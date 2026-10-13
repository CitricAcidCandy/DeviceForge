#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::session::serve_session(
        deviceforge_plugin_runtime::session::SessionOptions::default(),
        deviceforge_terminal_plugin::execute,
    )
    .await
    .is_err()
    {
        eprintln!("终端插件会话协议失败");
        std::process::exit(1);
    }
}
