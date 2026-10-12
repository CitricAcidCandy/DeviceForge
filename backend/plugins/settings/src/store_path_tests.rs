//! Windows 普通绝对长路径专项；仅在独立临时根创建配置和锁，不依赖工程或部署目录。
use super::*;
use std::{
    cell::Cell,
    ffi::OsString,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Component, Prefix},
};

fn long_root() -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().expect("无法创建隔离临时根");
    let canonical = fs::canonicalize(temporary.path()).expect("无法定位隔离临时根");
    let text = canonical.to_str().expect("合成临时路径须为有效文本");
    // 特意去掉测试根的 verbatim 前缀，覆盖部署者提供普通绝对路径的入口。
    let mut root = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else {
        PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text))
    };
    while root.as_os_str().encode_wide().count() <= 320 {
        root.push("设备工坊长路径专项-abcdefghijklmnopqrstuvwxyz0123456789");
    }
    assert!(root.is_absolute(), "测试根须为普通绝对路径");
    assert!(root.as_os_str().encode_wide().count() > 260);
    assert!(
        !matches!(
            root.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _) | Prefix::Verbatim(_))
        ),
        "测试输入不得预先带 verbatim 前缀"
    );
    fs::create_dir_all(&root).expect("无法创建隔离长路径");
    (temporary, root)
}

fn set_input(revision: &str, value: Value) -> Input {
    model::parse(
        "set",
        json!({"scope":"user","owner_id":"long-path","section":"theme",
            "expected_revision":revision,"value":value}),
    )
    .expect("合成写入输入无效")
}

fn get_input() -> Input {
    model::parse(
        "get",
        json!({"scope":"user","owner_id":"long-path","section":"theme"}),
    )
    .expect("合成读取输入无效")
}

fn owner(root: &Path) -> PathBuf {
    root.join("users/long-path")
}

fn assert_no_temporary(root: &Path) {
    let mut names = fs::read_dir(owner(root))
        .expect("无法核对配置目录")
        .map(|entry| entry.expect("无法读取配置目录项").file_name())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        vec![
            OsString::from("settings.json"),
            OsString::from("transaction.lock")
        ]
    );
}

#[test]
fn windows_long_path_initial_set_uses_verbatim_owner_and_persists() {
    let (_temporary, root) = long_root();
    let input = set_input("0", json!({"label":"长路径首次提交"}));
    let lease = Lease::acquire(&root, &input, &|| Ok(())).expect("无法获取长路径配置锁");
    assert!(matches!(
        lease.owner.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _))
    ));
    assert_eq!(lease.owner, fs::canonicalize(owner(&root)).unwrap());
    let committed = lease
        .execute(input, &|| Ok(()))
        .expect("长路径首次提交失败");
    assert_eq!(committed["revision"], "1");
    assert_eq!(committed["sections"]["theme"]["label"], "长路径首次提交");
    drop(lease);
    let stored: Value =
        serde_json::from_slice(&fs::read(owner(&root).join("settings.json")).unwrap()).unwrap();
    assert_eq!(stored, committed);
    assert_no_temporary(&root);
}

#[test]
fn windows_long_path_replace_preserves_cas_and_cancelled_bytes() {
    let (_temporary, root) = long_root();
    transact(&root, set_input("0", json!("旧内容")), &|| Ok(())).unwrap();
    let committed =
        transact(&root, set_input("1", json!("新内容")), &|| Ok(())).expect("长路径替换提交失败");
    assert_eq!(committed["revision"], "2");
    let path = owner(&root).join("settings.json");
    let original = fs::read(&path).unwrap();
    assert_eq!(
        transact(&root, set_input("1", json!("过期写入")), &|| Ok(())).unwrap_err(),
        "配置修订冲突，请重查后修改"
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    let calls = Cell::new(0);
    let cancelled = transact(&root, set_input("2", json!("取消写入")), &|| {
        calls.set(calls.get() + 1);
        if calls.get() >= 5 {
            Err("长路径专项取消".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(cancelled.unwrap_err(), "长路径专项取消");
    assert_eq!(fs::read(&path).unwrap(), original);
    let read = transact(&root, get_input(), &|| Ok(())).unwrap();
    assert_eq!(read["revision"], "2");
    assert_eq!(read["value"], "新内容");
    assert_no_temporary(&root);
}

#[test]
fn windows_long_path_failed_replace_keeps_original_and_removes_temporary() {
    let (_temporary, root) = long_root();
    transact(&root, set_input("0", json!("旧内容")), &|| Ok(())).unwrap();
    let path = owner(&root).join("settings.json");
    let original = fs::read(&path).unwrap();
    // 允许读取与写入共享，独立禁止删除共享；读阶段成功后，原子替换确定失败。
    let guard = OpenOptions::new()
        .read(true)
        .share_mode(0x00000001 | 0x00000002)
        .open(&path)
        .expect("无法建立提交失败的共享句柄");
    assert_eq!(
        transact(&root, set_input("1", json!("失败写入")), &|| Ok(())).unwrap_err(),
        "配置提交失败，保留原文件"
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_no_temporary(&root);
    drop(guard);
    let committed = transact(&root, set_input("1", json!("解除障碍后提交")), &|| Ok(())).unwrap();
    assert_eq!(committed["revision"], "2");
    assert_eq!(committed["sections"]["theme"], "解除障碍后提交");
    assert_no_temporary(&root);
}
