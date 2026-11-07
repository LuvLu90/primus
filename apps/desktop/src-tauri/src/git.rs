//! Git 只读查询：状态、Diff、分支。
//!
//! 当前只实现分支（`git_branch`，输入框上方的唇条显示）：直接读 `.git/HEAD`，不调用 git 程序、不写任何文件。
//! 支持工作区位于仓库子目录（向上查找）、worktree / submodule（`.git` 是写着 `gitdir:` 的文件）与分离 HEAD（显示短 SHA）。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// HEAD 与 `.git` 文件都很小；超过这个长度视为损坏，不再读取。
const MAX_SMALL_FILE: u64 = 4096;
/// 向上查找 `.git` 的最大层数（防止异常的深层路径）。
const MAX_DEPTH: usize = 64;
/// 分离 HEAD 时显示的 SHA 长度。
const SHORT_SHA: usize = 7;

/// 当前分支（`git_branch` 的返回值）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranch {
    /// 分支名（如 `main`、`feat/x`）；分离 HEAD 时为短 SHA
    pub name: String,
    /// HEAD 未指向分支（检出了某个提交）
    pub detached: bool,
}

/// 读取 `workspace` 所在仓库的当前分支；不是 Git 仓库（或 HEAD 无法识别）时返回 `None`。
pub(crate) fn branch(workspace: &Path) -> Option<GitBranch> {
    let git_dir = find_git_dir(workspace)?;
    let head = read_small(&git_dir.join("HEAD"))?;
    parse_head(&head)
}

/// 从 `start` 向上找到仓库的 git 目录：`.git` 目录本身，或 `.git` 文件中 `gitdir:` 指向的目录。
fn find_git_dir(start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors().take(MAX_DEPTH) {
        let dot_git = dir.join(".git");
        let Ok(meta) = fs::metadata(&dot_git) else {
            continue;
        };
        if meta.is_dir() {
            return Some(dot_git);
        }
        if meta.is_file() {
            let content = read_small(&dot_git)?;
            let target = parse_gitdir_file(&content)?;
            let resolved = if target.is_absolute() {
                target
            } else {
                dir.join(target)
            };
            return resolved.is_dir().then_some(resolved);
        }
    }
    None
}

/// `.git` 文件（worktree、submodule）：`gitdir: <路径>`。
fn parse_gitdir_file(content: &str) -> Option<PathBuf> {
    let line = content.lines().next()?.trim();
    let path = line.strip_prefix("gitdir:")?.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// 解析 HEAD：`ref: refs/heads/<分支>` 为分支；40 位（SHA-1）或 64 位（SHA-256）十六进制为分离 HEAD。
fn parse_head(content: &str) -> Option<GitBranch> {
    let line = content.lines().next()?.trim();
    if let Some(reference) = line.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference
            .strip_prefix("refs/heads/")
            .or_else(|| reference.strip_prefix("refs/"))
            .unwrap_or(reference);
        if name.is_empty() || name.chars().any(char::is_control) {
            return None;
        }
        return Some(GitBranch {
            name: name.to_string(),
            detached: false,
        });
    }
    let is_sha =
        (line.len() == 40 || line.len() == 64) && line.bytes().all(|b| b.is_ascii_hexdigit());
    is_sha.then(|| GitBranch {
        name: line[..SHORT_SHA].to_ascii_lowercase(),
        detached: true,
    })
}

/// 读取小文本文件；不存在、过大或不是 UTF-8 时返回 `None`。
fn read_small(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut buf = String::new();
    file.take(MAX_SMALL_FILE + 1)
        .read_to_string(&mut buf)
        .ok()?;
    (buf.len() as u64 <= MAX_SMALL_FILE).then_some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的临时目录（系统临时目录下，结束时删除；不写入 App 数据）。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "primus-git-test-{name}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_branch_refs() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some(GitBranch {
                name: "main".into(),
                detached: false
            })
        );
        assert_eq!(
            parse_head("ref: refs/heads/feat/composer-redesign\r\n").map(|b| b.name),
            Some("feat/composer-redesign".into())
        );
        assert_eq!(
            parse_head("ref: refs/remotes/origin/x").map(|b| b.name),
            Some("remotes/origin/x".into())
        );
        assert_eq!(parse_head("ref: "), None);
        assert_eq!(parse_head(""), None);
    }

    #[test]
    fn parses_detached_head_as_short_sha() {
        let sha1 = "A411CA1d9c2e4f0b8a7c6d5e4f3a2b1c0d9e8f7a";
        assert_eq!(
            parse_head(sha1),
            Some(GitBranch {
                name: "a411ca1".into(),
                detached: true
            })
        );
        let sha256 = "0123456789abcdef".repeat(4);
        assert_eq!(parse_head(&sha256).map(|b| b.name), Some("0123456".into()));
        assert_eq!(parse_head("not-a-sha"), None);
        assert_eq!(parse_head("a411ca1"), None);
    }

    #[test]
    fn parses_gitdir_file() {
        assert_eq!(
            parse_gitdir_file("gitdir: ../.git/worktrees/x\n"),
            Some(PathBuf::from("../.git/worktrees/x"))
        );
        assert_eq!(parse_gitdir_file("gitdir:"), None);
        assert_eq!(parse_gitdir_file("something else"), None);
    }

    #[test]
    fn reads_branch_from_repo_and_subdirectory() {
        let tmp = TempDir::new("repo");
        let repo = tmp.0.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("src/deep")).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        let expected = Some(GitBranch {
            name: "dev".into(),
            detached: false,
        });
        assert_eq!(branch(&repo), expected);
        assert_eq!(branch(&repo.join("src/deep")), expected);
    }

    #[test]
    fn follows_worktree_gitdir_file() {
        let tmp = TempDir::new("worktree");
        let main_git = tmp.0.join("main/.git/worktrees/wt");
        fs::create_dir_all(&main_git).unwrap();
        fs::write(main_git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        let wt = tmp.0.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        assert_eq!(branch(&wt).map(|b| b.name), Some("feature".into()));
        // 指向不存在的目录：不是仓库
        fs::write(wt.join(".git"), "gitdir: ../missing\n").unwrap();
        assert_eq!(branch(&wt), None);
    }

    #[test]
    fn not_a_repo_or_oversized_head() {
        let tmp = TempDir::new("plain");
        let plain = tmp.0.join("plain");
        fs::create_dir_all(&plain).unwrap();
        // 临时目录的上层可能恰好在某个仓库里：只断言自建的大 HEAD 被拒绝
        let repo = tmp.0.join("big");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(
            repo.join(".git/HEAD"),
            "x".repeat(MAX_SMALL_FILE as usize + 10),
        )
        .unwrap();
        assert_eq!(branch(&repo), None);
        assert_eq!(read_small(&plain.join("missing")), None);
    }
}
