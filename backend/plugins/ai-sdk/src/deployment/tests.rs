use super::*;
use crate::model::{NODE_VERSION, PROFILE, SDK_VERSION};
use serde_json::json;

fn deployment(root: &Path) -> Deployment {
    Deployment::from_executable(&root.join("deviceforge-ai-sdk-plugin.exe"), &[]).unwrap()
}

fn configuration(root: &Path) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "format_version":1,"profile":PROFILE,
        "node_executable":root.join("node"),"node_version":NODE_VERSION,
        "sdk_entry":root.join("sdk/dist/index.js"),"sdk_version":SDK_VERSION,
        "cli_executable":root.join("cli"),"cli_version":SDK_VERSION,
        "projects":{"demo":root.join("project")},"state_root":root.join("state"),
        "codex_home":root.join("provider"),"environment":{},"thread_options":{}
    }))
    .unwrap()
}

#[test]
fn deployment_parameters_cannot_replace_worker_or_exec_proxy() {
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("plugin.exe");
    for arguments in [
        vec![
            "--worker".into(),
            root.path().join("other.js").display().to_string(),
        ],
        vec!["--config".into(), "relative.json".into()],
        vec!["--config".into()],
        vec![
            "--config".into(),
            root.path().join("config.json").display().to_string(),
            "extra".into(),
        ],
    ] {
        assert!(Deployment::from_executable(&executable, &arguments).is_err());
    }
    assert!(Deployment::from_executable(Path::new("relative.exe"), &[]).is_err());
    let deployed = Deployment::from_executable(&executable, &[]).unwrap();
    let external = root.path().join("external").join("runtime.json");
    let configured = Deployment::from_executable(
        &executable,
        &["--config".into(), external.display().to_string()],
    )
    .unwrap();
    assert_eq!(deployed.worker_directory(), configured.worker_directory());
    assert_eq!(configured.config_path(), external);
}

#[tokio::test]
async fn complete_package_members_are_required_before_worker_launch() {
    let root = tempfile::tempdir().unwrap();
    let deployed = deployment(root.path());
    assert!(deployed.worker_entry().await.is_err());
    tokio::fs::create_dir_all(deployed.worker_directory())
        .await
        .unwrap();
    tokio::fs::write(deployed.worker_directory().join("index.js"), b"export {};")
        .await
        .unwrap();
    let error = deployed.worker_entry().await.unwrap_err();
    assert!(error.contains("worker/dist/probe.js"));
    for member in WORKER_MEMBERS {
        tokio::fs::write(deployed.worker_directory().join(member), b"export {};")
            .await
            .unwrap();
    }
    assert_eq!(
        deployed.worker_entry().await.unwrap(),
        deployed.worker_directory().join("index.js")
    );
    tokio::fs::write(deployed.worker_directory().join("sdk.js"), b"")
        .await
        .unwrap();
    assert!(
        deployed
            .worker_entry()
            .await
            .unwrap_err()
            .contains("sdk.js")
    );
}

#[tokio::test]
async fn package_directories_and_members_have_explicit_preparation_failures() {
    let root = tempfile::tempdir().unwrap();
    let deployed = deployment(root.path());
    tokio::fs::write(root.path().join("worker"), "不是目录".as_bytes())
        .await
        .unwrap();
    assert_eq!(
        deployed.worker_entry().await.unwrap_err(),
        "SDK包内固定worker目录未准备"
    );
    let other = tempfile::tempdir().unwrap();
    let deployed = deployment(other.path());
    tokio::fs::create_dir_all(deployed.worker_directory())
        .await
        .unwrap();
    for member in WORKER_MEMBERS {
        tokio::fs::write(deployed.worker_directory().join(member), b"export {};")
            .await
            .unwrap();
    }
    tokio::fs::write(
        deployed.worker_directory().join("protocol.js"),
        vec![0; 256 * 1024 + 1],
    )
    .await
    .unwrap();
    assert!(
        deployed
            .worker_entry()
            .await
            .unwrap_err()
            .contains("protocol.js")
    );
}

#[tokio::test]
async fn default_sidecar_and_explicit_configuration_preserve_provider_mapping() {
    let root = tempfile::tempdir().unwrap();
    let deployed = deployment(root.path());
    assert_eq!(
        deployed.load_config().await.unwrap_err(),
        "SDK旁置或显式部署配置未准备"
    );
    tokio::fs::write(deployed.config_path(), configuration(root.path()))
        .await
        .unwrap();
    let config = deployed.load_config().await.unwrap();
    assert_eq!(config.sdk_entry, root.path().join("sdk/dist/index.js"));
    assert_eq!(config.cli_executable, root.path().join("cli"));
    let explicit = root.path().join("external-config.json");
    tokio::fs::write(&explicit, configuration(root.path()))
        .await
        .unwrap();
    let configured = Deployment::from_executable(
        &root.path().join("plugin.exe"),
        &["--config".into(), explicit.display().to_string()],
    )
    .unwrap();
    assert_eq!(
        configured.load_config().await.unwrap().sdk_entry,
        config.sdk_entry
    );
}
