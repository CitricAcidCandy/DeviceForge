//! 七项业务的正向 DTO、固定输出与实际 argv；样本不代表可安装包或真机。
use crate::support::{
    self, ARTIFACT_ID, Fixture, XML,
    wire::{output_names, success},
    zip,
};
use serde_json::json;
use std::fs;

fn manifest_expected(format: &str, module: serde_json::Value) -> serde_json::Value {
    json!({"artifact_id":ARTIFACT_ID,"format":format,"module":module,"package_name":"org.fixture.app",
        "version_code":"0007","version_name":"一&二","min_sdk":"21","target_sdk":"35",
        "application_label":"独立样本","debuggable":false,"permissions":["android.permission.INTERNET"],"xml":XML})
}

#[test]
fn manifest_apk_preserves_business_strings_xml_and_private_argv() {
    let fixture = Fixture::new("输入 空格&$().apk", support::apk());
    let reply = fixture.normal("manifest", json!({}), true);
    assert_eq!(success(&reply), &manifest_expected("apk", json!(null)));
    assert!(output_names(&reply).is_empty());
    fixture.assert_no_output();
    let args = fixture.argv();
    assert_eq!(&args[..2], &["manifest", "print"]);
    assert_eq!(args.len(), 3);
    fixture.assert_private_input();
}

#[test]
fn manifest_aab_default_base_uses_fixed_java_prefix() {
    let fixture = Fixture::new("输入.aab", support::aab());
    let reply = fixture.normal("manifest", json!({}), true);
    assert_eq!(success(&reply), &manifest_expected("aab", json!("base")));
    let args = fixture.argv();
    assert_eq!(&args[..2], &["-Xmx256m", "-jar"]);
    assert_eq!(&args[3..5], &["dump", "manifest"]);
    assert_eq!(args[6], "--module=base");
    assert_eq!(args.len(), 7);
    fixture.assert_private_input();
    fixture.assert_no_output();
}

#[test]
fn manifest_aab_explicit_module_is_one_argv() {
    let fixture = Fixture::new("输入.aab", support::aab());
    let reply = fixture.normal("manifest", json!({"module":"feature_test"}), true);
    assert_eq!(
        success(&reply),
        &manifest_expected("aab", json!("feature_test"))
    );
    assert_eq!(fixture.argv()[6], "--module=feature_test");
    fixture.assert_no_output();
}

#[test]
fn signature_preserves_nullable_dn_digest_scheme_and_full_report() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let reply = fixture.normal("signature", json!({}), true);
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"verified":true,
        "signers":[{"number":1,"distinguished_name":null,"certificate_sha256":"ab".repeat(32)}],
        "schemes":[{"scheme":"v2","verified":true}],"report":support::signature()})
    );
    assert_eq!(
        &fixture.argv()[..3],
        &["verify", "--verbose", "--print-certs"]
    );
    fixture.assert_private_input();
    fixture.assert_no_output();
    assert!(output_names(&reply).is_empty());
}

#[test]
fn exact_apks_extraction_publishes_only_named_original_apk_bytes() {
    let fixture = Fixture::new("输入.apks", support::apks());
    let reply = fixture.normal("extract_apk", json!({"entry":"universal.apk"}), false);
    assert_eq!(success(&reply), &json!({"entry":"universal.apk"}));
    assert_eq!(output_names(&reply), ["extracted.apk"]);
    let output = fs::read(fixture.output.join("extracted.apk")).unwrap();
    assert_eq!(output, support::apk());
    assert_eq!(support::hash(&output), support::hash(&support::apk()));
    assert_eq!(fs::read_dir(&fixture.output).unwrap().count(), 1);
    fixture.assert_no_tool();
}

fn build(mode: &str, universal: serde_json::Value, source: &str) {
    let fixture = Fixture::new("输入.aab", support::aab());
    let reply = fixture.normal("build_apks", json!({"mode":mode}), true);
    assert_eq!(
        success(&reply),
        &json!({"mode":mode,"apk_count":1,"universal_entry":universal})
    );
    assert_eq!(output_names(&reply), ["built.apks"]);
    let expected = fs::read(fixture.tools.join(source)).unwrap();
    let actual = fs::read(fixture.output.join("built.apks")).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(support::hash(&actual), support::hash(&expected));
    let args = fixture.argv();
    assert_eq!(&args[..2], &["-Xmx256m", "-jar"]);
    assert_eq!(args[3], "build-apks");
    assert_eq!(args[6], format!("--mode={mode}"));
    assert_eq!(args[7], "--max-threads=2");
    assert_eq!(args[9], "--ks-key-alias=fixture_中文_&$()");
    assert!(args[10].starts_with("--ks-pass=file:"));
    assert!(args[11].starts_with("--key-pass=file:"));
    assert_eq!(args.len(), 12);
    fixture.assert_private_input();
}
#[test]
fn build_universal_preserves_whole_apks_bytes_and_signing_file_argv() {
    build("universal", json!("universal.apk"), "universal.apks");
}
#[test]
fn build_default_preserves_explicit_null_universal_entry() {
    build("default", json!(null), "default.apks");
}

#[test]
fn decode_packs_fixed_member_bytes_crc_and_old_counts() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let reply = fixture.normal("decode", json!({}), true);
    assert_eq!(
        success(&reply),
        &json!({"files":3,"unpacked_size":XML.len()+support::APKTOOL.len()+support::SMALI.len()})
    );
    assert_eq!(output_names(&reply), ["decoded.zip"]);
    let actual = zip::unpack_stored(&fs::read(fixture.output.join("decoded.zip")).unwrap());
    assert_eq!(actual, zip::unpack_stored(&support::decoded()));
    assert_eq!(fixture.argv()[3], "decode");
    fixture.assert_private_input();
}

#[test]
fn sdk_scan_retains_none_rule_class_and_ordered_evidence_without_tools() {
    let fixture = Fixture::new("已反编译.zip", support::decoded());
    let reply = fixture.normal(
        "scan_sdks",
        json!({"rules":[
        {"name":"找到类","package_path":"com.example.sdk","class_name":"Probe"},
        {"name":"只查包","package_path":"com.example.sdk"},
        {"name":"找不到","package_path":"com.absent","class_name":null}]}),
        false,
    );
    let evidence = json!(["smali/com/example/sdk/Probe.smali"]);
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"findings":[
        {"rule":{"name":"找到类","package_path":"com.example.sdk","class_name":"Probe"},"package_found":true,"class_found":true,"evidence":evidence},
        {"rule":{"name":"只查包","package_path":"com.example.sdk","class_name":null},"package_found":true,"class_found":null,"evidence":evidence},
        {"rule":{"name":"找不到","package_path":"com.absent","class_name":null},"package_found":false,"class_found":null,"evidence":[]}]})
    );
    assert!(output_names(&reply).is_empty());
    fixture.assert_no_tool();
    fixture.assert_no_output();
}

#[test]
fn split_selection_writes_camel_case_spec_and_exact_apk_member_bytes() {
    let fixture = Fixture::new("输入.apks", support::apks());
    let spec = support::device_spec();
    let reply = fixture.normal("extract_splits", json!({"device_spec":spec}), true);
    assert_eq!(
        success(&reply),
        &json!({"device_spec":spec,"apk_entries":["base-arm64.apk","base-master.apk"]})
    );
    assert_eq!(output_names(&reply), ["selected-apks.zip"]);
    let actual = zip::unpack_stored(&fs::read(fixture.output.join("selected-apks.zip")).unwrap());
    assert_eq!(actual.len(), 2);
    for name in ["base-master.apk", "base-arm64.apk"] {
        assert_eq!(actual[name], support::apk());
    }
    let actual_spec: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.tools.join("device-spec.json")).unwrap()).unwrap();
    assert_eq!(
        actual_spec,
        json!({"supportedAbis":["arm64-v8a"],"supportedLocales":["zh-CN"],"screenDensity":420,"sdkVersion":35})
    );
    assert_eq!(fixture.argv()[3], "extract-apks");
    fixture.assert_private_input();
}
