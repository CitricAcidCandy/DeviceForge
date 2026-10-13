use crate::{Error, Result};
use apk_plugin_sdk::session::SessionOpen;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    profile: String,
}

pub(crate) fn name(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 64
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

pub(crate) fn parse(request: &SessionOpen) -> Result<String> {
    request
        .validate()
        .map_err(|_| Error::Invalid("公开会话封套无效"))?;
    if request.operation != "open" {
        return Err(Error::Invalid("终端插件只接受open会话贡献"));
    }
    if request
        .artifacts
        .as_ref()
        .is_some_and(|context| !context.inputs.is_empty() || context.output_directory.is_some())
    {
        return Err(Error::Invalid("终端会话不接受输入或输出产物"));
    }
    if !request.input.is_object() {
        return Err(Error::Invalid("终端打开参数须为对象"));
    }
    let input: Open = serde_json::from_value(request.input.clone())
        .map_err(|_| Error::Invalid("终端打开只允许必填profile字符串"))?;
    if !name(&input.profile) {
        return Err(Error::Invalid("终端profile须为1至64字节的小写标识"));
    }
    Ok(input.profile)
}
