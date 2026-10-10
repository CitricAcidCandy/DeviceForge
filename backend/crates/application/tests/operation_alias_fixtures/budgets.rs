//! 纯任务的绝对期限与真实 Node 跨旧六十秒门闩分别验证，不真实等待长期限。
use super::{budget_port::BudgetFixture, config::*, support::*};
use apk_application::Application;
use apk_domain::{Job, JobStatus};
use serde_json::json;
use std::time::Duration;

fn terminal(app: &Application, id: &str) -> Option<Job> {
    let job = app.get(id).unwrap();
    job.status.is_terminal().then_some(job)
}
fn timed_out(job: &Job) {
    assert_eq!(job.status, JobStatus::Failed);
    assert_eq!(job.error.as_deref(), Some("执行超时"));
}

async fn wake_deadline_timer(deadline: tokio::time::Instant) {
    assert_eq!(tokio::time::Instant::now(), deadline);
    // 原截止点不变；只给毫秒粒度定时器一个明确刻度用于终态观察唤醒。
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(
        tokio::time::Instant::now(),
        deadline + Duration::from_millis(1)
    );
}

#[tokio::test]
async fn alias_uses_api_one_two_default_thirty_and_explicit_v2_120_across_sixty() {
    for (api, budget, seconds, before_expiry) in [
        (1, None, 30, 29),
        (2, None, 30, 29),
        (2, Some(120000), 120, 61),
    ] {
        let fixture = BudgetFixture::new(api, budget).await;
        tokio::time::pause();
        let admitted = tokio::time::Instant::now();
        let original = old_input("budget", None, "hold");
        let job = fixture.app.submit(GLOBAL, original.clone()).unwrap();
        paused_until("目标收到绝对期限", || {
            (fixture.probe.calls().len() == 1).then_some(())
        })
        .await;
        let call = fixture.probe.calls().remove(0);
        assert_eq!(call.operation, "plugin.aliasprobe.global");
        assert_eq!(call.input, json!({"device_id":null,"input":original}));
        assert_eq!(call.started_at, admitted);
        assert_eq!(call.deadline, admitted + Duration::from_secs(seconds));
        tokio::time::advance(Duration::from_secs(before_expiry)).await;
        assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
        assert_eq!(
            tokio::time::Instant::now(),
            admitted + Duration::from_secs(before_expiry)
        );
        tokio::time::advance(Duration::from_secs(seconds - before_expiry)).await;
        wake_deadline_timer(call.deadline).await;
        let completed = paused_until("原截止点终态", || terminal(&fixture.app, &job.id)).await;
        timed_out(&completed);
        assert_eq!(completed.operation, GLOBAL);
        assert_eq!(completed.input, original);
        assert_eq!(fixture.app.list(10).unwrap().len(), 1);
        assert_eq!(fixture.probe.calls().len(), 1);
        tokio::time::resume();
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn worker_queue_consumes_alias_budget_without_restarting_target_deadline() {
    let fixture = BudgetFixture::new(2, None).await;
    tokio::time::pause();
    let blocker = fixture
        .app
        .submit("plugin.aliasprobe.block", json!({}))
        .unwrap();
    paused_until("工作槽已占用", || {
        fixture.probe.blocking().then_some(())
    })
    .await;
    let admitted = tokio::time::Instant::now();
    let job = fixture
        .app
        .submit(GLOBAL, old_input("queued-budget", None, "hold"))
        .unwrap();
    tokio::time::advance(Duration::from_secs(20)).await;
    assert!(fixture.probe.calls().is_empty());
    fixture.probe.release.add_permits(1);
    paused_until("排队后的目标执行", || {
        (fixture.probe.calls().len() == 1).then_some(())
    })
    .await;
    let call = fixture.probe.calls().remove(0);
    assert_eq!(call.deadline, admitted + Duration::from_secs(30));
    assert_eq!(call.started_at, admitted + Duration::from_secs(20));
    assert_eq!(
        call.deadline.duration_since(call.started_at),
        Duration::from_secs(10)
    );
    tokio::time::advance(Duration::from_secs(10)).await;
    wake_deadline_timer(call.deadline).await;
    timed_out(
        &paused_until("排队扣时后的终态", || {
            terminal(&fixture.app, &job.id)
        })
        .await,
    );
    assert_eq!(
        paused_until("工作槽对照终态", || terminal(
            &fixture.app,
            &blocker.id
        ))
        .await
        .status,
        JobStatus::Succeeded
    );
    tokio::time::resume();
    fixture.shutdown().await;
}

#[tokio::test]
async fn alias_expired_in_worker_queue_never_calls_target_even_after_slot_release() {
    let fixture = BudgetFixture::new(2, None).await;
    tokio::time::pause();
    let blocker = fixture
        .app
        .submit("plugin.aliasprobe.block", json!({}))
        .unwrap();
    paused_until("过期测试工作槽已占用", || {
        fixture.probe.blocking().then_some(())
    })
    .await;
    let admitted = tokio::time::Instant::now();
    let job = fixture
        .app
        .submit(GLOBAL, old_input("zero-execution", None, "hold"))
        .unwrap();
    tokio::time::advance(Duration::from_secs(30)).await;
    wake_deadline_timer(admitted + Duration::from_secs(30)).await;
    timed_out(&paused_until("未执行任务过期", || terminal(&fixture.app, &job.id)).await);
    assert!(fixture.probe.calls().is_empty());
    fixture.probe.release.add_permits(1);
    paused_until("释放槽的对照任务终态", || {
        terminal(&fixture.app, &blocker.id)
    })
    .await;
    assert!(fixture.probe.calls().is_empty(), "过期别名不能晚到执行");
    assert_eq!(fixture.app.list(10).unwrap().len(), 2);
    tokio::time::resume();
    fixture.shutdown().await;
}

#[tokio::test]
async fn alias_provider_barrier_wait_keeps_second_job_original_absolute_deadline() {
    let fixture = BudgetFixture::new(2, None).await;
    tokio::time::pause();
    let first = fixture
        .app
        .submit(GLOBAL, old_input("barrier-holder", None, "hold"))
        .unwrap();
    paused_until("提供者写屏障持有者", || {
        (fixture.probe.calls().len() == 1).then_some(())
    })
    .await;
    tokio::time::advance(Duration::from_secs(5)).await;
    let admitted = tokio::time::Instant::now();
    let second = fixture
        .app
        .submit(GLOBAL, old_input("barrier-waiter", None, "hold"))
        .unwrap();
    tokio::time::advance(Duration::from_secs(20)).await;
    assert_eq!(fixture.probe.calls().len(), 1);
    fixture.app.cancel(&first.id).unwrap();
    paused_until("屏障释放后的第二目标", || {
        (fixture.probe.calls().len() == 2).then_some(())
    })
    .await;
    let second_call = fixture.probe.calls().remove(1);
    assert_eq!(second_call.input["input"]["label"], "barrier-waiter");
    assert_eq!(second_call.deadline, admitted + Duration::from_secs(30));
    assert_eq!(second_call.started_at, admitted + Duration::from_secs(20));
    tokio::time::advance(Duration::from_secs(10)).await;
    wake_deadline_timer(second_call.deadline).await;
    timed_out(
        &paused_until("屏障扣时后的终态", || {
            terminal(&fixture.app, &second.id)
        })
        .await,
    );
    assert_eq!(
        fixture.app.get(&first.id).unwrap().status,
        JobStatus::Cancelled
    );
    tokio::time::resume();
    fixture.shutdown().await;
}

#[tokio::test]
async fn real_v2_v3_alias_process_survives_61_host_seconds_then_exits_after_release_file() {
    for protocol in [2, 3] {
        let fixture = Fixture::with_timeout(protocol, config(), Some(120000)).await;
        tokio::time::pause();
        let admitted = tokio::time::Instant::now();
        let job = fixture
            .app
            .submit(WRITE, old_input("long-real", Some("same"), "hold"))
            .unwrap();
        let ready = paused_until("真实别名目标进程就绪", || {
            assert!(
                !fixture.app.get(&job.id).unwrap().status.is_terminal(),
                "真实目标未就绪就结束"
            );
            fixture.recorded("long-real", "ready")
        })
        .await;
        assert!(alive(pid(&ready)));
        tokio::time::advance(Duration::from_secs(61)).await;
        assert_eq!(
            tokio::time::Instant::now(),
            admitted + Duration::from_secs(61)
        );
        // 不等待任何虚拟计时器；反复让出执行权使旧六十秒传输期限有机会暴露。
        for _ in 0..1000 {
            assert_eq!(fixture.app.get(&job.id).unwrap().status, JobStatus::Running);
            assert_eq!(
                tokio::time::Instant::now(),
                admitted + Duration::from_secs(61)
            );
            tokio::task::yield_now().await;
        }
        assert!(alive(pid(&ready)));
        assert!(fixture.recorded("long-real", "response_written").is_none());
        fixture.release("long-real");
        let completed = paused_until("真实目标响应与共享任务终态", || {
            terminal(&fixture.app, &job.id)
        })
        .await;
        assert_eq!(completed.status, JobStatus::Succeeded);
        let exited = paused_until("真实目标自然退出标记", || {
            fixture.recorded("long-real", "process_exit")
        })
        .await;
        assert_eq!(exited["code"], 0);
        assert_eq!(exited["pid"], ready["pid"]);
        tokio::time::resume();
        fixture.exited("long-real").await;
        fixture.shutdown().await;
    }
}
