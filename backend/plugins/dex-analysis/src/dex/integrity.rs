use crate::{Error, Result};
use deviceforge_android_package_core::Control;
use sha1::{Digest, Sha1};

pub(super) fn verify(bytes: &[u8], control: &Control<'_>) -> Result<()> {
    let mut digest = Sha1::new();
    for chunk in bytes[32..].chunks(65_536) {
        control.check()?;
        digest.update(chunk);
    }
    if digest.finalize()[..] != bytes[12..32] {
        return Err(Error::Invalid("DEX内部SHA-1签名不一致"));
    }
    let mut first = 1u32;
    let mut second = 0u32;
    for chunk in bytes[12..].chunks(5552) {
        control.check()?;
        for &byte in chunk {
            first += u32::from(byte);
            second += first;
        }
        first %= 65_521;
        second %= 65_521;
    }
    if super::word(bytes, 8)? != ((second << 16) | first) {
        return Err(Error::Invalid("DEX内部Adler32不一致"));
    }
    control.check()?;
    Ok(())
}
