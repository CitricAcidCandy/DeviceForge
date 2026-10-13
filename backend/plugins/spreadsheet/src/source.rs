use crate::{Error, Result, rules::FILE_LIMIT, worker::Control};
use apk_plugin_sdk::ArtifactInput;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Seek, SeekFrom};

pub(crate) fn read(input: &ArtifactInput, control: &Control) -> Result<Vec<u8>> {
    control.check()?;
    let mut file = std::fs::File::open(&input.path)
        .map_err(|_| Error::Invalid("无法读取宿主输入副本"))?;
    if !file.metadata().map_err(|_| Error::Invalid("无法核对输入副本"))?.is_file() {
        return Err(Error::Invalid("输入副本不是普通文件"));
    }
    let mut bytes = Vec::new();
    let mut hash = Sha256::new();
    let mut chunk = [0; 16384];
    loop {
        control.check()?;
        let count = file.read(&mut chunk).map_err(|_| Error::Invalid("输入副本读取失败"))?;
        if count == 0 { break; }
        if bytes.len() + count > FILE_LIMIT { return Err(Error::Limit); }
        hash.update(&chunk[..count]);
        bytes.extend_from_slice(&chunk[..count]);
    }
    control.check()?;
    if bytes.len() as u64 != input.size || format!("{:x}", hash.finalize()) != input.sha256.to_ascii_lowercase() {
        return Err(Error::Invalid("输入大小或SHA256与授权元数据不一致"));
    }
    Ok(bytes)
}
/// 库的每次读或定位继续使用同一个单调截止点和取消令牌。
pub(crate) struct Controlled<'a> { cursor: Cursor<&'a [u8]>, control: &'a Control }
impl<'a> Controlled<'a> {
    pub(crate) fn new(bytes: &'a [u8], control: &'a Control) -> Self {
        Self { cursor: Cursor::new(bytes), control }
    }
    fn check(&self) -> std::io::Result<()> {
        self.control.check().map_err(|error| std::io::Error::other(error.to_string()))
    }
}
impl Read for Controlled<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.check()?;
        self.cursor.read(buf)
    }
}
impl Seek for Controlled<'_> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        self.cursor.seek(pos)
    }
}
