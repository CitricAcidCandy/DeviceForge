//! 只包含固定的编译期文档，不接受调用者路径或运行时文件内容。
use super::schema::{Target, Topic};
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct Document {
    pub target: Target,
    pub topic: Topic,
    pub source: &'static str,
    pub content: &'static str,
}

macro_rules! document {
    ($target:ident, $topic:ident, $source:literal) => {
        Document {
            target: Target::$target,
            topic: Topic::$topic,
            source: $source,
            content: include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../", $source)),
        }
    };
}

static DOCUMENTS: [Document; 14] = [
    document!(
        Frontend,
        Overview,
        "frontend/docs/guides/plugin-development/overview.md"
    ),
    document!(
        Frontend,
        Manifest,
        "frontend/docs/guides/plugin-development/manifest.md"
    ),
    document!(
        Frontend,
        Sdk,
        "frontend/docs/guides/plugin-development/sdk.md"
    ),
    document!(
        Frontend,
        Lifecycle,
        "frontend/docs/guides/plugin-development/lifecycle.md"
    ),
    document!(
        Frontend,
        Examples,
        "frontend/docs/guides/plugin-development/examples.md"
    ),
    document!(
        Frontend,
        Packaging,
        "frontend/docs/guides/plugin-development/packaging.md"
    ),
    document!(
        Frontend,
        Validation,
        "frontend/docs/guides/plugin-development/validation.md"
    ),
    document!(
        Backend,
        Overview,
        "backend/docs/guides/plugin-development/overview.md"
    ),
    document!(
        Backend,
        Manifest,
        "backend/docs/guides/plugin-development/manifest.md"
    ),
    document!(
        Backend,
        Sdk,
        "backend/docs/guides/plugin-development/sdk.md"
    ),
    document!(
        Backend,
        Lifecycle,
        "backend/docs/guides/plugin-development/lifecycle.md"
    ),
    document!(
        Backend,
        Examples,
        "backend/docs/guides/plugin-development/examples.md"
    ),
    document!(
        Backend,
        Packaging,
        "backend/docs/guides/plugin-development/packaging.md"
    ),
    document!(
        Backend,
        Validation,
        "backend/docs/guides/plugin-development/validation.md"
    ),
];

pub(super) fn select(target: Target, topic: Topic) -> Vec<&'static Document> {
    DOCUMENTS
        .iter()
        .filter(|document| {
            document.topic == topic && (target == Target::Fullstack || document.target == target)
        })
        .collect()
}
