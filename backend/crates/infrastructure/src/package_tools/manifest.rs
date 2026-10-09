use apk_domain::{
    Error, Result,
    packages::{PackageFormat, PackageManifest},
};
use quick_xml::{
    NsReader, XmlVersion,
    events::{BytesStart, Event},
    name::ResolveResult,
};
use std::collections::{BTreeMap, BTreeSet};
const ANDROID: &str = "http://schemas.android.com/apk/res/android";
fn invalid() -> Error {
    Error::Dependency("工具返回的 AndroidManifest XML 无效".into())
}
fn attributes(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<BTreeMap<(String, String), String>> {
    let mut values = BTreeMap::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| invalid())?;
        if attribute.key.0 == "xmlns" || attribute.key.0.starts_with("xmlns:") {
            continue;
        }
        let (namespace, name) = reader.resolver().resolve_attribute(attribute.key);
        let namespace = match namespace {
            ResolveResult::Unbound => "",
            ResolveResult::Bound(namespace) => namespace.0,
            ResolveResult::Unknown(_) => return Err(invalid()),
        };
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| invalid())?;
        if values
            .insert(
                (namespace.into(), name.into_inner().into()),
                value.into_owned(),
            )
            .is_some()
        {
            return Err(invalid());
        }
    }
    Ok(values)
}
pub(super) fn parse(
    id: &str,
    format: PackageFormat,
    module: Option<String>,
    xml: String,
) -> Result<PackageManifest> {
    if xml.len() > 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut result = PackageManifest {
        artifact_id: id.into(),
        format,
        module,
        package_name: String::new(),
        version_code: None,
        version_name: None,
        min_sdk: None,
        target_sdk: None,
        application_label: None,
        debuggable: None,
        permissions: Vec::new(),
        xml: String::new(),
    };
    let mut reader = NsReader::from_str(&xml);
    let mut depth = 0usize;
    let mut roots = 0;
    let mut nodes = 0;
    let mut sdk = false;
    let mut application = false;
    let mut permissions = BTreeSet::new();
    loop {
        let event = reader.read_event().map_err(|_| invalid())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                nodes += 1;
                if nodes > 20_000 || depth >= 128 {
                    return Err(Error::TooLarge);
                }
                let (namespace, name) = reader.resolver().resolve_element(element.name());
                if matches!(namespace, ResolveResult::Unknown(_)) {
                    return Err(invalid());
                }
                let unbound = matches!(namespace, ResolveResult::Unbound);
                let name = name.into_inner();
                let values = attributes(&reader, &element)?;
                let value = |namespace: &str, name: &str| {
                    values.get(&(namespace.into(), name.into())).cloned()
                };
                if depth == 0 {
                    roots += 1;
                    if roots != 1 || !unbound || name != "manifest" {
                        return Err(invalid());
                    }
                    result.package_name = value("", "package")
                        .filter(|v| !v.is_empty())
                        .ok_or_else(invalid)?;
                    result.version_code = value(ANDROID, "versionCode");
                    result.version_name = value(ANDROID, "versionName");
                } else if depth == 1 && unbound {
                    match name {
                        "uses-sdk" => {
                            if sdk {
                                return Err(invalid());
                            }
                            sdk = true;
                            result.min_sdk = value(ANDROID, "minSdkVersion");
                            result.target_sdk = value(ANDROID, "targetSdkVersion");
                        }
                        "application" => {
                            if application {
                                return Err(invalid());
                            }
                            application = true;
                            result.application_label = value(ANDROID, "label");
                            result.debuggable = value(ANDROID, "debuggable")
                                .map(|v| match v.as_str() {
                                    "true" => Ok(true),
                                    "false" => Ok(false),
                                    _ => Err(invalid()),
                                })
                                .transpose()?;
                        }
                        "uses-permission" | "uses-permission-sdk-23" => {
                            permissions.insert(
                                value(ANDROID, "name")
                                    .filter(|v| !v.is_empty())
                                    .ok_or_else(invalid)?,
                            );
                        }
                        _ => (),
                    }
                }
                if !empty {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or_else(invalid)?;
            }
            Event::DocType(_) | Event::GeneralRef(_) => return Err(invalid()),
            Event::Text(text) if !text.as_ref().trim().is_empty() => return Err(invalid()),
            Event::CData(_) => return Err(invalid()),
            Event::Eof => break,
            _ => (),
        }
    }
    if roots != 1 || depth != 0 {
        return Err(invalid());
    }
    result.permissions = permissions.into_iter().collect();
    result.xml = xml;
    Ok(result)
}
