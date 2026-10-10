use apk_domain::{
    Error, Result,
    reverse::{SdkFinding, SdkRule, SdkScan},
};
use std::{collections::BTreeSet, path::Path};
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && (value.as_bytes()[0].is_ascii_alphabetic() || b"_$".contains(&value.as_bytes()[0]))
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$')
}
pub(super) fn validate(rules: &[SdkRule]) -> Result<()> {
    if rules.is_empty() || rules.len() > 100 {
        return Err(Error::Invalid("SDK 规则数量必须为 1 到 100".into()));
    }
    let mut names = BTreeSet::new();
    for rule in rules {
        if rule.name.trim().is_empty()
            || rule.name.len() > 100
            || rule.name.chars().any(char::is_control)
            || !names.insert(rule.name.as_str())
            || rule.package_path.len() > 200
            || !rule.package_path.split('.').all(identifier)
            || rule
                .class_name
                .as_ref()
                .is_some_and(|name| name.len() > 100 || !identifier(name))
        {
            return Err(Error::Invalid(
                "SDK 名称必须唯一，包路径和类名必须为合法标识符".into(),
            ));
        }
    }
    Ok(())
}
pub(super) fn controlled(
    path: &Path,
    id: &str,
    rules: Vec<SdkRule>,
    control: &deviceforge_android_package_core::Control<'_>,
) -> Result<SdkScan> {
    use deviceforge_android_package_core::{ArchiveProfile, archive::Archive};
    control.check().map_err(super::packing::mapped)?;
    validate(&rules)?;
    let file = std::fs::File::open(path).map_err(|error| Error::Storage(error.to_string()))?;
    let archive = Archive::open(file, ArchiveProfile::Structure, control).map_err(|error| {
        use deviceforge_android_package_core::{Error as CoreError, LimitKind};
        match error {
            CoreError::LimitExceeded {
                kind: LimitKind::Entries,
                ..
            } => Error::Invalid("压缩包条目超过 10000".into()),
            CoreError::LimitExceeded {
                kind: LimitKind::ExpandedBytes,
                ..
            } => Error::Invalid("压缩包声明解压体积超过 2 GiB".into()),
            other => super::packing::mapped(other),
        }
    })?;
    let mut names = BTreeSet::new();
    for entry in archive.directory().entries() {
        control.check().map_err(super::packing::mapped)?;
        if !names.insert(entry.name.as_str()) {
            return Err(Error::Invalid("ZIP 包含重复条目或目录数量不匹配".into()));
        }
    }
    deviceforge_android_package_core::android::validate_decoded(archive.directory()).map_err(
        |_| {
            Error::Invalid(
                "SDK 检测需要包含 apktool.yml 和 AndroidManifest.xml 的反编译 ZIP".into(),
            )
        },
    )?;
    let core_rules: Vec<_> = rules
        .iter()
        .map(|rule| deviceforge_android_package_core::SdkRule {
            name: rule.name.clone(),
            package_path: rule.package_path.clone(),
            class_name: rule.class_name.clone(),
        })
        .collect();
    let findings = deviceforge_android_package_core::android::scan_sdks(
        archive.directory(),
        &core_rules,
        control,
    )
    .map_err(super::packing::mapped)?;
    let findings = findings
        .into_iter()
        .map(|finding| SdkFinding {
            rule: SdkRule {
                name: finding.rule.name,
                package_path: finding.rule.package_path,
                class_name: finding.rule.class_name,
            },
            package_found: finding.package_found,
            class_found: finding.class_found,
            evidence: finding.evidence,
        })
        .collect();
    Ok(SdkScan {
        artifact_id: id.into(),
        findings,
    })
}
