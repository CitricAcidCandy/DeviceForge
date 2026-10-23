use crate::{Error, Result};
use apk_plugin_sdk::session::SessionOpen;
use deviceforge_tool_process::PtySize;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Open {
    pub profile: String,
    #[serde(default)]
    pub terminal: Option<Terminal>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Terminal {
    protocol: String,
    cols: u16,
    rows: u16,
}

impl Terminal {
    pub(crate) fn size(&self) -> Result<PtySize> {
        if self.protocol != "deviceforge.terminal.v1" {
            return Err(Error::Invalid("终端协议须为deviceforge.terminal.v1"));
        }
        PtySize::new(self.cols, self.rows)
            .map_err(|_| Error::Invalid("终端列数须为20至500，行数须为5至200"))
    }
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

pub(crate) fn parse(request: &SessionOpen) -> Result<Open> {
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
    if request
        .input
        .get("terminal")
        .is_some_and(serde_json::Value::is_null)
    {
        return Err(Error::Invalid("terminal须为对象，不能为null"));
    }
    let input: Open = serde_json::from_value(request.input.clone())
        .map_err(|_| Error::Invalid("终端打开只允许profile字符串和可选terminal对象"))?;
    if !name(&input.profile) {
        return Err(Error::Invalid("终端profile须为1至64字节的小写标识"));
    }
    if let Some(terminal) = &input.terminal {
        terminal.size()?;
    }
    Ok(input)
}
