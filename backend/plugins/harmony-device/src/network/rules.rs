use crate::{Error, Result, rules as common_rules};
use std::net::Ipv4Addr;

pub(super) fn address(value: &str) -> Result<()> {
    if value.len() > 21 || !value.is_ascii() {
        return Err(Error::Invalid(
            "连接地址须为最多21字节的IPv4或localhost及端口",
        ));
    }
    let Some((host, port)) = value.split_once(':') else {
        return Err(Error::Invalid("连接地址必须显式包含主机和端口"));
    };
    if host != "localhost" && host.parse::<Ipv4Addr>().is_err() {
        return Err(Error::Invalid("连接主机须为规范IPv4或字面localhost"));
    }
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || !port.parse::<u16>().is_ok_and(|port| port > 0)
    {
        return Err(Error::Invalid("连接端口须为1至65535的ASCII十进制数字"));
    }
    Ok(())
}

pub(super) fn connect(stdout: &[u8], stderr: &[u8]) -> Result<String> {
    let output = common_rules::text(stdout, stderr)?;
    if !output.lines().any(|line| {
        matches!(
            line.trim(),
            "Connect OK" | "[Info]Target is connected, repeat operation"
        )
    }) {
        return Err(Error::Dependency("HDC未返回明确连接成功结果"));
    }
    Ok(output)
}

pub(super) fn disconnect(stdout: &[u8], stderr: &[u8]) -> Result<String> {
    let output = common_rules::text(stdout, stderr)?;
    if !output.is_empty() {
        return Err(Error::Dependency("HDC断开返回不支持的非静默响应"));
    }
    Ok(output)
}
