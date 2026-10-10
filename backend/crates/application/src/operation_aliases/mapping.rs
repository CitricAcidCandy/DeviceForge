//! 旧输入封套和结果投影，只处理传入值，不读取存储或推断平台。
use super::{FieldSource, InputMapping, ResultMapping, rules};
use apk_domain::{Error, Result, artifacts::Artifact, devices::CapabilityScope};
use serde::Deserialize;
use serde_json::{Map, Value, json};

pub fn map_input(
    mapping: &InputMapping,
    input: &Value,
    scope: Option<&CapabilityScope>,
) -> Result<Value> {
    if matches!(mapping, InputMapping::Identity) {
        return Ok(input.clone());
    }
    let mut business = input
        .as_object()
        .cloned()
        .ok_or_else(|| Error::Invalid("设备封套转换要求对象输入".into()))?;
    let device_id = business.remove("device_id");
    let device_id = match scope {
        Some(CapabilityScope::Device) => {
            let Some(Value::String(id)) = device_id else {
                return Err(Error::Invalid("设备范围要求字符串 device_id".into()));
            };
            apk_domain::devices::rules::local_id(&id)?;
            Value::String(id)
        }
        Some(CapabilityScope::Provider) => {
            if device_id.is_some_and(|value| !value.is_null()) {
                return Err(Error::Invalid("提供者范围不接受非空 device_id".into()));
            }
            Value::Null
        }
        None => return Err(Error::Invalid("设备封套转换缺少目标能力范围".into())),
    };
    Ok(json!({"device_id":device_id,"input":business}))
}

pub fn map_result(mapping: &ResultMapping, input: &Value, output: Value) -> Result<Value> {
    rules::result(mapping).map_err(|_| failed("结果投影规则无效"))?;
    match mapping {
        ResultMapping::Identity {} | ResultMapping::Value { wrapped: false } => return Ok(output),
        _ => {}
    }
    let wrapped = matches!(
        mapping,
        ResultMapping::Value { wrapped: true } | ResultMapping::Object { wrapped: true, .. }
    );
    let needs_artifacts = match mapping {
        ResultMapping::Artifact { .. } => true,
        ResultMapping::Object { fields, .. } => fields
            .iter()
            .any(|field| matches!(field.source, FieldSource::Artifact { .. })),
        _ => false,
    };
    // 只有明确要求包装或产物的规则才读取宿主包装，不猜测业务 result 字段。
    let host = if wrapped || needs_artifacts {
        Some(
            serde_json::from_value::<HostResult>(output.clone())
                .map_err(|_| failed("宿主产物结果包装无效"))?,
        )
    } else {
        None
    };
    let value = if wrapped {
        &host
            .as_ref()
            .ok_or_else(|| failed("缺少宿主结果包装"))?
            .result
    } else {
        &output
    };
    match mapping {
        ResultMapping::DeviceDiscovery { .. } => Err(failed("发现投影必须经过同次完整观测验证")),
        ResultMapping::Identity {} | ResultMapping::Value { .. } => Ok(value.clone()),
        ResultMapping::Artifact { filename } => {
            select_artifact(host.as_ref(), filename)?.ok_or_else(|| failed("结果中缺少指定产物"))
        }
        ResultMapping::Object { fields, .. } => {
            let mut projected = Map::new();
            for field in fields {
                let selected = match &field.source {
                    FieldSource::Input { pointer } => select_pointer(input, pointer)?.cloned(),
                    FieldSource::Value { pointer } => select_pointer(value, pointer)?.cloned(),
                    FieldSource::Artifact { filename } => select_artifact(host.as_ref(), filename)?,
                };
                match selected {
                    Some(selected) => {
                        projected.insert(field.name.clone(), selected);
                    }
                    None if field.optional => {}
                    None => return Err(failed("结果投影缺少必填源")),
                }
            }
            Ok(Value::Object(projected))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostResult {
    result: Value,
    artifacts: Vec<Artifact>,
}

fn select_artifact(host: Option<&HostResult>, filename: &str) -> Result<Option<Value>> {
    let host = host.ok_or_else(|| failed("产物投影缺少宿主包装"))?;
    let mut matches = host
        .artifacts
        .iter()
        .filter(|artifact| artifact.filename == filename);
    let selected = matches.next();
    if matches.next().is_some() {
        return Err(failed("结果中的指定产物名称重复"));
    }
    // 仅序列化领域 Artifact 的元数据，不信任业务 result 自填的 ID 或路径。
    selected
        .map(|artifact| serde_json::to_value(artifact).map_err(|_| failed("宿主产物元数据无效")))
        .transpose()
}

fn select_pointer<'a>(value: &'a Value, pointer: &str) -> Result<Option<&'a Value>> {
    rules::pointer(pointer).map_err(|_| failed("结果投影 JSON Pointer 无效"))?;
    if pointer.is_empty() {
        return Ok(Some(value));
    }
    let mut current = value;
    for encoded in pointer[1..].split('/') {
        let key = encoded.replace("~1", "/").replace("~0", "~");
        let next = match current {
            Value::Object(fields) => fields.get(&key),
            Value::Array(items) => {
                if key.is_empty()
                    || !key.bytes().all(|byte| byte.is_ascii_digit())
                    || (key.len() > 1 && key.starts_with('0'))
                {
                    return Err(failed("结果投影数组索引格式无效"));
                }
                key.parse::<usize>().ok().and_then(|index| items.get(index))
            }
            _ => return Err(failed("结果投影路径穿过非容器值")),
        };
        let Some(next) = next else {
            return Ok(None);
        };
        current = next;
    }
    Ok(Some(current))
}

fn failed(message: &str) -> Error {
    Error::Dependency(message.into())
}
