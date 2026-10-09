//! 先限制缓冲再读取整行，避免无换行输入导致无界分配。
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub(super) async fn line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|_| "输入流读取失败")?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("输入帧缺少换行结束符".into())
            };
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |index| index + 1);
        if bytes.len() + count > limit {
            return Err("输入帧超过大小上限".into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return Ok(Some(bytes));
        }
    }
}
