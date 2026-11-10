//! 应用与服务之间的请求 / 应答（命名管道，消息模式，一来一回）。
//!
//! 请求只有一种：安装某个已下载的 MSI。格式固定（JSON，拒绝未知字段）、长度受限（[`MAX_REQUEST_BYTES`]），
//! 每个字段按白名单校验；服务不执行请求里的任何命令或参数。路径只接受普通的本地绝对路径（`X:\…`），
//! 拒绝 UNC、设备路径（`\\?\`、`\\.\`）、相对段、备用数据流（`:`）与保留设备名。

use serde::{Deserialize, Serialize};

use crate::verify::parse_version;

/// 协议版本：字段或语义变化时加一，服务拒绝不认识的版本（应用随即回退到 UAC 安装）。
pub const PROTOCOL_VERSION: u32 = 1;
/// 请求与应答的最大字节数（管道缓冲区与读取上限）。
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024;
/// 路径最多 UTF-16 码元数（不支持 `\\?\` 长路径前缀，普通路径上限 260，这里放宽到 1024 只为容错）。
pub const MAX_PATH_UNITS: usize = 1024;
/// 签名（base64）最大长度：tauri signer 的签名约 400 字节，留足余量。
pub const MAX_SIGNATURE_LEN: usize = 4096;
pub const MAX_VERSION_LEN: usize = 64;

/// 安装请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallRequest {
    /// [`PROTOCOL_VERSION`]
    pub protocol: u32,
    /// 已下载的 MSI（本地绝对路径，扩展名 `.msi`）。服务以客户端身份打开它，复制后再验签。
    pub package: String,
    /// 待装版本（SemVer），须与签名绑定的版本一致且高于已安装版本。
    pub version: String,
    /// updater 签名（`.sig` 的内容，base64）。
    pub signature: String,
    /// 安装结束后以请求者身份重新打开 Primus（“立即重启更新”与启动时安装为 true，退出时安装为 false）。
    pub relaunch: bool,
    /// 重新打开时带上的 `--data-dir`（本地绝对路径）；只在 `relaunch` 时有意义。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

/// 应答代码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResponseCode {
    /// 已复制并验签，安装进程已启动：请求者应立即退出（安装等它退出后才开始）。
    Accepted,
    /// 请求格式或字段不合法
    Invalid,
    /// 签名校验失败（安装包、签名或版本不符）
    Signature,
    /// 版本不高于已安装版本
    NotNewer,
    /// 已有安装在进行
    Busy,
    /// 服务未启用（没有编译进公钥）或环境不满足（例如暂存目录不安全）：请求者可改走 UAC 安装
    Unavailable,
    /// 其他失败（读取、复制、启动安装进程）
    Failed,
}

/// 应答。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub code: ResponseCode,
    pub message: String,
}

impl Response {
    pub fn new(code: ResponseCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn accepted(&self) -> bool {
        self.code == ResponseCode::Accepted
    }

    /// 编码；消息过长时截断（按字符），保证不超过 [`MAX_RESPONSE_BYTES`]。
    pub fn encode(&self) -> Vec<u8> {
        let mut response = self.clone();
        loop {
            let bytes = serde_json::to_vec(&response).unwrap_or_default();
            if bytes.len() <= MAX_RESPONSE_BYTES || response.message.is_empty() {
                return bytes;
            }
            let keep = response.message.chars().count() / 2;
            response.message = response.message.chars().take(keep).collect();
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err("应答过长".to_owned());
        }
        serde_json::from_slice(bytes).map_err(|e| format!("应答格式不对：{e}"))
    }
}

impl InstallRequest {
    pub fn encode(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("请求过长".to_owned());
        }
        Ok(bytes)
    }

    /// 解码并校验；任一项不合法都拒绝。
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("请求过长".to_owned());
        }
        let request: Self =
            serde_json::from_slice(bytes).map_err(|e| format!("请求格式不对：{e}"))?;
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.protocol != PROTOCOL_VERSION {
            return Err(format!(
                "协议版本 {} 不受支持（服务为 {PROTOCOL_VERSION}）",
                self.protocol
            ));
        }
        validate_local_path(&self.package, Some("msi")).map_err(|e| format!("安装包路径{e}"))?;
        if self.version.len() > MAX_VERSION_LEN || parse_version(&self.version).is_none() {
            return Err("版本号不合法".to_owned());
        }
        let sig_ok = !self.signature.is_empty()
            && self.signature.len() <= MAX_SIGNATURE_LEN
            && self
                .signature
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
        if !sig_ok {
            return Err("签名不合法".to_owned());
        }
        if let Some(dir) = &self.data_dir {
            if !self.relaunch {
                return Err("不重新打开时不能指定数据目录".to_owned());
            }
            validate_local_path(dir, None).map_err(|e| format!("数据目录{e}"))?;
        }
        Ok(())
    }
}

/// Windows 保留设备名（不分大小写，带不带扩展名都算）。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验普通的本地绝对路径：`X:\` 开头、只用反斜杠、各段非空且不是 `.` / `..`、段尾不是空格或点、
/// 不含控制字符与 `" * < > ? | / :`（盘符后的冒号除外，拒绝备用数据流）、不是保留设备名、长度受限；
/// `ext` 给出时最后一段的扩展名须与之相同（不分大小写）。错误信息以“不合法”的原因开头，调用方前缀字段名。
pub fn validate_local_path(path: &str, ext: Option<&str>) -> Result<(), String> {
    let units = path.encode_utf16().count();
    if !(4..=MAX_PATH_UNITS).contains(&units) {
        return Err("长度不合法".to_owned());
    }
    let bytes = path.as_bytes();
    if !(bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\') {
        return Err("须是 X:\\ 开头的本地绝对路径".to_owned());
    }
    let rest = &path[3..];
    if rest
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '*' | '<' | '>' | '?' | '|' | '/' | ':'))
    {
        return Err("含有不允许的字符".to_owned());
    }
    let segments: Vec<&str> = rest.split('\\').collect();
    for segment in &segments {
        if segment.is_empty() || *segment == "." || *segment == ".." {
            return Err("含有空段或相对段".to_owned());
        }
        if segment.ends_with(' ') || segment.ends_with('.') {
            return Err("段尾不能是空格或点".to_owned());
        }
        let stem = segment.split('.').next().unwrap_or_default().trim_end();
        if RESERVED_NAMES
            .iter()
            .any(|name| stem.eq_ignore_ascii_case(name))
        {
            return Err("含有保留设备名".to_owned());
        }
    }
    if let Some(ext) = ext {
        let last = segments.last().copied().unwrap_or_default();
        let matches = last
            .rsplit_once('.')
            .is_some_and(|(stem, e)| !stem.is_empty() && e.eq_ignore_ascii_case(ext));
        if !matches {
            return Err(format!("扩展名须为 .{ext}"));
        }
    }
    Ok(())
}

/// 重新打开 Primus 的命令行：`"<exe>"`，有数据目录时追加 `--data-dir="<目录>"`。
/// 两个路径都已通过 [`validate_local_path`]（不含双引号）；结尾的反斜杠加倍，避免转义收尾的引号（CommandLineToArgvW 规则）。
pub fn relaunch_command_line(exe: &str, data_dir: Option<&str>) -> String {
    let quote = |s: &str| {
        let trimmed = s.trim_end_matches('\\');
        let tail = "\\".repeat((s.len() - trimmed.len()) * 2);
        format!("\"{trimmed}{tail}\"")
    };
    match data_dir {
        Some(dir) => format!("{} --data-dir={}", quote(exe), quote(dir)),
        None => quote(exe),
    }
}

/// `path` 是否位于目录 `dir` 之内（不分大小写，按路径段比较；`dir` 结尾的反斜杠可有可无）。
pub fn path_is_under(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('\\');
    if dir.is_empty() || path.len() <= dir.len() {
        return false;
    }
    let (head, tail) = path.split_at(dir.len());
    head.to_lowercase() == dir.to_lowercase() && tail.starts_with('\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> InstallRequest {
        InstallRequest {
            protocol: PROTOCOL_VERSION,
            package:
                r"C:\Program Files\Primus\data\users\S-1-5-21-1\updates\Primus_1.2.3_x64_zh-CN.msi"
                    .to_owned(),
            version: "1.2.3".to_owned(),
            signature: "dW50cnVzdGVk+/=".to_owned(),
            relaunch: true,
            data_dir: None,
        }
    }

    #[test]
    fn request_roundtrip() {
        let req = request();
        let bytes = req.encode().unwrap();
        assert_eq!(InstallRequest::decode(&bytes).unwrap(), req);
        let with_dir = InstallRequest {
            data_dir: Some(r"D:\Primus Data".to_owned()),
            ..request()
        };
        assert_eq!(
            InstallRequest::decode(&with_dir.encode().unwrap()).unwrap(),
            with_dir
        );
    }

    #[test]
    fn request_rejects_unknown_fields_and_oversize() {
        let mut value = serde_json::to_value(request()).unwrap();
        value["command"] = "cmd.exe /c whoami".into();
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(InstallRequest::decode(&bytes).is_err());
        assert!(InstallRequest::decode(&vec![b' '; MAX_REQUEST_BYTES + 1]).is_err());
        assert!(InstallRequest::decode(b"not json").is_err());
        assert!(InstallRequest::decode(b"{}").is_err());
    }

    #[test]
    fn request_field_validation() {
        let bad = |f: &dyn Fn(&mut InstallRequest)| {
            let mut req = request();
            f(&mut req);
            assert!(req.validate().is_err(), "{req:?}");
            assert!(InstallRequest::decode(&serde_json::to_vec(&req).unwrap()).is_err());
        };
        bad(&|r| r.protocol = 2);
        bad(&|r| r.version = "1.2".to_owned());
        bad(&|r| r.version = format!("1.2.3-{}", "a".repeat(64)));
        bad(&|r| r.signature = String::new());
        bad(&|r| r.signature = "abc def".to_owned());
        bad(&|r| r.signature = "a".repeat(MAX_SIGNATURE_LEN + 1));
        bad(&|r| r.package = r"C:\x\setup.exe".to_owned());
        bad(&|r| r.package = r"\\server\share\a.msi".to_owned());
        bad(&|r| {
            r.relaunch = false;
            r.data_dir = Some(r"D:\data".to_owned());
        });
        bad(&|r| r.data_dir = Some("relative\\dir".to_owned()));
        assert!(request().validate().is_ok());
    }

    #[test]
    fn local_paths() {
        let ok = |p: &str| assert!(validate_local_path(p, Some("msi")).is_ok(), "{p}");
        let no = |p: &str| assert!(validate_local_path(p, Some("msi")).is_err(), "{p}");
        ok(r"C:\a.msi");
        ok(r"d:\目录 带空格\Primus_1.0.0-beta.1_arm64_zh-CN.MSI");
        no(r"C:\a.exe");
        no(r"C:\.msi");
        no(r"C:\a.msi:evil");
        no(r"C:\a.msi::$DATA");
        no(r"C:/a.msi");
        no(r"C:\x/..\a.msi");
        no(r"C:\x\..\a.msi");
        no(r"C:\x\.\a.msi");
        no(r"C:\x\\a.msi");
        no(r"C:\x \a.msi");
        no(r"C:\x.\a.msi");
        no(r"C:\CON\a.msi");
        no(r"C:\x\nul.msi");
        no(r"C:\x\com1.txt\a.msi");
        no(r"\\?\C:\a.msi");
        no(r"\\.\pipe\a.msi");
        no(r"\\server\share\a.msi");
        no(r"a.msi");
        no(r"1:\a.msi");
        no("C:\\a\u{0}.msi");
        no("C:\\a\n.msi");
        no(r#"C:\a".msi"#);
        no(r"C:\a?.msi");
        no(r"C:\a*.msi");
        no(r"C:\a|b.msi");
        no(r"C:\a<b.msi");
        no(&format!(r"C:\{}.msi", "a".repeat(MAX_PATH_UNITS)));
        // 不带扩展名要求：目录
        assert!(validate_local_path(r"D:\Primus Data", None).is_ok());
        assert!(validate_local_path(r"D:\Primus Data\", None).is_err());
        assert!(validate_local_path(r"D:\", None).is_err());
    }

    #[test]
    fn relaunch_command_lines() {
        assert_eq!(
            relaunch_command_line(r"C:\Program Files\Primus\Primus.exe", None),
            r#""C:\Program Files\Primus\Primus.exe""#
        );
        assert_eq!(
            relaunch_command_line(r"C:\P\Primus.exe", Some(r"D:\Primus Data")),
            r#""C:\P\Primus.exe" --data-dir="D:\Primus Data""#
        );
        assert_eq!(
            relaunch_command_line(r"C:\P\Primus.exe", Some(r"D:\x\")),
            r#""C:\P\Primus.exe" --data-dir="D:\x\\""#
        );
    }

    #[test]
    fn paths_under_dir() {
        let dir = r"C:\Program Files\Primus";
        assert!(path_is_under(r"C:\Program Files\Primus\Primus.exe", dir));
        assert!(path_is_under(
            r"c:\program files\primus\resources\runtime\node.exe",
            &format!("{dir}\\")
        ));
        assert!(!path_is_under(r"C:\Program Files\Primus2\Primus.exe", dir));
        assert!(!path_is_under(r"C:\Program Files\Primus", dir));
        assert!(!path_is_under(r"C:\Windows\System32\msiexec.exe", dir));
        assert!(!path_is_under(r"C:\x", ""));
    }

    #[test]
    fn responses() {
        let r = Response::new(ResponseCode::Accepted, "ok");
        assert!(r.accepted());
        assert_eq!(Response::decode(&r.encode()).unwrap(), r);
        let long = Response::new(ResponseCode::Failed, "错".repeat(10_000));
        let bytes = long.encode();
        assert!(bytes.len() <= MAX_RESPONSE_BYTES);
        assert_eq!(Response::decode(&bytes).unwrap().code, ResponseCode::Failed);
        assert!(Response::decode(br#"{"code":"accepted","message":"","x":1}"#).is_err());
        assert!(Response::decode(br#"{"code":"other","message":""}"#).is_err());
    }
}
