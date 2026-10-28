//! 汇总真实目录、桥回执和可选持久日志；只把脱敏后的有界证据写入原产物端口。
use super::*;
use apk_application::debugger::{CommandState, DebugSession};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ExportFormat {
    #[default]
    None,
    Json,
    Markdown,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ReportInput {
    #[serde(default)]
    export: ExportFormat,
    #[serde(default)]
    logs: Option<ReportLogs>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReportLogs {
    log_id: Option<String>,
    job_id: Option<String>,
    q: Option<String>,
    #[serde(default)]
    order: LogOrder,
    cursor: Option<String>,
    #[serde(default = "log_limit")]
    limit: usize,
}
fn log_limit() -> usize {
    100
}

pub(super) fn redact(mut value: Value) -> Value {
    fn visit(value: &mut Value, depth: usize) {
        if depth > 32 {
            *value = json!("[结构超限]");
            return;
        }
        match value {
            Value::Object(fields) => {
                for (key, child) in fields {
                    let key = key.to_lowercase().replace(['_', '-', '.', ' '], "");
                    let sensitive = [
                        "token",
                        "password",
                        "passwd",
                        "secret",
                        "apikey",
                        "privatekey",
                        "authorization",
                        "credential",
                        "cookie",
                        "signingkey",
                        "signingmaterial",
                        "密码",
                        "密钥",
                        "令牌",
                    ]
                    .iter()
                    .any(|part| key.contains(part));
                    if sensitive {
                        *child = json!("[已脱敏]");
                    } else {
                        visit(child, depth + 1);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, depth + 1);
                }
            }
            _ => {}
        }
    }
    visit(&mut value, 0);
    value
}

pub(super) fn inspect(
    app: &Application,
    plugins: Option<&Arc<PluginService>>,
    target: &DebugTarget,
) -> Result<Value, ApiError> {
    let plugin = plugins.and_then(|service| {
        service.list().into_iter().find(|plugin| {
            plugin.id == target.plugin_id
                && Some(plugin.generation.as_str()) == target.generation.as_deref()
        })
    });
    let services = app
        .services()?
        .into_iter()
        .filter(|service| {
            service.provider.id == target.plugin_id
                && Some(service.provider.generation.as_str()) == target.generation.as_deref()
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"target":target,"plugin":plugin,"services":services,"operations":app.debug_operations(target)?,
        "coverage":{"plugin_catalog":true,"service_contracts":true,"operation_contracts":true,
            "resource_details":false,"ui_tree":false},
        "note":"旧清理告警只保留诊断，不封锁独立新调用"}),
    )
}

pub(super) async fn report(
    app: &Arc<Application>,
    plugins: Option<&Arc<PluginService>>,
    debugger: &DebuggerService,
    ports: DebuggerPorts<'_>,
    session: DebugSession,
    parameters: Value,
) -> Result<Value, ApiError> {
    let input: ReportInput = decode(parameters)?;
    if !matches!(input.export, ExportFormat::None) && ports.artifacts.is_none() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "debugger_artifacts_unavailable",
            "宿主未配置产物存储，无法导出调试报告",
        ));
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        let evidence = if session.target.target_kind == TargetKind::Server {
            inspect(app, plugins, &session.target)?
        } else {
            let result = debugger.execute(DebugCommandRequest { session_id: session.session_id.clone(),
                tool: DebugTool::Report, parameters: json!({}) }).await.map_err(error)?;
            if result.state != CommandState::Succeeded {
                return Err(ApiError::new(StatusCode::CONFLICT, "debugger_report_unconfirmed",
                    "浏览器报告未成功确认，本次不会持久化不完整或旧代报告"));
            }
            result.response.ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY,
                "debugger_report_unconfirmed", "浏览器未返回报告证据"))?
        };
        let logs = match input.logs {
            Some(logs) => diagnostics::query(ports.diagnostics, DiagnosticQuery {
                plugin_id: session.target.plugin_id.clone(), generation: session.target.generation.clone(),
                log_id: logs.log_id, job_id: logs.job_id, session_id: None, q: logs.q,
                order: logs.order, cursor: logs.cursor, limit: logs.limit,
            }).await?,
            None => json!({"included":false,"reason":"本次未请求持久日志"}),
        };
        let current = debugger.session(&session.session_id).map_err(error)?;
        if current.state != apk_application::debugger::SessionState::Active || current.target != session.target {
            return Err(ApiError::new(StatusCode::CONFLICT, "debugger_target_changed",
                "生成报告期间会话已结束或目标已改变，请重新生成当前目标报告"));
        }
        if session.target.target_kind == TargetKind::Server { validate_server_target(&session.target, plugins)?; }
        let events = debugger.events(EventQuery { session_id: Some(session.session_id.clone()), after: 0, limit: 200 }).map_err(error)?;
        let generated_at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis().min(u64::MAX as u128) as u64;
        let report = redact(json!({"protocol_version":1,"generated_at_ms":generated_at_ms,"session":session,"target":session.target,
            "evidence":evidence,"lifecycle_events":events,"logs":logs,
            "scope":{"evidence_target_generation_only":true,"session_events_may_include_previous_generations":true,
                "source_breakpoints":false,"arbitrary_evaluation":false,"production_acceptance_complete":false},
            "redaction":{"recursive_field_names":true,"replacement":"[已脱敏]",
                "scope":"凭据、签名材料、令牌、密码与私钥等已知字段名；不保证识别自由文本或自定义字段中的所有秘密"}}));
        apk_application::debugger::validate_debug_response(&report).map_err(error)?;
        let artifact = match input.export {
            ExportFormat::None => None,
            format => {
                let (filename, bytes) = match format {
                    ExportFormat::Json => ("deviceforge-debug-report.json", serde_json::to_vec_pretty(&report)),
                    ExportFormat::Markdown => {
                        let content = serde_json::to_string_pretty(&report).map_err(|_| ApiError::new(
                            StatusCode::INTERNAL_SERVER_ERROR, "debugger_encoding_failed", "报告编码失败"))?;
                        // 使用缩进代码块，插件文字不能闭合 Markdown 围栏注入报告正文。
                        let text = format!("# DeviceForge 插件调试报告\n\n证据仅限明确选定的运行代次；完整性与脱敏范围见报告字段。\n\n{}\n",
                            content.lines().map(|line| format!("    {line}")).collect::<Vec<_>>().join("\n"));
                        ("deviceforge-debug-report.md", Ok(text.into_bytes()))
                    }
                    ExportFormat::None => unreachable!(),
                };
                let bytes = bytes.map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR,
                    "debugger_encoding_failed", "报告编码失败"))?;
                if bytes.len() > 2 * 1024 * 1024 { return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE,
                    "debugger_report_capacity", "格式化报告超过 2 MiB 上限")); }
                let stream = futures_util::stream::once(async move { Ok(bytes.into()) });
                let artifact = ports.artifacts.expect("已检查产物端口").put(filename.into(), Box::pin(stream)).await?;
                Some(json!({"format":format,"download_url":format!("/api/v2/artifacts/{}/content", artifact.id),"metadata":artifact}))
            }
        };
        Ok(json!({"report":report,"artifact":artifact}))
    }).await.map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "debugger_report_timeout",
        "报告等待已到期；导出可能已写入产物，勿自动重试"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_application::debugger::*;
    use apk_domain::artifacts::ArtifactStore;
    use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
    use futures_util::StreamExt;

    #[test]
    fn debugger_report_redacts_nested_known_fields_and_preserves_evidence_scope() {
        let result = redact(
            json!({"coverage":{"complete":false},"items":[{"api-key":"sentinel",
            "signing_material":{"nested":"sentinel"},"密码":"sentinel"}],"arbitrary_text":"原文"}),
        );
        assert!(!result.to_string().contains("sentinel"));
        assert_eq!(result["coverage"]["complete"], false);
        assert_eq!(result["arbitrary_text"], "原文");
    }

    #[tokio::test]
    async fn debugger_browser_report_waits_for_receipt_and_exports_real_json_and_markdown() {
        let directory = tempfile::tempdir().unwrap();
        let artifacts = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            4,
        )
        .unwrap();
        let debugger = Arc::new(DebuggerService::new());
        let instance = debugger
            .register_instance(BridgeRegistration {
                plugins: vec![BridgePlugin {
                    plugin_id: "example".into(),
                    generation: Some("g1".into()),
                    version: None,
                }],
            })
            .unwrap();
        let session = debugger
            .open_session(SessionRequest {
                target: DebugTarget {
                    target_kind: TargetKind::Browser,
                    instance_id: Some(instance.instance_id.clone()),
                    plugin_id: "example".into(),
                    generation: Some("g1".into()),
                    version: None,
                },
            })
            .unwrap();
        for format in ["json", "markdown"] {
            let (app, debugger, artifacts, session) = (
                app.clone(),
                debugger.clone(),
                artifacts.clone(),
                session.clone(),
            );
            let polling = debugger.clone();
            let download_store = artifacts.clone();
            let format = format.to_owned();
            let expected = format.clone();
            let work = tokio::spawn(async move {
                report(
                    &app,
                    None,
                    &debugger,
                    DebuggerPorts {
                        artifacts: Some(artifacts.as_ref()),
                        ..Default::default()
                    },
                    session,
                    json!({"export":format}),
                )
                .await
            });
            let batch = polling
                .poll(BridgePoll {
                    instance_id: instance.instance_id.clone(),
                    limit: 4,
                })
                .await
                .unwrap();
            assert_eq!(batch.commands.len(), 1);
            assert!(!work.is_finished());
            let command = &batch.commands[0];
            polling.acknowledge(BridgeAck { instance_id:instance.instance_id.clone(), command_id:command.command_id.clone(),
                plugin_id:"example".into(), generation:Some("g1".into()), success:true,
                response:json!({"signing_material":"private-sentinel","coverage":{"complete":false}}) }).unwrap();
            let result = work
                .await
                .unwrap()
                .unwrap_or_else(|error| panic!("{}", error.1.message));
            let id = result["artifact"]["metadata"]["id"].as_str().unwrap();
            let (metadata, mut stream) = download_store.download(id).await.unwrap();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            assert!(metadata.size > 0);
            let text = String::from_utf8(bytes).unwrap();
            assert!(!text.contains("private-sentinel"));
            assert!(text.contains("[已脱敏]"));
            assert_eq!(result["report"]["evidence"]["coverage"]["complete"], false);
            if expected == "json" {
                assert!(serde_json::from_str::<Value>(&text).is_ok());
            } else {
                assert_eq!(metadata.filename, "deviceforge-debug-report.md");
                assert_eq!(metadata.media_type, "text/markdown");
                assert!(text.starts_with("# DeviceForge 插件调试报告"));
            }
        }
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn debugger_browser_report_rejects_target_switch_before_export() {
        let directory = tempfile::tempdir().unwrap();
        let artifacts = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            4,
        )
        .unwrap();
        let debugger = Arc::new(DebuggerService::new());
        let instance = debugger
            .register_instance(BridgeRegistration {
                plugins: vec![BridgePlugin {
                    plugin_id: "example".into(),
                    generation: Some("g1".into()),
                    version: None,
                }],
            })
            .unwrap();
        let other = debugger
            .register_instance(BridgeRegistration {
                plugins: instance.plugins.clone(),
            })
            .unwrap();
        let session = debugger
            .open_session(SessionRequest {
                target: DebugTarget {
                    target_kind: TargetKind::Browser,
                    instance_id: Some(instance.instance_id.clone()),
                    plugin_id: "example".into(),
                    generation: Some("g1".into()),
                    version: None,
                },
            })
            .unwrap();
        let (selected, reporting, application, store) = (
            session.clone(),
            debugger.clone(),
            app.clone(),
            artifacts.clone(),
        );
        let work = tokio::spawn(async move {
            report(
                &application,
                None,
                &reporting,
                DebuggerPorts {
                    artifacts: Some(store.as_ref()),
                    ..Default::default()
                },
                selected,
                json!({"export":"json"}),
            )
            .await
        });
        let batch = debugger
            .poll(BridgePoll {
                instance_id: instance.instance_id.clone(),
                limit: 4,
            })
            .await
            .unwrap();
        debugger
            .acknowledge(BridgeAck {
                instance_id: instance.instance_id,
                command_id: batch.commands[0].command_id.clone(),
                plugin_id: "example".into(),
                generation: Some("g1".into()),
                success: true,
                response: json!({"coverage":{"complete":false}}),
            })
            .unwrap();
        let next = DebugTarget {
            instance_id: Some(other.instance_id),
            ..session.target
        };
        debugger.select_target(&session.session_id, next).unwrap();
        assert_eq!(
            work.await.unwrap().err().unwrap().1.code,
            "debugger_target_changed"
        );
        let mut entries = tokio::fs::read_dir(directory.path()).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            assert!(entry.file_name().to_string_lossy().starts_with('.'));
        }
        app.shutdown().await.unwrap();
    }
}
