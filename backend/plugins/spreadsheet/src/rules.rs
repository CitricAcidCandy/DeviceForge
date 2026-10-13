use crate::{Error, Result, models::{Format, Input, Inspect, Metadata, Operation, Page, Read, Sheet}};
use apk_plugin_sdk::Request;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

pub(crate) const FILE_LIMIT: usize = 16 * 1024 * 1024;
pub(crate) const CELL_LIMIT: usize = 32768;
pub(crate) const NAME_LIMIT: usize = 512;
pub(crate) const ROW_LIMIT: usize = 10000;
pub(crate) const COLUMN_LIMIT: usize = 256;
pub(crate) const DENSE_LIMIT: usize = 2560256;
pub(crate) const RESULT_LIMIT: usize = 1024 * 1024;

pub(crate) fn parse(request: &Request) -> Result<Input> {
    if request.protocol_version != apk_plugin_sdk::CONTEXT_PROTOCOL_VERSION {
        return Err(Error::Invalid("表格插件要求公开协议4"));
    }
    let (id, operation) = match request.operation.as_str() {
        "inspect" => {
            let options: Inspect = serde_json::from_value(request.input.clone())
                .map_err(|_| Error::Invalid("inspect只接受必填artifact_id"))?;
            (options.artifact_id, Operation::Inspect)
        }
        "read" => {
            let options: Read = serde_json::from_value(request.input.clone())
                .map_err(|_| Error::Invalid("read参数无效或包含未知字段"))?;
            if options.offset > ROW_LIMIT || !(1..=500).contains(&options.limit)
                || matches!(&options.sheet, Some(Sheet::Name(name)) if name.is_empty() || name.len() > NAME_LIMIT) {
                return Err(Error::Invalid("工作表、offset或limit超过允许范围"));
            }
            (options.artifact_id.clone(), Operation::Read(options))
        }
        _ => return Err(Error::Invalid("未知表格贡献")),
    };
    if id.len() != 36 || uuid::Uuid::parse_str(&id).is_err() {
        return Err(Error::Invalid("artifact_id须为规范UUID"));
    }
    let context = request.artifacts.as_ref().ok_or(Error::Invalid("缺少宿主产物上下文"))?;
    if context.inputs.len() != 1 || context.output_directory.is_some() {
        return Err(Error::Invalid("表格要求单一输入且不接受输出目录"));
    }
    let artifact = &context.inputs[0];
    if artifact.field != "artifact_id" || artifact.artifact_id != id {
        return Err(Error::Invalid("宿主产物关联不一致"));
    }
    if artifact.size > FILE_LIMIT as u64 {
        return Err(Error::Limit);
    }
    if artifact.filename.is_empty() || artifact.filename.len() > NAME_LIMIT
        || artifact.filename.contains(['/', '\u{005c}', ':'])
        || artifact.filename.chars().any(char::is_control)
        || artifact.sha256.len() != 64 || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Invalid("输入文件名或SHA256无效"));
    }
    let extension = artifact.filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let format = match extension.as_str() {
        "xlsx" => Format::Xlsx,
        "xls" => Format::Xls,
        "csv" => Format::Csv,
        _ => return Err(Error::Invalid("仅支持xlsx、xls和csv")),
    };
    Ok(Input { artifact: artifact.clone(), format, operation })
}

pub(crate) fn sheet_index(names: &[String], selected: Option<&Sheet>) -> Result<usize> {
    match selected {
        None if !names.is_empty() => Ok(0),
        Some(Sheet::Index(index)) if *index < names.len() => Ok(*index),
        Some(Sheet::Name(name)) => names.iter().position(|x| x == name)
            .ok_or(Error::Invalid("指定工作表不存在")),
        _ => Err(Error::Invalid("指定工作表不存在")),
    }
}
pub(crate) fn names(names: &[String]) -> Result<()> {
    let mut seen = BTreeSet::new();
    if names.is_empty() || names.len() > 64 { return Err(Error::Limit); }
    for name in names {
        if name.is_empty() || name.len() > NAME_LIMIT || name.chars().any(char::is_control)
            || !seen.insert(name) { return Err(Error::Invalid("工作表名称无效或重复")); }
    }
    Ok(())
}
pub(crate) fn text(value: &str) -> Result<String> {
    if value.len() > CELL_LIMIT || value.contains('\0') { return Err(Error::Limit); }
    Ok(value.trim().to_owned())
}
fn empty(value: &Value) -> bool {
    matches!(value, Value::Null) || matches!(value, Value::String(text) if text.trim().is_empty())
}
fn header(value: &Value, column: usize) -> Result<String> {
    let name = match value {
        Value::Null => String::new(),
        Value::String(text) => text.trim().to_owned(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return Err(Error::Format),
    };
    if name.len() > NAME_LIMIT { return Err(Error::Limit); }
    Ok(if name.is_empty() { format!("列{}", column + 1) } else { name })
}
pub(crate) fn headers(row: &[Value]) -> Result<Vec<String>> {
    if row.len() > COLUMN_LIMIT { return Err(Error::Limit); }
    let originals = row.iter().enumerate().map(|(index, cell)| header(cell, index))
        .collect::<Result<Vec<_>>>()?;
    let reserved: BTreeSet<_> = originals.iter().cloned().collect();
    let mut used = BTreeSet::new();
    let mut result = Vec::with_capacity(originals.len());
    for original in originals {
        let mut name = original.clone();
        let mut suffix = 2;
        while used.contains(&name) {
            name = format!("{original}__{suffix}");
            suffix += 1;
            if reserved.contains(&name) { continue; }
        }
        if used.contains(&original) {
            while reserved.contains(&name) || used.contains(&name) {
                name = format!("{original}__{suffix}");
                suffix += 1;
            }
        }
        if name.len() > NAME_LIMIT { return Err(Error::Limit); }
        used.insert(name.clone());
        result.push(name);
    }
    Ok(result)
}

pub(crate) fn page(metadata: Metadata, sheet_name: String, rows: Vec<Vec<Value>>, options: Read,
    check: impl Fn() -> Result<()>) -> Result<Page> {
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width > COLUMN_LIMIT { return Err(Error::Limit); }
    let mut rows = rows.into_iter();
    let mut selected = None;
    for mut row in rows.by_ref() {
        check()?;
        if row.iter().all(empty) { continue; }
        row.resize(width, Value::Null);
        selected = Some(headers(&row)?);
        break;
    }
    let headers = selected.unwrap_or_default();
    let mut output = Vec::new();
    let mut total_rows = 0;
    // 逐字段计入编码上限，避免先构造庞大分页再发现超限。
    let mut encoded = serde_json::to_vec(&metadata).map_err(|_| Error::Format)?.len()
        + serde_json::to_vec(&headers).map_err(|_| Error::Format)?.len() + sheet_name.len() + 256;
    for row in rows {
        check()?;
        if row.iter().all(empty) { continue; }
        if total_rows >= ROW_LIMIT { return Err(Error::Limit); }
        if total_rows >= options.offset && output.len() < options.limit {
            let mut record = Map::new();
            for (index, name) in headers.iter().enumerate() {
                let cell = row.get(index).cloned().unwrap_or(Value::Null);
                encoded += serde_json::to_vec(&cell).map_err(|_| Error::Format)?.len()
                    + serde_json::to_vec(name).map_err(|_| Error::Format)?.len() + 2;
                if encoded >= RESULT_LIMIT { return Err(Error::Limit); }
                record.insert(name.clone(), cell);
            }
            encoded += 3;
            output.push(record);
        }
        total_rows += 1;
    }
    Ok(Page { metadata, sheet_name, headers, rows: output, total_rows,
        offset: options.offset, limit: options.limit })
}
