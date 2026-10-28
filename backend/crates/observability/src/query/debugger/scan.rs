//! 有界窗口内按实际时间和文件偏移作键集分页；不把文件路径或原始 JSON 暴露给调用者。
use super::*;
use std::{
    cmp::Ordering,
    hash::{Hash, Hasher},
    path::Path,
    time::SystemTime,
};

const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
mod identity;

#[derive(Clone)]
pub(super) struct FileWindow {
    name: String,
    identity: (u64, u64),
    size: u64,
    start: u64,
    created: Option<u128>,
    modified: Option<u128>,
    prefix: u64,
    tail: u64,
}

fn nanos(value: io::Result<SystemTime>) -> Option<u128> {
    value
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
}
fn digest(file: &mut File, offset: u64, size: u64) -> io::Result<u64> {
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = [0u8; 128];
    let length = size.min(128) as usize;
    file.read_exact(&mut buffer[..length])?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    buffer[..length].hash(&mut hash);
    Ok(hash.finish())
}
impl FileWindow {
    fn capture(name: String, mut file: File, length: u64) -> io::Result<Self> {
        let metadata = file.metadata()?;
        let size = metadata.len();
        Ok(Self {
            name,
            identity: identity::file_id(&file)?,
            size,
            start: size.saturating_sub(length),
            created: nanos(metadata.created()),
            modified: nanos(metadata.modified()),
            prefix: digest(&mut file, 0, size)?,
            tail: digest(&mut file, size.saturating_sub(128), size)?,
        })
    }
    fn unchanged(&self, file: &mut File) -> io::Result<bool> {
        let metadata = file.metadata()?;
        if metadata.len() < self.size
            || identity::file_id(file)? != self.identity
            || nanos(metadata.created()) != self.created
            || (metadata.len() == self.size && nanos(metadata.modified()) != self.modified)
        {
            return Ok(false);
        }
        Ok(digest(file, 0, self.size)? == self.prefix
            && digest(file, self.size.saturating_sub(128), self.size)? == self.tail)
    }
}

pub(super) fn snapshot(
    directory: &Path,
    filter: FilterSpec,
    deadline: Instant,
) -> io::Result<Snapshot> {
    let mut snapshot = Snapshot {
        filter,
        files: Vec::new(),
        boundary: None,
        limited: false,
    };
    let directory_entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(snapshot),
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    for (index, entry) in directory_entries.enumerate() {
        if index >= 1024 || Instant::now() >= deadline {
            snapshot.limited = true;
            break;
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with("deviceforge.")
            && name.ends_with(".jsonl")
            && name.len() <= 255
            && entry.file_type()?.is_file()
        {
            names.push(name.to_owned());
        }
    }
    names.sort_by(|a, b| b.cmp(a));
    if names.len() > 64 {
        names.truncate(64);
        snapshot.limited = true;
    }
    // 为每份文件的身份锚点留预算，扫描总读取量仍不超过 64 MiB。
    let mut remaining = MAX_SCAN_BYTES - 64 * 1024;
    for name in names {
        if Instant::now() >= deadline || remaining == 0 {
            snapshot.limited = true;
            break;
        }
        let file = match File::open(directory.join(&name)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                snapshot.limited = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        let size = file.metadata()?.len();
        let length = size.min(remaining).min(MAX_FILE_BYTES);
        let window = FileWindow::capture(name, file, length)?;
        if window.start > 0 {
            snapshot.limited = true;
        }
        remaining -= window.size - window.start;
        snapshot.files.push(window);
    }
    Ok(snapshot)
}

fn diagnostic(record: &Value) -> DebuggerLogEntry {
    DebuggerLogEntry {
        event: entry(record),
        plugin_id: text(record, "plugin_id"),
        generation: text(record, "generation"),
        session_id: text(record, "session_id").and_then(|id| validate_id(&id).ok()),
    }
}
fn matches_filter(filter: &FilterSpec, entry: &DebuggerLogEntry) -> bool {
    entry.plugin_id.as_deref() == Some(filter.plugin_id.as_str())
        && filter
            .generation
            .as_ref()
            .is_none_or(|id| entry.generation.as_ref() == Some(id))
        && filter
            .log_id
            .as_ref()
            .is_none_or(|id| entry.event.log_id.as_ref() == Some(id))
        && filter
            .job_id
            .as_ref()
            .is_none_or(|id| entry.event.job_id.as_ref() == Some(id))
        && filter
            .session_id
            .as_ref()
            .is_none_or(|id| entry.session_id.as_ref() == Some(id))
        && filter.q.as_ref().is_none_or(|q| {
            matches(&Filter::Text(q.clone()), &entry.event)
                || [&entry.plugin_id, &entry.generation, &entry.session_id]
                    .into_iter()
                    .flatten()
                    .any(|text| text.to_lowercase().contains(q))
        })
}
fn missing(filter: &FilterSpec, entry: &DebuggerLogEntry) -> bool {
    entry.plugin_id.is_none()
        || (entry.plugin_id.as_deref() == Some(filter.plugin_id.as_str())
            && ((filter.generation.is_some() && entry.generation.is_none())
                || (filter.log_id.is_some() && entry.event.log_id.is_none())
                || (filter.job_id.is_some() && entry.event.job_id.is_none())
                || (filter.session_id.is_some() && entry.session_id.is_none())))
}

struct Candidate {
    key: RecordKey,
    entry: DebuggerLogEntry,
}
fn compare(a: &RecordKey, b: &RecordKey, descending: bool) -> Ordering {
    if descending { b.cmp(a) } else { a.cmp(b) }
}

pub(super) fn page(
    directory: &Path,
    mut snapshot: Snapshot,
    limit: usize,
    deadline: Instant,
) -> io::Result<(DebuggerLogPage, Option<Snapshot>)> {
    let mut coverage = DebuggerLogCoverage {
        snapshot: true,
        retained_logs_only: true,
        scan_limited: snapshot.limited,
        ..Default::default()
    };
    let mut candidates: Vec<Candidate> = Vec::with_capacity(limit + 1);
    for window in &snapshot.files {
        if Instant::now() >= deadline {
            coverage.incomplete_scan = true;
            break;
        }
        let mut file = match File::open(directory.join(&window.name)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                coverage.gap = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        if !window.unchanged(&mut file)? {
            coverage.gap = true;
            continue;
        }
        file.seek(SeekFrom::Start(window.start))?;
        coverage.scanned_files += 1;
        let mut reader = BufReader::new((&mut file).take(window.size - window.start));
        let mut line = Vec::with_capacity(8192);
        let mut discard = window.start > 0;
        let mut position = window.start;
        let mut line_offset = position;
        loop {
            if Instant::now() >= deadline {
                coverage.incomplete_scan = true;
                break;
            }
            let buffer = reader.fill_buf()?;
            if buffer.is_empty() {
                if !line.is_empty() {
                    coverage.invalid_records += 1;
                }
                break;
            }
            let size = buffer
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(buffer.len(), |i| i + 1);
            if !discard {
                if line.len() + size <= 8192 {
                    line.extend_from_slice(&buffer[..size]);
                } else {
                    discard = true;
                    coverage.invalid_records += 1;
                }
            }
            let end = buffer[size - 1] == b'\n';
            reader.consume(size);
            position += size as u64;
            coverage.scanned_bytes += size as u64;
            if !end {
                continue;
            }
            if !discard {
                match serde_json::from_slice::<Value>(&line) {
                    Ok(record) => {
                        let entry = diagnostic(&record);
                        if missing(&snapshot.filter, &entry) {
                            coverage.missing_association_records += 1;
                        }
                        if matches_filter(&snapshot.filter, &entry) {
                            let time = timestamp(&entry.event.timestamp);
                            if time == i128::MIN {
                                coverage.invalid_records += 1;
                            }
                            let key = RecordKey {
                                time,
                                file: window.name.clone(),
                                offset: line_offset,
                            };
                            if snapshot.boundary.as_ref().is_none_or(|boundary| {
                                compare(&key, boundary, snapshot.filter.descending)
                                    == Ordering::Greater
                            }) {
                                let index = candidates.partition_point(|candidate| {
                                    compare(&candidate.key, &key, snapshot.filter.descending)
                                        == Ordering::Less
                                });
                                if index <= limit {
                                    candidates.insert(index, Candidate { key, entry });
                                    candidates.truncate(limit + 1);
                                }
                            }
                        }
                    }
                    Err(_) => coverage.invalid_records += 1,
                }
            }
            line.clear();
            discard = false;
            line_offset = position;
        }
        drop(reader);
        if !window.unchanged(&mut file)? {
            coverage.gap = true;
        }
        if coverage.incomplete_scan {
            break;
        }
    }
    coverage.has_more = candidates.len() > limit;
    candidates.truncate(limit);
    let next = if coverage.has_more && !coverage.gap && !coverage.incomplete_scan {
        snapshot.boundary = candidates.last().map(|candidate| candidate.key.clone());
        Some(snapshot)
    } else {
        None
    };
    let limited = coverage.has_more
        || coverage.gap
        || coverage.incomplete_scan
        || coverage.scan_limited
        || coverage.invalid_records > 0
        || coverage.missing_association_records > 0;
    Ok((
        DebuggerLogPage {
            entries: candidates
                .into_iter()
                .map(|candidate| candidate.entry)
                .collect(),
            next_cursor: None,
            limited,
            coverage,
        },
        next,
    ))
}
