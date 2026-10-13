//! 图层归属规则：候选真实UID与整条父链上的PID/UID见证共同成立。
mod proto;
mod wire;
use super::{Layer, belongs_to_package};
use super::super::Check;
use crate::{Error, Result};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Record {
    pub id: i32,
    pub name: String,
    pub parent: i32,
    pub uid: Option<u32>,
    pub metadata_uid: Option<u32>,
    pub metadata_pid: Option<u32>,
}

pub(crate) fn uid(output: &str, expected_pid: u32, check: Check<'_>) -> Result<Option<u32>> {
    let mut pid = None;
    let mut uid = None;
    for (index,line) in output.lines().enumerate() {
        check()?;
        if index >= 256 { return Err(Error::TooLarge); }
        if let Some(value) = line.strip_prefix("Pid:") {
            if pid.is_some() { return Ok(None); }
            pid = value.trim().parse::<u32>().ok();
            if pid != Some(expected_pid) { return Ok(None); }
        }
        if let Some(value) = line.strip_prefix("Uid:") {
            if uid.is_some() { return Ok(None); }
            let values = value.split_whitespace().take(5).map(|x| {
                if x.is_empty() || !x.bytes().all(|byte| byte.is_ascii_digit()) { None }
                else { x.parse::<u32>().ok().filter(|uid| *uid <= i32::MAX as u32) }
            }).collect::<Option<Vec<_>>>();
            let Some(values) = values else { return Ok(None); };
            if values.len() != 4 || values.iter().any(|x| *x != values[0]) { return Ok(None); }
            uid = Some(values[0]);
        }
    }
    check()?;
    Ok(if pid == Some(expected_pid) { uid } else { None })
}

pub(crate) fn layer(data: &[u8], package: &str, pid: u32, uid: u32, check: Check<'_>) -> Result<Option<Layer>> {
    super::super::package(package)?;
    let records = match proto::parse(data,check) {
        Err(Error::Dependency(_)) => return Ok(None),
        other => other?,
    };
    let by_id: BTreeMap<_,_> = records.iter().map(|record| (record.id,record)).collect();
    let mut selected = None;
    for candidate in &records {
        check()?;
        if candidate.uid != Some(uid)
            || !(candidate.name.contains("SurfaceView") || candidate.name.contains("BLAST"))
            || !belongs_to_package(&candidate.name,package) { continue; }
        // latency按名字查找；全目录重名也无法证明读回的是这一层。
        if records.iter().filter(|record| record.name == candidate.name).count() != 1 { return Ok(None); }
        let mut chain = Vec::new();
        let mut visited = BTreeSet::new();
        let mut current = candidate;
        let mut witnessed = false;
        loop {
            check()?;
            if !visited.insert(current.id) || chain.len() >= 4096 { return Ok(None); }
            if current.metadata_uid.is_some_and(|value| value != uid)
                || current.metadata_pid.is_some_and(|value| value != pid) { return Ok(None); }
            if current.metadata_uid == Some(uid) && current.metadata_pid == Some(pid) {
                witnessed = true;
            }
            chain.push(current.clone());
            if current.parent == -1 { break; }
            let Some(parent) = by_id.get(&current.parent) else { return Ok(None); };
            current = parent;
        }
        if !witnessed { continue; }
        if selected.is_some() { return Ok(None); }
        selected = Some(Layer { name: candidate.name.clone(), pid, uid, chain });
    }
    check()?;
    Ok(selected)
}
#[cfg(test)]
mod tests;
