#[tokio::main]
async fn main() {
    if deviceforge_plugin_runtime::serve_once_with_context(deviceforge_spreadsheet_plugin::execute)
        .await.is_err() {
        eprintln!("表格插件公开协议失败");
        std::process::exit(1);
    }
}
