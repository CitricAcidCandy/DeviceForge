#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_dex_analysis_plugin::execute)
        .await
        .is_err()
    {
        eprintln!("DEX插件公开协议失败");
        std::process::exit(1);
    }
}
