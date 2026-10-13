use apk_plugin_sdk::session::SessionStream;
use deviceforge_plugin_runtime::session::SessionOutput;
use serde_json::Value;

pub(crate) struct Writer {
    output: SessionOutput,
    bytes: usize,
}

impl Writer {
    pub(crate) fn new(output: SessionOutput) -> Self {
        Self { output, bytes: 0 }
    }

    pub(crate) async fn send(&mut self, event: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(event).map_err(|_| "AI流事件序列化失败")?;
        line.push(b'\n');
        if line.len() > 512 * 1024 || line.len() > (4 * 1024 * 1024usize).saturating_sub(self.bytes)
        {
            return Err("AI规范化流事件大小超限".into());
        }
        self.bytes += line.len();
        for chunk in line.chunks(8192) {
            self.output
                .send(SessionStream::Stdout, chunk)
                .await
                .map_err(|_| "AI会话输出已关闭或取消")?;
        }
        Ok(())
    }
}
