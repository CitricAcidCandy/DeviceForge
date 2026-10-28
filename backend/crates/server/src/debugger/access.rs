//! 调试访问独立核对真实回环连接；普通局域网业务的准入规则不变。
use crate::{ApiError, client_connection::ClientConnection};
use axum::{
    extract::ConnectInfo,
    http::{StatusCode, Uri, header, request::Parts},
};
use std::net::IpAddr;

fn loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| match address {
                IpAddr::V6(address) => address
                    .to_ipv4_mapped()
                    .map_or(address.is_loopback(), |mapped| mapped.is_loopback()),
                address => address.is_loopback(),
            })
}

pub(super) fn check(parts: &Parts) -> Result<(), ApiError> {
    let connected = parts
        .extensions
        .get::<ConnectInfo<ClientConnection>>()
        .is_some_and(|ConnectInfo(client)| client.is_loopback());
    if !connected {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "debugger_local_only",
            "插件调试仅允许本机连接，请使用 127.0.0.1 或 localhost 访问宿主；普通局域网功能不受影响",
        ));
    }
    let mut origins = parts.headers.get_all(header::ORIGIN).iter();
    let Some(origin) = origins.next() else {
        return Ok(());
    };
    let allowed = origins.next().is_none()
        && origin
            .to_str()
            .ok()
            .and_then(|text| text.parse::<Uri>().ok())
            .is_some_and(|uri| {
                matches!(uri.scheme_str(), Some("http" | "https"))
                    && uri
                        .authority()
                        .is_some_and(|authority| !authority.as_str().contains('@'))
                    && uri.host().is_some_and(loopback_host)
                    && uri.path() == "/"
                    && uri.query().is_none()
            });
    if !allowed {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "debugger_origin_rejected",
            "请在本机地址打开 DeviceForge 后再调试插件；当前网页不是本机回环来源",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, Request};

    fn parts(peer: &str, origin: Option<&str>) -> Parts {
        let mut request = Request::builder();
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        let (mut parts, ()) = request.body(()).unwrap().into_parts();
        parts
            .extensions
            .insert(ConnectInfo(ClientConnection::from_addresses(
                peer.parse().unwrap(),
                None,
            )));
        parts
    }

    #[test]
    fn true_socket_and_browser_origin_are_both_required() {
        for origin in [
            None,
            Some("http://localhost:5173"),
            Some("https://127.0.0.1:7031"),
            Some("http://[::1]:7031"),
        ] {
            assert!(check(&parts("127.0.0.1:1000", origin)).is_ok());
        }
        for origin in [
            "null",
            "https://localhost.example.com",
            "http://192.168.1.2",
            "file:///tmp/page",
            "http://localhost/other",
            "http://localhost?token=x",
            "http://user@localhost",
        ] {
            assert!(
                check(&parts("127.0.0.1:1000", Some(origin))).is_err(),
                "{origin}"
            );
        }
        let mut remote = parts("192.168.1.2:1000", Some("http://localhost:5173"));
        remote
            .headers
            .insert("x-forwarded-for", HeaderValue::from_static("127.0.0.1"));
        assert!(check(&remote).is_err());
        let mut missing = parts("127.0.0.1:1000", None);
        missing.extensions.clear();
        assert!(check(&missing).is_err());
    }

    #[test]
    fn multiple_origins_are_not_treated_as_a_local_request() {
        let mut request = parts("127.0.0.1:1000", Some("http://localhost"));
        request.headers.append(
            header::ORIGIN,
            HeaderValue::from_static("https://example.com"),
        );
        assert!(check(&request).is_err());
    }
}
