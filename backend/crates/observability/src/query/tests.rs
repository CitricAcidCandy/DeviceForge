use super::*;
use serde_json::json;

const ID: &str = "d3be1c0c-eee8-43a6-9f47-f963ddbfc725";
const JOB: &str = "31a501f3-ab38-4f84-8c70-d74bf6c86520";

fn record(id: &str, time: &str) -> Value {
    json!({"timestamp":time,"level":"INFO","fields":{"message":"请求开始","body":"不得返回的请求体","token":"不得返回的令牌"},
        "span":{"log_id":id,"job_id":JOB,"operation":"app.start","method":"GET","route":"/api/v2/jobs/{id}","private_path":"不得返回的路径"}})
}

#[test]
fn exact_id_finds_nested_context_and_returns_only_diagnostic_fields() {
    let dir = tempfile::tempdir().unwrap();
    let lines = [
        record(ID, "2026-10-27T02:00:00Z"),
        record("other", "2026-10-27T01:00:00Z"),
    ]
    .map(|v| v.to_string())
    .join("\n")
        + "\n";
    fs::write(dir.path().join("deviceforge.2026-10-27.jsonl"), lines).unwrap();
    let found = scan(
        dir.path().to_owned(),
        ID.into(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(found.entries.len(), 1);
    assert_eq!(found.entries[0].message, "请求开始");
    assert_eq!(found.job_ids, [JOB]);
    let public = serde_json::to_string(&found).unwrap();
    assert!(!public.contains("不得返回"));
    assert!(!public.contains("private_path"));
}

#[test]
fn unrelated_text_mentions_do_not_match_and_partial_lines_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("deviceforge.2026-10-27.jsonl"),
        format!(
            "{}\n{{\"log_id\":\"{ID}",
            json!({"fields":{"message":ID},"span":{"log_id":"other"}})
        ),
    )
    .unwrap();
    let found = scan(
        dir.path().to_owned(),
        ID.into(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert!(found.entries.is_empty());
}

#[test]
fn oversized_records_and_unrelated_files_cannot_expand_output() {
    let dir = tempfile::tempdir().unwrap();
    let mut lines = format!("{}\n", "x".repeat(20_000));
    for index in 0..110 {
        lines.push_str(&format!("{}\n", record(ID, &index.to_string())));
    }
    fs::write(dir.path().join("deviceforge.2026-10-27.jsonl"), lines).unwrap();
    fs::write(
        dir.path().join("private.jsonl"),
        format!("{}\n", record(ID, "private")),
    )
    .unwrap();
    let found = scan(
        dir.path().to_owned(),
        ID.into(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(found.entries.len(), 100);
    assert!(found.limited);
    assert_eq!(found.job_ids, [JOB]);
}

#[tokio::test]
async fn invalid_ids_and_capacity_fail_before_io_and_release_after_queries() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = crate::LogRuntime::open(crate::LogConfig {
        directory: dir.path().to_owned(),
        queue_capacity: 8,
        retained_files: 2,
        level: tracing::level_filters::LevelFilter::INFO,
    })
    .unwrap();
    let metrics = runtime.metrics();
    assert_eq!(
        metrics.search("../private").await.unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    let hold = metrics
        .search
        .slots
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    assert_eq!(
        metrics.search(ID).await.unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(hold);
    assert!(metrics.search(ID).await.unwrap().entries.is_empty());
    assert_eq!(metrics.search.slots.available_permits(), 2);
}

#[test]
fn exhausted_deadline_returns_limited_instead_of_unbounded_scan() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("deviceforge.2026-10-27.jsonl"),
        format!("{}\n", record(ID, "now")),
    )
    .unwrap();
    let found = scan(dir.path().to_owned(), ID.into(), Instant::now()).unwrap();
    assert!(found.limited);
    assert!(found.entries.is_empty());
}

#[test]
fn newest_records_are_selected_before_the_result_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut lines = String::new();
    for index in 0..350 {
        let id = if index < 200 { JOB } else { ID };
        let mut value = record(
            id,
            &format!("2026-10-27T10:{:02}:{:02}Z", index / 60, index % 60),
        );
        value["fields"]["message"] = json!(format!("请求记录 {index}"));
        lines.push_str(&format!("{value}\n"));
    }
    fs::write(dir.path().join("deviceforge.2026-10-27.jsonl"), lines).unwrap();
    let found = scan(
        dir.path().to_owned(),
        ID.into(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(found.entries.len(), 100);
    assert_eq!(found.entries[0].message, "请求记录 349");
    assert_eq!(found.entries[99].message, "请求记录 250");
    assert!(found.limited);
}

#[test]
fn keyword_search_matches_retained_server_fields_before_truncating() {
    let dir = tempfile::tempdir().unwrap();
    let mut lines = String::new();
    for index in 0..350 {
        let mut value = record(
            ID,
            &format!("2026-10-27T10:{:02}:{:02}Z", index / 60, index % 60),
        );
        value["span"]["operation"] = json!(if index < 200 {
            "other.run"
        } else {
            "android.APP.START"
        });
        value["fields"]["message"] = json!(format!("保留日志 {index}"));
        lines.push_str(&format!("{value}\n"));
    }
    fs::write(dir.path().join("deviceforge.2026-10-27.jsonl"), lines).unwrap();
    for (order, first, last) in [(LogOrder::Desc, 349, 250), (LogOrder::Asc, 200, 299)] {
        let found = scan_filtered(
            dir.path().to_owned(),
            Filter::Text("app.start".into()),
            order,
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(found.log_id, None);
        assert_eq!(found.entries.len(), 100);
        assert_eq!(found.entries[0].message, format!("保留日志 {first}"));
        assert_eq!(found.entries[99].message, format!("保留日志 {last}"));
        assert_eq!(found.entries[0].log_id.as_deref(), Some(ID));
        assert!(found.limited);
    }
    let private = scan_filtered(
        dir.path().to_owned(),
        Filter::Text("不得返回".into()),
        LogOrder::Desc,
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert!(private.entries.is_empty());
}

#[test]
fn chronological_order_handles_fractions_and_timezones() {
    let dir = tempfile::tempdir().unwrap();
    let lines = [
        "2026-10-27T10:00:00Z",
        "2026-10-27T10:00:00.1Z",
        "2026-10-27T18:00:01+08:00",
    ]
    .map(|time| record(ID, time).to_string())
    .join("\n")
        + "\n";
    fs::write(dir.path().join("deviceforge.2026-10-27.jsonl"), lines).unwrap();
    let found = scan(
        dir.path().to_owned(),
        ID.into(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(found.entries[0].timestamp, "2026-10-27T18:00:01+08:00");
    assert_eq!(found.entries[1].timestamp, "2026-10-27T10:00:00.1Z");
    assert_eq!(found.entries[2].timestamp, "2026-10-27T10:00:00Z");
}

#[tokio::test]
async fn text_query_rejects_empty_oversized_and_conflicting_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = crate::LogRuntime::open(crate::LogConfig {
        directory: dir.path().to_owned(),
        queue_capacity: 8,
        retained_files: 2,
        level: tracing::level_filters::LevelFilter::INFO,
    })
    .unwrap();
    let metrics = runtime.metrics();
    for query in ["", "  ", "包含\n换行", &"界".repeat(43)] {
        assert_eq!(
            metrics
                .search_logs(None, Some(query), LogOrder::Desc)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
    assert_eq!(
        metrics
            .search_logs(Some(ID), Some("app.start"), LogOrder::Desc)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(
        metrics
            .search_logs(None, Some("app.start"), LogOrder::Asc)
            .await
            .unwrap()
            .entries
            .is_empty()
    );
}
