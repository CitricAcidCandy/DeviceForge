use super::*;
use serde_json::json;

#[test]
fn round_trip_preserves_integer_extremes_unicode_and_nested_values() {
    let bytes = br#"[null,true,false,-9223372036854775808,18446744073709551615,1.25,{"name":"\u8bbe\u5907","items":[0]}]"#;
    let packed = encode_json(bytes).unwrap();
    assert_eq!(decode_json(&packed).unwrap(), parse_json(bytes).unwrap());
    assert_eq!(
        decode_json(&[0xcf, 255, 255, 255, 255, 255, 255, 255, 255]).unwrap(),
        json!(u64::MAX)
    );
    assert_eq!(
        parse_json(&json_bytes(&decode_json(&packed).unwrap()).unwrap()).unwrap(),
        parse_json(bytes).unwrap()
    );
}

#[test]
fn json_rejects_lossy_integers_duplicates_and_malformed_input() {
    for bytes in [b"18446744073709551616".as_slice(), b"-9223372036854775809"] {
        assert!(matches!(parse_json(bytes), Err(Error::Unsupported(_))));
    }
    for bytes in [
        br#"{"x":1,"x":2}"#.as_slice(),
        br#"{"x":1,"\u0078":2}"#,
        b"[]true",
        b"[",
        b"1e999",
        b"\xff",
        b"01",
    ] {
        assert!(parse_json(bytes).is_err());
    }
    assert_eq!(
        parse_json(br#""18446744073709551616\" -9223372036854775809""#).unwrap(),
        json!("18446744073709551616\" -9223372036854775809")
    );
}

#[test]
fn standard_types_without_json_representation_are_valid_but_not_convertible() {
    for bytes in [
        vec![0xc4, 1, 0],
        vec![0xd4, 0, 1],
        vec![0xa1, 0xff],
        vec![0x81, 1, 2],
        vec![0x82, 0xa1, b'x', 1, 0xa1, b'x', 2],
        vec![0xca, 0x7f, 0x80, 0, 0],
        vec![0xcb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0],
    ] {
        validate_msgpack(&bytes).unwrap();
        assert!(matches!(decode_json(&bytes), Err(Error::Unsupported(_))));
    }
}

#[test]
fn wire_rejects_truncation_trailing_values_reserved_markers_and_allocation_bombs() {
    let packed = encode_json(br#"[{"name":"device","values":[1,2,3]}]"#).unwrap();
    for end in 0..packed.len() {
        assert!(validate_msgpack(&packed[..end]).is_err());
    }
    for bytes in [
        vec![0xc1],
        vec![0xc0, 0xc0],
        vec![0xdb, 255, 255, 255, 255],
        vec![0xdd, 255, 255, 255, 255],
        vec![0xdf, 255, 255, 255, 255],
    ] {
        assert!(validate_msgpack(&bytes).is_err());
    }
    // 各长度编码及扩展编码都必须检查完整负载。
    for marker in [
        0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xd4, 0xd5,
        0xd6, 0xd7, 0xd8,
    ] {
        assert!(validate_msgpack(&[marker]).is_err());
    }
}

#[test]
fn depth_node_and_byte_limits_apply_to_both_formats() {
    let json_at_depth = format!("{}null{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
    let packed = encode_json(json_at_depth.as_bytes()).unwrap();
    decode_json(&packed).unwrap();
    assert!(matches!(
        parse_json(format!("[{json_at_depth}]").as_bytes()),
        Err(Error::Limit)
    ));
    let mut deeper = vec![0x91];
    deeper.extend(packed);
    assert!(matches!(validate_msgpack(&deeper), Err(Error::Limit)));
    let many = format!("[{}0]", "0,".repeat(MAX_NODES - 2));
    let packed = encode_json(many.as_bytes()).unwrap();
    validate_msgpack(&packed).unwrap();
    assert!(matches!(
        parse_json(format!("[{}0]", "0,".repeat(MAX_NODES - 1)).as_bytes()),
        Err(Error::Limit)
    ));
    let mut too_many = vec![0xdd];
    too_many.extend((MAX_NODES as u32).to_be_bytes());
    too_many.extend(vec![0; MAX_NODES]);
    assert!(matches!(validate_msgpack(&too_many), Err(Error::Limit)));
    let large = vec![b' '; MAX_BYTES + 1];
    assert!(matches!(parse_json(&large), Err(Error::Limit)));
    assert!(matches!(validate_msgpack(&large), Err(Error::Limit)));
}

#[test]
fn output_expansion_is_bounded() {
    // MessagePack 的控制字符在 JSON 中需要转义，输出可能远大于输入。
    let mut bytes = vec![0xdb];
    bytes.extend(3_000_000u32.to_be_bytes());
    bytes.extend(vec![0; 3_000_000]);
    assert!(matches!(
        json_bytes(&decode_json(&bytes).unwrap()),
        Err(Error::Limit)
    ));
}
