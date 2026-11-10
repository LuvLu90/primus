//! 右栏文件预览（附录 B `preview_file`）：只读取回复里引用、或 Agent 写出的本机文件内容，供右栏只读显示。
//!
//! 路径校验与 `open_path` 相同（open_path::check_path：只接受本机已存在的绝对路径，拒绝网址、网络与设备路径）。
//! 只读不写，最多读 [`MAX_BYTES`]；含 NUL 字节的按二进制处理，不返回内容。图片由前端走 `attachment_image`。
//!
//! Word / PowerPoint / Excel / PDF 要在前端渲染成“打开后的样子”，需要整份字节：`preview_file_bytes` 只接受
//! [`DOCUMENT_EXTENSIONS`] 里的扩展名，最多 [`MAX_DOCUMENT_BYTES`]，超过直接报错（截断的压缩包无法渲染）。

use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// 预览最多读取的字节数（1 MiB）；更大的文件只显示开头并标记 `truncated`
pub(crate) const MAX_BYTES: u64 = 1024 * 1024;

/// 文档预览（`preview_file_bytes`）的上限（30 MiB）
pub(crate) const MAX_DOCUMENT_BYTES: u64 = 30 * 1024 * 1024;

/// 允许按整份字节读取的文档扩展名（小写）：前端能渲染的格式
pub(crate) const DOCUMENT_EXTENSIONS: &[&str] = &["docx", "pptx", "xlsx", "xlsm", "pdf"];

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
}

/// 读取文件做预览。错误文案可直接显示给用户。
pub(crate) fn read_preview(path: &Path) -> Result<Preview, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹不能预览".into());
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

/// 读取整份文档字节供前端渲染（Word / PowerPoint / Excel / PDF）。错误文案可直接显示给用户。
pub(crate) fn read_document(path: &Path) -> Result<Vec<u8>, String> {
    if !is_document(path) {
        return Err("该类型的文件不能按文档预览".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹不能预览".into());
    }
    if !meta.is_file() {
        return Err("只能预览普通文件".into());
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "文件超过 {} MB，无法预览，请用默认程序打开",
            MAX_DOCUMENT_BYTES / 1024 / 1024
        ));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("读取文件失败：{e}"))?;
    // 读取期间文件可能变大：多读 1 字节判断是否超限
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    if buf.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "文件超过 {} MB，无法预览，请用默认程序打开",
            MAX_DOCUMENT_BYTES / 1024 / 1024
        ));
    }
    Ok(buf)
}

/// 扩展名（不区分大小写）是否在 [`DOCUMENT_EXTENSIONS`] 中
fn is_document(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        DOCUMENT_EXTENSIONS
            .iter()
            .any(|d| e.eq_ignore_ascii_case(d))
    })
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
    fn reads_file_and_rejects_dir() {
        let dir = std::env::temp_dir().join(format!("primus-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        std::fs::write(&file, "# 标题").unwrap();
        assert!(matches!(read_preview(&file), Ok(Preview::Text { .. })));
        assert!(read_preview(&dir).is_err());
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
