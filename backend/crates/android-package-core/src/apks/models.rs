use crate::{Control, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSpec {
    pub supported_abis: Vec<String>,
    pub supported_locales: Vec<String>,
    pub screen_density: u32,
    pub sdk_version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub device_features: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gl_extensions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_tier: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundletoolDeviceSpec<'a> {
    pub supported_abis: &'a [String],
    pub supported_locales: &'a [String],
    pub screen_density: u32,
    pub sdk_version: u32,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    pub device_features: &'a [String],
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    pub gl_extensions: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codename: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_tier: Option<&'a str>,
}

impl DeviceSpec {
    pub fn validate(&self, control: &Control<'_>) -> Result<()> {
        super::rules::spec(self, control)
    }

    pub fn bundletool(&self) -> BundletoolDeviceSpec<'_> {
        BundletoolDeviceSpec {
            supported_abis: &self.supported_abis,
            supported_locales: &self.supported_locales,
            screen_density: self.screen_density,
            sdk_version: self.sdk_version,
            device_features: &self.device_features,
            gl_extensions: &self.gl_extensions,
            codename: self.codename.as_deref(),
            device_tier: self.device_tier.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modules: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub instant: bool,
}

impl Selection {
    pub fn validate(&self, control: &Control<'_>) -> Result<()> {
        super::rules::selection(self, control)
    }
}
