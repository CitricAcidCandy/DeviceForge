use sha1::{Digest, Sha1};

pub(crate) struct Sample {
    pub bytes: Vec<u8>,
    pub types: usize,
    pub classes: usize,
    pub string_data: Vec<usize>,
    pub map: usize,
}

pub(crate) fn put(bytes: &mut [u8], position: usize, value: u32) {
    bytes[position..position + 4].copy_from_slice(&value.to_le_bytes());
}

pub(crate) fn seal(bytes: &mut [u8]) {
    let signature = Sha1::digest(&bytes[32..]);
    bytes[12..32].copy_from_slice(&signature);
    let mut first = 1u32;
    let mut second = 0u32;
    for &value in &bytes[12..] {
        first = (first + u32::from(value)) % 65_521;
        second = (second + first) % 65_521;
    }
    put(bytes, 8, (second << 16) | first);
}

pub(crate) fn sample(classes: &[&str], referenced: &[&str]) -> Sample {
    let mut names = classes
        .iter()
        .chain(referenced)
        .map(|name| format!("L{name};"))
        .collect::<Vec<_>>();
    names.sort_by_cached_key(|name| name.encode_utf16().collect::<Vec<_>>());
    names.dedup();
    let strings = if names.is_empty() { 0 } else { 112 };
    let types = if names.is_empty() {
        0
    } else {
        112 + names.len() * 4
    };
    let class_start = 112 + names.len() * 8;
    let data = class_start + classes.len() * 32;
    let mut bytes = vec![0u8; data];
    bytes[..8].copy_from_slice(b"dex\n039\0");
    put(&mut bytes, 36, 112);
    put(&mut bytes, 40, 0x1234_5678);
    put(&mut bytes, 56, names.len() as u32);
    put(&mut bytes, 60, strings as u32);
    put(&mut bytes, 64, names.len() as u32);
    put(&mut bytes, 68, types as u32);
    put(&mut bytes, 96, classes.len() as u32);
    put(
        &mut bytes,
        100,
        if classes.is_empty() {
            0
        } else {
            class_start as u32
        },
    );
    put(&mut bytes, 108, data as u32);
    let mut string_data = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let offset = bytes.len();
        string_data.push(offset);
        put(&mut bytes, strings + index * 4, offset as u32);
        put(&mut bytes, types + index * 4, index as u32);
        let units = name.encode_utf16().collect::<Vec<_>>();
        let mut length = units.len() as u32;
        loop {
            bytes.push((length as u8 & 0x7f) | if length > 0x7f { 0x80 } else { 0 });
            length >>= 7;
            if length == 0 {
                break;
            }
        }
        for unit in units {
            match unit {
                1..=0x7f => bytes.push(unit as u8),
                0..=0x7ff => bytes
                    .extend_from_slice(&[(0xc0 | (unit >> 6)) as u8, (0x80 | (unit & 0x3f)) as u8]),
                _ => bytes.extend_from_slice(&[
                    (0xe0 | (unit >> 12)) as u8,
                    (0x80 | ((unit >> 6) & 0x3f)) as u8,
                    (0x80 | (unit & 0x3f)) as u8,
                ]),
            }
        }
        bytes.push(0);
    }
    let mut defined = classes
        .iter()
        .map(|class| {
            names
                .iter()
                .position(|name| name == &format!("L{class};"))
                .unwrap()
        })
        .collect::<Vec<_>>();
    defined.sort();
    for (index, descriptor) in defined.into_iter().enumerate() {
        let position = class_start + index * 32;
        put(&mut bytes, position, descriptor as u32);
        put(&mut bytes, position + 4, 1);
        put(&mut bytes, position + 8, u32::MAX);
        put(&mut bytes, position + 16, u32::MAX);
    }
    while !bytes.len().is_multiple_of(4) {
        bytes.push(0);
    }
    let map = bytes.len();
    let mut entries = vec![(0u16, 1u32, 0usize)];
    if !names.is_empty() {
        entries.push((1, names.len() as u32, strings));
        entries.push((2, names.len() as u32, types));
    }
    if !classes.is_empty() {
        entries.push((6, classes.len() as u32, class_start));
    }
    if !names.is_empty() {
        entries.push((0x2002, names.len() as u32, data));
    }
    entries.push((0x1000, 1, map));
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (kind, count, offset) in entries {
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&count.to_le_bytes());
        bytes.extend_from_slice(&(offset as u32).to_le_bytes());
    }
    let size = bytes.len();
    put(&mut bytes, 32, size as u32);
    put(&mut bytes, 52, map as u32);
    put(&mut bytes, 104, (size - data) as u32);
    seal(&mut bytes);
    Sample {
        bytes,
        types,
        classes: class_start,
        string_data,
        map,
    }
}

pub(crate) fn members() -> Vec<u8> {
    let names = ["I", "Lcom/example/Entry;", "V", "field", "method"];
    let mut bytes = vec![0u8; 204];
    bytes[..8].copy_from_slice(b"dex\n039\0");
    put(&mut bytes, 36, 112);
    put(&mut bytes, 40, 0x1234_5678);
    for (index, (count, offset)) in [
        (5u32, 112u32),
        (3, 132),
        (1, 144),
        (1, 156),
        (1, 164),
        (1, 172),
    ]
    .into_iter()
    .enumerate()
    {
        put(&mut bytes, 56 + index * 8, count);
        put(&mut bytes, 60 + index * 8, offset);
    }
    put(&mut bytes, 108, 204);
    for (index, name) in names.iter().enumerate() {
        let offset = bytes.len();
        put(&mut bytes, 112 + index * 4, offset as u32);
        bytes.push(name.len() as u8);
        bytes.extend_from_slice(name.as_bytes());
        bytes.push(0);
    }
    for index in 0..3 {
        put(&mut bytes, 132 + index * 4, index as u32);
    }
    put(&mut bytes, 144, 2);
    put(&mut bytes, 148, 2);
    bytes[156..158].copy_from_slice(&1u16.to_le_bytes());
    put(&mut bytes, 160, 3);
    bytes[164..166].copy_from_slice(&1u16.to_le_bytes());
    put(&mut bytes, 168, 4);
    put(&mut bytes, 172, 1);
    put(&mut bytes, 176, 1);
    put(&mut bytes, 180, u32::MAX);
    put(&mut bytes, 188, u32::MAX);
    while !bytes.len().is_multiple_of(4) {
        bytes.push(0);
    }
    let map = bytes.len();
    bytes.extend_from_slice(&9u32.to_le_bytes());
    for (kind, count, offset) in [
        (0u16, 1u32, 0usize),
        (1, 5, 112),
        (2, 3, 132),
        (3, 1, 144),
        (4, 1, 156),
        (5, 1, 164),
        (6, 1, 172),
        (0x2002, 5, 204),
        (0x1000, 1, map),
    ] {
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&count.to_le_bytes());
        bytes.extend_from_slice(&(offset as u32).to_le_bytes());
    }
    let size = bytes.len();
    put(&mut bytes, 32, size as u32);
    put(&mut bytes, 52, map as u32);
    put(&mut bytes, 104, (size - 204) as u32);
    seal(&mut bytes);
    bytes
}
