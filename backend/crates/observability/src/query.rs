//! 保留日志的精确关联查询；文件读取、响应字段、时间和并发均有固定上限。
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod debugger;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
pub struct LogEntry {
    pub log_id: Option<String>,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub job_id: Option<String>,
    pub operation: Option<String>,
    pub code: Option<String>,
    pub method: Option<String>,
    pub route: Option<String>,
    pub status: Option<u16>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct LogSearch {
    pub log_id: Option<String>,
    pub entries: Vec<LogEntry>,
    pub job_ids: Vec<String>,
    pub limited: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LogOrder {
    Asc,
    #[default]
    Desc,
}

enum Filter {
    Id(String),
    Text(String),
}

#[derive(Clone)]
pub(crate) struct LogReader {
    directory: PathBuf,
    slots: Arc<tokio::sync::Semaphore>,
    debugger_cursors: Arc<std::sync::Mutex<debugger::CursorCache>>,
}

impl LogReader {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            slots: Arc::new(tokio::sync::Semaphore::new(2)),
            debugger_cursors: Arc::new(std::sync::Mutex::new(debugger::CursorCache::default())),
        }
    }
}

impl crate::LogMetrics {
    pub async fn search(&self, id: &str) -> io::Result<LogSearch> {
        self.search_logs(Some(id), None, LogOrder::Desc).await
    }

    pub async fn search_logs(
        &self,
        id: Option<&str>,
        query: Option<&str>,
        order: LogOrder,
    ) -> io::Result<LogSearch> {
        let filter = match (id, query) {
            (Some(id), None) => Filter::Id(validate_id(id)?),
            (None, Some(query)) => {
                let query = query.trim();
                if query.is_empty() || query.len() > 128 || query.chars().any(char::is_control) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "搜索词须为 1 至 128 字节的可见文字",
                    ));
                }
                Filter::Text(query.to_lowercase())
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "请填写日志 ID 或搜索词，两者不能同时使用",
                ));
            }
        };
        self.search_filtered(filter, order).await
    }

    async fn search_filtered(&self, filter: Filter, order: LogOrder) -> io::Result<LogSearch> {
        let permit =
            self.search.slots.clone().try_acquire_owned().map_err(|_| {
                io::Error::new(io::ErrorKind::WouldBlock, "日志查询较多，请稍后重试")
            })?;
        let directory = self.search.directory.clone();
        let deadline = Instant::now() + Duration::from_secs(2);
        // 截止点建立在入阻塞池前；请求停止后，后台扫描仍按同一期限退出。
        let mut work = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            scan_filtered(directory, filter, order, deadline)
        });
        match tokio::time::timeout(Duration::from_millis(2500), &mut work).await {
            Ok(result) => result.map_err(|_| io::Error::other("日志查询未完成"))?,
            Err(_) => {
                work.abort();
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "日志查询等待时间已用完，请稍后重试",
                ))
            }
        }
    }
}

fn validate_id(id: &str) -> io::Result<String> {
    if id.len() != 36 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "请填写完整日志 ID",
        ));
    }
    Ok(uuid::Uuid::parse_str(id)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "请填写完整日志 ID"))?
        .to_string())
}

fn field<'a>(record: &'a Value, key: &str) -> Option<&'a Value> {
    record
        .get("fields")
        .and_then(|v| v.get(key))
        .or_else(|| record.get("span").and_then(|v| v.get(key)))
        .or_else(|| {
            record
                .get("spans")
                .and_then(Value::as_array)
                .and_then(|spans| spans.iter().rev().find_map(|v| v.get(key)))
        })
}

fn text(record: &Value, key: &str) -> Option<String> {
    field(record, key)
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 512)
        .map(str::to_owned)
}

fn entry(record: &Value) -> LogEntry {
    LogEntry {
        log_id: text(record, "log_id").and_then(|id| validate_id(&id).ok()),
        timestamp: record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(64)
            .collect(),
        level: record
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(16)
            .collect(),
        message: text(record, "message").unwrap_or_else(|| "请求诊断记录".into()),
        job_id: text(record, "job_id").filter(|id| uuid::Uuid::parse_str(id).is_ok()),
        operation: text(record, "operation"),
        code: text(record, "code"),
        method: text(record, "method"),
        route: text(record, "route"),
        status: field(record, "status")
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok()),
    }
}

#[cfg(test)]
fn scan(directory: PathBuf, id: String, deadline: Instant) -> io::Result<LogSearch> {
    scan_filtered(directory, Filter::Id(id), LogOrder::Desc, deadline)
}

fn matches(filter: &Filter, entry: &LogEntry) -> bool {
    match filter {
        Filter::Id(id) => entry
            .log_id
            .as_ref()
            .is_some_and(|value| value.eq_ignore_ascii_case(id)),
        Filter::Text(query) => [
            Some(entry.message.as_str()),
            Some(entry.level.as_str()),
            entry.log_id.as_deref(),
            entry.job_id.as_deref(),
            entry.operation.as_deref(),
            entry.code.as_deref(),
            entry.method.as_deref(),
            entry.route.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.to_lowercase().contains(query)),
    }
}

fn timestamp(value: &str) -> i128 {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|time| time.unix_timestamp_nanos())
        .unwrap_or(i128::MIN)
}

fn scan_filtered(
    directory: PathBuf,
    filter: Filter,
    order: LogOrder,
    deadline: Instant,
) -> io::Result<LogSearch> {
    let mut result = LogSearch {
        log_id: match &filter {
            Filter::Id(id) => Some(id.clone()),
            Filter::Text(_) => None,
        },
        entries: Vec::new(),
        job_ids: Vec::new(),
        limited: false,
    };
    let mut files = Vec::new();
    let directory = match fs::read_dir(directory) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(error),
    };
    for (index, item) in directory.enumerate() {
        if index >= 1024 || Instant::now() >= deadline {
            result.limited = true;
            break;
        }
        let item = item?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("deviceforge.")
            && name.ends_with(".jsonl")
            && item.file_type()?.is_file()
        {
            files.push(item.path());
        }
    }
    files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    if files.len() > 64 {
        files.truncate(64);
        result.limited = true;
    }
    let mut remaining = 64 * 1024 * 1024u64;
    let mut timestamps = Vec::with_capacity(101);
    'files: for path in files {
        if Instant::now() >= deadline || remaining == 0 {
            result.limited = true;
            break;
        }
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                result.limited = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        let size = file.metadata()?.len();
        let length = size.min(remaining).min(8 * 1024 * 1024);
        let offset = size - length;
        if offset > 0 {
            result.limited = true;
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::new(file.take(length));
        let mut line = Vec::with_capacity(8192);
        let mut discard = offset > 0;
        loop {
            if Instant::now() >= deadline {
                result.limited = true;
                break 'files;
            }
            let buffer = reader.fill_buf()?;
            if buffer.is_empty() {
                break;
            }
            let size = buffer
                .iter()
                .position(|v| *v == b'\n')
                .map_or(buffer.len(), |v| v + 1);
            if !discard {
                if line.len() + size <= 8192 {
                    line.extend_from_slice(&buffer[..size]);
                } else {
                    discard = true;
                    result.limited = true;
                }
            }
            let end = buffer[size - 1] == b'\n';
            reader.consume(size);
            remaining = remaining.saturating_sub(size as u64);
            if !end {
                continue;
            }
            if !discard && let Ok(record) = serde_json::from_slice::<Value>(&line) {
                let record = entry(&record);
                if matches(&filter, &record) {
                    // 在服务器扫描完整预算范围后保留排序靠前的百条；不能先取旧百条再倒序。
                    let time = timestamp(&record.timestamp);
                    let index = timestamps.partition_point(|existing| match order {
                        LogOrder::Asc => *existing <= time,
                        LogOrder::Desc => *existing >= time,
                    });
                    if index < 100 {
                        timestamps.insert(index, time);
                        result.entries.insert(index, record);
                    }
                    if timestamps.len() > 100 || index >= 100 {
                        timestamps.truncate(100);
                        result.entries.truncate(100);
                        result.limited = true;
                    }
                }
            }
            line.clear();
            discard = false;
        }
    }
    let jobs: BTreeSet<_> = result
        .entries
        .iter()
        .filter_map(|entry| entry.job_id.clone())
        .collect();
    if jobs.len() > 20 {
        result.limited = true;
    }
    result.job_ids = jobs.into_iter().take(20).collect();
    Ok(result)
}

#[cfg(test)]
#[path = "query/tests.rs"]
mod tests;
