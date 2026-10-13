use crate::{config::Config, model::TEXT_BYTE_LIMIT};
use std::collections::BTreeSet;

pub struct Redactor {
    values: Vec<String>,
}

impl Redactor {
    pub fn for_config(config: &Config) -> Self {
        let mut values: BTreeSet<String> = config
            .environment
            .values()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect();
        for path in [
            &config.node_executable,
            &config.sdk_entry,
            &config.cli_executable,
            &config.state_root,
            &config.codex_home,
        ] {
            values.insert(path.to_string_lossy().into_owned());
        }
        for path in config.projects.values() {
            values.insert(path.to_string_lossy().into_owned());
        }
        let mut values: Vec<_> = values.into_iter().collect();
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        Self { values }
    }

    pub fn text(&self, text: &str) -> Result<String, String> {
        if text.len() > TEXT_BYTE_LIMIT {
            return Err("SDK公开正文超限".into());
        }
        let mut parts = vec![Some(text)];
        for value in &self.values {
            let mut next = Vec::new();
            for part in parts {
                match part {
                    None => next.push(None),
                    Some(part) => {
                        for (index, fragment) in part.split(value).enumerate() {
                            if index != 0 {
                                next.push(None);
                            }
                            if !fragment.is_empty() {
                                next.push(Some(fragment));
                            }
                        }
                    }
                }
            }
            let bytes = next
                .iter()
                .try_fold(0usize, |bytes, part| {
                    bytes.checked_add(part.unwrap_or("[已隐藏]").len())
                })
                .ok_or("SDK脱敏计数溢出")?;
            if bytes > TEXT_BYTE_LIMIT {
                return Err("SDK脱敏正文超限".into());
            }
            parts = next;
        }
        Ok(parts
            .into_iter()
            .map(|part| part.unwrap_or("[已隐藏]"))
            .collect())
    }
}
