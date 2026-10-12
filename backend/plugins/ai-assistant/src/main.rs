//! AI 助手通过部署者配置的 CLI 执行，响应不得泄露凭据配置。
#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_ai_assistant_plugin::execute)
        .await
        .is_err()
    {
        eprintln!("AI 助手插件协议失败");
        std::process::exit(1);
    }
}
