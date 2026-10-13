use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Start {
    pub bundle: String,
    pub ability: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bundle {
    pub bundle: String,
}

pub(crate) fn object(value: &Value) -> crate::Result<()> {
    if value.is_object() {
        Ok(())
    } else {
        Err(crate::Error::Invalid("应用动作输入必须为对象"))
    }
}
