//! 乾元 Primus 更新服务（PrimusUpdate，ADR 0007）与薄壳共用的部分。
//!
//! Primus 按机器安装在 Program Files（MSI，perMachine），普通用户无权替换程序文件。为了不在每次更新时弹 UAC，
//! MSI 另装一个按需启动、以 LocalSystem 运行的小服务 `PrimusUpdate`。它只做一件事：安装一个**已下载、由发布方
//! 签名、版本高于已安装版本**的 MSI。应用经命名管道 [`PIPE_NAME`] 发一个固定格式的 [`protocol::InstallRequest`]；
//! 服务以客户端身份读取安装包、复制到只有 SYSTEM 与 Administrators 可写的目录，再用编译进服务的 updater 公钥
//! 验签（[`verify::verify_signature`]）、拒绝降级（[`verify::is_newer`]），然后 `msiexec /i … /quiet`。
//!
//! - 库里只放与平台无关的纯逻辑（协议、验签、版本、路径校验、msiexec 参数与退出码）与 Windows 的管道客户端
//!   （[`client`]），薄壳与服务共用、可在任意平台单测；服务本体（SCM、管道服务端、安装进程）在 bin。
//! - 服务不执行请求里的任何命令或参数：请求只携带安装包路径、版本、签名、是否重开与 `--data-dir`，逐项按白名单校验。

pub mod msiexec;
pub mod protocol;
pub mod verify;

#[cfg(windows)]
pub mod client;
#[cfg(windows)]
pub mod pipe;

/// Windows 服务名（MSI 的 ServiceInstall 与 SCM 查询都用它）。
pub const SERVICE_NAME: &str = "PrimusUpdate";
/// 命名管道（只接受本机连接，见服务端的 `PIPE_REJECT_REMOTE_CLIENTS`）。
pub const PIPE_NAME: &str = r"\\.\pipe\PrimusUpdate";
/// 安装包大小上限，与薄壳下载上限一致。
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

/// 编译时注入的 updater 公钥（`TAURI_SIGNING_PUBLIC_KEY`，与 Primus.exe 同源）；空串视为没有。
pub fn compiled_pubkey() -> Option<&'static str> {
    option_env!("TAURI_SIGNING_PUBLIC_KEY")
        .map(str::trim)
        .filter(|k| !k.is_empty())
}
