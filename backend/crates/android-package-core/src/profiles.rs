pub const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub const MAX_DECLARED_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_APKS_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_TREE_DEPTH: usize = 128;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_XML_NODES: usize = 20_000;
pub const MAX_XML_DEPTH: usize = 128;
pub const MAX_SELECTED_NAME_BYTES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveProfile {
    Structure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeProfile {
    Reverse,
    Splits,
}

impl TreeProfile {
    pub fn entry_limit(self) -> usize {
        match self {
            Self::Reverse => 10_000,
            Self::Splits => 1_000,
        }
    }
}
