use apk_plugin_sdk::session::SessionStream;
use deviceforge_plugin_runtime::{InvocationContext, SessionOutput};
use serde_json::Value;

pub struct Writer {
    output: SessionOutput,
    bytes: usize,
}

impl Writer {
    pub fn new(output: SessionOutput) -> Self {
        Self { output, bytes: 0 }
    }

    pub async fn send(&mut self, context: &InvocationContext, event: &Value) -> Result<(), String> {
        context.check().map_err(|error| error.to_string())?;
        let mut line = serde_json::to_vec(event).map_err(|_| "SDK公开流事件序列化失败")?;
        line.push(b'\n');
        if line.len() > 512 * 1024 || line.len() > (4 * 1024 * 1024usize).saturating_sub(self.bytes)
        {
            return Err("SDK公开流单行或总量超限".into());
        }
        self.bytes += line.len();
        for chunk in line.chunks(8192) {
            context.check().map_err(|error| error.to_string())?;
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(context.deadline())) => return Err("SDK公开流期限已到期".into()),
                result = self.output.send(SessionStream::Stdout, chunk) => result.map_err(|_| "SDK公开流连接已关闭或取消")?,
            }
        }
        Ok(())
    }
}
