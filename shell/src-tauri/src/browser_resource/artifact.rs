//! App-pinned official browser artifacts. Reuses the pre-bridge runtime lock.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

pub const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 6000;
const LOCK: &str = include_str!("../../../src/shared/managed-browser-runtime.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLock {
    schema_version: u32,
    runtime_set: String,
    chromium_revision: String,
    chromium_browser_version: String,
    official_artifacts: HashMap<String, Artifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Artifact {
    pub source_url: String,
    pub url: String,
    pub sha256: String,
    pub archive_size_bytes: u64,
    pub unpacked_size_bytes: u64,
    pub entry_count: usize,
    pub archive_root: String,
    pub executable_relative_path: String,
}

pub(super) fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win32-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

pub(super) fn locked(platform: &str) -> Result<(String, Artifact), String> {
    let mut lock: RuntimeLock =
        serde_json::from_str(LOCK).map_err(|e| format!("browser lock: {e}"))?;
    if lock.schema_version != 2
        || lock.runtime_set.is_empty()
        || !lock
            .runtime_set
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    {
        return Err("Invalid browser runtime lock".into());
    }
    let artifact = lock
        .official_artifacts
        .remove(platform)
        .ok_or("Unsupported browser platform")?;
    validate(&artifact)?;
    let version = if platform == "linux-arm64" {
        lock.chromium_revision
    } else {
        lock.chromium_browser_version
    };
    if !artifact.url.contains(&format!("/{version}/"))
        || !artifact.source_url.contains(&format!("/{version}/"))
    {
        return Err("Browser artifact version mismatch".into());
    }
    Ok((lock.runtime_set, artifact))
}

pub(super) fn relative_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if raw.is_empty()
        || raw.contains(['\\', ':'])
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe browser archive path".into());
    }
    Ok(path.to_path_buf())
}

pub(super) fn validate(a: &Artifact) -> Result<(), String> {
    if a.sha256.len() != 64
        || !a.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || a.archive_size_bytes == 0
        || a.archive_size_bytes > MAX_ARCHIVE_BYTES
        || a.unpacked_size_bytes == 0
        || a.unpacked_size_bytes > MAX_UNPACKED_BYTES
        || a.entry_count == 0
        || a.entry_count > MAX_ARCHIVE_ENTRIES
        || a.archive_root.contains(['/', '\\'])
        || a.archive_root.is_empty()
        || !a
            .executable_relative_path
            .starts_with(&format!("{}/", a.archive_root))
    {
        return Err("Invalid browser artifact lock".into());
    }
    relative_path(&a.executable_relative_path)?;
    let source = valid_url(&a.source_url)?;
    if source.host_str() != Some("cdn.playwright.dev") || !source.path().starts_with("/builds/") {
        return Err("Browser source is not official".into());
    }
    let download = valid_url(&a.url)?;
    let allowed = match download.host_str() {
        Some("storage.googleapis.com") => {
            download.path().starts_with("/chrome-for-testing-public/")
        }
        Some("cdn.playwright.dev") => download.path().starts_with("/builds/chromium/"),
        Some("playwright.download.prss.microsoft.com") => true,
        _ => false,
    };
    if !allowed {
        return Err("Browser download host is not allowlisted".into());
    }
    Ok(())
}

fn valid_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|e| format!("Invalid browser URL: {e}"))?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Unsafe browser artifact URL".into());
    }
    Ok(url)
}
