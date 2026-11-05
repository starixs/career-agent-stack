//! Keep the bundled workspace's `.claude/skills/` in step with the app.
//!
//! `cmd_initialize_bundled_workspace` copies the career template once and then
//! treats the workspace as user-owned. Skills inside it, however, are product
//! instructions the user never edits: a one-time copy left installs missing
//! skills added later (inbox-triage, material-draft, resume-draft,
//! resume-import) and running stale playbooks.
//!
//! This module re-syncs ONLY the skill directories the template lists, gated by
//! a content fingerprint of the template's skills tree (not the app version:
//! dev builds keep one version while skills change daily). Everything else in
//! the workspace — CLAUDE.md, user files, skills the template does not ship,
//! and symlinked global-skill projections — is left alone.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{ulog_info, ulog_warn};

/// Stamp written next to `.claude/skills/` recording the last synced template.
pub const BUNDLED_SKILLS_STAMP: &str = ".bundled-skills-fingerprint";

/// Files under each skill dir that are never product content.
fn skipped(name: &std::ffi::OsStr) -> bool {
    name == ".git" || name == "node_modules" || name == ".DS_Store"
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if skipped(&entry.file_name()) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_files(root, &entry.path(), out)?;
        } else {
            out.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(&entry.path())
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

/// Stable fingerprint of a skills tree: sorted relative paths + file bytes.
pub fn skills_fingerprint(template_skills: &Path) -> std::io::Result<String> {
    let mut files = Vec::new();
    collect_files(template_skills, template_skills, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for rel in &files {
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update([0u8]);
        hasher.update(fs::read(template_skills.join(rel))?);
        hasher.update([0u8]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        if skipped(&entry.file_name()) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Replace one skill dir wholesale. A symlink at `dst` is a projection of a
/// global skill owned elsewhere, so it is reported and left untouched.
fn replace_skill(src: &Path, dst: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(dst) {
        Ok(meta) if meta.file_type().is_symlink() => {
            ulog_warn!(
                "[workspace] skill {} is a symlink projection; not overwriting",
                dst.display()
            );
            return Ok(false);
        }
        Ok(meta) => {
            let removed = if meta.is_dir() {
                fs::remove_dir_all(dst)
            } else {
                fs::remove_file(dst)
            };
            removed.map_err(|e| format!("clear {}: {}", dst.display(), e))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("stat {}: {}", dst.display(), e)),
    }
    copy_tree(src, dst)
        .map_err(|e| format!("copy {} -> {}: {}", src.display(), dst.display(), e))?;
    Ok(true)
}

fn stamp_path(dest_skills: &Path) -> PathBuf {
    dest_skills
        .parent()
        .unwrap_or(dest_skills)
        .join(BUNDLED_SKILLS_STAMP)
}

/// Record that `dest_skills` already matches the template (a fresh full copy),
/// so the next open does not rewrite every skill dir again.
pub fn record_bundled_workspace_skills(
    template_skills: &Path,
    dest_skills: &Path,
) -> Result<(), String> {
    if !template_skills.is_dir() {
        return Ok(());
    }
    let fingerprint = skills_fingerprint(template_skills)
        .map_err(|e| format!("fingerprint {}: {}", template_skills.display(), e))?;
    let stamp = stamp_path(dest_skills);
    fs::write(&stamp, &fingerprint).map_err(|e| format!("write {}: {}", stamp.display(), e))
}

/// Sync template skills into `dest_skills` when the template fingerprint
/// changed. Returns how many skill dirs were (re)written; 0 when up to date.
pub fn sync_bundled_workspace_skills(
    template_skills: &Path,
    dest_skills: &Path,
) -> Result<usize, String> {
    if !template_skills.is_dir() {
        return Ok(0);
    }
    let fingerprint = skills_fingerprint(template_skills)
        .map_err(|e| format!("fingerprint {}: {}", template_skills.display(), e))?;
    let stamp = stamp_path(dest_skills);
    if fs::read_to_string(&stamp)
        .map(|s| s.trim() == fingerprint)
        .unwrap_or(false)
    {
        return Ok(0);
    }
    fs::create_dir_all(dest_skills)
        .map_err(|e| format!("create {}: {}", dest_skills.display(), e))?;
    let mut written = 0;
    let entries = fs::read_dir(template_skills)
        .map_err(|e| format!("read {}: {}", template_skills.display(), e))?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) || skipped(&entry.file_name()) {
            continue;
        }
        if replace_skill(&entry.path(), &dest_skills.join(entry.file_name()))? {
            written += 1;
        }
    }
    fs::write(&stamp, &fingerprint).map_err(|e| format!("write {}: {}", stamp.display(), e))?;
    ulog_info!(
        "[workspace] synced bundled skills: {} dirs into {}",
        written,
        dest_skills.display()
    );
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn updates_listed_skills_adds_new_ones_and_leaves_everything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let template = tmp.path().join("template/.claude/skills");
        let workspace = tmp.path().join("ws");
        let dest = workspace.join(".claude/skills");
        write(&template.join("a/SKILL.md"), "a v2");
        write(&template.join("b/SKILL.md"), "b v1");
        write(&dest.join("a/SKILL.md"), "a v1");
        write(&dest.join("a/stale.md"), "old extra file");
        write(&dest.join("user-own/SKILL.md"), "mine");
        write(&workspace.join("CLAUDE.md"), "user edited");
        let global = tmp.path().join("global-c");
        write(&global.join("SKILL.md"), "global");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&global, dest.join("c")).unwrap();

        assert_eq!(sync_bundled_workspace_skills(&template, &dest).unwrap(), 2);

        assert_eq!(fs::read_to_string(dest.join("a/SKILL.md")).unwrap(), "a v2");
        assert!(!dest.join("a/stale.md").exists());
        assert_eq!(fs::read_to_string(dest.join("b/SKILL.md")).unwrap(), "b v1");
        assert_eq!(
            fs::read_to_string(dest.join("user-own/SKILL.md")).unwrap(),
            "mine"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("CLAUDE.md")).unwrap(),
            "user edited"
        );
        #[cfg(unix)]
        assert!(fs::symlink_metadata(dest.join("c"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(workspace
            .join(".claude")
            .join(BUNDLED_SKILLS_STAMP)
            .exists());
    }

    #[test]
    fn recording_a_fresh_copy_makes_the_next_sync_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let template = tmp.path().join("t");
        let dest = tmp.path().join("ws/.claude/skills");
        write(&template.join("a/SKILL.md"), "v1");
        write(&dest.join("a/SKILL.md"), "v1");
        record_bundled_workspace_skills(&template, &dest).unwrap();
        assert_eq!(sync_bundled_workspace_skills(&template, &dest).unwrap(), 0);
    }

    #[test]
    fn same_template_is_a_no_op_and_a_change_resyncs() {
        let tmp = tempfile::tempdir().unwrap();
        let template = tmp.path().join("t");
        let dest = tmp.path().join("ws/.claude/skills");
        write(&template.join("a/SKILL.md"), "v1");
        assert_eq!(sync_bundled_workspace_skills(&template, &dest).unwrap(), 1);
        write(&dest.join("a/SKILL.md"), "locally changed");
        assert_eq!(sync_bundled_workspace_skills(&template, &dest).unwrap(), 0);
        assert_eq!(
            fs::read_to_string(dest.join("a/SKILL.md")).unwrap(),
            "locally changed"
        );
        write(&template.join("a/SKILL.md"), "v2");
        assert_eq!(sync_bundled_workspace_skills(&template, &dest).unwrap(), 1);
        assert_eq!(fs::read_to_string(dest.join("a/SKILL.md")).unwrap(), "v2");
    }
}
