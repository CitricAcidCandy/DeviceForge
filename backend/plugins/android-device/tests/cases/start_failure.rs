//! 启动失败后只读辨因，不重发启动，也不把包名错误归咎于部署配置。
use crate::support::{self, Fixture, failure};
use serde_json::json;
use std::time::Duration;

fn diagnosed_failure(packages: &[u8], activity: Option<&[u8]>, expected: &str) {
    let fixture = Fixture::new("start-failure-diagnosis");
    fixture.plan(1, b"", b"private adb stderr must not escape", 252);
    fixture.plan(2, packages, b"", 0);
    fixture.release(2);
    if let Some(activity) = activity {
        fixture.plan(3, activity, b"", 0);
        fixture.release(3);
    }
    let mut running = fixture.begin(
        "app.start",
        support::device(json!({"package":support::PACKAGE})),
    );
    running.start(Duration::from_secs(20));
    let launch = fixture.wait_tool(1);
    fixture.release(1);
    let reply = running.complete();
    launch.assert_exited();
    failure(&reply, expected);
    fixture.assert_calls(if activity.is_some() { 3 } else { 2 });
    assert_eq!(
        fixture.argv(2),
        [
            "-s",
            support::SERIAL,
            "shell",
            "pm",
            "list",
            "packages",
            "--user",
            "current",
            support::PACKAGE
        ]
    );
    if activity.is_some() {
        assert_eq!(
            fixture.argv(3),
            [
                "-s",
                support::SERIAL,
                "shell",
                "cmd",
                "package",
                "resolve-activity",
                "--brief",
                "--user",
                "current",
                "-a",
                "android.intent.action.MAIN",
                "-c",
                "android.intent.category.LAUNCHER",
                "-p",
                support::PACKAGE,
            ]
        );
    }
    let serialized = reply.to_string();
    assert!(!serialized.contains("private adb stderr"));
    assert!(!serialized.contains("检查部署配置"));
}

#[test]
fn missing_package_is_reported_without_replaying_start() {
    diagnosed_failure(
        b"",
        None,
        "应用启动失败：当前设备未安装此应用，请选择已安装应用，或先完成安装",
    );
}

#[test]
fn package_prefix_is_not_treated_as_the_requested_package() {
    diagnosed_failure(
        b"package:com.failed.example.beta\n",
        None,
        "应用启动失败：当前设备未安装此应用，请选择已安装应用，或先完成安装",
    );
}

#[test]
fn installed_package_without_launcher_is_reported_separately() {
    diagnosed_failure(
        b"package:com.failed.example\n",
        Some(b"No activity found\n"),
        "应用启动失败：此应用没有可用的桌面启动入口，请检查应用是否被停用或需从其他应用打开",
    );
}

#[test]
fn installed_package_with_launcher_does_not_blame_deployment_configuration() {
    diagnosed_failure(
        b"package:com.failed.example\n",
        Some(b"com.failed.example/.MainActivity\n"),
        "应用启动失败：设备未接受应用启动，请确认应用状态后重试",
    );
}

#[test]
fn unreliable_diagnosis_preserves_original_failure() {
    for (stdout, stderr, code) in [
        (b"".as_slice(), b"device offline".as_slice(), 1),
        (b"".as_slice(), b"adb: device offline".as_slice(), 0),
        (b"not a package listing".as_slice(), b"".as_slice(), 0),
        (b"\xff".as_slice(), b"".as_slice(), 0),
    ] {
        let fixture = Fixture::new("start-unreliable-diagnosis");
        fixture.plan(1, b"", b"private launch diagnostic", 252);
        fixture.plan(2, stdout, stderr, code);
        fixture.release(2);
        let mut running = fixture.begin(
            "app.start",
            support::device(json!({"package":support::PACKAGE})),
        );
        running.start(Duration::from_secs(20));
        let launch = fixture.wait_tool(1);
        fixture.release(1);
        failure(
            &running.complete(),
            "工具依赖失败：设备连接工具执行失败，目前无法确认具体原因，请查看任务详情",
        );
        launch.assert_exited();
        fixture.assert_calls(2);
    }
}

fn interrupted_diagnosis(timeout: bool) {
    let fixture = Fixture::new("start-interrupted-diagnosis");
    fixture.plan(1, b"", b"private launch diagnostic", 252);
    fixture.plan(2, b"", b"", 0);
    let mut running = fixture.begin(
        "app.start",
        support::device(json!({"package":support::PACKAGE})),
    );
    running.start(Duration::from_secs(if timeout { 2 } else { 20 }));
    let launch = fixture.wait_tool(1);
    fixture.release(1);
    let diagnostic = fixture.wait_tool(2);
    if !timeout {
        running.cancel("cancelled");
    }
    failure(
        &running.complete(),
        if timeout {
            support::TOTAL_TIMEOUT
        } else {
            support::CANCELLED
        },
    );
    launch.assert_exited();
    diagnostic.assert_exited();
    fixture.assert_calls(2);
}

#[test]
fn cancellation_stops_diagnosis_without_replaying_start() {
    interrupted_diagnosis(false);
}

#[test]
fn diagnosis_consumes_original_deadline_without_renewal() {
    interrupted_diagnosis(true);
}
