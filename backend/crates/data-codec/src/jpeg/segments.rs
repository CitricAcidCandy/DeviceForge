use super::{Error, Frame, Info, Progress, Result};

pub(super) fn frame(marker: u8, length: u16, prefix: &[u8; 18]) -> Result<Frame> {
    if length < 8 || prefix[5] == 0 {
        return Err(Error::Invalid);
    }
    if prefix[0] != 8 || prefix[5] > 4 {
        return Err(Error::Unsupported);
    }
    let components = prefix[5];
    let info = Info {
        height: u16::from_be_bytes([prefix[1], prefix[2]]),
        width: u16::from_be_bytes([prefix[3], prefix[4]]),
    };
    if length != 8 + 3 * u16::from(components) || info.width == 0 || info.height == 0 {
        return Err(Error::Invalid);
    }
    let mut identifiers = [0; 4];
    for index in 0..usize::from(components) {
        let offset = 6 + 3 * index;
        let identifier = prefix[offset];
        let horizontal = prefix[offset + 1] >> 4;
        let vertical = prefix[offset + 1] & 15;
        if identifiers[..index].contains(&identifier)
            || !(1..=4).contains(&horizontal)
            || !(1..=4).contains(&vertical)
            || prefix[offset + 2] > 3
        {
            return Err(Error::Invalid);
        }
        identifiers[index] = identifier;
    }
    Ok(Frame {
        info,
        identifiers,
        components,
        progressive: marker == 0xc2,
    })
}

pub(super) fn scan(
    frame: Frame,
    mut progress: Progress,
    length: u16,
    prefix: &[u8; 18],
) -> Result<Progress> {
    let components = prefix[0];
    if components == 0 || components > frame.components || length != 6 + 2 * u16::from(components) {
        return Err(Error::Invalid);
    }
    let mut selected = 0u8;
    for index in 0..usize::from(components) {
        let offset = 1 + 2 * index;
        let position = frame.identifiers[..usize::from(frame.components)]
            .iter()
            .position(|identifier| *identifier == prefix[offset])
            .ok_or(Error::Invalid)?;
        let bit = 1 << position;
        if selected & bit != 0 || prefix[offset + 1] >> 4 > 3 || prefix[offset + 1] & 15 > 3 {
            return Err(Error::Invalid);
        }
        selected |= bit;
    }
    let offset = 1 + 2 * usize::from(components);
    let start = prefix[offset];
    let end = prefix[offset + 1];
    let high = prefix[offset + 2] >> 4;
    let low = prefix[offset + 2] & 15;
    if !frame.progressive {
        if [start, end, high, low] != [0, 63, 0, 0] || progress.covered_components & selected != 0 {
            return Err(Error::Invalid);
        }
        progress.covered_components |= selected;
        return Ok(progress);
    }
    if start > end
        || end > 63
        || (start == 0 && end != 0)
        || (start != 0 && components != 1)
        || high > 13
        || low > 13
        || (high != 0 && high != low + 1)
    {
        return Err(Error::Invalid);
    }
    if start == 0 && high == 0 {
        if progress.covered_components & selected != 0 {
            return Err(Error::Invalid);
        }
        progress.covered_components |= selected;
    } else if progress.covered_components & selected != selected {
        return Err(Error::Invalid);
    }
    let expected = if high == 0 { u8::MAX } else { high };
    for (position, coefficients) in progress
        .approximations
        .iter_mut()
        .enumerate()
        .take(usize::from(frame.components))
    {
        if selected & (1 << position) == 0 {
            continue;
        }
        let band = &mut coefficients[usize::from(start)..=usize::from(end)];
        if band.iter().any(|previous| *previous != expected) {
            return Err(Error::Invalid);
        }
        band.fill(low);
    }
    Ok(progress)
}
