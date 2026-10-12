//! 自动化通过公开协议接入，ADB 由部署者配置。
#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_automation_plugin::execute)
        .await
        .is_err()
    {
        eprintln!("自动化插件协议失败");
        std::process::exit(1);
    }
}
