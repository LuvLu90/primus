//! 用系统默认程序打开本机文件、在文件夹中显示（附录 B `open_path` / `reveal_path`）。
//!
//! 路径来自助手回复（不可信）：只接受本机已存在的绝对路径；拒绝网址与其他协议、网络路径（UNC，
//! 访问会向对方服务器发起 SMB 认证）与设备路径；可执行与脚本类文件不直接打开，改为在文件夹中显示。
//! 前端负责把相对路径按会话工作区解析成绝对路径、去掉行号。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 直接打开可能执行代码的扩展名（小写）：打开时改为在文件夹中显示。
/// Windows 上 .js / .vbs 等默认由脚本宿主运行，装了 Python / Perl / Ruby 后 .py / .pl / .rb 由解释器直接运行，
/// .lnk / .url / .appref-ms / .jnlp 会启动别的程序，.chm 可带脚本，.iso / .vhd 会挂载磁盘；
/// macOS 的 .app / .command 会启动程序。
const RISKY_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "scr",
    "pif",
    "cpl",
    "msc",
    "msi",
    "msp",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appinstaller",
    "application",
    "gadget",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "ps1xml",
    "psc1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "ws",
    "hta",
    "jar",
    "reg",
    "inf",
    "lnk",
    "url",
    "scf",
    "library-ms",
    "settingcontent-ms",
    "diagcab",
    "app",
    "command",
    "tool",
    "workflow",
    "terminal",
    "sh",
    "run",
    "py",
    "pyw",
    "pyz",
    "pyc",
    "pyo",
    "pl",
    "rb",
    "jnlp",
    "appref-ms",
    "chm",
    "sct",
    "wsc",
    "xll",
    "iso",
    "img",
    "vhd",
    "vhdx",
];

/// 路径的最大长度（字符）
const MAX_LEN: usize = 4096;

/// `open_path` 的结果：直接打开，或因是可执行文件改为在文件夹中显示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenOutcome {
    Opened,
    Revealed,
}

/// 校验通过的路径
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CheckedPath {
    /// 交给系统打开的路径（展开 `~` 后的原路径；不用规范化结果，避免映射盘变成网络路径）
    pub(crate) path: PathBuf,
    /// 是否是可执行或脚本类文件（自身或链接目标的扩展名；Unix 上另含带执行权限的文件）
    pub(crate) risky: bool,
}

/// 文件名的扩展名是否在 [`RISKY_EXTENSIONS`] 中（大小写不敏感；末尾的点与空格按 Windows 规则忽略；
/// 只有扩展名的 `.exe` 也算）。
pub(crate) fn is_risky(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let name = name.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    // 只有扩展名的文件（`.exe`）同样会被系统按扩展名运行
    RISKY_EXTENSIONS.iter().any(|ext| {
        name.len() > ext.len()
            && name.ends_with(ext)
            && name[..name.len() - ext.len()].ends_with('.')
    })
}

/// Unix：带执行权限的普通文件（无扩展名的脚本、程序）。默认打开程序可能直接运行它，改为在文件夹中显示。
#[cfg(unix)]
fn is_executable(target: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(target).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_target: &Path) -> bool {
    false
}

/// 网址或其他协议（`http:`、`mailto:`、`ms-settings:`…）；Windows 盘符（`C:`）不算。
fn has_scheme(raw: &str) -> bool {
    if raw.contains("://") {
        return true;
    }
    let Some((scheme, _)) = raw.split_once(':') else {
        return false;
    };
    scheme.len() > 1
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

/// 网络路径（`\\server\share`、`//server/share`）与设备路径（`\\?\`、`\\.\`）。
fn is_network_or_device(raw: &str) -> bool {
    let b = raw.as_bytes();
    b.len() >= 2 && matches!(b[0], b'\\' | b'/') && matches!(b[1], b'\\' | b'/')
}

/// 展开开头的 `~`（`~`、`~/x`、`~\x`）为用户主目录；取不到主目录时原样返回。
fn expand_home(raw: &str, home: Option<&Path>) -> PathBuf {
    let rest = if raw == "~" {
        Some("")
    } else {
        raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\"))
    };
    match (rest, home) {
        (Some(""), Some(home)) => home.to_path_buf(),
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(raw),
    }
}

/// 用户主目录（Windows `USERPROFILE`，其他 `HOME`）；只用于展开回复里的 `~/…`，不写入任何数据（约束 C2）。
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// 校验要打开 / 显示的路径。错误文案可直接显示给用户。
pub(crate) fn check_path(raw: &str) -> Result<CheckedPath, String> {
    check_path_with_home(raw, home_dir().as_deref())
}

pub(crate) fn check_path_with_home(raw: &str, home: Option<&Path>) -> Result<CheckedPath, String> {
    if raw.is_empty() || raw.chars().count() > MAX_LEN || raw.chars().any(char::is_control) {
        return Err("路径格式不正确".into());
    }
    if has_scheme(raw) {
        return Err("只能打开本机文件，不能打开网址".into());
    }
    if is_network_or_device(raw) {
        return Err("不支持打开网络路径或设备路径".into());
    }
    // Windows：统一成反斜杠（回复里常写 C:/x/y.ts），ShellExecute 与 explorer 都按反斜杠处理
    #[cfg(windows)]
    let raw = &raw.replace('/', "\\");
    let path = expand_home(raw, home);
    if !path.is_absolute() {
        return Err("需要文件的完整路径".into());
    }
    // 展开后仍不能是网络路径（主目录本身在网络共享上时）
    if is_network_or_device(&path.to_string_lossy()) {
        return Err("不支持打开网络路径或设备路径".into());
    }
    let target = match std::fs::canonicalize(&path) {
        Ok(target) => target,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("找不到文件：{}", path.display()));
        }
        Err(e) => return Err(format!("无法访问 {}：{e}", path.display())),
    };
    let risky = is_risky(&path) || is_risky(&target) || is_executable(&target);
    Ok(CheckedPath { path, risky })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::tests::TempDir;

    #[test]
    fn risky_extensions() {
        for name in [
            "setup.exe",
            "SETUP.EXE",
            "run.bat",
            "x.cmd",
            "a.ps1",
            "b.msi",
            "c.js",
            "d.vbs",
            "e.lnk",
            "f.url",
            "g.hta",
            "Foo.app",
            "evil.exe.",
            "evil.exe ",
            "y.sh",
            "render.py",
            "gui.pyw",
            "app.pyz",
            "x.pl",
            "y.rb",
            "tool.appref-ms",
            "a.jnlp",
            "help.chm",
            "disk.iso",
            ".exe",
            ".BAT",
        ] {
            assert!(is_risky(Path::new(name)), "{name}");
        }
        for name in [
            "main.rs",
            "README.md",
            "data.json",
            "exe",
            "notes.txt",
            "photo.png",
            "x.jsx",
            "bundle.mjs",
            "index.ts",
            "folder",
        ] {
            assert!(!is_risky(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn schemes_and_network_paths_are_refused() {
        for raw in [
            "https://example.com/a.txt",
            "file:///C:/a.txt",
            "mailto:a@b.c",
            "ms-settings:privacy",
            "javascript:alert(1)",
        ] {
            assert!(
                check_path_with_home(raw, None)
                    .unwrap_err()
                    .contains("网址"),
                "{raw}"
            );
        }
        for raw in [
            r"\\server\share\a.txt",
            "//server/share/a.txt",
            r"\\?\C:\a.txt",
            r"\\.\PhysicalDrive0",
        ] {
            assert!(
                check_path_with_home(raw, None)
                    .unwrap_err()
                    .contains("网络路径"),
                "{raw}"
            );
        }
    }

    #[test]
    fn malformed_and_relative_paths_are_refused() {
        assert!(check_path_with_home("", None).is_err());
        assert!(check_path_with_home("a\nb", None).is_err());
        assert!(check_path_with_home("a\0b", None).is_err());
        assert!(check_path_with_home(&"a".repeat(MAX_LEN + 1), None).is_err());
        assert_eq!(
            check_path_with_home("src/main.rs", None).unwrap_err(),
            "需要文件的完整路径"
        );
        // 没有主目录时 ~ 不展开，按相对路径拒绝
        assert!(check_path_with_home("~/a.txt", None).is_err());
    }

    #[test]
    fn missing_file_is_refused() {
        let tmp = TempDir::new();
        let missing = tmp.0.join("nope.txt");
        let err = check_path_with_home(missing.to_str().unwrap(), None).unwrap_err();
        assert!(err.starts_with("找不到文件"), "{err}");
    }

    #[test]
    fn existing_files_and_folders_pass() {
        let tmp = TempDir::new();
        let file = tmp.0.join("notes.md");
        std::fs::write(&file, "x").unwrap();
        let ok = check_path_with_home(file.to_str().unwrap(), None).unwrap();
        assert_eq!(
            ok,
            CheckedPath {
                path: file.clone(),
                risky: false
            }
        );
        let ok = check_path_with_home(tmp.0.to_str().unwrap(), None).unwrap();
        assert!(!ok.risky);

        let exe = tmp.0.join("tool.exe");
        std::fs::write(&exe, "x").unwrap();
        assert!(
            check_path_with_home(exe.to_str().unwrap(), None)
                .unwrap()
                .risky
        );
    }

    #[test]
    fn home_is_expanded() {
        let tmp = TempDir::new();
        std::fs::write(tmp.0.join("a.txt"), "x").unwrap();
        let ok = check_path_with_home("~/a.txt", Some(&tmp.0)).unwrap();
        assert_eq!(ok.path, tmp.0.join("a.txt"));
        assert_eq!(check_path_with_home("~", Some(&tmp.0)).unwrap().path, tmp.0);
    }

    #[cfg(unix)]
    #[test]
    fn link_to_executable_is_risky() {
        let tmp = TempDir::new();
        let exe = tmp.0.join("run.sh");
        std::fs::write(&exe, "x").unwrap();
        let link = tmp.0.join("readme.txt");
        std::os::unix::fs::symlink(&exe, &link).unwrap();
        let ok = check_path_with_home(link.to_str().unwrap(), None).unwrap();
        assert_eq!(ok.path, link);
        assert!(ok.risky);
    }

    #[cfg(unix)]
    #[test]
    fn executable_without_extension_is_risky() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let script = tmp.0.join("deploy");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        assert!(
            !check_path_with_home(script.to_str().unwrap(), None)
                .unwrap()
                .risky
        );
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            check_path_with_home(script.to_str().unwrap(), None)
                .unwrap()
                .risky
        );
    }
}
