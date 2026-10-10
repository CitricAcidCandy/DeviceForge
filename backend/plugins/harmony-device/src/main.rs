#[tokio::main]
async fn main() {
    if let Err(error) = deviceforge_plugin_runtime::serve_once_with_context(
        deviceforge_harmony_device_plugin::execute,
    )
    .await
    {
        eprintln!("鸿蒙设备插件协议失败：{error}");
        std::process::exit(1);
    }
}
