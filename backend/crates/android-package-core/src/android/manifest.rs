use crate::{
    Control, Error, LimitKind, ManifestData, Result,
    profiles::{MAX_TEXT_BYTES, MAX_XML_DEPTH, MAX_XML_NODES},
};
use quick_xml::{
    NsReader, XmlVersion,
    events::{BytesStart, Event, attributes::Attribute},
    name::{QName, ResolveResult},
};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
};

const ANDROID: &str = "http://schemas.android.com/apk/res/android";
fn invalid() -> Error {
    Error::InvalidManifest("AndroidManifest XML 结构或命名空间无效")
}

fn namespace_uri(namespace: ResolveResult<'_>) -> Result<String> {
    match namespace {
        ResolveResult::Unbound => Ok(String::new()),
        ResolveResult::Unknown(_) => Err(invalid()),
        ResolveResult::Bound(namespace) => {
            // 解析器的 URI 仍是声明原文，须按属性值规范化一次才比较扩展名称。
            let attribute = Attribute {
                key: QName("xmlns"),
                value: Cow::Borrowed(namespace.0),
            };
            attribute
                .normalized_value(XmlVersion::Implicit1_0)
                .map(Cow::into_owned)
                .map_err(|_| invalid())
        }
    }
}

fn attributes(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
    control: &Control<'_>,
) -> Result<BTreeMap<(String, String), String>> {
    let mut values = BTreeMap::new();
    for attribute in element.attributes() {
        control.check()?;
        let attribute = attribute.map_err(|_| invalid())?;
        // 未使用的声明也必须验证实体；不能因跳过 xmlns 而接受未定义实体。
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| invalid())?;
        if attribute.key.0 == "xmlns" || attribute.key.0.starts_with("xmlns:") {
            continue;
        }
        let (namespace, name) = reader.resolver().resolve_attribute(attribute.key);
        let namespace = namespace_uri(namespace)?;
        if values
            .insert((namespace, name.into_inner().into()), value.into_owned())
            .is_some()
        {
            return Err(invalid());
        }
    }
    Ok(values)
}

pub fn parse_manifest(xml: &str, control: &Control<'_>) -> Result<ManifestData> {
    control.check()?;
    if xml.len() > MAX_TEXT_BYTES {
        return Err(Error::limit(LimitKind::TextBytes, MAX_TEXT_BYTES as u64));
    }
    let mut result = ManifestData {
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
    let mut reader = NsReader::from_str(xml);
    let mut depth = 0usize;
    let mut roots = 0;
    let mut nodes = 0;
    let mut sdk = false;
    let mut application = false;
    let mut permissions = BTreeSet::new();
    loop {
        control.check()?;
        let event = reader.read_event().map_err(|_| invalid())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                nodes += 1;
                if nodes > MAX_XML_NODES {
                    return Err(Error::limit(LimitKind::XmlNodes, MAX_XML_NODES as u64));
                }
                if depth >= MAX_XML_DEPTH {
                    return Err(Error::limit(LimitKind::XmlDepth, MAX_XML_DEPTH as u64));
                }
                let (namespace, name) = reader.resolver().resolve_element(element.name());
                let unbound = namespace_uri(namespace)?.is_empty();
                let name = name.into_inner();
                let values = attributes(&reader, &element, control)?;
                let value = |namespace: &str, name: &str| {
                    values.get(&(namespace.into(), name.into())).cloned()
                };
                if depth == 0 {
                    roots += 1;
                    if roots != 1 || !unbound || name != "manifest" {
                        return Err(invalid());
                    }
                    result.package_name = value("", "package")
                        .filter(|value| !value.is_empty())
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
                                .map(|value| match value.as_str() {
                                    "true" => Ok(true),
                                    "false" => Ok(false),
                                    _ => Err(invalid()),
                                })
                                .transpose()?;
                        }
                        "uses-permission" | "uses-permission-sdk-23" => {
                            permissions.insert(
                                value(ANDROID, "name")
                                    .filter(|value| !value.is_empty())
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
            Event::DocType(_) | Event::GeneralRef(_) | Event::CData(_) => return Err(invalid()),
            Event::Text(text) if !text.as_ref().trim().is_empty() => return Err(invalid()),
            Event::Eof => break,
            _ => (),
        }
    }
    if roots != 1 || depth != 0 {
        return Err(invalid());
    }
    result.permissions = permissions.into_iter().collect();
    result.xml = xml.to_owned();
    control.check()?;
    Ok(result)
}
