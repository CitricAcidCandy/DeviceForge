use std::net::SocketAddr;

use clapless::Options;
use deviceforge_resource_server::{Store, router};
use tokio::net::TcpListener;

mod clapless {
    use std::{env, path::PathBuf};

    pub const HELP: &str = "DeviceForge 资源服务
用法：deviceforge-resource-server [--bind IP:端口] [--data-dir 父目录]

参数：
  -h, --help          显示帮助并退出，不启动服务或创建数据目录。
  --bind IP:端口     监听地址，默认 127.0.0.1:7040（仅本机访问）。
                     设为 0.0.0.0:7040 可监听所有 IPv4 网卡，供局域网访问。
  --data-dir 父目录  资源存储父目录，默认 .deviceforge-resources。
                     相对路径按当前命令行工作目录解析，含空格的路径需加引号。
                     启动时自动创建缺失的父目录、分类目录和存储数据库。

分类目录：plugin、tool、config、distribution、resource。
内部存储：blobs 保存内容寻址文件，tmp 保存临时文件。

示例：
  deviceforge-resource-server --bind 127.0.0.1:7040 --data-dir \"D:\\DeviceForge\\market-data\"
";

    pub struct Options {
        pub bind: String,
        pub data_dir: PathBuf,
    }

    impl Options {
        pub fn parse() -> Result<Option<Self>, String> {
            let mut bind = "127.0.0.1:7040".to_owned();
            let mut data_dir = PathBuf::from(".deviceforge-resources");
            let args: Vec<String> = env::args().skip(1).collect();
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "-h" | "--help"))
            {
                return Ok(None);
            }
            if !args.len().is_multiple_of(2) {
                return Err("参数必须成对提供".into());
            }
            for pair in args.chunks(2) {
                match pair[0].as_str() {
                    "--bind" => bind = pair[1].clone(),
                    "--data-dir" => data_dir = PathBuf::from(&pair[1]),
                    value => return Err(format!("未知参数：{value}")),
                }
            }
            Ok(Some(Self { bind, data_dir }))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(options) = Options::parse().map_err(std::io::Error::other)? else {
        println!("{}", clapless::HELP);
        return Ok(());
    };
    tracing_subscriber::fmt().with_env_filter("info").init();
    let store = Store::open(&options.data_dir)?;
    let app = router(store);
    let address: SocketAddr = options.bind.parse()?;
    let listener = TcpListener::bind(address).await?;
    tracing::info!(%address, data_dir = ?options.data_dir, "资源服务已启动");
    axum::serve(listener, app).await?;
    Ok(())
}
