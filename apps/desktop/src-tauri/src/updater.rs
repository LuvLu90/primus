//! 自动更新（技术方案第 3.6 节、ADR 0007）：检查 → 下载并验签 → 存为待装包 → 立即重启或下次启动时安装。
//!
//! - 只在 Rust 侧使用 `tauri-plugin-updater`（检查静态清单、下载并按 minisign 验签），不给 WebView 开插件权限；
//!   前端只经本模块的命令（`update_*`）与 `update_watch` 的 Channel 交互。
//! - 公钥不进仓库：构建时从环境变量 `TAURI_SIGNING_PUBLIC_KEY` 编译进来（`build.rs` 声明 rerun-if-env-changed）。
//!   没有公钥的构建（开发、PR）或非 Windows 平台整体禁用，状态报 `available: false`。
//! - 更新源：GitHub Release `update-feed` 下的 `stable.json` / `beta.json`（Tauri 2 静态清单），按通道选择；
//!   [`endpoints`] 返回列表，以后加镜像只需追加地址。调试构建可用 `PRIMUS_UPDATE_ENDPOINT` 覆盖。
//! - 只发 MSI（按机器安装在 Program Files）：MSI 版 exe 是 `--no-bundle` 编译的，插件自己判断不出安装方式，
//!   用 `windows-<arch>-msi` 显式指定清单条目。
//! - 待装包放在 `data/users/<SID>/updates/`（该目录只有当前用户与 SYSTEM 可写，追加 Administrators 只读，
//!   供“过肩”提权的管理员账号读取）：安装包写入后再原子写 `pending.json`。
//! - 安装（立即重启、下次启动、退出时共用 [`Updater::prepare_install`]）：从磁盘重读安装包，用编译进的公钥按插件
//!   同一套规则再次校验 minisign 签名（含签名绑定的版本），核对 SHA-256 与版本；失败删除待装包。通过后交给 MSI 一起
//!   安装的更新服务 PrimusUpdate（[`primus_update`]，LocalSystem）：服务以本用户身份读取安装包、复制到只有 SYSTEM 与
//!   Administrators 可写的目录后再次验签、拒绝降级，等 Primus 退出后 `msiexec /quiet` 静默安装，按需以本用户身份
//!   重新打开。服务不可用（旧版 MSI 没有服务、服务被禁用等）时，“立即重启更新”与启动时安装回退到 UAC 拉起安装器
//!   （`platform::launch_installer`），退出时安装则留到下次启动。

use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 编译时注入的 updater 公钥（tauri signer 的格式：minisign 公钥文件整体 base64）。
const PUBKEY: Option<&str> = option_env!("TAURI_SIGNING_PUBLIC_KEY");

/// 更新清单所在的 Release（`update-feed` 标签下的附件，见 release.yml 的 publish 作业）。
const FEED_BASE: &str = "https://github.com/skaduv/primus/releases/download/update-feed";
/// 调试构建覆盖更新源（完整的清单 URL），便于本地起静态服务器测试。
const ENDPOINT_OVERRIDE_ENV: &str = "PRIMUS_UPDATE_ENDPOINT";
/// 待装包描述文件与设置文件。
const PENDING_FILE: &str = "pending.json";
/// 多次安装仍未生效而放弃的版本（自动检查不再下载它，更高的版本照常更新）。
const ABANDONED_FILE: &str = "abandoned.json";
const SETTINGS_FILE: &str = "update.json";
const LOG_FILE: &str = "updater.log";
const LOG_MAX_BYTES: u64 = 1024 * 1024;
/// 主窗口起来后第一次自动检查的延迟，与之后的检查间隔。
pub(crate) const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
pub(crate) const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// 检查清单的超时（插件只把它用于清单请求）。
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// 下载安装包：连接超时、两次收到数据之间的最长间隔（停滞即失败）、总时长上限（慢网络也足够下完）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// 安装包大小上限：插件在验签前把整个响应放在内存里，超过即中止下载。
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
/// 同一待装包成功拉起安装器、但版本始终没有变化（安装失败）的次数上限：超过后删除待装包，不再每次启动都弹 UAC。
const MAX_INSTALL_ATTEMPTS: u32 = 3;
/// 下载进度推送的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// 编译进来的公钥；空串视为没有（CI 中未配置的 Secret 展开为空串）。
pub(crate) fn compiled_pubkey() -> Option<&'static str> {
    PUBKEY.map(str::trim).filter(|k| !k.is_empty())
}

/// 更新通道（第 18 章“更新”分组）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    fn manifest(self) -> &'static str {
        match self {
            Self::Stable => "stable.json",
            Self::Beta => "beta.json",
        }
    }
}

/// 某个通道的更新源（按顺序尝试，前一个失败再试下一个）。目前只有 GitHub；以后加镜像在这里追加。
/// 调试构建设置了 `PRIMUS_UPDATE_ENDPOINT` 时只用它。
pub(crate) fn endpoints(channel: UpdateChannel, debug_override: Option<&str>) -> Vec<String> {
    if let Some(url) = debug_override.map(str::trim).filter(|u| !u.is_empty()) {
        return vec![url.to_owned()];
    }
    vec![format!("{FEED_BASE}/{}", channel.manifest())]
}

fn debug_endpoint_override() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(ENDPOINT_OVERRIDE_ENV).ok()
    } else {
        None
    }
}

/// 更新设置：`data/users/<SID>/app/update.json`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct UpdateSettings {
    pub(crate) auto_update: bool,
    pub(crate) channel: UpdateChannel,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_update: true,
            channel: UpdateChannel::Stable,
        }
    }
}

impl UpdateSettings {
    /// 读取设置；文件不存在或内容无效时用默认值（自动更新开、稳定版）。
    pub(crate) fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        write_atomic(
            path,
            &serde_json::to_vec_pretty(self).map_err(io::Error::other)?,
        )
    }
}

/// 清单中的平台键 `windows-<x86_64|aarch64>-msi`；不支持的架构为 None。
pub(crate) fn target_for(arch: &str) -> Option<String> {
    matches!(arch, "x86_64" | "aarch64").then(|| format!("windows-{arch}-msi"))
}

/// 当前构建的架构名（与插件的 `{{arch}}` 一致）。
fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "unsupported"
    }
}

// 版本比较与签名校验与更新服务共用同一份实现（服务复制安装包后按同一规则再验一次）
pub(crate) use primus_update::verify::{is_newer, verify_signature};

/// 已下载、校验过、等待安装的更新：`data/users/<SID>/updates/pending.json`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingUpdate {
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) notes: Option<String>,
    /// 安装包文件名（只是文件名，位于 updates 目录下）
    pub(crate) file: String,
    pub(crate) sha256: String,
    /// `.sig` 内容（清单中的 signature）
    pub(crate) signature: String,
    /// 已成功拉起安装器的次数（UAC 取消不计）
    #[serde(default)]
    pub(crate) attempts: u32,
}

/// 安装包文件名：取下载地址最后一段，只允许 ASCII 字母数字与 `._-`，扩展名须为 `.msi`。
pub(crate) fn package_file_name(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && name
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("msi"))
        && !name.eq_ignore_ascii_case(PENDING_FILE);
    ok.then(|| name.to_owned())
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 回退到 UAC 时的安装器命令行：系统目录下的 msiexec 被动安装、不自动重启。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallerCommand {
    pub(crate) program: PathBuf,
    pub(crate) params: String,
}

pub(crate) fn installer_command(package: &Path, system_dir: &Path) -> InstallerCommand {
    InstallerCommand {
        program: system_dir.join("msiexec.exe"),
        params: format!("/i \"{}\" /passive /norestart", package.display()),
    }
}

/// 启动时对待装包的处理。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupAction {
    Nothing,
    Install,
    /// 删除待装包（原因写日志）
    Discard(String),
    /// 多次拉起安装器仍未生效：记下放弃的版本（自动检查不再下载它），再删除待装包
    Abandon(String),
}

pub(crate) fn startup_action(pending: Option<&PendingUpdate>, current: &Version) -> StartupAction {
    let Some(p) = pending else {
        return StartupAction::Nothing;
    };
    if !is_newer(&p.version, current) {
        return StartupAction::Discard(format!("待装版本 {} 不高于当前版本 {current}", p.version));
    }
    if p.attempts >= MAX_INSTALL_ATTEMPTS {
        return StartupAction::Abandon(format!(
            "已 {} 次拉起安装器但版本仍未更新，放弃待装版本 {}",
            p.attempts, p.version
        ));
    }
    StartupAction::Install
}

/// 先写临时文件并落盘，再改名覆盖（同一目录内原子替换）。
fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 命令错误：`code` 供前端区分（`unavailable`、`busy`、`noPending`、`invalid`、`cancelled`、`failed`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct UpdateError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl UpdateError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// 更新流程所处阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UpdatePhase {
    Idle,
    Checking,
    Downloading,
    Installing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingInfo {
    pub(crate) version: String,
    pub(crate) notes: Option<String>,
}

/// `update_status` 的返回值，也是 `update_watch` 推送的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub(crate) current_version: String,
    /// 是否可以自动更新（发布构建编译进了公钥、Windows 平台、架构受支持）
    pub(crate) available: bool,
    pub(crate) settings: UpdateSettings,
    pub(crate) phase: UpdatePhase,
    pub(crate) progress: Option<DownloadProgress>,
    /// 已下载并校验、等待安装的版本
    pub(crate) pending: Option<PendingInfo>,
    /// 上次检查完成的时间（毫秒）
    pub(crate) last_check: Option<u64>,
    /// 上次检查或下载失败的原因（自动检查失败不弹提示，只在设置页显示）
    pub(crate) last_error: Option<String>,
}

/// 校验通过、等待交给安装器的安装包。Windows 上持有一个只共享读的句柄（拒绝写入、改名与删除）；
/// 拉起安装器时把它的可继承副本交给等待安装器结束的 PowerShell，保证从验签到安装器读取结束，安装包都不能被替换。
pub(crate) struct VerifiedPackage {
    pub(crate) path: PathBuf,
    pub(crate) version: String,
    /// updater 签名（交给更新服务再验一次）
    pub(crate) signature: String,
    lock: File,
}

struct Runtime {
    phase: UpdatePhase,
    progress: Option<DownloadProgress>,
    last_check: Option<u64>,
    last_error: Option<String>,
}

type Listener = Box<dyn Fn(UpdateStatus) + Send + Sync>;

/// 更新状态（Tauri 托管为 `Arc<Updater>`）。
pub(crate) struct Updater {
    current_version: Version,
    target: Option<String>,
    pubkey: Option<&'static str>,
    updates_dir: PathBuf,
    /// `--data-dir` 指定的数据目录：安装后重新打开 Primus 时原样带上
    relaunch_data_dir: Option<PathBuf>,
    settings_file: PathBuf,
    settings: Mutex<UpdateSettings>,
    runtime: Mutex<Runtime>,
    listener: Mutex<Option<Listener>>,
    /// 检查 / 下载进行中（自动与手动共用，同一时刻只有一个）
    busy: AtomicBool,
    /// 已把安装交给更新服务或安装器（本进程随即退出）：退出时不再尝试安装
    handed_off: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Updater {
    pub(crate) fn new(
        current_version: Version,
        updates_dir: PathBuf,
        app_dir: &Path,
        pubkey: Option<&'static str>,
    ) -> Self {
        let settings_file = app_dir.join(SETTINGS_FILE);
        Self {
            current_version,
            target: target_for(current_arch()),
            pubkey,
            updates_dir,
            relaunch_data_dir: None,
            settings: Mutex::new(UpdateSettings::load(&settings_file)),
            settings_file,
            runtime: Mutex::new(Runtime {
                phase: UpdatePhase::Idle,
                progress: None,
                last_check: None,
                last_error: None,
            }),
            listener: Mutex::new(None),
            busy: AtomicBool::new(false),
            handed_off: AtomicBool::new(false),
        }
    }

    /// 数据目录来自 `--data-dir` 时设置：安装器结束后重新打开 Primus 带上同一个数据目录。
    pub(crate) fn with_relaunch_data_dir(mut self, data_dir: Option<PathBuf>) -> Self {
        self.relaunch_data_dir = data_dir;
        self
    }

    /// 是否可以自动更新：有公钥、Windows、架构受支持。
    pub(crate) fn available(&self) -> bool {
        self.pubkey.is_some() && cfg!(windows) && self.target.is_some()
    }

    pub(crate) fn settings(&self) -> UpdateSettings {
        *lock(&self.settings)
    }

    fn pending_path(&self) -> PathBuf {
        self.updates_dir.join(PENDING_FILE)
    }

    /// 读取待装包描述；文件名不合法的描述视为无效。
    pub(crate) fn read_pending(&self) -> Option<PendingUpdate> {
        let bytes = fs::read(self.pending_path()).ok()?;
        let pending: PendingUpdate = serde_json::from_slice(&bytes).ok()?;
        let name_ok = package_file_name(&pending.file).as_deref() == Some(pending.file.as_str());
        name_ok.then_some(pending)
    }

    fn write_pending(&self, pending: &PendingUpdate) -> io::Result<()> {
        write_atomic(
            &self.pending_path(),
            &serde_json::to_vec_pretty(pending).map_err(io::Error::other)?,
        )
    }

    /// 删除待装包与描述，以及 updates 目录里其他残留的安装包（日志保留）。
    pub(crate) fn discard_pending(&self, reason: &str) {
        self.log(&format!("删除待装包：{reason}"));
        let _ = fs::remove_file(self.pending_path());
        self.remove_packages_except(None);
        self.notify();
    }

    fn remove_packages_except(&self, keep: Option<&str>) {
        let Ok(entries) = fs::read_dir(&self.updates_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == LOG_FILE
                || name == PENDING_FILE
                || name == ABANDONED_FILE
                || keep == Some(name.as_ref())
            {
                continue;
            }
            let _ = fs::remove_file(entry.path());
        }
    }

    /// 多次安装未生效而放弃的版本。
    fn abandoned_version(&self) -> Option<String> {
        #[derive(Deserialize)]
        struct Abandoned {
            version: String,
        }
        let bytes = fs::read(self.updates_dir.join(ABANDONED_FILE)).ok()?;
        serde_json::from_slice::<Abandoned>(&bytes)
            .ok()
            .map(|a| a.version)
    }

    /// 放弃待装版本：记下版本（自动检查不再下载它），再删除待装包。
    fn abandon_pending(&self, version: &str, reason: &str) {
        let record = serde_json::json!({ "version": version });
        if let Err(e) = write_atomic(
            &self.updates_dir.join(ABANDONED_FILE),
            record.to_string().as_bytes(),
        ) {
            self.log(&format!("无法记录放弃的版本 {version}：{e}"));
        }
        self.discard_pending(reason);
    }

    /// 按启动规则处理待装包：需要删除或放弃时执行并返回原因。
    fn apply_discard(
        &self,
        action: &StartupAction,
        pending: Option<&PendingUpdate>,
    ) -> Option<String> {
        match action {
            StartupAction::Discard(reason) => {
                self.discard_pending(reason);
                Some(reason.clone())
            }
            StartupAction::Abandon(reason) => {
                match pending {
                    Some(p) => self.abandon_pending(&p.version, reason),
                    None => self.discard_pending(reason),
                }
                Some(reason.clone())
            }
            StartupAction::Nothing | StartupAction::Install => None,
        }
    }

    /// 校验磁盘上的待装包：SHA-256 与描述一致，签名（含绑定的版本）有效。
    fn verify_stored(&self, pending: &PendingUpdate, pubkey: &str) -> Result<(), String> {
        let bytes = fs::read(self.updates_dir.join(&pending.file))
            .map_err(|e| format!("读取安装包失败：{e}"))?;
        if sha256_hex(&bytes) != pending.sha256 {
            return Err("安装包的 SHA-256 与下载时不一致".to_owned());
        }
        verify_signature(&bytes, &pending.signature, pubkey, &pending.version)
    }

    pub(crate) fn status(&self) -> UpdateStatus {
        let runtime = lock(&self.runtime);
        UpdateStatus {
            current_version: self.current_version.to_string(),
            available: self.available(),
            settings: self.settings(),
            phase: runtime.phase,
            progress: runtime.progress.clone(),
            pending: self
                .read_pending()
                .filter(|p| is_newer(&p.version, &self.current_version))
                .map(|p| PendingInfo {
                    version: p.version,
                    notes: p.notes,
                }),
            last_check: runtime.last_check,
            last_error: runtime.last_error.clone(),
        }
    }

    /// 注册状态推送（再次调用替换旧的），注册后立即推送一次当前状态。
    pub(crate) fn set_listener(&self, listener: impl Fn(UpdateStatus) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Box::new(listener));
        self.notify();
    }

    fn notify(&self) {
        let status = self.status();
        if let Some(listener) = lock(&self.listener).as_ref() {
            listener(status);
        }
    }

    fn set_phase(&self, phase: UpdatePhase, progress: Option<DownloadProgress>) {
        {
            let mut runtime = lock(&self.runtime);
            runtime.phase = phase;
            runtime.progress = progress;
        }
        self.notify();
    }

    /// 修改设置并保存；自动更新从关到开时返回 true（调用方据此立即检查一次）。
    pub(crate) fn set_settings(
        &self,
        auto_update: Option<bool>,
        channel: Option<UpdateChannel>,
    ) -> Result<bool, UpdateError> {
        let turned_on = {
            let mut settings = lock(&self.settings);
            let mut next = *settings;
            if let Some(v) = auto_update {
                next.auto_update = v;
            }
            if let Some(c) = channel {
                next.channel = c;
            }
            next.save(&self.settings_file)
                .map_err(|e| UpdateError::new("failed", format!("保存更新设置失败：{e}")))?;
            let turned_on = next.auto_update && !settings.auto_update;
            *settings = next;
            turned_on
        };
        self.notify();
        Ok(turned_on)
    }

    /// 追加一行到 `updates/updater.log`（只有当前用户可读写；超过 1MB 时清空重写）。失败忽略。
    pub(crate) fn log(&self, message: &str) {
        let path = self.updates_dir.join(LOG_FILE);
        if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
            let _ = fs::remove_file(&path);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{} {message}", now_millis());
        }
        eprintln!("[updater] {message}");
    }

    /// 检查更新；有更高版本且不是已下载的同一版本时下载、验签并存为待装包。
    /// 返回检查后的状态；`channel` 为本次检查使用的通道（不保存），缺省用设置中的通道。
    /// `manual` 为用户在设置页手动检查：此时也会重新下载之前多次安装未生效而放弃的版本。
    pub(crate) async fn check_and_download<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        channel: Option<UpdateChannel>,
        manual: bool,
    ) -> Result<UpdateStatus, UpdateError> {
        if !self.available() {
            return Err(UpdateError::new(
                "unavailable",
                "此版本未启用自动更新（开发构建或缺少更新公钥）",
            ));
        }
        if self.busy.swap(true, Ordering::AcqRel) {
            // 已有检查或下载在进行：返回当前状态，进度经 update_watch 推送
            return Ok(self.status());
        }
        let result = self.check_inner(app, channel, manual).await;
        {
            // 先在锁内复位状态再放开 busy，下一次检查开始时看到的已是复位后的状态
            let mut runtime = lock(&self.runtime);
            runtime.phase = UpdatePhase::Idle;
            runtime.progress = None;
            runtime.last_check = Some(now_millis());
            runtime.last_error = result.as_ref().err().map(|e| e.message.clone());
        }
        self.busy.store(false, Ordering::Release);
        if let Err(e) = &result {
            self.log(&format!("检查或下载更新失败：{}", e.message));
        }
        self.notify();
        result.map(|()| self.status())
    }

    async fn check_inner<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        channel: Option<UpdateChannel>,
        manual: bool,
    ) -> Result<(), UpdateError> {
        use tauri_plugin_updater::UpdaterExt;
        let failed = |e: &dyn std::fmt::Display| UpdateError::new("failed", e.to_string());
        let (Some(pubkey), Some(target)) = (self.pubkey, self.target.clone()) else {
            return Err(UpdateError::new("unavailable", "此版本未启用自动更新"));
        };
        let channel = channel.unwrap_or_else(|| self.settings().channel);
        let urls = endpoints(channel, debug_endpoint_override().as_deref())
            .iter()
            .map(|u| u.parse())
            .collect::<Result<Vec<tauri::Url>, _>>()
            .map_err(|e| failed(&e))?;
        self.set_phase(UpdatePhase::Checking, None);
        let updater = app
            .updater_builder()
            .pubkey(pubkey)
            .target(target)
            .endpoints(urls)
            .map_err(|e| failed(&e))?
            .timeout(CHECK_TIMEOUT)
            // 插件不把 timeout 用于下载：连接与读取停滞的超时在客户端上设置（清单与下载都适用）
            .configure_client(|client| {
                client
                    .connect_timeout(CONNECT_TIMEOUT)
                    .read_timeout(READ_TIMEOUT)
            })
            .build()
            .map_err(|e| failed(&e))?;
        let Some(mut update) = updater.check().await.map_err(|e| failed(&e))? else {
            self.log(&format!(
                "{channel:?} 通道没有比 {} 更新的版本",
                self.current_version
            ));
            return Ok(());
        };
        if !is_newer(&update.version, &self.current_version) {
            return Ok(());
        }
        if self.abandoned_version().as_deref() == Some(update.version.as_str()) {
            if !manual {
                self.log(&format!(
                    "版本 {} 多次安装未生效，自动检查不再下载",
                    update.version
                ));
                return Ok(());
            }
            // 用户手动检查：清掉放弃记录，重新下载再试
            let _ = fs::remove_file(self.updates_dir.join(ABANDONED_FILE));
        }
        if let Some(pending) = self.read_pending()
            && pending.version == update.version
        {
            // 复用前确认磁盘上的安装包完好；损坏或缺失时删除并重新下载
            match self.verify_stored(&pending, pubkey) {
                Ok(()) => {
                    self.log(&format!("版本 {} 已下载，等待安装", pending.version));
                    return Ok(());
                }
                Err(e) => self.discard_pending(&format!(
                    "已下载的 {} 校验失败，重新下载：{e}",
                    pending.version
                )),
            }
        }
        let file = package_file_name(update.download_url.as_str()).ok_or_else(|| {
            UpdateError::new("failed", format!("下载地址不合法：{}", update.download_url))
        })?;
        self.log(&format!("开始下载 {} → {file}", update.version));

        self.set_phase(
            UpdatePhase::Downloading,
            Some(DownloadProgress {
                downloaded: 0,
                total: None,
            }),
        );
        // 下载的总时长上限（插件把 Update::timeout 用作下载请求的超时）
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        let mut downloaded = 0u64;
        let mut last_push = Instant::now();
        let too_large = Arc::new(AtomicBool::new(false));
        let flag = too_large.clone();
        // download 内部按插件规则验签（含 requireSignedVersion），不通过返回错误
        let download = update.download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded > MAX_PACKAGE_BYTES || total.is_some_and(|t| t > MAX_PACKAGE_BYTES) {
                    flag.store(true, Ordering::Release);
                    return;
                }
                if last_push.elapsed() >= PROGRESS_INTERVAL {
                    last_push = Instant::now();
                    self.set_phase(
                        UpdatePhase::Downloading,
                        Some(DownloadProgress { downloaded, total }),
                    );
                }
            },
            || {},
        );
        // 超过大小上限时丢弃下载的 future（中止请求、释放已缓存的内容），不等它读完
        let mut download = std::pin::pin!(download);
        let bytes = std::future::poll_fn(|cx| {
            let polled = download.as_mut().poll(cx);
            if too_large.load(Ordering::Acquire) {
                return Poll::Ready(Err(UpdateError::new(
                    "failed",
                    format!(
                        "安装包超过 {} MB，已中止下载",
                        MAX_PACKAGE_BYTES / 1024 / 1024
                    ),
                )));
            }
            polled.map(|r| r.map_err(|e| failed(&e)))
        })
        .await?;
        let pending = PendingUpdate {
            version: update.version.clone(),
            notes: update.body.clone(),
            file,
            sha256: sha256_hex(&bytes),
            signature: update.signature.clone(),
            attempts: 0,
        };
        self.store_package(&pending, &bytes)
            .map_err(|e| UpdateError::new("failed", format!("保存安装包失败：{e}")))?;
        self.log(&format!("版本 {} 已下载并校验，等待安装", pending.version));
        Ok(())
    }

    /// 写入安装包（先写临时文件再改名），再原子写 `pending.json`；两者都提交后才清掉旧的安装包，
    /// 写入失败时旧的待装包仍然可用。
    pub(crate) fn store_package(&self, pending: &PendingUpdate, bytes: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.updates_dir)?;
        // 标准用户“过肩”提权时安装器以管理员账号运行，读不到安装包就会安装失败：授权失败不发布待装包
        crate::platform::grant_admins_read(&self.updates_dir).map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("无法给 updates 目录追加 Administrators 只读权限：{e}"),
            )
        })?;
        write_atomic(&self.updates_dir.join(&pending.file), bytes)?;
        self.write_pending(pending)?;
        self.remove_packages_except(Some(&pending.file));
        Ok(())
    }

    /// 安装前的二次校验：从磁盘重读安装包，核对版本、安装方式、SHA-256，并用编译进的公钥重新校验签名。
    /// 任一项不通过时删除待装包。
    pub(crate) fn prepare_install(&self) -> Result<VerifiedPackage, UpdateError> {
        let pubkey = self
            .pubkey
            .filter(|_| self.available())
            .ok_or_else(|| UpdateError::new("unavailable", "此版本未启用自动更新"))?;
        let pending = self
            .read_pending()
            .ok_or_else(|| UpdateError::new("noPending", "没有已下载的更新"))?;
        let action = startup_action(Some(&pending), &self.current_version);
        if let Some(reason) = self.apply_discard(&action, Some(&pending)) {
            return Err(UpdateError::new("noPending", reason));
        }
        let path = self.updates_dir.join(&pending.file);
        let invalid = |reason: String| {
            self.discard_pending(&reason);
            UpdateError::new("invalid", reason)
        };
        let (lock_file, bytes) = open_locked(&path)
            .map_err(|e| invalid(format!("读取安装包 {} 失败：{e}", path.display())))?;
        // 校验失败时先关闭锁句柄再删除：Windows 上句柄未共享删除，不关闭就删不掉安装包
        if sha256_hex(&bytes) != pending.sha256 {
            drop(lock_file);
            return Err(invalid("安装包的 SHA-256 与下载时不一致".to_owned()));
        }
        if let Err(e) = verify_signature(&bytes, &pending.signature, pubkey, &pending.version) {
            drop(lock_file);
            return Err(invalid(format!("安装包签名校验失败：{e}")));
        }
        Ok(VerifiedPackage {
            path,
            version: pending.version,
            signature: pending.signature,
            lock: lock_file,
        })
    }

    /// 安装器已成功拉起：记一次尝试（安装失败时下次启动据此放弃）。
    pub(crate) fn record_attempt(&self) {
        if let Some(mut pending) = self.read_pending() {
            pending.attempts += 1;
            let _ = self.write_pending(&pending);
        }
    }

    pub(crate) fn set_installing(&self, installing: bool) {
        self.set_phase(
            if installing {
                UpdatePhase::Installing
            } else {
                UpdatePhase::Idle
            },
            None,
        );
    }

    pub(crate) fn current_version(&self) -> &Version {
        &self.current_version
    }

    /// 退出时是否要安装：可以自动更新、设置开启、有待装包，且还没有把安装交出去。
    pub(crate) fn wants_install_on_exit(&self) -> bool {
        self.available()
            && self.settings().auto_update
            && !self.handed_off.load(Ordering::Acquire)
            && self.read_pending().is_some()
    }
}

/// 打开安装包并读出全部内容。Windows 上以只共享读的方式打开（拒绝其他进程写入、删除或改名），
/// 返回的句柄保持到安装器拉起之后。
fn open_locked(path: &Path) -> io::Result<(File, Vec<u8>)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ：安装器仍可读取
        options.share_mode(0x0000_0001);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "不是普通文件"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((file, bytes))
}

/// 什么时候安装：决定安装后是否重新打开 Primus、服务不可用时能否回退到 UAC。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallTrigger {
    /// 用户点了“立即重启更新”：装完重新打开；服务不可用时回退到 UAC
    RestartNow,
    /// 启动时发现待装包：装完重新打开；服务不可用时回退到 UAC
    Startup,
    /// 用户退出 Primus：装完不重新打开；服务不可用时不弹 UAC，留到下次启动
    Exit,
}

impl InstallTrigger {
    fn relaunch(self) -> bool {
        self != Self::Exit
    }
}

/// 拉起安装的结果。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LaunchOutcome {
    /// 更新服务已接手或安装器已运行，调用方应退出（安装结束后会以普通权限重新打开 Primus，退出时安装除外）
    Started,
    /// 用户取消了 UAC
    Cancelled,
    /// 退出时安装但更新服务不可用：什么都没做，待装包留到下次启动
    Deferred,
}

/// 服务看到的路径：去掉 `\\?\` 前缀与结尾的反斜杠，须是普通的本地绝对路径（否则当作服务不可用，回退到 UAC）。
fn plain_path(path: &Path, ext: Option<&str>) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("路径不是 Unicode：{}", path.display()))?;
    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
    let text = if ext.is_none() {
        text.trim_end_matches('\\')
    } else {
        text
    };
    primus_update::protocol::validate_local_path(text, ext)
        .map_err(|e| format!("路径 {text} {e}"))?;
    Ok(text.to_owned())
}

/// 更新服务的处理结果。
enum ServiceOutcome {
    Accepted,
    /// 服务拒绝了请求（签名、版本、格式、正在安装）：不回退到 UAC
    Rejected(UpdateError),
    /// 服务不可用（没装、没启用、通信失败、路径不便交给服务）：可以回退到 UAC
    Unavailable(String),
}

/// 把已校验的安装包交给更新服务。
fn request_service(updater: &Updater, package: &VerifiedPackage, relaunch: bool) -> ServiceOutcome {
    use primus_update::protocol::{InstallRequest, PROTOCOL_VERSION, ResponseCode};
    let package_path = match plain_path(&package.path, Some("msi")) {
        Ok(p) => p,
        Err(e) => return ServiceOutcome::Unavailable(e),
    };
    let data_dir = match updater.relaunch_data_dir.as_deref().filter(|_| relaunch) {
        Some(dir) => match plain_path(dir, None) {
            Ok(d) => Some(d),
            Err(e) => return ServiceOutcome::Unavailable(e),
        },
        None => None,
    };
    let request = InstallRequest {
        protocol: PROTOCOL_VERSION,
        package: package_path,
        version: package.version.clone(),
        signature: package.signature.trim().to_owned(),
        relaunch,
        data_dir,
    };
    #[cfg(windows)]
    let response = primus_update::client::request_install(&request);
    #[cfg(not(windows))]
    let response: Result<primus_update::protocol::Response, String> = {
        let _ = &request;
        Err("更新服务只支持 Windows".to_owned())
    };
    let response = match response {
        Ok(r) => r,
        Err(e) => return ServiceOutcome::Unavailable(e),
    };
    updater.log(&format!(
        "更新服务应答 {:?}：{}",
        response.code, response.message
    ));
    match response.code {
        ResponseCode::Accepted => ServiceOutcome::Accepted,
        ResponseCode::Unavailable => ServiceOutcome::Unavailable(response.message),
        ResponseCode::Busy => {
            ServiceOutcome::Rejected(UpdateError::new("failed", "上一次更新仍在安装，请稍后再试"))
        }
        ResponseCode::Signature | ResponseCode::NotNewer | ResponseCode::Invalid => {
            // 服务按同一规则复核不通过：这个待装包不能再用
            updater.discard_pending(&format!("更新服务拒绝：{}", response.message));
            ServiceOutcome::Rejected(UpdateError::new("invalid", response.message))
        }
        ResponseCode::Failed => {
            ServiceOutcome::Rejected(UpdateError::new("failed", response.message))
        }
    }
}

/// 安装已校验的待装包：先交给更新服务（静默），服务不可用时按时机回退到 UAC 或留到下次启动。
/// 交出成功记一次尝试（安装失败时下次启动据此放弃）；失败或取消时待装包保留。
pub(crate) fn launch(
    updater: &Updater,
    package: VerifiedPackage,
    trigger: InstallTrigger,
) -> Result<LaunchOutcome, UpdateError> {
    updater.log(&format!(
        "安装版本 {}（{trigger:?}），交给更新服务",
        package.version
    ));
    match request_service(updater, &package, trigger.relaunch()) {
        ServiceOutcome::Accepted => {
            updater.record_attempt();
            updater.handed_off.store(true, Ordering::Release);
            return Ok(LaunchOutcome::Started);
        }
        ServiceOutcome::Rejected(e) => return Err(e),
        ServiceOutcome::Unavailable(reason) => {
            updater.log(&format!("更新服务不可用：{reason}"));
            if trigger == InstallTrigger::Exit {
                return Ok(LaunchOutcome::Deferred);
            }
        }
    }
    launch_elevated(updater, package)
}

/// 回退：经 UAC 拉起 msiexec（安装包已校验），安装器结束后以普通权限重新打开 Primus。
fn launch_elevated(
    updater: &Updater,
    package: VerifiedPackage,
) -> Result<LaunchOutcome, UpdateError> {
    let system_dir = crate::platform::system_dir();
    let command = installer_command(&package.path, &system_dir);
    let relaunch = std::env::current_exe()
        .map_err(|e| UpdateError::new("failed", format!("无法确定 Primus.exe 路径：{e}")))?;
    updater.log(&format!(
        "经 UAC 拉起安装器：{} {}（版本 {}）",
        command.program.display(),
        command.params,
        package.version
    ));
    match crate::platform::launch_installer(
        &command.program,
        &command.params,
        &relaunch,
        updater.relaunch_data_dir.as_deref(),
        &package.lock,
    ) {
        Ok(Some(relaunch_scheduled)) => {
            updater.record_attempt();
            updater.handed_off.store(true, Ordering::Release);
            let version = package.version.clone();
            if !relaunch_scheduled {
                // 没有等待安装器的 PowerShell 接手安装包句柄：至少在模态提示框关闭前仍由本进程持有
                updater.log("无法安排安装后自动重新打开 Primus，已提示用户手动打开");
                crate::platform::show_info(&format!(
                    "Primus {} 正在安装。安装完成后请手动打开 Primus。",
                    version
                ));
            }
            Ok(LaunchOutcome::Started)
        }
        Ok(None) => {
            updater.log("用户取消了管理员授权，待装包保留");
            Ok(LaunchOutcome::Cancelled)
        }
        Err(e) => {
            updater.log(&format!("拉起安装器失败：{e}"));
            Err(UpdateError::new("failed", format!("无法启动安装程序：{e}")))
        }
    }
}

/// 启动时（数据目录就绪、单实例确认之后，创建窗口与拉起 Core 之前）处理待装包：
/// 版本更高 → 校验后交给更新服务（或经 UAC 拉起安装器），成功返回 true（调用方立即退出）；已装过或无效 → 清理。
pub(crate) fn install_on_startup(updater: &Updater) -> bool {
    let pending = updater.read_pending();
    match startup_action(pending.as_ref(), updater.current_version()) {
        StartupAction::Nothing => {
            // 没有描述但目录里残留安装包（例如写描述前被中断）：清掉
            if pending.is_none() {
                updater.remove_packages_except(None);
            }
            false
        }
        action @ (StartupAction::Discard(_) | StartupAction::Abandon(_)) => {
            updater.apply_discard(&action, pending.as_ref());
            false
        }
        StartupAction::Install => {
            if !updater.available() {
                return false;
            }
            match updater
                .prepare_install()
                .and_then(|p| launch(updater, p, InstallTrigger::Startup))
            {
                Ok(LaunchOutcome::Started) => true,
                Ok(LaunchOutcome::Cancelled | LaunchOutcome::Deferred) => false,
                Err(e) => {
                    updater.log(&format!("启动时安装更新未完成：{}", e.message));
                    false
                }
            }
        }
    }
}

/// 退出时安装（`RunEvent::Exit`，调用方已确认没有运行中的 Agent 并结束了全部 Core）：只走更新服务，不弹 UAC，
/// 装完不重新打开。失败只记日志，待装包留到下次启动。
pub(crate) fn install_on_exit(updater: &Updater) {
    match updater
        .prepare_install()
        .and_then(|p| launch(updater, p, InstallTrigger::Exit))
    {
        Ok(LaunchOutcome::Started) => updater.log("退出时已交给更新服务安装"),
        Ok(_) => updater.log("退出时没有安装，留到下次启动"),
        Err(e) => updater.log(&format!("退出时安装更新未完成：{}", e.message)),
    }
}

/// 自动检查：主窗口起来后延迟约 10 秒检查一次，之后每 24 小时一次；自动更新关闭时跳过。失败只记日志。
pub(crate) fn start_auto_check<R: tauri::Runtime>(app: tauri::AppHandle<R>, updater: Arc<Updater>) {
    if !updater.available() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("primus-updater".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                if updater.settings().auto_update {
                    let _ = tauri::async_runtime::block_on(
                        updater.check_and_download(&app, None, false),
                    );
                }
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[updater] 无法启动自动检查线程：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::tests::TempDir;

    // tauri signer 2.12 实际生成的公钥与签名（与 scripts/updater-signature.test.ts 相同的一次性测试密钥，私钥已丢弃）：
    // 对内容 "hello\n" 执行 tauri signer sign --app-version 1.2.3
    const TAURI_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg5MUM5RTJDM0IzMEFCNzIKUldSeXF6QTdMSjRjaWRMejQ1Wi9vcGF3MS9GRTFJTE0wS3V6a0ZIUGljcWtmQUgwMVVuVW1rQzQK";
    const TAURI_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeXF6QTdMSjRjaWRhcW1GNFVHRHFUZHI3SHdMQU90a3hGaEFGUENlY1MyR0JZVjdEOUprb0dOTER5WTVqamw4Z0JxcHlzYXNVaWRWTytRUjhxWm9Nc2FBazcvQ2J1TWdnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzNDUxMzgwCWZpbGU6aAl2ZXJzaW9uOjEuMi4zCkxORFRMdTVIREZaZThkaWpVdHkrUTk0N0RBVHljNll4SVc1V2lIWmRJanB6aDVGQndpZ3NaeGFjeVY4T0lWWTNEaHd5S1NvL3JyLzhCNFZwanJBS0NRPT0K";
    // 另一把随机生成的公钥（密钥 ID 不同）
    const OTHER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldRQkFnTUVCUVlIQ09qaVVtQSt6SnlBTFdFSmdBMngraGdObUVIay96Q3FOeDFNQVNzaUdpTlMK";
    const HELLO: &[u8] = b"hello\n";

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    // 验签与版本比较的完整用例在 update-service（primus_update::verify）；这里确认薄壳用的是同一份实现
    #[test]
    fn shared_verify_and_version_rules() {
        assert_eq!(
            verify_signature(HELLO, TAURI_SIG, TAURI_PUBKEY, "1.2.3"),
            Ok(())
        );
        assert!(verify_signature(HELLO, TAURI_SIG, OTHER_PUBKEY, "1.2.3").is_err());
        assert!(is_newer("1.3.0", &v("1.3.0-beta.2")));
        assert!(!is_newer("1.2.9", &v("1.3.0-beta.2")));
    }

    #[test]
    fn endpoints_per_channel_and_debug_override() {
        assert_eq!(
            endpoints(UpdateChannel::Stable, None),
            vec!["https://github.com/skaduv/primus/releases/download/update-feed/stable.json"]
        );
        assert_eq!(
            endpoints(UpdateChannel::Beta, Some(" ")),
            vec!["https://github.com/skaduv/primus/releases/download/update-feed/beta.json"]
        );
        assert_eq!(
            endpoints(UpdateChannel::Beta, Some("http://127.0.0.1:8080/x.json")),
            vec!["http://127.0.0.1:8080/x.json"]
        );
    }

    #[test]
    fn msi_target_names() {
        assert_eq!(target_for("x86_64").as_deref(), Some("windows-x86_64-msi"));
        assert_eq!(
            target_for("aarch64").as_deref(),
            Some("windows-aarch64-msi")
        );
        assert_eq!(target_for("i686"), None);
    }

    #[test]
    fn plain_paths_for_the_service() {
        let msi = Path::new(
            r"\\?\C:\Program Files\Primus\data\users\S-1\updates\Primus_1.0.0_x64_zh-CN.msi",
        );
        assert_eq!(
            plain_path(msi, Some("msi")).as_deref(),
            Ok(r"C:\Program Files\Primus\data\users\S-1\updates\Primus_1.0.0_x64_zh-CN.msi")
        );
        assert_eq!(
            plain_path(Path::new(r"D:\Primus Data\"), None).as_deref(),
            Ok(r"D:\Primus Data")
        );
        assert!(plain_path(Path::new(r"\\server\share\a.msi"), Some("msi")).is_err());
        assert!(plain_path(Path::new(r"C:\a.exe"), Some("msi")).is_err());
    }

    #[test]
    fn settings_default_on_and_roundtrip() {
        let tmp = TempDir::new();
        let path = tmp.0.join("update.json");
        assert_eq!(
            UpdateSettings::load(&path),
            UpdateSettings {
                auto_update: true,
                channel: UpdateChannel::Stable
            }
        );
        fs::write(&path, b"{not json").unwrap();
        assert!(UpdateSettings::load(&path).auto_update);
        fs::write(&path, br#"{"channel":"beta"}"#).unwrap();
        assert_eq!(
            UpdateSettings::load(&path),
            UpdateSettings {
                auto_update: true,
                channel: UpdateChannel::Beta
            }
        );
        let s = UpdateSettings {
            auto_update: false,
            channel: UpdateChannel::Beta,
        };
        s.save(&path).unwrap();
        assert_eq!(UpdateSettings::load(&path), s);
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("\"autoUpdate\": false")
        );
    }

    #[test]
    fn package_file_names_are_sanitized() {
        assert_eq!(
            package_file_name(
                "https://github.com/skaduv/primus/releases/download/v0.0.7/Primus_0.0.7_x64_zh-CN.msi"
            )
            .as_deref(),
            Some("Primus_0.0.7_x64_zh-CN.msi")
        );
        assert_eq!(
            package_file_name("https://x/Primus_0.0.7_arm64_zh-CN.msi?x=1").as_deref(),
            Some("Primus_0.0.7_arm64_zh-CN.msi")
        );
        for bad in [
            "https://x/Primus_0.0.7_arm64-setup.exe",
            "https://x/Primus.exe",
            "https://x/",
            "https://x/..msi",
            "https://x/a%20b.msi",
            "https://x/.hidden.msi",
            "https://x/a b.msi",
        ] {
            assert_eq!(package_file_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn installer_command_lines() {
        let sys = Path::new("C:\\Windows\\System32");
        let pkg = Path::new("D:\\Primus\\data\\users\\S-1\\updates\\Primus_1.0.0_x64_zh-CN.msi");
        let msi = installer_command(pkg, sys);
        assert_eq!(msi.program, sys.join("msiexec.exe"));
        assert_eq!(
            msi.params,
            format!("/i \"{}\" /passive /norestart", pkg.display())
        );
    }

    fn pending(version: &str) -> PendingUpdate {
        PendingUpdate {
            version: version.to_owned(),
            notes: Some("说明".to_owned()),
            file: "Primus_1.2.3_x64_zh-CN.msi".to_owned(),
            sha256: sha256_hex(HELLO),
            signature: TAURI_SIG.to_owned(),
            attempts: 0,
        }
    }

    #[test]
    fn startup_actions() {
        let cur = v("1.2.2");
        assert_eq!(startup_action(None, &cur), StartupAction::Nothing);
        let p = pending("1.2.3");
        assert_eq!(startup_action(Some(&p), &cur), StartupAction::Install);
        assert!(matches!(
            startup_action(Some(&p), &v("1.2.3")),
            StartupAction::Discard(_)
        ));
        let tried = PendingUpdate {
            attempts: MAX_INSTALL_ATTEMPTS,
            ..p
        };
        assert!(matches!(
            startup_action(Some(&tried), &cur),
            StartupAction::Abandon(_)
        ));
    }

    fn updater(tmp: &TempDir, current: &str, pubkey: Option<&'static str>) -> Updater {
        let app = tmp.0.join("app");
        fs::create_dir_all(&app).unwrap();
        Updater::new(v(current), tmp.0.join("updates"), &app, pubkey)
    }

    #[test]
    fn store_then_read_pending_and_status() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.2", Some(TAURI_PUBKEY));
        assert_eq!(u.read_pending(), None);
        fs::create_dir_all(tmp.0.join("updates")).unwrap();
        fs::write(tmp.0.join("updates/Primus_old.msi"), b"old").unwrap();
        let p = pending("1.2.3");
        u.store_package(&p, HELLO).unwrap();
        assert_eq!(u.read_pending(), Some(p.clone()));
        assert!(
            !tmp.0.join("updates/Primus_old.msi").exists(),
            "旧安装包被清掉"
        );
        let status = u.status();
        assert_eq!(status.current_version, "1.2.2");
        assert_eq!(
            status.pending,
            Some(PendingInfo {
                version: "1.2.3".into(),
                notes: Some("说明".into())
            })
        );
        assert!(status.settings.auto_update);
        // 描述里的文件名被篡改成路径时不认
        let mut evil = p;
        evil.file = "..\\..\\evil.msi".into();
        fs::write(
            tmp.0.join("updates/pending.json"),
            serde_json::to_vec(&evil).unwrap(),
        )
        .unwrap();
        assert_eq!(u.read_pending(), None);
    }

    #[cfg(windows)]
    #[test]
    fn prepare_install_verifies_and_locks_package() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.2", Some(TAURI_PUBKEY));
        u.store_package(&pending("1.2.3"), HELLO).unwrap();
        let pkg = u.prepare_install().unwrap();
        assert_eq!(pkg.version, "1.2.3");
        // 校验后持有的句柄拒绝写入
        assert!(fs::write(&pkg.path, b"tampered").is_err());
    }

    #[test]
    fn prepare_install_rejects_tampered_package_and_deletes_it() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.2", Some(TAURI_PUBKEY));
        if !u.available() {
            // 非 Windows：整体禁用
            assert_eq!(
                u.prepare_install().err().map(|e| e.code),
                Some("unavailable")
            );
            // 签名与哈希校验本身是平台无关的
            let p = pending("1.2.3");
            assert_eq!(
                verify_signature(HELLO, &p.signature, TAURI_PUBKEY, &p.version),
                Ok(())
            );
            return;
        }
        let p = pending("1.2.3");
        u.store_package(&p, HELLO).unwrap();
        fs::write(tmp.0.join("updates").join(&p.file), b"hello!\n").unwrap();
        assert_eq!(u.prepare_install().err().map(|e| e.code), Some("invalid"));
        assert_eq!(u.read_pending(), None);
        assert!(!tmp.0.join("updates").join(&p.file).exists());
        // 哈希对但签名绑定的版本不对
        let wrong = pending("1.2.4");
        u.store_package(&wrong, HELLO).unwrap();
        assert_eq!(u.prepare_install().err().map(|e| e.code), Some("invalid"));
        assert_eq!(u.read_pending(), None);
    }

    #[test]
    fn startup_cleans_installed_or_stale_packages() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.3", Some(TAURI_PUBKEY));
        u.store_package(&pending("1.2.3"), HELLO).unwrap();
        assert!(!install_on_startup(&u));
        assert_eq!(u.read_pending(), None);
        assert!(!tmp.0.join("updates/Primus_1.2.3_x64_zh-CN.msi").exists());
        // 没有描述的残留安装包也清掉，日志保留
        fs::write(tmp.0.join("updates/Primus_x.msi"), b"x").unwrap();
        assert!(!install_on_startup(&u));
        assert!(!tmp.0.join("updates/Primus_x.msi").exists());
        assert!(tmp.0.join("updates/updater.log").exists());
    }

    #[test]
    fn unavailable_without_pubkey() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.0.0", None);
        assert!(!u.available());
        assert!(!u.status().available);
        u.store_package(&pending("1.2.3"), HELLO).unwrap();
        assert_eq!(
            u.prepare_install().err().map(|e| e.code),
            Some("unavailable")
        );
        // 没有公钥时不尝试安装，也不删除待装包
        assert!(!install_on_startup(&u));
        assert!(u.read_pending().is_some());
    }

    #[test]
    fn settings_changes_are_saved_and_notified() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.0.0", None);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        u.set_listener(move |s| sink.lock().unwrap().push(s.settings));
        assert_eq!(u.set_settings(Some(false), None), Ok(false));
        assert_eq!(
            u.set_settings(Some(true), Some(UpdateChannel::Beta)),
            Ok(true)
        );
        assert_eq!(u.set_settings(Some(true), None), Ok(false));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 4, "注册时推送一次，之后每次修改推送");
        assert_eq!(seen[2].channel, UpdateChannel::Beta);
        assert_eq!(
            UpdateSettings::load(&tmp.0.join("app/update.json")),
            UpdateSettings {
                auto_update: true,
                channel: UpdateChannel::Beta
            }
        );
    }

    #[test]
    fn abandoned_version_is_recorded_and_survives_cleanup() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.2", None);
        let p = PendingUpdate {
            attempts: MAX_INSTALL_ATTEMPTS,
            ..pending("1.2.3")
        };
        u.store_package(&p, HELLO).unwrap();
        assert!(!install_on_startup(&u));
        assert_eq!(u.read_pending(), None);
        assert_eq!(u.abandoned_version().as_deref(), Some("1.2.3"));
        // 之后存入新版本、启动清理都不删放弃记录
        u.store_package(&pending("1.2.4"), HELLO).unwrap();
        u.remove_packages_except(None);
        assert_eq!(u.abandoned_version().as_deref(), Some("1.2.3"));
    }

    #[test]
    fn store_keeps_new_package_and_removes_old_after_commit() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.2", None);
        let old = pending("1.2.3");
        u.store_package(&old, HELLO).unwrap();
        let new = PendingUpdate {
            file: "Primus_1.2.4_x64_zh-CN.msi".into(),
            ..pending("1.2.4")
        };
        u.store_package(&new, HELLO).unwrap();
        assert_eq!(u.read_pending(), Some(new.clone()));
        assert!(tmp.0.join("updates").join(&new.file).exists());
        assert!(!tmp.0.join("updates").join(&old.file).exists());
    }

    #[test]
    fn verify_stored_detects_corrupt_or_missing_package() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.2.2", None);
        let p = pending("1.2.3");
        u.store_package(&p, HELLO).unwrap();
        assert_eq!(u.verify_stored(&p, TAURI_PUBKEY), Ok(()));
        fs::write(tmp.0.join("updates").join(&p.file), b"hello!\n").unwrap();
        assert!(u.verify_stored(&p, TAURI_PUBKEY).is_err());
        fs::remove_file(tmp.0.join("updates").join(&p.file)).unwrap();
        assert!(u.verify_stored(&p, TAURI_PUBKEY).is_err());
    }

    #[test]
    fn record_attempt_increments() {
        let tmp = TempDir::new();
        let u = updater(&tmp, "1.0.0", None);
        u.store_package(&pending("1.2.3"), HELLO).unwrap();
        u.record_attempt();
        u.record_attempt();
        assert_eq!(u.read_pending().unwrap().attempts, 2);
    }
}
