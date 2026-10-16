//! 市场来源发现适配器。
//!
//! 目录展示与资源字节由独立 resource-server 提供；本插件只负责读取来源清单、合并目录，
//! 安装和卸载继续交给宿主已有的插件包生命周期，避免市场元数据绕过安装器。

use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const DEFAULT_SOURCE: &str = "http://127.0.0.1:7040";

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let result = async {
        context.check().map_err(|error| error.to_string())?;
        match request.operation.as_str() {
            "sources" => Ok(Output::from(json!({ "sources": sources() }))),
            "catalog" => catalog(request.input, &context).await,
            operation => Err(format!("不支持的市场操作：{operation}")),
        }
    }
    .await;
    Execution::complete(result)
}

async fn catalog(input: Value, context: &InvocationContext) -> Result<Output, String> {
    let query = input.as_object().cloned().unwrap_or_default();
    let suffix = query_string(&query);
    let client = reqwest::Client::new();
    let mut entries = BTreeMap::new();
    for source in sources() {
        context.check().map_err(|error| error.to_string())?;
        let url = format!(
            "{}/api/v1/catalog{}",
            source["url"].as_str().unwrap_or(DEFAULT_SOURCE),
            suffix
        );
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("市场来源请求失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!("市场来源返回 HTTP {}", response.status()));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("市场目录 JSON 无效：{error}"))?;
        if let Some(items) = value.get("entries").and_then(Value::as_array) {
            for item in items {
                let mut item = item.clone();
                if let Some(object) = item.as_object_mut() {
                    object.insert(
                        "source".into(),
                        Value::String(source["url"].as_str().unwrap_or(DEFAULT_SOURCE).into()),
                    );
                    object.insert(
                        "source_name".into(),
                        source
                            .get("name")
                            .cloned()
                            .unwrap_or_else(|| Value::String("市场来源".into())),
                    );
                }
                let key = format!(
                    "{}@{}",
                    item.get("id").and_then(Value::as_str).unwrap_or_default(),
                    item.get("version")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                entries.entry(key).or_insert(item);
            }
        }
    }
    let entries: Vec<Value> = entries.into_values().collect();
    Ok(Output::from(
        json!({ "entries": entries, "total": entries.len() }),
    ))
}

fn sources() -> Vec<Value> {
    std::env::var("DEVICEFORGE_MARKETPLACE_SOURCES")
        .ok()
        .and_then(|value| serde_json::from_str::<Vec<Value>>(&value).ok())
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| vec![json!({ "name": "本地默认市场", "url": DEFAULT_SOURCE })])
}

fn query_string(query: &serde_json::Map<String, Value>) -> String {
    let pairs = query
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key, value)));
    let encoded = pairs
        .map(|(key, value)| format!("{}={}", urlencoding(key), urlencoding(value)))
        .collect::<Vec<_>>();
    if encoded.is_empty() {
        String::new()
    } else {
        format!("?{}", encoded.join("&"))
    }
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
