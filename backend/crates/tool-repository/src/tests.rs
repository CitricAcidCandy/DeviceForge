use super::*;

fn key(digest: char) -> ToolKey {
    ToolKey {
        id: "runtime".into(),
        version: "1.0".into(),
        platform: "windows-x86_64".into(),
        sha256: digest.to_string().repeat(64),
    }
}

#[test]
fn semantic_version_build_metadata_is_a_safe_repository_segment() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let mut tool = key('a');
    tool.version = "1.2.3+vendor.4".into();
    let path = publish(&repository, &tool);
    assert!(path.is_dir());
    repository
        .read()
        .unwrap()
        .verify(&tool, &|| Ok(()))
        .unwrap();
}
fn publish(repository: &Repository, key: &ToolKey) -> PathBuf {
    let stage = repository.stage().unwrap();
    let payload = stage.path().join("payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("runtime.exe"), b"verified-tool").unwrap();
    repository
        .write()
        .unwrap()
        .publish(key, &payload, &|| Ok(()))
        .unwrap()
}

#[test]
fn active_previous_and_consumer_references_all_prevent_removal() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = key('a');
    let path = publish(&repository, &key);
    let writer = repository.write().unwrap();
    for owner in ["host-active", "host-previous", "consumer-selection"] {
        writer
            .set_references(owner, std::slice::from_ref(&key))
            .unwrap();
    }
    assert_eq!(writer.references(&key).unwrap().len(), 3);
    for owner in ["host-active", "host-previous"] {
        writer.set_references(owner, &[]).unwrap();
        assert!(matches!(writer.remove(&key, &|| Ok(())), Err(Error::InUse)));
        assert!(path.exists());
    }
    writer.set_references("consumer-selection", &[]).unwrap();
    assert!(writer.remove(&key, &|| Ok(())).unwrap() >= b"verified-tool".len() as u64);
    assert!(!path.exists());
}

#[test]
fn invocation_lease_across_repository_handles_prevents_all_writes() {
    let temporary = tempfile::tempdir().unwrap();
    let host = Repository::open(temporary.path()).unwrap();
    let plugin = Repository::open(temporary.path()).unwrap();
    let key = key('b');
    publish(&host, &key);
    let first_call = host.read().unwrap();
    let second_call = plugin.read().unwrap();
    first_call.verify(&key, &|| Ok(())).unwrap();
    assert!(matches!(plugin.write(), Err(Error::Busy)));
    drop(first_call);
    assert!(matches!(host.write(), Err(Error::Busy)));
    drop(second_call);
    host.write().unwrap().remove(&key, &|| Ok(())).unwrap();
}

#[test]
fn reuse_and_removal_reject_changed_content_without_deleting_it() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = key('c');
    let path = publish(&repository, &key);
    fs::write(path.join("runtime.exe"), b"tampered").unwrap();
    let writer = repository.write().unwrap();
    assert!(matches!(
        writer.verify(&key, &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        writer.remove(&key, &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    assert!(path.exists());
}

#[test]
fn identity_ledger_survives_removal_and_rejects_same_version_replacement() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let original = key('a');
    publish(&repository, &original);
    repository
        .write()
        .unwrap()
        .remove(&original, &|| Ok(()))
        .unwrap();
    let stage = repository.stage().unwrap();
    let payload = stage.path().join("payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("runtime.exe"), b"different-version-content").unwrap();
    assert!(matches!(
        repository
            .write()
            .unwrap()
            .publish(&key('b'), &payload, &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    assert!(payload.exists());
}

#[test]
fn damaged_reference_fails_closed_and_cancellation_does_not_remove_tool() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = key('d');
    let path = publish(&repository, &key);
    let writer = repository.write().unwrap();
    writer
        .set_references("host", std::slice::from_ref(&key))
        .unwrap();
    fs::write(
        repository.root().join(".repository/references/host.json"),
        b"broken-json",
    )
    .unwrap();
    assert!(matches!(
        writer.remove(&key, &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    writer.set_references("host", &[]).unwrap();
    assert!(matches!(
        writer.remove(&key, &|| Err(Error::Cancelled)),
        Err(Error::Cancelled)
    ));
    assert!(path.exists());
}

#[test]
fn invalid_keys_and_external_staging_cannot_mutate_repository() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let mut invalid = key('a');
    for id in ["../escape", "NUL", ".private", "bad:stream"] {
        invalid.id = id.into();
        assert!(repository.path(&invalid).is_err());
    }
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("runtime.exe"), b"external").unwrap();
    assert!(matches!(
        repository
            .write()
            .unwrap()
            .publish(&key('a'), external.path(), &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    assert!(external.path().join("runtime.exe").exists());
}

#[test]
fn same_digest_cannot_replace_different_expansion_or_accept_external_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = key('e');
    let original = publish(&repository, &key);
    let stage = repository.stage().unwrap();
    let payload = stage.path().join("payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("runtime.exe"), b"different").unwrap();
    let writer = repository.write().unwrap();
    assert!(matches!(
        writer.publish(&key, &payload, &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    assert!(writer.publish(&key, temporary.path(), &|| Ok(())).is_err());
    assert_eq!(
        fs::read(original.join("runtime.exe")).unwrap(),
        b"verified-tool"
    );
}

#[test]
fn entries_and_client_state_stay_inside_explicit_namespaces() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = key('f');
    let directory = publish(&repository, &key);
    let reader = repository.read().unwrap();
    assert_eq!(
        reader
            .verify_entry(&directory.join("runtime.exe"), &|| Ok(()))
            .unwrap(),
        key
    );
    assert!(
        reader
            .verify_entry(&directory.join("missing"), &|| Ok(()))
            .is_err()
    );
    assert!(
        repository
            .key_for_entry(&directory.join("../runtime.exe"))
            .is_err()
    );
    assert!(
        repository
            .key_for_entry(&temporary.path().join("outside.exe"))
            .is_err()
    );
    assert!(repository.client_directory("../escape").is_err());
    assert!(
        repository
            .client_directory("tool-supply")
            .unwrap()
            .ends_with(".repository/clients/tool-supply")
    );
}
