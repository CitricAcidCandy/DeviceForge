use crate::{Error, Result, models::Rule};
use apk_plugin_sdk::{ArtifactInput, Request};
use serde::Deserialize;
use std::collections::BTreeSet;

pub(crate) const FILE_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspect {
    artifact_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scan {
    artifact_id: String,
    rules: Vec<Rule>,
}

pub(crate) struct Input {
    pub artifact: ArtifactInput,
    pub rules: Option<Vec<Rule>>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && (value.as_bytes()[0].is_ascii_alphabetic() || b"_$".contains(&value.as_bytes()[0]))
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_$".contains(&byte))
}

pub(crate) fn rules(values: &[Rule]) -> Result<()> {
    let mut names = BTreeSet::new();
    if values.is_empty() || values.len() > 100 {
        return Err(Error::Invalid("SDK规则须为1至100条"));
    }
    for rule in values {
        if rule.name.trim().is_empty()
            || rule.name.len() > 100
            || rule.name.chars().any(char::is_control)
            || !names.insert(&rule.name)
            || rule.package_path.len() > 200
            || !rule.package_path.split('.').all(identifier)
            || rule
                .class_name
                .as_ref()
                .is_some_and(|name| name.len() > 100 || !identifier(name))
        {
            return Err(Error::Invalid("SDK名称、包路径或类名不符合严格规则"));
        }
    }
    Ok(())
}

pub(crate) fn parse(request: &Request) -> Result<Input> {
    if request.protocol_version != apk_plugin_sdk::context::CONTEXT_PROTOCOL_VERSION {
        return Err(Error::Invalid("DEX插件要求公开协议4"));
    }
    let (id, rules) = match request.operation.as_str() {
        "inspect" => {
            let input: Inspect = serde_json::from_value(request.input.clone())
                .map_err(|_| Error::Invalid("inspect只接受必填artifact_id"))?;
            (input.artifact_id, None)
        }
        "scan_sdks" => {
            let input: Scan = serde_json::from_value(request.input.clone())
                .map_err(|_| Error::Invalid("scan_sdks只接受artifact_id和rules"))?;
            self::rules(&input.rules)?;
            (input.artifact_id, Some(input.rules))
        }
        _ => return Err(Error::Invalid("未知DEX贡献")),
    };
    if uuid::Uuid::parse_str(&id).is_err() || id.len() != 36 {
        return Err(Error::Invalid("artifact_id须为规范UUID"));
    }
    let context = request
        .artifacts
        .as_ref()
        .ok_or(Error::Invalid("缺少宿主产物上下文"))?;
    if context.inputs.len() != 1 || context.output_directory.is_some() {
        return Err(Error::Invalid("DEX要求单一输入且不接受输出目录"));
    }
    let artifact = &context.inputs[0];
    if artifact.field != "artifact_id" || artifact.artifact_id != id {
        return Err(Error::Invalid("宿主输入产物关联不一致"));
    }
    if artifact.size < 112 || artifact.size > FILE_LIMIT {
        return Err(Error::TooLarge);
    }
    if artifact.filename.len() > 500
        || !artifact.filename.to_ascii_lowercase().ends_with(".dex")
        || artifact.filename.contains(['/', '\\', ':'])
        || artifact.filename.chars().any(char::is_control)
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(Error::Invalid("输入DEX文件名或摘要无效"));
    }
    Ok(Input {
        artifact: artifact.clone(),
        rules,
    })
}
