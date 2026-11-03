//! Compatibility responses for retired managed Chromium commands.
//! No download, maintenance, executable resolution or user-data deletion remains.
//! Old renderer/session snapshots can still ask for status during an upgrade.

fn retired_status() -> serde_json::Value {
    serde_json::json!({
        "platform": null,
        "requiredRevision": "",
        "installedRevision": null,
        "installAuthorized": false,
        "state": "unsupported",
        "operationId": null,
        "downloadedBytes": null,
        "totalBytes": null,
        "progressPercent": null,
        "errorCode": "BROWSER_RESOURCE_RETIRED",
        "retryable": false,
        "automaticRetryCount": 0,
        "statusRevision": 0,
        "updatedAt": ""
    })
}

#[tauri::command]
pub fn cmd_browser_resource_status() -> serde_json::Value {
    retired_status()
}

#[tauri::command]
pub fn cmd_browser_resource_install() -> Result<serde_json::Value, String> {
    Err("BROWSER_RESOURCE_RETIRED: 请使用日常 Chrome 和 career-bridge 扩展".into())
}

#[tauri::command]
pub fn cmd_browser_resource_maintain() -> Result<serde_json::Value, String> {
    cmd_browser_resource_install()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_commands_cannot_install_or_retry() {
        let status = cmd_browser_resource_status();
        assert_eq!(status["state"], "unsupported");
        assert_eq!(status["installAuthorized"], false);
        assert_eq!(status["retryable"], false);
        assert!(cmd_browser_resource_install().is_err());
        assert!(cmd_browser_resource_maintain().is_err());
    }
}
