//! 受控慢副本与发布必须消耗同一绝对预算，不得每阶段重新给期限。

use super::{
    liveness,
    support::{Fixture, OPERATION, context, finish, pid, until, until_paused},
    transport::confirmed_interruption,
};
use apk_domain::{Error, Executor};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn slow_copy_times_out_before_process_start_in_both_protocols() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, true, false).await;
        let deadline = Instant::now() + Duration::from_secs(3);
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("hold"),
            CancellationToken::new(),
            context(deadline),
        );
        tokio::pin!(call);
        until(call.as_mut(), fixture.store.copying.entered()).await;
        let result = finish(call.as_mut(), deadline).await;
        assert!(
            matches!(result, Err(Error::Timeout)),
            "副本流耗尽总预算：{result:?}"
        );
        fixture.assert_not_started();
        assert!(fixture.store.reads() > 0);
        assert_eq!(fixture.store.copying.completions(), 0);
        assert_eq!(fixture.store.committed(), 0);
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}

#[tokio::test]
async fn cancellation_during_copy_does_not_start_process_or_publish() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, true, false).await;
        let deadline = Instant::now() + Duration::from_secs(15);
        let cancel = CancellationToken::new();
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("hold"),
            cancel.clone(),
            context(deadline),
        );
        tokio::pin!(call);
        until(call.as_mut(), fixture.store.copying.entered()).await;
        cancel.cancel();
        let result = finish(call.as_mut(), Instant::now()).await;
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "副本流取消：{result:?}"
        );
        fixture.assert_not_started();
        assert_eq!(fixture.store.copying.completions(), 0);
        assert_eq!(fixture.store.committed(), 0);
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}

#[tokio::test]
async fn transport_receives_only_budget_remaining_after_slow_copy() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, true, false).await;
        tokio::time::pause();
        let admitted_at = tokio::time::Instant::now();
        let deadline = admitted_at + Duration::from_secs(6);
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("hold"),
            CancellationToken::new(),
            context(deadline.into_std()),
        );
        tokio::pin!(call);
        until_paused(
            call.as_mut(),
            fixture.store.copying.entered(),
            "副本首块门闩",
        )
        .await;
        // 四秒只由显式推进消耗；真实文件/Node 调度不再争抢余下两秒。
        tokio::time::advance(Duration::from_secs(4)).await;
        assert_eq!(
            tokio::time::Instant::now(),
            admitted_at + Duration::from_secs(4)
        );
        fixture.store.copying.release();
        let ready = until_paused(
            call.as_mut(),
            fixture.event_without_timer("ready"),
            "真实进程就绪",
        )
        .await;
        assert!(liveness::alive(pid(&ready)), "就绪标记须对应真实运行进程");
        assert_eq!(fixture.store.copying.completions(), 1);
        assert_eq!(
            deadline.duration_since(tokio::time::Instant::now()),
            Duration::from_secs(2)
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(tokio::time::Instant::now(), deadline);
        // 回到真实时钟完成合作清理；不在暂停状态自动跳过生产清理宽限。
        tokio::time::resume();
        let result = finish(call.as_mut(), deadline.into_std()).await;
        assert!(
            matches!(result, Err(Error::Timeout)),
            "传输不得重启六秒预算：{result:?}"
        );
        confirmed_interruption(&fixture, &ready, "timeout").await;
    }
}

#[tokio::test]
async fn slow_copy_process_and_blocked_publication_share_one_deadline() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, true, true).await;
        tokio::time::pause();
        let admitted_at = tokio::time::Instant::now();
        let deadline = admitted_at + Duration::from_secs(6);
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("copy"),
            CancellationToken::new(),
            context(deadline.into_std()),
        );
        tokio::pin!(call);
        until_paused(
            call.as_mut(),
            fixture.store.copying.entered(),
            "副本首块门闩",
        )
        .await;
        tokio::time::advance(Duration::from_secs(4)).await;
        assert_eq!(
            tokio::time::Instant::now(),
            admitted_at + Duration::from_secs(4)
        );
        fixture.store.copying.release();
        until_paused(
            call.as_mut(),
            fixture.store.publishing.entered(),
            "进程退出后的发布门闩",
        )
        .await;
        let ready = until_paused(
            call.as_mut(),
            fixture.event_without_timer("ready"),
            "发布阶段的进程就绪证据",
        )
        .await;
        assert!(
            !liveness::alive(pid(&ready)),
            "进入发布前真实进程应完成零退出"
        );
        let exited = until_paused(
            call.as_mut(),
            fixture.event_without_timer("process_exit"),
            "真实进程自然退出证据",
        )
        .await;
        assert_eq!(exited["code"], 0);
        assert_eq!(fixture.store.copying.completions(), 1);
        assert_eq!(
            deadline.duration_since(tokio::time::Instant::now()),
            Duration::from_secs(2)
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(tokio::time::Instant::now(), deadline);
        tokio::time::resume();
        let result = finish(call.as_mut(), deadline.into_std()).await;
        assert!(
            matches!(result, Err(Error::Timeout)),
            "发布不得得到新的完整预算：{result:?}"
        );
        assert_eq!(fixture.store.publishing.completions(), 0);
        assert_eq!(fixture.store.committed(), 0);
        fixture.assert_cleaned(&ready).await;
        assert!(
            !fixture.plugin.has_unresolved_resources(),
            "进程已确认退出，发布超时不应伪造未确认资源"
        );
    }
}

#[tokio::test]
async fn cancellation_during_publication_keeps_source_and_cleans_call_files() {
    for protocol in [2, 3] {
        let fixture = Fixture::new(protocol, false, true).await;
        let deadline = Instant::now() + Duration::from_secs(15);
        let cancel = CancellationToken::new();
        let call = fixture.plugin.execute_with_context(
            OPERATION,
            fixture.input("copy"),
            cancel.clone(),
            context(deadline),
        );
        tokio::pin!(call);
        until(call.as_mut(), fixture.store.publishing.entered()).await;
        let ready = fixture.event("ready").await;
        assert!(!liveness::alive(pid(&ready)));
        cancel.cancel();
        let result = finish(call.as_mut(), Instant::now()).await;
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "发布取消必须保留精确错误：{result:?}"
        );
        assert_eq!(fixture.store.publishing.completions(), 0);
        assert_eq!(fixture.store.committed(), 0);
        fixture.assert_cleaned(&ready).await;
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}
