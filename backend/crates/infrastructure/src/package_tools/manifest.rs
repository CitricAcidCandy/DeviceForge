//! 公共清单规则到宿主 DTO 的薄映射；调用方在受限 worker 中执行。
use apk_domain::{
    Error, Result,
    packages::{PackageFormat, PackageManifest},
};
use deviceforge_android_package_core::{Control, Error as CoreError, android::parse_manifest};

pub(super) fn controlled(
    id: &str,
    format: PackageFormat,
    module: Option<String>,
    xml: String,
    control: &Control<'_>,
) -> Result<PackageManifest> {
    let data = parse_manifest(&xml, control).map_err(|error| match error {
        CoreError::Cancelled | CoreError::Timeout => super::control_error(error),
        CoreError::LimitExceeded { .. } => Error::TooLarge,
        _ => Error::Dependency("工具返回的 AndroidManifest XML 无效".into()),
    })?;
    Ok(PackageManifest {
        artifact_id: id.into(),
        format,
        module,
        package_name: data.package_name,
        version_code: data.version_code,
        version_name: data.version_name,
        min_sdk: data.min_sdk,
        target_sdk: data.target_sdk,
        application_label: data.application_label,
        debuggable: data.debuggable,
        permissions: data.permissions,
        xml: data.xml,
    })
}

#[cfg(test)]
pub(super) fn parse(
    id: &str,
    format: PackageFormat,
    module: Option<String>,
    xml: String,
) -> Result<PackageManifest> {
    controlled(id, format, module, xml, &Control::new(None, &|| false))
}
