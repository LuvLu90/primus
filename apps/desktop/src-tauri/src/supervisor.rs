//! Core 进程监管（技术方案第 2.2、4.4、5.3–5.5 节）：优先用电脑上已安装的 Node、没有时用内置 `node.exe` 拉起 Core、重定向环境变量、
//! 收集 stderr、放进 Job Object，并管理进程上限与崩溃计数。
//!
//! - 启动参数（第 5.3 节）：`node.exe <agent-core>/rpc-entry.js [--session <文件>] --approve|--no-approve
//!   -e <agent-core>/extensions/primus-bundle.js`，工作目录为项目目录。
//! - 环境变量（第 4.4 节）：`PRIMUS_CODING_AGENT_DIR`、`PRIMUS_CODING_AGENT_SESSION_DIR`、`TEMP`/`TMP` 指向
//!   `data/users/<SID>`，`PRIMUS_SKIP_VERSION_CHECK=1`、`PRIMUS_TELEMETRY`、`PRIMUS_OFFLINE`，并清空 `NODE_OPTIONS`。
//!   其余环境变量（如 `PATH`）照常继承，工具命令需要它们。
//! - stderr 单独读取（第 5.4 节）：逐行写入 `data/shared/logs/core-<会话>-<日期>.log`，并保留最近 200 行用于崩溃展示。
//! - 每个 Core 进程各放进一个 Job Object（`job` 模块，句柄全部由主进程持有）：主进程被强杀时系统回收全部 Core
//!   及其子孙进程；结束单个 Core（淘汰、空闲回收、停止）时结束其整个作业，工具子进程不残留。
//! - 结束进程、等待 stderr 收尾都不在监管器锁内进行，且 stderr 收尾有时限（后代进程可能仍持有管道写端）。
//! - stdin / stdout 由 `rpc_bridge` 接管（[`CoreProcess::take_stdin`]、[`CoreProcess::take_stdout`]）。
//! - 健康检查与 10 分钟空闲回收依赖 `rpc_bridge` 提供的活动信息，随其接入；这里先提供
//!   [`Supervisor::evict_idle`] 与按最久未使用淘汰的上限控制。

// 由 rpc_bridge 与前端命令使用；它们接入前非测试构建先放行未使用告警，接入后删除此属性。
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::job::Job;
use crate::paths::DataPaths;

/// 崩溃时展示的 stderr 行数（第 5.4 节）。
pub(crate) const STDERR_TAIL_LINES: usize = 200;
/// 同时运行的 Core 进程默认上限与可调范围（第 2.2 节）。
pub(crate) const DEFAULT_MAX_PROCESSES: usize = 4;
pub(crate) const MAX_PROCESSES_RANGE: std::ops::RangeInclusive<usize> = 1..=8;
/// 空闲回收时长（第 2.2 节）。
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// 1 分钟内连续崩溃 3 次不再自动重启（第 5.5 节）。
pub(crate) const CRASH_WINDOW: Duration = Duration::from_secs(60);
pub(crate) const CRASH_LIMIT: usize = 3;
/// 进程结束后等待 stderr 读取线程收尾的时限：超时即放弃等待（线程留在后台直到管道关闭）。
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

#[cfg(windows)]
const NODE_EXE: &str = "node.exe";
#[cfg(not(windows))]
const NODE_EXE: &str = "node";
/// Core 要求的最低 Node 版本（agent-core/package.json 的 engines）：低于它的系统 Node 不用，改用内置运行时。
const MIN_NODE_VERSION: (u32, u32, u32) = (22, 19, 0);

/// Core 运行文件的位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CoreLayout {
    /// 内置 Node 运行时
    pub(crate) node: PathBuf,
    /// RPC 模式入口 `rpc-entry.js`
    pub(crate) entry: PathBuf,
    /// 第一方扩展 `primus-bundle.js`
    pub(crate) extension: PathBuf,
}

impl CoreLayout {
    /// 由运行时目录与 Core 目录组成。
    pub(crate) fn new(runtime_dir: &Path, core_dir: &Path) -> Self {
        Self {
            node: runtime_dir.join(NODE_EXE),
            entry: core_dir.join("rpc-entry.js"),
            extension: core_dir.join("extensions").join("primus-bundle.js"),
        }
    }

    /// 安装目录布局（第 3.2 节）：`<exe 目录>/resources/{runtime,agent-core}`。
    pub(crate) fn installed(exe_dir: &Path) -> Self {
        let resources = exe_dir.join("resources");
        Self::new(&resources.join("runtime"), &resources.join("agent-core"))
    }

    /// 开发模式布局：`pnpm build:core` 与 `pnpm build:extensions` 产出的仓库 `dist/{runtime,agent-core}`。
    /// `dist/runtime` 只含 Windows 运行时，其他平台的开发构建改用 PATH 中的 `node`。
    pub(crate) fn dev(repo_root: &Path) -> Self {
        let dist = repo_root.join("dist");
        let mut layout = Self::new(&dist.join("runtime"), &dist.join("agent-core"));
        if !cfg!(windows) {
            layout.node = PathBuf::from(NODE_EXE);
        }
        layout
    }

    /// 按构建模式选择布局（与 `paths` 的数据目录规则一致：debug 构建视为开发模式）。
    pub(crate) fn resolve(dev_mode: bool, exe_dir: &Path, repo_root: &Path) -> Self {
        if dev_mode {
            Self::dev(repo_root)
        } else {
            Self::installed(exe_dir)
        }
    }

    /// 优先使用用户电脑上已安装的 Node（PATH 中第一个版本满足 Core 要求的），没有时保留内置运行时。
    pub(crate) fn prefer_system_node(mut self) -> Self {
        if let Some(node) = find_system_node(std::env::var_os("PATH").as_deref()) {
            self.node = node;
        }
        self
    }

    /// 检查运行文件是否齐全（`node` 为裸命令名时交给 PATH 查找，不检查）。
    pub(crate) fn check(&self) -> Result<(), SupervisorError> {
        let node_is_bare = self.node.parent().is_none_or(|p| p.as_os_str().is_empty());
        let mut required: Vec<&Path> = vec![&self.entry, &self.extension];
        if !node_is_bare {
            required.insert(0, &self.node);
        }
        match required.into_iter().find(|p| !p.is_file()) {
            Some(missing) if missing == self.node => {
                Err(SupervisorError::NodeNotFound(missing.to_path_buf()))
            }
            Some(missing) => Err(SupervisorError::MissingFile(missing.to_path_buf())),
            None => Ok(()),
        }
    }
}

/// 在 PATH 中查找版本满足 Core 要求的 Node，返回其绝对路径。只看绝对路径的目录，
/// 避免当前目录下的同名程序被当成 Node 执行。
pub(crate) fn find_system_node(path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(NODE_EXE))
        .filter(|node| node.is_file())
        .find(|node| node_version(node).is_some_and(|v| v >= MIN_NODE_VERSION))
}

/// 运行 `node --version` 取版本号；无法运行或输出无法解析时为 None。
fn node_version(node: &Path) -> Option<(u32, u32, u32)> {
    let mut cmd = Command::new(node);
    cmd.arg("--version")
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&out.stdout))
}

/// 解析 `v24.22.1` 形式的版本号（忽略预发布后缀）。
pub(crate) fn parse_node_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().strip_prefix('v')?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?;
    let digits: String = patch.chars().take_while(char::is_ascii_digit).collect();
    Some((major, minor, digits.parse().ok()?))
}

/// 一次 Core 启动的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LaunchOptions {
    /// 工作目录：用户选择的项目目录
    pub(crate) cwd: PathBuf,
    /// 恢复的会话文件；新会话为 None
    pub(crate) session_file: Option<PathBuf>,
    /// 没有会话文件时指定的会话 ID（`--session-id`，不存在则以此 ID 新建）：新会话由薄壳先定好 ID，
    /// 重启时用同一 ID 恢复到 Core 已写下的会话文件。与 `session_file` 同时给出时以文件为准（Core 不允许两者同用）
    pub(crate) session_id: Option<String>,
    /// 项目已信任时为 true（`--approve`），否则 `--no-approve`（第 17.2 节）
    pub(crate) approve: bool,
    /// 用户开启了离线模式
    pub(crate) offline: bool,
    /// 用户开启了遥测（默认关闭）
    pub(crate) telemetry: bool,
}

/// 监管错误。
#[derive(Debug)]
pub(crate) enum SupervisorError {
    /// Core 运行文件缺失（安装损坏，或开发模式下未运行 `pnpm build:core` / `pnpm build:extensions`）
    MissingFile(PathBuf),
    /// 电脑上没有可用的 Node（未安装或版本过低），内置运行时也不存在（开发模式下未运行 `pnpm build:core`）
    NodeNotFound(PathBuf),
    /// 该会话已有运行中的 Core 进程
    AlreadyRunning(String),
    /// 1 分钟内已崩溃 3 次，不再自动重启
    CrashLoop(String),
    /// 已达进程上限且其他进程都在运行一轮，没有可淘汰的空闲进程
    LimitReached(usize),
    /// 拉起、放入作业或读写进程失败
    Io(io::Error),
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingFile(p) => write!(f, "内核文件缺失：{}", p.display()),
            Self::NodeNotFound(p) => write!(
                f,
                "未找到 Node.js：请安装 Node {}.{}.{} 或更高版本，或提供内置运行时 {}",
                MIN_NODE_VERSION.0,
                MIN_NODE_VERSION.1,
                MIN_NODE_VERSION.2,
                p.display()
            ),
            Self::AlreadyRunning(key) => write!(f, "会话 {key} 的内核进程已在运行"),
            Self::CrashLoop(key) => {
                write!(
                    f,
                    "会话 {key} 的内核 1 分钟内连续崩溃 {CRASH_LIMIT} 次，已停止自动重启"
                )
            }
            Self::LimitReached(max) => write!(
                f,
                "同时运行的内核已达上限（{max} 个）且都在工作，请等其中一个结束或在设置中调高上限"
            ),
            Self::Io(e) => write!(f, "内核进程操作失败：{e}"),
        }
    }
}

impl std::error::Error for SupervisorError {}

impl From<io::Error> for SupervisorError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 构造 Core 启动命令（不拉起）。
pub(crate) fn build_command(
    layout: &CoreLayout,
    paths: &DataPaths,
    opts: &LaunchOptions,
) -> Command {
    let mut cmd = Command::new(&layout.node);
    cmd.arg(&layout.entry);
    if let Some(session) = &opts.session_file {
        cmd.arg("--session").arg(session);
    } else if let Some(id) = &opts.session_id {
        cmd.arg("--session-id").arg(id);
    }
    cmd.arg(if opts.approve {
        "--approve"
    } else {
        "--no-approve"
    });
    cmd.arg("-e").arg(&layout.extension);
    cmd.current_dir(&opts.cwd);

    let tmp = paths.tmp_dir();
    cmd.env("PRIMUS_CODING_AGENT_DIR", paths.core_dir())
        .env("PRIMUS_CODING_AGENT_SESSION_DIR", paths.sessions_dir())
        .env("TEMP", &tmp)
        .env("TMP", &tmp)
        .env("PRIMUS_SKIP_VERSION_CHECK", "1")
        .env("PRIMUS_TELEMETRY", if opts.telemetry { "1" } else { "0" })
        .env_remove("NODE_OPTIONS");
    if opts.offline {
        cmd.env("PRIMUS_OFFLINE", "1");
    } else {
        cmd.env_remove("PRIMUS_OFFLINE");
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        // node.exe 是控制台程序：不弹黑框
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 最近若干行 stderr（线程安全，读取线程写入、界面读取）。
#[derive(Debug, Clone)]
pub(crate) struct StderrTail {
    lines: Arc<Mutex<VecDeque<String>>>,
    capacity: usize,
}

impl StderrTail {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity,
        }
    }

    fn guard(&self) -> MutexGuard<'_, VecDeque<String>> {
        // 读取线程 panic 也不应让界面拿不到已收集的行
        self.lines.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn push(&self, line: String) {
        let mut lines = self.guard();
        if lines.len() == self.capacity {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// 按时间顺序返回保留的行。
    pub(crate) fn lines(&self) -> Vec<String> {
        self.guard().iter().cloned().collect()
    }
}

/// stderr 读取线程。
struct StderrReader {
    handle: JoinHandle<()>,
    /// 线程结束时发送端随之释放，`recv_timeout` 立即返回 Disconnected
    done: Receiver<()>,
}

impl StderrReader {
    /// 最多等待 `timeout` 让线程读完剩余输出；超时则不再等待
    /// （Core 的后代进程可能继承了 stderr 写端，管道迟迟不关闭）。
    fn finish(self, timeout: Duration) {
        match self.done.recv_timeout(timeout) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                let _ = self.handle.join();
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// 后台读取 stderr：只按 LF 分行（去行尾 `\r`，非法 UTF-8 按替换字符处理），写日志并保留尾部。
fn spawn_stderr_reader(
    stderr: ChildStderr,
    tail: StderrTail,
    mut log: Option<File>,
) -> io::Result<StderrReader> {
    let (done_tx, done) = mpsc::channel::<()>();
    let handle = std::thread::Builder::new()
        .name("core-stderr".into())
        .spawn(move || {
            let _done = done_tx;
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let line = buf.strip_suffix(b"\n").unwrap_or(&buf);
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                let text = String::from_utf8_lossy(line).into_owned();
                if let Some(file) = log.as_mut() {
                    // 日志写失败不影响进程运行，丢弃后续日志写入
                    if writeln!(file, "{text}").is_err() {
                        log = None;
                    }
                }
                tail.push(text);
            }
        })?;
    Ok(StderrReader { handle, done })
}

/// UTC 日期 `YYYYMMDD`（日志文件名用；日志模块落地后统一按天滚动与清理）。
pub(crate) fn utc_date_stamp(now: SystemTime) -> String {
    let days = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}")
}

/// 会话标识转成安全的文件名片段。
fn sanitize_key(key: &str) -> String {
    let s: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if s.is_empty() { "core".into() } else { s }
}

/// 一个运行中的 Core 进程。
pub(crate) struct CoreProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    tail: StderrTail,
    stderr_reader: Option<StderrReader>,
    /// 本进程独占的作业：结束时连同子孙进程一起结束
    job: Job,
    last_used: Instant,
}

impl CoreProcess {
    pub(crate) fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 交给 rpc_bridge 的写端（只能取一次）。
    pub(crate) fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.stdin.take()
    }

    /// 交给 rpc_bridge 的读端（只能取一次）。
    pub(crate) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    /// 最近的 stderr 行。
    pub(crate) fn stderr_tail(&self) -> Vec<String> {
        self.tail.lines()
    }

    /// 标记一次活动（rpc_bridge 收发记录时调用），用于空闲回收与最久未使用淘汰。
    pub(crate) fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    pub(crate) fn idle_for(&self) -> Duration {
        self.last_used.elapsed()
    }

    /// 进程是否已退出（不阻塞）。
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// 有时限地等待 stderr 读取线程收尾。
    fn drain_stderr(&mut self) {
        if let Some(reader) = self.stderr_reader.take() {
            reader.finish(STDERR_DRAIN_TIMEOUT);
        }
    }

    /// 结束进程及其子孙进程并回收，返回最近的 stderr。不要在持有监管器锁时调用。
    pub(crate) fn kill(mut self) -> Vec<String> {
        self.stdin.take();
        let _ = self.job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.drain_stderr();
        self.tail.lines()
    }
}

/// 拉起时腾出的进程：因上限被淘汰的，以及已自行退出、被移出表的。drop 时结束（不要在持有监管器锁时 drop）。
#[derive(Default)]
pub(crate) struct Evicted {
    evicted: Vec<(String, CoreProcess)>,
    exited: Vec<(String, CoreProcess)>,
}

impl Evicted {
    /// 进程已不在表里的会话：因进程上限被淘汰的，以及已自行退出、被清理的。
    /// 调用方据此把它们标为未运行（发送得到 NotRunning，重启可恢复）。
    pub(crate) fn keys(&self) -> Vec<String> {
        self.evicted
            .iter()
            .chain(&self.exited)
            .map(|(k, _)| k.clone())
            .collect()
    }

    fn append(&mut self, mut other: Evicted) {
        self.evicted.append(&mut other.evicted);
        self.exited.append(&mut other.exited);
    }
}

impl Drop for Evicted {
    fn drop(&mut self) {
        for (_, process) in self.evicted.drain(..).chain(self.exited.drain(..)) {
            process.kill();
        }
    }
}

/// 拉起前预留的名额（[`Supervisor::reserve`]）：占着名额直到 [`Reservation::commit`]；未提交即 drop 时归还。
/// 进程创建（[`Reservation::launch`]）不持任何锁，其他会话的发送、关闭不必等它。
pub(crate) struct Reservation<'a> {
    supervisor: &'a Supervisor,
    key: String,
    committed: bool,
}

impl Reservation<'_> {
    /// 创建 Core 进程（不持锁）；失败时 drop 预留即归还名额，不影响其他会话。
    pub(crate) fn launch(&self, opts: &LaunchOptions) -> Result<CoreProcess, SupervisorError> {
        self.supervisor.launch(&self.key, opts)
    }

    /// 登记新进程，超出上限时淘汰最久未使用的空闲进程（`is_busy` 在监管器锁内求值，调用方让它与
    /// “进入忙碌”持同一把锁）。预留之后若空闲会话转为忙碌、腾不出位置，不结束正在工作的会话，
    /// 而是拒绝新进程（[`Rejected`]，drop 时结束新进程；不要在持锁时 drop）：进程数始终不超过上限（第 2.2 节）。
    pub(crate) fn commit(
        mut self,
        process: CoreProcess,
        is_busy: impl Fn(&str) -> bool,
    ) -> Result<(u32, Evicted), Rejected> {
        self.committed = true;
        let key = self.key.as_str();
        let max = self.supervisor.max_processes();
        let mut state = self.supervisor.state();
        state.starting.remove(key);
        let excess = (state.procs.len() + 1).saturating_sub(max);
        let mut idle: Vec<(String, Duration)> = state
            .procs
            .iter()
            .filter(|(k, _)| !is_busy(k))
            .map(|(k, p)| (k.clone(), p.idle_for()))
            .collect();
        if idle.len() < excess {
            return Err(Rejected {
                max,
                process: Some(Box::new(process)),
            });
        }
        // 最久未使用的先淘汰
        idle.sort_by_key(|(_, idle_for)| std::cmp::Reverse(*idle_for));
        let mut evicted = Evicted::default();
        for (lru, _) in idle.into_iter().take(excess) {
            if let Some(process) = state.procs.remove(&lru) {
                evicted.evicted.push((lru, process));
            }
        }
        let pid = process.pid();
        state.procs.insert(key.to_owned(), process);
        Ok((pid, evicted))
    }
}

/// 登记被拒绝：进程都在工作、腾不出位置（[`Reservation::commit`]）。带着新创建的进程，drop 时结束它
/// （不要在持锁时 drop）；转换成 [`SupervisorError::LimitReached`] 时同样结束。
pub(crate) struct Rejected {
    max: usize,
    /// 装箱：Windows 上 `CoreProcess` 带作业对象等句柄，体积大，避免 `Result` 的错误类型过大
    process: Option<Box<CoreProcess>>,
}

impl Drop for Rejected {
    fn drop(&mut self) {
        if let Some(process) = self.process.take() {
            (*process).kill();
        }
    }
}

impl From<Rejected> for SupervisorError {
    fn from(rejected: Rejected) -> Self {
        Self::LimitReached(rejected.max)
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.supervisor.state().starting.remove(&self.key);
        }
    }
}

/// 崩溃计数：窗口内达到上限即不再自动重启（第 5.5 节）。
#[derive(Debug, Clone)]
pub(crate) struct CrashTracker {
    window: Duration,
    limit: usize,
    history: VecDeque<Instant>,
}

impl Default for CrashTracker {
    fn default() -> Self {
        Self::new(CRASH_WINDOW, CRASH_LIMIT)
    }
}

impl CrashTracker {
    pub(crate) fn new(window: Duration, limit: usize) -> Self {
        Self {
            window,
            limit,
            history: VecDeque::new(),
        }
    }

    fn prune(&mut self, now: Instant) {
        while let Some(&first) = self.history.front() {
            if now.saturating_duration_since(first) >= self.window {
                self.history.pop_front();
            } else {
                break;
            }
        }
    }

    /// 记录一次崩溃。
    pub(crate) fn record(&mut self, now: Instant) {
        self.prune(now);
        self.history.push_back(now);
    }

    /// 是否还允许自动重启。
    pub(crate) fn allows_restart(&mut self, now: Instant) -> bool {
        self.prune(now);
        self.history.len() < self.limit
    }
}

/// 一个已退出的 Core 进程（由 [`Supervisor::reap_exited`] 返回）。
#[derive(Debug)]
pub(crate) struct ExitedCore {
    pub(crate) key: String,
    pub(crate) status: ExitStatus,
    pub(crate) stderr_tail: Vec<String>,
    /// 是否还允许自动重启（1 分钟内第 3 次崩溃后为 false）
    pub(crate) restart_allowed: bool,
}

struct State {
    procs: HashMap<String, CoreProcess>,
    crashes: HashMap<String, CrashTracker>,
    /// 已预留名额、正在创建进程的会话（占名额，不可淘汰）
    starting: HashSet<String>,
}

/// Core 进程池。
pub(crate) struct Supervisor {
    layout: CoreLayout,
    paths: DataPaths,
    max_processes: Mutex<usize>,
    state: Mutex<State>,
}

impl Supervisor {
    pub(crate) fn new(layout: CoreLayout, paths: DataPaths) -> io::Result<Self> {
        // 启动时探测一次作业对象可用，失败则不让 App 带着无法回收的 Core 运行
        Job::new()?;
        Ok(Self {
            layout,
            paths,
            max_processes: Mutex::new(DEFAULT_MAX_PROCESSES),
            state: Mutex::new(State {
                procs: HashMap::new(),
                crashes: HashMap::new(),
                starting: HashSet::new(),
            }),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 设置进程上限（夹到 1–8）。
    pub(crate) fn set_max_processes(&self, max: usize) {
        let max = max.clamp(*MAX_PROCESSES_RANGE.start(), *MAX_PROCESSES_RANGE.end());
        *self
            .max_processes
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = max;
    }

    pub(crate) fn max_processes(&self) -> usize {
        *self
            .max_processes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 为会话 `key` 拉起 Core。成功后若超出上限，结束最久未使用的其他进程；该会话 1 分钟内已崩溃 3 次时拒绝。
    pub(crate) fn spawn(&self, key: &str, opts: &LaunchOptions) -> Result<u32, SupervisorError> {
        self.spawn_evicting(key, opts, &[], |_| {})
    }

    /// 同 [`Supervisor::spawn`]，超出上限时只淘汰不在 `busy` 中的（空闲）进程，没有可淘汰的就拒绝拉起（第 2.2 节）。
    /// 要结束的会话先交给 `before_kill`（锁外、结束进程之前），调用方据此先把它们标为未运行，再结束进程。
    pub(crate) fn spawn_evicting(
        &self,
        key: &str,
        opts: &LaunchOptions,
        busy: &[String],
        before_kill: impl FnOnce(&[String]),
    ) -> Result<u32, SupervisorError> {
        let (pid, evicted) = self.spawn_with(key, opts, |k| busy.iter().any(|b| b == k))?;
        before_kill(&evicted.keys());
        Ok(pid)
    }

    /// 拉起会话的 Core：[`Supervisor::reserve`] → [`Reservation::launch`] → [`Reservation::commit`] 一次做完。
    /// 返回被淘汰与已退出的进程（在 drop 时结束，调用方在锁外 drop）。
    pub(crate) fn spawn_with(
        &self,
        key: &str,
        opts: &LaunchOptions,
        is_busy: impl Fn(&str) -> bool,
    ) -> Result<(u32, Evicted), SupervisorError> {
        let mut evicted = Evicted::default();
        let reservation = self.reserve(key, &is_busy, &mut evicted)?;
        let process = reservation.launch(opts)?;
        let (pid, more) = reservation.commit(process, &is_busy)?;
        evicted.append(more);
        Ok((pid, evicted))
    }

    /// 为会话预留名额（监管器锁内，不创建进程）：先移出已自行退出的进程（计一次崩溃、不占名额），
    /// 检查崩溃上限，再确认放得下——其他进程中空闲（`is_busy` 为假）的个数足以腾出位置，否则拒绝（第 2.2 节）。
    /// 预留中的会话占名额且不可淘汰。已退出的进程放进 `exited`（拒绝时也放）：调用方把这些会话标为未运行，在锁外 drop。
    pub(crate) fn reserve(
        &self,
        key: &str,
        is_busy: impl Fn(&str) -> bool,
        exited: &mut Evicted,
    ) -> Result<Reservation<'_>, SupervisorError> {
        self.layout.check()?;
        let max = self.max_processes();
        let mut state = self.state();
        if state.procs.contains_key(key) || state.starting.contains(key) {
            return Err(SupervisorError::AlreadyRunning(key.to_owned()));
        }
        let now = Instant::now();
        let gone: Vec<String> = state
            .procs
            .iter_mut()
            .filter_map(|(k, p)| matches!(p.try_wait(), Ok(Some(_))).then(|| k.clone()))
            .collect();
        for k in gone {
            if let Some(process) = state.procs.remove(&k) {
                state.crashes.entry(k.clone()).or_default().record(now);
                exited.exited.push((k, process));
            }
        }
        if let Some(tracker) = state.crashes.get_mut(key)
            && !tracker.allows_restart(now)
        {
            return Err(SupervisorError::CrashLoop(key.to_owned()));
        }
        let idle = state.procs.keys().filter(|k| !is_busy(k)).count();
        if state.procs.len() + state.starting.len() + 1 > max + idle {
            return Err(SupervisorError::LimitReached(max));
        }
        state.starting.insert(key.to_owned());
        Ok(Reservation {
            supervisor: self,
            key: key.to_owned(),
            committed: false,
        })
    }

    fn launch(&self, key: &str, opts: &LaunchOptions) -> Result<CoreProcess, SupervisorError> {
        let job = Job::new()?;
        let mut cmd = build_command(&self.layout, &self.paths, opts);
        // 作业名传给 Core：`Primus.exe --secret` 据此确认调用方在本 App 的作业内（第 9.4 节）
        cmd.env(crate::job::JOB_NAME_ENV, job.name());
        let mut child = cmd.spawn()?;
        if let Err(e) = job.assign(&child) {
            // 不在作业里的 Core 主进程崩溃时会残留，宁可不启动
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.into());
        }
        let tail = StderrTail::new(STDERR_TAIL_LINES);
        let log = self.open_stderr_log(key);
        let stderr_reader = match child.stderr.take() {
            Some(stderr) => Some(spawn_stderr_reader(stderr, tail.clone(), log)?),
            None => None,
        };
        Ok(CoreProcess {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            child,
            tail,
            stderr_reader,
            job,
            last_used: Instant::now(),
        })
    }

    /// `data/shared/logs/core-<会话>-<日期>.log`（第 19.1 节）；打不开时只保留内存中的尾部。
    fn open_stderr_log(&self, key: &str) -> Option<File> {
        let dir = self.paths.logs_dir();
        let name = format!(
            "core-{}-{}.log",
            sanitize_key(key),
            utc_date_stamp(SystemTime::now())
        );
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))
            .ok()
    }

    /// 对会话的进程执行操作（rpc_bridge 取管道、标记活动等）。
    pub(crate) fn with_process<R>(
        &self,
        key: &str,
        f: impl FnOnce(&mut CoreProcess) -> R,
    ) -> Option<R> {
        self.state().procs.get_mut(key).map(f)
    }

    pub(crate) fn running_keys(&self) -> Vec<String> {
        self.state().procs.keys().cloned().collect()
    }

    /// 结束会话的进程（用户关闭会话、退出 App、重新连接前），返回最近的 stderr。不计入崩溃次数。
    pub(crate) fn stop(&self, key: &str) -> Option<Vec<String>> {
        let process = self.state().procs.remove(key)?;
        Some(process.kill())
    }

    /// 重启（重新连接）前结束会话的进程。进程已自行退出时按崩溃计数（第 5.5 节），
    /// 之后的 [`Supervisor::spawn`] 因而同样受“1 分钟内 3 次”的限制；返回退出状态（仍在运行则为 None）。
    pub(crate) fn stop_for_restart(&self, key: &str) -> Option<ExitStatus> {
        let (process, exited) = {
            let mut state = self.state();
            let mut process = state.procs.remove(key)?;
            let exited = process.try_wait().ok().flatten();
            if exited.is_some() {
                state
                    .crashes
                    .entry(key.to_owned())
                    .or_default()
                    .record(Instant::now());
            }
            (process, exited)
        };
        process.kill();
        exited
    }

    /// 收集意外退出的进程并计入崩溃次数；调用方据此在时间线标记“内核已退出”。
    pub(crate) fn reap_exited(&self) -> Vec<ExitedCore> {
        let mut collected = Vec::new();
        {
            let mut state = self.state();
            let keys: Vec<String> = state.procs.keys().cloned().collect();
            for key in keys {
                let done = match state.procs.get_mut(&key).map(CoreProcess::try_wait) {
                    Some(Ok(Some(status))) => Some(status),
                    _ => None,
                };
                let Some(status) = done else { continue };
                let Some(process) = state.procs.remove(&key) else {
                    continue;
                };
                let now = Instant::now();
                let tracker = state.crashes.entry(key.clone()).or_default();
                tracker.record(now);
                let restart_allowed = tracker.allows_restart(now);
                collected.push((key, status, process, restart_allowed));
            }
        }
        // 锁外收尾：结束残留的子孙进程，有时限地等待 stderr 读完
        collected
            .into_iter()
            .map(|(key, status, mut process, restart_allowed)| {
                let _ = process.job.terminate();
                process.drain_stderr();
                ExitedCore {
                    key,
                    status,
                    stderr_tail: process.tail.lines(),
                    restart_allowed,
                }
            })
            .collect()
    }

    /// 结束空闲超过 `timeout` 的进程，返回被回收的会话。
    pub(crate) fn evict_idle(&self, timeout: Duration) -> Vec<String> {
        let removed: Vec<(String, CoreProcess)> = {
            let mut state = self.state();
            let idle: Vec<String> = state
                .procs
                .iter()
                .filter(|(_, p)| p.idle_for() >= timeout)
                .map(|(k, _)| k.clone())
                .collect();
            idle.into_iter()
                .filter_map(|key| state.procs.remove(&key).map(|p| (key, p)))
                .collect()
        };
        removed
            .into_iter()
            .map(|(key, process)| {
                process.kill();
                key
            })
            .collect()
    }

    /// 结束全部 Core 进程（退出 App 时）。
    pub(crate) fn shutdown(&self) {
        let procs: Vec<CoreProcess> = self.state().procs.drain().map(|(_, p)| p).collect();
        // 先结束全部作业（Core 与子孙进程立即退出），再逐个回收
        for process in &procs {
            let _ = process.job.terminate();
        }
        for process in procs {
            process.kill();
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::paths::{self, DataRoot, DataRootSource};
    use std::ffi::OsStr;
    use std::io::Read;
    use std::sync::atomic::{AtomicU32, Ordering};

    pub(crate) struct TempDir(pub(crate) PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!(
                "primus-supervisor-{}-{nanos}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn data_paths(root: &Path) -> DataPaths {
        let user = crate::platform::current_user_id().unwrap();
        paths::prepare_at(
            DataRoot {
                path: root.join("data"),
                source: DataRootSource::CommandLine,
            },
            &user,
        )
        .unwrap()
    }

    /// 用 PATH 中的 node 运行一个测试脚本充当 Core 入口。
    pub(crate) fn fake_layout(root: &Path, script: &str) -> CoreLayout {
        let core = root.join("agent-core");
        std::fs::create_dir_all(core.join("extensions")).unwrap();
        std::fs::write(core.join("rpc-entry.js"), script).unwrap();
        std::fs::write(core.join("extensions").join("primus-bundle.js"), "").unwrap();
        CoreLayout {
            node: PathBuf::from("node"),
            entry: core.join("rpc-entry.js"),
            extension: core.join("extensions").join("primus-bundle.js"),
        }
    }

    fn opts(cwd: &Path) -> LaunchOptions {
        LaunchOptions {
            cwd: cwd.to_path_buf(),
            session_file: None,
            session_id: None,
            approve: false,
            offline: false,
            telemetry: false,
        }
    }

    fn has_arg(cmd: &Command, arg: &str) -> bool {
        cmd.get_args().any(|a| a == OsStr::new(arg))
    }

    fn env_of(cmd: &Command, name: &str) -> Option<Option<String>> {
        cmd.get_envs()
            .find(|(k, _)| *k == OsStr::new(name))
            .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn layouts() {
        let installed = CoreLayout::installed(Path::new("/opt/Primus"));
        assert_eq!(
            installed.node,
            Path::new("/opt/Primus/resources/runtime").join(NODE_EXE)
        );
        assert_eq!(
            installed.entry,
            Path::new("/opt/Primus/resources/agent-core/rpc-entry.js")
        );
        assert_eq!(
            installed.extension,
            Path::new("/opt/Primus/resources/agent-core/extensions/primus-bundle.js")
        );

        let dev = CoreLayout::dev(Path::new("/repo"));
        assert_eq!(dev.entry, Path::new("/repo/dist/agent-core/rpc-entry.js"));
        if cfg!(windows) {
            assert_eq!(dev.node, Path::new("/repo/dist/runtime/node.exe"));
        } else {
            assert_eq!(dev.node, Path::new("node"));
        }

        assert_eq!(
            CoreLayout::resolve(false, Path::new("/opt/Primus"), Path::new("/repo")),
            installed
        );
        assert_eq!(
            CoreLayout::resolve(true, Path::new("/opt/Primus"), Path::new("/repo")),
            dev
        );
    }

    #[test]
    fn node_version_parsing() {
        assert_eq!(parse_node_version("v24.22.1\n"), Some((24, 22, 1)));
        assert_eq!(parse_node_version("v25.0.0-nightly2026"), Some((25, 0, 0)));
        assert_eq!(parse_node_version("24.22.1"), None);
        assert_eq!(parse_node_version("v24"), None);
        assert!((22, 18, 9) < MIN_NODE_VERSION && (22, 19, 0) >= MIN_NODE_VERSION);
    }

    #[test]
    fn find_system_node_skips_relative_and_missing_dirs() {
        let tmp = TempDir::new();
        let path = std::env::join_paths([Path::new("relative-dir"), &tmp.0]).unwrap();
        assert_eq!(find_system_node(Some(path.as_os_str())), None);
        assert_eq!(find_system_node(None), None);
    }

    #[test]
    fn check_reports_missing_files() {
        let tmp = TempDir::new();
        let layout = CoreLayout::installed(&tmp.0);
        assert!(
            matches!(layout.check(), Err(SupervisorError::NodeNotFound(p)) if p == layout.node)
        );
        let fake = fake_layout(&tmp.0, "");
        assert!(fake.check().is_ok(), "裸命令名 node 交给 PATH 查找");
    }

    #[test]
    fn command_args_and_environment() {
        let tmp = TempDir::new();
        let paths = data_paths(&tmp.0);
        let layout = fake_layout(&tmp.0, "");
        let mut o = opts(&tmp.0);
        o.session_file = Some(tmp.0.join("s.jsonl"));
        o.session_id = Some("ignored".into());
        o.approve = true;
        o.offline = true;
        let cmd = build_command(&layout, &paths, &o);

        let args: Vec<_> = cmd.get_args().map(|a| a.to_owned()).collect();
        assert_eq!(args[0], layout.entry.as_os_str());
        assert_eq!(args[1], "--session");
        assert_eq!(args[2], tmp.0.join("s.jsonl").as_os_str());
        assert_eq!(args[3], "--approve");
        assert_eq!(args[4], "-e");
        assert_eq!(args[5], layout.extension.as_os_str());
        assert_eq!(cmd.get_current_dir(), Some(tmp.0.as_path()));

        let core = paths.core_dir().to_string_lossy().into_owned();
        let sessions = paths.sessions_dir().to_string_lossy().into_owned();
        let tmpdir = paths.tmp_dir().to_string_lossy().into_owned();
        assert_eq!(env_of(&cmd, "PRIMUS_CODING_AGENT_DIR"), Some(Some(core)));
        assert_eq!(
            env_of(&cmd, "PRIMUS_CODING_AGENT_SESSION_DIR"),
            Some(Some(sessions))
        );
        assert_eq!(env_of(&cmd, "TEMP"), Some(Some(tmpdir.clone())));
        assert_eq!(env_of(&cmd, "TMP"), Some(Some(tmpdir)));
        assert_eq!(
            env_of(&cmd, "PRIMUS_SKIP_VERSION_CHECK"),
            Some(Some("1".into()))
        );
        assert_eq!(env_of(&cmd, "PRIMUS_TELEMETRY"), Some(Some("0".into())));
        assert_eq!(env_of(&cmd, "PRIMUS_OFFLINE"), Some(Some("1".into())));
        assert_eq!(
            env_of(&cmd, "NODE_OPTIONS"),
            Some(None),
            "NODE_OPTIONS 应被清除"
        );

        o.approve = false;
        o.offline = false;
        o.session_file = None;
        let cmd = build_command(&layout, &paths, &o);
        assert!(has_arg(&cmd, "--no-approve"));
        assert!(!has_arg(&cmd, "--session"));
        assert_eq!(env_of(&cmd, "PRIMUS_OFFLINE"), Some(None));

        // 没有会话文件时用会话 ID：新会话与重启恢复用同一个 ID
        o.session_id = Some("primus-1".into());
        let cmd = build_command(&layout, &paths, &o);
        let args: Vec<_> = cmd.get_args().map(|a| a.to_owned()).collect();
        assert_eq!(args[1], "--session-id");
        assert_eq!(args[2], "primus-1");
        assert!(!has_arg(&cmd, "--session"));
    }

    /// 打印 Core 关心的环境变量与参数，向 stderr 写 3 行（含 CRLF 与非法 UTF-8 之外的普通文本），然后退出。
    const ENV_DUMP: &str = r#"
const keys = ["PRIMUS_CODING_AGENT_DIR", "PRIMUS_CODING_AGENT_SESSION_DIR", "TEMP", "TMP",
  "PRIMUS_SKIP_VERSION_CHECK", "PRIMUS_TELEMETRY", "NODE_OPTIONS"];
const out = {};
for (const k of keys) out[k] = process.env[k] ?? null;
out.argv = process.argv.slice(2);
out.cwd = process.cwd();
process.stdout.write(JSON.stringify(out) + "\n");
process.stderr.write("line one\nline two\r\nline three\n");
"#;

    #[test]
    fn spawned_core_sees_redirected_environment_and_stderr_is_collected() {
        let tmp = TempDir::new();
        let paths = data_paths(&tmp.0);
        let layout = fake_layout(&tmp.0, ENV_DUMP);
        let supervisor = Supervisor::new(layout, paths.clone()).unwrap();

        supervisor
            .spawn("s-1", &opts(&tmp.0))
            .expect("需要 PATH 中有 node");
        let mut stdout = supervisor
            .with_process("s-1", CoreProcess::take_stdout)
            .flatten()
            .unwrap();
        assert!(
            supervisor
                .with_process("s-1", CoreProcess::take_stdin)
                .flatten()
                .is_some(),
            "stdin 交给 rpc_bridge"
        );
        let mut text = String::new();
        stdout.read_to_string(&mut text).unwrap();
        let out: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        let s = |k: &str| out[k].as_str().map(str::to_owned);
        assert_eq!(
            s("PRIMUS_CODING_AGENT_DIR"),
            Some(paths.core_dir().to_string_lossy().into_owned())
        );
        assert_eq!(
            s("PRIMUS_CODING_AGENT_SESSION_DIR"),
            Some(paths.sessions_dir().to_string_lossy().into_owned())
        );
        assert_eq!(
            s("TEMP"),
            Some(paths.tmp_dir().to_string_lossy().into_owned())
        );
        assert_eq!(s("PRIMUS_SKIP_VERSION_CHECK").as_deref(), Some("1"));
        assert!(out["NODE_OPTIONS"].is_null());
        assert_eq!(out["argv"][0], "--no-approve");

        // 进程退出后由 reap_exited 收集：stderr 三行完整、去掉 \r，计入崩溃次数
        let deadline = Instant::now() + Duration::from_secs(10);
        let exited = loop {
            let exited = supervisor.reap_exited();
            if !exited.is_empty() || Instant::now() > deadline {
                break exited;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(exited.len(), 1);
        assert_eq!(exited[0].key, "s-1");
        assert_eq!(
            exited[0].stderr_tail,
            vec!["line one", "line two", "line three"]
        );
        assert!(exited[0].restart_allowed);
        assert!(supervisor.running_keys().is_empty());

        // stderr 同时写入日志文件
        let log = std::fs::read_dir(paths.logs_dir())
            .unwrap()
            .filter_map(Result::ok)
            .find(|e| e.file_name().to_string_lossy().starts_with("core-s-1-"))
            .expect("应生成 core-<会话>-<日期>.log");
        let content = std::fs::read_to_string(log.path()).unwrap();
        assert!(content.contains("line two\n"));
    }

    const IDLE: &str = "setInterval(() => {}, 1000);";

    #[test]
    fn spawn_rejects_duplicates_and_evicts_lru_at_limit() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(fake_layout(&tmp.0, IDLE), data_paths(&tmp.0)).unwrap();
        supervisor.set_max_processes(0);
        assert_eq!(supervisor.max_processes(), 1, "上限夹到 1–8");

        supervisor.spawn("a", &opts(&tmp.0)).unwrap();
        assert!(matches!(
            supervisor.spawn("a", &opts(&tmp.0)),
            Err(SupervisorError::AlreadyRunning(_))
        ));
        // 唯一的其他进程正在工作：不淘汰，拒绝拉起
        assert!(matches!(
            supervisor.spawn_evicting("b", &opts(&tmp.0), &["a".to_owned()], |_| {}),
            Err(SupervisorError::LimitReached(1))
        ));
        assert_eq!(supervisor.running_keys(), vec!["a".to_owned()]);

        let mut evicted = Vec::new();
        supervisor
            .spawn_evicting("b", &opts(&tmp.0), &[], |keys| {
                // 交给调用方时被淘汰的进程尚未结束
                assert!(supervisor.running_keys().contains(&"b".to_owned()));
                evicted = keys.to_vec();
            })
            .unwrap();
        assert_eq!(evicted, vec!["a".to_owned()], "交出被淘汰的会话");
        assert_eq!(supervisor.running_keys(), vec!["b".to_owned()]);

        // 拉起失败（工作目录不存在）不淘汰已有会话
        assert!(matches!(
            supervisor.spawn("c", &opts(&tmp.0.join("missing"))),
            Err(SupervisorError::Io(_))
        ));
        assert_eq!(supervisor.running_keys(), vec!["b".to_owned()]);

        assert_eq!(supervisor.stop("b").map(|t| t.len()), Some(0));
        assert!(supervisor.running_keys().is_empty());
        assert!(supervisor.stop("b").is_none());
    }

    #[test]
    fn exited_process_frees_its_slot_and_counts_as_crash() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(fake_layout(&tmp.0, IDLE), data_paths(&tmp.0)).unwrap();
        supervisor.set_max_processes(1);
        supervisor.spawn("a", &opts(&tmp.0)).unwrap();
        supervisor.with_process("a", |p| {
            p.child.kill().unwrap();
            p.child.wait().unwrap();
        });
        // 即使调用方仍把 a 当作忙碌，已退出的进程也不占名额；它的会话交给调用方标为未运行
        let mut evicted = vec!["x".to_owned()];
        supervisor
            .spawn_evicting("b", &opts(&tmp.0), &["a".to_owned()], |keys| {
                evicted = keys.to_vec();
            })
            .unwrap();
        assert_eq!(evicted, vec!["a".to_owned()]);
        assert_eq!(supervisor.running_keys(), vec!["b".to_owned()]);
        assert_eq!(
            supervisor.state().crashes.get("a").map(|t| t.history.len()),
            Some(1)
        );
        supervisor.stop("b");
    }

    /// 结束会话的 Core 并等它退出（模拟崩溃；进程仍留在表里）。
    pub(crate) fn kill_core(supervisor: &Supervisor, key: &str) {
        supervisor.with_process(key, |p| {
            p.child.kill().unwrap();
            p.child.wait().unwrap();
        });
    }

    #[test]
    fn reservation_holds_a_slot_until_committed_or_dropped() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(fake_layout(&tmp.0, IDLE), data_paths(&tmp.0)).unwrap();
        supervisor.set_max_processes(1);
        let mut gone = Evicted::default();
        let a = supervisor.reserve("a", |_| false, &mut gone).unwrap();
        // 预留中的会话占名额、不可淘汰，也不能重复预留
        assert!(matches!(
            supervisor.reserve("b", |_| false, &mut gone),
            Err(SupervisorError::LimitReached(1))
        ));
        assert!(matches!(
            supervisor.reserve("a", |_| false, &mut gone),
            Err(SupervisorError::AlreadyRunning(_))
        ));
        // 创建进程不持监管器锁：本线程持锁期间，另一线程的 launch 仍能完成
        let guard = supervisor.state();
        let (tx, rx) = mpsc::channel();
        let process = std::thread::scope(|s| {
            let handle = s.spawn(|| {
                let process = a.launch(&opts(&tmp.0));
                let _ = tx.send(());
                process
            });
            let finished = rx.recv_timeout(Duration::from_secs(10)).is_ok();
            drop(guard);
            let process = handle.join().unwrap().unwrap();
            assert!(finished, "创建进程期间不应等待监管器锁");
            process
        });
        assert!(supervisor.running_keys().is_empty());
        let (_, evicted) = a.commit(process, |_| false).ok().unwrap();
        assert!(evicted.keys().is_empty());
        assert_eq!(supervisor.running_keys(), vec!["a".to_owned()]);

        // a 忙碌时放不下；空闲时可预留，未提交即 drop 则归还名额、不淘汰 a
        assert!(matches!(
            supervisor.reserve("b", |_| true, &mut gone),
            Err(SupervisorError::LimitReached(1))
        ));
        let b = supervisor.reserve("b", |_| false, &mut gone).unwrap();
        drop(b);
        assert!(supervisor.state().starting.is_empty());
        assert_eq!(supervisor.running_keys(), vec!["a".to_owned()]);
        supervisor.stop("a");
    }

    #[test]
    fn commit_rejects_when_idle_session_turned_busy_after_reservation() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(fake_layout(&tmp.0, IDLE), data_paths(&tmp.0)).unwrap();
        supervisor.set_max_processes(1);
        let mut gone = Evicted::default();
        let a = supervisor.reserve("a", |_| false, &mut gone).unwrap();
        let process = a.launch(&opts(&tmp.0)).unwrap();
        a.commit(process, |_| false).ok().unwrap();
        // 预留 b 时 a 空闲，登记 b 时 a 已忙碌：不淘汰 a，拒绝 b 并结束其进程，不超出上限
        let b = supervisor.reserve("b", |_| false, &mut gone).unwrap();
        let process = b.launch(&opts(&tmp.0)).unwrap();
        let rejected_pid = process.pid();
        assert!(pid_alive(rejected_pid));
        let rejected = b.commit(process, |k| k == "a").err().unwrap();
        assert!(matches!(
            SupervisorError::from(rejected),
            SupervisorError::LimitReached(1)
        ));
        // 被拒绝的进程未登记，转换（drop）时已结束并回收
        assert!(!pid_alive(rejected_pid), "被拒绝的 Core 进程应已结束");
        assert_eq!(supervisor.running_keys(), vec!["a".to_owned()]);
        assert!(supervisor.state().starting.is_empty());
        // a 空闲时登记 b 则淘汰 a
        let b = supervisor.reserve("b", |_| false, &mut gone).unwrap();
        let process = b.launch(&opts(&tmp.0)).unwrap();
        let (_, evicted) = b.commit(process, |_| false).ok().unwrap();
        assert_eq!(evicted.keys(), vec!["a".to_owned()]);
        drop(evicted);
        assert_eq!(supervisor.running_keys(), vec!["b".to_owned()]);
        supervisor.stop("b");
    }

    #[test]
    fn evict_idle_kills_only_idle_processes() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(fake_layout(&tmp.0, IDLE), data_paths(&tmp.0)).unwrap();
        supervisor.spawn("old", &opts(&tmp.0)).unwrap();
        assert!(
            supervisor.evict_idle(IDLE_TIMEOUT).is_empty(),
            "默认 10 分钟内不回收"
        );
        std::thread::sleep(Duration::from_millis(600));
        supervisor.spawn("new", &opts(&tmp.0)).unwrap();
        let evicted = supervisor.evict_idle(Duration::from_millis(400));
        assert_eq!(evicted, vec!["old".to_owned()]);
        assert_eq!(supervisor.running_keys(), vec!["new".to_owned()]);
        assert_eq!(
            supervisor.with_process("new", |p| p.stderr_tail()),
            Some(Vec::new())
        );

        // 有活动的进程不被回收
        std::thread::sleep(Duration::from_millis(600));
        supervisor.with_process("new", CoreProcess::touch);
        assert!(supervisor.evict_idle(Duration::from_millis(400)).is_empty());
        supervisor.shutdown();
        assert!(supervisor.running_keys().is_empty());
    }

    #[test]
    fn crash_loop_blocks_restart() {
        let tmp = TempDir::new();
        let supervisor =
            Supervisor::new(fake_layout(&tmp.0, "process.exit(3);"), data_paths(&tmp.0)).unwrap();
        for round in 0..CRASH_LIMIT {
            supervisor.spawn("c", &opts(&tmp.0)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let exited = loop {
                let e = supervisor.reap_exited();
                if !e.is_empty() || Instant::now() > deadline {
                    break e;
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            assert_eq!(exited.len(), 1);
            assert_eq!(exited[0].status.code(), Some(3));
            assert_eq!(exited[0].restart_allowed, round + 1 < CRASH_LIMIT);
        }
        assert!(matches!(
            supervisor.spawn("c", &opts(&tmp.0)),
            Err(SupervisorError::CrashLoop(_))
        ));
    }

    #[test]
    fn stop_for_restart_counts_exited_core_as_crash() {
        let tmp = TempDir::new();
        let supervisor =
            Supervisor::new(fake_layout(&tmp.0, "process.exit(3);"), data_paths(&tmp.0)).unwrap();
        for _ in 0..CRASH_LIMIT {
            supervisor.spawn("c", &opts(&tmp.0)).unwrap();
            // 等进程自行退出（不经 reap_exited），再由“重新连接”结束
            let deadline = Instant::now() + Duration::from_secs(10);
            while supervisor
                .with_process("c", |p| p.try_wait().ok().flatten().is_none())
                .unwrap_or(false)
            {
                assert!(Instant::now() < deadline, "进程未退出");
                std::thread::sleep(Duration::from_millis(20));
            }
            let status = supervisor.stop_for_restart("c").expect("已退出");
            assert_eq!(status.code(), Some(3));
        }
        assert!(matches!(
            supervisor.spawn("c", &opts(&tmp.0)),
            Err(SupervisorError::CrashLoop(_))
        ));

        // 仍在运行的进程被重新连接结束，不算崩溃
        let idle = Supervisor::new(fake_layout(&tmp.0, IDLE), data_paths(&tmp.0)).unwrap();
        for _ in 0..=CRASH_LIMIT {
            idle.spawn("d", &opts(&tmp.0)).unwrap();
            assert!(idle.stop_for_restart("d").is_none());
        }
        assert!(idle.stop_for_restart("d").is_none());
    }

    /// 拉起一个继承 stderr 的常驻孙进程并打印其 pid；`exit` 为真时 Core 随即退出。
    fn grandchild_script(exit: bool) -> String {
        format!(
            r#"
const {{ spawn }} = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{ stdio: ["ignore", "ignore", "inherit"] }});
process.stdout.write(String(g.pid) + "\n", () => {{ if ({exit}) process.exit(0); }});
setInterval(() => {{}}, 1000);
"#
        )
    }

    fn read_pid(supervisor: &Supervisor, key: &str) -> u32 {
        let stdout = supervisor
            .with_process(key, CoreProcess::take_stdout)
            .flatten()
            .unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(stdout), &mut line).unwrap();
        line.trim().parse().expect("孙进程 pid")
    }

    /// 进程是否仍存在（Windows 用 tasklist，其他平台 `kill -0`；已回收的进程视为不存在）。
    pub(crate) fn pid_alive(pid: u32) -> bool {
        if cfg!(windows) {
            Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
                .unwrap_or(false)
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }
    }

    /// 孙进程收尾：Windows 上应已随作业结束；其他平台没有作业，测试自行清理。
    fn cleanup_grandchild(pid: u32) {
        if cfg!(windows) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if !pid_alive(pid) {
                    break;
                }
                assert!(Instant::now() < deadline, "孙进程应随 Core 的作业结束");
                std::thread::sleep(Duration::from_millis(100));
            }
        } else {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        }
    }

    #[test]
    fn stop_does_not_hang_when_grandchild_holds_stderr() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(
            fake_layout(&tmp.0, &grandchild_script(false)),
            data_paths(&tmp.0),
        )
        .unwrap();
        supervisor.spawn("g", &opts(&tmp.0)).unwrap();
        let grandchild = read_pid(&supervisor, "g");
        let started = Instant::now();
        assert!(supervisor.stop("g").is_some());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "stderr 收尾应有时限"
        );
        cleanup_grandchild(grandchild);
    }

    #[test]
    fn reap_does_not_hang_when_grandchild_holds_stderr() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(
            fake_layout(&tmp.0, &grandchild_script(true)),
            data_paths(&tmp.0),
        )
        .unwrap();
        supervisor.spawn("g", &opts(&tmp.0)).unwrap();
        let grandchild = read_pid(&supervisor, "g");
        let deadline = Instant::now() + Duration::from_secs(10);
        let exited = loop {
            let started = Instant::now();
            let e = supervisor.reap_exited();
            assert!(started.elapsed() < Duration::from_secs(5), "reap 应有时限");
            if !e.is_empty() || Instant::now() > deadline {
                break e;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(exited.len(), 1);
        // 监管器锁未被占住
        assert!(supervisor.running_keys().is_empty());
        cleanup_grandchild(grandchild);
    }

    #[test]
    fn crash_tracker_window() {
        let mut t = CrashTracker::new(Duration::from_secs(60), 3);
        let start = Instant::now();
        t.record(start);
        t.record(start + Duration::from_secs(10));
        assert!(t.allows_restart(start + Duration::from_secs(11)));
        t.record(start + Duration::from_secs(20));
        assert!(!t.allows_restart(start + Duration::from_secs(21)));
        // 第一次崩溃滑出窗口后恢复
        assert!(t.allows_restart(start + Duration::from_secs(61)));
    }

    #[test]
    fn stderr_tail_keeps_last_lines() {
        let tail = StderrTail::new(3);
        for i in 0..5 {
            tail.push(format!("l{i}"));
        }
        assert_eq!(tail.lines(), vec!["l2", "l3", "l4"]);
    }

    #[test]
    fn date_stamp_and_key_sanitizing() {
        assert_eq!(utc_date_stamp(UNIX_EPOCH), "19700101");
        // 2026-10-28T12:00:00Z
        let t = UNIX_EPOCH + Duration::from_secs(1_793_188_800);
        assert_eq!(utc_date_stamp(t), "20261028");
        // 闰日 2024-02-29T00:00:00Z
        let leap = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(utc_date_stamp(leap), "20240229");
        assert_eq!(sanitize_key("a/b\\c:d e"), "a_b_c_d_e");
        assert_eq!(sanitize_key(""), "core");
    }
}
