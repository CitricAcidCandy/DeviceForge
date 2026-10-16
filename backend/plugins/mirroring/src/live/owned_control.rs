use super::{
    checked,
    device::Device,
    device_messages::{Decoder, DeviceMessage},
    model::Open,
    ownership::{Command, Ownership, View},
    pressed_inputs::PressedInputs,
};
use crate::config::Config;
use deviceforge_plugin_runtime::InvocationContext;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

pub(crate) struct OwnedControl<'a> {
    config: &'a Config,
    ownership: Ownership,
    device: Option<Device>,
    socket: Option<TcpStream>,
    decoder: Decoder,
    parameters: Open,
    pressed: PressedInputs,
}

#[cfg(test)]
mod tests;

impl<'a> OwnedControl<'a> {
    pub(crate) async fn new(
        open: &Open,
        client_id: &str,
        master: bool,
        config: &'a Config,
    ) -> Result<Self, String> {
        let ownership = Ownership::new(&open.device_id, client_id).await?;
        ownership.register(open.control, master).await?;
        let mut parameters = open.clone();
        parameters.audio = false;
        parameters.control = true;
        Ok(Self {
            config,
            ownership,
            device: None,
            socket: None,
            decoder: Decoder::new(),
            parameters,
            pressed: PressedInputs::new(),
        })
    }

    pub(crate) async fn refresh(&mut self, context: &InvocationContext) -> Result<View, String> {
        let stop = {
            let guard = self.ownership.lock().await?;
            !guard.is_owner() || guard.needs_handoff()
        };
        // 移交状态已经禁止新输入；补发抬起和设备清理不能占用跨会话协调锁。
        if stop && !self.stop().await {
            return Err("设备控制资源清理未确认".into());
        }
        let mut guard = self.ownership.lock().await?;
        // 重新读取期间的主控抢回、目标离开等变化，只在旧资源已释放后完成最新移交。
        if stop && guard.needs_handoff() {
            guard.finish_handoff()?;
            guard.save().await?;
        }
        let activate = guard.is_owner() && self.device.is_none();
        drop(guard);
        if activate {
            self.device = Some(Device::new());
            let device = self.device.as_mut().ok_or("设备控制资源缺失")?;
            if let Err(error) = device
                .prepare_control(self.config, &self.parameters, context)
                .await
            {
                if error == "ADB直播直接进程清理未确认" {
                    device.unresolved = true;
                }
                return Err(error);
            }
            self.socket = Some(device.connect(context).await?);
            self.decoder = Decoder::new();
        }
        Ok(self.ownership.lock().await?.view())
    }

    pub(crate) async fn command(&self, command: Command) -> Result<View, String> {
        let mut guard = self.ownership.lock().await?;
        guard.command(command)?;
        guard.save().await?;
        if guard.needs_recovery() {
            return Err(
                "旧控制进程已失联，设备资源尚未确认释放，请由部署者核对并清理后恢复控制".into(),
            );
        }
        Ok(guard.view())
    }

    pub(crate) async fn send(
        &mut self,
        bytes: &[u8],
        revision: Option<u64>,
        context: &InvocationContext,
    ) -> Result<(), String> {
        let guard = self.ownership.lock().await?;
        if !guard.is_owner() || revision != Some(guard.view().control_revision) {
            return Ok(());
        }
        let Some(socket) = self.socket.as_mut() else {
            return Ok(());
        };
        checked(context, async {
            tokio::time::timeout(std::time::Duration::from_secs(1), socket.write_all(bytes))
                .await
                .map_err(|_| "设备控制写入超时")?
                .map_err(|_| "设备控制连接已断开".to_owned())
        })
        .await?;
        self.pressed.record(bytes)
    }

    pub(crate) async fn next(&mut self) -> Result<Vec<DeviceMessage>, String> {
        let Some(socket) = self.socket.as_mut() else {
            return std::future::pending().await;
        };
        let mut buffer = [0_u8; 8192];
        let count = socket
            .read(&mut buffer)
            .await
            .map_err(|_| "设备控制应答读取失败")?;
        if count == 0 {
            self.decoder.finish()?;
            return Err("设备控制连接已断开".into());
        }
        self.decoder.push(&buffer[..count])
    }

    pub(crate) async fn clipboard_guard(&self) -> Result<super::ownership::Guard, String> {
        self.ownership.lock().await
    }

    pub(crate) fn clipboard_enabled(&self) -> bool {
        self.parameters.clipboard_autosync
    }

    async fn stop(&mut self) -> bool {
        let released = if let Some(socket) = self.socket.as_mut() {
            let bytes: Vec<u8> = self.pressed.release().into_iter().flatten().collect();
            tokio::time::timeout(std::time::Duration::from_secs(1), socket.write_all(&bytes))
                .await
                .is_ok_and(|result| result.is_ok())
        } else {
            let released = self.pressed.is_empty();
            self.pressed.clear();
            released
        };
        self.socket = None;
        self.decoder = Decoder::new();
        let Some(device) = self.device.as_mut() else {
            return released;
        };
        if !released {
            device.unresolved = true;
        }
        if !device.cleanup(self.config, &self.parameters).await || !released {
            return false;
        }
        self.device = None;
        true
    }

    pub(crate) async fn close(&mut self) -> bool {
        let clean = self.stop().await;
        self.ownership.unregister(clean).await.is_ok() && clean
    }
}
