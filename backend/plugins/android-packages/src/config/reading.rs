//! 配置的有界异步读取，不触发平台工具或签名文件读取。
use super::Config;
use crate::error::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use std::{future::Future, path::PathBuf};
use tokio::io::AsyncReadExt;

pub(crate) async fn controlled<T>(
    context: &InvocationContext,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
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

impl Config {
    pub(crate) async fn read(context: &InvocationContext) -> Result<Self> {
        context.check()?;
        let mut args = std::env::args_os().skip(1);
        let (path, explicit) = match args.next() {
            None => (
                std::env::current_exe()
                    .map_err(|_| Error::Io("无法定位插件部署入口"))?
                    .parent()
                    .ok_or(Error::Invalid("插件入口没有部署目录"))?
                    .join("android-packages.config.json"),
                false,
            ),
            Some(flag) if flag == "--config" => (
                PathBuf::from(args.next().ok_or(Error::Invalid("缺少部署配置路径"))?),
                true,
            ),
            _ => return Err(Error::Invalid("仅支持--config部署参数")),
        };
        if args.next().is_some() {
            return Err(Error::Invalid("部署参数过多"));
        }
        super::absolute(&path)?;
        let present = controlled(context, async {
            match tokio::fs::symlink_metadata(&path).await {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && !explicit => {
                    Ok(false)
                }
                Err(_) => Err(Error::Io("部署配置无法读取")),
            }
        })
        .await?;
        if !present {
            return Ok(Self::default());
        }
        super::paths::regular(&path, false, context).await?;
        let bytes = controlled(context, async {
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|_| Error::Io("部署配置无法打开"))?;
            let mut bytes = Vec::new();
            file.take(65_537)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Error::Io("部署配置无法读取"))?;
            if bytes.len() > 65_536 {
                return Err(Error::TooLarge);
            }
            Ok(bytes)
        })
        .await?;
        let config: Self =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("部署配置JSON无效"))?;
        config.validate()?;
        context.check()?;
        Ok(config)
    }
}
