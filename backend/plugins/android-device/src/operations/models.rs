//! 每层显式拒绝未知字段；provider封套的null必须实际出现。
use crate::rules::Action;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Envelope {
    pub device_id: Value,
    pub input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Address {
    pub address: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Package {
    pub package: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InputAction {
    pub action: Action,
}
