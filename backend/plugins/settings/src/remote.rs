//! 兼容旧配置服务的读取、保存及本地备份回退；远端不支持修订事务。
use crate::{
    config::{Config, Remote},
    model::Input,
    store,
};
use deviceforge_plugin_runtime::InvocationContext;
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::path::PathBuf;

const KEYS: &[&str] = &[
    "deviceInfo",
    "distrosInfo",
    "iframePageUrl",
    "luaCommand",
    "packageInfo",
    "permissions",
    "distroPaySystemsInfo",
    "feishuUser",
    "dynamicSnalysisHooks",
    "packageSDK",
    "chillyRoomProjectGroups",
    "apkToolUpdateConfig",
];

async fn local(
    root: PathBuf,
    input: Input,
    context: InvocationContext,
    lease: Option<store::Lease>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || match lease {
        Some(lease) => lease.execute(input, &|| {
            context.check().map_err(|error| error.to_string())
        }),
        None => store::execute(&root, input, &context),
    })
    .await
    .map_err(|_| "配置备份工作异常".to_owned())?
}

async fn reserve(
    root: PathBuf,
    mut input: Input,
    context: InvocationContext,
) -> Result<store::Lease, String> {
    tokio::task::spawn_blocking(move || {
        let check = || context.check().map_err(|error| error.to_string());
        let lease = store::Lease::acquire(&root, &input, &check)?;
        let expected = input.expected_revision.clone();
        input.operation = "list".into();
        let current = lease.execute(input, &check)?;
        if current["revision"].as_str() != expected.as_deref() {
            return Err("配置修订冲突，未向远端写入".into());
        }
        if expected
            .as_deref()
            .map(crate::model::revision)
            .transpose()?
            == Some(u64::MAX)
        {
            return Err("配置修订已耗尽，未向远端写入".into());
        }
        Ok(lease)
    })
    .await
    .map_err(|_| "配置预检工作异常".to_owned())?
}

pub(crate) async fn execute(
    config: Config,
    mut input: Input,
    context: &InvocationContext,
) -> Result<Value, String> {
    let section = input
        .section
        .as_deref()
        .ok_or("远端配置缺少配置区")?
        .to_owned();
    if !KEYS.contains(&section.as_str()) {
        return Err("远端配置区不在旧服务公开清单中".into());
    }
    let remote = config.remote.ok_or("未配置旧配置服务")?;
    let save = input.operation == "remote.save";
    let lease = if save {
        Some(reserve(config.storage_root.clone(), input.clone(), context.clone()).await?)
    } else {
        None
    };
    context.check().map_err(|error| error.to_string())?;
    let cancel = context.cancellation();
    let request = fetch(
        &remote,
        &section,
        save.then_some(input.value.as_ref().unwrap_or(&Value::Null)),
    );
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("远端配置请求已取消".into()),
        _ = tokio::time::sleep_until(context.deadline().into()) => return Err("远端配置请求总期限已到期".into()),
        result = request => result,
    };
    context.check().map_err(|error| error.to_string())?;
    let value = match result {
        Ok(value) => {
            if save {
                input.value.clone().unwrap_or(Value::Null)
            } else {
                value
            }
        }
        Err(_) if !save => {
            input.operation = "get".into();
            let mut cached = local(config.storage_root, input, context.clone(), None)
                .await
                .map_err(|_| "远端配置不可用且无有效本地备份")?;
            cached["source"] = json!("local");
            cached["backup_updated"] = json!(false);
            cached["remote_committed"] = json!(false);
            return Ok(cached);
        }
        Err(error) => return Err(error),
    };
    if save && !input.write_local_backup {
        // 预检取得的锁保留到完整响应确认；跳过备份不改变本地修订或内容。
        return Ok(
            json!({"format_version":1,"section":section,"value":value,"source":"remote","backup_updated":false,"revision":null,"remote_committed":true}),
        );
    }
    input.operation = "set".into();
    input.value = Some(value.clone());
    input.value_present = true;
    let committed = local(config.storage_root, input, context.clone(), lease).await;
    context.check().map_err(|error| error.to_string())?;
    // 远端成功不能被本地CAS冲突伪装为远端失败，也不覆盖并发本地修改。
    match committed {
        Ok(backup) => Ok(
            json!({"format_version":1,"section":section,"value":value,"source":"remote","backup_updated":true,"revision":backup["revision"],"remote_committed":save}),
        ),
        Err(_) => Ok(
            json!({"format_version":1,"section":section,"value":value,"source":"remote","backup_updated":false,"revision":null,"remote_committed":save}),
        ),
    }
}

async fn fetch(remote: &Remote, section: &str, value: Option<&Value>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建配置请求")?;
    let base = reqwest::Url::parse(&remote.base_url).map_err(|_| "远端配置地址无效")?;
    let url = base
        .join(&format!(
            "{}/{section}",
            if value.is_some() {
                "update_config"
            } else {
                "get_config"
            }
        ))
        .map_err(|_| "远端配置地址无效")?;
    let mut request = if let Some(value) = value {
        client.post(url).json(value)
    } else {
        client.get(url)
    };
    for (name, value) in &remote.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "远端配置请求头名无效")?;
        let value =
            reqwest::header::HeaderValue::from_str(value).map_err(|_| "远端配置请求头值无效")?;
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|_| "远端配置请求失败")?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > 1024 * 1024)
    {
        return Err("远端配置状态或大小无效".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.try_next().await.map_err(|_| "远端配置响应中断")? {
        if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
            return Err("远端配置响应超限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    decode(&bytes, value.is_some())
}

fn decode(bytes: &[u8], saving: bool) -> Result<Value, String> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| "远端配置响应格式无效")?;
    let candidate = if raw.get("success").is_none()
        && raw
            .get("data")
            .and_then(|data| data.get("success"))
            .is_some()
    {
        &raw["data"]
    } else {
        &raw
    };
    let status = raw.get("status").or_else(|| candidate.get("status"));
    if candidate.get("success") != Some(&Value::Bool(true))
        || status.is_some_and(|status| status != 200 && status != "200")
    {
        return Err("远端配置业务返回失败".into());
    }
    if !saving && candidate.get("data").is_none() {
        return Err("远端配置响应缺少内容".into());
    }
    Ok(candidate.get("data").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod integration_tests;

#[cfg(test)]
#[path = "remote_backup_tests.rs"]
mod backup_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_envelopes_preserve_explicit_null_and_reject_false_success() {
        assert_eq!(
            decode(
                br#"{"status":200,"data":{"success":true,"data":null}}"#,
                false
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            decode(br#"{"success":true,"data":{"items":[]}}"#, false).unwrap(),
            json!({"items":[]})
        );
        assert!(decode(br#"{"success":false,"data":{}}"#, false).is_err());
        assert!(decode(br#"{"status":500,"success":true,"data":{}}"#, false).is_err());
        assert!(decode(br#"{"success":true}"#, false).is_err());
        assert!(decode(br#"{"success":true}"#, true).is_ok());
        assert_eq!(
            decode(
                br#"{"success":true,"data":{"success":true,"data":"payload"}}"#,
                false
            )
            .unwrap(),
            json!({"success":true,"data":"payload"})
        );
    }
}
