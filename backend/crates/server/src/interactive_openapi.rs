use crate::{
    interactive::*,
    openapi::{endpoint, schema, v2_endpoint},
};
use apk_domain::interactive::{SessionInfo, SessionOutputPage};
use serde_json::{Value, json};

pub(crate) fn contribute(document: &mut Value) {
    let id =
        json!({"name":"id","in":"path","required":true,"schema":{"type":"string","format":"uuid"}});
    let mut open = endpoint(
        "打开插件持续会话，准备及业务共享原预算",
        "202",
        schema::<SessionInfo>(),
    );
    open["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<crate::Submit>()}}});
    let list = endpoint(
        "列出本次宿主保留的会话记录",
        "200",
        schema::<Vec<SessionInfo>>(),
    );
    document["paths"]["/api/v2/sessions"] =
        json!({"get":v2_endpoint(list),"post":v2_endpoint(open)});
    document["paths"]["/api/v2/session-definitions"] = json!({"get":v2_endpoint(endpoint(
        "列出当前持续会话贡献及目录修订", "200", schema::<SessionDefinitions>()))});
    document["paths"]["/api/v2/sessions/{id}"] = json!({"parameters":[id.clone()],
        "get":v2_endpoint(endpoint("查询会话业务及资源终态", "200", schema::<SessionInfo>())),
        "delete":v2_endpoint(endpoint("删除已结束的会话记录", "200", schema::<SessionRemoved>()))});
    let mut output = endpoint(
        "排他游标读取会话原字节输出",
        "200",
        schema::<SessionOutputPage>(),
    );
    output["parameters"] = json!([
        {"name":"after","in":"query","schema":{"type":"integer","minimum":0,"default":0}},
        {"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100,"default":50}}
    ]);
    document["paths"]["/api/v2/sessions/{id}/output"] =
        json!({"parameters":[id.clone()],"get":v2_endpoint(output)});
    let mut input = endpoint(
        "发送原字节，成功仅确认输入准入",
        "200",
        schema::<SessionReceipt>(),
    );
    input["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<SessionBytesInput>()}}});
    document["paths"]["/api/v2/sessions/{id}/input"] =
        json!({"parameters":[id.clone()],"post":v2_endpoint(input)});
    document["paths"]["/api/v2/sessions/{id}/eof"] = json!({"parameters":[id.clone()],
        "post":v2_endpoint(endpoint("有序关闭输入并保留取消通路", "200", schema::<SessionReceipt>()))});
    document["paths"]["/api/v2/sessions/{id}/release"] = json!({"parameters":[id.clone()],
        "post":v2_endpoint(endpoint("请求释放会话；清理确认后自动删除记录，失败记录保留", "202", schema::<SessionInfo>()))});
    document["paths"]["/api/v2/sessions/{id}/cancel"] = json!({"parameters":[id],
        "post":v2_endpoint(endpoint("请求停止会话，资源终态另行查询", "200", schema::<SessionInfo>()))});
    for (name, value) in [
        ("SessionInfo", schema::<SessionInfo>()),
        ("SessionOutputPage", schema::<SessionOutputPage>()),
        ("SessionDefinitions", schema::<SessionDefinitions>()),
        ("SessionBytesInput", schema::<SessionBytesInput>()),
        ("SessionReceipt", schema::<SessionReceipt>()),
        ("SessionRemoved", schema::<SessionRemoved>()),
    ] {
        document["components"]["schemas"][name] = value;
    }
}
