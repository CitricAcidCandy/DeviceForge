use apk_domain::Executor;
use apk_infrastructure::plugins::ProcessPlugin;
use apk_plugin_sdk::{Contribution, Manifest, PROTOCOL_VERSION};
use serde_json::json;
use tokio_util::sync::CancellationToken;
#[tokio::test]
async fn independent_process_returns_correlated_response() {
    let plugin = ProcessPlugin::new(Manifest {
        id: "echo".into(),
        version: "0.1.0".into(),
        protocol_version: PROTOCOL_VERSION,
        executable: env!("CARGO_BIN_EXE_deviceforge-echo-plugin").into(),
        args: vec![],
        performance: None,
        devices: None,
        artifacts: None,
        operations: vec![Contribution {
            name: "echo".into(),
            title: "回显".into(),
            input_schema: json!({"type":"object"}),
        }],
    })
    .unwrap();
    let input = json!({"中文":"开发者插件","number":42});
    assert_eq!(
        plugin
            .execute("plugin.echo.echo", input.clone(), CancellationToken::new())
            .await
            .unwrap(),
        input
    );
    assert_eq!(
        plugin
            .execute(
                "plugin.echo.echo",
                serde_json::Value::Null,
                CancellationToken::new()
            )
            .await
            .unwrap(),
        serde_json::Value::Null
    );
    assert!(
        plugin
            .execute("plugin.echo.unknown", json!({}), CancellationToken::new())
            .await
            .is_err()
    );
}
