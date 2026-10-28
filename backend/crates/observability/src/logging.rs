use crate::LogConfig;
use serde::Serialize;
use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tracing_appender::non_blocking::{ErrorCounter, NonBlocking, NonBlockingBuilder, WorkerGuard};
use tracing_subscriber::{Layer, layer::SubscriberExt, util::SubscriberInitExt};

const RECORD_LIMIT: usize = 8192;

#[derive(Default)]
struct Counters {
    written_bytes: AtomicU64,
    write_errors: AtomicU64,
    oversized_records: AtomicU64,
}

#[derive(Clone)]
pub struct LogMetrics {
    counters: Arc<Counters>,
    dropped: ErrorCounter,
    queue_capacity: usize,
    pub(crate) search: crate::query::LogReader,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct LogStats {
    pub queue_capacity: usize,
    pub record_limit_bytes: usize,
    pub dropped_records: usize,
    pub oversized_records: u64,
    pub written_bytes: u64,
    pub write_errors: u64,
}

impl LogMetrics {
    pub fn snapshot(&self) -> LogStats {
        LogStats {
            queue_capacity: self.queue_capacity,
            record_limit_bytes: RECORD_LIMIT,
            dropped_records: self.dropped.dropped_lines(),
            oversized_records: self.counters.oversized_records.load(Ordering::Relaxed),
            written_bytes: self.counters.written_bytes.load(Ordering::Relaxed),
            write_errors: self.counters.write_errors.load(Ordering::Relaxed),
        }
    }
}

struct CountedWriter<W> {
    inner: W,
    counters: Arc<Counters>,
}
impl<W: Write> Write for CountedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self.inner.write(bytes) {
            Ok(size) => {
                self.counters
                    .written_bytes
                    .fetch_add(size as u64, Ordering::Relaxed);
                Ok(size)
            }
            Err(error) => {
                self.counters.write_errors.fetch_add(1, Ordering::Relaxed);
                Err(error)
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush().inspect_err(|_| {
            self.counters.write_errors.fetch_add(1, Ordering::Relaxed);
        })
    }
}

#[derive(Clone)]
struct Records {
    writer: NonBlocking,
    counters: Arc<Counters>,
}
struct Record {
    owner: Records,
    bytes: Vec<u8>,
    oversized: bool,
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Records {
    type Writer = Record;
    fn make_writer(&'a self) -> Record {
        Record {
            owner: self.clone(),
            bytes: Vec::with_capacity(512),
            oversized: false,
        }
    }
}
impl Write for Record {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > RECORD_LIMIT {
            self.oversized = true;
        }
        if !self.oversized {
            self.bytes.extend_from_slice(bytes);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for Record {
    fn drop(&mut self) {
        if self.oversized {
            self.owner
                .counters
                .oversized_records
                .fetch_add(1, Ordering::Relaxed);
        } else if !self.bytes.is_empty() {
            // 每个 JSONL 事件作为一条队列消息提交，避免多线程交错半行。
            let _ = self.owner.writer.write_all(&self.bytes);
        }
    }
}

pub struct LogRuntime {
    config: LogConfig,
    records: Records,
    metrics: LogMetrics,
    _guard: WorkerGuard,
}
impl LogRuntime {
    pub fn open(config: LogConfig) -> io::Result<Self> {
        config.validate()?;
        let writer = tracing_appender::rolling::RollingFileAppender::builder()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("deviceforge")
            .filename_suffix("jsonl")
            .max_log_files(config.retained_files)
            .build(&config.directory)
            .map_err(io::Error::other)?;
        Ok(Self::with_writer(config, writer))
    }
    fn with_writer(config: LogConfig, writer: impl Write + Send + 'static) -> Self {
        let counters = Arc::new(Counters::default());
        let (writer, guard) = NonBlockingBuilder::default()
            .buffered_lines_limit(config.queue_capacity)
            .lossy(true)
            .thread_name("设备工坊日志写入")
            .finish(CountedWriter {
                inner: writer,
                counters: counters.clone(),
            });
        let metrics = LogMetrics {
            counters: counters.clone(),
            dropped: writer.error_counter(),
            queue_capacity: config.queue_capacity,
            search: crate::query::LogReader::new(config.directory.clone()),
        };
        Self {
            config,
            records: Records { writer, counters },
            metrics,
            _guard: guard,
        }
    }
    pub fn metrics(&self) -> LogMetrics {
        self.metrics.clone()
    }
    pub fn subscriber(&self) -> impl tracing::Subscriber + Send + Sync + 'static {
        let layer = tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_current_span(true)
            .with_span_list(true)
            .with_writer(self.records.clone())
            .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
                metadata.target().starts_with("apk_")
                    || metadata.target().starts_with("deviceforge_")
            }))
            .with_filter(self.config.level);
        tracing_subscriber::registry().with(layer)
    }
}

pub fn install(config: LogConfig) -> io::Result<LogRuntime> {
    let runtime = LogRuntime::open(config)?;
    runtime.subscriber().try_init().map_err(io::Error::other)?;
    // panic 的外部载荷可能包含凭据；记录固定文案，不调用默认打印钩子。
    std::panic::set_hook(Box::new(
        |_| tracing::error!(target: "deviceforge_observability", "进程发生内部异常"),
    ));
    Ok(runtime)
}

#[cfg(test)]
mod tests;
