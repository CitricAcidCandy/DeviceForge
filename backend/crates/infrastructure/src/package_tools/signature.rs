use apk_domain::{
    Error, Result,
    packages::{PackageSignature, PackageSigner, SignatureScheme},
};
use std::collections::BTreeMap;
fn invalid() -> Error {
    Error::Dependency("签名工具未返回完整、明确的验证结果".into())
}
pub(super) fn parse(id: &str, report: String) -> Result<PackageSignature> {
    let mut verifies = false;
    let mut count = None;
    let mut signers: BTreeMap<u32, (Option<String>, Option<String>)> = BTreeMap::new();
    let mut schemes = BTreeMap::new();
    for line in report.lines().map(str::trim) {
        if line == "Verifies" {
            verifies = true;
        }
        if line == "DOES NOT VERIFY" || line.starts_with("ERROR:") {
            return Err(invalid());
        }
        if let Some(value) = line.strip_prefix("Number of signers: ") {
            if count.is_some() {
                return Err(invalid());
            }
            count = Some(value.parse::<u32>().map_err(|_| invalid())?);
        }
        if let Some(value) = line.strip_prefix("Verified using ") {
            let (scheme, verified) = value.rsplit_once(": ").ok_or_else(invalid)?;
            let scheme = scheme.split_whitespace().next().ok_or_else(invalid)?;
            let verified = match verified {
                "true" => true,
                "false" => false,
                _ => return Err(invalid()),
            };
            if schemes.insert(scheme.to_owned(), verified).is_some() {
                return Err(invalid());
            }
        }
        if let Some(value) = line.strip_prefix("Signer #") {
            let (number, value) = value.split_once(' ').ok_or_else(invalid)?;
            let number = number.parse::<u32>().map_err(|_| invalid())?;
            if number == 0 || number > 32 {
                return Err(invalid());
            }
            if let Some(value) = value.strip_prefix("certificate DN: ") {
                if signers
                    .entry(number)
                    .or_default()
                    .0
                    .replace(value.into())
                    .is_some()
                {
                    return Err(invalid());
                }
            } else if let Some(value) = value.strip_prefix("certificate SHA-256 digest: ") {
                if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err(invalid());
                }
                if signers
                    .entry(number)
                    .or_default()
                    .1
                    .replace(value.to_ascii_lowercase())
                    .is_some()
                {
                    return Err(invalid());
                }
            }
        }
    }
    let count = count.filter(|v| (1..=32).contains(v)).ok_or_else(invalid)?;
    if !verifies || !schemes.values().any(|value| *value) || signers.len() != count as usize {
        return Err(invalid());
    }
    let signers = (1..=count)
        .map(|number| {
            let (distinguished_name, digest) = signers.remove(&number).ok_or_else(invalid)?;
            Ok(PackageSigner {
                number,
                distinguished_name,
                certificate_sha256: digest.ok_or_else(invalid)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(PackageSignature {
        artifact_id: id.into(),
        verified: true,
        signers,
        schemes: schemes
            .into_iter()
            .map(|(scheme, verified)| SignatureScheme { scheme, verified })
            .collect(),
        report,
    })
}
