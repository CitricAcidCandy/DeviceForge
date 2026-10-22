//! 统一发布复用既有便携归档门禁，普通工具使用不带 npm 前缀的根目录。
use apk_domain::{
    Error, Result, plugin_installations::ResourceFormat, plugin_packages::PackageFormat,
};
use std::{fs, path::Path};
pub(super) fn extract(
    input: &Path,
    root: &Path,
    format: ResourceFormat,
    component: bool,
) -> Result<()> {
    let format = match format {
        ResourceFormat::Zip => PackageFormat::Zip,
        ResourceFormat::Tgz => PackageFormat::Tgz,
        ResourceFormat::File => {
            if component {
                return Err(Error::Invalid("组件不能使用单文件格式".into()));
            }
            fs::copy(input, root.join("payload"))
                .map_err(|_| Error::Storage("工具文件暂存失败".into()))?;
            return Ok(());
        }
    };
    if component {
        crate::plugin_packages::archive::extract_release_component(input, root, format)
    } else {
        crate::plugin_packages::archive::extract_release(input, root, format)
    }
}
