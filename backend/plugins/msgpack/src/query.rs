use serde::Deserialize;
use serde_json::{Number, Value, json};
use std::cmp::Ordering;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Equals,
    Contains,
    Greater,
    Less,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    field: String,
    operator: Operator,
    value: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Options {
    pub artifact_id: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "limit")]
    limit: usize,
    filter: Option<Filter>,
}
fn limit() -> usize {
    50
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if self.offset > 100_000 || !(1..=100).contains(&self.limit) {
            return Err("查询偏移最多 100000，分页大小为 1–100".into());
        }
        if let Some(filter) = &self.filter {
            if filter.field.is_empty()
                || filter.field.len() > 100
                || filter.field.chars().any(char::is_control)
            {
                return Err("筛选字段必须为 1–100 字节的单层字段名".into());
            }
            match filter.operator {
                Operator::Contains if !filter.value.is_string() => {
                    return Err("contains 只接受字符串".into());
                }
                Operator::Greater | Operator::Less if !filter.value.is_number() => {
                    return Err("数值比较只接受数字".into());
                }
                _ => (),
            }
        }
        Ok(())
    }
}
fn integer(value: &Number) -> Option<i128> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
}
fn compare(left: &Number, right: &Number) -> Result<Ordering, String> {
    if let (Some(left), Some(right)) = (integer(left), integer(right)) {
        return Ok(left.cmp(&right));
    }
    // 混合浮点比较不允许把大整数先舍入，再给出错误筛选结果。
    for number in [left, right] {
        if integer(number).is_some_and(|value| value.abs() > (1i128 << 53)) {
            return Err("大整数与浮点数混合比较无法保证精度".into());
        }
    }
    left.as_f64()
        .and_then(|left| right.as_f64().and_then(|right| left.partial_cmp(&right)))
        .ok_or_else(|| "数值无法比较".into())
}
fn matches(record: &Value, filter: &Filter) -> Result<bool, String> {
    let Some(value) = record
        .as_object()
        .and_then(|object| object.get(&filter.field))
    else {
        return Ok(false);
    };
    Ok(match filter.operator {
        Operator::Equals => {
            if let (Some(left), Some(right)) = (value.as_number(), filter.value.as_number()) {
                compare(left, right)? == Ordering::Equal
            } else {
                value == &filter.value
            }
        }
        Operator::Contains => value
            .as_str()
            .is_some_and(|value| value.contains(filter.value.as_str().expect("已验证字符串"))),
        Operator::Greater | Operator::Less => {
            let Some(left) = value.as_number() else {
                return Ok(false);
            };
            let order = compare(left, filter.value.as_number().expect("已验证数字"))?;
            match filter.operator {
                Operator::Greater => order == Ordering::Greater,
                _ => order == Ordering::Less,
            }
        }
    })
}
pub fn execute(value: Value, options: Options) -> Result<Value, String> {
    let Value::Array(records) = value else {
        return Err("分页查询要求根值为记录数组".into());
    };
    let total = records.len();
    let mut matched = 0;
    let mut page = Vec::new();
    for record in records {
        if let Some(filter) = &options.filter
            && !matches(&record, filter)?
        {
            continue;
        }
        if matched >= options.offset && page.len() < options.limit {
            page.push(record);
        }
        matched += 1;
    }
    if options.offset > matched {
        return Err("查询偏移超过匹配结果数量".into());
    }
    let next = options.offset + page.len();
    let result = json!({"format_version":1,"source_artifact_id":options.artifact_id,"total":total,"matched":matched,"offset":options.offset,"records":page,"next_offset":(next < matched).then_some(next)});
    if serde_json::to_vec(&result)
        .map_err(|_| "查询结果序列化失败")?
        .len()
        > 128 * 1024
    {
        return Err("查询结果超过 128 KiB，请减小分页或使用文件转换".into());
    }
    Ok(result)
}
#[cfg(test)]
mod tests;
