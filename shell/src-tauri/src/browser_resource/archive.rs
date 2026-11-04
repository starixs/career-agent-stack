//! Bounded extraction, adapted from the original browser resource owner.
use super::artifact::{relative_path, Artifact, MAX_ARCHIVE_ENTRIES, MAX_UNPACKED_BYTES};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_LINK_BYTES: u64 = 4096;
type Links = Vec<(PathBuf, PathBuf)>;

fn declared_entries(path: &Path) -> Result<usize, String> {
    const FOOTER_SIZE: u64 = 22;
    const SEARCH_SIZE: u64 = FOOTER_SIZE + u16::MAX as u64;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size < FOOTER_SIZE {
        return Err("Invalid browser zip footer".into());
    }
    let tail_size = size.min(SEARCH_SIZE);
    file.seek(SeekFrom::Start(size - tail_size))
        .map_err(|e| e.to_string())?;
    let mut tail = vec![0u8; tail_size as usize];
    file.read_exact(&mut tail).map_err(|e| e.to_string())?;
    for i in (0..=tail.len() - FOOTER_SIZE as usize).rev() {
        if tail[i..i + 4] != [0x50, 0x4b, 0x05, 0x06] {
            continue;
        }
        let at = |n| u16::from_le_bytes([tail[i + n], tail[i + n + 1]]);
        if i + FOOTER_SIZE as usize + usize::from(at(20)) != tail.len() {
            continue;
        }
        if at(4) != 0 || at(6) != 0 || at(8) != at(10) || at(10) == u16::MAX {
            return Err("Unsupported multi-disk or ZIP64 browser archive".into());
        }
        return Ok(usize::from(at(10)));
    }
    Err("Invalid browser zip footer".into())
}

fn inspect(archive: &mut ZipArchive<File>, a: &Artifact) -> Result<Links, String> {
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    let mut size = 0u64;
    let mut executable = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let path = relative_path(entry.name().trim_end_matches('/'))?;
        if !path.starts_with(&a.archive_root) || !seen.insert(path.clone()) {
            return Err("Duplicate or out-of-root browser archive entry".into());
        }
        size = size
            .checked_add(entry.size())
            .ok_or("Archive size overflow")?;
        if size > MAX_UNPACKED_BYTES {
            return Err("Browser archive unpacked size exceeded".into());
        }
        if entry.is_symlink() {
            if entry.size() > MAX_LINK_BYTES {
                return Err("Browser symlink too large".into());
            }
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .map_err(|e| e.to_string())?;
            links.push((path, relative_path(&target)?));
        } else if !entry.is_dir() {
            if entry
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000))
            {
                return Err("Special files forbidden in browser archive".into());
            }
            executable |= path == Path::new(&a.executable_relative_path);
        }
    }
    if !executable || size != a.unpacked_size_bytes {
        return Err("Browser archive contents mismatch".into());
    }
    #[cfg(windows)]
    if !links.is_empty() {
        return Err("Browser symlinks unsupported on Windows".into());
    }
    Ok(links)
}

fn extract_files(archive: &mut ZipArchive<File>, staging: &Path) -> Result<(), String> {
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_symlink() {
            continue;
        }
        let output = staging.join(relative_path(entry.name().trim_end_matches('/'))?);
        if entry.is_dir() {
            fs::create_dir_all(output).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = File::create(&output).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        if copied != entry.size() {
            return Err("Browser extracted file size mismatch".into());
        }
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn create_links(staging: &Path, links: Links) -> Result<(), String> {
    #[cfg(unix)]
    for (path, target) in &links {
        let output = staging.join(path);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::os::unix::fs::symlink(target, output).map_err(|e| e.to_string())?;
    }
    let root = staging.canonicalize().map_err(|e| e.to_string())?;
    for (path, _) in links {
        let target = staging
            .join(path)
            .canonicalize()
            .map_err(|e| format!("Invalid browser symlink: {e}"))?;
        if !target.starts_with(&root) {
            return Err("Browser symlink escapes staging".into());
        }
    }
    Ok(())
}

pub(super) fn extract(path: &Path, staging: &Path, artifact: &Artifact) -> Result<(), String> {
    let count = declared_entries(path)?;
    if count == 0 || count != artifact.entry_count || count > MAX_ARCHIVE_ENTRIES {
        return Err("Browser archive entry count mismatch".into());
    }
    let mut archive =
        ZipArchive::new(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if archive.len() != count {
        return Err("Duplicate browser archive entries".into());
    }
    let links = inspect(&mut archive, artifact)?;
    fs::create_dir_all(staging).map_err(|e| e.to_string())?;
    extract_files(&mut archive, staging)?;
    create_links(staging, links)
}
