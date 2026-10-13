use deviceforge_data_codec::jpeg::{Error, Info, MAX_BYTES, MAX_SEGMENTS, Validator};

fn segment(bytes: &mut Vec<u8>, marker: u8, payload: &[u8]) {
    bytes.extend([0xff, marker]);
    bytes.extend(u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
    bytes.extend(payload);
}

fn frame(progressive: bool, components: u8) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8];
    let mut payload = vec![8, 0, 2, 0, 3, components];
    for identifier in 1..=components {
        payload.extend([identifier, 0x11, 0]);
    }
    segment(&mut bytes, if progressive { 0xc2 } else { 0xc0 }, &payload);
    bytes
}

fn scan(bytes: &mut Vec<u8>, identifiers: &[u8], spectral: [u8; 3], data: &[u8]) {
    let mut payload = vec![u8::try_from(identifiers.len()).unwrap()];
    for identifier in identifiers {
        payload.extend([*identifier, 0]);
    }
    payload.extend(spectral);
    segment(bytes, 0xda, &payload);
    bytes.extend(data);
}

fn baseline() -> Vec<u8> {
    let mut bytes = frame(false, 1);
    scan(&mut bytes, &[1], [0, 63, 0], &[0x12, 0xff, 0, 0x34]);
    bytes.extend([0xff, 0xd9]);
    bytes
}

fn validate(bytes: &[u8]) -> Result<Info, Error> {
    let mut validator = Validator::new();
    validator.push(bytes)?;
    validator.finish()
}

#[test]
fn baseline_survives_every_chunk_boundary() {
    let bytes = baseline();
    for size in 1..=bytes.len() {
        let mut validator = Validator::default();
        for chunk in bytes.chunks(size) {
            validator.push(chunk).unwrap();
            validator.push(&[]).unwrap();
        }
        assert_eq!(
            validator.finish(),
            Ok(Info {
                width: 3,
                height: 2
            })
        );
    }
}

#[test]
fn every_truncation_and_trailing_byte_is_rejected() {
    let bytes = baseline();
    for end in 0..bytes.len() {
        assert_eq!(validate(&bytes[..end]), Err(Error::Invalid), "{end}");
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert_eq!(validate(&trailing), Err(Error::Invalid));
    let mut doubled = bytes.clone();
    doubled.extend(bytes);
    assert_eq!(validate(&doubled), Err(Error::Invalid));
}

#[test]
fn baseline_covers_each_component_in_separate_scans() {
    let mut bytes = frame(false, 4);
    for identifier in 1..=4 {
        scan(&mut bytes, &[identifier], [0, 63, 0], &[1]);
    }
    bytes.extend([0xff, 0xd9]);
    assert!(validate(&bytes).is_ok());
    let mut missing = frame(false, 2);
    scan(&mut missing, &[1], [0, 63, 0], &[1]);
    missing.extend([0xff, 0xd9]);
    assert_eq!(validate(&missing), Err(Error::Invalid));
    let mut repeated = frame(false, 1);
    scan(&mut repeated, &[1], [0, 63, 0], &[1]);
    scan(&mut repeated, &[1], [0, 63, 0], &[1]);
    repeated.extend([0xff, 0xd9]);
    assert_eq!(validate(&repeated), Err(Error::Invalid));
}

#[test]
fn progressive_dc_ac_and_refinement_are_supported() {
    let mut bytes = frame(true, 2);
    scan(&mut bytes, &[1, 2], [0, 0, 1], &[1]);
    scan(&mut bytes, &[1], [1, 63, 1], &[2]);
    scan(&mut bytes, &[2], [1, 63, 1], &[3]);
    scan(&mut bytes, &[1, 2], [0, 0, 0x10], &[4]);
    scan(&mut bytes, &[1], [1, 63, 0x10], &[5]);
    bytes.extend([0xff, 0xd9]);
    assert!(validate(&bytes).is_ok());
}

#[test]
fn frame_precision_dimensions_components_and_lengths_are_checked() {
    for (offset, value, error) in [
        (6, 12, Error::Unsupported),
        (8, 0, Error::Invalid),
        (10, 0, Error::Invalid),
        (11, 0, Error::Invalid),
        (11, 5, Error::Unsupported),
        (13, 0x01, Error::Invalid),
        (13, 0x50, Error::Invalid),
        (14, 4, Error::Invalid),
        (5, 10, Error::Invalid),
    ] {
        let mut bytes = baseline();
        bytes[offset] = value;
        assert_eq!(validate(&bytes), Err(error), "{offset}:{value}");
    }
    let mut duplicate = frame(false, 2);
    duplicate[15] = 1;
    assert_eq!(validate(&duplicate), Err(Error::Invalid));
    let mut duplicate_frame = frame(false, 1);
    duplicate_frame.extend(&frame(false, 1)[2..]);
    assert_eq!(validate(&duplicate_frame), Err(Error::Invalid));
}

#[test]
fn invalid_scan_fields_and_empty_entropy_are_rejected() {
    for payload in [
        vec![0, 0, 63, 0],
        vec![1, 2, 0, 0, 63, 0],
        vec![1, 1, 0x40, 0, 63, 0],
        vec![1, 1, 0, 1, 63, 0],
        vec![1, 1, 0, 0, 62, 0],
        vec![1, 1, 0, 0, 63, 1],
        vec![2, 1, 0, 1, 0, 0, 63, 0],
    ] {
        let mut bytes = frame(false, 2);
        segment(&mut bytes, 0xda, &payload);
        bytes.extend([1, 0xff, 0xd9]);
        assert_eq!(validate(&bytes), Err(Error::Invalid), "{payload:?}");
    }
    let mut empty = frame(false, 1);
    scan(&mut empty, &[1], [0, 63, 0], &[]);
    empty.extend([0xff, 0xd9]);
    assert_eq!(validate(&empty), Err(Error::Invalid));
    let mut absent_frame = vec![0xff, 0xd8];
    scan(&mut absent_frame, &[1], [0, 63, 0], &[1]);
    absent_frame.extend([0xff, 0xd9]);
    assert_eq!(validate(&absent_frame), Err(Error::Invalid));
}

#[test]
fn invalid_progressive_spectral_and_approximation_fields_are_rejected() {
    for (identifiers, spectral) in [
        (vec![1, 2], [1, 63, 0]),
        (vec![1], [0, 63, 0]),
        (vec![1], [2, 1, 0]),
        (vec![1], [1, 64, 0]),
        (vec![1], [1, 63, 0x20]),
        (vec![1], [1, 63, 14]),
    ] {
        let mut bytes = frame(true, 2);
        scan(&mut bytes, &[1, 2], [0, 0, 0], &[1]);
        scan(&mut bytes, &identifiers, spectral, &[1]);
        bytes.extend([0xff, 0xd9]);
        assert_eq!(validate(&bytes), Err(Error::Invalid));
    }
}

#[test]
fn restart_markers_require_interval_and_cyclic_sequence() {
    let mut bytes = frame(false, 1);
    segment(&mut bytes, 0xdd, &[0, 1]);
    let mut data = vec![1];
    for index in 0..10 {
        data.extend([0xff, 0xd0 + index % 8, 1]);
    }
    scan(&mut bytes, &[1], [0, 63, 0], &data);
    bytes.extend([0xff, 0xd9]);
    assert!(validate(&bytes).is_ok());
    for interval in [None, Some(0), Some(1)] {
        let mut bytes = frame(false, 1);
        if let Some(interval) = interval {
            segment(&mut bytes, 0xdd, &[0, interval]);
        }
        scan(&mut bytes, &[1], [0, 63, 0], &[1, 0xff, 0xd1, 1]);
        bytes.extend([0xff, 0xd9]);
        assert_eq!(validate(&bytes), Err(Error::Invalid));
    }
    for data in [
        vec![0xff, 0xd0, 1],
        vec![1, 0xff, 0xd0, 0xff, 0xd1, 1],
        vec![1, 0xff, 0xd0],
    ] {
        let mut bytes = frame(false, 1);
        segment(&mut bytes, 0xdd, &[0, 1]);
        scan(&mut bytes, &[1], [0, 63, 0], &data);
        bytes.extend([0xff, 0xd9]);
        assert_eq!(validate(&bytes), Err(Error::Invalid));
    }
}

#[test]
fn progressive_refinement_requires_matching_previous_approximation() {
    for spectral in [[1, 63, 0x10], [0, 0, 0x10]] {
        let mut bytes = frame(true, 1);
        scan(&mut bytes, &[1], [0, 0, 0], &[1]);
        scan(&mut bytes, &[1], spectral, &[1]);
        bytes.extend([0xff, 0xd9]);
        assert_eq!(validate(&bytes), Err(Error::Invalid));
    }
    let mut bytes = frame(true, 1);
    scan(&mut bytes, &[1], [0, 0, 2], &[1]);
    scan(&mut bytes, &[1], [0, 0, 0x21], &[1]);
    scan(&mut bytes, &[1], [0, 0, 0x10], &[1]);
    bytes.extend([0xff, 0xd9]);
    assert!(validate(&bytes).is_ok());
}

#[test]
fn progressive_initial_bands_cannot_overlap_but_can_be_refined() {
    let mut bytes = frame(true, 1);
    scan(&mut bytes, &[1], [0, 0, 0], &[1]);
    scan(&mut bytes, &[1], [1, 31, 1], &[1]);
    let mut overlap = bytes.clone();
    scan(&mut overlap, &[1], [31, 63, 1], &[1]);
    overlap.extend([0xff, 0xd9]);
    assert_eq!(validate(&overlap), Err(Error::Invalid));
    scan(&mut bytes, &[1], [32, 63, 1], &[1]);
    scan(&mut bytes, &[1], [1, 63, 0x10], &[1]);
    bytes.extend([0xff, 0xd9]);
    assert!(validate(&bytes).is_ok());
}

#[test]
fn unsupported_codings_and_illegal_marker_positions_are_rejected() {
    for marker in [0xc1, 0xc3, 0xc9, 0xca, 0xcc, 0xdc, 0xde, 0xdf] {
        let mut bytes = baseline();
        bytes[3] = marker;
        assert_eq!(validate(&bytes), Err(Error::Unsupported), "{marker:x}");
    }
    for bytes in [
        vec![0xff, 0xd8, 0xff, 0xd9],
        vec![0xff, 0xd8, 0xff, 0xd8],
        vec![0xff, 0xd8, 0xff, 0xd0],
        vec![0xff, 0xd8, 0xff, 0],
        vec![0xff, 0xd8, 0xff, 0xe0, 0, 1],
    ] {
        assert_eq!(validate(&bytes), Err(Error::Invalid));
    }
}

#[test]
fn failure_stays_sticky_and_metadata_is_bounded_by_segment_count() {
    let mut validator = Validator::new();
    assert_eq!(validator.push(&[0]), Err(Error::Invalid));
    assert_eq!(validator.push(&baseline()), Err(Error::Invalid));
    assert_eq!(validator.finish(), Err(Error::Invalid));
    for extra in [0, 1] {
        let mut validator = Validator::new();
        validator.push(&[0xff, 0xd8]).unwrap();
        for _ in 0..MAX_SEGMENTS - 3 + extra {
            validator.push(&[0xff, 0xe0, 0, 2]).unwrap();
        }
        let result = validator.push(&baseline()[2..]);
        if extra == 0 {
            assert!(result.is_ok());
            assert!(validator.finish().is_ok());
        } else {
            assert_eq!(result, Err(Error::Limit));
        }
    }
}

#[test]
fn byte_limit_accepts_exact_boundary_and_rejects_next_chunk() {
    let mut validator = Validator::new();
    let mut header = frame(false, 1);
    scan(&mut header, &[1], [0, 63, 0], &[]);
    validator.push(&header).unwrap();
    let mut remaining = MAX_BYTES - header.len() as u64 - 2;
    let chunk = [1; 64 * 1024];
    while remaining != 0 {
        let length = remaining.min(chunk.len() as u64) as usize;
        validator.push(&chunk[..length]).unwrap();
        remaining -= length as u64;
    }
    validator.push(&[0xff, 0xd9]).unwrap();
    assert!(validator.finish().is_ok());
    let mut validator = Validator::new();
    validator.push(&header).unwrap();
    let oversized = vec![1; MAX_BYTES as usize - header.len() + 1];
    assert_eq!(validator.push(&oversized), Err(Error::Limit));
    assert_eq!(validator.finish(), Err(Error::Invalid));
}
