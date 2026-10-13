//! 完整历史与有限尾部共用单块和窗口边界；不拥有媒体帧或进程。
use super::{MESSAGE_LIMIT, OUTPUT_LIMIT};
use apk_domain::{Error, Result, interactive::*};
use std::collections::VecDeque;

pub(super) struct OutputCache {
    chunks: VecDeque<SessionChunk>,
    bytes: usize,
    retention: SessionOutputRetention,
}

impl OutputCache {
    pub fn new(retention: SessionOutputRetention) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            retention,
        }
    }

    pub fn append(&mut self, chunk: SessionChunk) -> Result<()> {
        if chunk.bytes.len() > SESSION_CHUNK_LIMIT {
            return Err(Error::TooLarge);
        }
        if self.retention == SessionOutputRetention::BoundedTail {
            while self.bytes + chunk.bytes.len() > OUTPUT_LIMIT
                || self.chunks.len() >= MESSAGE_LIMIT
            {
                let oldest = self.chunks.pop_front().expect("窗口满时必有已保留输出");
                self.bytes -= oldest.bytes.len();
            }
        } else if self.bytes + chunk.bytes.len() > OUTPUT_LIMIT
            || self.chunks.len() >= MESSAGE_LIMIT
        {
            return Err(Error::TooLarge);
        }
        self.bytes += chunk.bytes.len();
        self.chunks.push_back(chunk);
        Ok(())
    }

    pub fn page(&self, after: u64, limit: usize) -> Result<Vec<SessionChunk>> {
        if self
            .chunks
            .front()
            .is_some_and(|first| after < first.sequence - 1)
        {
            return Err(Error::Conflict(
                "会话输出游标已过期，请重新建立媒体会话".into(),
            ));
        }
        Ok(self
            .chunks
            .iter()
            .filter(|chunk| chunk.sequence > after)
            .take(limit)
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(sequence: u64, size: usize) -> SessionChunk {
        SessionChunk {
            sequence,
            stream: SessionStream::Stdout,
            bytes: vec![sequence as u8; size],
        }
    }

    #[test]
    fn tail_evicts_at_byte_boundary_and_keeps_real_sequence() {
        let mut cache = OutputCache::new(SessionOutputRetention::BoundedTail);
        for sequence in 1..=2049 {
            cache.append(chunk(sequence, SESSION_CHUNK_LIMIT)).unwrap();
        }
        assert_eq!(cache.bytes, OUTPUT_LIMIT);
        assert_eq!(cache.chunks.len(), 2048);
        assert!(matches!(cache.page(0, 100), Err(Error::Conflict(_))));
        let page = cache.page(1, 2).unwrap();
        assert_eq!(
            page.iter().map(|chunk| chunk.sequence).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(page[0].bytes, vec![2; SESSION_CHUNK_LIMIT]);
        cache
            .append(chunk(2050, SESSION_CHUNK_LIMIT + 1))
            .unwrap_err();
        assert_eq!(cache.bytes, OUTPUT_LIMIT);
        assert_eq!(cache.chunks.back().unwrap().sequence, 2049);
    }

    #[test]
    fn tail_block_boundary_applies_even_to_empty_chunks() {
        let mut cache = OutputCache::new(SessionOutputRetention::BoundedTail);
        for sequence in 1..=MESSAGE_LIMIT as u64 + 1 {
            cache.append(chunk(sequence, 0)).unwrap();
        }
        assert_eq!(cache.bytes, 0);
        assert_eq!(cache.chunks.len(), MESSAGE_LIMIT);
        assert!(matches!(cache.page(0, 1), Err(Error::Conflict(_))));
        assert_eq!(cache.page(1, 1).unwrap()[0].sequence, 2);
    }

    #[test]
    fn complete_history_rejects_overflow_without_removing_prefix() {
        let mut cache = OutputCache::new(SessionOutputRetention::Complete);
        for sequence in 1..=2048 {
            cache.append(chunk(sequence, SESSION_CHUNK_LIMIT)).unwrap();
        }
        assert!(matches!(cache.append(chunk(2049, 1)), Err(Error::TooLarge)));
        assert_eq!(cache.page(0, 1).unwrap()[0].sequence, 1);
        assert_eq!(cache.bytes, OUTPUT_LIMIT);
    }
}
