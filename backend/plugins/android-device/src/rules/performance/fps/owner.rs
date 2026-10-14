//! 图层归属规则：原生身份声明与父链共同成立；API 28 使用完整窗口会话桥。
mod proto;
mod window;
mod wire;
use super::super::Check;
use super::{Layer, belongs_to_package};
use crate::{Error, Result};
use std::collections::{BTreeMap, BTreeSet};
pub(super) use window::Witness;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Record {
    pub id: i32,
    pub name: String,
    pub parent: Option<i32>,
    pub uid: Option<u32>,
    pub has_metadata: bool,
    pub metadata_uid: Option<u32>,
    pub metadata_pid: Option<u32>,
}

pub(crate) fn uid(output: &str, expected_pid: u32, check: Check<'_>) -> Result<Option<u32>> {
    let mut pid = None;
    let mut uid = None;
    for (index, line) in output.lines().enumerate() {
        check()?;
        if index >= 256 {
            return Err(Error::TooLarge);
        }
        if let Some(value) = line.strip_prefix("Pid:") {
            if pid.is_some() {
                return Ok(None);
            }
            pid = value.trim().parse::<u32>().ok();
            if pid != Some(expected_pid) {
                return Ok(None);
            }
        }
        if let Some(value) = line.strip_prefix("Uid:") {
            if uid.is_some() {
                return Ok(None);
            }
            let values = value
                .split_whitespace()
                .take(5)
                .map(|x| {
                    if x.is_empty() || !x.bytes().all(|byte| byte.is_ascii_digit()) {
                        None
                    } else {
                        x.parse::<u32>().ok().filter(|uid| *uid <= i32::MAX as u32)
                    }
                })
                .collect::<Option<Vec<_>>>();
            let Some(values) = values else {
                return Ok(None);
            };
            if values.len() != 4 || values.iter().any(|x| *x != values[0]) {
                return Ok(None);
            }
            uid = Some(values[0]);
        }
    }
    check()?;
    Ok(if pid == Some(expected_pid) { uid } else { None })
}

#[derive(Debug)]
pub(crate) enum Qualification {
    Owned(Layer),
    Window(Directory),
}

#[derive(Debug)]
pub(crate) struct Directory {
    records: Vec<Record>,
    sdk: u32,
    legacy: bool,
    package: String,
    pid: u32,
    uid: u32,
}

pub(crate) fn layer(
    data: &[u8],
    package: &str,
    pid: u32,
    uid: u32,
    sdk: u32,
    check: Check<'_>,
) -> Result<Option<Qualification>> {
    super::super::package(package)?;
    let records = match proto::parse(data, check) {
        Err(Error::Dependency(_)) => return Ok(None),
        other => other?,
    };
    // API 28 缺少图层 UID/metadata；仅完整无声明目录允许精确窗口桥。
    // 混合目录不能把缺少声明的图层补成已知归属。
    let legacy = sdk == 28
        && records
            .iter()
            .all(|record| record.uid.is_none() && !record.has_metadata);
    if sdk == 28 && !legacy {
        return Ok(None);
    }
    let directory = Directory {
        records,
        sdk,
        legacy,
        package: package.to_owned(),
        pid,
        uid,
    };
    let (selected, needs_window) = directory.select(&[], check)?;
    Ok(match selected {
        Some(layer) => Some(Qualification::Owned(layer)),
        None if needs_window => Some(Qualification::Window(directory)),
        None => None,
    })
}

impl Directory {
    pub(crate) fn window_layer(&self, output: &str, check: Check<'_>) -> Result<Option<Layer>> {
        let Some(windows) = window::parse(output, &self.package, self.pid, self.uid, check)? else {
            return Ok(None);
        };
        Ok(self.select(&windows, check)?.0)
    }

    fn select(&self, windows: &[Witness], check: Check<'_>) -> Result<(Option<Layer>, bool)> {
        let Self {
            records,
            sdk,
            legacy,
            package,
            pid,
            uid,
        } = self;
        let (pid, uid, sdk, legacy) = (*pid, *uid, *sdk, *legacy);
        let by_id: BTreeMap<_, _> = records.iter().map(|record| (record.id, record)).collect();
        let mut needs_window = false;
        let mut selected = None;
        for candidate in records {
            check()?;
            if candidate.uid.is_some_and(|value| value != uid)
                || !(candidate.name.starts_with("SurfaceView")
                    || (candidate.name.starts_with(package.as_str())
                        && candidate.name.contains("(BLAST)")))
                || !belongs_to_package(&candidate.name, package)
            {
                continue;
            }
            // latency按名字查找；全目录重名也无法证明读回的是这一层。
            if records
                .iter()
                .filter(|record| record.name == candidate.name)
                .count()
                != 1
            {
                return Ok((None, false));
            }
            let mut chain = Vec::new();
            let mut visited = BTreeSet::new();
            let mut current = candidate;
            let mut witnessed = false;
            loop {
                check()?;
                if !visited.insert(current.id) || chain.len() >= 4096 {
                    return Ok((None, false));
                }
                if current.metadata_uid.is_some_and(|value| value != uid)
                    || current.metadata_pid.is_some_and(|value| value != pid)
                {
                    return Ok((None, false));
                }
                if current.metadata_uid == Some(uid) && current.metadata_pid == Some(pid) {
                    witnessed = true;
                }
                chain.push(current.clone());
                // API 28 原件根层不写 parent；不能把字段缺省误读为 ID 0。
                // 显式 ID 0 及任何失联父 ID 仍按真实引用检查，其他版本保持原资格。
                if current.parent == Some(-1) || (legacy && current.parent.is_none()) {
                    break;
                }
                let Some(parent_id) = current.parent else {
                    return Ok((None, false));
                };
                let Some(parent) = by_id.get(&parent_id) else {
                    return Ok((None, false));
                };
                current = parent;
            }
            let window = if witnessed {
                None
            } else {
                if windows.is_empty() {
                    needs_window |= legacy
                        || (chain.iter().any(|record| record.metadata_uid == Some(uid))
                            && chain.iter().all(|record| record.metadata_pid.is_none()));
                    continue;
                }
                let Some(witness) = window::bind(records, &chain, windows, uid, legacy, check)?
                else {
                    continue;
                };
                Some(witness)
            };
            if selected.is_some() {
                return Ok((None, false));
            }
            selected = Some(Layer {
                name: candidate.name.clone(),
                sdk,
                pid,
                uid,
                chain,
                window,
            });
        }
        check()?;
        Ok((selected, needs_window))
    }
}
#[cfg(test)]
mod tests;
