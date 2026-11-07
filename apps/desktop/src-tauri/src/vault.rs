//! 密钥保险库：DPAPI 加解密、按 ID 存取、命令行取密钥模式（技术方案第 9.4、17.5 节）。
//!
//! - 文件：`data/users/<SID>/vault/secrets.bin`，内容为 `PRV1` 魔数 + 用户级 DPAPI 加密的 JSON
//!   （`{"v":1,"secrets":{"<id>":"<值>"}}`）。目录本身已是仅当前用户与 SYSTEM 可访问（第 4.3 节），
//!   DPAPI 再保证文件被复制到别处、或被其他 Windows 用户读到时也无法解密。
//! - 写入先写同目录临时文件再替换，避免中途崩溃留下半个文件。
//! - `Primus.exe --secret provider:<渠道 ID>`：不打开窗口，确认自己在本 App 的 Core 作业内后把该渠道的密钥写到 stdout 并退出，
//!   供 `models.json` 的 `"apiKey": "!<Primus.exe> --secret provider:<id>"` 使用；密钥不进命令行参数、环境变量与会话文件。
//!   只接受 `provider:<id>` 形式的名字，其他名字一律按不存在处理。
//! - macOS / Linux 的 Keychain / Secret Service 见第 20 章，当前非 Windows 平台加解密直接报不支持，
//!   绝不退回明文落盘。

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// 命令行取密钥参数。
pub(crate) const SECRET_ARG: &str = "--secret";

/// 保险库文件名。
const VAULT_FILE: &str = "secrets.bin";

/// 文件魔数与格式版本。
const MAGIC: &[u8; 4] = b"PRV1";

/// DPAPI 附加熵：把密文绑定到本 App，其他程序即使以同一用户身份调用 DPAPI 也需要知道它。
#[cfg_attr(not(windows), allow(dead_code))]
const ENTROPY: &[u8] = b"Primus vault v1";

/// ID 只允许小写字母、数字、`-` 与 `:`，长度 1–64：它会出现在命令行里（这些字符在 bash 与 cmd 中都按字面解释）。
pub(crate) fn is_valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b':')
}

/// `--secret` 模式接受的名字：只有 `provider:<渠道 ID>`。
pub(crate) fn is_secret_name(name: &str) -> bool {
    name.strip_prefix(crate::providers::SECRET_PREFIX)
        .is_some_and(crate::providers::is_valid_id)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Contents {
    v: u32,
    secrets: BTreeMap<String, String>,
}

/// 一个用户的保险库（`vault/secrets.bin`）。
pub(crate) struct Vault {
    file: PathBuf,
}

impl Vault {
    /// `dir` 为 `data/users/<SID>/vault`。只计算路径，不访问文件系统。
    pub(crate) fn new(dir: &Path) -> Self {
        Self {
            file: dir.join(VAULT_FILE),
        }
    }

    fn load(&self) -> io::Result<Contents> {
        let data = match fs::read(&self.file) {
            Ok(data) => data,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Contents::default()),
            Err(e) => return Err(e),
        };
        let sealed = data
            .strip_prefix(MAGIC.as_slice())
            .ok_or_else(|| invalid("保险库文件格式无法识别"))?;
        let plain = unprotect(sealed)?;
        let contents: Contents =
            serde_json::from_slice(&plain).map_err(|_| invalid("保险库内容无法解析"))?;
        if contents.v != 1 {
            return Err(invalid("保险库版本不受支持"));
        }
        Ok(contents)
    }

    fn store(&self, contents: &Contents) -> io::Result<()> {
        let plain = serde_json::to_vec(contents).map_err(io::Error::other)?;
        let sealed = protect(&plain)?;
        let dir = self
            .file
            .parent()
            .ok_or_else(|| invalid("保险库路径无效"))?;
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("{VAULT_FILE}.{}.tmp", std::process::id()));
        let result = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(MAGIC)?;
            f.write_all(&sealed)?;
            f.sync_all()?;
            drop(f);
            // Windows 上 rename 以 MOVEFILE_REPLACE_EXISTING 替换已有文件
            fs::rename(&tmp, &self.file)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    /// 读取一个密钥；不存在时返回 `None`。
    pub(crate) fn get(&self, id: &str) -> io::Result<Option<String>> {
        Ok(self.load()?.secrets.remove(id))
    }

    /// 写入（或覆盖）一个密钥。
    pub(crate) fn set(&self, id: &str, value: &str) -> io::Result<()> {
        if !is_valid_id(id) {
            return Err(invalid("密钥 ID 无效"));
        }
        let mut contents = self.load()?;
        contents.v = 1;
        contents.secrets.insert(id.to_owned(), value.to_owned());
        self.store(&contents)
    }

    /// 删除一个密钥（删除渠道、迁移旧令牌时用）；不存在时什么也不做。
    pub(crate) fn remove(&self, id: &str) -> io::Result<()> {
        let mut contents = self.load()?;
        if contents.secrets.remove(id).is_some() {
            self.store(&contents)?;
        }
        Ok(())
    }

    /// 保证 `id` 的值等于 `value`：相同则不动文件，不同（或不存在、文件损坏）则重写。返回是否写入。
    pub(crate) fn ensure(&self, id: &str, value: &str) -> io::Result<bool> {
        match self.get(id) {
            Ok(Some(current)) if current == value => Ok(false),
            Ok(_) => self.set(id, value).map(|()| true),
            // 无法解密（如从其他用户 / 机器复制来的文件）时整份重建：里面的值本来就用不了
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                let mut contents = Contents {
                    v: 1,
                    ..Contents::default()
                };
                contents.secrets.insert(id.to_owned(), value.to_owned());
                self.store(&contents).map(|()| true)
            }
            Err(e) => Err(e),
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// 从命令行参数中找出 `--secret <id>`（只接受这一种形式，且必须是第一个参数）。
pub(crate) fn parse_secret_arg<I>(args: I) -> Option<String>
where
    I: IntoIterator,
    I::Item: Into<std::ffi::OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    if args.next()? != SECRET_ARG {
        return None;
    }
    Some(args.next()?.to_string_lossy().into_owned())
}

/// 取密钥模式的退出码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SecretExit {
    Ok = 0,
    /// ID 无效或不存在
    NotFound = 2,
    /// 调用方不在本 App 的 Core 作业内，或环境不完整
    Denied = 3,
    /// 读取或解密失败
    Failed = 4,
}

/// 由 Core 环境变量 `PRIMUS_CODING_AGENT_DIR`（`data/users/<SID>/core`）推出保险库目录，
/// 并确认路径中的 SID 就是当前用户，防止被指向其他用户的目录。
pub(crate) fn vault_dir_from_core_dir(core_dir: &Path, user_id: &str) -> Option<PathBuf> {
    if core_dir.file_name()? != "core" {
        return None;
    }
    let user_dir = core_dir.parent()?;
    if user_dir.file_name()? != user_id || user_dir.parent()?.file_name()? != "users" {
        return None;
    }
    Some(user_dir.join("vault"))
}

/// `Primus.exe --secret <id>`：不创建窗口、不初始化 Tauri。成功时值写到 stdout（不带换行）。
/// 错误只写简短原因到 stderr，绝不输出密钥内容。
pub(crate) fn run_secret_mode(id: &str) -> SecretExit {
    let exit = secret_value(id).and_then(|value| {
        let mut out = io::stdout().lock();
        out.write_all(value.as_bytes())
            .and_then(|()| out.flush())
            .map_err(|_| SecretExit::Failed)
    });
    match exit {
        Ok(()) => SecretExit::Ok,
        Err(code) => {
            let reason = match code {
                SecretExit::NotFound => "密钥不存在",
                SecretExit::Denied => "调用方不在乾元内核的作业中",
                _ => "读取保险库失败",
            };
            let _ = writeln!(io::stderr(), "primus --secret：{reason}");
            code
        }
    }
}

fn secret_value(id: &str) -> Result<String, SecretExit> {
    if !is_secret_name(id) {
        return Err(SecretExit::NotFound);
    }
    let job = std::env::var(crate::job::JOB_NAME_ENV).map_err(|_| SecretExit::Denied)?;
    if !crate::job::caller_in_job(&job).unwrap_or(false) {
        return Err(SecretExit::Denied);
    }
    let core_dir = std::env::var_os("PRIMUS_CODING_AGENT_DIR").ok_or(SecretExit::Denied)?;
    let user_id = crate::platform::current_user_id().map_err(|_| SecretExit::Failed)?;
    let dir = vault_dir_from_core_dir(Path::new(&core_dir), &user_id).ok_or(SecretExit::Denied)?;
    Vault::new(&dir)
        .get(id)
        .map_err(|_| SecretExit::Failed)?
        .ok_or(SecretExit::NotFound)
}

// ---- 平台加解密 ----

#[cfg(windows)]
fn protect(plain: &[u8]) -> io::Result<Vec<u8>> {
    dpapi(plain, true)
}

#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> io::Result<Vec<u8>> {
    // 解密失败（不是本用户 / 本机加密的数据，或被篡改）归为数据无效
    dpapi(sealed, false).map_err(|_| invalid("保险库无法解密"))
}

/// 用户级 DPAPI（`CryptProtectData` / `CryptUnprotectData`），禁止弹出任何界面。
#[cfg(windows)]
fn dpapi(input: &[u8], encrypt: bool) -> io::Result<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    let len = u32::try_from(input.len()).map_err(|_| invalid("数据过大"))?;
    let data_in = CRYPT_INTEGER_BLOB {
        cbData: len,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: 输入与熵在调用期间有效且不会被写入；输出由系统分配，下面用 LocalFree 释放
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &data_in,
                null(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &data_in,
                null_mut(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: 成功时 pbData 指向 cbData 字节的系统分配内存
    let result = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    // SAFETY: 由 CryptProtectData / CryptUnprotectData 分配，只释放一次
    unsafe { LocalFree(out.pbData as HLOCAL) };
    Ok(result)
}

/// 单元测试在非 Windows 上用可逆变换代替 DPAPI，只为覆盖文件格式与读写流程。
#[cfg(all(test, not(windows)))]
fn protect(plain: &[u8]) -> io::Result<Vec<u8>> {
    Ok(plain.iter().map(|b| b ^ 0x5a).collect())
}

#[cfg(all(test, not(windows)))]
fn unprotect(sealed: &[u8]) -> io::Result<Vec<u8>> {
    Ok(sealed.iter().map(|b| b ^ 0x5a).collect())
}

#[cfg(all(not(test), not(windows)))]
fn protect(_plain: &[u8]) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "当前平台尚未接入系统密钥库",
    ))
}

#[cfg(all(not(test), not(windows)))]
fn unprotect(_sealed: &[u8]) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "当前平台尚未接入系统密钥库",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("primus-vault-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    const MODEL_TOKEN_ID: &str = "provider:test";

    #[test]
    fn set_get_remove_round_trip_without_plaintext_on_disk() {
        let dir = temp_dir("rt");
        let vault = Vault::new(&dir);
        assert_eq!(vault.get(MODEL_TOKEN_ID).unwrap(), None, "文件不存在时为空");
        vault.set(MODEL_TOKEN_ID, "value-一二三").unwrap();
        vault.set("other", "x").unwrap();
        assert_eq!(
            vault.get(MODEL_TOKEN_ID).unwrap().as_deref(),
            Some("value-一二三")
        );
        let raw = fs::read(dir.join(VAULT_FILE)).unwrap();
        assert!(raw.starts_with(MAGIC));
        assert!(!raw.windows(5).any(|w| w == b"value"), "文件中不得出现明文");
        vault.remove(MODEL_TOKEN_ID).unwrap();
        assert_eq!(vault.get(MODEL_TOKEN_ID).unwrap(), None);
        assert_eq!(vault.get("other").unwrap().as_deref(), Some("x"));
        assert!(
            fs::read_dir(&dir).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")),
            "不留临时文件"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_rewrites_only_on_change_and_recovers_from_corruption() {
        let dir = temp_dir("ensure");
        let vault = Vault::new(&dir);
        assert!(vault.ensure(MODEL_TOKEN_ID, "a").unwrap());
        assert!(!vault.ensure(MODEL_TOKEN_ID, "a").unwrap(), "相同值不重写");
        assert!(vault.ensure(MODEL_TOKEN_ID, "b").unwrap());
        assert_eq!(vault.get(MODEL_TOKEN_ID).unwrap().as_deref(), Some("b"));

        fs::write(dir.join(VAULT_FILE), b"garbage").unwrap();
        assert_eq!(
            vault.get(MODEL_TOKEN_ID).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(vault.ensure(MODEL_TOKEN_ID, "c").unwrap(), "损坏时整份重建");
        assert_eq!(vault.get(MODEL_TOKEN_ID).unwrap().as_deref(), Some("c"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_and_args() {
        assert!(is_valid_id("model-token") && is_valid_id("provider:ioply"));
        for bad in ["", "Model", "a b", "a/b", "a\"", &"x".repeat(65)] {
            assert!(!is_valid_id(bad), "{bad:?}");
        }
        assert!(is_secret_name("provider:ioply") && is_secret_name("provider:my-gw-2"));
        for bad in [
            "model-token",
            "provider:",
            "provider:Bad",
            "provider:1a",
            "provider:a:b",
            "providers:a",
            "other:a",
        ] {
            assert!(!is_secret_name(bad), "{bad:?}");
        }
        assert!(Vault::new(Path::new("/tmp/none")).set("BAD", "v").is_err());
        assert_eq!(
            parse_secret_arg(["--secret", "provider:ioply"]).as_deref(),
            Some("provider:ioply")
        );
        assert_eq!(parse_secret_arg(["--secret"]), None);
        assert_eq!(parse_secret_arg(["--data-dir", "x", "--secret", "a"]), None);
        assert_eq!(parse_secret_arg(Vec::<String>::new()), None);
    }

    #[test]
    fn vault_dir_must_belong_to_current_user() {
        let core = Path::new("/d/data/users/S-1-5-21-1/core");
        assert_eq!(
            vault_dir_from_core_dir(core, "S-1-5-21-1"),
            Some(PathBuf::from("/d/data/users/S-1-5-21-1/vault"))
        );
        assert_eq!(vault_dir_from_core_dir(core, "S-1-5-21-2"), None);
        assert_eq!(
            vault_dir_from_core_dir(Path::new("/d/data/users/S-1-5-21-1/other"), "S-1-5-21-1"),
            None
        );
        assert_eq!(
            vault_dir_from_core_dir(Path::new("/d/data/x/S-1-5-21-1/core"), "S-1-5-21-1"),
            None
        );
    }

    #[test]
    fn secret_mode_denies_callers_outside_core_job() {
        // 测试进程不在任何乾元作业里：无论环境如何都拒绝，且不输出任何值
        assert_eq!(secret_value("provider:ioply"), Err(SecretExit::Denied));
        assert_eq!(secret_value("BAD ID"), Err(SecretExit::NotFound));
        assert_eq!(
            secret_value("model-token"),
            Err(SecretExit::NotFound),
            "旧令牌名与其他名字一律拒绝"
        );
    }
}
