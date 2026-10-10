use crate::support::{Fixture, PACKAGE, SERIAL, UNINSTALL_SUCCESS, device, success};
use serde_json::json;
use std::fs;

#[test]
fn packages_has_exact_target_shell_argv_and_preserves_complete_trimmed_text() {
    let fixture = Fixture::new("packages-business");
    let reply = fixture.run(
        "packages",
        device(json!({})),
        b" \ncom.alpha.app\ncom.beta.app \n",
        b"",
        0,
    );
    assert_eq!(fixture.argv(), ["-t", SERIAL, "shell", "bm", "dump", "-a"]);
    assert_eq!(
        success(&reply),
        &json!({"output":"com.alpha.app\ncom.beta.app"})
    );
    assert!(!fixture.root.join("unused-output").exists());
}

#[test]
fn uninstall_keeps_legal_failed_package_and_does_not_request_extra_privileges() {
    let fixture = Fixture::new("uninstall-business");
    let reply = fixture.run(
        "app.uninstall",
        device(json!({"package":PACKAGE})),
        UNINSTALL_SUCCESS,
        b"",
        0,
    );
    assert_eq!(fixture.argv(), ["-t", SERIAL, "uninstall", PACKAGE]);
    assert_eq!(
        success(&reply),
        &json!({"output":"msg:uninstall bundle successfully."})
    );
    assert!(!fixture.root.join("unused-output").exists());
}

#[test]
fn empty_packages_is_explicit_empty_output_and_never_an_empty_device_array() {
    let fixture = Fixture::new("packages-empty");
    let reply = fixture.run("packages", device(json!({})), b" \r\n", b"", 0);
    assert_eq!(success(&reply), &json!({"output":""}));
}

#[test]
fn subprocess_does_not_inherit_host_tool_or_token_environment() {
    let fixture = Fixture::new("restricted-environment");
    let reply = fixture.run("packages", device(json!({})), b"com.alpha.app\n", b"", 0);
    assert_eq!(success(&reply), &json!({"output":"com.alpha.app"}));
    assert_eq!(
        fs::read(fixture.root.join("call-01/restricted-flags.bin")).unwrap(),
        [0, 0, 0, 0]
    );
}
