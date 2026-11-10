//! 只包含固定的编译期文档，不接受调用者路径或运行时文件内容。
use super::schema::{Target, Topic};
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct Document {
    pub target: Target,
    pub topic: Topic,
    pub content: &'static str,
}

macro_rules! document {
    ($target:ident, $topic:ident, $source:literal) => {
        Document {
            target: Target::$target,
            topic: Topic::$topic,
            content: include_str!(concat!(env!("DEVICEFORGE_SDK_ROOT"), "/", $source)),
        }
    };
    ($target:ident, $topic:ident, $source:literal, $supplement:literal) => {
        Document {
            target: Target::$target,
            topic: Topic::$topic,
            content: concat!(
                include_str!(concat!(env!("DEVICEFORGE_SDK_ROOT"), "/", $source)),
                "\n\n",
                include_str!(concat!(env!("DEVICEFORGE_SDK_ROOT"), "/", $supplement))
            ),
        }
    };
}

static DOCUMENTS: [Document; 16] = [
    document!(
        Frontend,
        Dependencies,
        "docs/frontend/dependencies.md"
    ),
    document!(
        Backend,
        Dependencies,
        "docs/backend/dependencies.md"
    ),
    document!(
        Frontend,
        Overview,
        "docs/frontend/overview.md"
    ),
    document!(
        Frontend,
        Manifest,
        "docs/frontend/manifest.md"
    ),
    document!(
        Frontend,
        Sdk,
        "docs/frontend/sdk.md",
        "docs/frontend/composition.md"
    ),
    document!(
        Frontend,
        Lifecycle,
        "docs/frontend/lifecycle.md"
    ),
    document!(
        Frontend,
        Examples,
        "docs/frontend/examples.md"
    ),
    document!(
        Frontend,
        Packaging,
        "docs/frontend/packaging.md"
    ),
    document!(
        Frontend,
        Validation,
        "docs/frontend/validation.md"
    ),
    document!(
        Backend,
        Overview,
        "docs/backend/overview.md"
    ),
    document!(
        Backend,
        Manifest,
        "docs/backend/manifest.md"
    ),
    document!(
        Backend,
        Sdk,
        "docs/backend/sdk.md"
    ),
    document!(
        Backend,
        Lifecycle,
        "docs/backend/lifecycle.md"
    ),
    document!(
        Backend,
        Examples,
        "docs/backend/examples.md"
    ),
    document!(
        Backend,
        Packaging,
        "docs/backend/packaging.md"
    ),
    document!(
        Backend,
        Validation,
        "docs/backend/validation.md"
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
