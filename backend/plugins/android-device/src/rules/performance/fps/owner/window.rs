//! Android 9/11 窗口身份见证；Java 对象标识只作代际复核，绝不当作原生图层 ID。
use super::super::super::Check;
use super::Record;
use crate::{Error, Result};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::rules::performance::fps) struct Witness {
    pub token: String,
    pub title: String,
    pub session: String,
    pub surface: String,
    pub surface_handle: String,
}

struct Pending {
    token: String,
    title: String,
    user: u32,
    fields: BTreeMap<&'static str, String>,
}

fn decimal(value: &str) -> Option<u32> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok().filter(|value| *value <= i32::MAX as u32)
}

fn hexadecimal(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn header(line: &str) -> Option<Pending> {
    let (index, value) = line
        .trim_start()
        .strip_prefix("Window #")?
        .split_once(' ')?;
    decimal(index)?;
    let value = value.strip_prefix("Window{")?.strip_suffix("}:")?;
    let mut parts = value.splitn(3, ' ');
    let token = parts.next()?;
    let user = decimal(parts.next()?.strip_prefix('u')?)?;
    let title = parts.next()?;
    if !hexadecimal(token)
        || title.is_empty()
        || title.len() > 1024
        || title.chars().any(char::is_control)
    {
        return None;
    }
    Some(Pending {
        token: token.to_owned(),
        title: title.to_owned(),
        user,
        fields: BTreeMap::new(),
    })
}

impl Pending {
    fn put(&mut self, key: &'static str, value: &str) -> bool {
        value.len() <= 1024 && self.fields.insert(key, value.to_owned()).is_none()
    }

    fn read(&mut self, line: &str) -> bool {
        if let Some((_, value)) = line.split_once("mSession=Session{") {
            let Some((value, _)) = value.split_once('}') else {
                return false;
            };
            if !self.put("session", value) {
                return false;
            }
        }
        if let Some(value) = line.trim().strip_prefix("mSurface=Surface(name=") {
            let Some((surface, handle)) = value.rsplit_once(")/@0x") else {
                return false;
            };
            if !hexadecimal(handle)
                || !self.put("surface", surface)
                || !self.put("surface_handle", handle)
            {
                return false;
            }
        }
        for part in line.split_whitespace() {
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            for expected in [
                "mOwnerUid",
                "package",
                "mHasSurface",
                "isReadyForDisplay()",
                "isOnScreen",
                "isVisible",
                "mViewVisibility",
                "mAppDied",
                "mDrawState",
                "mLastHidden",
            ] {
                if key == expected && !self.put(expected, value) {
                    return false;
                }
            }
        }
        true
    }

    fn finish(self, package: &str, pid: u32, uid: u32) -> Option<Witness> {
        let fields = &self.fields;
        if fields.get("package")?.as_str() != package || decimal(fields.get("mOwnerUid")?)? != uid {
            return None;
        }
        for (key, expected) in [
            ("mHasSurface", "true"),
            ("isReadyForDisplay()", "true"),
            ("isOnScreen", "true"),
            ("isVisible", "true"),
            ("mViewVisibility", "0x0"),
            ("mAppDied", "false"),
            ("mDrawState", "HAS_DRAWN"),
            ("mLastHidden", "false"),
        ] {
            if fields.get(key)?.as_str() != expected {
                return None;
            }
        }
        let session = fields.get("session")?;
        let (session_token, identity) = session.split_once(' ')?;
        let (session_pid, identity) = identity.split_once(":u")?;
        let (user, app) = identity.split_once('a')?;
        let (user, app) = (decimal(user)?, decimal(app)?);
        if !hexadecimal(session_token)
            || decimal(session_pid)? != pid
            || user != self.user
            || app >= 100_000
            || user.checked_mul(100_000)?.checked_add(app)? != uid
        {
            return None;
        }
        Some(Witness {
            token: self.token,
            title: self.title,
            session: session.to_owned(),
            surface: fields.get("surface")?.clone(),
            surface_handle: fields.get("surface_handle")?.clone(),
        })
    }
}

pub(super) fn parse(
    output: &str,
    package: &str,
    pid: u32,
    uid: u32,
    check: Check<'_>,
) -> Result<Option<Vec<Witness>>> {
    check()?;
    if output.len() > 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut current = None;
    let mut windows = Vec::new();
    let mut tokens = BTreeSet::new();
    for (index, line) in output.lines().enumerate() {
        check()?;
        if index >= 16_384 || line.len() > 4096 {
            return Err(Error::TooLarge);
        }
        if line.trim_start().starts_with("Window #") {
            if let Some(pending) = current.take()
                && let Some(witness) = Pending::finish(pending, package, pid, uid)
            {
                windows.push(witness);
            }
            let Some(pending) = header(line) else {
                return Ok(None);
            };
            if tokens.len() >= 512 {
                return Err(Error::TooLarge);
            }
            if !tokens.insert(pending.token.clone()) {
                return Ok(None);
            }
            current = Some(pending);
        } else if let Some(pending) = current.as_mut()
            && !pending.read(line)
        {
            return Ok(None);
        }
    }
    if let Some(pending) = current
        && let Some(witness) = pending.finish(package, pid, uid)
    {
        windows.push(witness);
    }
    check()?;
    Ok(Some(windows))
}

fn named_layer(name: &str, requested: &str) -> bool {
    name.strip_prefix(requested)
        .and_then(|value| value.strip_prefix('#'))
        .and_then(decimal)
        .is_some()
}

pub(super) fn bind(
    records: &[Record],
    chain: &[Record],
    windows: &[Witness],
    uid: u32,
    legacy: bool,
    check: Check<'_>,
) -> Result<Option<Witness>> {
    let mut selected = None;
    for window in windows {
        check()?;
        let container = format!("{} {}", window.token, window.title);
        for pair in chain.windows(2) {
            check()?;
            let (buffer, parent) = (&pair[0], &pair[1]);
            if !named_layer(&parent.name, &container) {
                continue;
            }
            // 声明的 Surface 必须通过数值父链直接挂在完整窗口容器下。
            // API 28 仅在全目录无 UID/metadata 且完整窗口会话身份成立时使用该桥。
            // 数值 parent ID 与完整名称须同时成立；同 UID 或名称前缀不能作为见证。
            if buffer.parent != Some(parent.id)
                || !named_layer(&buffer.name, &window.surface)
                || (!legacy && buffer.metadata_uid != Some(uid))
            {
                return Ok(None);
            }
            if records
                .iter()
                .filter(|record| named_layer(&record.name, &container))
                .count()
                != 1
                || records
                    .iter()
                    .filter(|record| {
                        record.parent == Some(parent.id)
                            && named_layer(&record.name, &window.surface)
                    })
                    .count()
                    != 1
                || selected.is_some()
            {
                return Ok(None);
            }
            selected = Some(window.clone());
        }
    }
    check()?;
    Ok(selected)
}

#[cfg(test)]
mod tests;
