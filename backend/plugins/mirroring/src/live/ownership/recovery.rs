//! 资源核对之后的协调状态恢复；存活锁、协调锁均不删除。
use super::{
    state::State,
    storage::{self, Paths},
};
use std::{
    collections::BTreeSet,
    fs::File,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Inspection {
    Clean,
    NeedsProof,
    Active,
    Busy,
}

fn root(resources: &Path) -> Result<PathBuf, String> {
    Ok(resources
        .parent()
        .ok_or("控制协调目录缺失")?
        .join(".mirroring-control"))
}

pub(crate) fn key(device: &str) -> String {
    storage::digest(device)
}

pub(crate) async fn list(resources: &Path) -> Result<Vec<String>, String> {
    let root = root(resources)?;
    storage::blocking(move || {
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("无法枚举控制协调状态".into()),
        };
        let mut keys = Vec::new();
        let mut count = 0;
        for entry in entries {
            count += 1;
            if count > 16384 {
                return Err("控制协调目录条目超限".into());
            }
            let path = entry.map_err(|_| "控制协调目录读取失败")?.path();
            if path.extension().is_some_and(|value| value == "json") {
                let name = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .ok_or("控制协调文件名无效")?;
                if name.len() != 64 || !name.bytes().all(|value| value.is_ascii_hexdigit()) {
                    return Err("控制协调文件名无效".into());
                }
                keys.push(name.to_owned());
                if keys.len() > 128 {
                    return Err("待核对控制协调状态超限".into());
                }
            }
        }
        keys.sort();
        Ok(keys)
    })
    .await
}

fn pins(paths: &Paths, state: &State) -> Result<Option<Vec<File>>, String> {
    let clients: BTreeSet<_> = state
        .participants
        .iter()
        .map(|entry| entry.client_id.as_str())
        .chain(
            [
                state.owner_id.as_deref(),
                state.target_id.as_deref(),
                state.recovery_id.as_deref(),
            ]
            .into_iter()
            .flatten(),
        )
        .collect();
    let mut pins = Vec::new();
    for client in clients {
        match paths.acquire_live(client) {
            Ok(pin) => pins.push(pin),
            Err(_) if paths.alive(client)? => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(Some(pins))
}

pub(crate) async fn inspect(
    resources: &Path,
    key: &str,
    confirmed: bool,
) -> Result<Inspection, String> {
    let key = key.to_owned();
    let root = root(resources)?;
    storage::blocking(move || inspect_at(Paths { root, device: key }, confirmed)).await
}

fn inspect_at(paths: Paths, confirmed: bool) -> Result<Inspection, String> {
    let _lock = paths.acquire()?;
    let state = paths.read()?;
    let Some(_pins) = pins(&paths, &state)? else {
        let owner_alive = match &state.owner_id {
            Some(owner) => paths.alive(owner)?,
            None => true,
        };
        return Ok(if !state.blocked && !confirmed && owner_alive {
            Inspection::Active
        } else {
            Inspection::Busy
        });
    };
    if (state.blocked || state.owner_id.is_some()) && !confirmed {
        return Ok(Inspection::NeedsProof);
    }
    if !confirmed {
        return Ok(Inspection::Clean);
    }
    let mut next = state.clone();
    next.owner_id = None;
    next.target_id = None;
    next.recovery_id = None;
    next.blocked = false;
    next.transitioning = false;
    next.participants.clear();
    next.requests.clear();
    if next != state {
        next.changed_from(&state)?;
        paths.save(&next)?;
    }
    Ok(Inspection::Clean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::ownership::Ownership;
    #[test]
    fn dead_owner_requires_resource_proof_and_preserves_revisions() {
        let root =
            std::env::temp_dir().join(format!("mirroring-recovery-control-{}", std::process::id()));
        let paths = Paths::new(root.clone(), "dead-test");
        paths.prepare().unwrap();
        let mut state = State::empty();
        state.blocked = true;
        state.owner_id = Some("lost".into());
        state.revision = 10;
        state.control_revision = 4;
        paths.save(&state).unwrap();
        assert_eq!(
            inspect_at(paths.clone(), false).unwrap(),
            Inspection::NeedsProof
        );
        assert!(paths.read().unwrap().blocked);
        assert_eq!(inspect_at(paths.clone(), true).unwrap(), Inspection::Clean);
        let next = paths.read().unwrap();
        assert!(!next.blocked && next.owner_id.is_none());
        assert_eq!((next.revision, next.control_revision), (11, 5));
        assert!(root.join(format!("{}.lock", paths.device)).exists());
    }
    #[test]
    fn active_participant_prevents_state_clear_even_with_remote_proof() {
        let root =
            std::env::temp_dir().join(format!("mirroring-recovery-active-{}", std::process::id()));
        let owner = Ownership::at(root.clone(), "active-test", "client").unwrap();
        let paths = Paths::new(root, "active-test");
        let mut state = State::empty();
        state.register("client", true, true).unwrap();
        paths.save(&state).unwrap();
        assert_eq!(inspect_at(paths.clone(), true).unwrap(), Inspection::Busy);
        assert_eq!(paths.read().unwrap().owner_id.as_deref(), Some("client"));
        drop(owner);
        assert_eq!(inspect_at(paths, true).unwrap(), Inspection::Clean);
    }
}
