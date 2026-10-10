//! 配置插件使用现有公开任务协议，不输出配置内容到诊断日志。
#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_settings_plugin::execute)
        .await
        .is_err()
    {
        eprintln!("配置插件协议失败");
        std::process::exit(1);
    }
}
