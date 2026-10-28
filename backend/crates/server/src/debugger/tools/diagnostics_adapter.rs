//! 真实持久日志适配器；HTTP/MCP 临时持有原 LogMetrics 克隆，共用同一目录和工作池。
use super::*;
use deviceforge_observability::{DebuggerLogQuery, LogMetrics};
use futures_util::future::BoxFuture;

pub(crate) struct PersistentDiagnostics(pub LogMetrics);

impl DebuggerDiagnostics for PersistentDiagnostics {
    fn query(&self, query: DiagnosticQuery) -> BoxFuture<'_, Result<DiagnosticPage, ApiError>> {
        Box::pin(async move {
            let result = self
                .0
                .search_debugger_logs(DebuggerLogQuery {
                    plugin_id: query.plugin_id,
                    generation: query.generation,
                    log_id: query.log_id,
                    job_id: query.job_id,
                    session_id: query.session_id,
                    q: query.q,
                    order: match query.order {
                        LogOrder::Asc => deviceforge_observability::LogOrder::Asc,
                        LogOrder::Desc => deviceforge_observability::LogOrder::Desc,
                    },
                    cursor: query.cursor,
                    limit: query.limit,
                })
                .await
                .map_err(|failure| {
                    let (status, code, message) = match failure.kind() {
                        std::io::ErrorKind::InvalidInput => (
                            StatusCode::BAD_REQUEST,
                            "debugger_invalid_input",
                            "日志筛选或游标与本次请求不符，请从首页重新查询",
                        ),
                        std::io::ErrorKind::NotFound => (
                            StatusCode::CONFLICT,
                            "debugger_cursor_expired",
                            "日志游标已过期或属于其他宿主，请从首页重新查询",
                        ),
                        std::io::ErrorKind::WouldBlock => (
                            StatusCode::TOO_MANY_REQUESTS,
                            "debugger_diagnostics_busy",
                            "持久日志查询或分页容量已满，请稍后重试",
                        ),
                        std::io::ErrorKind::TimedOut => (
                            StatusCode::GATEWAY_TIMEOUT,
                            "debugger_diagnostics_timeout",
                            "持久日志查询等待已到期",
                        ),
                        _ => (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "debugger_log_read_failed",
                            "无法查询保留日志，请检查日志存储状态",
                        ),
                    };
                    ApiError::new(status, code, message)
                })?;
            let entries = result
                .entries
                .into_iter()
                .map(encode)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(DiagnosticPage {
                entries,
                next_cursor: result.next_cursor,
                limited: result.limited,
                coverage: encode(result.coverage)?,
            })
        })
    }
}
