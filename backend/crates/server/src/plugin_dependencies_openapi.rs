//! 插件依赖的公开模式只从领域类型生成，路径统一复用 v2 响应封套。
use crate::openapi::{endpoint, schema, v2_endpoint};
use apk_domain::plugin_dependencies::*;
use serde_json::{Value, json};

pub(super) fn contribute(document: &mut Value) {
    for (name, value) in [
        ("PluginDependencies", schema::<PluginDependencies>()),
        ("DependencyTarget", schema::<DependencyTarget>()),
        ("DependencyTargetKind", schema::<DependencyTargetKind>()),
        ("DependencyChange", schema::<DependencyChange>()),
        ("DependencyRequest", schema::<DependencyRequest>()),
        ("DependencyView", schema::<DependencyView>()),
        ("DependencyStatus", schema::<DependencyStatus>()),
        ("DependencyOrigin", schema::<DependencyOrigin>()),
    ] {
        document["components"]["schemas"][name] = value;
    }
    let parameters = json!([
        {"name":"target_kind","in":"path","required":true,"schema":schema::<DependencyTargetKind>()},
        {"name":"id","in":"path","required":true,"schema":{"type":"string","minLength":1,"maxLength":99}}
    ]);
    let path = "/api/v2/plugin-dependencies/{target_kind}/{id}";
    let mut query = endpoint(
        "读取插件依赖和当前修订",
        "200",
        schema::<PluginDependencies>(),
    );
    unavailable(&mut query);
    document["paths"][path] = json!({"parameters":parameters.clone(),"get":v2_endpoint(query)});
    for (action, summary) in [
        ("scan", "提交依赖检测与自动配置任务"),
        ("install", "提交缺失依赖安装与自动配置任务"),
    ] {
        let mut operation = endpoint(summary, "202", schema::<apk_domain::Job>());
        operation["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<DependencyChange>()}}});
        for (status, description) in [
            ("413", "请求超过 256 KiB"),
            ("415", "请求媒体类型无效"),
            ("502", "任务提交依赖失败"),
        ] {
            operation["responses"][status] = json!({"description":description,"content":{"application/json":{"schema":schema::<crate::Failure>()}}});
        }
        unavailable(&mut operation);
        document["paths"][format!("{path}/{action}")] =
            json!({"parameters":parameters.clone(),"post":v2_endpoint(operation)});
    }
}

fn unavailable(operation: &mut Value) {
    operation["responses"]["503"] = json!({"description":"插件依赖服务未配置","content":{"application/json":{"schema":schema::<crate::Failure>()}}});
}

#[cfg(test)]
mod tests {
    #[test]
    fn dependencies_are_generator_visible_and_use_v2_envelopes() {
        let document = crate::openapi::document();
        for name in [
            "PluginDependencies",
            "DependencyChange",
            "DependencyTarget",
            "DependencyRequest",
        ] {
            assert!(document["components"]["schemas"][name].is_object());
        }
        for (suffix, method, status) in [
            ("", "get", "200"),
            ("/scan", "post", "202"),
            ("/install", "post", "202"),
        ] {
            let path = format!("/api/v2/plugin-dependencies/{{target_kind}}/{{id}}{suffix}");
            let operation = &document["paths"][path][method];
            let success = &operation["responses"][status]["content"]["application/json"]["schema"];
            assert!(success["properties"]["log_id"].is_object());
            assert!(success["properties"]["data"].is_object());
            assert!(operation["responses"]["503"]["content"]["application/json"]["schema"]["properties"]["error"].is_object());
        }
    }
}
