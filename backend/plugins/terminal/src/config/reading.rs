use super::{CONFIG_LIMIT, Config, absolute};
use crate::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use std::{ffi::OsString, future::Future, path::PathBuf};
use tokio::io::AsyncReadExt;

pub(crate) async fn controlled<Value>(
    context: &InvocationContext,
    future: impl Future<Output = Result<Value>>,
) -> Result<Value> {
    context.check()?;
    let cancel = context.cancellation();
    let result = tokio::select! {
        biased;
        _ = tokio::time::sleep_until(context.deadline().into()) => Err(Error::Timeout),
        _ = cancel.cancelled() => Err(Error::Cancelled),
        result = future => result,
    };
    context.check()?;
    result
}

pub(super) fn path(args: &[OsString], executable: PathBuf) -> Result<PathBuf> {
    let path = match args {
        [] => executable.with_file_name("terminal.config.json"),
        [flag, path] if flag == "--config" => PathBuf::from(path),
        _ => return Err(Error::Configuration("部署参数只接受--config绝对路径")),
    };
    absolute(&path)?;
    Ok(path)
}

impl Config {
    pub(crate) async fn read(context: &InvocationContext) -> Result<Self> {
        context.check()?;
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        let executable =
            std::env::current_exe().map_err(|_| Error::Configuration("无法定位终端插件入口"))?;
        let path = match apk_plugin_sdk::configuration::managed_config_path() {
            Some(path) => path,
            None => path(&args, executable)?,
        };
        absolute(&path)?;
        let bytes = controlled(context, async {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|_| Error::Configuration("部署配置无法打开"))?;
            let mut bytes = Vec::new();
            file.take((CONFIG_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Error::Configuration("部署配置无法读取"))?;
            if bytes.len() > CONFIG_LIMIT {
                return Err(Error::Configuration("部署配置超过65536字节"));
            }
            Ok(bytes)
        })
        .await?;
        let config = Self::parse(&bytes)?;
        context.check()?;
        Ok(config)
    }
}
