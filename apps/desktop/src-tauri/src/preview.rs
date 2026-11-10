//! 右栏文件预览（附录 B `preview_file`）：只读取回复里引用、或 Agent 写出的本机文件内容，供右栏只读显示。
//!
//! 路径校验与 `open_path` 相同（open_path::check_path：只接受本机已存在的绝对路径，拒绝网址、网络与设备路径）。
//! 只读不写，最多读 [`MAX_BYTES`]；含 NUL 字节的按二进制处理，不返回内容。图片由前端走 `attachment_image`。

use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// 预览最多读取的字节数（1 MiB）；更大的文件只显示开头并标记 `truncated`
pub(crate) const MAX_BYTES: u64 = 1024 * 1024;

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
