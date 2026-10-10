//! 标准输出只写公开协议帧，ADB输出由业务处理器校验。
#[tokio::main]
async fn main() {
    if let Err(error) = deviceforge_plugin_runtime::serve_once_with_context(
        deviceforge_android_device_plugin::execute,
    )
    .await
    {
        eprintln!("安卓设备插件协议失败：{error}");
        std::process::exit(1);
    }
}
