//! 设备标识与业务参数的纯资格规则，不读取配置或启动进程。
mod input;
mod output;

use crate::{Error, Result};
pub(crate) use input::Action;
pub(crate) use output::adb_diagnostic_line;
use std::net::{Ipv4Addr, Ipv6Addr};

pub(crate) fn bounded_text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

pub(crate) fn serial(value: &str) -> Result<()> {
    if !bounded_text(value, 200) || value.starts_with('-') {
        return Err(Error::Invalid(
            "设备标识须为不含控制符的有效原文，最多200字节",
        ));
    }
    Ok(())
}

pub(crate) fn package(value: &str) -> Result<()> {
    let valid = value.len() <= 200
        && value.contains('.')
        && value.split('.').all(|part| {
            let mut bytes = part.bytes();
            bytes
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
                && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        });
    if !valid {
        return Err(Error::Invalid("应用包名须为最多200字节的点分ASCII标识"));
    }
    Ok(())
}

pub(crate) fn address(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(Error::Invalid(
            "连接地址须为不含空白的host:port，最多200字节",
        ));
    }
    let valid = if let Some(rest) = value.strip_prefix('[') {
        rest.split_once("]:")
            .is_some_and(|(host, port)| host.parse::<Ipv6Addr>().is_ok() && valid_port(port))
    } else {
        value
            .split_once(':')
            .is_some_and(|(host, port)| valid_host(host) && valid_port(port))
    };
    if !valid {
        return Err(Error::Invalid(
            "连接地址必须包含合法主机和1至65535端口，IPv6须加方括号",
        ));
    }
    Ok(())
}

fn valid_port(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u16>().is_ok_and(|port| port != 0)
}

fn valid_host(value: &str) -> bool {
    if value.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    // 纯数字点分地址不退化为DNS，以免错误IPv4仍被当作合法主机。
    if value.is_empty()
        || value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return false;
    }
    let value = value.strip_suffix('.').unwrap_or(value);
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

#[cfg(test)]
#[path = "rules/tests.rs"]
mod tests;
