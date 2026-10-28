//! 调试器持久日志查询独立于原百条搜索，使用相同工作池、目录和绝对扫描期限。
use super::*;
use std::collections::BTreeMap;
mod scan;

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebuggerLogQuery {
    pub plugin_id: String,
    pub generation: Option<String>,
    pub log_id: Option<String>,
    pub job_id: Option<String>,
    pub session_id: Option<String>,
    pub q: Option<String>,
    #[serde(default)]
    pub order: LogOrder,
    pub cursor: Option<String>,
    #[serde(default = "page_limit")]
    pub limit: usize,
}
fn page_limit() -> usize {
    100
}

#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
pub struct DebuggerLogEntry {
    #[serde(flatten)]
    pub event: LogEntry,
    pub plugin_id: Option<String>,
    pub generation: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Default, Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct DebuggerLogCoverage {
    pub snapshot: bool,
    pub gap: bool,
    pub scan_limited: bool,
    pub incomplete_scan: bool,
    pub missing_association_records: u64,
    pub invalid_records: u64,
    pub scanned_files: usize,
    pub scanned_bytes: u64,
    pub has_more: bool,
    pub retained_logs_only: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct DebuggerLogPage {
    pub entries: Vec<DebuggerLogEntry>,
    pub next_cursor: Option<String>,
    pub limited: bool,
    pub coverage: DebuggerLogCoverage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FilterSpec {
    plugin_id: String,
    generation: Option<String>,
    log_id: Option<String>,
    job_id: Option<String>,
    session_id: Option<String>,
    q: Option<String>,
    descending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RecordKey {
    time: i128,
    file: String,
    offset: u64,
}

#[derive(Clone)]
struct Snapshot {
    filter: FilterSpec,
    files: Vec<scan::FileWindow>,
    boundary: Option<RecordKey>,
    limited: bool,
}

struct CachedCursor {
    snapshot: Snapshot,
    expires: Instant,
}

#[derive(Default)]
pub(super) struct CursorCache {
    entries: BTreeMap<String, CachedCursor>,
}

impl CursorCache {
    fn prune(&mut self) {
        self.entries
            .retain(|_, entry| Instant::now() < entry.expires);
    }
    fn get(&mut self, token: &str, filter: &FilterSpec) -> io::Result<Snapshot> {
        self.prune();
        let entry = self.entries.get(token).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "日志游标已过期或属于其他宿主，请从首页重新查询",
            )
        })?;
        if &entry.snapshot.filter != filter {
            return Err(invalid("日志游标与筛选或排序不匹配"));
        }
        Ok(entry.snapshot.clone())
    }
    fn insert(&mut self, snapshot: Snapshot) -> io::Result<String> {
        self.prune();
        if self.entries.len() >= 128 {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "日志分页游标容量已满，请稍后重新查询",
            ));
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.entries.insert(
            token.clone(),
            CachedCursor {
                snapshot,
                expires: Instant::now() + Duration::from_secs(300),
            },
        );
        Ok(token)
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

impl DebuggerLogQuery {
    fn filter(&self) -> io::Result<FilterSpec> {
        let text = |value: &str| {
            !value.trim().is_empty()
                && value.len() <= 128
                && value.trim() == value
                && !value.chars().any(char::is_control)
        };
        if !text(&self.plugin_id)
            || self.generation.as_ref().is_some_and(|v| !text(v))
            || self.q.as_ref().is_some_and(|v| !text(v))
            || !(1..=100).contains(&self.limit)
        {
            return Err(invalid(
                "日志查询需要明确插件、可见筛选文本和 1 至 100 条页大小",
            ));
        }
        if let Some(token) = &self.cursor {
            validate_id(token)?;
        }
        let id = |value: &Option<String>| value.as_ref().map(|v| validate_id(v)).transpose();
        Ok(FilterSpec {
            plugin_id: self.plugin_id.clone(),
            generation: self.generation.clone(),
            log_id: id(&self.log_id)?,
            job_id: id(&self.job_id)?,
            session_id: id(&self.session_id)?,
            q: self.q.as_ref().map(|v| v.to_lowercase()),
            descending: matches!(self.order, LogOrder::Desc),
        })
    }
}

impl crate::LogMetrics {
    pub async fn search_debugger_logs(
        &self,
        query: DebuggerLogQuery,
    ) -> io::Result<DebuggerLogPage> {
        let filter = query.filter()?;
        let permit =
            self.search.slots.clone().try_acquire_owned().map_err(|_| {
                io::Error::new(io::ErrorKind::WouldBlock, "日志查询较多，请稍后重试")
            })?;
        // 原搜索与调试分页共用两槽；排队进入阻塞池也消耗同一绝对期限。
        let deadline = Instant::now() + Duration::from_secs(2);
        let directory = self.search.directory.clone();
        let cursors = self.search.debugger_cursors.clone();
        let snapshot = match &query.cursor {
            Some(token) => Some(
                cursors
                    .try_lock()
                    .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "日志游标状态忙"))?
                    .get(token, &filter)?,
            ),
            None => None,
        };
        let mut work = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let snapshot = match snapshot {
                Some(snapshot) => snapshot,
                None => scan::snapshot(&directory, filter, deadline)?,
            };
            let (mut page, next) = scan::page(&directory, snapshot, query.limit, deadline)?;
            if let Some(next) = next {
                page.next_cursor = Some(
                    cursors
                        .try_lock()
                        .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "日志游标状态忙"))?
                        .insert(next)?,
                );
            }
            Ok(page)
        });
        match tokio::time::timeout(Duration::from_millis(2500), &mut work).await {
            Ok(result) => result.map_err(|_| io::Error::other("调试日志查询未完成"))?,
            Err(_) => {
                work.abort();
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "调试日志查询等待已到期",
                ))
            }
        }
    }
}

#[cfg(test)]
#[path = "debugger/tests.rs"]
mod tests;
