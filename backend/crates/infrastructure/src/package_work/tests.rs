use super::{PackageCapacity, State};
use crate::package_tools::worker::Pool;
use apk_domain::{Error, Result};
use deviceforge_android_package_core::Control;
use std::{
    path::PathBuf,
    sync::{
        Arc, Barrier, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;

const WATCHDOG: Duration = Duration::from_secs(5);

/// 通道决定闭包启动和释放顺序；看门狗只防测试挂死，不用于推测竞争。
struct Gate {
    started: Option<oneshot::Receiver<()>>,
    release: Option<mpsc::Sender<()>>,
    lease: Weak<tempfile::TempDir>,
    directory: PathBuf,
}

impl Gate {
    async fn ready(&mut self) {
        tokio::time::timeout(WATCHDOG, self.started.take().expect("启动通知只能读取一次"))
            .await
            .expect("真实阻塞闭包未发出启动通知")
            .expect("阻塞闭包在通知前结束");
    }

    fn release(&mut self) {
        self.release
            .take()
            .expect("工作只能释放一次")
            .send(())
            .expect("真实阻塞闭包必须仍在等待释放");
    }
}

fn gated_work(
    value: usize,
) -> (
    Gate,
    impl FnOnce(&Control<'_>) -> Result<usize> + Send + 'static,
) {
    let (started, ready) = oneshot::channel();
    let (release, waiting) = mpsc::channel();
    let lease = Arc::new(tempfile::tempdir().expect("创建测试专属目录"));
    let gate = Gate {
        started: Some(ready),
        release: Some(release),
        lease: Arc::downgrade(&lease),
        directory: lease.path().to_owned(),
    };
    let work = move |_: &Control<'_>| {
        let _lease = lease;
        started.send(()).expect("启动通知接收者应仍存在");
        // 断言失败时测试端释放 sender，也能令闭包退出，不遗留阻塞线程。
        let _ = waiting.recv();
        Ok(value)
    };
    (gate, work)
}

#[tokio::test]
async fn distinct_owner_pools_share_exactly_four_real_worker_slots() {
    let capacity = PackageCapacity::default();
    let first_owner = Pool::new(capacity.clone());
    let second_owner = Pool::new(capacity.clone());
    assert_eq!(capacity.slots.available_permits(), 4);
    let mut gates = Vec::new();
    let mut workers = Vec::new();
    for index in 0..4 {
        let owner = if index % 2 == 0 {
            first_owner.clone()
        } else {
            second_owner.clone()
        };
        let (gate, work) = gated_work(index);
        gates.push(gate);
        workers.push(tokio::spawn(async move {
            owner.run(CancellationToken::new(), None, work).await
        }));
    }
    for gate in &mut gates {
        gate.ready().await;
    }
    assert_eq!(capacity.slots.available_permits(), 0);
    assert_eq!(
        capacity.registry.lock().expect("容量登记锁").states.len(),
        4
    );
    assert!(!first_owner.unresolved(), "正常等待中的工作不能误报丢弃");
    assert!(!second_owner.unresolved());

    let entered = Arc::new(AtomicBool::new(false));
    let seen = entered.clone();
    let mut fifth = Box::pin(second_owner.run(CancellationToken::new(), None, move |_| {
        seen.store(true, Ordering::SeqCst);
        Ok(4)
    }));
    assert!(futures_util::poll!(fifth.as_mut()).is_pending());
    assert!(!entered.load(Ordering::SeqCst), "第五项没有许可不得启动");
    assert_eq!(
        capacity.registry.lock().expect("容量登记锁").states.len(),
        4
    );

    gates[0].release();
    let first = tokio::time::timeout(WATCHDOG, workers.remove(0))
        .await
        .expect("首个工作未退出")
        .expect("任务异常")
        .expect("首个工作失败");
    assert_eq!(first, 0);
    assert_eq!(
        tokio::time::timeout(WATCHDOG, fifth)
            .await
            .expect("第五项取得释放的许可后未结束")
            .expect("第五项失败"),
        4
    );
    assert!(entered.load(Ordering::SeqCst));

    for gate in gates.iter_mut().skip(1) {
        gate.release();
    }
    for (index, worker) in workers.into_iter().enumerate() {
        assert_eq!(
            tokio::time::timeout(WATCHDOG, worker)
                .await
                .expect("工作未退出")
                .expect("任务异常")
                .expect("工作失败"),
            index + 1
        );
    }
    assert_eq!(capacity.slots.available_permits(), 4);
    assert!(!first_owner.unresolved());
    assert!(!second_owner.unresolved());
    capacity.close().unwrap();
    capacity.drain_until(Instant::now()).await.unwrap();
}

#[tokio::test]
async fn dropped_waiter_retains_permit_and_directory_lease_only_for_its_owner() {
    let capacity = PackageCapacity::default();
    let owner = Pool::new(capacity.clone());
    let owner_clone = owner.clone();
    let other_owner = Pool::new(capacity.clone());
    let cancel = CancellationToken::new();
    let (mut gate, work) = gated_work(1);
    let mut waiting = Box::pin(owner.run(cancel.clone(), None, work));
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    gate.ready().await;
    assert!(!owner.unresolved());
    drop(waiting);

    assert!(cancel.is_cancelled(), "Future 丢弃必须传播取消");
    assert!(owner.unresolved());
    assert!(owner_clone.unresolved(), "同一 owner 克隆应共享风险");
    assert!(!other_owner.unresolved(), "共享容量不能串联不同 owner 风险");
    assert_eq!(
        capacity.slots.available_permits(),
        3,
        "等待者丢弃不释放真实工作许可"
    );
    assert!(gate.lease.upgrade().is_some());
    assert!(gate.directory.is_dir(), "未退出闭包必须保有真实目录 lease");
    assert_eq!(
        other_owner
            .run(CancellationToken::new(), None, |_| Ok(2))
            .await
            .unwrap(),
        2
    );
    assert!(owner.unresolved(), "另一 owner 成功不能清除未结束工作");
    assert!(!other_owner.unresolved());

    capacity.close().unwrap();
    assert!(matches!(
        capacity.drain_until(Instant::now()).await,
        Err(Error::CleanupFailed)
    ));
    assert!(gate.directory.is_dir());
    gate.release();
    capacity
        .drain_until(Instant::now() + WATCHDOG)
        .await
        .unwrap();
    assert!(!owner.unresolved(), "真实闭包退出后动态排空才能确认");
    assert!(!owner_clone.unresolved());
    assert!(!other_owner.unresolved());
    assert!(gate.lease.upgrade().is_none());
    assert!(!gate.directory.exists());
    assert_eq!(capacity.slots.available_permits(), 4);
}

#[tokio::test]
async fn close_winning_after_permit_acquisition_rejects_spawn_without_running_work() {
    let capacity = PackageCapacity::default();
    let permit = capacity.slots.clone().acquire_owned().await.unwrap();
    assert_eq!(capacity.slots.available_permits(), 3);
    let state = Arc::new(Mutex::new(State::default()));
    let entered = Arc::new(AtomicBool::new(false));
    let seen = entered.clone();
    let lease = Arc::new(tempfile::tempdir().expect("创建测试专属目录"));
    let weak = Arc::downgrade(&lease);
    let directory = lease.path().to_owned();
    let work = move || {
        let _permit = permit;
        let _lease = lease;
        seen.store(true, Ordering::SeqCst);
        Ok::<_, Error>(())
    };

    // 许可已拿到，随后由另一真实线程先完成 close，精确覆盖提交前的关闭竞争。
    let barrier = Arc::new(Barrier::new(2));
    let closing_barrier = barrier.clone();
    let closing_capacity = capacity.clone();
    let (closed, confirmed) = oneshot::channel();
    let closer = std::thread::spawn(move || {
        closing_barrier.wait();
        let result = closing_capacity.close();
        closed.send(result).expect("关闭确认接收者应仍存在");
    });
    barrier.wait();
    tokio::time::timeout(WATCHDOG, confirmed)
        .await
        .expect("关闭线程未确认")
        .expect("关闭确认丢失")
        .unwrap();
    closer.join().expect("关闭线程异常");

    let rejected = capacity.spawn(&state, work);
    assert!(matches!(rejected, Err(Error::Conflict(message)) if message == "包工作容量已关闭"));
    assert!(!entered.load(Ordering::SeqCst));
    assert!(
        capacity
            .registry
            .lock()
            .expect("容量登记锁")
            .states
            .is_empty()
    );
    assert!(
        !state.lock().expect("工作状态锁").finished,
        "拒绝工作不能伪造完成登记"
    );
    assert_eq!(
        capacity.slots.available_permits(),
        4,
        "未提交闭包丢弃时归还预取许可"
    );
    assert!(weak.upgrade().is_none());
    assert!(!directory.exists());
    capacity.drain_until(Instant::now()).await.unwrap();
}

#[tokio::test]
async fn close_drain_deadline_is_bounded_and_later_real_exit_can_be_confirmed() {
    let capacity = PackageCapacity::default();
    assert!(
        matches!(capacity.drain_until(Instant::now()).await, Err(Error::Invalid(message))
        if message == "包工作排空前必须先关闭容量")
    );
    let owner = Pool::new(capacity.clone());
    let running_owner = owner.clone();
    let (mut gate, work) = gated_work(7);
    let running = tokio::spawn(async move {
        running_owner
            .run(CancellationToken::new(), None, work)
            .await
    });
    gate.ready().await;
    let state = capacity.registry.lock().expect("容量登记锁").states[0]
        .upgrade()
        .expect("运行中的工作必须保有状态");
    assert!(!state.lock().expect("工作状态锁").finished);
    assert!(!owner.unresolved());
    capacity.close().unwrap();

    // 真实阻塞闭包已由通道确认启动且仍被门闩保留；只推进排空计时器。
    tokio::time::pause();
    let deadline = Instant::now() + Duration::from_millis(250);
    let mut draining = Box::pin(capacity.drain_until(deadline));
    assert!(futures_util::poll!(draining.as_mut()).is_pending());
    tokio::time::advance(Duration::from_millis(250)).await;
    assert!(matches!(draining.await, Err(Error::CleanupFailed)));
    tokio::time::resume();
    assert!(!state.lock().expect("工作状态锁").finished);
    assert!(
        !state.lock().expect("工作状态锁").detached,
        "排空超时不等于工作等待者已丢弃"
    );
    assert!(gate.directory.is_dir());
    assert_eq!(capacity.slots.available_permits(), 3);

    let entered = Arc::new(AtomicBool::new(false));
    let seen = entered.clone();
    let rejected = owner
        .run(CancellationToken::new(), None, move |_| {
            seen.store(true, Ordering::SeqCst);
            Ok(8)
        })
        .await;
    assert!(matches!(rejected, Err(Error::Conflict(message)) if message == "包工作容量已关闭"));
    assert!(!entered.load(Ordering::SeqCst));

    gate.release();
    assert_eq!(
        tokio::time::timeout(WATCHDOG, running)
            .await
            .expect("已释放工作未退出")
            .expect("任务异常")
            .expect("工作失败"),
        7
    );
    assert!(state.lock().expect("工作状态锁").finished);
    assert!(!owner.unresolved());
    assert!(gate.lease.upgrade().is_none());
    assert!(!gate.directory.exists());
    assert_eq!(capacity.slots.available_permits(), 4);
    // 历史排空失败不锁死确认；后续真实结束后，即使给当前截止点也应成功。
    capacity.drain_until(Instant::now()).await.unwrap();
    capacity.close().unwrap();
}
