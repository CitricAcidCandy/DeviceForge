//! 业务身份、配置区及十进制修订校验，不允许路径替代身份。
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Scope {
    User,
    Workspace,
}

impl Scope {
    pub(crate) fn directory(self) -> &'static str {
        match self {
            Self::User => "users",
            Self::Workspace => "workspaces",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    pub scope: Scope,
    pub owner_id: String,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub sections: Option<BTreeMap<String, Value>>,
    #[serde(skip)]
    pub operation: String,
}

pub(crate) fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

pub(crate) fn revision(value: &str) -> Result<u64, String> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return Err("配置修订须为规范十进制字符串".into());
    }
    value.parse().map_err(|_| "配置修订无效".into())
}

pub(crate) fn parse(operation: &str, value: Value) -> Result<Input, String> {
    if !["list", "get", "set", "delete", "import"].contains(&operation) {
        return Err("未知配置操作".into());
    }
    let mut input: Input = serde_json::from_value(value).map_err(|_| "配置业务输入无效".to_owned())?;
    if !identity(&input.owner_id)
        || input.section.as_deref().is_some_and(|section| !identity(section))
    {
        return Err("配置归属或配置区无效".into());
    }
    if let Some(value) = &input.expected_revision {
        revision(value)?;
    }
    match operation {
        "get" if input.section.is_none() => return Err("读取配置需要配置区".into()),
        "set" if input.section.is_none() || input.value.is_none() => return Err("写入配置需要配置区和内容".into()),
        "delete" if input.section.is_none() => return Err("删除配置需要配置区".into()),
        "import" if input.sections.as_ref().is_none_or(|items| items.is_empty() || items.len() > 64 || items.keys().any(|key| !identity(key))) => return Err("旧配置导入需要有效配置区映射".into()),
        _ => {}
    }
    if ["set", "delete", "import"].contains(&operation) && input.expected_revision.is_none() {
        return Err("配置修改必须携带预期修订".into());
    }
    input.operation = operation.into();
    Ok(input)
}
