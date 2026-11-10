//! 有界HTTP获取；不复制业务客户端的令牌、Cookie或其他认证头。
use super::budget;
use apk_domain::{Error, Result, plugin_guides::MAX_GUIDE_BYTES};
use futures_util::StreamExt;
use std::{
    net::IpAddr,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) fn validate(source: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(source).map_err(|_| Error::Invalid("指南下载地址无效".into()))?;
    if !allowed(&url) {
        return Err(Error::Invalid(
            "指南地址须为HTTPS或本机测试HTTP，且不能含凭据或片段".into(),
        ));
    }
    Ok(url)
}

fn allowed(url: &reqwest::Url) -> bool {
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host().is_some()
        && (url.scheme() == "https" || (url.scheme() == "http" && local))
}

pub(super) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let downgrade = attempt.url().scheme() != "https"
                && attempt.previous().iter().any(|url| url.scheme() == "https");
            if attempt.previous().len() > 3 || downgrade || !allowed(attempt.url()) {
                attempt.error("指南重定向超出范围")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| Error::Dependency("指南下载客户端创建失败".into()))
}

pub(super) async fn download(
    client: &reqwest::Client,
    source: reqwest::Url,
    deadline: Instant,
    cancel: CancellationToken,
) -> Result<Vec<u8>> {
    budget::wait(deadline, &cancel, async {
        let response = client
            .get(source)
            .timeout(deadline.saturating_duration_since(Instant::now()))
            .send()
            .await
            .map_err(|error| download_error(error, "指南下载未完成"))?;
        if !response.status().is_success() {
            return Err(Error::Dependency("指南来源返回失败状态".into()));
        }
        if response
            .content_length()
            .is_some_and(|bytes| bytes > MAX_GUIDE_BYTES as u64)
        {
            return Err(Error::TooLarge);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| download_error(error, "指南正文接收失败"))?;
            if chunk.len() > MAX_GUIDE_BYTES.saturating_sub(body.len()) {
                return Err(Error::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
    .await
}

fn download_error(error: reqwest::Error, message: &str) -> Error {
    if error.is_timeout() {
        Error::Timeout
    } else {
        Error::Dependency(message.into())
    }
}
