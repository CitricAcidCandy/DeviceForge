//! 重载只调用原插件生命周期服务，等待结束与实际后台排空分别记录。
use super::*;
use apk_application::debugger::DebugSession;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ReloadInput {
    confirmed: bool,
    #[serde(default)]
    follow: bool,
    #[serde(default = "budget")]
    timeout_ms: u64,
}
fn budget() -> u64 {
    30_000
}

pub(super) async fn browser_reload(
    debugger: &DebuggerService,
    session: DebugSession,
    input: Value,
) -> Result<Value, ApiError> {
    let input: ReloadInput = decode(input)?;
    if !input.confirmed {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "debugger_confirmation_required",
            "重载运行实例需要显式确认",
        ));
    }
    if !(100..=30_000).contains(&input.timeout_ms) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "重载等待期限必须为 100 至 30000 毫秒",
        ));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(input.timeout_ms);
    let result = match tokio::time::timeout_at(
        deadline,
        debugger.execute(DebugCommandRequest {
            session_id: session.session_id.clone(),
            tool: DebugTool::Reload,
            parameters: json!({"confirmed":true}),
        }),
    )
    .await
    {
        Ok(result) => result.map_err(error)?,
        Err(_) => {
            return Ok(
                json!({"state":"timed_out_unconfirmed","followed":false,"automatic_replay":false}),
            );
        }
    };
    if !input.follow || result.state != apk_application::debugger::CommandState::Succeeded {
        return encode(result);
    }
    let next_generation = result
        .response
        .as_ref()
        .and_then(|response| response["generation"].as_str())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "debugger_target_changed",
                "重载回执缺少新代次",
            )
        })?;
    let next = tokio::time::timeout_at(deadline, async {
        loop {
            let current = debugger.session(&session.session_id).map_err(error)?;
            if current.target != session.target
                || matches!(
                    current.state,
                    apk_application::debugger::SessionState::Closed
                        | apk_application::debugger::SessionState::Expired
                        | apk_application::debugger::SessionState::Disconnected
                )
            {
                return Ok(None);
            }
            if let Some(target) = debugger
                .targets()
                .map_err(error)?
                .into_iter()
                .find(|target| {
                    target.instance_id == session.target.instance_id
                        && target.plugin_id == session.target.plugin_id
                        && target.generation.as_deref() == Some(next_generation)
                })
            {
                return debugger
                    .follow_target(&session.session_id, &session.target, target)
                    .map_err(error);
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await;
    let followed = match next {
        Ok(result) => result?,
        Err(_) => None,
    };
    Ok(
        json!({"command":result,"followed":followed.is_some(),"session":followed,
        "automatic_replay":false,"note":"只有真实目录确认新代次且选择未变化时才跟随；等待共享原期限"}),
    )
}

pub(super) async fn reload(
    plugins: Option<&Arc<PluginService>>,
    debugger: &DebuggerService,
    reload_expected: Option<&ReloadExpected>,
    session: DebugSession,
    input: Value,
) -> Result<Value, ApiError> {
    let input: ReloadInput = decode(input)?;
    if !input.confirmed {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "debugger_confirmation_required",
            "重载会排空并取消当前插件任务，需要显式确认",
        ));
    }
    if !(100..=30_000).contains(&input.timeout_ms) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "重载等待期限必须为 100 至 30000 毫秒",
        ));
    }
    let plugins = plugins.ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "debugger_capability_unavailable",
            "宿主未配置插件生命周期服务",
        )
    })?;
    let reload_expected = reload_expected.ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "debugger_reload_unavailable",
            "宿主尚未注入原 PluginService 的原子代次校验与排空重载入口",
        )
    })?;
    let previous = session.target;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(input.timeout_ms);
    let cancel = tokio_util::sync::CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let outcome = tokio::time::timeout_at(
        deadline,
        reload_expected(
            plugins.clone(),
            previous.plugin_id.clone(),
            previous.generation.clone().expect("已验证代次"),
            cancel.clone(),
            apk_domain::ExecutionContext {
                deadline: Some(deadline.into_std()),
            },
        ),
    )
    .await;
    let plugin = match outcome {
        Ok(result) => result?,
        Err(_) => {
            cancel.cancel();
            return Ok(
                json!({"state":"timed_out_unconfirmed","previous_target":previous,
            "followed":false,"automatic_replay":false,
            "note":"等待到期不表示排空重载已停止；请重新查询目标，不自动重试"}),
            );
        }
    };
    if plugin.id != previous.plugin_id
        || Some(plugin.generation.as_str()) == previous.generation.as_deref()
        || !plugins
            .list()
            .iter()
            .any(|current| current.id == plugin.id && current.generation == plugin.generation)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "debugger_target_changed",
            "重载返回的插件新代次与真实运行目录不一致，不跟随或自动重放",
        ));
    }
    let next = DebugTarget {
        generation: Some(plugin.generation.clone()),
        version: Some(plugin.version.clone()),
        ..previous.clone()
    };
    debugger.target_changed(&previous).map_err(error)?;
    let followed = if input.follow {
        debugger
            .follow_target(&session.session_id, &previous, next.clone())
            .map_err(error)?
    } else {
        None
    };
    Ok(
        json!({"state":"succeeded","previous_target":previous,"target":next,"plugin":plugin,
        "followed":followed.is_some(),"session":followed,"automatic_replay":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::debugger::server_target::tests::fixture;

    #[tokio::test]
    async fn debugger_reload_requires_confirmation_and_explicit_lifecycle_injection() {
        let (app, plugins, target) = fixture().await;
        let debugger = DebuggerService::new();
        let session = debugger
            .open_session(apk_application::debugger::SessionRequest { target })
            .unwrap();
        assert_eq!(
            reload(
                Some(&plugins),
                &debugger,
                None,
                session.clone(),
                json!({"confirmed":false})
            )
            .await
            .err()
            .unwrap()
            .1
            .code,
            "debugger_confirmation_required"
        );
        assert_eq!(
            reload(
                Some(&plugins),
                &debugger,
                None,
                session.clone(),
                json!({"confirmed":true})
            )
            .await
            .err()
            .unwrap()
            .1
            .code,
            "debugger_reload_unavailable"
        );
        assert_eq!(
            plugins.list()[0].generation,
            session.target.generation.unwrap()
        );
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn debugger_reload_wait_is_bounded_and_never_follows_unconfirmed_result() {
        let (app, plugins, target) = fixture().await;
        let debugger = DebuggerService::new();
        let session = debugger
            .open_session(apk_application::debugger::SessionRequest { target })
            .unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = calls.clone();
        let original = plugins.clone();
        let reloader: Box<ReloadExpected> =
            Box::new(move |service, id, generation, _cancel, context| {
                assert!(Arc::ptr_eq(&service, &original));
                assert_eq!(id, "example");
                assert!(!generation.is_empty());
                assert!(context.deadline.is_some_and(|deadline| deadline
                    <= std::time::Instant::now() + std::time::Duration::from_millis(100)));
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(std::future::pending())
            });
        let result = reload(
            Some(&plugins),
            &debugger,
            Some(reloader.as_ref()),
            session.clone(),
            json!({"confirmed":true,"follow":true,"timeout_ms":100}),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.1.message));
        assert_eq!(result["state"], "timed_out_unconfirmed");
        assert_eq!(result["followed"], false);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            debugger.session(&session.session_id).unwrap().target,
            session.target
        );
        app.shutdown().await.unwrap();
    }
}
