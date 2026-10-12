//! 文件锁覆盖读取、修订判断和原子提交；不覆盖任意服务器路径。
use crate::model::{self, Input};
use deviceforge_plugin_runtime::InvocationContext;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

const LIMIT: usize = 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    format_version: u32,
    revision: String,
    sections: BTreeMap<String, Value>,
}

fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "无法创建配置目录".to_owned())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法检查配置目录".to_owned())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("配置目录不得为链接".into());
    }
    Ok(())
}

pub(crate) fn execute(
    root: &Path,
    input: Input,
    context: &InvocationContext,
) -> Result<Value, String> {
    transact(root, input, &|| {
        context.check().map_err(|error| error.to_string())
    })
}

fn transact(
    root: &Path,
    input: Input,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    Lease::acquire(root, &input, check)?.execute(input, check)
}

// 同一归属的远端写入与本地事务共享锁，不在网络请求期间释放CAS资格。
pub(crate) struct Lease {
    _lock: File,
    owner: PathBuf,
}

impl Lease {
    pub(crate) fn acquire(
        root: &Path,
        input: &Input,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        check()?;
        directory(root)?;
        let scoped = root.join(input.scope.directory());
        directory(&scoped)?;
        let owner = scoped.join(&input.owner_id);
        directory(&owner)?;
        // tempfile 的 Windows 提交直接调用 Win32，不像 std 创建文件时自动处理长路径。
        // 先完成受控目录及链接检查，再规范化现存 owner，让临时源和目标都带 verbatim 前缀。
        #[cfg(windows)]
        let owner = fs::canonicalize(&owner).map_err(|_| "无法规范化配置目录".to_owned())?;
        let lock_path = owner.join("transaction.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|entry| entry.file_type().is_symlink()) {
            return Err("配置锁不得为链接".into());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "无法打开配置事务锁".to_owned())?;
        loop {
            check()?;
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return Err("配置事务锁失败".into()),
            }
        }
        check()?;
        Ok(Self { _lock: lock, owner })
    }

    pub(crate) fn execute(
        &self,
        input: Input,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Value, String> {
        check()?;
        let path = self.owner.join("settings.json");
        let mut document = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Document {
                format_version: 1,
                revision: "0".into(),
                sections: BTreeMap::new(),
            },
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= LIMIT as u64 =>
            {
                let raw = fs::read(&path).map_err(|_| "无法读取配置内容".to_owned())?;
                serde_json::from_slice::<Document>(&raw)
                    .map_err(|_| "配置文档损坏，保留原文件".to_owned())?
            }
            _ => return Err("配置文档类型或大小无效".into()),
        };
        if document.format_version != 1
            || document.sections.len() > 64
            || document
                .sections
                .keys()
                .any(|section| !model::identity(section))
        {
            return Err("配置版本不受支持，保留原文件".into());
        }
        let current = model::revision(&document.revision)?;
        if input.operation == "list" {
            return Ok(
                json!({"format_version":1,"revision":document.revision,"sections":document.sections}),
            );
        }
        if input.operation == "get" {
            let section = input.section.ok_or("读取配置缺少配置区")?;
            let value = document
                .sections
                .get(&section)
                .cloned()
                .ok_or("配置区不存在")?;
            return Ok(
                json!({"format_version":1,"revision":document.revision,"section":section,"value":value}),
            );
        }
        if input
            .expected_revision
            .as_deref()
            .map(model::revision)
            .transpose()?
            != Some(current)
        {
            return Err("配置修订冲突，请重查后修改".into());
        }
        match input.operation.as_str() {
            "set" => {
                document.sections.insert(
                    input.section.ok_or("配置区缺失")?,
                    input.value.unwrap_or(Value::Null),
                );
            }
            "delete" => {
                document
                    .sections
                    .remove(&input.section.ok_or("配置区缺失")?);
            }
            "import" => {
                document
                    .sections
                    .extend(input.sections.ok_or("导入配置缺失")?);
            }
            _ => return Err("未知配置操作".into()),
        }
        if document.sections.len() > 64 {
            return Err("配置区数量超限".into());
        }
        document.revision = current.checked_add(1).ok_or("配置修订已耗尽")?.to_string();
        let raw = serde_json::to_vec(&document).map_err(|_| "配置序列化失败".to_owned())?;
        if raw.len() > LIMIT {
            return Err("配置内容超限".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.owner)
            .map_err(|_| "无法准备配置提交".to_owned())?;
        temporary
            .write_all(&raw)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "无法写入配置事务文件".to_owned())?;
        check()?;
        temporary
            .persist(&path)
            .map_err(|_| "配置提交失败，保留原文件".to_owned())?;
        Ok(json!({"format_version":1,"revision":document.revision,"sections":document.sections}))
    }
}

#[cfg(all(test, windows))]
#[path = "store_path_tests.rs"]
mod path_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn input(operation: &str, value: Value) -> Input {
        model::parse(operation, value).unwrap()
    }

    #[test]
    fn user_workspace_isolated_and_stale_revision_preserves_original() {
        let root = tempfile::tempdir().unwrap();
        let user = json!({"scope":"user","owner_id":"lemon","section":"theme","expected_revision":"0","value":{"mode":"dark"}});
        assert_eq!(
            transact(root.path(), input("set", user.clone()), &|| Ok(())).unwrap()["revision"],
            "1"
        );
        assert!(transact(root.path(), input("set", user), &|| Ok(())).is_err());
        let workspace = input("list", json!({"scope":"workspace","owner_id":"lemon"}));
        assert_eq!(
            transact(root.path(), workspace, &|| Ok(())).unwrap()["revision"],
            "0"
        );
        let user = input(
            "get",
            json!({"scope":"user","owner_id":"lemon","section":"theme"}),
        );
        assert_eq!(
            transact(root.path(), user, &|| Ok(())).unwrap()["value"]["mode"],
            "dark"
        );
    }

    #[test]
    fn legacy_sections_import_and_future_version_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let imported = input(
            "import",
            json!({"scope":"workspace","owner_id":"demo","expected_revision":"0","sections":{"deviceInfo":[],"dynamicSnalysisHooks":{}}}),
        );
        assert_eq!(
            transact(root.path(), imported, &|| Ok(())).unwrap()["sections"]["deviceInfo"],
            json!([])
        );
        let path = root.path().join("workspaces/demo/settings.json");
        let original = br#"{"format_version":9,"revision":"1","sections":{}}"#;
        fs::write(&path, original).unwrap();
        assert!(
            transact(
                root.path(),
                input("list", json!({"scope":"workspace","owner_id":"demo"})),
                &|| Ok(())
            )
            .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn rejects_paths_noncanonical_revision_and_missing_cas() {
        for owner in ["../escape", "a/b", "a\\b", "-bad"] {
            assert!(model::parse("list", json!({"scope":"user","owner_id":owner})).is_err());
        }
        for revision in ["01", "+1", "-1", " 1", "1 ", "18446744073709551616"] {
            assert!(model::revision(revision).is_err());
        }
        assert_eq!(model::revision("18446744073709551615").unwrap(), u64::MAX);
        assert!(
            model::parse(
                "set",
                json!({"scope":"user","owner_id":"demo","section":"theme","value":null})
            )
            .is_err()
        );
    }

    #[test]
    fn explicit_null_is_stored_and_parallel_cas_has_one_winner() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_owned();
        let mut workers = Vec::new();
        for _ in 0..2 {
            let path = path.clone();
            workers.push(std::thread::spawn(move || {
                transact(&path, input("set", json!({"scope":"user","owner_id":"demo","section":"nullable","expected_revision":"0","value":null})), &|| Ok(())).is_ok()
            }));
        }
        assert_eq!(
            workers
                .into_iter()
                .filter_map(|worker| worker.join().ok())
                .filter(|ok| *ok)
                .count(),
            1
        );
        let read = transact(
            &path,
            input(
                "get",
                json!({"scope":"user","owner_id":"demo","section":"nullable"}),
            ),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(read["revision"], "1");
        assert!(read.get("value").unwrap().is_null());
    }

    #[test]
    fn operation_specific_fields_match_manifest_and_cancel_preserves_original() {
        for (operation, extra) in [
            ("list", json!({"section":"theme"})),
            ("get", json!({"value":null})),
            ("delete", json!({"value":null})),
            ("import", json!({"section":"theme"})),
        ] {
            let mut value = json!({"scope":"user","owner_id":"demo"});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(model::parse(operation, value).is_err());
        }
        let root = tempfile::tempdir().unwrap();
        let write = input(
            "set",
            json!({"scope":"user","owner_id":"demo","section":"theme","expected_revision":"0","value":"old"}),
        );
        transact(root.path(), write.clone(), &|| Ok(())).unwrap();
        let path = root.path().join("users/demo/settings.json");
        let original = fs::read(&path).unwrap();
        let mut update = write;
        update.expected_revision = Some("1".into());
        update.value = Some(json!("new"));
        let checks = std::cell::Cell::new(0);
        assert!(
            transact(root.path(), update, &|| {
                checks.set(checks.get() + 1);
                if checks.get() >= 5 {
                    Err("取消".into())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), original);
    }
}
