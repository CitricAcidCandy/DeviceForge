use crate::{Error, Result};
use serde_json::Value;

pub(crate) fn parse(stdout: &[u8], stderr: &[u8], bundle: &str) -> Result<Value> {
    let stdout =
        std::str::from_utf8(stdout).map_err(|_| Error::Dependency("应用详情输出不是有效UTF-8"))?;
    crate::rules::text(b"", stderr)?;
    let body = if let Some(value) = stdout.strip_prefix(&format!("{bundle}:\r\n")) {
        value
    } else if let Some(value) = stdout.strip_prefix(&format!("{bundle}:\n")) {
        value
    } else {
        stdout
    };
    let value = deviceforge_data_codec::parse_json(body.trim().as_bytes())
        .map_err(|_| Error::Dependency("应用详情JSON无效或超出限额"))?;
    let root = value
        .as_object()
        .ok_or(Error::Dependency("应用详情JSON根节点无效"))?;
    if root
        .get("name")
        .is_some_and(|name| name.as_str() != Some(bundle))
    {
        return Err(Error::Dependency("应用详情包名与请求不一致"));
    }
    Ok(value)
}

pub(crate) fn ability(value: &Value, bundle: &str) -> Result<String> {
    let root = value
        .as_object()
        .ok_or(Error::Dependency("应用详情JSON根节点无效"))?;
    if root
        .get("name")
        .is_some_and(|name| name.as_str() != Some(bundle))
    {
        return Err(Error::Dependency("应用详情包名与请求不一致"));
    }
    let modules = root
        .get("hapModuleInfos")
        .and_then(Value::as_array)
        .ok_or(Error::Dependency("应用详情缺少有效模块列表"))?;
    if modules.len() > 128 {
        return Err(Error::Dependency("应用详情模块数量超过128项"));
    }
    let first = modules
        .first()
        .and_then(Value::as_object)
        .ok_or(Error::Dependency("应用详情首模块无效"))?;
    if first
        .get("bundleName")
        .is_some_and(|name| name.as_str() != Some(bundle))
    {
        return Err(Error::Dependency("应用详情首模块包名与请求不一致"));
    }
    let selected_ability = first
        .get("mainAbility")
        .and_then(Value::as_str)
        .ok_or(Error::Dependency("应用详情首模块缺少mainAbility"))?;
    super::rules::ability(selected_ability)
        .map_err(|_| Error::Dependency("应用详情首模块mainAbility无效"))?;
    Ok(selected_ability.to_owned())
}
