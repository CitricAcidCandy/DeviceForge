//! 会话准入与异步句柄端口；应用持有监督 Future，适配器拥有实际资源。
use super::{SessionChunk, SessionDefinition, SessionExit, SessionRequest, SessionResult};
use crate::Result;
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// 输入句柄可独立共享，接收端等待输出时不会占用输入侧借用。
#[async_trait]
pub trait SessionInput: Send + Sync {
    /// 有界背压仅确认输入准入；先预留容量再复制，不证明插件已消费。
    /// 等待期间取消或到期须返回错误，尚未准入的输入不产生副作用。
    async fn send(&self, bytes: &[u8]) -> SessionResult<()>;

    /// 与 send 共享准入顺序；只关闭协议输入，仍保留取消控制传输。
    /// 空 send 不是 EOF；EOF 后的输入和重复 EOF 均须返回错误。
    async fn eof(&self) -> SessionResult<()>;

    /// 同步、幂等地撤销新输入，并通知独立控制通路，不等待数据队列。
    /// 在途半帧须完整收口或判定传输失败，不能在半帧中插入取消帧。
    fn cancel(&self);
}

#[async_trait]
/// 接收句柄 Drop 须请求取消且撤销所有输入克隆，不得 abort 后台监督。
/// 实际 owner、租约和粘性未确认标记由已登记的监督继续持有。
pub trait InteractiveSession: Send + Sync {
    fn input(&self) -> Arc<dyn SessionInput>;

    /// 等待 Ready/Start 握手完成并缓存成功或失败；重复调用返回同一结论。
    /// 丢弃等待 Future 不取消后台监督或重新计时。
    async fn ready(&self) -> SessionResult<()>;

    /// 取消安全：丢弃尚未完成的接收不丢失队列中输出。
    /// None 仅表示输出结束；资源终态必须通过 wait 取得。
    async fn recv(&mut self) -> Option<SessionChunk>;

    /// 排空并丢弃未读输出，等待真实监督结论，避免无消费者导致死锁。
    /// 等待 Future 可被丢弃后重等；终态缓存后重复返回同一共享记录。
    async fn wait(&mut self) -> Arc<SessionExit>;
}

/// 构造本身没有进程或文件副作用；应用在原子准入时登记监督，锁外运行。
pub struct SessionLaunch {
    pub handle: Box<dyn InteractiveSession>,
    pub supervisor: BoxFuture<'static, ()>,
}

pub trait SessionProvider: Send + Sync {
    fn definitions(&self) -> Vec<SessionDefinition>;

    /// 纯同步构造；取消 token 是合作业务撤销，不能直接用作进程强制终止。
    fn open(&self, request: SessionRequest, cancel: CancellationToken) -> Result<SessionLaunch>;

    /// 未确认资源必须粘性保留；后续成功不能清除先前未确认结论。
    fn has_unresolved_resources(&self) -> bool {
        false
    }
}
