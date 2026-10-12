//! 普通请求只能选择业务 ID，不能覆盖部署路径、源或程序。
use crate::error::{Error, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

pub(crate) enum Input {
    Catalog,
    Plan(Vec<String>),
    Install(String),
    Remove(String),
    FeatureStatus(String),
    FeaturePrepare(String),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    #[serde(default)]
    module_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Module {
    module_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Feature {
    feature_key: String,
}

pub(crate) fn valid_id(id: &str) -> bool {
    if matches!(id, "con" | "prn" | "aux" | "nul")
        || (id.len() == 4
            && (id.starts_with("com") || id.starts_with("lpt"))
            && matches!(id.as_bytes()[3], b'1'..=b'9'))
    {
        return false;
    }
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_lowercase()
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}
pub(crate) fn parse(operation: &str, value: Value) -> Result<Input> {
    let invalid = || Error::Invalid("操作输入结构错误");
    match operation {
        "catalog" => {
            serde_json::from_value::<Empty>(value).map_err(|_| invalid())?;
            Ok(Input::Catalog)
        }
        "plan" => {
            let input: Selection = serde_json::from_value(value).map_err(|_| invalid())?;
            let mut unique = HashSet::new();
            if input.module_ids.len() > 128
                || input
                    .module_ids
                    .iter()
                    .any(|id| !valid_id(id) || !unique.insert(id))
            {
                return Err(Error::Invalid("模块 ID 无效、重复或超过 128 项"));
            }
            Ok(Input::Plan(input.module_ids))
        }
        "install" | "remove" => {
            let input: Module = serde_json::from_value(value).map_err(|_| invalid())?;
            if !valid_id(&input.module_id) {
                return Err(Error::Invalid("模块 ID 无效"));
            }
            Ok(if operation == "install" {
                Input::Install(input.module_id)
            } else {
                Input::Remove(input.module_id)
            })
        }
        "runtime_feature.status" | "runtime_feature.prepare" => {
            let input: Feature = serde_json::from_value(value).map_err(|_| invalid())?;
            if input.feature_key.is_empty() || input.feature_key.len() > 128 {
                return Err(Error::Invalid("功能标识必须为 1 至 128 字节"));
            }
            Ok(if operation == "runtime_feature.status" {
                Input::FeatureStatus(input.feature_key)
            } else {
                Input::FeaturePrepare(input.feature_key)
            })
        }
        _ => Err(Error::Invalid("未知工具供应操作")),
    }
}
