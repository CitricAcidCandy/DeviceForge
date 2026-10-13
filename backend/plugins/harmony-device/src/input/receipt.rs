use crate::{Error, Result};

pub(super) struct Receipt {
    pub body: String,
    pub status: u8,
}

pub(super) fn parse(bytes: &[u8], token: &str, stage: &str) -> Result<Receipt> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::Dependency("Harmony输入回执不是有效UTF-8"))?
        .replace("\r\n", "\n");
    if !text.ends_with('\n') || text.contains('\r') {
        return Err(Error::Dependency("Harmony输入缺少完整终端回执"));
    }
    let mut frames = text
        .lines()
        .filter(|line| line.starts_with("DF_INPUT_DONE:"));
    let frame = frames
        .next()
        .ok_or(Error::Dependency("Harmony输入缺少完整终端回执"))?;
    if frames.next().is_some() || text.lines().last() != Some(frame) {
        return Err(Error::Dependency("Harmony输入回执重复或不是终端帧"));
    }
    let prefix = format!("DF_INPUT_DONE:{token}:{stage}:");
    let status = frame
        .strip_prefix(&prefix)
        .ok_or(Error::Dependency("Harmony输入回执标识或阶段不一致"))?;
    if status.is_empty()
        || !status.bytes().all(|byte| byte.is_ascii_digit())
        || (status.len() > 1 && status.starts_with('0'))
    {
        return Err(Error::Dependency("Harmony输入回执退出码无效"));
    }
    let status = status
        .parse::<u8>()
        .map_err(|_| Error::Dependency("Harmony输入回执退出码无效"))?;
    let body = text
        .strip_suffix(&format!("{frame}\n"))
        .ok_or(Error::Dependency("Harmony输入终端帧边界无效"))?
        .to_owned();
    Ok(Receipt { body, status })
}

pub(super) fn version(body: &str) -> Result<()> {
    if body.trim() != "5.0.1.1" {
        return Err(Error::Dependency("设备uitest版本不在当前固定输入档案中"));
    }
    Ok(())
}

pub(super) fn help(body: &str) -> Result<()> {
    let lines = body
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>();
    for expected in [
        "click/doubleClick/longClick <x> <y> click on the target coordinates",
        "swipe/drag <from_x> <from_y> <to_x> <to_y> [velocity] velocity ranges from 200 to 40000, default 600",
        "keyEvent <keyID/Back/Home/Power> inject keyEvent",
        "inputText <x> <y> <text> inputText at the target coordinate point",
    ] {
        if lines
            .iter()
            .filter(|line| line.as_str() == expected)
            .count()
            != 1
        {
            return Err(Error::Dependency("设备uitest帮助不符合当前固定输入档案"));
        }
    }
    if lines.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        [
            "[fail]",
            "error",
            "failed",
            "not found",
            "permission denied",
        ]
        .iter()
        .any(|word| lower.contains(word))
    }) {
        return Err(Error::Dependency("设备uitest资格探测返回失败诊断"));
    }
    Ok(())
}

pub(super) fn success(body: &str) -> Result<()> {
    if body.trim() != "No Error" {
        return Err(Error::Dependency("Harmony输入未返回固定档案的明确成功诊断"));
    }
    Ok(())
}
