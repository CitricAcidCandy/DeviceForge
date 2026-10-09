use apk_domain::{
    Error, Result,
    reverse::{SdkFinding, SdkRule, SdkScan},
};
use std::{collections::BTreeSet, path::Path};
use tokio_util::sync::CancellationToken;
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
fn smali_root(root: &str) -> bool {
    root == "smali"
        || root.strip_prefix("smali_classes").is_some_and(|number| {
            !number.is_empty()
                && number.bytes().all(|c| c.is_ascii_digit())
                && number.parse::<u32>().is_ok_and(|v| v >= 2)
        })
}
pub(super) fn scan(
    path: &Path,
    id: &str,
    rules: Vec<SdkRule>,
    cancel: &CancellationToken,
) -> Result<SdkScan> {
    validate(&rules)?;
    crate::artifacts::validation::validate_archive(path)?;
    let mut archive = crate::artifacts::validation::archive(path)?;
    if !["apktool.yml", "AndroidManifest.xml"].iter().all(|name| {
        archive
            .by_name(name)
            .is_ok_and(|file| !file.is_dir() && file.size() > 0)
    }) {
        return Err(Error::Invalid(
            "SDK 检测需要包含 apktool.yml 和 AndroidManifest.xml 的反编译 ZIP".into(),
        ));
    }
    let paths: BTreeSet<String> = archive
        .file_names()
        .filter(|name| {
            name.split_once('/')
                .is_some_and(|(root, rest)| smali_root(root) && rest.ends_with(".smali"))
        })
        .map(str::to_owned)
        .collect();
    let mut findings = Vec::with_capacity(rules.len());
    for rule in rules {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let prefix = format!("{}/", rule.package_path.replace('.', "/"));
        let class = rule
            .class_name
            .as_ref()
            .map(|name| format!("{prefix}{name}.smali"));
        let mut evidence = Vec::new();
        let mut package_found = false;
        let mut class_found = class.as_ref().map(|_| false);
        for path in &paths {
            let (_, relative) = path.split_once('/').expect("已筛选 smali 路径");
            if relative.starts_with(&prefix) {
                package_found = true;
                if class.as_deref() == Some(relative) {
                    class_found = Some(true);
                }
                if evidence.len() < 10 {
                    evidence.push(path.clone());
                }
            }
        }
        // 检测点必须出现在证据列表中，不能被同包其他文件占满。
        if class_found == Some(true) {
            let matching = paths
                .iter()
                .find(|path| {
                    path.split_once('/')
                        .is_some_and(|(_, relative)| class.as_deref() == Some(relative))
                })
                .expect("已匹配检测点");
            if !evidence.contains(matching) {
                evidence.pop();
                evidence.push(matching.clone());
            }
        }
        evidence.sort();
        findings.push(SdkFinding {
            rule,
            package_found,
            class_found,
            evidence,
        });
    }
    Ok(SdkScan {
        artifact_id: id.into(),
        findings,
    })
}
