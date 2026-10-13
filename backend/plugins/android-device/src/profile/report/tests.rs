//! 独立字节夹具验证官方格式、晚到表、符号缺失和恶意输入。
use super::*;
fn varint(mut value: u64) -> Vec<u8> {
    let mut b = Vec::new();
    loop {
        let p = (value & 127) as u8;
        value >>= 7;
        b.push(p | if value == 0 { 0 } else { 128 });
        if value == 0 {
            return b;
        }
    }
}
fn n(field: u32, value: u64) -> Vec<u8> {
    let mut b = varint(u64::from(field) << 3);
    b.extend(varint(value));
    b
}
fn b(field: u32, value: &[u8]) -> Vec<u8> {
    let mut b = varint((u64::from(field) << 3) | 2);
    b.extend(varint(value.len() as u64));
    b.extend(value);
    b
}
fn record(field: u32, message: Vec<u8>) -> Vec<u8> {
    b(field, &message)
}
fn fixture(mut records: Vec<Vec<u8>>, count: u64) -> Vec<u8> {
    records.push(record(2, [n(1, count), n(2, 3)].concat()));
    records.push(record(5, b(1, b"cpu-clock")));
    let mut out = b"SIMPLEPERF\x01\x00".to_vec();
    for r in records {
        out.extend((r.len() as u32).to_le_bytes());
        out.extend(r);
    }
    out.extend(0u32.to_le_bytes());
    out
}
fn sample(time: u64, symbol: u64) -> Vec<u8> {
    let chain = [n(1, 0x1234), n(2, 0), n(3, symbol), n(4, 0)].concat();
    record(
        1,
        [n(1, time), n(2, 51), b(3, &chain), n(4, u64::MAX), n(5, 0)].concat(),
    )
}
fn table() -> Vec<Vec<u8>> {
    vec![
        record(
            3,
            [n(1, 0), b(2, b"/data/lib.so"), b(3, b"Game::Update")].concat(),
        ),
        record(4, [n(1, 51), n(2, 50), b(3, b"UnityMain")].concat()),
    ]
}
#[test]
fn samples_before_tables_are_sorted_without_losing_unknown_symbols_or_u64() {
    let mut records = vec![sample(u64::MAX, 0), sample(9, u64::MAX)];
    records.extend(table());
    let report = parse(&fixture(records, 2), &|| Ok(())).unwrap();
    assert_eq!(report.lost_count, 3);
    assert_eq!(report.samples[0].time_ns, "9");
    assert_eq!(report.samples[1].time_ns, u64::MAX.to_string());
    assert_eq!(report.samples[0].callchain[0].symbol, None);
    assert_eq!(
        report.samples[1].callchain[0].symbol.as_deref(),
        Some("Game::Update")
    );
    assert_eq!(report.samples[1].event_count, u64::MAX.to_string());
    assert_eq!(report.samples[0].process_id, Some(50));
    assert_eq!(report.samples[0].callchain[0].address, "0x1234");
}
#[test]
fn invalid_header_version_lengths_and_trailer_fail() {
    let valid = fixture(table(), 0);
    for changed in 0..4 {
        let mut value = valid.clone();
        match changed {
            0 => value[0] = 0,
            1 => value[10] = 2,
            2 => value.truncate(value.len() - 1),
            _ => value.push(1),
        }
        assert!(parse(&value, &|| Ok(())).is_err());
    }
    let mut value = valid;
    value[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(parse(&value, &|| Ok(())), Err(Error::TooLarge)));
}
#[test]
fn missing_or_conflicting_tables_and_statistics_fail() {
    let mut missing = table();
    missing.push(sample(1, 0));
    let valid = fixture(missing.clone(), 1);
    assert!(parse(&valid, &|| Ok(())).is_ok());
    assert!(parse(&fixture(vec![sample(1, 0)], 1), &|| Ok(())).is_err());
    missing.push(table().remove(0));
    assert!(parse(&fixture(missing, 1), &|| Ok(())).is_err());
    assert!(parse(&fixture(table(), 1), &|| Ok(())).is_err());
}
#[test]
fn invalid_symbol_event_varint_or_single_value_is_rejected() {
    let mut records = table();
    records.push(sample(1, 9));
    assert!(parse(&fixture(records, 1), &|| Ok(())).is_err());
    let mut records = table();
    records.push(record(1, [n(1, 1), n(1, 2), n(2, 51)].concat()));
    assert!(parse(&fixture(records, 1), &|| Ok(())).is_err());
    assert!(
        wire::Reader::new(&[8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2])
            .next()
            .is_err()
    );
    assert!(wire::Reader::new(&[0]).next().is_err());
}
#[test]
fn chain_leaf_order_and_failed_unwinding_are_preserved() {
    let mut records = table();
    let frame1 = [n(1, 3), n(2, 0), n(3, 0)].concat();
    let frame2 = [n(1, 4), n(2, 0), n(3, u64::MAX), n(4, 2)].concat();
    let unwind = [n(1, 4), n(2, 0x55), n(3, 3)].concat();
    records.push(record(
        1,
        [
            n(1, 5),
            n(2, 51),
            b(3, &frame1),
            b(3, &frame2),
            b(6, &unwind),
        ]
        .concat(),
    ));
    let report = parse(&fixture(records, 1), &|| Ok(())).unwrap();
    let sample = &report.samples[0];
    assert_eq!(sample.callchain[0].address, "0x3");
    assert_eq!(sample.callchain[1].execution_type, "jit_jvm");
    assert_eq!(sample.unwinding.as_ref().unwrap().error_code, Some(3));
}
#[test]
fn cancellation_and_structural_limit_remain_failures() {
    let cancelled = || Err(Error::Cancelled);
    assert!(matches!(
        parse(&fixture(table(), 0), &cancelled),
        Err(Error::Cancelled)
    ));
    let mut records = table();
    let frame = [n(1, 3), n(2, 0), n(3, u64::MAX)].concat();
    let mut body = [n(1, 5), n(2, 51)].concat();
    for _ in 0..257 {
        body.extend(b(3, &frame));
    }
    records.push(record(1, body));
    assert!(matches!(
        parse(&fixture(records, 1), &|| Ok(())),
        Err(Error::TooLarge)
    ));
}
