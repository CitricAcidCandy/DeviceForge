//! 清单和归档都逐块读取；不把整个下载收集到内存，不重置执行期限。
use crate::{
    budget::Budget,
    config::validate_url,
    error::{Error, Result},
};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| Error::Dependency("创建下载客户端失败"))
}
async fn response(
    client: &reqwest::Client,
    url: &str,
    allow_http: bool,
    limit: u64,
    budget: &Budget,
) -> Result<reqwest::Response> {
    validate_url(url, allow_http)?;
    let response = budget
        .run(async {
            client
                .get(url)
                .send()
                .await
                .map_err(|_| Error::Dependency("下载请求失败"))
        })
        .await?;
    if !response.status().is_success() {
        return Err(Error::Dependency("下载服务器返回非成功状态"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(Error::TooLarge);
    }
    Ok(response)
}
pub(crate) async fn manifest(
    client: &reqwest::Client,
    url: &str,
    allow_http: bool,
    limit: u64,
    budget: &Budget,
) -> Result<Vec<u8>> {
    let mut stream = response(client, url, allow_http, limit, budget)
        .await?
        .bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = budget
        .run(async {
            stream
                .next()
                .await
                .transpose()
                .map_err(|_| Error::Dependency("清单响应读取失败"))
        })
        .await?
    {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    budget.check()?;
    Ok(bytes)
}
pub(crate) async fn archive(
    client: &reqwest::Client,
    url: &str,
    allow_http: bool,
    expected_size: u64,
    limit: u64,
    destination: &Path,
    budget: &Budget,
) -> Result<String> {
    if expected_size == 0 || expected_size > limit {
        return Err(Error::TooLarge);
    }
    let response = response(client, url, allow_http, limit.min(expected_size), budget).await?;
    if response
        .content_length()
        .is_some_and(|size| size != expected_size)
    {
        return Err(Error::Invalid("下载长度与清单不一致"));
    }
    let mut stream = response.bytes_stream();
    let mut file: File = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| Error::Io("创建暂存下载失败"))?;
    let mut total = 0u64;
    let mut hash = Sha256::new();
    while let Some(chunk) = budget
        .run(async {
            stream
                .next()
                .await
                .transpose()
                .map_err(|_| Error::Dependency("归档响应读取失败"))
        })
        .await?
    {
        total = total
            .checked_add(chunk.len() as u64)
            .filter(|size| *size <= limit && *size <= expected_size)
            .ok_or(Error::TooLarge)?;
        budget.check()?;
        file.write_all(&chunk)
            .map_err(|_| Error::Io("写入暂存下载失败"))?;
        hash.update(&chunk);
    }
    if total != expected_size {
        return Err(Error::Invalid("下载未达到清单声明长度"));
    }
    file.sync_all()
        .map_err(|_| Error::Io("持久化暂存下载失败"))?;
    budget.check()?;
    Ok(format!("{:x}", hash.finalize()))
}
