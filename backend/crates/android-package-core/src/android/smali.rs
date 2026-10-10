use crate::{Control, Error, Result, SdkFinding, SdkRule, archive::Directory};
use std::collections::BTreeSet;

pub fn validate_decoded(directory: &Directory) -> Result<()> {
    for name in ["apktool.yml", "AndroidManifest.xml"] {
        let mut entries = directory
            .entries()
            .iter()
            .filter(|entry| entry.name == name);
        let entry = entries
            .next()
            .ok_or(Error::InvalidArchive("反编译目录缺少必要成员"))?;
        if entries.next().is_some() || entry.directory || entry.size == 0 {
            return Err(Error::InvalidArchive("反编译必要成员必须唯一且非空"));
        }
    }
    Ok(())
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && (value.as_bytes()[0].is_ascii_alphabetic() || b"_$".contains(&value.as_bytes()[0]))
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_$".contains(&byte))
}

fn validate_rules(rules: &[SdkRule], control: &Control<'_>) -> Result<()> {
    if rules.is_empty() || rules.len() > 100 {
        return Err(Error::InvalidArgument("SDK 规则数量必须为 1 到 100"));
    }
    let mut names = BTreeSet::new();
    for rule in rules {
        control.check()?;
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
            return Err(Error::InvalidArgument(
                "SDK 名称须唯一，包路径与类名须为合法有界标识符",
            ));
        }
    }
    Ok(())
}

fn smali_root(root: &str) -> bool {
    root == "smali"
        || root.strip_prefix("smali_classes").is_some_and(|number| {
            !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit())
                && number.parse::<u32>().is_ok_and(|number| number >= 2)
        })
}

pub fn scan_sdks(
    directory: &Directory,
    rules: &[SdkRule],
    control: &Control<'_>,
) -> Result<Vec<SdkFinding>> {
    control.check()?;
    validate_rules(rules, control)?;
    validate_decoded(directory)?;
    let mut paths = BTreeSet::new();
    for entry in directory.entries() {
        control.check()?;
        if !entry.directory
            && entry
                .name
                .split_once('/')
                .is_some_and(|(root, rest)| smali_root(root) && rest.ends_with(".smali"))
        {
            paths.insert(entry.name.as_str());
        }
    }
    let mut findings = Vec::with_capacity(rules.len());
    for rule in rules {
        control.check()?;
        let prefix = format!("{}/", rule.package_path.replace('.', "/"));
        let class = rule
            .class_name
            .as_ref()
            .map(|name| format!("{prefix}{name}.smali"));
        let mut evidence = Vec::new();
        let mut package_found = false;
        let mut selected_class = None;
        for &path in &paths {
            control.check()?;
            let (_, relative) = path.split_once('/').expect("已筛选 smali 路径");
            if relative.starts_with(&prefix) {
                package_found = true;
                if class.as_deref() == Some(relative) {
                    selected_class = Some(path);
                }
                if evidence.len() < 10 {
                    evidence.push(path.to_owned());
                }
            }
        }
        if let Some(matching) = selected_class
            && !evidence.iter().any(|entry| entry == matching)
        {
            evidence.pop();
            evidence.push(matching.to_owned());
        }
        evidence.sort();
        findings.push(SdkFinding {
            rule: rule.clone(),
            package_found,
            class_found: class.as_ref().map(|_| selected_class.is_some()),
            evidence,
        });
    }
    control.check()?;
    Ok(findings)
}
