use std::{net::SocketAddr, path::PathBuf};

use clapless::Options;
use deviceforge_resource_server::{Store, router};
use tokio::net::TcpListener;

mod clapless {
    use std::{env, path::PathBuf};

    pub struct Options {
        pub bind: String,
        pub data_dir: PathBuf,
    }

    impl Options {
        pub fn parse() -> Result<Self, String> {
            let mut bind = "127.0.0.1:7040".to_owned();
            let mut data_dir = PathBuf::from(".deviceforge-resources");
            let args: Vec<String> = env::args().skip(1).collect();
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
            Ok(Self { bind, data_dir })
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let options = Options::parse().map_err(std::io::Error::other)?;
    let store = Store::open(&options.data_dir)?;
    let app = router(store);
    let address: SocketAddr = options.bind.parse()?;
    let listener = TcpListener::bind(address).await?;
    tracing::info!(%address, data_dir = ?options.data_dir, "资源服务已启动");
    axum::serve(listener, app).await?;
    Ok(())
}
