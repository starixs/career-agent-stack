//! Rust owns the app's browser binary. First launch prepares it automatically;
//! the Global Sidecar starts it with the same extension bridge used by all callers.
//! No Playwright driver, personal Chrome profile changes, or login-cookie copying.
mod archive;
mod artifact;
mod download;
mod install;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

const AUTOMATIC_ATTEMPTS: u8 = 2;
const RETRY_DELAY: Duration = Duration::from_secs(5);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static STATUS: OnceLock<Mutex<BrowserResourceStatus>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResourceStatus {
    pub platform: Option<String>,
    pub required_revision: String,
    pub installed_revision: Option<String>,
    pub install_authorized: bool,
    pub state: String,
    pub operation_id: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub progress_percent: Option<u8>,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub automatic_retry_count: u8,
    pub status_revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResourceResolution {
    pub executable_path: String,
    pub revision: String,
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    retryable: bool,
    detail: String,
}
impl Failure {
    fn io(e: impl std::fmt::Display) -> Self {
        Self {
            code: "BROWSER_RESOURCE_INSTALL_FAILED",
            retryable: true,
            detail: e.to_string(),
        }
    }
    fn network(e: impl std::fmt::Display) -> Self {
        Self {
            code: "BROWSER_RESOURCE_NETWORK_FAILED",
            retryable: true,
            detail: e.to_string(),
        }
    }
    fn verify(e: impl std::fmt::Display) -> Self {
        Self {
            code: "BROWSER_RESOURCE_VERIFY_FAILED",
            retryable: false,
            detail: e.to_string(),
        }
    }
}

fn resource() -> Option<BrowserResourceResolution> {
    let platform = artifact::platform_key()?;
    let (set, a) = artifact::locked(platform).ok()?;
    install::installed(&install::root().ok()?, platform, &set, &a)
}

fn initial_status() -> BrowserResourceStatus {
    let platform = artifact::platform_key();
    let lock = platform.and_then(|p| artifact::locked(p).ok());
    let installed = resource();
    let state = initial_state(lock.is_some(), installed.is_some());
    BrowserResourceStatus {
        platform: platform.map(str::to_string),
        required_revision: lock
            .as_ref()
            .map(|(set, _)| set.clone())
            .unwrap_or_default(),
        installed_revision: installed.map(|r| r.revision),
        install_authorized: lock.is_some(),
        state: state.into(),
        operation_id: None,
        downloaded_bytes: None,
        total_bytes: lock.map(|(_, a)| a.archive_size_bytes),
        progress_percent: if state == "ready" { Some(100) } else { None },
        error_code: if state == "unsupported" {
            Some("BROWSER_RESOURCE_UNSUPPORTED".into())
        } else {
            None
        },
        retryable: false,
        automatic_retry_count: 0,
        status_revision: 1,
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn initial_state(supported: bool, installed: bool) -> &'static str {
    if !supported {
        "unsupported"
    } else if installed {
        "ready"
    } else {
        "checking"
    }
}

fn cell() -> &'static Mutex<BrowserResourceStatus> {
    STATUS.get_or_init(|| Mutex::new(initial_status()))
}
fn current_status() -> BrowserResourceStatus {
    cell().lock().expect("browser status poisoned").clone()
}

fn update(change: impl FnOnce(&mut BrowserResourceStatus)) {
    let next = {
        let mut status = cell().lock().expect("browser status poisoned");
        change(&mut status);
        status.status_revision += 1;
        status.updated_at = chrono::Utc::now().to_rfc3339();
        status.clone()
    };
    if let Some(app) = crate::logger::get_app_handle() {
        if let Err(e) = app.emit("browser-resource-status", &next) {
            crate::ulog_warn!("[browser-resource] status emit failed: {e}");
        }
    }
}

fn phase(state: &str) {
    update(|s| s.state = state.into());
}
fn progress(bytes: u64, total: u64, percent: u8) {
    update(|s| {
        s.downloaded_bytes = Some(bytes);
        s.total_bytes = Some(total);
        s.progress_percent = Some(percent);
    });
}

fn finish(result: Result<(), Failure>, retries_remaining: bool) -> bool {
    match result {
        Ok(()) => {
            update(|s| {
                s.state = "ready".into();
                s.installed_revision = Some(s.required_revision.clone());
                s.progress_percent = Some(100);
                s.error_code = None;
                s.retryable = false;
                s.operation_id = None;
            });
            crate::ulog_info!("[browser-resource] ready");
            false
        }
        Err(e) => {
            crate::ulog_warn!(
                "[browser-resource] failed code={} detail={}",
                e.code,
                e.detail
            );
            update(|s| {
                s.state = if e.retryable && retries_remaining {
                    "checking"
                } else {
                    "install_failed"
                }
                .into();
                s.error_code = Some(e.code.into());
                s.retryable = e.retryable;
                s.operation_id = None;
            });
            e.retryable
        }
    }
}

pub fn start_automatic_maintenance() {
    let status = current_status();
    if matches!(status.state.as_str(), "ready" | "unsupported")
        || ACTIVE.swap(true, Ordering::SeqCst)
    {
        return;
    }
    update(|s| {
        s.state = "checking".into();
        s.error_code = None;
        s.retryable = false;
    });
    tauri::async_runtime::spawn(async {
        for attempt in 1..=AUTOMATIC_ATTEMPTS {
            update(|s| {
                s.automatic_retry_count = attempt;
                s.operation_id = Some(uuid::Uuid::new_v4().to_string());
            });
            let result = tauri::async_runtime::spawn_blocking(install::ensure)
                .await
                .unwrap_or_else(|e| Err(Failure::io(e)));
            if !finish(result, attempt < AUTOMATIC_ATTEMPTS) || attempt == AUTOMATIC_ATTEMPTS {
                break;
            }
            tokio::time::sleep(RETRY_DELAY).await;
        }
        ACTIVE.store(false, Ordering::SeqCst);
    });
}

pub fn resolve_browser_resource() -> Result<BrowserResourceResolution, BrowserResourceStatus> {
    resource().ok_or_else(current_status)
}

#[tauri::command]
pub fn cmd_browser_resource_status() -> BrowserResourceStatus {
    current_status()
}

#[tauri::command]
pub fn cmd_browser_resource_install() -> BrowserResourceStatus {
    start_automatic_maintenance();
    current_status()
}

#[tauri::command]
pub fn cmd_browser_resource_maintain() -> BrowserResourceStatus {
    cmd_browser_resource_install()
}
