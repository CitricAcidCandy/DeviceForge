use super::{models::FILE_LIMIT, scripts};
use crate::{Error, Result};

pub(super) fn utf8(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| Error::Dependency("截图回执不是有效UTF-8"))
}

pub(super) fn terminal<'a>(text: &'a str, kind: &str, token: &str) -> Result<&'a str> {
    if !text.ends_with('\n') {
        return Err(Error::Dependency("截图缺少完整终端回执"));
    }
    let prefix = format!("{kind}:{token}:");
    let all_prefix = format!("{kind}:");
    let mut matching = text.lines().filter(|line| line.starts_with(&all_prefix));
    let line = matching
        .next()
        .ok_or(Error::Dependency("截图缺少完整终端回执"))?;
    if matching.next().is_some() || text.lines().last() != Some(line) {
        return Err(Error::Dependency("截图回执重复或不是终端帧"));
    }
    line.strip_prefix(&prefix)
        .ok_or(Error::Dependency("截图回执所有权标识不一致"))
}

pub(super) fn status(value: &str) -> Result<u8> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Error::Dependency("截图回执状态无效"));
    }
    value
        .parse()
        .map_err(|_| Error::Dependency("截图回执状态无效"))
}

pub(super) fn exact(text: &str, kind: &str, token: &str) -> bool {
    let expected = format!("{kind}:{token}");
    text.ends_with('\n')
        && text.lines().last() == Some(expected.as_str())
        && text
            .lines()
            .filter(|line| line.starts_with(&format!("{kind}:")))
            .count()
            == 1
}

pub(super) fn probe(text: &str, token: &str, stderr: &[u8]) -> Result<()> {
    crate::rules::text(text.as_bytes(), stderr)?;
    let normalized = text.replace("\r\n", "\n");
    let footer = format!("DF_PROBE_DONE:{token}:0\n");
    if normalized != format!("RGV2aWNlRm9yZ2U=\n{footer}")
        && normalized != format!("RGV2aWNlRm9yZ2U=\n\n{footer}")
    {
        return Err(Error::Dependency("设备未通过base64 -w 0资格探测"));
    }
    Ok(())
}

pub(super) fn captured(text: &str, token: &str, stderr: &[u8], exit: u8) -> Result<()> {
    crate::rules::text(text.as_bytes(), stderr)?;
    if exit != 0 {
        return Err(Error::Dependency("设备截图命令执行失败"));
    }
    let owner = format!("DF_OWNER_READY:{token}");
    if text
        .lines()
        .filter(|line| line.starts_with("DF_OWNER_READY:"))
        .collect::<Vec<_>>()
        != [owner.as_str()]
    {
        return Err(Error::Dependency("截图独占目录所有权未确认"));
    }
    let path = scripts::path(token);
    let success = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("success: snapshot display "))
        .collect::<Vec<_>>();
    let [success] = success.as_slice() else {
        return Err(Error::Dependency("设备截图缺少唯一JPEG成功诊断"));
    };
    let (display, written) = success
        .split_once(" , write to ")
        .ok_or(Error::Dependency("设备截图成功诊断无效"))?;
    if display.is_empty() || !display.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Error::Dependency("设备截图屏幕标识无效"));
    }
    let dimensions = written
        .strip_prefix(&format!("{path} as jpeg, width "))
        .ok_or(Error::Dependency("设备截图成功路径不一致"))?;
    let (width, height) = dimensions
        .split_once(", height ")
        .ok_or(Error::Dependency("设备截图尺寸诊断无效"))?;
    for value in [width, height] {
        if value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || value.parse::<u16>().ok().is_none_or(|size| size == 0)
        {
            return Err(Error::Dependency("设备截图尺寸诊断无效"));
        }
    }
    Ok(())
}

pub(super) fn size(value: &str) -> Result<u64> {
    let value = value.trim_matches(|character: char| character.is_ascii_whitespace());
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Error::Dependency("设备截图大小回执无效"));
    }
    let size = value.parse::<u64>().map_err(|_| Error::TooLarge)?;
    if size == 0 {
        return Err(Error::Dependency("设备截图文件为空"));
    }
    if size > FILE_LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(size)
}
