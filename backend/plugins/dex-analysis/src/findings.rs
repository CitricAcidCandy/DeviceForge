use crate::{
    Error, Result,
    models::{Finding, Rule},
};
use deviceforge_android_package_core::Control;

pub(crate) fn scan(
    classes: &[String],
    rules: Vec<Rule>,
    control: &Control<'_>,
) -> Result<Vec<Finding>> {
    let mut findings = Vec::with_capacity(rules.len());
    let mut result_bytes = 1024usize;
    for rule in rules {
        control.check()?;
        let prefix = format!("{}/", rule.package_path.replace('.', "/"));
        let target = rule
            .class_name
            .as_ref()
            .map(|name| format!("{prefix}{name}"));
        let mut package_found = false;
        let mut class_found = target.as_ref().map(|_| false);
        let mut evidence = Vec::new();
        for class in classes {
            control.check()?;
            if !class.starts_with(&prefix) {
                continue;
            }
            package_found = true;
            if evidence.len() < 10 {
                evidence.push(class.clone());
            }
            if target.as_ref() == Some(class) {
                class_found = Some(true);
                if !evidence.contains(class) {
                    if evidence.len() == 10 {
                        evidence.pop();
                    }
                    evidence.push(class.clone());
                }
            }
        }
        evidence.sort_unstable();
        result_bytes += 200
            + (rule.name.len()
                + rule.package_path.len()
                + rule.class_name.as_ref().map_or(0, String::len))
                * 6;
        result_bytes += evidence
            .iter()
            .map(|name| name.len() * 6 + 3)
            .sum::<usize>();
        if result_bytes > 512 * 1024 {
            return Err(Error::TooLarge);
        }
        findings.push(Finding {
            rule,
            package_found,
            class_found,
            evidence,
        });
    }
    control.check()?;
    Ok(findings)
}
