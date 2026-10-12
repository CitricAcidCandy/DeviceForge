//! 投屏业务的离线录制阶段，通过公开任务协议提交。
#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_mirroring_plugin::execute)
        .await
        .is_err()
    {
        eprintln!("投屏插件协议失败");
        std::process::exit(1);
    }
}
