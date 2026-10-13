use crate::{
    config::Config,
    model::TurnResult,
    model::{PROFILE, PROVIDER, SDK_VERSION},
    resources::Resources,
};
use deviceforge_plugin_runtime::InvocationContext;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelEvidence {
    format_version: u32,
    provider: String,
    sdk_version: String,
    profile: String,
    configuration_sha256: String,
    project_id: String,
    thread_id: String,
    turns: String,
}

pub struct Record {
    pub outcome: Result<(), String>,
    pub worker_complete: bool,
}

fn fingerprint(config: &Config) -> Result<String, String> {
    let value = json!({
        "profile":config.profile,"node_executable":config.node_executable,"node_version":config.node_version,
        "sdk_entry":config.sdk_entry,"sdk_version":config.sdk_version,"cli_executable":config.cli_executable,
        "cli_version":config.cli_version,"projects":config.projects,"state_root":config.state_root,
        "codex_home":config.codex_home,"environment":config.environment,"thread_options":config.thread_options,
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| "SDK模型资格配置摘要无法编码")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn read(config: &Config) -> Result<Option<ModelEvidence>, String> {
    let path = config.state_root.join("model-qualification.json");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("SDK模型资格记录无法检查".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("SDK模型资格记录类型或大小无效".into());
    }
    let file = File::open(path).map_err(|_| "SDK模型资格记录无法打开")?;
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "SDK模型资格记录无法读取")?;
    if bytes.len() > 4096 {
        return Err("SDK模型资格记录超限".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "SDK模型资格记录无效".into())
}

pub async fn verified(config: Config, context: InvocationContext) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        context.check().map_err(|error| error.to_string())?;
        let evidence = read(&config)?;
        let Some(evidence) = evidence else {
            return Ok(false);
        };
        let turns = evidence
            .turns
            .parse::<u64>()
            .ok()
            .filter(|turns| *turns > 0 && turns.to_string() == evidence.turns);
        Ok(evidence.format_version == 1
            && evidence.provider == PROVIDER
            && evidence.sdk_version == SDK_VERSION
            && evidence.profile == PROFILE
            && evidence.configuration_sha256 == fingerprint(&config)?
            && config.projects.contains_key(&evidence.project_id)
            && crate::model::normalize_thread(&evidence.thread_id)
                .is_ok_and(|thread| thread == evidence.thread_id)
            && turns.is_some())
    })
    .await
    .map_err(|_| "SDK模型资格读取worker失败")?
}

fn check(context: &InvocationContext, until: Instant) -> Result<(), String> {
    context.check().map_err(|error| error.to_string())?;
    if Instant::now() >= until {
        return Err("SDK模型资格提交清理窗口已到期".into());
    }
    Ok(())
}

fn lock(path: &Path, context: &InvocationContext, until: Instant) -> Result<File, String> {
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("SDK模型资格锁不能是链接".into());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "SDK模型资格锁无法打开")?;
    loop {
        check(context, until)?;
        match lock.try_lock_exclusive() {
            Ok(()) => return Ok(lock),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return Err("SDK模型资格锁失败".into()),
        }
    }
}

pub async fn record(
    config: Arc<Config>,
    context: InvocationContext,
    result: &TurnResult,
    until: Instant,
    resources: Arc<Resources>,
) -> Record {
    let configuration_sha256 = match fingerprint(&config) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            return Record {
                outcome: Err(error),
                worker_complete: true,
            };
        }
    };
    let evidence = ModelEvidence {
        format_version: 1,
        provider: PROVIDER.into(),
        sdk_version: SDK_VERSION.into(),
        profile: PROFILE.into(),
        configuration_sha256,
        project_id: result.project_id.clone(),
        thread_id: result.thread_id.clone(),
        turns: result.turns.clone(),
    };
    let worker = tokio::task::spawn_blocking(move || {
        let _resources = resources;
        let _lock = lock(
            &config.state_root.join("model-qualification.lock"),
            &context,
            until,
        )?;
        let bytes = serde_json::to_vec(&evidence).map_err(|_| "SDK模型资格记录无法编码")?;
        if bytes.len() > 4096 {
            return Err("SDK模型资格记录超限".into());
        }
        let mut staged = tempfile::NamedTempFile::new_in(&config.state_root)
            .map_err(|_| "SDK模型资格记录无法准备")?;
        staged
            .write_all(&bytes)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| "SDK模型资格记录无法写入")?;
        check(&context, until)?;
        let target = config.state_root.join("model-qualification.json");
        if std::fs::symlink_metadata(&target)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("SDK模型资格记录不能是链接".into());
        }
        staged
            .persist(target)
            .map_err(|_| "SDK模型资格记录提交失败")?;
        Ok(())
    });
    match tokio::time::timeout_at(tokio::time::Instant::from_std(until), worker).await {
        Ok(Ok(outcome)) => Record {
            outcome,
            worker_complete: true,
        },
        Ok(Err(_)) => Record {
            outcome: Err("SDK模型资格提交worker失败".into()),
            worker_complete: true,
        },
        Err(_) => Record {
            outcome: Err("SDK模型资格提交worker实际结束未确认".into()),
            worker_complete: false,
        },
    }
}
