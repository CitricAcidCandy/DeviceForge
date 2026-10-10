//! 业务只组合公开核心与已冻结 Session 接缝，资源收口统一归 Session。
mod build_apks;
mod common;
mod decode;
mod extract_apk;
mod extract_splits;
mod input;
mod manifest;
mod scan_sdks;
mod signature;

use crate::{Error, Result, session::Session};
use deviceforge_plugin_runtime::Output;
pub(crate) use input::Input;
use serde_json::Value;

pub(crate) fn parse(operation: &str, input: &Value) -> Result<Input> {
    Input::parse(operation, input).map_err(Error::Invalid)
}

impl Input {
    pub(crate) fn extensions(&self) -> &'static [&'static str] {
        match self {
            Self::Manifest(_) => &[".apk", ".aab"],
            Self::Signature(_) | Self::Decode(_) => &[".apk"],
            Self::Extract(_) | Self::Splits(_) => &[".apks"],
            Self::Build(_) => &[".aab"],
            Self::Scan(_) => &[".zip"],
        }
    }
}

pub(crate) async fn execute(session: &Session, input: Input) -> Result<Output> {
    match input {
        Input::Manifest(input) => manifest::run(session, input).await,
        Input::Signature(input) => signature::run(session, input).await,
        Input::Extract(input) => extract_apk::run(session, input).await,
        Input::Build(input) => build_apks::run(session, input).await,
        Input::Decode(input) => decode::run(session, input).await,
        Input::Scan(input) => scan_sdks::run(session, input).await,
        Input::Splits(input) => extract_splits::run(session, input).await,
    }
}
