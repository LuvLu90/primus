//! 右栏文件预览（附录 B `preview_file`）：只读取回复里引用、或 Agent 写出的本机文件内容，供右栏只读显示。
//!
//! 路径校验与 `open_path` 相同（open_path::check_path：只接受本机已存在的绝对路径，拒绝网址、网络与设备路径）。
//! 只读不写，最多读 [`MAX_BYTES`]；含 NUL 字节的按二进制处理，不返回内容。图片由前端走 `attachment_image`。
//!
//! Word / PowerPoint / Excel / PDF 要在前端渲染成“打开后的样子”，需要整份字节：`preview_file_bytes` 只接受
//! [`DOCUMENT_EXTENSIONS`] 里的扩展名，最多 [`MAX_DOCUMENT_BYTES`]，超过直接报错（截断的压缩包无法渲染）。
//! 音频、视频（[`MEDIA_EXTENSIONS`]，最多 [`MAX_MEDIA_BYTES`]）与 `attachment_image` 解不了的图片
//! （[`IMAGE_BYTES_EXTENSIONS`]：GIF 动画、ICO、AVIF）也按整份字节交给前端，用 blob URL 播放 / 显示。
//!
//! 文件夹（`preview_dir`）：列出直接子项（名称、是否文件夹、大小、修改时间、是否隐藏），文件夹在前、按名称排序，
//! 最多返回 [`MAX_DIR_ENTRIES`] 项；只读目录项元数据，不打开任何文件。隐藏属性由调用方按平台判断（platform 模块）。

use std::ffi::OsStr;
use std::fs::Metadata;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// 预览最多读取的字节数（1 MiB）；更大的文件只显示开头并标记 `truncated`
pub(crate) const MAX_BYTES: u64 = 1024 * 1024;

/// 文档预览（`preview_file_bytes`）的上限（30 MiB）
pub(crate) const MAX_DOCUMENT_BYTES: u64 = 30 * 1024 * 1024;

/// 允许按整份字节读取的文档扩展名（小写）：前端能渲染的格式
pub(crate) const DOCUMENT_EXTENSIONS: &[&str] = &["docx", "pptx", "xlsx", "xlsm", "pdf"];

/// 音频 / 视频预览的上限（64 MiB）：整份读入内存交给 `<audio>` / `<video>`，更大的用默认程序打开
pub(crate) const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;

/// 按整份字节读取的音频、视频扩展名（小写）：WebView2 能直接播放的格式
pub(crate) const MEDIA_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "mp4", "m4v", "webm", "mov", "ogv",
];

/// 按整份字节读取、由 `<img>` 直接显示的图片（`attachment_image` 会丢掉 GIF 动画，也解不了 ICO / AVIF）
pub(crate) const IMAGE_BYTES_EXTENSIONS: &[&str] = &["gif", "ico", "avif"];

/// 文件夹预览最多返回的子项数
pub(crate) const MAX_DIR_ENTRIES: usize = 2000;

/// 文件夹预览最多扫描的子项数（超过后不再读取，按已读到的排序返回，`total` 为下限）
pub(crate) const MAX_DIR_SCAN: usize = 20_000;

/// 预览结果
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preview {
    /// 文本文件（UTF-8；无法解码的字节替换为 U+FFFD）
    Text {
        text: String,
        truncated: bool,
        size: u64,
    },
    /// 二进制文件：不返回内容
    Binary { size: u64 },
    /// 文件夹：前端改用 `preview_dir` 列出内容
    Directory,
}

/// 文件夹中的一项
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// 是文件夹（指向文件夹的链接也算）
    pub dir: bool,
    /// 文件大小（字节）；文件夹与读不到元数据的项为 None
    pub size: Option<u64>,
    /// 修改时间（Unix 毫秒）；取不到时为 None
    pub modified_ms: Option<i64>,
    /// 隐藏或系统项（Windows 的隐藏 / 系统属性；其他平台为 `.` 开头）
    pub hidden: bool,
}

/// 文件夹预览结果
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// 文件夹在前、按名称排序，最多 [`MAX_DIR_ENTRIES`] 项
    pub entries: Vec<DirEntry>,
    /// 读到的子项总数（扫描到 [`MAX_DIR_SCAN`] 即停，此时为下限）
    pub total: usize,
    /// 只返回了一部分（超过 [`MAX_DIR_ENTRIES`]，或扫描未完成）
    pub truncated: bool,
}

/// 读取文件做预览。错误文案可直接显示给用户。
pub(crate) fn read_preview(path: &Path) -> Result<Preview, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.is_dir() {
        return Ok(Preview::Directory);
    }
    // 只打开普通文件：FIFO、设备等特殊文件在 open/read 时可能一直阻塞
    if !meta.is_file() {
        return Err("只能预览普通文件".into());
    }
    let size = meta.len();
    let file = std::fs::File::open(path).map_err(|e| format!("读取文件失败：{e}"))?;
    let mut buf = Vec::with_capacity(size.min(MAX_BYTES) as usize);
    file.take(MAX_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    Ok(decode(buf, size))
}

/// 读取整份文件字节供前端渲染（Word / PowerPoint / Excel / PDF、音频视频、部分图片）。错误文案可直接显示给用户。
pub(crate) fn read_document(path: &Path) -> Result<Vec<u8>, String> {
    let Some(limit) = bytes_limit(path) else {
        return Err("该类型的文件不能按文档预览".into());
    };
    let too_large = || {
        format!(
            "文件超过 {} MB，无法预览，请用默认程序打开",
            limit / 1024 / 1024
        )
    };
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹不能按文件预览".into());
    }
    if !meta.is_file() {
        return Err("只能预览普通文件".into());
    }
    if meta.len() > limit {
        return Err(too_large());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("读取文件失败：{e}"))?;
    // 读取期间文件可能变大：多读 1 字节判断是否超限
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    if buf.len() as u64 > limit {
        return Err(too_large());
    }
    Ok(buf)
}

/// 扩展名（不区分大小写）是否在列表中
fn has_extension(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| list.iter().any(|d| e.eq_ignore_ascii_case(d)))
}

/// 扩展名（不区分大小写）是否在 [`DOCUMENT_EXTENSIONS`] 中
fn is_document(path: &Path) -> bool {
    has_extension(path, DOCUMENT_EXTENSIONS)
}

/// 按整份字节读取的上限；不接受的扩展名为 None
fn bytes_limit(path: &Path) -> Option<u64> {
    if is_document(path) || has_extension(path, IMAGE_BYTES_EXTENSIONS) {
        Some(MAX_DOCUMENT_BYTES)
    } else if has_extension(path, MEDIA_EXTENSIONS) {
        Some(MAX_MEDIA_BYTES)
    } else {
        None
    }
}

/// 列出文件夹的直接子项（[`DirListing`]）。`is_hidden` 按平台判断隐藏 / 系统项。错误文案可直接显示给用户。
pub(crate) fn list_dir(
    path: &Path,
    is_hidden: impl Fn(&Metadata, &OsStr) -> bool,
) -> Result<DirListing, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件夹失败：{e}"))?;
    if !meta.is_dir() {
        return Err("不是文件夹".into());
    }
    let read = std::fs::read_dir(path).map_err(|e| format!("读取文件夹失败：{e}"))?;
    let mut entries = Vec::new();
    let mut complete = true;
    for item in read {
        if entries.len() >= MAX_DIR_SCAN {
            complete = false;
            break;
        }
        // 单项读不到（权限、刚被删除）时跳过，不让整个文件夹失败
        let Ok(item) = item else { continue };
        let name_os = item.file_name();
        // 目录项自带的元数据（不跟随链接；Windows 上来自目录枚举本身，不打开文件）
        let Ok(own) = item.metadata() else { continue };
        let target = if own.file_type().is_symlink() {
            // 链接按指向的目标显示；目标不存在时按文件显示、没有大小
            std::fs::metadata(item.path()).ok()
        } else {
            Some(own.clone())
        };
        let dir = target.as_ref().is_some_and(Metadata::is_dir);
        let size = match &target {
            Some(m) if m.is_file() => Some(m.len()),
            _ => None,
        };
        let modified_ms = target
            .as_ref()
            .unwrap_or(&own)
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_millis()).ok());
        entries.push(DirEntry {
            name: name_os.to_string_lossy().into_owned(),
            dir,
            size,
            modified_ms,
            hidden: is_hidden(&own, &name_os),
        });
    }
    sort_entries(&mut entries);
    let total = entries.len();
    let truncated = !complete || total > MAX_DIR_ENTRIES;
    entries.truncate(MAX_DIR_ENTRIES);
    Ok(DirListing {
        entries,
        total,
        truncated,
    })
}

/// 文件夹在前；同类按名称（不区分大小写，数字按数值比较，与资源管理器一致），相同时按原名
fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// 自然排序：连续数字按数值比较（`a2` 在 `a10` 前），其余字符不区分大小写
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut digits = String::new();
                    while let Some(ch) = it.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(ch);
                        it.next();
                    }
                    digits
                };
                let (m, n) = (take(&mut x), take(&mut y));
                let (m0, n0) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let ord = m0.len().cmp(&n0.len()).then_with(|| m0.cmp(n0));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// 字节 → 预览：含 NUL 视为二进制；截断处被切开的多字节字符丢掉，其余无效字节替换为 U+FFFD。
fn decode(mut buf: Vec<u8>, size: u64) -> Preview {
    if buf.contains(&0) {
        return Preview::Binary { size };
    }
    let truncated = size > buf.len() as u64;
    // 去掉 UTF-8 BOM
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        buf.drain(..3);
    }
    let text = match String::from_utf8(buf) {
        Ok(text) => text,
        Err(e) => {
            let err = e.utf8_error();
            let mut bytes = e.into_bytes();
            if truncated && err.error_len().is_none() {
                bytes.truncate(err.valid_up_to());
            }
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    Preview::Text {
        text,
        truncated,
        size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_bom() {
        let p = decode(b"\xEF\xBB\xBFhello".to_vec(), 8);
        assert_eq!(
            p,
            Preview::Text {
                text: "hello".into(),
                truncated: false,
                size: 8
            }
        );
    }

    #[test]
    fn nul_is_binary() {
        assert_eq!(decode(vec![1, 0, 2], 3), Preview::Binary { size: 3 });
    }

    #[test]
    fn truncated_drops_split_char() {
        // “中”是 3 字节，截断后只剩前 2 字节
        let mut bytes = b"ab".to_vec();
        bytes.extend_from_slice(&"中".as_bytes()[..2]);
        let p = decode(bytes, 100);
        assert_eq!(
            p,
            Preview::Text {
                text: "ab".into(),
                truncated: true,
                size: 100
            }
        );
    }

    #[test]
    fn invalid_bytes_replaced() {
        let p = decode(vec![b'a', 0xFF, b'b'], 3);
        assert_eq!(
            p,
            Preview::Text {
                text: "a\u{FFFD}b".into(),
                truncated: false,
                size: 3
            }
        );
    }

    #[test]
    fn reads_file_and_reports_dir() {
        let dir = std::env::temp_dir().join(format!("primus-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        std::fs::write(&file, "# 标题").unwrap();
        assert!(matches!(read_preview(&file), Ok(Preview::Text { .. })));
        assert_eq!(read_preview(&dir), Ok(Preview::Directory));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_documents_only() {
        let dir = std::env::temp_dir().join(format!("primus-preview-doc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("报告.DOCX");
        std::fs::write(&docx, [b'P', b'K', 3, 4, 0]).unwrap();
        assert_eq!(read_document(&docx).unwrap(), vec![b'P', b'K', 3, 4, 0]);
        let text = dir.join("a.txt");
        std::fs::write(&text, "x").unwrap();
        assert!(read_document(&text).is_err());
        let folder = dir.join("b.pptx");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(read_document(&folder).is_err());
        assert!(read_document(&dir.join("missing.pdf")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn document_extensions() {
        assert!(is_document(Path::new("a.pptx")));
        assert!(is_document(Path::new("C:/x/b.Pdf")));
        assert!(is_document(Path::new("报表.XLSX")));
        assert!(is_document(Path::new("/w/宏.xlsm")));
        assert!(!is_document(Path::new("a.doc")));
        // 旧版二进制 .xls 与文本 .csv 不按整份字节读取（.csv 走 preview_file）
        assert!(!is_document(Path::new("a.xls")));
        assert!(!is_document(Path::new("a.csv")));
        assert!(!is_document(Path::new("docx")));
    }

    #[test]
    fn bytes_limits_by_kind() {
        assert_eq!(bytes_limit(Path::new("a.PDF")), Some(MAX_DOCUMENT_BYTES));
        assert_eq!(bytes_limit(Path::new("动图.gif")), Some(MAX_DOCUMENT_BYTES));
        assert_eq!(
            bytes_limit(Path::new("favicon.ico")),
            Some(MAX_DOCUMENT_BYTES)
        );
        assert_eq!(bytes_limit(Path::new("a.avif")), Some(MAX_DOCUMENT_BYTES));
        for ext in ["mp3", "WAV", "ogg", "m4a", "flac", "mp4", "webm", "MOV"] {
            assert_eq!(
                bytes_limit(Path::new(&format!("x.{ext}"))),
                Some(MAX_MEDIA_BYTES),
                "{ext}"
            );
        }
        assert_eq!(bytes_limit(Path::new("a.png")), None);
        assert_eq!(bytes_limit(Path::new("a.exe")), None);
        assert_eq!(bytes_limit(Path::new("mp3")), None);
    }

    #[test]
    fn reads_media_bytes() {
        let dir = std::env::temp_dir().join(format!("primus-preview-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let song = dir.join("歌.mp3");
        std::fs::write(&song, b"ID3").unwrap();
        assert_eq!(read_document(&song).unwrap(), b"ID3".to_vec());
        let folder = dir.join("clip.mp4");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(read_document(&folder).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn entry(name: &str, dir: bool) -> DirEntry {
        DirEntry {
            name: name.into(),
            dir,
            size: None,
            modified_ms: None,
            hidden: false,
        }
    }

    #[test]
    fn sorts_folders_first_then_natural_name() {
        let mut v = vec![
            entry("b.txt", false),
            entry("a10.txt", false),
            entry("Zeta", true),
            entry("a2.txt", false),
            entry("alpha", true),
            entry("A2.txt", false),
        ];
        sort_entries(&mut v);
        let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            ["alpha", "Zeta", "A2.txt", "a2.txt", "a10.txt", "b.txt"]
        );
        assert_eq!(natural_cmp("file007", "file7"), std::cmp::Ordering::Equal);
        assert_eq!(natural_cmp("x9", "x10"), std::cmp::Ordering::Less);
    }

    #[test]
    fn lists_directory_entries() {
        let dir = std::env::temp_dir().join(format!("primus-preview-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("子文件夹")).unwrap();
        std::fs::write(dir.join("b.txt"), "hello").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();
        let listing = list_dir(&dir, |_, name| name.to_string_lossy().starts_with('.')).unwrap();
        assert_eq!(listing.total, 3);
        assert!(!listing.truncated);
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["子文件夹", ".hidden", "b.txt"]);
        let sub = &listing.entries[0];
        assert!(sub.dir && sub.size.is_none() && !sub.hidden);
        let b = &listing.entries[2];
        assert_eq!((b.dir, b.size, b.hidden), (false, Some(5), false));
        assert!(b.modified_ms.is_some_and(|ms| ms > 0));
        assert!(listing.entries[1].hidden);
        assert!(list_dir(&dir.join("b.txt"), |_, _| false).is_err());
        assert!(list_dir(&dir.join("missing"), |_, _| false).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn caps_directory_entries() {
        let dir = std::env::temp_dir().join(format!("primus-preview-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..MAX_DIR_ENTRIES + 5 {
            std::fs::write(dir.join(format!("f{i}")), "").unwrap();
        }
        let listing = list_dir(&dir, |_, _| false).unwrap();
        assert_eq!(listing.total, MAX_DIR_ENTRIES + 5);
        assert_eq!(listing.entries.len(), MAX_DIR_ENTRIES);
        assert!(listing.truncated);
        assert_eq!(listing.entries[0].name, "f0");
        assert_eq!(listing.entries[1].name, "f1");
        assert_eq!(listing.entries[2].name, "f2");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_dir_counts_as_dir() {
        let dir = std::env::temp_dir().join(format!("primus-preview-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        std::os::unix::fs::symlink(dir.join("gone"), dir.join("broken")).unwrap();
        let listing = list_dir(&dir, |_, _| false).unwrap();
        let find = |n: &str| listing.entries.iter().find(|e| e.name == n).unwrap();
        assert!(find("link").dir);
        assert!(!find("broken").dir && find("broken").size.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_blocking() {
        let dir = std::env::temp_dir().join(format!("primus-preview-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("pipe");
        let ok = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            assert!(read_preview(&fifo).is_err());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
