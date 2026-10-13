//! 保留录像任务并按首帧接入协议5实时投屏。
#[tokio::main]
async fn main() {
    if deviceforge_mirroring_plugin::entry::serve_io(tokio::io::stdin(), tokio::io::stdout())
        .await
        .is_err()
    {
        eprintln!("投屏插件协议失败");
        std::process::exit(1);
    }
}
