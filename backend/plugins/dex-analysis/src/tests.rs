use super::*;
use apk_plugin_sdk::{ArtifactContext, ArtifactInput, Manifest, Request};
use deviceforge_android_package_core::Control;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::time::{Duration, Instant};

pub(crate) mod fixture;
pub(crate) mod protocol;

fn control() -> Control<'static> {
    Control::new(None, &|| false)
}

pub(crate) fn request(bytes: &[u8], path: String, operation: &str) -> Request {
    let id = "00000000-0000-4000-8000-000000000001";
    Request {
        protocol_version: 4,
        request_id: "dex-case".into(),
        operation: operation.into(),
        input: json!({"artifact_id":id}),
        artifacts: Some(ArtifactContext {
            inputs: vec![ArtifactInput {
                field: "artifact_id".into(),
                artifact_id: id.into(),
                filename: "classes.dex".into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", sha2::Sha256::digest(bytes)),
                path,
            }],
            output_directory: None,
        }),
    }
}

#[test]
fn manifest_is_two_independent_protocol_four_contributions_without_output_artifacts() {
    let manifest: Manifest = serde_json::from_str(include_str!("../manifest.json")).unwrap();
    assert_eq!(manifest.id, "dex-analysis");
    assert_eq!(manifest.protocol_version, 4);
    assert_eq!(manifest.operations.len(), 2);
    assert_eq!(manifest.operations[0].name, "inspect");
    assert_eq!(manifest.operations[1].name, "scan_sdks");
    assert_eq!(
        manifest.artifacts.as_ref().unwrap().input_fields,
        ["artifact_id"]
    );
    assert!(!manifest.artifacts.unwrap().outputs);
    for operation in manifest.operations {
        assert_eq!(operation.execution.unwrap().total_timeout_ms, 30_000);
    }
}

#[test]
fn independently_built_class_tables_report_counts_and_supported_versions() {
    for version in ["035", "037", "038", "039", "040"] {
        let mut sample = fixture::sample(
            &["com/example/sdk/Entry$Inner"],
            &["com/reference/External"],
        );
        sample.bytes[4..7].copy_from_slice(version.as_bytes());
        fixture::seal(&mut sample.bytes);
        let analysis = dex::parse(&sample.bytes, &control()).unwrap();
        assert_eq!(analysis.version, version);
        assert_eq!(analysis.classes, ["com/example/sdk/Entry$Inner"]);
        assert_eq!(analysis.counts.strings, 2);
        assert_eq!(analysis.counts.types, 2);
        assert_eq!(analysis.counts.defined_classes, 1);
    }
    let empty = fixture::sample(&[], &[]);
    assert_eq!(
        dex::parse(&empty.bytes, &control())
            .unwrap()
            .counts
            .defined_classes,
        0
    );
}

#[test]
fn rejects_unsupported_versions_endian_and_linked_or_container_headers() {
    for version in ["036", "041", "999"] {
        let mut sample = fixture::sample(&["com/example/Entry"], &[]);
        sample.bytes[4..7].copy_from_slice(version.as_bytes());
        fixture::seal(&mut sample.bytes);
        assert!(matches!(
            dex::parse(&sample.bytes, &control()),
            Err(Error::Unsupported(_))
        ));
    }
    for (offset, value) in [(40usize, 0x7856_3412), (44, 4), (48, 112)] {
        let mut sample = fixture::sample(&["com/example/Entry"], &[]);
        fixture::put(&mut sample.bytes, offset, value);
        fixture::seal(&mut sample.bytes);
        assert!(matches!(
            dex::parse(&sample.bytes, &control()),
            Err(Error::Unsupported(_))
        ));
    }
}

#[test]
fn input_sha1_and_adler32_mutations_are_rejected_separately() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    let mut changed = sample.bytes.clone();
    changed[sample.string_data[0] + 2] ^= 1;
    assert!(matches!(
        dex::parse(&changed, &control()),
        Err(Error::Invalid("DEX内部SHA-1签名不一致"))
    ));
    let mut changed = sample.bytes.clone();
    changed[8] ^= 1;
    assert!(matches!(
        dex::parse(&changed, &control()),
        Err(Error::Invalid("DEX内部Adler32不一致"))
    ));
    assert_ne!(Sha1::digest(&changed[32..])[..], [0u8; 20]);
}

#[test]
fn resealed_malformed_lengths_sections_and_mapping_do_not_become_valid() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    for (offset, value) in [
        (32usize, 112),
        (36, 120),
        (60, 113),
        (68, 112),
        (104, 1),
        (52, u32::MAX),
        (56, 1_000_001),
    ] {
        let mut bytes = sample.bytes.clone();
        fixture::put(&mut bytes, offset, value);
        fixture::seal(&mut bytes);
        assert!(dex::parse(&bytes, &control()).is_err());
    }
    let mut bytes = sample.bytes.clone();
    fixture::put(&mut bytes, sample.map + 4 + 12 + 4, 2);
    fixture::seal(&mut bytes);
    assert!(matches!(
        dex::parse(&bytes, &control()),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn resealed_out_of_range_type_class_source_and_missing_class_data_mapping_are_rejected() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    for (offset, value) in [
        (sample.types, 1),
        (sample.classes, 1),
        (sample.classes + 16, 1),
        (sample.classes + 24, sample.map as u32),
    ] {
        let mut bytes = sample.bytes.clone();
        fixture::put(&mut bytes, offset, value);
        fixture::seal(&mut bytes);
        assert!(matches!(
            dex::parse(&bytes, &control()),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn mutf8_declared_length_continuations_overlong_and_four_byte_utf8_are_rejected() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    for (relative, value) in [(0usize, 1), (1, 0x80), (1, 0xc1), (1, 0xf0), (1, 0)] {
        let mut bytes = sample.bytes.clone();
        bytes[sample.string_data[0] + relative] = value;
        fixture::seal(&mut bytes);
        assert!(matches!(
            dex::parse(&bytes, &control()),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn actual_definitions_package_boundaries_and_inner_class_detection_are_preserved() {
    let sample = fixture::sample(
        &["com/example/sdk/Entry$Inner", "com/example/sdkExtra/Other"],
        &["com/reference/sdk/Entry"],
    );
    let analysis = dex::parse(&sample.bytes, &control()).unwrap();
    let rules = vec![
        models::Rule {
            name: "defined".into(),
            package_path: "com.example.sdk".into(),
            class_name: Some("Entry$Inner".into()),
        },
        models::Rule {
            name: "reference".into(),
            package_path: "com.reference.sdk".into(),
            class_name: None,
        },
        models::Rule {
            name: "prefix".into(),
            package_path: "com.example.sd".into(),
            class_name: None,
        },
    ];
    let findings = findings::scan(&analysis.classes, rules, &control()).unwrap();
    assert!(findings[0].package_found);
    assert_eq!(findings[0].class_found, Some(true));
    assert_eq!(findings[0].evidence, ["com/example/sdk/Entry$Inner"]);
    assert!(!findings[1].package_found);
    assert_eq!(findings[1].class_found, None);
    assert!(!findings[2].package_found);
}

#[test]
fn bounded_evidence_keeps_requested_class_after_the_first_ten() {
    let mut classes = (0..20)
        .map(|index| format!("com/example/sdk/Entry{index:02}"))
        .collect::<Vec<_>>();
    classes.sort();
    let rule = models::Rule {
        name: "sdk".into(),
        package_path: "com.example.sdk".into(),
        class_name: Some("Entry19".into()),
    };
    let finding = findings::scan(&classes, vec![rule], &control())
        .unwrap()
        .remove(0);
    assert_eq!(finding.evidence.len(), 10);
    assert!(finding.evidence.contains(&"com/example/sdk/Entry19".into()));
    assert_eq!(finding.class_found, Some(true));
}

#[test]
fn pre_cancel_and_expired_control_never_return_partial_success() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    let cancelled = Control::new(None, &|| true);
    assert!(matches!(
        dex::parse(&sample.bytes, &cancelled),
        Err(Error::Cancelled)
    ));
    let expired = Control::new(Some(Instant::now() - Duration::from_secs(1)), &|| true);
    assert!(matches!(
        dex::parse(&sample.bytes, &expired),
        Err(Error::Timeout)
    ));
}

#[test]
fn strict_business_and_host_authorization_reject_paths_rules_and_extra_artifacts() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    let mut request = request(&sample.bytes, "/unused".into(), "inspect");
    assert!(input::parse(&request).is_ok());
    for value in [
        Value::Null,
        json!({}),
        json!({"artifact_id":"not-uuid"}),
        json!({"artifact_id":request.input["artifact_id"],"path":"/server"}),
    ] {
        request.input = value;
        assert!(input::parse(&request).is_err());
    }
    request.input = json!({"artifact_id":"00000000-0000-4000-8000-000000000001"});
    request.artifacts.as_mut().unwrap().output_directory = Some("/server".into());
    assert!(input::parse(&request).is_err());
    request.artifacts.as_mut().unwrap().output_directory = None;
    request.artifacts.as_mut().unwrap().inputs[0].artifact_id = "other".into();
    assert!(input::parse(&request).is_err());
}

#[test]
fn independent_field_method_and_prototype_tables_validate_actual_references() {
    let bytes = fixture::members();
    let analysis = dex::parse(&bytes, &control()).unwrap();
    assert_eq!(analysis.counts.prototypes, 1);
    assert_eq!(analysis.counts.fields, 1);
    assert_eq!(analysis.counts.methods, 1);
    assert_eq!(analysis.classes, ["com/example/Entry"]);
    for (offset, value) in [
        (144usize, 0),
        (148, 3),
        (156, 3),
        (156, 0x0002_0001),
        (164, 0x0001_0001),
        (168, 1),
    ] {
        let mut changed = bytes.clone();
        fixture::put(&mut changed, offset, value);
        fixture::seal(&mut changed);
        assert!(matches!(
            dex::parse(&changed, &control()),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn supplementary_mutf8_names_and_version_040_spaces_use_official_name_ranges() {
    let sample = fixture::sample(&["com/示例/Entry𐐀"], &[]);
    assert_eq!(
        dex::parse(&sample.bytes, &control()).unwrap().classes,
        ["com/示例/Entry𐐀"]
    );
    let mut spaced = fixture::sample(&["com/example/Entry Name"], &[]);
    assert!(matches!(
        dex::parse(&spaced.bytes, &control()),
        Err(Error::Invalid(_))
    ));
    spaced.bytes[4..7].copy_from_slice(b"040");
    fixture::seal(&mut spaced.bytes);
    assert_eq!(
        dex::parse(&spaced.bytes, &control()).unwrap().classes,
        ["com/example/Entry Name"]
    );
}

#[test]
fn duplicate_strings_types_and_class_definitions_are_rejected_after_resealing() {
    let sample = fixture::sample(&["com/example/First", "com/example/Second"], &[]);
    for (offset, value) in [
        (112usize + 4, sample.string_data[0] as u32),
        (sample.types + 4, 0),
        (sample.classes + 32, 0),
    ] {
        let mut bytes = sample.bytes.clone();
        fixture::put(&mut bytes, offset, value);
        fixture::seal(&mut bytes);
        assert!(matches!(
            dex::parse(&bytes, &control()),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn sdk_rules_reject_duplicates_and_unbounded_or_partial_package_names() {
    let valid = models::Rule {
        name: "sdk".into(),
        package_path: "com.example.sdk".into(),
        class_name: Some("Entry$Inner".into()),
    };
    assert!(input::rules(std::slice::from_ref(&valid)).is_ok());
    assert!(input::rules(&[]).is_err());
    assert!(input::rules(&vec![valid.clone(); 101]).is_err());
    assert!(input::rules(&[valid.clone(), valid.clone()]).is_err());
    for path in ["com..sdk", "com/sdk", ".sdk", "com.*", "com.sdk\n"] {
        let mut rule = valid.clone();
        rule.package_path = path.into();
        assert!(input::rules(&[rule]).is_err());
    }
}

#[test]
fn total_sdk_evidence_budget_rejects_unbounded_serialized_success() {
    let classes = (0..10)
        .map(|index| format!("com/example/sdk/{}Entry{index}", "a".repeat(4000)))
        .collect::<Vec<_>>();
    let rules = (0..100)
        .map(|index| models::Rule {
            name: format!("sdk{index}"),
            package_path: "com.example.sdk".into(),
            class_name: None,
        })
        .collect();
    assert!(matches!(
        findings::scan(&classes, rules, &control()),
        Err(Error::TooLarge)
    ));
}
