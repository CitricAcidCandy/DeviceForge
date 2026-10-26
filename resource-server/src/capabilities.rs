//! 浏览器发布前使用的稳定能力声明；限额与实际上传边界共用。
use serde_json::{Value, json};

pub(crate) const RESOURCE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub(crate) fn document() -> Value {
    json!({
        "api_version": 1,
        "release_publication": {
            "format_versions": [1, 2],
            "host_api_versions": [2],
            "resource_max_bytes": RESOURCE_MAX_BYTES,
            "catalog_last": true,
            "immutable_versions": true
        }
    })
}
