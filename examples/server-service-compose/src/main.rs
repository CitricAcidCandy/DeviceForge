//! 消费和提供服务的独立插件；失败的依赖不影响无关 ping 入口。
use apk_plugin_sdk::services::ServiceRef;
use deviceforge_plugin_runtime::{Execution, ServiceHandle, serve_once_with_services};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Text {
    text: String,
}

#[tokio::main]
async fn main() {
    let result = serve_once_with_services(|request, context, services| async move {
        let outcome = async {
            context.check().map_err(|e| e.to_string())?;
            if request.operation == "ping" {
                return Ok(serde_json::json!({"alive":true}).into());
            }
            if request.operation != "compose" {
                return Err("未知操作".to_owned());
            }
            let input: Text =
                serde_json::from_value(request.input).map_err(|_| "输入必须是 text 字符串对象")?;
            let normalize: ServiceHandle<Text, Text> = services.service(ServiceRef {
                id: "example.text.normalize".into(),
                version: "1.0".into(),
            });
            let output = normalize.call(&input).await?;
            context.check().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"text":format!("FORGE: {}", output.text)}).into())
        }
        .await;
        Execution::complete(outcome)
    })
    .await;
    if result.is_err() {
        eprintln!("服务插件传输失败");
        std::process::exit(1);
    }
}
