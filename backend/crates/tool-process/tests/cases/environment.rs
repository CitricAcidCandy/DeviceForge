use crate::support::{Case, decode, fixture, options};
use deviceforge_tool_process::{Environment, ToolCommand, capture};
use std::{collections::BTreeSet, ffi::OsString, path::PathBuf};
use tokio_util::sync::CancellationToken;

fn normalized(name: &str) -> String {
    if cfg!(windows) {
        name.to_uppercase()
    } else {
        name.into()
    }
}

fn parent_names() -> BTreeSet<String> {
    std::env::vars_os()
        .map(|(key, _)| normalized(&key.to_string_lossy()))
        .collect()
}

#[tokio::test]
async fn default_inherit_preserves_parent_environment_names() {
    let executable = fixture();
    let args = vec!["environment".into()];
    let command = ToolCommand::new(executable, &args);
    assert_eq!(command.environment, Environment::Inherit);
    let expected = parent_names();
    let output = capture(command, options(), CancellationToken::new())
        .await
        .expect("默认继承环境");
    let values = decode(&output.stdout);
    assert!(values.len() >= 3);
    let actual: BTreeSet<String> = values[3..].iter().map(|key| normalized(key)).collect();
    assert_eq!(actual, expected, "只核对变量名，不输出继承环境内容");
    assert!(output.stderr.is_empty());
}

#[tokio::test]
async fn restricted_environment_has_only_fixed_allowlist_and_explicit_env() {
    let executable = fixture();
    let args = vec!["environment".into()];
    let allowed: BTreeSet<String> = [
        "PATH",
        "SystemRoot",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "COMSPEC",
        "PATHEXT",
        "PSModulePath",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ]
    .into_iter()
    .map(normalized)
    .collect();
    let inherited = parent_names();
    let mut expected: BTreeSet<String> = inherited.intersection(&allowed).cloned().collect();
    expected.insert("TOOL_PROCESS_TEST_EXPLICIT".into());
    expected.insert("PATH".into());
    let mut command = ToolCommand::new(executable, &args);
    command.environment = Environment::Restricted;
    command.env.insert(
        OsString::from("TOOL_PROCESS_TEST_EXPLICIT"),
        OsString::from("显式 中文 值"),
    );
    command
        .env
        .insert(OsString::from("PATH"), OsString::from("本次显式覆盖 PATH"));
    let output = capture(command, options(), CancellationToken::new())
        .await
        .expect("受限继承与显式覆盖");
    let values = decode(&output.stdout);
    assert!(values.len() >= 3);
    assert_eq!(values[1], "显式 中文 值");
    assert_eq!(values[2], "本次显式覆盖 PATH");
    let actual: BTreeSet<String> = values[3..].iter().map(|key| normalized(key)).collect();
    assert_eq!(actual, expected, "未授权继承变量不得进入夹具环境");
}

#[tokio::test]
async fn explicit_environment_and_cwd_work_in_inherit_mode() {
    let executable = fixture();
    let case = Case::new();
    let directory = case.path().join("带空格 中文 工作目录");
    std::fs::create_dir(&directory).expect("受控工作目录");
    let args = vec!["environment".into()];
    let mut command = ToolCommand::new(executable, &args);
    command.directory = Some(&directory);
    command.env.insert(
        OsString::from("TOOL_PROCESS_TEST_EXPLICIT"),
        OsString::from("调用方显式值"),
    );
    let output = capture(command, options(), CancellationToken::new())
        .await
        .expect("指定环境和 cwd");
    let values = decode(&output.stdout);
    assert_eq!(values[1], "调用方显式值");
    let actual = std::fs::canonicalize(PathBuf::from(&values[0])).expect("实际 cwd");
    assert_eq!(actual, std::fs::canonicalize(&directory).expect("期望 cwd"));
}
