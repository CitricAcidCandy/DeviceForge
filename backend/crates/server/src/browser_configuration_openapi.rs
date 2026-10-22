//! 浏览器配置的完整记录与 CAS 接口由 Rust 类型生成。
use crate::openapi::{endpoint, schema, v2_endpoint};
use apk_domain::browser_configurations::*;
use serde_json::{Value, json};

pub(crate) fn contribute(document: &mut Value) {
    let mut patch_schema = schema::<BrowserConfigurationPatch>();
    // Option 表示允许 null；CAS 字段仍必须显式提供，不能省略成创建操作。
    patch_schema["required"] = json!(["expected_revision", "record"]);
    let mut view_schema = schema::<BrowserConfigurationView>();
    // 响应始终包含 record；不存在时字段值为 null，而不是省略字段。
    view_schema["required"] = json!(["record"]);
    let mut get = endpoint(
        "读取浏览器插件完整原值配置；不存在时 record 为 null",
        "200",
        view_schema.clone(),
    );
    let mut patch = endpoint(
        "按修订 CAS 保存浏览器插件完整记录；无需插件已安装",
        "200",
        view_schema.clone(),
    );
    patch["requestBody"] =
        json!({"required":true,"content":{"application/json":{"schema":patch_schema.clone()}}});
    for operation in [&mut get, &mut patch] {
        operation["responses"]["413"] = json!({"description":"请求或配置文件超过 256 KiB","content":{"application/json":{"schema":schema::<crate::Failure>()}}});
        operation["responses"]["503"] = json!({"description":"浏览器配置服务未配置","content":{"application/json":{"schema":schema::<crate::Failure>()}}});
    }
    document["paths"]["/api/v2/browser-plugin-configurations/{id}"] = json!({
        "parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string","minLength":1,"maxLength":99,"pattern":"^[a-z0-9][a-z0-9._-]*$"}}],
        "get":v2_endpoint(get),
        "patch":v2_endpoint(patch)
    });
    for (name, value) in [
        (
            "BrowserConfigurationRecord",
            schema::<BrowserConfigurationRecord>(),
        ),
        ("BrowserConfigurationView", view_schema),
        ("BrowserConfigurationPatch", patch_schema),
    ] {
        document["components"]["schemas"][name] = value;
    }
}
