use super::{
    archive,
    artifact::{self, Artifact},
    download, BrowserResourceResolution, Failure,
};
use crate::utils::file_lock::{with_file_lock_blocking, FileLockOptions};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_STALE: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(100);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    schema_version: u32,
    runtime_set: String,
    platform: String,
    executable_relative_path: String,
    sha256: String,
    source: String,
}

pub(super) fn root() -> Result<PathBuf, Failure> {
    crate::app_dirs::keystone_data_dir()
        .map(|p| p.join("runtimes/browser"))
        .ok_or_else(|| Failure::io("Cannot determine app data directory"))
}

pub(super) fn installed(
    root: &Path,
    platform: &str,
    set: &str,
    a: &Artifact,
) -> Option<BrowserResourceResolution> {
    let path = root.join("installed.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            crate::ulog_warn!("[browser-resource] metadata read failed: {e}");
            return None;
        }
    };
    let meta: Installed = match serde_json::from_slice(&bytes) {
        Ok(meta) => meta,
        Err(e) => {
            crate::ulog_warn!("[browser-resource] metadata invalid: {e}");
            return None;
        }
    };
    if meta.schema_version != 2
        || meta.runtime_set != set
        || meta.platform != platform
        || meta.source != "playwright-official"
        || !meta.sha256.eq_ignore_ascii_case(&a.sha256)
        || meta.executable_relative_path != a.executable_relative_path
    {
        return None;
    }
    let dir = root.join(set).join(platform).canonicalize().ok()?;
    let executable = dir.join(&a.executable_relative_path).canonicalize().ok()?;
    if !executable.starts_with(dir) || !executable.is_file() {
        return None;
    }
    Some(BrowserResourceResolution {
        executable_path: executable.to_string_lossy().into(),
        revision: set.into(),
    })
}

fn remove_owned(path: &Path, directory: bool) {
    let result = if directory {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    if let Err(e) = result {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::ulog_warn!("[browser-resource] staging cleanup failed: {e}");
        }
    }
}

fn restore_backup(target: &Path, backup: &Path, existed: bool) {
    remove_owned(target, true);
    if existed {
        if let Err(e) = fs::rename(backup, target) {
            crate::ulog_warn!("[browser-resource] rollback failed: {e}");
        }
    }
}

fn publish(
    root: &Path,
    staging: &Path,
    platform: &str,
    set: &str,
    a: &Artifact,
) -> Result<(), Failure> {
    let target = root.join(set).join(platform);
    let parent = target
        .parent()
        .ok_or_else(|| Failure::io("Invalid browser target"))?;
    fs::create_dir_all(parent).map_err(Failure::io)?;
    let backup = root.join(format!(".old-{}", Uuid::new_v4()));
    let existed = target.exists();
    if existed {
        fs::rename(&target, &backup).map_err(Failure::io)?;
    }
    if let Err(e) = fs::rename(staging, &target) {
        restore_backup(&target, &backup, existed);
        return Err(Failure::io(e));
    }
    let metadata = Installed {
        schema_version: 2,
        runtime_set: set.into(),
        platform: platform.into(),
        executable_relative_path: a.executable_relative_path.clone(),
        sha256: a.sha256.clone(),
        source: "playwright-official".into(),
    };
    let bytes = serde_json::to_vec_pretty(&metadata).map_err(Failure::io)?;
    if let Err(e) =
        crate::workspace_files::path_safety::atomic_write_file(&root.join("installed.json"), &bytes)
    {
        restore_backup(&target, &backup, existed);
        return Err(Failure::io(e));
    }
    if existed {
        remove_owned(&backup, true);
    }
    Ok(())
}

pub(super) fn cleanup_staging(root: &Path) -> Result<(), Failure> {
    // Called only under the shared installation lock. Never touch profiles or
    // published versions, and never follow a staging symlink during removal.
    for entry in fs::read_dir(root).map_err(Failure::io)? {
        let entry = entry.map_err(Failure::io)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".download-") && !name.starts_with(".staging-") {
            continue;
        }
        if entry.file_type().map_err(Failure::io)?.is_dir() {
            fs::remove_dir_all(entry.path()).map_err(Failure::io)?;
        } else {
            fs::remove_file(entry.path()).map_err(Failure::io)?;
        }
    }
    Ok(())
}

fn install_locked(root: &Path, platform: &str, set: &str, a: &Artifact) -> Result<(), Failure> {
    if installed(root, platform, set, a).is_some() {
        return Ok(());
    }
    cleanup_staging(root)?;
    let free = crate::filesystem_capacity::available_space(root).map_err(Failure::io)?;
    if free < a.archive_size_bytes.saturating_add(a.unpacked_size_bytes) {
        return Err(Failure {
            code: "BROWSER_RESOURCE_DISK_FULL",
            retryable: false,
            detail: "Insufficient disk space".into(),
        });
    }
    let id = Uuid::new_v4();
    let zip = root.join(format!(".download-{id}.zip"));
    let staging = root.join(format!(".staging-{id}"));
    let result = (|| {
        super::phase("downloading");
        tokio::runtime::Handle::current().block_on(download::download(a, &zip))?;
        super::phase("installing");
        archive::extract(&zip, &staging, a).map_err(Failure::verify)?;
        publish(root, &staging, platform, set, a)
    })();
    remove_owned(&zip, false);
    remove_owned(&staging, true);
    result
}

pub(super) fn ensure() -> Result<(), Failure> {
    let platform =
        artifact::platform_key().ok_or_else(|| Failure::verify("Unsupported browser platform"))?;
    let (set, a) = artifact::locked(platform).map_err(Failure::verify)?;
    let root = root()?;
    fs::create_dir_all(&root).map_err(Failure::io)?;
    with_file_lock_blocking(
        &root.join("install.lock"),
        FileLockOptions {
            timeout: LOCK_TIMEOUT,
            stale: LOCK_STALE,
            poll: LOCK_POLL,
        },
        || Ok(install_locked(&root, platform, &set, &a)),
    )
    .map_err(Failure::io)?
}
