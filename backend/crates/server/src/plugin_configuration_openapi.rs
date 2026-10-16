//! 统一配置的模式声明，生成客户端从同一领域类型获取契约。
use crate::openapi::{endpoint, schema, v2_endpoint};
use apk_domain::plugin_configurations::*;
use serde_json::{Value, json};

pub(crate) fn contribute(document: &mut Value) {
    let kind = json!({"name":"kind","in":"path","required":true,"schema":{"type":"string","enum":["server"]}});
    let id =
        json!({"name":"id","in":"path","required":true,"schema":{"type":"string","maxLength":99}});
    let mut list = v2_endpoint(endpoint(
        "列出部署服务器插件的统一配置，包含旁置部署",
        "200",
        schema::<Vec<PluginConfiguration>>(),
    ));
    list["parameters"] = json!([{"name":"kind","in":"query","required":true,"schema":{"type":"string","enum":["server"]}}]);
    document["paths"]["/api/v2/plugin-configurations"] = json!({"get":list});
    let get = v2_endpoint(endpoint(
        "读取配置声明、遮蔽值和修订状态",
        "200",
        schema::<PluginConfiguration>(),
    ));
    let mut patch = v2_endpoint(endpoint(
        "使用CAS保存JSON合并补丁；compatible=false表示校验失败且未保存",
        "200",
        schema::<PluginConfiguration>(),
    ));
    patch["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<ConfigurationPatch>()}}});
    document["paths"]["/api/v2/plugin-configurations/{kind}/{id}"] =
        json!({"parameters":[kind.clone(),id.clone()],"get":get,"patch":patch});
    for action in ["reset", "apply"] {
        let mut operation = v2_endpoint(endpoint(
            if action == "reset" {
                "按CAS恢复当前插件默认配置"
            } else {
                "按CAS应用配置，需重载时拒绝活动任务与清理失败"
            },
            "200",
            schema::<PluginConfiguration>(),
        ));
        operation["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<ConfigurationRevision>()}}});
        document["paths"][format!("/api/v2/plugin-configurations/{{kind}}/{{id}}/{action}")] =
            json!({"parameters":[kind.clone(),id.clone()],"post":operation});
    }
    for (name, value) in [
        ("PluginConfiguration", schema::<PluginConfiguration>()),
        (
            "ConfigurationDefinition",
            schema::<ConfigurationDefinition>(),
        ),
        (
            "ConfigurationFieldError",
            schema::<ConfigurationFieldError>(),
        ),
        ("ConfigurationPatch", schema::<ConfigurationPatch>()),
        ("ConfigurationRevision", schema::<ConfigurationRevision>()),
    ] {
        document["components"]["schemas"][name] = value;
    }
}
