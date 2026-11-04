use super::{artifact::Artifact, Failure};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn client(proxy: bool) -> Result<reqwest::Client, Failure> {
    // External official artifact: use the app's proxy owner, not the loopback client.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(REQUEST_TIMEOUT);
    if proxy {
        crate::proxy_config::build_client_with_proxy(builder).map_err(Failure::network)
    } else {
        builder.no_proxy().build().map_err(Failure::network)
    }
}

async fn response(a: &Artifact, proxy: bool) -> Result<reqwest::Response, Failure> {
    let response = client(proxy)?
        .get(&a.url)
        .send()
        .await
        .map_err(Failure::network)?;
    let status = response.status();
    if !status.is_success() {
        return Err(Failure {
            code: "BROWSER_RESOURCE_DOWNLOAD_FAILED",
            retryable: status.is_server_error() || status.as_u16() == 429,
            detail: format!("Official browser download HTTP {status}"),
        });
    }
    if response.url().as_str() != a.url
        || response
            .content_length()
            .is_some_and(|n| n != a.archive_size_bytes)
    {
        return Err(Failure::verify("Browser download URL or size mismatch"));
    }
    Ok(response)
}

async fn transfer(a: &Artifact, path: &Path, proxy: bool) -> Result<(), Failure> {
    let response = response(a, proxy).await?;
    let mut file = File::create(path).map_err(Failure::io)?;
    let mut stream = response.bytes_stream();
    let mut size = 0u64;
    let mut sha = Sha256::new();
    let mut percent = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(Failure::network)?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| Failure::verify("Browser download overflow"))?;
        if size > a.archive_size_bytes {
            return Err(Failure::verify("Browser download exceeded locked size"));
        }
        file.write_all(&chunk).map_err(Failure::io)?;
        sha.update(&chunk);
        let next = ((size * 100) / a.archive_size_bytes) as u8;
        if next > percent {
            percent = next;
            super::progress(size, a.archive_size_bytes, percent);
        }
    }
    file.sync_all().map_err(Failure::io)?;
    if size != a.archive_size_bytes
        || !format!("{:x}", sha.finalize()).eq_ignore_ascii_case(&a.sha256)
    {
        return Err(Failure::verify("Browser artifact size or SHA-256 mismatch"));
    }
    Ok(())
}

pub(super) async fn download(a: &Artifact, path: &Path) -> Result<(), Failure> {
    match transfer(a, path, true).await {
        Err(error) if error.code == "BROWSER_RESOURCE_NETWORK_FAILED" => {
            crate::ulog_warn!("[browser-resource] transport=proxy fallback=direct");
            transfer(a, path, false).await
        }
        result => result,
    }
}
