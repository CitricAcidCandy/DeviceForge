//! 仅映射公开指南库的固定正文，不接受调用者路径或运行时文件内容。
use super::schema::{Target, Topic};
use deviceforge_plugin_guide::{backend, frontend};
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct Document {
    pub target: Target,
    pub topic: Topic,
    pub content: &'static str,
}

macro_rules! document {
    ($target:ident, $topic:ident, $content:path) => {
        Document {
            target: Target::$target,
            topic: Topic::$topic,
            content: $content,
        }
    };
}

static DOCUMENTS: [Document; 16] = [
    document!(Frontend, Overview, frontend::OVERVIEW),
    document!(Frontend, Manifest, frontend::MANIFEST),
    document!(Frontend, Sdk, frontend::SDK),
    document!(Frontend, Lifecycle, frontend::LIFECYCLE),
    document!(Frontend, Examples, frontend::EXAMPLES),
    document!(Frontend, Packaging, frontend::PACKAGING),
    document!(Frontend, Dependencies, frontend::DEPENDENCIES),
    document!(Frontend, Validation, frontend::VALIDATION),
    document!(Backend, Overview, backend::OVERVIEW),
    document!(Backend, Manifest, backend::MANIFEST),
    document!(Backend, Sdk, backend::SDK),
    document!(Backend, Lifecycle, backend::LIFECYCLE),
    document!(Backend, Examples, backend::EXAMPLES),
    document!(Backend, Packaging, backend::PACKAGING),
    document!(Backend, Dependencies, backend::DEPENDENCIES),
    document!(Backend, Validation, backend::VALIDATION),
];

pub(super) fn select(target: Target, topic: Topic) -> Vec<&'static Document> {
    DOCUMENTS
        .iter()
        .filter(|document| {
            document.topic == topic && (target == Target::Fullstack || document.target == target)
        })
        .collect()
}

pub(super) fn builtin() -> apk_domain::Result<apk_domain::plugin_guides::GuideSnapshot> {
    fn label(value: impl Serialize) -> apk_domain::Result<String> {
        match serde_json::to_value(value) {
            Ok(serde_json::Value::String(value)) => Ok(value),
            _ => Err(apk_domain::Error::Invalid("内置指南目标或主题无效".into())),
        }
    }
    let documents = DOCUMENTS
        .iter()
        .map(|document| {
            Ok(apk_domain::plugin_guides::GuideDocument {
                target: label(document.target)?,
                topic: label(document.topic)?,
                content: document.content.to_owned(),
            })
        })
        .collect::<apk_domain::Result<Vec<_>>>()?;
    apk_application::plugin_guides::embedded(documents, deviceforge_plugin_guide::GUIDE_VERSION)
}
