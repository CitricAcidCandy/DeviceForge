//! 标准输出仅用于公开协议帧，工具与业务均在库处理器内执行。
#[tokio::main]
async fn main() {
    if let Err(error) = deviceforge_plugin_runtime::serve_once_with_context(
        deviceforge_android_packages_plugin::execute,
    )
    .await
    {
        eprintln!("安卓包插件协议失败：{error}");
        std::process::exit(1);
    }
}
