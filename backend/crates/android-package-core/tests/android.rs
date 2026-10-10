mod common;
use common::{input, live, stored};
use deviceforge_android_package_core::{
    ArchiveProfile, BuildMode, Control, Error, LimitKind, SdkRule, android, archive::Archive,
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn manifest_keeps_namespace_values_none_and_sorted_permissions() {
    let xml = r#"<manifest xmlns:a="http://schemas.android.com/apk/res/android" package="com.example" a:versionCode="001"><uses-permission a:name="z"/><uses-permission a:name="a"/><uses-permission a:name="z"/><uses-sdk a:minSdkVersion="21"/><application a:label="@string/app_name" a:debuggable="false"/></manifest>"#;
    let result = android::parse_manifest(xml, &live()).unwrap();
    assert_eq!(result.package_name, "com.example");
    assert_eq!(result.version_code.as_deref(), Some("001"));
    assert_eq!(result.version_name, None);
    assert_eq!(result.min_sdk.as_deref(), Some("21"));
    assert_eq!(result.permissions, ["a", "z"]);
    assert_eq!(result.debuggable, Some(false));
    assert_eq!(result.xml, xml);
}

#[test]
fn malformed_manifest_dtd_entities_duplicate_structure_and_namespace_fail() {
    for xml in [
        "<!DOCTYPE manifest [<!ENTITY secret 'x'>]><manifest package='p'/>",
        "<manifest package='p'>&undefined;</manifest>",
        "<manifest package='p'/><manifest package='q'/>",
        "<manifest package='p'><uses-sdk/><uses-sdk/></manifest>",
        "<manifest package='p'><application/><application/></manifest>",
        "<x:manifest package='p'/>",
        "<manifest xmlns='other' package='p'/>",
        "<manifest xmlns:a='http://schemas.android.com/apk/res/android' xmlns:b='http://schemas.android.com/apk/res/android' package='p' a:versionCode='1' b:versionCode='2'/>",
        "<manifest package='p'><application></manifest>",
    ] {
        assert!(
            matches!(
                android::parse_manifest(xml, &live()),
                Err(Error::InvalidManifest(_))
            ),
            "{xml}"
        );
    }
    assert!(matches!(
        android::parse_manifest(&" ".repeat(1024 * 1024 + 1), &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::TextBytes,
            ..
        })
    ));
}

fn report() -> String {
    format!(
        "Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate DN: CN=example\nSigner #1 certificate SHA-256 digest: {}\nWARNING: preserved\n",
        "AB".repeat(32)
    )
}

#[test]
fn signature_requires_complete_contiguous_signers_and_success_scheme() {
    let text = report();
    let result = android::parse_signature(&text, &live()).unwrap();
    assert!(result.verified);
    assert_eq!(result.signers[0].certificate_sha256, "ab".repeat(32));
    assert_eq!(result.report, text);
    for text in [
        report().replace("Verifies\n", ""),
        report().replace(": true", ": false"),
        report().replace("Signer #1", "Signer #2"),
        report().replace("Number of signers: 1", "Number of signers: 2"),
        format!("{}Number of signers: 1", report()),
        format!("{}DOES NOT VERIFY", report()),
        format!("{}Signer #1 certificate DN: duplicate", report()),
    ] {
        assert!(matches!(
            android::parse_signature(&text, &live()),
            Err(Error::InvalidSignature(_))
        ));
    }
}

#[test]
fn apks_reads_every_outer_member_and_rejects_bad_crc_duplicates_and_missing_rules() {
    let apk = stored(&[("AndroidManifest.xml", b"binary", 0)]);
    let mut archive = Archive::open(
        input(&stored(&[
            ("toc.pb", b"toc", 0),
            ("universal.apk", &apk, 0),
        ])),
        ArchiveProfile::Structure,
        &live(),
    )
    .unwrap();
    let result = android::validate_apks(&mut archive, BuildMode::Universal, &live()).unwrap();
    assert_eq!(result.apk_count, 1);
    assert_eq!(result.universal_entry.as_deref(), Some("universal.apk"));
    let mut multi = Archive::open(
        input(&stored(&[
            ("toc.pb", b"toc", 0),
            ("universal.apk", &apk, 0),
            ("base.apk", &apk, 0),
        ])),
        ArchiveProfile::Structure,
        &live(),
    )
    .unwrap();
    assert!(matches!(
        android::validate_apks(&mut multi, BuildMode::Universal, &live()),
        Err(Error::InvalidArchive(_))
    ));
    for bytes in [
        stored(&[("toc.pb", b"", 0), ("base.apk", &apk, 0)]),
        stored(&[("toc.pb", b"toc", 0), ("base.apk", b"invalid", 0)]),
        stored(&[
            ("toc.pb", b"a", 0),
            ("toc.pb", b"b", 0),
            ("base.apk", &apk, 0),
        ]),
    ] {
        let mut archive = Archive::open(input(&bytes), ArchiveProfile::Structure, &live()).unwrap();
        assert!(matches!(
            android::validate_apks(&mut archive, BuildMode::Default, &live()),
            Err(Error::InvalidArchive(_))
        ));
    }
    let mut bad = stored(&[
        ("toc.pb", b"toc", 0),
        ("base.apk", &apk, 0),
        ("unrelated", b"payload", 0),
    ]);
    let offset = bad
        .windows(7)
        .position(|window| window == b"payload")
        .unwrap();
    bad[offset] ^= 1;
    let mut archive = Archive::open(input(&bad), ArchiveProfile::Structure, &live()).unwrap();
    assert!(matches!(
        android::validate_apks(&mut archive, BuildMode::Default, &live()),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn xml_depth_and_node_caps_have_separate_errors() {
    let deep = format!(
        "<manifest package='p'>{}{}</manifest>",
        "<item>".repeat(128),
        "</item>".repeat(128)
    );
    assert!(matches!(
        android::parse_manifest(&deep, &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::XmlDepth,
            limit: 128
        })
    ));
    let many = format!(
        "<manifest package='p'>{}</manifest>",
        "<item/>".repeat(20_000)
    );
    assert!(matches!(
        android::parse_manifest(&many, &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::XmlNodes,
            limit: 20_000
        })
    ));
}

#[test]
fn sdk_rule_duplicates_bad_identifiers_and_decoded_duplicate_required_file_fail() {
    let archive = Archive::open(
        input(&stored(&[
            ("apktool.yml", b"x", 0),
            ("AndroidManifest.xml", b"x", 0),
        ])),
        ArchiveProfile::Structure,
        &live(),
    )
    .unwrap();
    let rule = SdkRule {
        name: "r".into(),
        package_path: "com.example".into(),
        class_name: None,
    };
    assert!(matches!(
        android::scan_sdks(archive.directory(), &[rule.clone(), rule], &live()),
        Err(Error::InvalidArgument(_))
    ));
    for package in ["", "com..example", "com/example", "123.invalid"] {
        let rule = SdkRule {
            name: "r".into(),
            package_path: package.into(),
            class_name: None,
        };
        assert!(matches!(
            android::scan_sdks(archive.directory(), &[rule], &live()),
            Err(Error::InvalidArgument(_))
        ));
    }
    let archive = Archive::open(
        input(&stored(&[
            ("apktool.yml", b"x", 0),
            ("apktool.yml", b"y", 0),
            ("AndroidManifest.xml", b"x", 0),
        ])),
        ArchiveProfile::Structure,
        &live(),
    )
    .unwrap();
    assert!(matches!(
        android::validate_decoded(archive.directory()),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn sdk_scan_observes_package_boundary_and_preserves_selected_class_evidence() {
    let mut owned = vec![
        ("apktool.yml".to_owned(), b"x".to_vec()),
        ("AndroidManifest.xml".to_owned(), b"x".to_vec()),
        ("smali/com/examplex/Wrong.smali".to_owned(), b"x".to_vec()),
    ];
    for number in 0..12 {
        owned.push((
            format!("smali/com/example/A{number:02}.smali"),
            b"x".to_vec(),
        ));
    }
    owned.push((
        "smali_classes2/com/example/Zebra.smali".into(),
        b"x".to_vec(),
    ));
    let entries: Vec<_> = owned
        .iter()
        .map(|(name, body)| (name.as_str(), body.as_slice(), 0))
        .collect();
    let archive =
        Archive::open(input(&stored(&entries)), ArchiveProfile::Structure, &live()).unwrap();
    let rules = [
        SdkRule {
            name: "test".into(),
            package_path: "com.example".into(),
            class_name: Some("Zebra".into()),
        },
        SdkRule {
            name: "absent".into(),
            package_path: "com.ex".into(),
            class_name: None,
        },
    ];
    let results = android::scan_sdks(archive.directory(), &rules, &live()).unwrap();
    assert_eq!(results[0].class_found, Some(true));
    assert_eq!(results[0].evidence.len(), 10);
    assert!(
        results[0]
            .evidence
            .iter()
            .any(|path| path.ends_with("Zebra.smali"))
    );
    assert!(!results[1].package_found);
    assert!(results[1].evidence.is_empty());
}

#[test]
fn parsers_recheck_control_at_completion_and_pre_cancel_wins_over_bad_input() {
    let cancel = || true;
    assert!(matches!(
        android::parse_manifest("bad", &Control::new(None, &cancel)),
        Err(Error::Cancelled)
    ));
    let calls = AtomicUsize::new(0);
    let cancel = || calls.fetch_add(1, Ordering::Relaxed) >= 2;
    assert!(matches!(
        android::parse_manifest("<manifest package='p'/>", &Control::new(None, &cancel)),
        Err(Error::Cancelled)
    ));
    let calls = AtomicUsize::new(0);
    let lines = report().lines().count();
    let cancel = || calls.fetch_add(1, Ordering::Relaxed) > lines;
    assert!(matches!(
        android::parse_signature(&report(), &Control::new(None, &cancel)),
        Err(Error::Cancelled)
    ));
}

#[test]
fn pkg_xml_001_rejects_undefined_entities_in_all_namespace_declarations() {
    for xml in [
        "<manifest package='p' xmlns:unused='urn:&undefined;'/>",
        "<manifest package='p' xmlns:a='http://schemas.android.com/apk/res/&undefined;' a:versionCode='1'/>",
        "<manifest package='p'><application xmlns:unused='urn:&undefined;'/></manifest>",
    ] {
        assert!(
            matches!(
                android::parse_manifest(xml, &live()),
                Err(Error::InvalidManifest(_))
            ),
            "{xml}"
        );
    }
}

#[test]
fn pkg_xml_001_decodes_equivalent_namespace_uri_before_android_attribute_lookup() {
    let xml = "<manifest package='p' xmlns:a='http:&#47;&#47;schemas.android.com/apk/res/andr&#x6f;id' a:versionCode='003'><uses-sdk a:minSdkVersion='21'/><application a:label='example' a:debuggable='false'/></manifest>";
    let result = android::parse_manifest(xml, &live()).unwrap();
    assert_eq!(result.version_code.as_deref(), Some("003"));
    assert_eq!(result.min_sdk.as_deref(), Some("21"));
    assert_eq!(result.application_label.as_deref(), Some("example"));
    assert_eq!(result.debuggable, Some(false));
    assert_eq!(result.xml, xml);
}

#[test]
fn pkg_xml_001_rejects_duplicate_expanded_attributes_after_namespace_normalization() {
    let xml = "<manifest package='p' xmlns:a='http://schemas.android.com/apk/res/android' xmlns:b='http://schemas.android.com/apk/res/andr&#111;id' a:versionCode='1' b:versionCode='2'/>";
    assert!(matches!(
        android::parse_manifest(xml, &live()),
        Err(Error::InvalidManifest(_))
    ));
}
