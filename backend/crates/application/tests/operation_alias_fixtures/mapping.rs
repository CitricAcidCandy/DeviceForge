//! 真实目标输入、显式包装结果与单份旧任务历史，不重新提交目标任务。
use super::{config::*, support::*};
use apk_domain::{Executor, JobStatus};
use serde_json::{Value, json};

#[tokio::test]
async fn real_v2_v3_alias_keeps_one_job_old_input_and_exact_target_envelope() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, config()).await;
        let before = fixture.app.list(100).unwrap().len();
        let old = old_input("single-job", Some("same"), "normal");
        let job = fixture
            .app
            .submit_async(WRITE.into(), old.clone())
            .await
            .unwrap();
        let terminal = settled(&fixture.app, &job.id).await;
        assert_eq!(terminal.status, JobStatus::Succeeded);
        assert_eq!(terminal.id, job.id);
        assert_eq!(terminal.operation, WRITE);
        assert_eq!(terminal.input, old);
        let envelope = json!({"device_id":"same","input":{"label":"single-job","mode":"normal","payload":{"value":7}}});
        assert_eq!(
            fixture.event("single-job", "ready").await["input"],
            envelope
        );
        assert_eq!(
            terminal.result,
            Some(json!({"operation":"write","received":envelope,"result":{"literal":"业务字段"}}))
        );
        let jobs = fixture.app.list(100).unwrap();
        assert_eq!(jobs.len(), before + 1, "不能另建一份目标任务");
        assert_eq!(jobs.iter().filter(|item| item.id == job.id).count(), 1);
        assert!(
            !jobs
                .iter()
                .any(|item| item.operation == "plugin.aliasprobe.write")
        );
        let events = fixture.app.events(&job.id, 0).unwrap();
        assert!(events.iter().all(|event| event.job_id == job.id));
        assert_eq!(
            events
                .iter()
                .map(|event| event.status.clone())
                .collect::<Vec<_>>(),
            vec![JobStatus::Queued, JobStatus::Running, JobStatus::Succeeded]
        );
        fixture.exited("single-job").await;
        assert!(!fixture.plugin().has_unresolved_resources());
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn real_object_mapping_preserves_old_input_null_and_business_result_field() {
    let mut alias = binding(WRITE, "write", true);
    alias["result"] = json!({"kind":"object","wrapped":true,"fields":[
        {"name":"old_label","source":{"kind":"input","pointer":"/label"}},
        {"name":"target_label","source":{"kind":"value","pointer":"/received/input/label"}},
        {"name":"business_result","source":{"kind":"value","pointer":"/result"}},
        {"name":"nullable","source":{"kind":"input","pointer":"/nullable"}},
        {"name":"absent","source":{"kind":"value","pointer":"/missing"},"optional":true}
    ]});
    let fixture = Fixture::new(3, config_from(vec![alias])).await;
    let mut input = old_input("mapped-result", Some("same"), "normal");
    input["nullable"] = Value::Null;
    let job = fixture
        .app
        .submit_async(WRITE.into(), input.clone())
        .await
        .unwrap();
    let terminal = settled(&fixture.app, &job.id).await;
    assert_eq!(terminal.status, JobStatus::Succeeded);
    assert_eq!(terminal.input, input);
    assert_eq!(
        terminal.result,
        Some(
            json!({"old_label":"mapped-result","target_label":"mapped-result",
        "business_result":{"literal":"业务字段"},"nullable":null})
        )
    );
    fixture.exited("mapped-result").await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn provider_envelope_accepts_omitted_or_null_id_but_rejects_non_null_and_bad_target_input() {
    let mut write = binding(WRITE, "write", true);
    // 旧模式允许缺少 label；目标真实模式仍必须校验转换后的输入。
    write["operation"]["input_schema"]["required"] = json!(["device_id"]);
    let fixture = Fixture::new(
        3,
        config_from(vec![write, binding(GLOBAL, "global", false)]),
    )
    .await;
    let before = fixture.app.list(100).unwrap().len();
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(WRITE.into(), json!({"device_id":"same"}))
                .await
        ),
        "invalid_input"
    );
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(
                    GLOBAL.into(),
                    old_input("invalid-global", Some("same"), "normal")
                )
                .await
        ),
        "invalid_input"
    );
    assert_eq!(fixture.app.list(100).unwrap().len(), before);
    assert!(fixture.recorded("invalid-global", "started").is_none());
    for (label, explicit_null) in [("global-omitted", false), ("global-null", true)] {
        let mut input = old_input(label, None, "normal");
        if explicit_null {
            input["device_id"] = Value::Null;
        }
        let job = fixture
            .app
            .submit_async(GLOBAL.into(), input.clone())
            .await
            .unwrap();
        let terminal = settled(&fixture.app, &job.id).await;
        assert_eq!(terminal.status, JobStatus::Succeeded);
        assert_eq!(terminal.input, input);
        let request = fixture.event(label, "ready").await;
        assert_eq!(request["input"]["device_id"], Value::Null);
        assert!(request["input"]["input"].get("device_id").is_none());
        fixture.exited(label).await;
    }
    fixture.shutdown().await;
}
