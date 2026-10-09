#[path="../../application/tests/devices/support.rs"]
mod support;
use support::*;
use axum::{Router,body::{Body,to_bytes},http::{Request,StatusCode}};
use serde_json::{Value,json};
use tower::ServiceExt;
async fn request(router:&Router,method:&str,path:&str,body:String)->(StatusCode,Value){
    let response=router.clone().oneshot(Request::builder().method(method).uri(path).header("content-type","application/json").body(Body::from(body)).unwrap()).await.unwrap();
    let status=response.status();let bytes=to_bytes(response.into_body(),1024*1024).await.unwrap();(status,serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn http_exact_errors_default_open_and_v2_context(){
    let provider=Provider::new("http");let (app,_,_,input)=setup(provider.clone()).await;
    let router=apk_server::router(app.clone(),String::new(),100).unwrap();
    let (_,list)=request(&router,"GET","/api/v2/device-providers",String::new()).await;
    assert_eq!(list["data"][0]["id"],"http");assert!(list["log_id"].is_string());
    let valid=serde_json::to_value(action(&input,"read",Some("same"))).unwrap();
    let mut old=valid.clone();old["generation"]=json!("old");
    let mut unknown=valid.clone();unknown["provider_id"]=json!("unknown");
    let mut version=valid.clone();version["version"]=json!(2);
    let mut invalid_version=valid.clone();invalid_version["version"]=json!(0);
    let mut nonobject=valid.clone();nonobject["input"]=json!([]);
    for (body,status,code) in [(old,StatusCode::CONFLICT,"conflict"),(unknown,StatusCode::NOT_FOUND,"not_found"),(version,StatusCode::NOT_FOUND,"not_found"),(invalid_version,StatusCode::BAD_REQUEST,"invalid_input"),(nonobject,StatusCode::BAD_REQUEST,"invalid_input"),(valid.clone(),StatusCode::CONFLICT,"conflict")]{
        let (actual,result)=request(&router,"POST","/api/v2/device-actions",body.to_string()).await;
        assert_eq!(actual,status,"{result}");assert_eq!(result["error"]["code"],code);assert!(result["log_id"].is_string());
    }
    for body in ["{".into(),"{}".into(),json!({"generation":input.generation,"extra":true}).to_string()]{
        let (status,result)=request(&router,"POST","/api/v2/device-providers/http/refresh",body).await;
        assert_eq!(status,StatusCode::BAD_REQUEST);assert_eq!(result["error"]["code"],"invalid_input");
    }
    let refresh=json!({"generation":input.generation}).to_string();
    let (status,result)=request(&router,"POST","/api/v2/device-providers/http/refresh",refresh.clone()).await;
    assert_eq!(status,StatusCode::OK,"{result}");assert!(result["data"]["observed_at"].is_number());
    let mut missing=valid.clone();missing["device_id"]=json!("missing");
    let (status,result)=request(&router,"POST","/api/v2/device-actions",missing.to_string()).await;
    assert_eq!(status,StatusCode::NOT_FOUND);assert_eq!(result["error"]["code"],"not_found");
    let (status,result)=request(&router,"POST","/api/v2/device-actions",valid.to_string()).await;
    assert_eq!(status,StatusCode::ACCEPTED,"{result}");
    *provider.discovery.lock().unwrap()=json!([{"id":"same","state":"offline","capabilities":[]}]);
    request(&router,"POST","/api/v2/device-providers/http/refresh",refresh.clone()).await;
    let (status,result)=request(&router,"POST","/api/v2/device-actions",valid.to_string()).await;
    assert_eq!(status,StatusCode::CONFLICT);assert_eq!(result["error"]["code"],"conflict");
    *provider.discovery.lock().unwrap()=json!([{"id":"same","state":"bad","capabilities":[]}]);
    let (status,result)=request(&router,"POST","/api/v2/device-providers/http/refresh",refresh).await;
    assert_eq!(status,StatusCode::BAD_GATEWAY);assert_eq!(result["error"]["code"],"dependency_failed");
    let (_,schema)=request(&router,"GET","/api/v2/openapi.json",String::new()).await;
    assert_eq!(schema["security"],json!([{}, {"bearerAuth":[]} ]));
    assert!(schema["paths"]["/api/v2/device-actions"]["post"].is_object());
    app.shutdown().await.unwrap();
}

async fn rpc(router:&Router,name:&str,args:Value)->Value{
    let params=json!({"name":name,"arguments":args,"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"设备契约测试","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}});
    let response=router.clone().oneshot(Request::builder().method("POST").uri("/mcp")
        .header("host","127.0.0.1:7031").header("content-type","application/json")
        .header("accept","application/json, text/event-stream").header("MCP-Protocol-Version","2026-07-28")
        .header("Mcp-Method","tools/call").header("Mcp-Name",name)
        .body(Body::from(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":params}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(),1024*1024).await.unwrap()).unwrap()
}
#[tokio::test]
async fn mcp_shares_http_directory_and_exact_domain_errors(){
    let provider=Provider::new("mcp");let (app,_,_,input)=setup(provider).await;
    let router=apk_server::router(app.clone(),String::new(),100).unwrap();
    let listed=rpc(&router,"deviceforge.list_device_providers",json!({})).await;
    assert_eq!(listed["result"]["structuredContent"][0]["id"],"mcp");
    let refreshed=rpc(&router,"deviceforge.refresh_devices",serde_json::to_value(&input).unwrap()).await;
    assert_eq!(refreshed["result"]["structuredContent"]["provider"]["generation"],input.generation);
    let (_,http)=request(&router,"GET","/api/v2/devices",String::new()).await;
    assert_eq!(http["data"][0]["discovery_job_id"],refreshed["result"]["structuredContent"]["discovery_job_id"]);
    let valid=serde_json::to_value(action(&input,"read",Some("same"))).unwrap();
    for (field,value,code) in [("version",json!(2),"not_found"),("generation",json!("old"),"conflict"),("input",json!(null),"invalid_input")]{
        let mut args=valid.clone();args[field]=value;
        let result=rpc(&router,"deviceforge.invoke_device",args).await;
        assert_eq!(result["result"]["isError"],true,"{result}");
        assert_eq!(result["result"]["structuredContent"]["code"],code,"{result}");
    }
    let invoked=rpc(&router,"deviceforge.invoke_device",valid).await;
    assert_eq!(invoked["result"]["structuredContent"]["operation"],"plugin.mcp.read");
    app.shutdown().await.unwrap();
}
