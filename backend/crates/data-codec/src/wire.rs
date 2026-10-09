use crate::{Error, MAX_BYTES, MAX_DEPTH, MAX_NODES, Result};
struct Scanner<'a> {
    bytes: &'a [u8],
    position: usize,
    nodes: usize,
}
impl Scanner<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8]> {
        let end = self.position.checked_add(count).ok_or(Error::Limit)?;
        let bytes = self.bytes.get(self.position..end).ok_or(Error::Invalid)?;
        self.position = end;
        Ok(bytes)
    }
    fn count(&mut self, width: usize) -> Result<usize> {
        let mut value = 0usize;
        for byte in self.take(width)? {
            value = value
                .checked_mul(256)
                .and_then(|v| v.checked_add(*byte as usize))
                .ok_or(Error::Limit)?;
        }
        Ok(value)
    }
    fn body(&mut self, width: usize, extension: bool) -> Result<()> {
        let length = self.count(width)?;
        if extension {
            self.take(1)?;
        }
        self.take(length)?;
        Ok(())
    }
    fn children(&mut self, count: usize, depth: usize) -> Result<()> {
        if count > MAX_NODES.saturating_sub(self.nodes) {
            return Err(Error::Limit);
        }
        if count > self.bytes.len().saturating_sub(self.position) {
            return Err(Error::Invalid);
        }
        for _ in 0..count {
            self.value(depth + 1)?;
        }
        Ok(())
    }
    fn value(&mut self, depth: usize) -> Result<()> {
        self.nodes += 1;
        if depth > MAX_DEPTH || self.nodes > MAX_NODES {
            return Err(Error::Limit);
        }
        let marker = self.take(1)?[0];
        match marker {
            0x00..=0x7f | 0xe0..=0xff | 0xc0 | 0xc2 | 0xc3 => (),
            0xa0..=0xbf => {
                self.take((marker & 31) as usize)?;
            }
            0x80..=0x8f => self.children((marker & 15) as usize * 2, depth)?,
            0x90..=0x9f => self.children((marker & 15) as usize, depth)?,
            0xc4 | 0xd9 => self.body(1, false)?,
            0xc5 | 0xda => self.body(2, false)?,
            0xc6 | 0xdb => self.body(4, false)?,
            0xc7 => self.body(1, true)?,
            0xc8 => self.body(2, true)?,
            0xc9 => self.body(4, true)?,
            0xca | 0xce | 0xd2 => {
                self.take(4)?;
            }
            0xcb | 0xcf | 0xd3 => {
                self.take(8)?;
            }
            0xcc | 0xd0 => {
                self.take(1)?;
            }
            0xcd | 0xd1 => {
                self.take(2)?;
            }
            0xd4..=0xd8 => {
                self.take((1usize << (marker - 0xd4)) + 1)?;
            }
            0xdc | 0xdd => {
                let count = self.count(if marker == 0xdc { 2 } else { 4 })?;
                self.children(count, depth)?;
            }
            0xde | 0xdf => {
                let count = self
                    .count(if marker == 0xde { 2 } else { 4 })?
                    .checked_mul(2)
                    .ok_or(Error::Limit)?;
                self.children(count, depth)?;
            }
            _ => return Err(Error::Invalid),
        }
        Ok(())
    }
}
pub(super) fn validate(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    let mut scanner = Scanner {
        bytes,
        position: 0,
        nodes: 0,
    };
    scanner.value(0)?;
    if scanner.position != bytes.len() {
        return Err(Error::Invalid);
    }
    Ok(())
}
