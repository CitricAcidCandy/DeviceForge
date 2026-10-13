pub(super) const FILE_LIMIT: u64 = 64 * 1024 * 1024;
pub(super) const FRAME_LIMIT: u64 = 89_478_616;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Frame {
    pub body_bytes: u64,
    pub status: u8,
}
