//! 部署配置与真实提供者清单；旧输入和目标封套分别声明模式。
use apk_application::operation_aliases::Config;
use serde_json::{Value, json};
use std::path::Path;

pub const PROVIDER: &str = "aliasprobe";
pub const WRITE: &str = "device.write";
pub const READ: &str = "device.read";
pub const GLOBAL: &str = "provider.write";

pub fn old_schema(device: bool) -> Value {
    let mut schema = json!({"type":"object","properties":{
        "device_id":{"type":["string","null"]},
        "label":{"type":"string","pattern":"^[a-z0-9-]+$"},
        "mode":{"enum":["normal","hold","failed"]},
        "payload":{},"nullable":{}
    },"required":["label"],"additionalProperties":false});
    if device {
        schema["properties"]["device_id"] = json!({"type":"string"});
        schema["required"] = json!(["device_id", "label"]);
    }
    schema
}

pub fn binding(alias: &str, capability: &str, device: bool) -> Value {
    json!({"operation":{"id":alias,"title":"旧设备入口","input_schema":old_schema(device)},
        "target":{"kind":"device_capability","plugin_id":PROVIDER,"capability":capability,"version":1},
        "input":"device_envelope","result":{"kind":"value","wrapped":true}})
}

pub fn config_from(bindings: Vec<Value>) -> Config {
    serde_json::from_value(json!({"format_version":1,"bindings":bindings})).unwrap()
}

pub fn config() -> Config {
    config_from(vec![
        binding(WRITE, "write", true),
        binding(READ, "read", true),
        binding(GLOBAL, "global", false),
    ])
}

pub fn manifest(protocol: u32, marker: &Path, timeout: Option<u64>) -> Value {
    let envelope = json!({"type":"object","properties":{
        "device_id":{"type":["string","null"]},"input":old_schema(false)
    },"required":["device_id","input"],"additionalProperties":false});
    let mut declaration = json!({
        "id":PROVIDER,"version":"1","protocol_version":protocol,
        "executable":super::support::node(),
        "args":[Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/operation_alias_fixtures/provider.cjs"),marker],
        "operations":[
            {"name":"discover","title":"发现模拟设备","input_schema":{"type":"object","additionalProperties":false}},
            {"name":"write","title":"设备写","input_schema":envelope},
            {"name":"read","title":"设备读","input_schema":envelope},
            {"name":"global","title":"提供者写","input_schema":envelope},
            {"name":"ping","title":"无设备锁对照","input_schema":{"type":"object"}}
        ],
        "devices":{"api_version":2,"platform":"synthetic_demo","discover_operation":"discover","capabilities":[
            {"id":"write","version":1,"operation":"write","scope":"device","access":"write"},
            {"id":"read","version":1,"operation":"read","scope":"device","access":"read"},
            {"id":"global","version":1,"operation":"global","scope":"provider","access":"write"}
        ]}
    });
    if let Some(timeout) = timeout {
        declaration["devices"]["capabilities"][0]["execution_timeout_ms"] = json!(timeout);
    }
    declaration
}

pub fn old_input(label: &str, device: Option<&str>, mode: &str) -> Value {
    let mut input = json!({"label":label,"mode":mode,"payload":{"value":7}});
    if let Some(device) = device {
        input["device_id"] = json!(device);
    }
    input
}
