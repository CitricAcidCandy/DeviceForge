//! 提供服务的独立插件；只依赖公开 SDK 与运行库，不引用宿主。
use deviceforge_plugin_runtime::{Execution, serve_once_with_services};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    text: String,
}
#[derive(Serialize)]
struct Output {
    text: String,
}

#[tokio::main]
async fn main() {
    let result = serve_once_with_services(|request, context, _| async move {
        let outcome = async {
            context.check().map_err(|e| e.to_string())?;
            if request.operation != "normalize" {
                return Err("未知操作".to_owned());
            }
            let input: Input =
                serde_json::from_value(request.input).map_err(|_| "输入必须是 text 字符串对象")?;
            let output = Output {
                text: input.text.trim().to_lowercase(),
            };
            context.check().map_err(|e| e.to_string())?;
            serde_json::to_value(output)
                .map(Into::into)
                .map_err(|_| "服务结果编码失败".into())
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
