//! 统一发布安装模式由 Rust 公共类型生成。
use crate::openapi::{endpoint, schema, v2_endpoint};
use apk_application::installation_operations::InstallationRequest;
use apk_domain::plugin_installations::*;
use serde_json::{Value, json};

pub(super) fn contribute(document: &mut Value) {
    for (name, value) in [
        ("PluginReleaseManifest", schema::<ReleaseManifest>()),
        ("PluginInstallation", schema::<InstalledRelease>()),
        ("PluginInstallationSource", schema::<InstallSource>()),
        ("PluginInstallationPlan", schema::<InstallationPlan>()),
        (
            "PluginInstallationSuccessfulRelease",
            schema::<SuccessfulRelease>(),
        ),
        (
            "PluginResourceCleanupReport",
            schema::<ResourceCleanupReport>(),
        ),
    ] {
        document["components"]["schemas"][name] = value;
    }
    let request = |mut operation: Value, input: Value| {
        operation["requestBody"] =
            json!({"required":true,"content":{"application/json":{"schema":input}}});
        v2_endpoint(operation)
    };
    document["paths"]["/api/v2/plugin-installations"] = json!({
        "get":v2_endpoint(endpoint("已安装完整功能插件", "200", schema::<Vec<InstalledRelease>>())),
        "post":request(endpoint("提交完整功能插件安装任务", "202", schema::<apk_domain::Job>()), schema::<InstallationRequest>())
    });
    document["paths"]["/api/v2/plugin-installations/plan"] = json!({"post":request(endpoint("预览完整插件安装计划", "200", schema::<InstallationPlan>()), schema::<InstallSource>())});
    document["paths"]["/api/v2/plugin-installations/cleanup"] = json!({"post":request(endpoint("提交托管资源引用检查或清理任务", "202", schema::<apk_domain::Job>()), schema::<apk_application::installation_operations::InstallationCleanup>())});
    let mut upload = endpoint(
        "流式上传完整离线插件包",
        "201",
        schema::<apk_domain::artifacts::Artifact>(),
    );
    upload["parameters"] = json!([{"name":"filename","in":"query","required":true,"schema":{"type":"string","pattern":"\\.zip$"}}]);
    upload["requestBody"] = json!({"required":true,"content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}});
    document["paths"]["/api/v2/plugin-installations/artifacts"] =
        json!({"post":v2_endpoint(upload)});
    let id = json!({"name":"id","in":"path","required":true,"schema":{"type":"string"}});
    document["paths"]["/api/v2/plugin-installations/{id}"] = json!({
        "parameters":[id.clone()],
        "get":v2_endpoint(endpoint("读取完整插件安装状态", "200", schema::<InstalledRelease>())),
        "put":request(endpoint("提交成套更新任务", "202", schema::<apk_domain::Job>()), schema::<InstallationRequest>()),
        "delete":request(endpoint("卸载完整功能并保留配置", "202", schema::<apk_domain::Job>()), schema::<InstallationRevision>())
    });
    document["paths"]["/api/v2/plugin-installations/{id}/enabled"] = json!({
        "parameters":[id.clone()],"patch":request(endpoint("提交完整功能启停任务", "202", schema::<apk_domain::Job>()), schema::<InstallationEnabled>())
    });
    for (path, description) in [
        (
            "/api/v2/plugin-installations/{id}/reload",
            "按当前修订重载完整功能，保留启停意图",
        ),
        (
            "/api/v2/plugin-installations/{id}/restore-successful",
            "显式恢复上一成功代码包，不回滚业务数据",
        ),
    ] {
        document["paths"][path] = json!({"parameters":[id.clone()],
            "post":request(endpoint(description, "202", schema::<apk_domain::Job>()), schema::<InstallationAction>())});
    }
    let mut previous = v2_endpoint(endpoint(
        "查询当前修订的上一成功代码包",
        "200",
        schema::<SuccessfulRelease>(),
    ));
    previous["parameters"] = json!([id,
        {"name":"expected_revision","in":"query","required":true,"schema":{"type":"string","pattern":"^[a-f0-9]{64}$"}}]);
    document["paths"]["/api/v2/plugin-installations/{id}/previous-successful"] =
        json!({"get":previous});
    document["paths"]["/api/v2/plugin-installations/browser/{id}/revisions/{revision}/assets/{path}"] = json!({"get":{
        "summary":"按不可变发布修订提供浏览器资源", "security":[],
        "parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}},{"name":"revision","in":"path","required":true,"schema":{"type":"string"}},{"name":"path","in":"path","required":true,"schema":{"type":"string"}}],
        "responses":{"200":{"description":"资源原始字节","content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}}}
    }});
}
