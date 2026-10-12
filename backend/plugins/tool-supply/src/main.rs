//! 标准输出仅用于协议 4，部署配置固定从插件可执行文件旁读取。
#[tokio::main]
async fn main() {
    if let Err(error) =
        deviceforge_plugin_runtime::serve_once_with_context(deviceforge_tool_supply_plugin::execute)
            .await
    {
        eprintln!("工具供应插件协议失败：{error}");
        std::process::exit(1);
    }
}
