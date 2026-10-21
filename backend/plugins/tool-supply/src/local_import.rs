//! 本地导入只读取宿主授权的输入产物，不读取清单来源或访问下载地址。
use crate::{
    budget::Budget,
    cache,
    config::Config,
    error::{Error, Result},
    input::valid_id,
    manifest::{Manifest, Module},
    operations, storage, transaction,
};
use apk_plugin_sdk::{ArtifactContext, ArtifactInput};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Import {
    archive_artifact_id: String,
    module_id: String,
    manifest: Manifest,
}

pub(crate) fn parse(value: Value) -> Result<Import> {
    let input: Import =
        serde_json::from_value(value).map_err(|_| Error::Invalid("本地工具导入结构错误"))?;
    let bytes = input.archive_artifact_id.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        || !valid_id(&input.module_id)
    {
        return Err(Error::Invalid("导入要求有效的产物 UUID 和模块 ID"));
    }
    Ok(input)
}

fn authorized<'a>(
    input: &Import,
    artifacts: &'a Option<ArtifactContext>,
) -> Result<&'a ArtifactInput> {
    let artifacts = artifacts
        .as_ref()
        .ok_or(Error::Invalid("缺少宿主输入产物上下文"))?;
    if artifacts.inputs.len() != 1 {
        return Err(Error::Invalid("本地工具导入要求唯一输入产物副本"));
    }
    let artifact = &artifacts.inputs[0];
    if artifact.field != "/archive_artifact_id"
        || artifact.artifact_id != input.archive_artifact_id
        || artifact.filename.len() > 255
        || !artifact.filename.to_ascii_lowercase().ends_with(".zip")
        || artifact.filename.contains(['/', '\\'])
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(Error::Invalid("输入产物关联或 ZIP 元数据无效"));
    }
    Ok(artifact)
}

pub(crate) async fn execute(
    input: Import,
    artifacts: Option<ArtifactContext>,
    config: &Config,
    budget: &Budget,
) -> Result<Value> {
    budget.check()?;
    input.manifest.validate(config)?;
    cache::canonical(&input.manifest)?;
    let module = input.manifest.module(&input.module_id)?;
    let artifact = authorized(&input, &artifacts)?;
    let _lock = storage::ModuleLock::acquire(config, &input.module_id, budget)?;
    let changed = operations::requires_install(config, module, budget)?;
    if !changed {
        // 相同版本也核对所选上传内容；只读取，不创建安装事务。
        let checksum = archive(artifact, module, None, budget)?;
        return Ok(json!({"module_id":module.name,"version":module.version,
            "sha256":checksum,"changed":false}));
    }
    let transaction = transaction::Transaction::create(config, &input.module_id, budget)?;
    let outcome = async {
        let checksum = archive(
            artifact,
            module,
            Some(&transaction.path.join("archive.zip")),
            budget,
        )?;
        operations::install_archive(
            config,
            module,
            &input.manifest.manifest_version,
            &transaction,
            checksum,
            budget,
        )
        .await
    }
    .await;
    transaction.finish(config, outcome)
}

fn archive(
    artifact: &ArtifactInput,
    module: &Module,
    destination: Option<&Path>,
    budget: &Budget,
) -> Result<String> {
    budget.check()?;
    if artifact.size != module.size {
        return Err(Error::Invalid("输入产物长度与清单不一致"));
    }
    if !artifact.sha256.eq_ignore_ascii_case(&module.sha256) {
        return Err(Error::Checksum);
    }
    let path = Path::new(&artifact.path);
    if !path.is_absolute() {
        return Err(Error::Invalid("宿主输入产物副本必须为绝对路径"));
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Io("检查输入产物失败"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("输入产物副本必须为普通文件"));
    }
    let mut source = File::open(path).map_err(|_| Error::Io("打开输入产物失败"))?;
    let opened = source
        .metadata()
        .map_err(|_| Error::Io("检查输入产物失败"))?;
    if !opened.is_file() || opened.len() != module.size || metadata.len() != module.size {
        return Err(Error::Invalid("输入产物实际长度与清单不一致"));
    }
    let mut target = destination
        .map(|path| {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|_| Error::Io("创建本地归档暂存失败"))
        })
        .transpose()?;
    let mut total = 0u64;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        budget.check()?;
        let count = source
            .read(&mut buffer)
            .map_err(|_| Error::Io("读取输入产物失败"))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .filter(|size| *size <= module.size)
            .ok_or(Error::TooLarge)?;
        if let Some(file) = &mut target {
            file.write_all(&buffer[..count])
                .map_err(|_| Error::Io("写入本地归档暂存失败"))?;
        }
        hash.update(&buffer[..count]);
    }
    if total != module.size {
        return Err(Error::Invalid("输入产物未达到清单声明长度"));
    }
    let checksum = format!("{:x}", hash.finalize());
    if !checksum.eq_ignore_ascii_case(&module.sha256) {
        return Err(Error::Checksum);
    }
    if let Some(file) = target {
        file.sync_all()
            .map_err(|_| Error::Io("持久化本地归档暂存失败"))?;
    }
    budget.check()?;
    Ok(checksum)
}

#[cfg(test)]
#[path = "local_import_tests.rs"]
mod tests;
