//! 使用真实临时 JSONL 文件验证跨百条分页，不以百条搜索结果模拟服务端分页。
use super::*;
use serde_json::json;

const LOG: &str = "d3be1c0c-eee8-43a6-9f47-f963ddbfc725";
const JOB: &str = "31a501f3-ab38-4f84-8c70-d74bf6c86520";
const SESSION: &str = "d3be1c0c-eee8-43a6-9f47-f963ddbfc726";

fn query() -> DebuggerLogQuery {
    DebuggerLogQuery {
        plugin_id: "example".into(),
        generation: Some("g2".into()),
        log_id: None,
        job_id: None,
        session_id: None,
        q: None,
        order: LogOrder::Desc,
        cursor: None,
        limit: 100,
    }
}
fn record(index: usize) -> Value {
    json!({"timestamp":format!("2026-10-28T10:{:02}:{:02}Z", index/60, index%60),"level":"INFO",
        "fields":{"message":format!("请求记录 {index}"),"private_path":"private-sentinel","token":"private-sentinel"},
        "span":{"plugin_id":"example","generation":"g2","job_id":JOB,"session_id":SESSION,"log_id":LOG}})
}
fn runtime(directory: &std::path::Path) -> crate::LogRuntime {
    crate::LogRuntime::open(crate::LogConfig {
        directory: directory.to_owned(),
        queue_capacity: 8,
        retained_files: 2,
        level: tracing::level_filters::LevelFilter::INFO,
    })
    .unwrap()
}

#[tokio::test]
async fn debugger_persistent_pages_reach_records_after_two_hundred_in_both_orders() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = runtime(directory.path());
    let metrics = runtime.metrics();
    let mut lines = String::new();
    for index in 0..350 {
        lines.push_str(&format!("{}\n", record(index)));
    }
    fs::write(directory.path().join("deviceforge.2026-10-28.jsonl"), lines).unwrap();
    for order in [LogOrder::Desc, LogOrder::Asc] {
        let mut request = query();
        request.order = order;
        let mut messages = Vec::new();
        for page_index in 0..4 {
            let page = metrics.search_debugger_logs(request.clone()).await.unwrap();
            assert_eq!(page.entries.len(), if page_index < 3 { 100 } else { 50 });
            assert!(!page.coverage.gap);
            messages.extend(page.entries.iter().map(|entry| entry.event.message.clone()));
            assert!(
                !serde_json::to_string(&page)
                    .unwrap()
                    .contains("private-sentinel")
            );
            request.cursor = page.next_cursor;
            if page_index < 3 {
                assert!(request.cursor.is_some());
            } else {
                assert!(request.cursor.is_none());
            }
        }
        let expected: Vec<_> = match order {
            LogOrder::Asc => (0..350).collect(),
            LogOrder::Desc => (0..350).rev().collect(),
        };
        assert_eq!(
            messages,
            expected
                .into_iter()
                .map(|index| format!("请求记录 {index}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(messages.iter().collect::<BTreeSet<_>>().len(), 350);
    }
}

#[tokio::test]
async fn debugger_filters_all_associations_before_paging_and_cursor_binds_query() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = runtime(directory.path());
    let metrics = runtime.metrics();
    let mut lines = String::new();
    for index in 0..360 {
        let mut value = record(index);
        if index < 300 {
            value["span"]["plugin_id"] = json!("example-other");
        }
        if index == 350 {
            value["span"]["generation"] = json!("g1");
        }
        if index == 351 {
            value["span"]["job_id"] = json!(SESSION);
        }
        if index == 352 {
            value["span"]["session_id"] = json!(JOB);
        }
        if index == 353 {
            value["span"]["log_id"] = json!(JOB);
        }
        if index == 354 {
            value["span"].as_object_mut().unwrap().remove("generation");
        }
        value["fields"]["message"] = json!(format!("筛选 KEYword {index}"));
        lines.push_str(&format!("{value}\n"));
    }
    fs::write(directory.path().join("deviceforge.2026-10-28.jsonl"), lines).unwrap();
    let mut request = query();
    request.log_id = Some(LOG.into());
    request.job_id = Some(JOB.into());
    request.session_id = Some(SESSION.into());
    request.q = Some("keyword".into());
    request.limit = 20;
    let first = metrics.search_debugger_logs(request.clone()).await.unwrap();
    assert_eq!(first.entries.len(), 20);
    assert!(first.coverage.missing_association_records > 0);
    assert!(
        first
            .entries
            .iter()
            .all(|entry| entry.generation.as_deref() == Some("g2"))
    );
    request.cursor = first.next_cursor;
    for key in ["generation", "order", "q", "plugin_id"] {
        let mut wrong = request.clone();
        match key {
            "generation" => wrong.generation = None,
            "order" => wrong.order = LogOrder::Asc,
            "q" => wrong.q = Some("changed".into()),
            _ => wrong.plugin_id = "example-other".into(),
        }
        assert_eq!(
            metrics
                .search_debugger_logs(wrong)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
    let mut all = first.entries;
    loop {
        let page = metrics.search_debugger_logs(request.clone()).await.unwrap();
        all.extend(page.entries);
        request.cursor = page.next_cursor;
        if request.cursor.is_none() {
            break;
        }
    }
    assert_eq!(all.len(), 55);
    assert!(all.iter().all(|entry| {
        !(350..=354).any(|index| entry.event.message.ends_with(&format!(" {index}")))
    }));
}

#[tokio::test]
async fn debugger_snapshot_ignores_appends_and_reports_rotation_truncation_or_replacement_gap() {
    for mutation in ["append", "remove", "truncate", "replace"] {
        let directory = tempfile::tempdir().unwrap();
        let runtime = runtime(directory.path());
        let metrics = runtime.metrics();
        let path = directory.path().join("deviceforge.2026-10-28.jsonl");
        let lines = (0..250)
            .map(|index| format!("{}\n", record(index)))
            .collect::<String>();
        fs::write(&path, &lines).unwrap();
        let first = metrics.search_debugger_logs(query()).await.unwrap();
        let mut request = query();
        request.cursor = first.next_cursor;
        match mutation {
            "append" => {
                use std::io::Write;
                let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
                writeln!(file, "{}", record(399)).unwrap();
            }
            "remove" => fs::remove_file(&path).unwrap(),
            "truncate" => fs::write(&path, format!("{}\n", record(0))).unwrap(),
            _ => {
                fs::rename(&path, directory.path().join("archived.log")).unwrap();
                fs::write(&path, &lines).unwrap();
            }
        }
        let page = metrics.search_debugger_logs(request).await.unwrap();
        if mutation == "append" {
            assert!(!page.coverage.gap);
            assert_eq!(page.entries.len(), 100);
            assert_eq!(page.entries[0].event.message, "请求记录 149");
        } else {
            assert!(page.coverage.gap);
            assert!(page.limited);
            assert!(page.next_cursor.is_none());
        }
    }
}

#[tokio::test]
async fn debugger_equal_timestamp_pages_use_file_identity_and_offset_without_duplicates() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = runtime(directory.path());
    let metrics = runtime.metrics();
    for suffix in ["a", "b"] {
        let lines = (0..130)
            .map(|index| {
                let mut value = record(1);
                value["fields"]["message"] = json!(format!("{suffix}-{index}"));
                format!("{value}\n")
            })
            .collect::<String>();
        fs::write(
            directory.path().join(format!("deviceforge.{suffix}.jsonl")),
            lines,
        )
        .unwrap();
    }
    let mut request = query();
    let mut all = BTreeSet::new();
    loop {
        let page = metrics.search_debugger_logs(request.clone()).await.unwrap();
        for entry in page.entries {
            assert!(all.insert(entry.event.message));
        }
        request.cursor = page.next_cursor;
        if request.cursor.is_none() {
            break;
        }
    }
    assert_eq!(all.len(), 260);
}

#[tokio::test]
async fn debugger_query_shares_original_two_slots_and_rejects_invalid_or_expired_cursors() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = runtime(directory.path());
    let metrics = runtime.metrics();
    let hold = metrics
        .search
        .slots
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    assert_eq!(
        metrics
            .search_debugger_logs(query())
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(
        metrics.search(LOG).await.unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(hold);
    let mut invalid_query = query();
    invalid_query.limit = 101;
    assert_eq!(
        metrics
            .search_debugger_logs(invalid_query)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    let mut expired = query();
    expired.cursor = Some(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        metrics
            .search_debugger_logs(expired)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
    metrics.search_debugger_logs(query()).await.unwrap();
    assert_eq!(metrics.search.slots.available_permits(), 2);
}

#[test]
fn debugger_absolute_deadline_and_oversized_line_report_coverage_without_false_next_page() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("deviceforge.a.jsonl"),
        format!("{}\n{}\n{}", "x".repeat(9000), record(0), "{partial"),
    )
    .unwrap();
    let snapshot = scan::snapshot(
        directory.path(),
        query().filter().unwrap(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    let (page, next) = scan::page(directory.path(), snapshot.clone(), 100, Instant::now()).unwrap();
    assert!(page.coverage.incomplete_scan);
    assert!(next.is_none());
    let (page, _) = scan::page(
        directory.path(),
        snapshot,
        100,
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(page.coverage.invalid_records >= 2);
    assert!(page.limited);
}
