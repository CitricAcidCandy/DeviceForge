use super::*;
use apk_plugin_sdk::{ArtifactContext, ArtifactInput, Manifest};
use serde_json::{Value, json};

mod protocol;

#[test]
fn terminal_manifest_uses_independent_session_contribution_and_one_hour_original_budget() {
    let manifest: Manifest = serde_json::from_str(include_str!("../manifest.json")).unwrap();
    assert_eq!(manifest.id, "terminal");
    assert_eq!(manifest.protocol_version, 4);
    assert!(manifest.operations.is_empty());
    let defaults = manifest.configuration.as_ref().unwrap().defaults.clone();
    let example: Value =
        serde_json::from_str(include_str!("../terminal.config.example.json")).unwrap();
    assert_eq!(defaults, example);
    let config = config::Config::parse(&serde_json::to_vec(&defaults).unwrap()).unwrap();
    let profile = config.profile("powershell").unwrap();
    assert_eq!(profile.executable, "powershell.exe");
    assert_eq!(
        profile.args,
        [
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-Command",
            "$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()"
        ]
    );
    assert!(config.profile("python").is_err());
    let sessions = manifest.sessions.unwrap();
    sessions.validate().unwrap();
    assert_eq!(sessions.protocol_version, 5);
    assert_eq!(sessions.operations.len(), 1);
    assert_eq!(sessions.operations[0].name, "open");
    assert_eq!(
        sessions.operations[0].execution.unwrap().total_timeout_ms,
        3_600_000
    );
}

#[test]
fn open_rejects_free_program_paths_arguments_shell_unknown_fields_and_wrong_types() {
    for input in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"profile":null}),
        json!({"profile":1}),
        json!({"profile":"tool","shell":"id"}),
        json!({"profile":"tool","executable":"node"}),
        json!({"profile":"tool","args":[]}),
        json!({"profile":"../tool"}),
        json!({"profile":"Tool"}),
        json!({"profile":"-tool"}),
        json!({"profile":"t".repeat(65)}),
        json!({"profile":"tool","terminal":null}),
    ] {
        let request = SessionOpen::new("case", "open", input);
        assert!(operation::parse(&request).is_err());
    }
    let request = SessionOpen::new("case", "open", json!({"profile":"tool-1._"}));
    assert_eq!(operation::parse(&request).unwrap().profile, "tool-1._");
    assert!(
        operation::parse(&SessionOpen::new(
            "case",
            "other",
            json!({"profile":"tool"})
        ))
        .is_err()
    );
}

#[test]
fn terminal_rejects_input_and_output_artifacts_and_does_not_choose_server_paths() {
    let mut request = SessionOpen::new("case", "open", json!({"profile":"tool"}));
    request.artifacts = Some(ArtifactContext {
        inputs: Vec::new(),
        output_directory: None,
    });
    assert!(operation::parse(&request).is_ok());
    request.artifacts.as_mut().unwrap().output_directory = Some("/unaccepted".into());
    assert!(operation::parse(&request).is_err());
    request.artifacts.as_mut().unwrap().output_directory = None;
    request
        .artifacts
        .as_mut()
        .unwrap()
        .inputs
        .push(ArtifactInput {
            field: "source".into(),
            artifact_id: "ignored".into(),
            filename: "source".into(),
            size: 0,
            sha256: "0".repeat(64),
            path: "/unaccepted".into(),
        });
    assert!(operation::parse(&request).is_err());
}

#[test]
fn terminal_open_accepts_versioned_size_and_rejects_partial_unknown_and_out_of_bounds() {
    let valid = json!({"profile":"powershell","terminal":{"protocol":"deviceforge.terminal.v1","cols":120,"rows":30}});
    assert_eq!(
        operation::parse(&SessionOpen::new("case", "open", valid))
            .unwrap()
            .terminal
            .unwrap()
            .size()
            .unwrap()
            .cols,
        120
    );
    for terminal in [
        json!({}),
        json!({"protocol":"other","cols":80,"rows":24}),
        json!({"protocol":"deviceforge.terminal.v1","cols":19,"rows":24}),
        json!({"protocol":"deviceforge.terminal.v1","cols":80,"rows":4}),
        json!({"protocol":"deviceforge.terminal.v1","cols":80,"rows":24,"shell":true}),
        json!({"protocol":"deviceforge.terminal.v1","cols":80.5,"rows":24}),
    ] {
        assert!(
            operation::parse(&SessionOpen::new(
                "case",
                "open",
                json!({"profile":"tool","terminal":terminal})
            ))
            .is_err()
        );
    }
}
