//! 在线依赖只引用本市场摘要或可信声明的官方 HTTPS，不在发布时抓取上游。
use crate::store::StoreError;
use deviceforge_plugin_dependencies::{ArchiveFormat, DependencySource, SourceKind};

pub(crate) fn validate(
    source: &DependencySource,
    authority: Option<&str>,
) -> Result<(), StoreError> {
    let invalid = || StoreError::Metadata("在线依赖来源必须为官方 HTTPS 或本市场摘要资源".into());
    if source.sha256.bytes().all(|byte| byte == b'0')
        || ["unresolved", ".", ".."].contains(&source.version.as_str())
        || (source.format == ArchiveFormat::File
            && source.entries.values().any(|entry| entry != "payload"))
    {
        return Err(invalid());
    }
    if source.kind == SourceKind::Market && source.url == source.sha256 {
        return Ok(());
    }
    let url = url::Url::parse(&source.url).map_err(|_| invalid())?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if source.kind == SourceKind::Official {
        return if url.scheme() == "https" {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    if !["http", "https"].contains(&url.scheme())
        || url.query().is_some()
        || url.path() != format!("/api/v1/resources/{}", source.sha256)
    {
        return Err(invalid());
    }
    // 反向代理须保留公开 Host；不把浏览器 Origin 或任意转发头当作市场地址。
    let authority = authority.ok_or_else(invalid)?;
    let market =
        url::Url::parse(&format!("{}://{authority}/", url.scheme())).map_err(|_| invalid())?;
    if market.host_str().is_none()
        || !market.username().is_empty()
        || market.password().is_some()
        || market.path() != "/"
        || market.query().is_some()
        || market.fragment().is_some()
        || market.host_str() != url.host_str()
        || market.port_or_known_default() != url.port_or_known_default()
    {
        return Err(invalid());
    }
    Ok(())
}
