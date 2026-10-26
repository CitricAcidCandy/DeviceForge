//! 创建前写意图、完成后写阶段；租约随工具监督保留。
use super::{process::Identity, store};
use serde::{Deserialize, Serialize};
use std::{fs::File, path::PathBuf, sync::Arc};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    #[default]
    Planned,
    Attempting,
    Confirmed,
    Released,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RemoteIdentity {
    pub pid: u32,
    pub start: String,
    pub boot: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub version: u8,
    pub device_id: String,
    pub token: String,
    pub directory: String,
    pub scid: String,
    pub port: Option<u16>,
    pub server_version: String,
    #[serde(default)]
    pub externally_managed: bool,
    pub owner: Identity,
    pub directory_stage: Stage,
    pub upload_stage: Stage,
    pub forward_stage: Stage,
    pub server_stage: Stage,
    pub remote: Option<RemoteIdentity>,
}

pub(crate) fn device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

impl Record {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || !device_id(&self.device_id)
            || self.token.len() != 32
            || !hex(&self.token)
            || self.port == Some(0)
            || self.owner.pid == 0
            || self.owner.birth.is_empty()
            || self.owner.birth.len() > 128
        {
            return Err("资源台账身份或版本无效".into());
        }
        if self.externally_managed {
            if !self.directory.is_empty()
                || !self.scid.is_empty()
                || self.port.is_some()
                || self.server_version != "external"
                || self.remote.is_some()
            {
                return Err("外部录制债务不能伪造远端独占归属".into());
            }
        } else if self.directory != format!("/data/local/tmp/deviceforge_{}", self.token)
            || self.scid.len() != 8
            || !hex(&self.scid)
            || self.scid == "00000000"
            || crate::config::server_version(&self.server_version).is_none()
        {
            return Err("直播资源台账身份或版本无效".into());
        }
        if let Some(identity) = &self.remote
            && (identity.pid < 2
                || identity.start.is_empty()
                || identity.start.len() > 24
                || !identity.start.bytes().all(|byte| byte.is_ascii_digit())
                || identity.boot.len() != 36
                || !identity
                    .boot
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
        {
            return Err("远端进程台账身份无效".into());
        }
        Ok(())
    }

    pub fn path(&self, root: &std::path::Path) -> PathBuf {
        root.join(format!("{}.json", self.token))
    }
}

fn hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) struct ToolLease {
    pub _resource: Arc<File>,
    pub _process: Arc<File>,
}

pub(crate) struct Ledger {
    pub record: Record,
    root: PathBuf,
    pub lease: Arc<ToolLease>,
}

impl Ledger {
    pub async fn create(record: Record) -> Result<Self, String> {
        record.validate()?;
        let process = store::process_lease(true)
            .await?
            .ok_or("本次资源进程租约暂不可用")?;
        let root = store::root()?;
        Self::create_at(root, record, process).await
    }

    pub(super) async fn create_at(
        root: PathBuf,
        record: Record,
        process: Arc<File>,
    ) -> Result<Self, String> {
        record.validate()?;
        store::io(move || {
            store::prepare(&root)?;
            let lease = store::lock(&root.join(format!("{}.lease", record.token)), false)?
                .ok_or("资源台账身份已经使用")?;
            let _catalog =
                store::lock(&root.join("catalog.lock"), false)?.ok_or("资源台账正在登记")?;
            store::registration_capacity(&root)?;
            let path = record.path(&root);
            if path.exists() {
                return Err("资源台账身份冲突".into());
            }
            let bytes = serde_json::to_vec(&record).map_err(|_| "资源台账编码失败")?;
            store::publish(&path, &bytes)?;
            Ok(Self {
                record,
                root,
                lease: Arc::new(ToolLease {
                    _resource: lease,
                    _process: process,
                }),
            })
        })
        .await
    }

    pub async fn save(&self) -> Result<(), String> {
        let record = self.record.clone();
        let root = self.root.clone();
        let lease = self.lease.clone();
        store::io(move || {
            let _lease = lease;
            record.validate()?;
            store::publish(
                &record.path(&root),
                &serde_json::to_vec(&record).map_err(|_| "资源台账编码失败")?,
            )
        })
        .await
    }

    pub async fn remove(&self) -> Result<(), String> {
        let path = self.record.path(&self.root);
        let lease = self.lease.clone();
        store::io(move || {
            let _lease = lease;
            std::fs::remove_file(path).map_err(|_| "已核对资源台账撤销失败".into())
        })
        .await
    }
}

pub(super) async fn read_all(root: &std::path::Path) -> Result<Vec<Record>, String> {
    let root = root.to_owned();
    store::io(move || {
        store::paths(&root)?
            .into_iter()
            .map(|path| {
                let record: Record =
                    serde_json::from_slice(&store::read(&path)?).map_err(|_| "资源台账无法解析")?;
                record.validate()?;
                if record.path(&root) != path {
                    return Err("资源台账文件归属不符".into());
                }
                Ok(record)
            })
            .collect()
    })
    .await
}

pub(super) async fn reload(
    root: &std::path::Path,
    record: &Record,
) -> Result<Option<Record>, String> {
    let path = record.path(root);
    store::io(move || {
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法重新检查资源台账".into()),
            Ok(_) => {}
        }
        let record: Record =
            serde_json::from_slice(&store::read(&path)?).map_err(|_| "资源台账无法解析")?;
        record.validate()?;
        if record.path(path.parent().ok_or("资源台账目录缺失")?) != path {
            return Err("资源台账文件归属不符".into());
        }
        Ok(Some(record))
    })
    .await
}
