#[tokio::main]
async fn main() {
    if let Err(error) =
        deviceforge_plugin_runtime::serve_once_with_context(deviceforge_frida_plugin::execute).await
    {
        eprintln!("Frida插件协议失败：{error}");
        std::process::exit(1);
    }
}
