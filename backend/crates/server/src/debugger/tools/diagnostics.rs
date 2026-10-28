//! 日志筛选与分页下沉到持久日志端口，不在首百条结果上伪造全范围查询。
use super::*;
use futures_util::future::BoxFuture;
use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LogOrder {
    Asc,
    #[default]
    Desc,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct DiagnosticQuery {
    pub plugin_id: String,
    #[serde(default)]
    pub generation: Option<String>,
    #[serde(default)]
    pub log_id: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub order: LogOrder,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "page_size")]
    pub limit: usize,
}

fn page_size() -> usize {
    100
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub(crate) struct DiagnosticPage {
    pub entries: Vec<Value>,
    pub next_cursor: Option<String>,
    pub limited: bool,
    /// 由实际日志查询端口声明扫描范围、缺失关联与游标稳定性。
    pub coverage: Value,
}

pub(crate) trait DebuggerDiagnostics: Send + Sync {
    /// 实现必须在有界工作池内查询，先按全部条件筛选排序，再分页。
    fn query(&self, query: DiagnosticQuery) -> BoxFuture<'_, Result<DiagnosticPage, ApiError>>;
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub(super) enum EventsInput {
    Legacy(EventQuery),
    Source(EventSource),
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub(super) enum EventSource {
    Logs(DiagnosticQuery),
    Lifecycle(EventQuery),
}

impl DiagnosticQuery {
    pub(super) fn validate(&self) -> Result<(), ApiError> {
        let visible = |text: &str, max: usize| {
            !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
        };
        if !visible(&self.plugin_id, 128)
            || !(1..=100).contains(&self.limit)
            || self.generation.as_ref().is_some_and(|s| !visible(s, 128))
            || self.q.as_ref().is_some_and(|s| !visible(s, 128))
            || self.cursor.as_ref().is_some_and(|s| !visible(s, 2048))
            || [&self.log_id, &self.job_id, &self.session_id]
                .iter()
                .filter_map(|id| id.as_ref())
                .any(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "debugger_invalid_input",
                "日志查询需要明确插件、有效关联编号和 1 至 100 条页大小；游标为服务器返回的不透明值",
            ));
        }
        Ok(())
    }
}

pub(super) async fn query(
    port: Option<&dyn DebuggerDiagnostics>,
    input: DiagnosticQuery,
) -> Result<Value, ApiError> {
    input.validate()?;
    let port = port.ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "debugger_diagnostics_unavailable",
            "宿主尚未注入支持插件关联与游标的持久日志查询端口",
        )
    })?;
    let limit = input.limit;
    let page = tokio::time::timeout(std::time::Duration::from_millis(2500), port.query(input))
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "debugger_diagnostics_timeout",
                "日志查询等待已到期，不自动重试",
            )
        })??;
    if page.entries.len() > limit || page.next_cursor.as_ref().is_some_and(|s| s.len() > 2048) {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "debugger_diagnostics_invalid",
            "日志端口返回的页超过已声明上限",
        ));
    }
    let mut value = report::redact(encode(page)?);
    value["source"] = json!("logs");
    apk_application::debugger::validate_debug_response(&value).map_err(error)?;
    Ok(value)
}

pub(super) async fn events(
    debugger: &DebuggerService,
    port: Option<&dyn DebuggerDiagnostics>,
    input: Value,
) -> Result<Value, ApiError> {
    match decode::<EventsInput>(input)? {
        EventsInput::Legacy(query) | EventsInput::Source(EventSource::Lifecycle(query)) => {
            encode(debugger.events(query).map_err(error)?)
        }
        EventsInput::Source(EventSource::Logs(input)) => query(port, input).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct QueryPort;
    impl DebuggerDiagnostics for QueryPort {
        fn query(&self, query: DiagnosticQuery) -> BoxFuture<'_, Result<DiagnosticPage, ApiError>> {
            Box::pin(async move {
                assert_eq!(query.plugin_id, "example");
                assert_eq!(query.generation.as_deref(), Some("g2"));
                assert_eq!(query.cursor.as_deref(), Some("opaque-page-2"));
                assert!(matches!(query.order, LogOrder::Desc));
                assert_eq!(query.limit, 2);
                assert_eq!(query.q.as_deref(), Some("失败"));
                Ok(DiagnosticPage {
                    entries: vec![json!({"message":"当前代日志","password":"private-sentinel"})],
                    next_cursor: Some("opaque-page-3".into()),
                    limited: true,
                    coverage: json!({"source":"持久日志端口","complete":false}),
                })
            })
        }
    }

    #[tokio::test]
    async fn debugger_logs_forward_exact_filters_cursor_and_preserve_coverage() {
        let result = events(
            &DebuggerService::new(),
            Some(&QueryPort),
            json!({"source":"logs",
            "plugin_id":"example","generation":"g2","q":"失败","cursor":"opaque-page-2","limit":2}),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.1.message));
        assert_eq!(result["next_cursor"], "opaque-page-3");
        assert_eq!(result["limited"], true);
        assert_eq!(result["coverage"]["complete"], false);
        assert_eq!(result["entries"][0]["password"], "[已脱敏]");
        assert!(!result.to_string().contains("private-sentinel"));
    }

    #[tokio::test]
    async fn debugger_logs_missing_port_is_explicit_and_legacy_events_remain_compatible() {
        let service = DebuggerService::new();
        assert_eq!(
            events(
                &service,
                None,
                json!({"source":"logs","plugin_id":"example"})
            )
            .await
            .err()
            .unwrap()
            .1
            .code,
            "debugger_diagnostics_unavailable"
        );
        for input in [
            json!({"after":0,"limit":10}),
            json!({"source":"lifecycle","after":0,"limit":10}),
        ] {
            assert!(
                events(&service, None, input)
                    .await
                    .unwrap_or_else(|error| panic!("{}", error.1.message))["events"]
                    .is_array()
            );
        }
        for input in [
            json!({"source":"logs","plugin_id":"example","limit":101}),
            json!({"source":"logs","plugin_id":"example","cursor":""}),
            json!({"source":"logs","plugin_id":"example","job_id":"not-a-job"}),
            json!({"source":"logs","plugin_id":"example","unknown":true}),
        ] {
            assert_eq!(
                events(&service, None, input).await.err().unwrap().1.code,
                "debugger_invalid_input"
            );
        }
    }
}
