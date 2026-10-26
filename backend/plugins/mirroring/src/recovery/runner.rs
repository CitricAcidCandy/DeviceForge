//! 所有恢复命令沿用同一截止点，工具监督持有恢复租约至直接进程确认退出。
use super::{
    ledger::{Record, Stage},
    remote, store,
};
use crate::config::Config;
use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, Error, ExecutionOptions, ToolCommand, capture_with_lease,
};
use std::{fs::File, path::Path, sync::Arc};
use tokio::time::Instant;

pub(super) struct Runner<'a> {
    pub config: &'a Config,
    pub context: &'a InvocationContext,
    pub deadline: Instant,
    pub lease: Arc<File>,
    pub resource_lease: Option<Arc<File>>,
    pub unconfirmed: bool,
}

pub(super) trait RecoveryRunner {
    fn check(&self) -> Result<(), String>;
    fn unconfirmed(&self) -> bool;
    fn pin(&mut self, lease: Option<Arc<File>>);
    async fn devices(&mut self) -> Result<Vec<String>, String>;
    async fn command(&mut self, device: &str, args: Vec<String>) -> Result<Vec<u8>, String>;
}

impl<'a> Runner<'a> {
    pub fn new(config: &'a Config, context: &'a InvocationContext, lease: Arc<File>) -> Self {
        Self {
            config,
            context,
            lease,
            resource_lease: None,
            deadline: Instant::from_std(context.deadline())
                .min(Instant::now() + std::time::Duration::from_secs(30)),
            unconfirmed: false,
        }
    }

    async fn capture(&mut self, args: Vec<String>) -> Result<Vec<u8>, String> {
        self.context.check().map_err(|_| "资源核对已取消或到期")?;
        if Instant::now() >= self.deadline {
            return Err("资源核对总期限已到期".into());
        }
        let mut command = ToolCommand::new(&self.config.adb, &args);
        command.environment = Environment::Restricted;
        let mut options = ExecutionOptions::new(self.deadline);
        options.stdout_limit = 8192;
        options.stderr_limit = 8192;
        let lease = Arc::new((self.lease.clone(), self.resource_lease.clone()));
        match capture_with_lease(command, options, self.context.cancellation(), lease).await {
            Ok(output) => Ok(output.stdout),
            Err(error) => {
                if matches!(error, Error::CleanupFailed { .. }) {
                    self.unconfirmed = true;
                }
                Err(match error {
                    Error::NonZeroExit {
                        code: Some(81 | 83),
                        ..
                    } => "资源归属或进程出生身份不符，未强制清理",
                    Error::NonZeroExit { code: Some(86), .. } => {
                        "发现无台账旧资源或外部投屏占用，请确认原投屏工具已退出后重试；未强制清理"
                    }
                    Error::NonZeroExit { code: Some(82), .. } => {
                        "设备不支持完整资源审计，尚不能确认恢复"
                    }
                    Error::Timeout => "资源核对总期限已到期",
                    Error::Cancelled => "资源核对已取消",
                    Error::CleanupFailed { .. } => "本机直接进程退出未确认，保留资源阻断",
                    _ => "设备离线、授权不足或资源清理失败，请恢复连接后再次核对",
                }
                .into())
            }
        }
    }
}

impl RecoveryRunner for Runner<'_> {
    fn check(&self) -> Result<(), String> {
        self.context
            .check()
            .map_err(|_| "资源核对已取消或到期".into())
    }
    fn unconfirmed(&self) -> bool {
        self.unconfirmed
    }
    fn pin(&mut self, lease: Option<Arc<File>>) {
        self.resource_lease = lease;
    }
    async fn devices(&mut self) -> Result<Vec<String>, String> {
        online_devices(&self.capture(vec!["devices".into()]).await?)
    }
    async fn command(&mut self, device: &str, args: Vec<String>) -> Result<Vec<u8>, String> {
        let mut argv = vec!["-s".into(), device.into()];
        argv.extend(args);
        self.capture(argv).await
    }
}

pub(super) fn online_devices(output: &[u8]) -> Result<Vec<String>, String> {
    if output.len() > 8192 {
        return Err("设备枚举输出超限，无法完成旧资源审计".into());
    }
    let mut lines = std::str::from_utf8(output)
        .map_err(|_| "设备枚举文本无效")?
        .lines();
    if lines.next() != Some("List of devices attached") {
        return Err("设备枚举缺少完整列表标识".into());
    }
    let mut devices = std::collections::BTreeSet::new();
    for line in lines.filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_ascii_whitespace();
        let device = fields.next().ok_or("设备枚举缺少标识")?;
        if !super::ledger::device_id(device)
            || fields.next() != Some("device")
            || fields.next().is_some()
        {
            return Err("设备离线、未授权或枚举状态无效，请恢复连接后核对旧资源".into());
        }
        if !devices.insert(device.to_owned()) || devices.len() > 128 {
            return Err("设备枚举重复或数量超限，不能省略旧资源审计".into());
        }
    }
    Ok(devices.into_iter().collect())
}

pub(super) async fn recover(
    runner: &mut impl RecoveryRunner,
    root: &Path,
    record: &mut Record,
) -> Result<(), String> {
    if record.externally_managed {
        legacy_audit(runner, &record.device_id).await?;
        record.directory_stage = Stage::Released;
        record.upload_stage = Stage::Released;
        record.forward_stage = Stage::Released;
        record.server_stage = Stage::Released;
        return save(root, record).await;
    }
    // 已释放端口不再属于本记录；后续正常复用不能重新成为本记录的债务。
    let port = if record.forward_stage == Stage::Released {
        None
    } else {
        let list = runner
            .command(&record.device_id, vec!["forward".into(), "--list".into()])
            .await?;
        remote::forward(&list, record)?
    };
    // 目录释放回执已包含服务退出和上传文件删除，续办时不重复删除。
    if record.directory_stage != Stage::Released {
        let output = runner
            .command(
                &record.device_id,
                vec!["shell".into(), remote::cleanup(record)],
            )
            .await?;
        if !matches!(
            output.as_slice(),
            b"DFML_RECOVERED\n" | b"DFML_RECOVERED\r\n"
        ) {
            return Err("设备资源未返回有效清理确认".into());
        }
    }
    record.directory_stage = Stage::Released;
    record.upload_stage = Stage::Released;
    record.server_stage = Stage::Released;
    save(root, record).await?;
    if record.forward_stage == Stage::Released {
        return Ok(());
    }
    if let Some(port) = port {
        record.port = Some(port);
        save(root, record).await?;
        let current = runner
            .command(&record.device_id, vec!["forward".into(), "--list".into()])
            .await?;
        if remote::forward(&current, record)? != Some(port) {
            return Err("资源转发在核对期间变化，请重新核对".into());
        }
        let removed = runner
            .command(
                &record.device_id,
                vec!["forward".into(), "--remove".into(), format!("tcp:{port}")],
            )
            .await;
        // 直接进程未确认不允许由后续空转发表冲销。
        if runner.unconfirmed() {
            return Err("本机直接进程退出未确认，保留资源阻断".into());
        }
        if removed.as_ref().is_ok_and(|output| !output.is_empty()) {
            return Err("转发撤销回执无效".into());
        }
        let current = runner
            .command(&record.device_id, vec!["forward".into(), "--list".into()])
            .await?;
        if remote::forward(&current, record)?.is_some() {
            return Err("本次转发尚未确认撤销".into());
        }
    }
    record.forward_stage = Stage::Released;
    save(root, record).await
}

pub(super) async fn legacy_audit(
    runner: &mut impl RecoveryRunner,
    device: &str,
) -> Result<(), String> {
    let output = runner
        .command(device, vec!["forward".into(), "--list".into()])
        .await?;
    let text = std::str::from_utf8(&output).map_err(|_| "转发审计文本无效")?;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        if fields.len() != 3 {
            return Err("转发审计目录无效".into());
        }
        if fields[0] == device && fields[2].starts_with("localabstract:scrcpy_") {
            return Err(
                "发现无台账投屏转发或外部工具占用，请先结束原投屏后重试；未猜测归属或强制删除"
                    .into(),
            );
        }
    }
    let output = runner
        .command(device, vec!["shell".into(), remote::LEGACY_AUDIT.into()])
        .await?;
    if matches!(output.as_slice(), b"DFML_AUDITED\n" | b"DFML_AUDITED\r\n") {
        Ok(())
    } else {
        Err("旧版资源审计尚未获得明确确认".into())
    }
}
pub(super) async fn save(root: &Path, record: &Record) -> Result<(), String> {
    let path = record.path(root);
    let record = record.clone();
    store::io(move || {
        record.validate()?;
        store::publish(
            &path,
            &serde_json::to_vec(&record).map_err(|_| "资源台账编码失败")?,
        )
    })
    .await
}
