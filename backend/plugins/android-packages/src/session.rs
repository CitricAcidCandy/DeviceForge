//! 单次业务的目录租约、受限同步工作和明确清理责任。
mod directory;
mod files;
mod process;
mod worker;
use crate::{
    config::Config,
    error::{Error, Result},
};
use apk_plugin_sdk::{ArtifactOutput, Request, cooperative::CleanupOutcome};
use deviceforge_android_package_core::TreeProfile;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Semaphore;

pub(crate) const FILE_LIMIT: u64 = 64 * 1024 * 1024;

#[cfg(test)]
mod tests;

pub(crate) struct Input {
    pub artifact_id: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub path: PathBuf,
}

/// 此租约不自动删除目录；只有finish确认所有使用者退出后才删除。
pub(super) struct Lease {
    path: PathBuf,
}

pub(crate) struct Session {
    pub input: Input,
    pub root: PathBuf,
    context: InvocationContext,
    config: Config,
    output: PathBuf,
    lease: Arc<Lease>,
    slots: Arc<Semaphore>,
    unresolved: Arc<AtomicBool>,
    cleanup_until: Mutex<Option<tokio::time::Instant>>,
}

pub(crate) enum Watch {
    File { path: PathBuf, limit: u64 },
    Tree { path: PathBuf, profile: TreeProfile },
}

impl Session {
    pub(crate) async fn prepare(
        request: &Request,
        context: InvocationContext,
        config: Config,
        extensions: &[&str],
    ) -> Result<Self> {
        context.check()?;
        let id = request
            .input
            .get("artifact_id")
            .and_then(serde_json::Value::as_str)
            .ok_or(Error::Invalid("缺少输入产物ID"))?;
        let artifacts = request
            .artifacts
            .as_ref()
            .ok_or(Error::Invalid("缺少宿主产物上下文"))?;
        if artifacts.inputs.len() != 1 {
            return Err(Error::Invalid("要求唯一输入产物副本"));
        }
        let input = &artifacts.inputs[0];
        if input.field != "artifact_id" || input.artifact_id != id {
            return Err(Error::Invalid("输入产物关联不一致"));
        }
        if input.size > FILE_LIMIT {
            return Err(Error::TooLarge);
        }
        if input.sha256.len() != 64 || !input.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::Invalid("输入产物摘要无效"));
        }
        files::filename(&input.filename)?;
        let extension = extensions
            .iter()
            .find(|suffix| input.filename.to_ascii_lowercase().ends_with(**suffix))
            .ok_or(Error::Invalid("产物格式不符合操作要求"))?;
        let source = PathBuf::from(&input.path);
        let metadata = crate::config::paths::regular(&source, false, &context).await?;
        if metadata.len() != input.size {
            return Err(Error::Invalid("输入产物长度不一致"));
        }
        let output = PathBuf::from(
            artifacts
                .output_directory
                .as_ref()
                .ok_or(Error::Invalid("未获产物输出授权"))?,
        );
        crate::config::paths::regular(&output, true, &context).await?;
        let scratch = config
            .scratch_root
            .clone()
            .unwrap_or_else(std::env::temp_dir);
        crate::config::paths::regular(&scratch, true, &context).await?;
        context.check()?;
        let directory = directory::create(&context, scratch).await?;
        let root = directory.path().to_path_buf();
        let private = root.join(format!("source{extension}"));
        let session = Self {
            input: Input {
                artifact_id: id.into(),
                filename: input.filename.clone(),
                size: input.size,
                sha256: input.sha256.clone(),
                path: private,
            },
            lease: Arc::new(Lease {
                path: directory.keep(),
            }),
            root,
            context,
            config,
            output,
            slots: Arc::new(Semaphore::new(1)),
            unresolved: Arc::default(),
            cleanup_until: Mutex::new(None),
        };
        let destination = session.input.path.clone();
        let expected_size = session.input.size;
        let expected_hash = session.input.sha256.clone();
        let copied = session
            .work(move |control| {
                files::copy_input(
                    &source,
                    &destination,
                    expected_size,
                    &expected_hash,
                    control,
                )
            })
            .await;
        if let Err(error) = copied {
            let confirmed = session.cleanup().await;
            return Err(if confirmed {
                error
            } else {
                Error::CleanupFailed
            });
        }
        Ok(session)
    }

    pub(crate) async fn signing(&self) -> Result<crate::config::Signing> {
        self.context.check()?;
        let signing = self
            .config
            .signing
            .clone()
            .ok_or(Error::Dependency("部署者未配置构建签名文件"))?;
        for path in [
            &signing.keystore,
            &signing.store_password_file,
            &signing.key_password_file,
        ] {
            crate::config::paths::regular(path, false, &self.context).await?;
        }
        Ok(signing)
    }

    pub(crate) async fn finish(self, result: Result<Output>) -> Execution {
        let result = match self.context.check() {
            Ok(()) => result,
            Err(error) => Err(error.into()),
        };
        let complete = self.cleanup().await;
        let result = if complete {
            result
        } else {
            Err(Error::CleanupFailed)
        };
        Execution {
            outcome: result.map_err(|error| error.to_string()),
            cleanup: if complete {
                CleanupOutcome::Complete
            } else {
                CleanupOutcome::Failed
            },
        }
    }

    async fn cleanup(&self) -> bool {
        if self.unresolved.load(Ordering::Acquire) || Arc::strong_count(&self.lease) != 1 {
            return false;
        }
        let path = self.lease.path.clone();
        let Ok(until) = self.cleanup_point() else {
            return false;
        };
        let cleanup = tokio::task::spawn_blocking(move || files::remove_owned(&path));
        matches!(
            tokio::time::timeout_at(until, cleanup).await,
            Ok(Ok(Ok(())))
        )
    }

    /// 工具、监测、工作与目录删除沿同一次收口点，失败后不重计时。
    fn cleanup_point(&self) -> Result<tokio::time::Instant> {
        let mut until = self
            .cleanup_until
            .lock()
            .map_err(|_| Error::CleanupFailed)?;
        Ok(*until
            .get_or_insert_with(|| tokio::time::Instant::now() + std::time::Duration::from_secs(2)))
    }

    fn resume_after_monitor(&self) -> Result<()> {
        self.context.check()?;
        if self.unresolved.load(Ordering::Acquire) || Arc::strong_count(&self.lease) != 1 {
            return Err(Error::CleanupFailed);
        }
        *self
            .cleanup_until
            .lock()
            .map_err(|_| Error::CleanupFailed)? = None;
        Ok(())
    }

    pub(crate) async fn publish(&self, name: &str) -> Result<ArtifactOutput> {
        if ![
            "extracted.apk",
            "built.apks",
            "decoded.zip",
            "selected-apks.zip",
        ]
        .contains(&name)
        {
            return Err(Error::Invalid("输出名称未授权"));
        }
        let source = self.root.join(name);
        let target = self.output.join(name);
        self.work(move |control| files::copy_output(&source, &target, control))
            .await?;
        Ok(ArtifactOutput {
            filename: name.into(),
        })
    }

    pub(crate) async fn write_private(&self, name: &str, bytes: &[u8]) -> Result<PathBuf> {
        files::filename(name)?;
        if bytes.len() > 65_536 {
            return Err(Error::TooLarge);
        }
        let path = self.root.join(name);
        let target = path.clone();
        let bytes = bytes.to_vec();
        self.work(move |control| files::write(&target, &bytes, control))
            .await?;
        Ok(path)
    }
}
