//! 历史永久租约不占活动额度；未知条目和部分遍历不能成为成功证明。
use super::*;

#[tokio::test]
async fn more_than_8192_historical_leases_do_not_consume_active_record_capacity() {
    let root = root();
    for ordinal in 0..8193 {
        std::fs::write(root.join(format!("{ordinal:032x}.lease")), b"").unwrap();
    }
    std::fs::write(root.join("process.lock"), b"").unwrap();
    std::fs::write(root.join("catalog.lock"), b"").unwrap();
    std::fs::write(root.join(format!("{}.gate", store::digest("demo"))), b"").unwrap();
    assert!(store::paths(&root).unwrap().is_empty());
    assert!(ledger::read_all(&root).await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 8196);
    for ordinal in 1..=store::RECORD_LIMIT as u32 {
        write(&root, &record("demo", ordinal));
    }
    assert_eq!(
        ledger::read_all(&root).await.unwrap().len(),
        store::RECORD_LIMIT
    );
    write(&root, &record("demo", store::RECORD_LIMIT as u32 + 1));
    assert!(
        ledger::read_all(&root).await.is_err(),
        "活动台账上限必须独立保留"
    );
    assert!(root.join("00000000000000000000000000000000.lease").exists());
}

#[tokio::test]
async fn unknown_pending_or_damaged_history_files_are_never_silently_skipped() {
    for (name, bytes) in [
        ("unknown.txt", b"".as_slice()),
        ("unknown.lease", b"".as_slice()),
        (
            "00000000000000000000000000000001.lease",
            b"damaged".as_slice(),
        ),
        ("00000000000000000000000000000001.pending", b"{}".as_slice()),
        ("process.lock", b"damaged".as_slice()),
    ] {
        let root = root();
        std::fs::write(root.join(name), bytes).unwrap();
        assert!(store::paths(&root).is_err(), "{name}");
        assert!(ledger::read_all(&root).await.is_err(), "{name}");
        assert!(root.join(name).exists(), "不能删除可疑条目掩盖风险");
    }
}

#[test]
fn historical_lock_names_cannot_hide_a_directory() {
    let root = root();
    std::fs::create_dir(root.join("00000000000000000000000000000001.lease")).unwrap();
    assert!(store::paths(&root).is_err());
}

#[tokio::test]
async fn malformed_or_oversized_active_json_is_still_rejected() {
    for bytes in [b"{}".to_vec(), vec![b' '; store::LIMIT + 1]] {
        let root = root();
        let value = record("demo", 1);
        std::fs::write(value.path(&root), bytes).unwrap();
        assert!(ledger::read_all(&root).await.is_err());
        assert!(value.path(&root).exists());
    }
}

#[test]
fn new_registration_counts_old_pending_debt_without_requiring_its_audit() {
    let root = root();
    for ordinal in 1..store::RECORD_LIMIT {
        std::fs::write(root.join(format!("{ordinal:032x}.json")), b"{broken").unwrap();
        std::fs::write(root.join(format!("{ordinal:032x}.pending")), b"unconfirmed").unwrap();
    }
    store::registration_capacity(&root).unwrap();
    std::fs::write(root.join("unknown.txt"), b"unconfirmed").unwrap();
    assert!(store::registration_capacity(&root).is_err());
    assert!(
        store::paths(&root).is_err(),
        "恢复不能把损坏登记当作已经清理"
    );
}

#[test]
fn historical_scan_obeys_a_fixed_budget_at_batch_boundaries() {
    let root = root();
    for ordinal in 0..129 {
        std::fs::write(root.join(format!("{ordinal:032x}.lease")), b"").unwrap();
    }
    let mut checks = 0;
    let result = store::paths_with_check(&root, || {
        checks += 1;
        if checks == 2 {
            Err("确定性注入总预算到期".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(result.unwrap_err(), "确定性注入总预算到期");
    assert_eq!(checks, 2);
}

#[test]
fn expired_final_scan_check_cannot_publish_a_partial_success() {
    let root = root();
    write(&root, &record("demo", 1));
    let mut checks = 0;
    let result = store::paths_with_check(&root, || {
        checks += 1;
        if checks == 2 {
            Err("最后确认前预算到期".into())
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert_eq!(checks, 2);
}
