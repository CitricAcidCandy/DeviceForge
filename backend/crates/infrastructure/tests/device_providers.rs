use apk_domain::{Error,Executor};
use apk_infrastructure::plugins::ProcessPlugin;
use apk_plugin_sdk::Manifest;
use serde_json::json;
use tokio_util::sync::CancellationToken;
fn node()->std::path::PathBuf {
    let name=if cfg!(windows){"node.exe"}else{"node"};
    std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|root|root.join(name)).find(|path|path.is_file()).expect("真实插件回归需要 Node")
}
#[tokio::test]
async fn real_process_discovery_protocols_one_two_three_and_bad_result(){
    let dir=tempfile::tempdir().unwrap();
    let script=dir.path().join("provider.cjs");
    // 本夹具每次启动一个真实进程，仅发协议帧，不创建外部资源。
    std::fs::write(&script,r#"const rl=require('node:readline').createInterface({input:process.stdin});
rl.once('line',line=>{
 const q=JSON.parse(line);
 const result=q.input.bad ? [{id:'same',state:'online',capabilities:[{id:'undeclared',version:1,available:true}]}] : [{id:'same',state:'online',capabilities:[]}];
 const response={protocol_version:q.protocol_version,request_id:q.request_id,result};
 process.stdout.write(JSON.stringify(q.protocol_version===3 ? {response,cleanup:'complete'} : response)+'\n');
 rl.close();
});
"#).unwrap();
    for version in [1,2,3]{
        let manifest:Manifest=serde_json::from_value(json!({"id":"test","version":"1","protocol_version":version,"executable":node(),"args":[script],"operations":[{"name":"discover","title":"发现","input_schema":{"type":"object"}}],"devices":{"api_version":1,"platform":"第三方测试","discover_operation":"discover","capabilities":[]}})).unwrap();
        let plugin=ProcessPlugin::new(manifest).unwrap();
        assert_eq!(plugin.device_provider().unwrap().discover_operation,"plugin.test.discover");
        let output=plugin.execute("plugin.test.discover",json!({}),CancellationToken::new()).await.unwrap();
        if version==1{assert!(output.is_array());}else{assert!(output["result"].is_array());assert_eq!(output["artifacts"],json!([]));}
        assert!(matches!(plugin.execute("plugin.test.discover",json!({"bad":true}),CancellationToken::new()).await,Err(Error::Dependency(_))));
        assert!(!plugin.has_unresolved_resources());
    }
}
