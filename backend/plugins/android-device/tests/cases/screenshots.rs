use crate::support::{
    self, Fixture,
    artifacts::{self, png},
    failure,
};
use serde_json::json;
use std::{fs, time::Duration};

fn request(fixture: &Fixture) -> (serde_json::Value, std::path::PathBuf) {
    artifacts::screenshot(fixture)
}

#[test]
fn screenshot_uses_fixed_argv_and_publishes_only_authorized_png() {
    let fixture = Fixture::new("screenshot-success");
    let (request, output_root) = request(&fixture);
    let image = png(45);
    let reply = artifacts::run(&fixture, request, &image, b"", 0);
    assert_eq!(
        fixture.argv(1),
        vec!["-s", support::SERIAL, "exec-out", "screencap", "-p"]
    );
    artifacts::screenshot_result(&reply);
    let target = output_root.join("screenshot.png");
    assert_eq!(fs::read(target).unwrap(), image);
    assert_eq!(fs::read_dir(&output_root).unwrap().count(), 1);
}

#[test]
fn screenshot_requires_minimum_png_signature_ihdr_dimensions_and_45_bytes() {
    for (mut image, expected) in [
        (vec![0; 44], "输入无效：PNG标识、IHDR或尺寸无效"),
        (vec![0; 45], "输入无效：PNG标识、IHDR或尺寸无效"),
        (png(45), "输入无效：PNG标识、IHDR或尺寸无效"),
    ] {
        if image.len() == 45 {
            image[19] = 0;
        }
        let fixture = Fixture::new("screenshot-header");
        let (request, output_root) = request(&fixture);
        let reply = artifacts::run(&fixture, request, &image, b"", 0);
        failure(&reply, expected);
        assert!(!output_root.join("screenshot.png").exists());
    }
}

#[test]
fn screenshot_accepts_extra_bytes_without_crc_or_full_decode() {
    let fixture = Fixture::new("screenshot-extra-bytes");
    let (request, output_root) = request(&fixture);
    let mut image = png(45);
    image[30] = 0xff;
    let reply = artifacts::run(&fixture, request, &image, b"", 0);
    artifacts::screenshot_result(&reply);
    assert_eq!(fs::read(output_root.join("screenshot.png")).unwrap(), image);
}

#[test]
fn screenshot_stdout_limit_is_64_mib_and_stderr_limit_is_1_mib() {
    for (stdout, stderr) in [
        (vec![b'x'; 64 * 1024 * 1024 + 1], Vec::new()),
        (png(45), vec![b'e'; 1024 * 1024 + 1]),
    ] {
        let fixture = Fixture::new("screenshot-output-limit");
        let (request, output_root) = request(&fixture);
        let reply = artifacts::run(&fixture, request, &stdout, &stderr, 0);
        failure(&reply, "数据超过插件限额");
        assert!(!output_root.join("screenshot.png").exists());
    }
}

#[test]
fn screenshot_existing_target_is_never_overwritten() {
    let fixture = Fixture::new("screenshot-existing-target");
    let (request, output_root) = request(&fixture);
    let target = output_root.join("screenshot.png");
    fs::write(&target, b"old-target").unwrap();
    let reply = artifacts::run(&fixture, request, &png(45), b"", 0);
    failure(&reply, "文件操作失败：资源文件无法独占创建");
    assert_eq!(fs::read(target).unwrap(), b"old-target");
}

#[test]
fn screenshot_nonzero_exit_does_not_publish() {
    let fixture = Fixture::new("screenshot-tool-error");
    let (request, output_root) = request(&fixture);
    let reply = artifacts::run(&fixture, request, &png(45), b"", 7);
    failure(
        &reply,
        "工具依赖失败：设备连接工具执行失败，目前无法确认具体原因，请查看任务详情",
    );
    assert!(!output_root.join("screenshot.png").exists());
}

#[test]
fn screenshot_output_directory_must_be_absolute_regular_non_linked_directory() {
    let fixture = Fixture::new("screenshot-output-path");
    let mut request = fixture.request("screenshot", support::device(json!({})));
    request["artifacts"]["output_directory"] = json!(fixture.root.join("missing-output"));
    failure(
        &artifacts::run(&fixture, request, &png(45), b"", 0),
        "文件操作失败：资源路径无法读取",
    );
    assert!(!fixture.root.join("missing-output").exists());
}

#[test]
fn screenshot_capture_closes_private_file_before_publishing_and_cleans_scratch() {
    let mut fixture = Fixture::new("screenshot-private-clean");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let (request, output_root) = request(&fixture);
    let reply = artifacts::run(&fixture, request, &png(64), b"", 0);
    artifacts::screenshot_result(&reply);
    assert_eq!(
        fs::metadata(output_root.join("screenshot.png"))
            .unwrap()
            .len(),
        64
    );
    artifacts::empty(&scratch);
    assert_eq!(fs::read_dir(&output_root).unwrap().count(), 1);
}

#[test]
fn screenshot_short_header_and_bad_ihdr_length_or_type_are_rejected_without_outputs() {
    for shape in 0..3 {
        let fixture = Fixture::new("screenshot-ihdr");
        let (request, output_root) = request(&fixture);
        let mut image = png(45);
        let expected = if shape == 0 {
            image.truncate(23);
            "输入无效：PNG头部不完整"
        } else {
            image[if shape == 1 { 11 } else { 12 }] = 0;
            "输入无效：PNG标识、IHDR或尺寸无效"
        };
        failure(&artifacts::run(&fixture, request, &image, b"", 0), expected);
        artifacts::empty(&output_root);
    }
}

#[test]
fn screenshot_exact_stdout_and_stderr_limits_are_accepted() {
    let mut fixture = Fixture::new("screenshot-exact-limits");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let (request, output_root) = request(&fixture);
    artifacts::plan_large_stdout(&fixture, artifacts::FILE_LIMIT);
    fs::write(fixture.root.join("stderr-1"), vec![b'x'; 1024 * 1024]).unwrap();
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    fixture.release(1);
    let reply = running.complete();
    probe.assert_exited();
    artifacts::screenshot_result(&reply);
    assert_eq!(
        fs::metadata(output_root.join("screenshot.png"))
            .unwrap()
            .len(),
        artifacts::FILE_LIMIT as u64
    );
    artifacts::empty(&scratch);
}
