//! Windows 普通绝对长路径专项；仅使用隔离临时根和合成线程状态。
use super::*;
use std::{
    ffi::OsString,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Component, Prefix},
};

const ID: &str = "12345678-1234-1234-1234-123456789abc";
const PROJECT: &str = "long-path-project";

fn long_root() -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().expect("无法创建隔离临时根");
    let canonical = fs::canonicalize(temporary.path()).expect("无法定位隔离临时根");
    let text = canonical.to_str().expect("合成临时路径须为有效文本");
    // 移除临时根的 verbatim 前缀，覆盖部署者提供普通绝对路径的入口。
    let mut root = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else {
        PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text))
    };
    while root.as_os_str().encode_wide().count() <= 320 {
        root.push("设备工坊会话长路径专项-abcdefghijklmnopqrstuvwxyz0123456789");
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
    fs::create_dir_all(root.join("project")).expect("无法创建隔离长路径及合成项目目录");
    (temporary, root)
}

fn state_path(root: &Path) -> PathBuf {
    root.join("threads").join(format!("{ID}.json"))
}

fn read_state(root: &Path) -> Snapshot {
    let raw = fs::read(state_path(root)).expect("无法读取长路径会话字节");
    serde_json::from_slice(&raw).expect("无法解析长路径会话状态")
}

fn assert_state(state: &Snapshot, project: &Path, turns: u64, uncertain: bool, closed: bool) {
    assert_eq!(state.format_version, 1);
    assert_eq!(state.project_id, PROJECT);
    assert_eq!(state.project_root.as_path(), project);
    assert_eq!(state.thread_id, ID);
    assert_eq!(state.turns, turns);
    assert_eq!(state.uncertain, uncertain);
    assert_eq!(state.closed, closed);
}

fn assert_no_temporary(root: &Path) {
    let mut names = fs::read_dir(root.join("threads"))
        .expect("无法核对长路径会话目录")
        .map(|entry| entry.expect("无法读取会话目录项").file_name())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        vec![
            OsString::from(format!("{ID}.json")),
            OsString::from(format!("{ID}.lock"))
        ]
    );
}

#[test]
fn windows_long_path_initial_complete_persists_and_reopens() {
    let (_temporary, root) = long_root();
    let project = root.join("project");
    let mut lease =
        Lease::acquire(&root, ID, PROJECT, &project, &|| Ok(())).expect("无法获取长路径会话锁");
    assert!(lease.snapshot.is_none());
    lease
        .complete(PROJECT.into(), project.clone(), ID.into(), &|| Ok(()))
        .expect("长路径首次会话提交失败");
    // 先执行真实原子提交，再检查内部路径，修前失败须落在提交阶段。
    assert!(matches!(
        lease.path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _))
    ));
    assert_eq!(
        lease.path.parent().unwrap(),
        fs::canonicalize(root.join("threads")).unwrap()
    );
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 1, false, false);
    assert_state(&read_state(&root), &project, 1, false, false);
    drop(lease);
    let reopened = Lease::acquire(&root, &ID.to_ascii_uppercase(), PROJECT, &project, &|| {
        Ok(())
    })
    .expect("长路径持久会话重新获取失败");
    assert_state(
        reopened.snapshot.as_ref().unwrap(),
        &project,
        1,
        false,
        false,
    );
    assert_no_temporary(&root);
}

#[test]
fn windows_long_path_replace_and_cancel_preserve_durable_state() {
    let (_temporary, root) = long_root();
    let project = root.join("project");
    let mut lease = Lease::acquire(&root, ID, PROJECT, &project, &|| Ok(())).unwrap();
    lease
        .complete(PROJECT.into(), project.clone(), ID.into(), &|| Ok(()))
        .expect("长路径首次会话提交失败");
    lease.begin(&|| Ok(())).expect("长路径轮次开始提交失败");
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 1, true, false);
    assert_state(&read_state(&root), &project, 1, true, false);
    let original = fs::read(state_path(&root)).unwrap();
    assert_eq!(
        lease
            .complete(PROJECT.into(), project.clone(), ID.into(), &|| {
                Err("长路径会话取消".into())
            })
            .unwrap_err(),
        "长路径会话取消"
    );
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 1, true, false);
    assert_eq!(fs::read(state_path(&root)).unwrap(), original);
    assert_no_temporary(&root);
    assert_eq!(
        lease.close(&|| Err("长路径会话取消".into())).unwrap_err(),
        "长路径会话取消"
    );
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 1, true, false);
    assert_eq!(fs::read(state_path(&root)).unwrap(), original);
    assert_no_temporary(&root);
    lease
        .complete(PROJECT.into(), project.clone(), ID.into(), &|| Ok(()))
        .expect("长路径替换会话提交失败");
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 2, false, false);
    drop(lease);
    let mut reopened = Lease::acquire(&root, ID, PROJECT, &project, &|| Ok(())).unwrap();
    assert_state(
        reopened.snapshot.as_ref().unwrap(),
        &project,
        2,
        false,
        false,
    );
    reopened.close(&|| Ok(())).expect("长路径会话关闭提交失败");
    drop(reopened);
    let mut closed = Lease::acquire(&root, ID, PROJECT, &project, &|| Ok(())).unwrap();
    assert_state(closed.snapshot.as_ref().unwrap(), &project, 2, false, true);
    assert_state(&read_state(&root), &project, 2, false, true);
    assert_eq!(closed.begin(&|| Ok(())).unwrap_err(), "AI线程已关闭");
    assert_no_temporary(&root);
}

#[test]
fn windows_long_path_failed_replace_keeps_original_and_cleans_temporary() {
    let (_temporary, root) = long_root();
    let project = root.join("project");
    let mut lease = Lease::acquire(&root, ID, PROJECT, &project, &|| Ok(())).unwrap();
    lease
        .complete(PROJECT.into(), project.clone(), ID.into(), &|| Ok(()))
        .expect("长路径首次会话提交失败");
    lease.begin(&|| Ok(())).unwrap();
    let original = fs::read(state_path(&root)).unwrap();
    // 允许读写共享但禁止删除共享，让真实原子替换失败，不注入模拟存储。
    let guard = OpenOptions::new()
        .read(true)
        .share_mode(0x00000001 | 0x00000002)
        .open(state_path(&root))
        .expect("无法建立会话提交失败的共享句柄");
    assert_eq!(
        lease
            .complete(PROJECT.into(), project.clone(), ID.into(), &|| Ok(()))
            .unwrap_err(),
        "AI会话提交失败，保留原文件"
    );
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 1, true, false);
    assert_state(&read_state(&root), &project, 1, true, false);
    assert_eq!(fs::read(state_path(&root)).unwrap(), original);
    assert_no_temporary(&root);
    drop(guard);
    lease
        .complete(PROJECT.into(), project.clone(), ID.into(), &|| Ok(()))
        .expect("解除共享句柄障碍后会话提交失败");
    assert_state(lease.snapshot.as_ref().unwrap(), &project, 2, false, false);
    assert_state(&read_state(&root), &project, 2, false, false);
    assert_no_temporary(&root);
}
