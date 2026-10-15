#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_marketplace_plugin::execute)
        .await
        .is_err()
    {
        eprintln!("市场插件协议失败");
        std::process::exit(1);
    }
}

