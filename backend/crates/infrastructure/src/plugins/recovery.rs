//! 显式协议4恢复调用；普通执行准入不接受此特殊操作。
use super::ProcessPlugin;
use apk_domain::{Error, ExecutionContext, Result, plugin_recovery::RecoveryReport};
use apk_plugin_sdk::{Manifest, Request, recovery::RecoveryStatus};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) fn validate(manifest: &Manifest) -> Result<()> {
    if let Some(access) = &manifest.recovery
        && (manifest.protocol_version != 4
            || access.api_version != 1
            || !(1000..=30000).contains(&access.timeout_ms)
            || !super::valid_name(&access.operation)
            || manifest
                .operations
                .iter()
                .any(|value| value.name == access.operation))
    {
        return Err(Error::Invalid(
            "资源恢复声明须采用协议4、版本1、独立操作与有界预算".into(),
        ));
    }
    Ok(())
}

pub(super) async fn run(
    plugin: &ProcessPlugin,
    input: serde_json::Value,
    cancel: CancellationToken,
    context: ExecutionContext,
) -> Result<RecoveryReport> {
    let access = plugin
        .manifest
        .recovery
        .as_ref()
        .ok_or_else(|| Error::Conflict("插件未声明资源恢复能力".into()))?;
    // 新活动调用不阻止独立插件逐旧资源核对；旧报告只能确认此刻已有的历史债务。
    let recovery = crate::plugin_resources::ToolLease::recovery_snapshot(&plugin.unresolved);
    let deadline = context
        .deadline
        .ok_or_else(|| Error::Invalid("资源恢复缺少固定截止点".into()))?;
    let until = Some(tokio::time::Instant::from_std(deadline));
    crate::execution_deadline::check(&cancel, until)?;
    let configuration = if let Some(store) = &plugin.configurations {
        crate::execution_deadline::run(&cancel, until, store.invocation_path(&plugin.manifest.id))
            .await?
    } else {
        None
    };
    let resources = if let Some(store) = &plugin.configurations {
        crate::execution_deadline::run(&cancel, until, store.resources_path(&plugin.manifest.id))
            .await?
    } else {
        None
    };
    let id = uuid::Uuid::new_v4().to_string();
    let request = Request {
        protocol_version: 4,
        request_id: id.clone(),
        operation: access.operation.clone(),
        input,
        artifacts: None,
    };
    let mut input =
        serde_json::to_vec(&request).map_err(|_| Error::Invalid("恢复请求无法编码".into()))?;
    input.push(b'\n');
    if input.len() > 16 * 1024 {
        return Err(Error::TooLarge);
    }
    let response = crate::process::cooperative::run_with_context(
        crate::process::cooperative::Invocation {
            executable: &plugin.manifest.executable,
            args: &plugin.manifest.args,
            input,
            request_id: &id,
            cancel: cancel.clone(),
            directory: None,
            timeout: Duration::from_millis(access.timeout_ms),
            deadline: Some(deadline),
            configuration: configuration.as_deref(),
            resources: resources.as_deref(),
        },
        plugin.unresolved.clone(),
    )
    .await?;
    crate::execution_deadline::check(&cancel, until)?;
    if !response.outputs.is_empty() {
        return Err(Error::Dependency("恢复调用不得发布产物".into()));
    }
    let value = response
        .result
        .ok_or_else(|| Error::Dependency("插件资源核对未完成".into()))?;
    let report: apk_plugin_sdk::recovery::RecoveryReport = serde_json::from_value(value.clone())
        .map_err(|_| Error::Dependency("插件资源核对报告无效".into()))?;
    if !report.validate() {
        return Err(Error::Dependency("插件资源核对报告越界或相互矛盾".into()));
    }
    let result = serde_json::from_value(value)
        .map_err(|_| Error::Dependency("资源核对报告映射失败".into()))?;
    if report.status == RecoveryStatus::Recovered {
        if let Err(error) = crate::plugin_resources::confirm_recovery(&recovery) {
            return match error {
                Error::Conflict(message) => Ok(RecoveryReport::busy(message)),
                error => Err(error),
            };
        }
        tracing::info!(
            local_idle = crate::plugin_resources::recovery_ready(&plugin.unresolved),
            "旧资源核对已确认，新调用租约与晚到债务保持独立"
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    fn manifest() -> Manifest {
        serde_json::from_value(
            json!({"id":"recovery-test","version":"1","protocol_version":4,
            "executable":std::env::current_exe().unwrap(),
            "operations":[{"name":"status","title":"状态","input_schema":{"type":"object"}}],
            "recovery":{"api_version":1,"operation":"runtime.recover","timeout_ms":30000}}),
        )
        .unwrap()
    }

    #[test]
    fn recovery_is_explicit_bounded_and_not_a_normal_business_contribution() {
        let original = manifest();
        assert!(validate(&original).is_ok());
        let mut value = original.clone();
        value.protocol_version = 3;
        assert!(validate(&value).is_err());
        let mut value = original.clone();
        value.recovery.as_mut().unwrap().timeout_ms = 30001;
        assert!(validate(&value).is_err());
        let mut value = original.clone();
        value.recovery.as_mut().unwrap().operation = "status".into();
        assert!(validate(&value).is_err());
        let mut value = original.clone();
        value.recovery.as_mut().unwrap().api_version = 2;
        assert!(validate(&value).is_err());
        let mut value = original;
        value.recovery = None;
        assert!(validate(&value).is_ok());
    }

    #[tokio::test]
    async fn recovery_process_runs_with_new_active_lease_and_keeps_unreaped_debt_busy() {
        let directory = tempfile::tempdir().unwrap();
        let mut definition = manifest();
        // 清单要求真实绝对入口，不能把 PATH 命令名当作可执行文件路径。
        let node = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("恢复夹具需要可用的 Node.js");
        assert!(node.status.success(), "查询 Node.js 绝对入口失败");
        definition.executable = String::from_utf8(node.stdout)
            .expect("Node.js 入口必须是 UTF-8")
            .trim()
            .into();
        definition.args = vec![
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/cleanup_isolation.mjs")
                .to_str()
                .unwrap()
                .into(),
            directory.path().to_str().unwrap().into(),
        ];
        let plugin = ProcessPlugin::new(definition).unwrap();
        plugin.unresolved.store(true, Ordering::Release);
        let active = crate::plugin_resources::acquire(
            None,
            &CancellationToken::new(),
            tokio::time::Instant::now() + Duration::from_secs(5),
            &plugin.unresolved,
        )
        .await
        .unwrap();
        for (name, pending) in [("active", false), ("pending", true)] {
            if pending {
                active.retain();
            }
            let report = run(
                &plugin,
                json!({"name":name}),
                CancellationToken::new(),
                ExecutionContext {
                    deadline: Some(std::time::Instant::now() + Duration::from_secs(10)),
                },
            )
            .await
            .unwrap();
            assert_eq!(
                report.status,
                if pending {
                    apk_domain::plugin_recovery::RecoveryStatus::Busy
                } else {
                    apk_domain::plugin_recovery::RecoveryStatus::Recovered
                }
            );
            assert!(
                directory.path().join(format!("{name}.json")).exists(),
                "活动调用不能阻止实际核对运行"
            );
            assert!(!crate::plugin_resources::recovery_ready(&plugin.unresolved));
            assert!(plugin.unresolved.load(Ordering::Acquire));
        }
        active.process_exited();
        drop(active);
        crate::plugin_resources::confirm_recovery(
            &crate::plugin_resources::ToolLease::recovery_snapshot(&plugin.unresolved),
        )
        .unwrap();
        assert!(!plugin.unresolved.load(Ordering::Acquire));
    }
}
