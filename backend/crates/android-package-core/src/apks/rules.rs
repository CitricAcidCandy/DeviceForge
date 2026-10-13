use super::{DeviceSpec, Selection};
use crate::{Control, Error, Result};
use std::collections::BTreeSet;

fn list(
    values: &[String],
    limit: usize,
    length: usize,
    minimum: usize,
    extra: &[u8],
    control: &Control<'_>,
) -> Result<()> {
    if values.len() < minimum || values.len() > limit {
        return Err(Error::InvalidArgument("设备规格列表数量无效"));
    }
    let mut names = BTreeSet::new();
    for value in values {
        control.check()?;
        if value.is_empty()
            || value.len() > length
            || !names.insert(value)
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || extra.contains(&byte))
        {
            return Err(Error::InvalidArgument("设备规格列表元素为空、重复或非法"));
        }
    }
    Ok(())
}

pub(super) fn spec(spec: &DeviceSpec, control: &Control<'_>) -> Result<()> {
    control.check()?;
    list(&spec.supported_abis, 16, 80, 1, b"_-", control)?;
    list(&spec.supported_locales, 100, 80, 1, b"_-", control)?;
    list(&spec.device_features, 256, 160, 0, b"_.:-", control)?;
    list(&spec.gl_extensions, 256, 160, 0, b"_.:-", control)?;
    if !(1..=10_000).contains(&spec.screen_density) || !(1..=10_000).contains(&spec.sdk_version) {
        return Err(Error::InvalidArgument("设备规格密度或SDK数值无效"));
    }
    for value in [&spec.codename, &spec.device_tier].into_iter().flatten() {
        control.check()?;
        if value.is_empty()
            || value.len() > 80
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            return Err(Error::InvalidArgument("设备代号或档位标识无效"));
        }
    }
    let text_bytes = [
        &spec.supported_abis,
        &spec.supported_locales,
        &spec.device_features,
        &spec.gl_extensions,
    ]
    .into_iter()
    .flatten()
    .map(String::len)
    .sum::<usize>()
        + spec.codename.as_ref().map_or(0, String::len)
        + spec.device_tier.as_ref().map_or(0, String::len);
    if text_bytes > 48 * 1024 {
        return Err(Error::InvalidArgument("设备规格字符串合计超过48KiB"));
    }
    control.check()
}

pub(super) fn selection(selection: &Selection, control: &Control<'_>) -> Result<()> {
    control.check()?;
    if let Some(modules) = &selection.modules {
        if modules.is_empty() || modules.len() > 128 {
            return Err(Error::InvalidArgument("模块选择须为1至128项"));
        }
        let mut names = BTreeSet::new();
        for module in modules {
            control.check()?;
            if module.is_empty()
                || module.len() > 80
                || !names.insert(module)
                || !module.as_bytes()[0].is_ascii_alphabetic()
                || !module
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                || (module == "ALL" && modules.len() != 1)
            {
                return Err(Error::InvalidArgument(
                    "模块名称非法、重复或ALL与具体模块混用",
                ));
            }
        }
    }
    control.check()
}
