//! 游戏展示帧的纯规则；不清空全局计数，不访问设备、时钟或会话。
use super::Check;
use crate::{Error, Result};
use apk_plugin_sdk::FrameWindow;
use sha2::{Digest, Sha256};

const MAX_LAYER_ROWS: usize = 4096;
const MAX_FRAME_ROWS: usize = 256;
const MAX_SPAN_NS: u64 = 60_000_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Layer {
    name: String,
}

impl Layer {
    /// ADB shell 会合并参数，因此层名必须作为一个受检的单引号参数。
    pub(crate) fn shell_argument(&self) -> String {
        format!("'{}'", self.name.replace('\'', "'\\''"))
    }

    fn source(&self) -> String {
        let digest = Sha256::digest(self.name.as_bytes());
        let mut source = String::from("sf_present_");
        for byte in &digest[..8] {
            source.push_str(&format!("{byte:02x}"));
        }
        source
    }
}

#[derive(Debug)]
pub(crate) struct Snapshot {
    present_ns: Vec<u64>,
}

fn belongs_to_package(name: &str, package: &str) -> bool {
    name.match_indices(package).any(|(index, _)| {
        let before = index == 0
            || matches!(name.as_bytes().get(index - 1), Some(b'[' | b' ' | b'(' | b'='));
        let after = matches!(
            name.as_bytes().get(index + package.len()),
            None | Some(b'/' | b' ' | b']' | b')' | b'#' | b'(')
        );
        before && after
    })
}

pub(crate) fn unique_layer(
    output: &str,
    package: &str,
    check: Check<'_>,
) -> Result<Option<Layer>> {
    super::package(package)?;
    let mut selected = None;
    for (index, line) in output.lines().enumerate() {
        check()?;
        if index >= MAX_LAYER_ROWS {
            return Err(Error::TooLarge);
        }
        let name = line.trim();
        if !(name.contains("SurfaceView") || name.contains("BLAST"))
            || !belongs_to_package(name, package)
        {
            continue;
        }
        if name.len() > 1024
            || name.chars().any(char::is_control)
            || name.contains('\u{fffd}')
            || selected.is_some()
        {
            return Ok(None);
        }
        selected = Some(Layer { name: name.into() });
    }
    Ok(selected)
}

fn nanoseconds(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|value| *value <= i64::MAX as u64)
}

pub(crate) fn snapshot(output: &str, check: Check<'_>) -> Result<Option<Snapshot>> {
    check()?;
    let mut lines = output.lines().filter(|line| !line.trim().is_empty());
    let Some(refresh) = lines.next().and_then(|line| nanoseconds(line.trim())) else {
        return Ok(None);
    };
    if !(1..=1_000_000_000).contains(&refresh) {
        return Ok(None);
    }
    let mut present_ns = Vec::new();
    for (index, line) in lines.enumerate() {
        check()?;
        if index >= MAX_FRAME_ROWS {
            return Err(Error::TooLarge);
        }
        let mut fields = line.split_whitespace();
        let (Some(desired), Some(actual), Some(ready)) = (
            fields.next().and_then(nanoseconds),
            fields.next().and_then(nanoseconds),
            fields.next().and_then(nanoseconds),
        ) else {
            return Ok(None);
        };
        if fields.next().is_some() {
            return Ok(None);
        }
        let _ = (desired, ready);
        if actual == 0 || actual == i64::MAX as u64 {
            continue;
        }
        if let Some(last) = present_ns.last() {
            if actual < *last {
                return Ok(None);
            }
            // 同一次展示即使重复出现在环形缓存也只算一帧。
            if actual == *last {
                continue;
            }
        }
        present_ns.push(actual);
    }
    Ok(Some(Snapshot { present_ns }))
}

pub(crate) fn window(
    layer: &Layer,
    before: &Snapshot,
    after: &Snapshot,
    check: Check<'_>,
) -> Result<Option<FrameWindow>> {
    check()?;
    let Some(anchor) = before.present_ns.last() else {
        return Ok(None);
    };
    let mut position = None;
    for (index, present) in after.present_ns.iter().enumerate() {
        check()?;
        if present == anchor {
            position = Some(index);
            break;
        }
    }
    let Some(position) = position else {
        // 环形缓存覆盖了原锚时不能猜测丢失了多少帧。
        return Ok(None);
    };
    let Some(last) = after.present_ns.last() else {
        return Ok(None);
    };
    let Some(span_ns) = last.checked_sub(*anchor) else {
        return Ok(None);
    };
    if span_ns == 0 || span_ns > MAX_SPAN_NS {
        return Ok(None);
    }
    let Some(frames) = after.present_ns.len().checked_sub(position + 1) else {
        return Ok(None);
    };
    let Some(frames) = u64::try_from(frames).ok().filter(|frames| *frames > 0) else {
        return Ok(None);
    };
    // 公共窗口只有整数毫秒；向上取整避免缩短真实跨度后夸大 FPS。
    let Some(duration_ms) = span_ns
        .checked_add(999_999)
        .map(|span| span / 1_000_000)
        .and_then(|span| u32::try_from(span).ok())
        .filter(|span| (1..=60_000).contains(span) && frames <= u64::from(*span))
    else {
        return Ok(None);
    };
    check()?;
    Ok(Some(FrameWindow {
        frames,
        duration_ms,
        source: layer.source(),
    }))
}

#[cfg(test)]
mod tests;
