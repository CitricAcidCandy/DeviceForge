//! 指南完整快照的纯校验，文本修订不等于宿主能力升级。
use apk_domain::{Error, Result, plugin_guides::*};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const TOPICS: [&str; 8] = [
    "overview",
    "manifest",
    "sdk",
    "lifecycle",
    "examples",
    "packaging",
    "dependencies",
    "validation",
];

pub(super) fn digest(documents: &[GuideDocument]) -> Result<String> {
    let bytes =
        serde_json::to_vec(documents).map_err(|_| Error::Invalid("指南正文无法编码".into()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn validate(snapshot: &GuideSnapshot, baseline: u32) -> Result<()> {
    if snapshot.format_version != 1
        || snapshot.compatibility_version != baseline
        || snapshot.guide_version < baseline
    {
        return Err(Error::Invalid("指南与当前宿主内置能力基线不兼容".into()));
    }
    if snapshot.documents.len() != 16 {
        return Err(Error::Invalid("指南必须完整包含两端八个主题".into()));
    }
    let mut seen = BTreeSet::new();
    for document in &snapshot.documents {
        if !["frontend", "backend"].contains(&document.target.as_str())
            || !TOPICS.contains(&document.topic.as_str())
            || !seen.insert((&document.target, &document.topic))
            || !(100..=131_072).contains(&document.content.len())
            || document.content.trim().is_empty()
            || document.content.contains('\u{feff}')
        {
            return Err(Error::Invalid("指南主题重复、缺失或正文不符合预算".into()));
        }
    }
    if snapshot.content_sha256 != digest(&snapshot.documents)? {
        return Err(Error::Invalid("指南正文SHA-256不匹配".into()));
    }
    Ok(())
}

pub(super) fn decode(bytes: &[u8], baseline: u32) -> Result<GuideSnapshot> {
    if bytes.len() > MAX_GUIDE_BYTES {
        return Err(Error::TooLarge);
    }
    let snapshot: GuideSnapshot =
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid("指南快照JSON结构无效".into()))?;
    validate(&snapshot, baseline)?;
    Ok(snapshot)
}

pub fn embedded(documents: Vec<GuideDocument>, guide_version: u32) -> Result<GuideSnapshot> {
    let snapshot = GuideSnapshot {
        format_version: 1,
        compatibility_version: guide_version,
        guide_version,
        content_sha256: digest(&documents)?,
        documents,
    };
    validate(&snapshot, guide_version)?;
    Ok(snapshot)
}
