//! 仅显式验收参数启用的调用标记；不记录输入，不创建额外进程。
use apk_plugin_sdk::Request;
use std::path::PathBuf;

pub struct Diagnostics {
    directory: Option<PathBuf>,
    request_id: String,
}

impl Diagnostics {
    pub async fn start(request: &Request) -> Result<Self, String> {
        let arguments: Vec<_> = std::env::args_os().skip(1).collect();
        let directory = match arguments.as_slice() {
            [] => None,
            [flag, path] if flag == "--smoke-directory" => {
                let path = PathBuf::from(path);
                if !path.is_absolute() || !path.is_dir() {
                    return Err("验收标记目录必须是已存在的绝对目录".into());
                }
                Some(path)
            }
            _ => return Err("未知验收参数".into()),
        };
        let diagnostics = Self {
            directory,
            request_id: request.request_id.clone(),
        };
        diagnostics.write("started", false).await?;
        Ok(diagnostics)
    }

    pub async fn finish(&self, cancelled: bool) -> Result<(), String> {
        self.write("finished", cancelled).await
    }

    async fn write(&self, phase: &str, cancelled: bool) -> Result<(), String> {
        let Some(directory) = &self.directory else {
            return Ok(());
        };
        if self.request_id.is_empty()
            || !self
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("验收请求身份不可作为文件名".into());
        }
        let bytes = serde_json::to_vec(&serde_json::json!({
            "request_id": self.request_id, "pid": std::process::id(),
            "phase": phase, "cancelled": cancelled,
        }))
        .map_err(|_| "验收标记编码失败")?;
        tokio::fs::write(
            directory.join(format!("{}.{phase}.json", self.request_id)),
            bytes,
        )
        .await
        .map_err(|_| "验收标记写入失败".into())
    }
}
