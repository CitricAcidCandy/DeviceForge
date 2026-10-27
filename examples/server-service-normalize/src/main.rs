//! 提供服务的独立插件；只依赖公开 SDK 与运行库，不引用宿主。
use deviceforge_plugin_runtime::{Execution, serve_once_with_services};
use serde::{Deserialize, Serialize};
mod diagnostics;

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
        let diagnostics = match diagnostics::Diagnostics::start(&request).await {
            Ok(value) => value,
            Err(error) => return Execution::complete(Err(error)),
        };
        let outcome = async {
            context.check().map_err(|e| e.to_string())?;
            if request.operation != "normalize" {
                return Err("未知操作".to_owned());
            }
            let input: Input =
                serde_json::from_value(request.input).map_err(|_| "输入必须是 text 字符串对象")?;
            // 只有管理员显式启用标记目录时，才等待可撤销的验收屏障。
            if let Some(path) = diagnostics.hold_path() {
                let until = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
                let cancel = context.cancellation();
                while tokio::fs::try_exists(&path)
                    .await
                    .map_err(|_| "验收屏障读取失败")?
                {
                    context.check().map_err(|error| error.to_string())?;
                    tokio::select! {
                        _ = cancel.cancelled() => return Err("规范化调用已取消".into()),
                        _ = tokio::time::sleep_until(until) => return Err("验收屏障超过六十秒".into()),
                        _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {},
                    }
                }
            }
            let output = Output {
                text: input.text.trim().to_lowercase(),
            };
            context.check().map_err(|e| e.to_string())?;
            serde_json::to_value(output)
                .map(Into::into)
                .map_err(|_| "服务结果编码失败".into())
        }
        .await;
        let cancelled = context.cancellation().is_cancelled();
        match diagnostics.finish(cancelled).await {
            Ok(()) => Execution::complete(outcome),
            Err(error) => Execution::complete(Err(error)),
        }
    })
    .await;
    if result.is_err() {
        eprintln!("服务插件传输失败");
        std::process::exit(1);
    }
}
