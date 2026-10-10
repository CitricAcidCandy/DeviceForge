//! 公共签名报告规则到宿主 DTO 的薄映射；报告脱敏由调用方处理。
use apk_domain::{
    Error, Result,
    packages::{PackageSignature, PackageSigner, SignatureScheme},
};
use deviceforge_android_package_core::{Control, Error as CoreError, android::parse_signature};

pub(super) fn controlled(
    id: &str,
    report: String,
    control: &Control<'_>,
) -> Result<PackageSignature> {
    let data = parse_signature(&report, control).map_err(|error| match error {
        CoreError::Cancelled | CoreError::Timeout => super::control_error(error),
        CoreError::LimitExceeded { .. } => Error::TooLarge,
        _ => Error::Dependency("签名工具未返回完整、明确的验证结果".into()),
    })?;
    Ok(PackageSignature {
        artifact_id: id.into(),
        verified: data.verified,
        signers: data
            .signers
            .into_iter()
            .map(|signer| PackageSigner {
                number: signer.number,
                distinguished_name: signer.distinguished_name,
                certificate_sha256: signer.certificate_sha256,
            })
            .collect(),
        schemes: data
            .schemes
            .into_iter()
            .map(|scheme| SignatureScheme {
                scheme: scheme.scheme,
                verified: scheme.verified,
            })
            .collect(),
        report: data.report,
    })
}

#[cfg(test)]
pub(super) fn parse(id: &str, report: String) -> Result<PackageSignature> {
    controlled(id, report, &Control::new(None, &|| false))
}
