use super::*;
use std::collections::BTreeMap;

fn registered(repository: &Repository) -> ToolKey {
    let key = ToolKey {
        id: "third-party-runtime".into(),
        version: "1.2.3+dep.original".into(),
        platform: Repository::platform(),
        sha256: "a".repeat(64),
    };
    let stage = repository.stage().unwrap();
    let payload = stage.path().join("payload");
    fs::create_dir_all(payload.join("vendor/bin")).unwrap();
    fs::write(payload.join("vendor/bin/tool"), b"tool-bytes").unwrap();
    let writer = repository.write().unwrap();
    writer.publish(&key, &payload, &|| Ok(())).unwrap();
    writer
        .register_tool(
            &key,
            "1.2.3",
            &BTreeMap::from([("program".into(), "vendor/bin/tool".into())]),
            &|| Ok(()),
        )
        .unwrap();
    key
}

#[test]
fn stable_entries_and_runtime_version_survive_other_repository_handle_and_broken_cache() {
    let temporary = tempfile::tempdir().unwrap();
    let first = Repository::open(temporary.path()).unwrap();
    let key = registered(&first);
    fs::write(first.root().join(".repository/index.json"), b"broken-cache").unwrap();
    let second = Repository::open(temporary.path()).unwrap();
    let reader = second.read().unwrap();
    let index = reader.tool_index(&|| Ok(())).unwrap();
    assert_eq!(index.tools.len(), 1);
    assert_eq!(index.tools[0].key, key);
    assert_eq!(index.tools[0].runtime_version, "1.2.3");
    assert_eq!(index.tools[0].entries["program"], "vendor/bin/tool");
    assert!(reader.verify(&key, &|| Ok(())).is_ok());
}

#[test]
fn user_supplied_unregistered_directories_do_not_break_shared_index() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = registered(&repository);
    let local = repository.root().join("vendor/custom/bin/helpers");
    fs::create_dir_all(&local).unwrap();
    fs::write(repository.root().join("local-tool.exe"), b"local").unwrap();
    fs::write(local.join("tool.exe"), b"local").unwrap();
    let index = repository.read().unwrap().tool_index(&|| Ok(())).unwrap();
    assert_eq!(index.tools.len(), 1);
    assert_eq!(index.tools[0].key, key);
}

#[test]
fn immutable_metadata_rejects_redefinition_and_missing_entries() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = registered(&repository);
    let writer = repository.write().unwrap();
    let entries = BTreeMap::from([("program".into(), "vendor/bin/tool".into())]);
    assert!(
        writer
            .register_tool(&key, "9.0.0", &entries, &|| Ok(()))
            .is_err()
    );
    assert!(
        writer
            .register_tool(
                &key,
                "1.2.3",
                &BTreeMap::from([("program".into(), "missing".into())]),
                &|| Ok(())
            )
            .is_err()
    );
}

#[test]
fn prepared_references_under_read_lease_close_the_cleanup_gap() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = registered(&repository);
    let lease = repository.read().unwrap();
    lease
        .set_references("unique-preparation", std::slice::from_ref(&key))
        .unwrap();
    assert!(matches!(repository.write(), Err(Error::Busy)));
    drop(lease);
    let writer = repository.write().unwrap();
    assert!(matches!(writer.remove(&key, &|| Ok(())), Err(Error::InUse)));
    drop(writer);
    repository
        .read()
        .unwrap()
        .set_references("unique-preparation", &[])
        .unwrap();
    repository
        .write()
        .unwrap()
        .remove(&key, &|| Ok(()))
        .unwrap();
}

#[test]
fn targeted_index_does_not_read_unrelated_damaged_inventory_and_honors_cancellation() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = Repository::open(temporary.path()).unwrap();
    let key = registered(&repository);
    let broken = repository
        .root()
        .join("other-tool/1.0.0")
        .join(Repository::platform())
        .join("b".repeat(64));
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("inventory.json"), b"broken-inventory").unwrap();
    let reader = repository.read().unwrap();
    assert_eq!(
        reader
            .tool_index_for(&key.id, &key.platform, &|| Ok(()))
            .unwrap()
            .tools
            .len(),
        1
    );
    assert!(reader.tool_index(&|| Ok(())).is_err());
    assert!(matches!(
        reader.tool_index_for(&key.id, &key.platform, &|| Err(Error::Cancelled)),
        Err(Error::Cancelled)
    ));
}
