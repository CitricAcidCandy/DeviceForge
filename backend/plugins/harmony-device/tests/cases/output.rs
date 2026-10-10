use crate::support::{Fixture, PACKAGE, UNINSTALL_SUCCESS, device, failure, success};
use serde_json::json;

#[test]
fn packages_failure_diagnostic_in_either_stream_rejects_complete_text() {
    for (stdout, stderr) in [
        (b"com.alpha.app\nerror: private".as_slice(), b"".as_slice()),
        (b"com.alpha.app\n".as_slice(), b"failed: private".as_slice()),
        (b"com.alpha.app\n".as_slice(), b"device offline".as_slice()),
    ] {
        let fixture = Fixture::new("packages-diagnostic");
        failure(
            &fixture.run("packages", device(json!({})), stdout, stderr, 0),
            "工具依赖失败：HDC返回失败诊断",
        );
    }
}

#[test]
fn packages_invalid_utf8_in_either_stream_and_nonzero_exit_are_fixed() {
    for (stdout, stderr, code, expected) in [
        (
            &[0xff][..],
            b"".as_slice(),
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
        (
            b"com.alpha.app".as_slice(),
            &[0xff][..],
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
        (
            b"private output".as_slice(),
            b"private error".as_slice(),
            3,
            "工具依赖失败：HDC客户端执行失败，请检查部署配置",
        ),
    ] {
        let fixture = Fixture::new("packages-stream-failure");
        failure(
            &fixture.run("packages", device(json!({})), stdout, stderr, code),
            expected,
        );
    }
}

#[test]
fn uninstall_requires_own_success_suffix_on_independent_line() {
    for output in [
        b"Success\n".as_slice(),
        b"msg:install bundle successfully.\n".as_slice(),
        b"msg:uninstall bundle successfully. suffix\n".as_slice(),
        b"NotSuccess\n".as_slice(),
    ] {
        let fixture = Fixture::new("uninstall-no-success");
        failure(
            &fixture.run(
                "app.uninstall",
                device(json!({"package":PACKAGE})),
                output,
                b"",
                0,
            ),
            "工具依赖失败：HDC未返回明确成功结果",
        );
    }
}

#[test]
fn uninstall_accepts_case_insensitive_info_prefix_and_success_from_stderr() {
    for (stdout, stderr, output) in [
        (
            b"[Info]App uninstall bundle msg:UNINSTALL BUNDLE SUCCESSFULLY.\n".as_slice(),
            b"".as_slice(),
            "[Info]App uninstall bundle msg:UNINSTALL BUNDLE SUCCESSFULLY.",
        ),
        (
            b"".as_slice(),
            UNINSTALL_SUCCESS,
            "msg:uninstall bundle successfully.",
        ),
    ] {
        let fixture = Fixture::new("uninstall-success");
        assert_eq!(
            success(&fixture.run(
                "app.uninstall",
                device(json!({"package":PACKAGE})),
                stdout,
                stderr,
                0
            )),
            &json!({"output":output})
        );
    }
}

#[test]
fn uninstall_success_never_overrides_failure_in_either_stream() {
    for (stdout, stderr) in [
        (
            b"msg:uninstall bundle successfully.\nFailure\n".as_slice(),
            b"".as_slice(),
        ),
        (UNINSTALL_SUCCESS, b"error: denied".as_slice()),
        (b"failed\n".as_slice(), UNINSTALL_SUCCESS),
    ] {
        let fixture = Fixture::new("uninstall-failure-wins");
        failure(
            &fixture.run(
                "app.uninstall",
                device(json!({"package":PACKAGE})),
                stdout,
                stderr,
                0,
            ),
            "工具依赖失败：HDC返回失败诊断",
        );
    }
}

#[test]
fn each_output_stream_is_bounded_before_partial_business_result() {
    for oversized_stderr in [false, true] {
        let fixture = Fixture::new("bounded-output");
        let bytes = vec![b'x'; 1024 * 1024 + 1];
        let (stdout, stderr) = if oversized_stderr {
            (b"com.alpha.app".as_slice(), bytes.as_slice())
        } else {
            (bytes.as_slice(), b"".as_slice())
        };
        failure(
            &fixture.run("packages", device(json!({})), stdout, stderr, 0),
            "数据超过插件限额",
        );
    }
}
