use super::*;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use zip::{write::SimpleFileOptions, ZipWriter};

#[test]
fn fresh_supported_install_is_automatic_not_a_user_setup_task() {
    assert_eq!(initial_state(true, false), "checking");
    assert_eq!(initial_state(true, true), "ready");
    assert_eq!(initial_state(false, false), "unsupported");
}

#[test]
fn official_lock_is_valid_for_every_shipped_platform() {
    for platform in [
        "darwin-arm64",
        "darwin-x64",
        "win32-x64",
        "linux-x64",
        "linux-arm64",
    ] {
        assert!(artifact::locked(platform).is_ok(), "{platform}");
    }
    assert!(artifact::locked("unknown").is_err());
}

#[test]
fn artifact_urls_and_paths_cannot_escape_the_lock() {
    let (_, mut a) = artifact::locked("darwin-arm64").unwrap();
    a.url = "https://storage.googleapis.com.evil.test/chrome.zip".into();
    assert!(artifact::validate(&a).is_err());
    for path in [
        "../outside",
        "/tmp/escape",
        "C:\\escape",
        "root/../../escape",
        "root\\escape",
    ] {
        assert!(artifact::relative_path(path).is_err(), "{path}");
    }
}

fn fixture(path: &Path, name: &str) -> artifact::Artifact {
    let mut zip = ZipWriter::new(File::create(path).unwrap());
    zip.start_file(name, SimpleFileOptions::default().unix_permissions(0o755))
        .unwrap();
    zip.write_all(b"browser").unwrap();
    zip.finish().unwrap();
    let (_, mut a) = artifact::locked("linux-x64").unwrap();
    a.archive_root = "chrome".into();
    a.executable_relative_path = "chrome/browser".into();
    a.entry_count = 1;
    a.unpacked_size_bytes = 7;
    a
}

#[test]
fn bounded_archive_extracts_executable_and_rejects_bad_layouts() {
    let temp = tempfile::tempdir().unwrap();
    let zip = temp.path().join("browser.zip");
    let a = fixture(&zip, "chrome/browser");
    let dest = temp.path().join("ok");
    archive::extract(&zip, &dest, &a).unwrap();
    assert_eq!(fs::read(dest.join("chrome/browser")).unwrap(), b"browser");
    let mut mismatch = a.clone();
    mismatch.unpacked_size_bytes = 99;
    assert!(archive::extract(&zip, &temp.path().join("bad-size"), &mismatch).is_err());
    let a = fixture(&zip, "../outside");
    assert!(archive::extract(&zip, &temp.path().join("bad-path"), &a).is_err());
    assert!(!temp.path().join("outside").exists());
    let a = fixture(&zip, "chrome/other");
    assert!(archive::extract(&zip, &temp.path().join("missing-exe"), &a).is_err());
}

#[test]
fn interrupted_download_cleanup_preserves_published_files() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join(".download-interrupted.zip"), b"partial").unwrap();
    fs::create_dir(temp.path().join(".staging-interrupted")).unwrap();
    fs::write(temp.path().join("installed.json"), b"preserve").unwrap();
    install::cleanup_staging(temp.path()).unwrap();
    assert!(!temp.path().join(".download-interrupted.zip").exists());
    assert!(!temp.path().join(".staging-interrupted").exists());
    assert_eq!(
        fs::read(temp.path().join("installed.json")).unwrap(),
        b"preserve"
    );
}

#[test]
fn stale_metadata_is_not_a_ready_browser() {
    let temp = tempfile::tempdir().unwrap();
    let (set, a) = artifact::locked("darwin-arm64").unwrap();
    assert!(install::installed(temp.path(), "darwin-arm64", &set, &a).is_none());
    fs::write(temp.path().join("installed.json"), b"{bad json").unwrap();
    assert!(install::installed(temp.path(), "darwin-arm64", &set, &a).is_none());
}
