//! 会话表（附录 B：`session_open` / `session_close` / `core_send` / `core_restart`）：`sessionKey` → Core 进程 + RPC 桥。
//!
//! - 打开：为会话拉起一个 Core（`supervisor`），接管其 stdin/stdout 建一座桥（`rpc_bridge`），批次推给该会话的 Channel。
//!   新会话由薄壳先定好会话 ID（`--session-id`），恢复已有会话用会话文件（`--session`）。
//!   未选工作区时在 `users/<SID>/chat` 下运行（约束 C2：不落到用户主目录）。
//! - 发送：记录原样写入 stdin，薄壳不理解、不修改内容（第 5.1 节）。
//! - 重启：结束旧进程、等旧桥把剩余批次推完，再用同样的启动参数拉起新进程（同一会话 ID / 文件，Core 从会话文件恢复）；
//!   新桥的 `seq` 接着旧桥编号，前端据缺口检测与 `get_messages` 重建状态（第 7.3 节）。旧进程已自行退出的按崩溃计数，
//!   重新连接同样受“1 分钟内 3 次”限制（第 5.5 节）。重启期间会话留在表里（标记重启中）：发送得到 NotRunning，
//!   并发的重启被拒绝；期间被关闭的会话，重启完成后立即结束新进程，不放回表中。
//! - 关闭：结束进程，桥随 stdout EOF 自行收尾。
//! - 拉起新进程超出进程上限时只淘汰空闲会话（打开或重启中的会话算忙碌），腾不出位置则拒绝（LimitReached），
//!   进程数不超过上限；被淘汰的、拉起时清理掉的、以及发送时发现已自行退出的会话标为未运行，
//!   之后的发送得到 NotRunning（可重启恢复）。
//! - 拉起分三步：会话表锁内预留名额 → 不持锁创建进程（其他会话的发送、关闭不等它）→ 会话表锁内登记并淘汰。

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::paths::DataPaths;
use crate::rpc_bridge::{BatchSink, Bridge, BridgeConfig, BridgeError, CoreBatch};
use crate::supervisor::{
    CoreProcess, Evicted, LaunchOptions, Rejected, Reservation, Supervisor, SupervisorError,
};

/// Tauri 中使用的会话表：批次经每个会话自己的 Channel 推给前端。
pub(crate) type AppSessions = Sessions<tauri::ipc::Channel<CoreBatch>>;

/// 未选工作区时 Core 的工作目录（`users/<SID>` 下）。
const DEFAULT_WORKSPACE_DIR: &str = "chat";

/// 未选工作区时的默认工作目录 `users/<SID>/chat`（会话索引按它过滤“未选工作区”的会话）。
pub(crate) fn default_workspace_dir(paths: &DataPaths) -> PathBuf {
    paths.user_dir().join(DEFAULT_WORKSPACE_DIR)
}

#[derive(Debug)]
pub(crate) enum SessionError {
    /// 会话不存在（未打开或已关闭）
    NotFound(String),
    /// 工作区不是一个已存在的目录
    Workspace(PathBuf),
    /// 会话暂无进程（重启失败、因进程上限被淘汰或已自行退出），需重启内核
    NotRunning(String),
    /// 会话正在重启
    Restarting(String),
    /// 会话文件已被另一个打开中的会话使用（同一文件只能有一个 Core 写入）
    InUse(PathBuf),
    /// 会话文件正在删除（移到回收站）
    Deleting(PathBuf),
    /// 正在安装更新：不开始新的一轮、不拉起新的内核
    Updating,
    Supervisor(SupervisorError),
    Bridge(BridgeError),
    Io(io::Error),
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(key) => write!(f, "会话不存在：{key}"),
            Self::Workspace(path) => write!(f, "工作区不存在：{}", path.display()),
            Self::NotRunning(key) => write!(f, "会话的内核未运行，请重启内核：{key}"),
            Self::Restarting(key) => write!(f, "会话的内核正在重启：{key}"),
            Self::InUse(path) => write!(f, "会话已在其他标签中打开：{}", path.display()),
            Self::Deleting(path) => write!(f, "会话正在删除：{}", path.display()),
            Self::Updating => write!(f, "正在安装更新，暂时不能发送或启动会话"),
            Self::Supervisor(e) => write!(f, "{e}"),
            Self::Bridge(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<SupervisorError> for SessionError {
    fn from(e: SupervisorError) -> Self {
        Self::Supervisor(e)
    }
}

impl From<Rejected> for SessionError {
    fn from(rejected: Rejected) -> Self {
        Self::Supervisor(rejected.into())
    }
}

impl From<BridgeError> for SessionError {
    fn from(e: BridgeError) -> Self {
        Self::Bridge(e)
    }
}

impl From<io::Error> for SessionError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

struct Entry<S> {
    /// 重启中、重启失败或被淘汰时为 None：会话仍在表里，可以（再次）重启
    bridge: Option<Bridge>,
    /// 正在拉起（打开或重启中）：桥为空，发送得到 NotRunning，重启被拒绝
    restarting: bool,
    /// 进程已不在：因进程上限被结束，或已自行退出、被拉起时的清理移除（重启可恢复）
    evicted: bool,
    /// 下一座桥第一批之前的序号（重启失败时保留旧桥的最后序号）
    last_seq: u64,
    opts: LaunchOptions,
    /// 恢复的会话文件的键（`platform::file_keys`：文件系统身份与路径键，打开时算好）；新会话为空
    file_keys: Vec<String>,
    sink: S,
}

pub(crate) struct Sessions<S> {
    entries: Mutex<HashMap<String, Entry<S>>>,
    /// 正在删除（移到回收站）的会话文件的键（`platform::file_keys`）。只在持有 `entries` 锁时加入与检查（锁顺序：entries → deleting），
    /// 删除结束后单独加锁移除
    deleting: Mutex<HashSet<String>>,
    /// 正在拉起（打开或重启，从登记到 `finish_launch` 结束）的 `sessionKey`；拉起结束时通知 `launch_done`。
    /// 删除据此等待被移出会话表、但进程尚未登记到监管器的拉起结束（那时新进程已被结束），再删除文件
    launching: Mutex<HashSet<String>>,
    launch_done: Condvar,
    /// 删除等待进行中的拉起的上限（默认 [`LAUNCH_WAIT`]，测试可调小）
    launch_wait: Duration,
    /// 等待拉起超时而没有删除的文件：“删除中”登记保留到这些拉起结束（[`LaunchGuard`] 撤销），期间重试删除或打开都被拒绝。
    /// 锁顺序：launching → held_deletes；之后才单独加 deleting 锁
    held_deletes: Mutex<Vec<HeldDelete>>,
    next: AtomicU64,
    /// 正在安装更新（[`Sessions::hold_for_update`]）：只在持有 `entries` 锁时读写，
    /// 与忙碌检查、prompt 写入、会话拉起的登记互斥
    updating: AtomicBool,
    config: BridgeConfig,
}

/// 删除等待进行中的拉起结束的上限：拉起本身有超时，这里只防止意外卡死删除命令。
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

impl<S: BatchSink + Clone> Default for Sessions<S> {
    fn default() -> Self {
        Self::new(BridgeConfig::default())
    }
}

impl<S: BatchSink + Clone> Sessions<S> {
    pub(crate) fn new(config: BridgeConfig) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            deleting: Mutex::new(HashSet::new()),
            launching: Mutex::new(HashSet::new()),
            launch_done: Condvar::new(),
            launch_wait: LAUNCH_WAIT,
            held_deletes: Mutex::new(Vec::new()),
            next: AtomicU64::new(0),
            updating: AtomicBool::new(false),
            config,
        }
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry<S>>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn deleting(&self) -> MutexGuard<'_, HashSet<String>> {
        self.deleting.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn launching(&self) -> MutexGuard<'_, HashSet<String>> {
        self.launching
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 标记会话开始拉起；返回的守卫在拉起结束（含出错、panic）时撤销标记并通知等待的删除。
    /// 在持有 `entries` 锁、把条目标为拉起中时调用（锁顺序：entries → launching）
    fn begin_launch(&self, key: &str) -> LaunchGuard<'_, S> {
        self.launching().insert(key.to_owned());
        LaunchGuard {
            sessions: self,
            key: key.to_owned(),
        }
    }

    /// 等待这些会话进行中的拉起结束（最多 `launch_wait`）；超时仍未结束返回 false。
    fn wait_launches(&self, keys: &[String]) -> bool {
        let deadline = std::time::Instant::now() + self.launch_wait;
        let mut launching = self.launching();
        while keys.iter().any(|k| launching.contains(k)) {
            let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) else {
                return false;
            };
            launching = self
                .launch_done
                .wait_timeout(launching, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    /// 测试用：以未信任（`--no-approve`）打开会话。
    #[cfg(test)]
    pub(crate) fn open(
        &self,
        supervisor: &Supervisor,
        paths: &DataPaths,
        workspace: &str,
        session_file: Option<&str>,
        sink: S,
    ) -> Result<String, SessionError> {
        self.open_with_trust(supervisor, paths, workspace, session_file, false, sink)
    }

    /// 打开会话：拉起 Core 并开始推送批次，返回 `sessionKey`。
    /// `approve` 为工作区的信任状态（第 17.2 节）：true 以 `--approve` 启动，加载项目级扩展、技能和 MCP。
    pub(crate) fn open_with_trust(
        &self,
        supervisor: &Supervisor,
        paths: &DataPaths,
        workspace: &str,
        session_file: Option<&str>,
        approve: bool,
        sink: S,
    ) -> Result<String, SessionError> {
        let cwd = if workspace.trim().is_empty() {
            let dir = default_workspace_dir(paths);
            std::fs::create_dir_all(&dir)?;
            dir
        } else {
            PathBuf::from(workspace)
        };
        if !cwd.is_dir() {
            return Err(SessionError::Workspace(cwd));
        }
        let n = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let key = format!("s{n}");
        let session_file = session_file.filter(|p| !p.is_empty()).map(PathBuf::from);
        let session_id = session_file.is_none().then(|| new_session_id(n));
        // 恢复已有会话文件：按文件身份与路径（解析符号链接、`.` 段、短名）比较，并读出文件头的会话 ID——
        // 这个文件可能是某个打开中的新会话由 Core 写下的（那条登记只有会话 ID、没有会话文件）。
        // 身份查询失败时只有路径键，照常登记：之后同一文件取得身份时仍按路径键对上
        let file_keys = session_file
            .as_deref()
            .map(crate::platform::file_keys)
            .unwrap_or_default();
        let file_id = session_file.as_deref().and_then(|file| {
            crate::session_index::session_file_id(file).filter(|id| named_for_session(file, id))
        });
        let opts = LaunchOptions {
            cwd,
            session_file,
            session_id,
            approve,
            offline: false,
            telemetry: false,
        };
        // 先登记（标记启动中）再拉起：拉起期间若被其他会话的拉起淘汰，标记能落到这一条上；
        // 期间被关闭则结束新进程
        // 占用检查与登记在同一次加锁内完成，并发打开同一会话文件时只有一个能通过；正在删除的文件拒绝打开
        let _launch = {
            let mut entries = self.entries();
            if self.updating.load(Ordering::Acquire) {
                return Err(SessionError::Updating);
            }
            if let Some(file) = &opts.session_file {
                if using(&entries, &file_keys, file_id.as_deref()) {
                    return Err(SessionError::InUse(file.clone()));
                }
                let deleting = self.deleting();
                if file_keys.iter().any(|k| deleting.contains(k)) {
                    return Err(SessionError::Deleting(file.clone()));
                }
            }
            entries.insert(
                key.clone(),
                Entry {
                    bridge: None,
                    restarting: true,
                    evicted: false,
                    last_seq: 0,
                    opts: opts.clone(),
                    file_keys,
                    sink: sink.clone(),
                },
            );
            self.begin_launch(&key)
        };
        let result = self.launch(supervisor, &key, &opts, sink, 0);
        if let Err(e) = result {
            // 打开失败：撤下登记并报告拉起的原因（如 LimitReached）
            self.entries().remove(&key);
            return Err(e);
        }
        self.finish_launch(supervisor, &key, 0, result)
            .map(|()| key)
    }

    /// 把一条 RPC 记录写入会话的 Core（不阻塞）。
    pub(crate) fn send(
        &self,
        supervisor: &Supervisor,
        key: &str,
        record: &serde_json::Value,
    ) -> Result<(), SessionError> {
        let mut entries = self.entries();
        let entry = entries
            .get_mut(key)
            .ok_or_else(|| SessionError::NotFound(key.to_owned()))?;
        if entry.evicted || entry.bridge.is_none() {
            return Err(SessionError::NotRunning(key.to_owned()));
        }
        // 安装更新期间不开始新的一轮（其他命令如 abort、get_state 照常）
        if self.updating.load(Ordering::Acquire)
            && record.get("type").and_then(serde_json::Value::as_str) == Some("prompt")
        {
            return Err(SessionError::Updating);
        }
        // 进程已自行退出（尚未被清理）：标为未运行并立即报错，不写进旧桥再等前端超时。
        // 锁顺序与拉起一致：会话表 → 监管器
        let alive = supervisor
            .with_process(key, |p| {
                let alive = !matches!(p.try_wait(), Ok(Some(_)));
                if alive {
                    p.touch();
                }
                alive
            })
            .unwrap_or(false);
        if !alive {
            entry.evicted = true;
            return Err(SessionError::NotRunning(key.to_owned()));
        }
        if let Some(bridge) = &entry.bridge {
            match bridge.send(record) {
                // 写线程已结束（Core 的 stdin 已断开）：发送报告未运行，需重启恢复。进程此刻仍在，
                // 不标 evicted：evicted 只表示进程已不在，否则仍在输出回复的会话会被当作空闲淘汰、截断回复；
                // 进程退出后下次发送的 try_wait 或拉起时的清理会再标记
                Err(BridgeError::Closed) => {
                    return Err(SessionError::NotRunning(key.to_owned()));
                }
                r => r?,
            }
        }
        Ok(())
    }

    /// 测试用：是否有会话正在运行一轮（或正在打开 / 重启）。自动更新用 [`Sessions::hold_for_update`] 在同一把锁内检查并置位。
    #[cfg(test)]
    pub(crate) fn any_busy(&self) -> bool {
        let entries = self.entries();
        entries.keys().any(|key| is_busy(&entries, key))
    }

    /// 进入“安装更新”状态：在同一次加锁内检查忙碌并置位，之后的 prompt 写入与会话拉起被拒绝（[`SessionError::Updating`]），
    /// 不会有新的一轮夹在检查与停掉 Core 之间。`force` 为假且有会话忙碌时返回 None（前端确认后带 force 再来）。
    /// 返回的守卫释放时（取消 UAC、拉起失败）恢复正常。
    pub(crate) fn hold_for_update(&self, force: bool) -> Option<UpdateHold<'_, S>> {
        let entries = self.entries();
        if !force && entries.keys().any(|key| is_busy(&entries, key)) {
            return None;
        }
        self.updating.store(true, Ordering::Release);
        Some(UpdateHold { sessions: self })
    }

    /// 薄壳为新会话定好的会话 ID（`--session-id`）；恢复已有会话文件时为 None。
    pub(crate) fn session_id(&self, key: &str) -> Option<String> {
        self.entries()
            .get(key)
            .and_then(|entry| entry.opts.session_id.clone())
    }

    /// 是否有打开中的会话使用这个会话文件或会话 ID。新会话按薄壳定好的会话 ID 判断，
    /// 恢复的会话按会话文件的身份或路径判断（`platform::file_keys`）。
    #[cfg(test)]
    pub(crate) fn is_using(&self, session_file: &Path, session_id: Option<&str>) -> bool {
        let file_keys = crate::platform::file_keys(session_file);
        let session_id = session_id.filter(|id| named_for_session(session_file, id));
        using(&self.entries(), &file_keys, session_id)
    }

    /// 删除会话文件（永久删除，不进回收站）：打开中的会话不必先关闭——在同一次加锁内把使用这个会话文件或会话 ID 的
    /// 会话（同 [`Self::is_using`]）移出会话表，并把文件登记为“删除中”；然后在锁外用 `stop` 结束这些会话的 Core
    /// （结束进程要等待，不能占着会话表锁），再执行 `delete`，结束后撤销登记。登记期间打开同一文件得到 `Deleting`，
    /// 不会出现会话关闭后、文件删除前又被打开的情况。同一文件已在删除中时不执行 `delete`，返回
    /// [`DeleteRefused::AlreadyDeleting`]。
    /// 新会话按会话 ID 匹配时要求文件名是 Core 为该 ID 新建的 `<时间戳>_<会话 ID>.jsonl`（复制出的副本不算）；
    /// 移出时仍在拉起的会话，等拉起结束、新进程被结束后才执行 `delete`；等待超时则不删除文件，返回
    /// [`DeleteRefused::LaunchPending`]（文件与索引保留，可稍后重试）。
    pub(crate) fn delete_closing<T>(
        &self,
        session_file: &Path,
        session_id: Option<&str>,
        mut stop: impl FnMut(&str),
        delete: impl FnOnce() -> T,
    ) -> Result<T, DeleteRefused> {
        let file_keys = crate::platform::file_keys(session_file);
        let session_id = session_id.filter(|id| named_for_session(session_file, id));
        let closed: Vec<String> = {
            let mut entries = self.entries();
            let mut deleting = self.deleting();
            if file_keys.iter().any(|k| deleting.contains(k)) {
                // 同一文件已在删除中：不重复删除
                return Err(DeleteRefused::AlreadyDeleting);
            }
            deleting.extend(file_keys.iter().cloned());
            let keys: Vec<String> = entries
                .iter()
                .filter(|(_, e)| entry_uses(e, &file_keys, session_id))
                .map(|(k, _)| k.clone())
                .collect();
            // 桥随条目 drop：关闭写队列，读、合批线程随 stdout EOF 结束
            for k in &keys {
                entries.remove(k);
            }
            keys
        };
        let mut _release = DeletingGuard {
            sessions: self,
            keys: file_keys,
        };
        for key in &closed {
            stop(key);
        }
        // 移出会话表时正在拉起、进程尚未登记到监管器的会话，上面的 stop 结束不了：等拉起结束——
        // `register` 或 `finish_launch` 发现条目已不在，会在拉起标记撤销前结束新进程（kill 等到进程退出）。
        // 超时说明拉起卡住，Core 可能仍在运行：不删除文件，并把“删除中”登记交给这些拉起，等它们结束才撤销——
        // 否则会话已移出会话表，立即重试时没有可等待的会话，会在 Core 仍运行时删除文件
        if !self.wait_launches(&closed) {
            let launching = self.launching();
            let pending: Vec<String> = closed
                .iter()
                .filter(|k| launching.contains(*k))
                .cloned()
                .collect();
            if !pending.is_empty() {
                lock(&self.held_deletes).push(HeldDelete {
                    file_keys: std::mem::take(&mut _release.keys),
                    launches: pending,
                });
                return Err(DeleteRefused::LaunchPending);
            }
            // 超时与检查之间拉起已结束：照常删除
        }
        Ok(delete())
    }

    /// 关闭会话并结束其 Core；会话不存在时什么也不做。
    pub(crate) fn close(&self, supervisor: &Supervisor, key: &str) {
        let entry = self.entries().remove(key);
        if entry.is_some() {
            supervisor.stop(key);
        }
        // 桥在这里 drop：关闭写队列；读、合批线程随 stdout EOF 结束
    }

    /// 重启会话的 Core：同一会话 ID / 文件，`seq` 接着编号。失败时会话保留在表里，可再次重启。
    /// 测试用：重启时不重新判定信任。
    #[cfg(test)]
    pub(crate) fn restart(&self, supervisor: &Supervisor, key: &str) -> Result<(), SessionError> {
        self.restart_checked(supervisor, key, |_| true)
    }

    /// 重启会话的 Core。`still_trusted` 按工作区目录重新判定信任：原本以 `--approve` 启动、
    /// 现在已不被信任时改为 `--no-approve`（只会降级，不会升级）。
    pub(crate) fn restart_checked(
        &self,
        supervisor: &Supervisor,
        key: &str,
        still_trusted: impl FnOnce(&Path) -> bool,
    ) -> Result<(), SessionError> {
        // 取出旧桥并标记重启中；耗时的结束与拉起在锁外进行，不阻塞其他会话
        let (old, opts, sink, last_seq, _launch) = {
            let mut entries = self.entries();
            let entry = entries
                .get_mut(key)
                .ok_or_else(|| SessionError::NotFound(key.to_owned()))?;
            if entry.restarting {
                return Err(SessionError::Restarting(key.to_owned()));
            }
            if self.updating.load(Ordering::Acquire) {
                return Err(SessionError::Updating);
            }
            // 重启期间桥为空，发送照样得到 NotRunning；淘汰标记在这里清除。重启中 mark_gone 不再标记它
            // （被清理的可能是旧进程），新进程是否还在由 finish_launch 按监管器的实际状态判定
            entry.restarting = true;
            entry.evicted = false;
            (
                entry.bridge.take(),
                entry.opts.clone(),
                entry.sink.clone(),
                entry.last_seq,
                self.begin_launch(key),
            )
        };
        // 在会话表的锁外判定（读 workspaces.json 与计算指纹），之后写回登记，后续重启沿用降级后的值
        let mut opts = opts;
        if opts.approve && !still_trusted(&opts.cwd) {
            opts.approve = false;
            if let Some(entry) = self.entries().get_mut(key) {
                entry.opts.approve = false;
            }
        }
        // 旧进程已自行退出时计一次崩溃，随后的拉起受崩溃上限约束
        supervisor.stop_for_restart(key);
        // 进程（连同整个作业）已结束，stdout EOF：等旧桥把剩余记录推完再接着编号，新旧批次不交错
        let last_seq = old.map_or(last_seq, Bridge::finish);
        let result = self.launch(supervisor, key, &opts, sink, last_seq);
        self.finish_launch(supervisor, key, last_seq, result)
    }

    /// 拉起结束后放回桥：会话期间被关闭则结束新进程并返回 NotFound；失败时会话留在表里（桥为空）
    fn finish_launch(
        &self,
        supervisor: &Supervisor,
        key: &str,
        last_seq: u64,
        result: Result<Bridge, SessionError>,
    ) -> Result<(), SessionError> {
        let mut entries = self.entries();
        let Some(entry) = entries.get_mut(key) else {
            // 拉起期间会话已关闭：无论拉起成败都报告 NotFound；拉起成功的新进程在锁外结束
            drop(entries);
            if let Ok(bridge) = result {
                drop(bridge);
                supervisor.stop(key);
            }
            return Err(SessionError::NotFound(key.to_owned()));
        };
        entry.restarting = false;
        entry.last_seq = last_seq;
        let bridge = result?;
        // 登记后到这里之间新进程若已被清理（自行退出），标为未运行；否则清除拉起期间可能残留的标记
        entry.evicted = supervisor.with_process(key, |_| ()).is_none();
        entry.bridge = Some(bridge);
        Ok(())
    }

    /// 登记新创建的进程。登记前确认会话仍在（创建进程期间可能被关闭）：已关闭则不登记、不淘汰别的会话，
    /// 锁外结束新进程并返回 NotFound。登记时腾不出位置（预留后空闲会话转为忙碌）则拒绝，新进程同样在锁外结束
    /// （Rejected 的 drop）。
    fn register(
        &self,
        key: &str,
        reservation: Reservation<'_>,
        process: CoreProcess,
    ) -> Result<(), SessionError> {
        let committed = {
            let mut entries = self.entries();
            if entries.contains_key(key) {
                let committed = reservation.commit(process, |k| is_busy(&entries, k));
                if let Ok((_, evicted)) = &committed {
                    mark_gone(&mut entries, evicted);
                }
                Ok(committed)
            } else {
                Err(process)
            }
        };
        let committed = match committed {
            Ok(committed) => committed,
            Err(process) => {
                process.kill();
                return Err(SessionError::NotFound(key.to_owned()));
            }
        };
        let (_, evicted) = committed?;
        drop(evicted);
        Ok(())
    }

    fn launch(
        &self,
        supervisor: &Supervisor,
        key: &str,
        opts: &LaunchOptions,
        sink: S,
        first_seq: u64,
    ) -> Result<Bridge, SessionError> {
        // 超出上限只淘汰空闲会话：正在运行一轮、已写入 prompt 未响应、或正在打开/重启（桥尚未装入）的都算忙碌。
        // 预留名额与登记淘汰都与发送（写入 prompt 即记忙碌）持同一把会话表锁，挑中的会话之后不会再收到 prompt；
        // 进程创建在两把锁之外进行。进程已不在的会话在锁内标记（发送方随即看到 NotRunning），进程在锁外结束
        let mut gone = Evicted::default();
        let reservation = {
            let mut entries = self.entries();
            if !entries.contains_key(key) {
                return Err(SessionError::NotFound(key.to_owned()));
            }
            let reservation = supervisor.reserve(key, |k| is_busy(&entries, k), &mut gone);
            mark_gone(&mut entries, &gone);
            reservation
        };
        drop(gone);
        let reservation = reservation?;
        // 失败时预留随 drop 归还，不影响其他会话
        let process = reservation.launch(opts)?;
        self.register(key, reservation, process)?;
        let pipes = supervisor.with_process(key, |p| (p.take_stdin(), p.take_stdout()));
        let Some((Some(stdin), Some(stdout))) = pipes else {
            supervisor.stop(key);
            return Err(io::Error::other("内核进程的标准输入输出不可用").into());
        };
        let config = BridgeConfig {
            first_seq,
            ..self.config
        };
        Bridge::start(key.to_owned(), stdin, stdout, sink, config).map_err(|e| {
            supervisor.stop(key);
            e.into()
        })
    }
}

#[cfg(test)]
impl<S: BatchSink + Clone> Sessions<S> {
    /// 测试用：登记一个没有进程的会话（按会话文件或会话 ID 占用）。
    pub(crate) fn insert_idle_for_test(
        &self,
        key: &str,
        session_file: Option<&str>,
        session_id: Option<&str>,
        sink: S,
    ) {
        let opts = LaunchOptions {
            cwd: PathBuf::from("."),
            session_file: session_file.map(PathBuf::from),
            session_id: session_id.map(str::to_owned),
            approve: false,
            offline: false,
            telemetry: false,
        };
        let file_keys = session_file
            .map(|p| crate::platform::file_keys(Path::new(p)))
            .unwrap_or_default();
        self.entries.lock().unwrap().insert(
            key.to_owned(),
            Entry {
                bridge: None,
                restarting: false,
                evicted: true,
                last_seq: 0,
                opts,
                file_keys,
                sink,
            },
        );
    }
}

/// [`Sessions::delete_closing`] 没有执行删除的原因。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DeleteRefused {
    /// 同一文件已在删除中
    AlreadyDeleting,
    /// 使用这个文件的会话仍在拉起 Core，等待超时
    LaunchPending,
}

impl fmt::Display for DeleteRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyDeleting => write!(f, "会话正在删除中"),
            Self::LaunchPending => write!(f, "会话的内核仍在启动，请稍后再删除"),
        }
    }
}

/// 安装更新期间的守卫：释放时（在会话表的锁内）恢复发送与拉起。
pub(crate) struct UpdateHold<'a, S> {
    sessions: &'a Sessions<S>,
}

impl<S> Drop for UpdateHold<'_, S> {
    fn drop(&mut self) {
        let _entries = lock(&self.sessions.entries);
        self.sessions.updating.store(false, Ordering::Release);
    }
}

/// 拉起结束（含出错、panic）时撤销“拉起中”标记并通知等待的删除。
struct LaunchGuard<'a, S> {
    sessions: &'a Sessions<S>,
    key: String,
}

impl<S> Drop for LaunchGuard<'_, S> {
    fn drop(&mut self) {
        let released: Vec<String> = {
            let mut launching = lock(&self.sessions.launching);
            launching.remove(&self.key);
            let mut held = lock(&self.sessions.held_deletes);
            let mut released = Vec::new();
            held.retain_mut(|h| {
                if h.launches.iter().any(|k| launching.contains(k)) {
                    return true;
                }
                released.append(&mut h.file_keys);
                false
            });
            released
        };
        // 超时未删除的文件，相关拉起都已结束：撤销“删除中”登记，可以重试删除
        if !released.is_empty() {
            let mut deleting = lock(&self.sessions.deleting);
            for k in &released {
                deleting.remove(k);
            }
        }
        self.sessions.launch_done.notify_all();
    }
}

/// 等待拉起超时而保留“删除中”登记的文件。
struct HeldDelete {
    file_keys: Vec<String>,
    /// 还没结束的拉起（会话键）
    launches: Vec<String>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 会话文件是否是 Core 为这个会话 ID 新建的那个文件（Core 命名为 `<时间戳>_<会话 ID>.jsonl`）。
/// 新会话的登记只有会话 ID：复制出来的会话文件保留原文件头的 ID 但文件名不同，不能因此关闭或占用那个新会话。
fn named_for_session(path: &Path, session_id: &str) -> bool {
    let suffix = format!("_{session_id}.jsonl");
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.len() > suffix.len()
                && name.is_char_boundary(name.len() - suffix.len())
                && name[name.len() - suffix.len()..].eq_ignore_ascii_case(&suffix)
        })
}

/// 删除结束（含 panic）时撤销“删除中”登记。
struct DeletingGuard<'a, S> {
    sessions: &'a Sessions<S>,
    keys: Vec<String>,
}

impl<S> Drop for DeletingGuard<'_, S> {
    fn drop(&mut self) {
        let mut deleting = self
            .sessions
            .deleting
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for k in &self.keys {
            deleting.remove(k);
        }
    }
}

/// 拉起时的淘汰判断：正在工作、已写入 prompt 未响应、或正在打开/重启（桥尚未装入）的会话算忙碌，不淘汰。
fn is_busy<S>(entries: &HashMap<String, Entry<S>>, key: &str) -> bool {
    entries.get(key).is_some_and(|e| {
        !e.evicted && (e.restarting || e.bridge.as_ref().is_some_and(Bridge::is_busy))
    })
}

/// 把进程已不在的会话（被淘汰或已自行退出）标为未运行：之后的发送得到 NotRunning，重启可恢复。
/// 打开/重启中的会话跳过：被清理的可能是重启前的旧进程，新进程的状态由 finish_launch 判定。
fn mark_gone<S>(entries: &mut HashMap<String, Entry<S>>, gone: &Evicted) {
    for k in gone.keys() {
        if let Some(entry) = entries.get_mut(&k).filter(|e| !e.restarting) {
            entry.evicted = true;
        }
    }
}

/// 新会话的 ID：Core 要求字母数字开头结尾、只含 `[A-Za-z0-9._-]`。
fn new_session_id(n: u64) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("primus-{nanos:x}-{n}")
}

/// 是否有打开中的会话在使用这个会话文件或会话 ID（调用方持有 `entries` 锁）。`file_keys` 为会话文件的键
/// （`platform::file_keys`），与恢复的会话登记的键有任一相同即为同一文件；`session_id` 为该文件的会话 ID，与新会话（薄壳定好 ID、文件由 Core 创建）比较。
fn using<S>(
    entries: &HashMap<String, Entry<S>>,
    file_keys: &[String],
    session_id: Option<&str>,
) -> bool {
    entries
        .values()
        .any(|entry| entry_uses(entry, file_keys, session_id))
}

/// 一个会话是否在使用这个会话文件（键有任一相同）或会话 ID（新会话）。
fn entry_uses<S>(entry: &Entry<S>, file_keys: &[String], session_id: Option<&str>) -> bool {
    let same_file = crate::platform::keys_overlap(&entry.file_keys, file_keys);
    let same_id = session_id.is_some() && entry.opts.session_id.as_deref() == session_id;
    same_file || same_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::CoreLayout;
    use crate::supervisor::tests::{TempDir, data_paths, fake_layout, kill_core, pid_alive};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// 启动时输出一条 `{"start":{argv, cwd}}`，之后把 stdin 的每一行原样回显（都是 JSON）。
    const ECHO: &str = r#"
process.stdout.write(JSON.stringify({ start: { argv: process.argv.slice(2), cwd: process.cwd() } }) + "\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    process.stdout.write(buf.slice(0, i + 1));
    buf = buf.slice(i + 1);
  }
});
"#;

    /// 收到的批次：`(sessionKey, seq, records)`
    type Received = Vec<(String, u64, Vec<serde_json::Value>)>;

    #[derive(Clone, Default)]
    struct Collect(Arc<Mutex<Received>>);

    impl BatchSink for Collect {
        fn send(&self, batch: CoreBatch) -> bool {
            let records = batch
                .records
                .iter()
                .map(|r| serde_json::from_str(r.get()).unwrap())
                .collect();
            self.0
                .lock()
                .unwrap()
                .push((batch.session_key, batch.seq, records));
            true
        }
    }

    impl Collect {
        fn records(&self) -> Vec<serde_json::Value> {
            let batches = self.0.lock().unwrap();
            batches.iter().flat_map(|(_, _, r)| r.clone()).collect()
        }

        fn seqs(&self) -> Vec<u64> {
            self.0.lock().unwrap().iter().map(|(_, s, _)| *s).collect()
        }

        /// 等到收到满足条件的记录数达到 `count`。
        fn wait_for(&self, count: usize, pred: impl Fn(&serde_json::Value) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if self.records().iter().filter(|r| pred(r)).count() >= count {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "等待记录超时：{:?}",
                    self.records()
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    fn setup(tmp: &TempDir) -> (Supervisor, DataPaths, Sessions<Collect>) {
        let paths = data_paths(&tmp.0);
        let layout: CoreLayout = fake_layout(&tmp.0, ECHO);
        let supervisor = Supervisor::new(layout, paths.clone()).unwrap();
        (supervisor, paths, Sessions::default())
    }

    fn starts(sink: &Collect) -> Vec<serde_json::Value> {
        sink.records()
            .into_iter()
            .filter_map(|r| r.get("start").cloned())
            .collect()
    }

    fn arg_after(start: &serde_json::Value, flag: &str) -> Option<String> {
        let argv = start["argv"].as_array()?;
        let i = argv.iter().position(|a| a == flag)?;
        argv.get(i + 1)?.as_str().map(str::to_owned)
    }

    fn idle_entry(session_file: Option<&str>, session_id: Option<&str>) -> Entry<Collect> {
        Entry {
            bridge: None,
            restarting: false,
            evicted: true,
            last_seq: 0,
            opts: LaunchOptions {
                cwd: PathBuf::from("/w"),
                session_file: session_file.map(PathBuf::from),
                session_id: session_id.map(str::to_owned),
                approve: false,
                offline: false,
                telemetry: false,
            },
            file_keys: session_file
                .map(|p| crate::platform::file_keys(Path::new(p)))
                .unwrap_or_default(),
            sink: Collect::default(),
        }
    }

    #[test]
    fn is_using_matches_session_file_or_id() {
        let sessions = Sessions::<Collect>::new(BridgeConfig::default());
        let file = std::env::temp_dir().join("sessions").join("a.jsonl");
        sessions
            .entries()
            .insert("s1".into(), idle_entry(file.to_str(), None));
        sessions
            .entries()
            .insert("s2".into(), idle_entry(None, Some("primus-new")));
        assert!(sessions.is_using(&file, None));
        assert!(sessions.is_using(
            Path::new("/elsewhere/2026-11-05T00-00-00-000Z_primus-new.jsonl"),
            Some("primus-new")
        ));
        // 复制出的副本保留文件头的会话 ID，但不是 Core 为这个 ID 新建的文件
        assert!(!sessions.is_using(Path::new("/elsewhere/b.jsonl"), Some("primus-new")));
        assert!(!sessions.is_using(
            Path::new("/elsewhere/2026-11-05T00-00-00-000Z_primus-new (1).jsonl"),
            Some("primus-new")
        ));
        assert!(!sessions.is_using(Path::new("/elsewhere/b.jsonl"), Some("other")));
        assert!(!sessions.is_using(Path::new("/elsewhere/b.jsonl"), None));
        sessions.entries().remove("s1");
        assert!(!sessions.is_using(&file, None));
    }

    #[test]
    fn opening_a_session_file_already_in_use_is_rejected() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let file = tmp.0.join("a.jsonl");
        sessions
            .entries()
            .insert("s1".into(), idle_entry(file.to_str(), None));
        let r = sessions.open(
            &supervisor,
            &paths,
            tmp.0.to_str().unwrap(),
            file.to_str(),
            Collect::default(),
        );
        assert!(matches!(r, Err(SessionError::InUse(_))), "{r:?}");
        assert!(supervisor.running_keys().is_empty());
        assert_eq!(sessions.session_id("s1"), None);
    }

    #[test]
    fn opening_the_file_of_an_open_new_session_is_rejected() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        // 打开中的新会话只登记了会话 ID；Core 随后写下的会话文件头带同一个 ID
        sessions
            .entries()
            .insert("s1".into(), idle_entry(None, Some("primus-new")));
        let file = tmp.0.join("2026_primus-new.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"primus-new\"}\n").unwrap();
        let r = sessions.open(
            &supervisor,
            &paths,
            tmp.0.to_str().unwrap(),
            file.to_str(),
            Collect::default(),
        );
        assert!(matches!(r, Err(SessionError::InUse(_))), "{r:?}");
        assert!(supervisor.running_keys().is_empty());
    }

    #[test]
    fn opening_the_same_file_by_another_spelling_is_rejected() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let sub = tmp.0.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let file = sub.join("a.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"a\"}\n").unwrap();
        sessions
            .entries()
            .insert("s1".into(), idle_entry(file.to_str(), None));
        let dotted = tmp
            .0
            .join(".")
            .join("sub")
            .join("..")
            .join("sub")
            .join("a.jsonl");
        let r = sessions.open(
            &supervisor,
            &paths,
            tmp.0.to_str().unwrap(),
            dotted.to_str(),
            Collect::default(),
        );
        assert!(matches!(r, Err(SessionError::InUse(_))), "{r:?}");
        assert!(sessions.is_using(&dotted, None));
    }

    #[test]
    fn entry_registered_without_file_identity_still_blocks_open_and_delete() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let file = tmp.0.join("a.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"a\"}\n").unwrap();
        // 登记时身份查询失败（只有路径键）；之后同一文件能取得文件系统身份
        let mut entry = idle_entry(file.to_str(), None);
        entry.file_keys = crate::platform::file_keys_with(&file, |_| None);
        assert!(entry.file_keys.iter().all(|k| !k.starts_with("file-id:")));
        sessions.entries().insert("s1".into(), entry);
        assert!(sessions.is_using(&file, None));
        let r = sessions.open(
            &supervisor,
            &paths,
            tmp.0.to_str().unwrap(),
            file.to_str(),
            Collect::default(),
        );
        assert!(matches!(r, Err(SessionError::InUse(_))), "{r:?}");
        assert!(supervisor.running_keys().is_empty());
        // 删除时一并关闭使用它的会话
        let mut stopped = Vec::new();
        assert!(
            sessions
                .delete_closing(&file, None, |k| stopped.push(k.to_owned()), || ())
                .is_ok()
        );
        assert_eq!(stopped, ["s1"]);
        assert!(!sessions.is_using(&file, None));
    }

    #[test]
    fn delete_waits_for_a_launch_in_flight() {
        let sessions = Arc::new(Sessions::<Collect>::new(BridgeConfig::default()));
        let file = std::env::temp_dir().join("2026-11-05T00-00-00-000Z_primus-x.jsonl");
        sessions.insert_idle_for_test("s1", None, Some("primus-x"), Collect::default());
        let guard = sessions.begin_launch("s1");
        let order = Arc::new(Mutex::new(Vec::new()));
        let worker = {
            let (sessions, order, file) = (sessions.clone(), order.clone(), file.clone());
            std::thread::spawn(move || {
                sessions.delete_closing(
                    &file,
                    Some("primus-x"),
                    |_| {},
                    || order.lock().unwrap().push("delete"),
                )
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        // 拉起尚未结束：删除在等待，文件还没删
        assert!(order.lock().unwrap().is_empty());
        order.lock().unwrap().push("launch done");
        drop(guard);
        assert!(worker.join().unwrap().is_ok());
        assert_eq!(*order.lock().unwrap(), vec!["launch done", "delete"]);
    }

    #[test]
    fn delete_is_refused_when_a_launch_does_not_finish() {
        let mut sessions = Sessions::<Collect>::new(BridgeConfig::default());
        sessions.launch_wait = Duration::from_millis(50);
        let file = std::env::temp_dir().join("2026-11-05T00-00-00-000Z_primus-y.jsonl");
        sessions.insert_idle_for_test("s1", None, Some("primus-y"), Collect::default());
        let guard = sessions.begin_launch("s1");
        let mut stopped = Vec::new();
        let r = sessions.delete_closing(
            &file,
            Some("primus-y"),
            |k| stopped.push(k.to_owned()),
            || panic!("拉起未结束时不应删除文件"),
        );
        assert_eq!(r, Err(DeleteRefused::LaunchPending));
        assert_eq!(stopped, ["s1"], "每个会话只结束一次");
        // 拉起结束前重试：会话已移出会话表，但“删除中”登记仍在，不能删除
        let retry =
            sessions.delete_closing(&file, Some("primus-y"), |_| {}, || panic!("重试也不应删除"));
        assert_eq!(retry, Err(DeleteRefused::AlreadyDeleting));
        // 拉起结束：撤销登记，重试可以删除
        drop(guard);
        assert!(sessions.deleting().is_empty());
        assert_eq!(
            sessions.delete_closing(&file, Some("primus-y"), |_| {}, || 7),
            Ok(7)
        );
    }

    #[test]
    fn file_being_deleted_cannot_be_opened() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let file = tmp.0.join("a.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"a\"}\n").unwrap();
        // 删除进行中（回调执行期间）打开同一文件：拒绝，不拉起进程
        let opened = sessions
            .delete_closing(
                &file,
                Some("a"),
                |_| {},
                || {
                    sessions.open(
                        &supervisor,
                        &paths,
                        tmp.0.to_str().unwrap(),
                        file.to_str(),
                        Collect::default(),
                    )
                },
            )
            .expect("未被使用的文件应执行删除回调");
        assert!(
            matches!(opened, Err(SessionError::Deleting(_))),
            "{opened:?}"
        );
        assert!(supervisor.running_keys().is_empty());
        // 删除结束后撤销登记
        assert!(sessions.deleting().is_empty());
        // 同一文件已在删除中时不重复删除
        sessions
            .deleting()
            .extend(crate::platform::file_keys(&file));
        assert!(
            sessions.delete_closing(&file, None, |_| {}, || panic!("不应执行删除"))
                == Err(DeleteRefused::AlreadyDeleting)
        );
    }

    #[test]
    fn open_send_and_close() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let work = tmp.0.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let sink = Collect::default();
        let key = sessions
            .open(
                &supervisor,
                &paths,
                work.to_str().unwrap(),
                None,
                sink.clone(),
            )
            .expect("打开会话");
        sessions
            .send(
                &supervisor,
                &key,
                &serde_json::json!({ "type": "get_state", "id": "1" }),
            )
            .unwrap();
        sink.wait_for(1, |r| r["id"] == "1");

        let start = &starts(&sink)[0];
        assert_eq!(
            std::fs::canonicalize(start["cwd"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(&work).unwrap()
        );
        let id = arg_after(start, "--session-id").expect("新会话应带 --session-id");
        assert!(id.starts_with("primus-"), "{id}");
        assert!(arg_after(start, "--session").is_none());
        assert!(sink.0.lock().unwrap().iter().all(|(k, _, _)| *k == key));

        sessions.close(&supervisor, &key);
        assert!(supervisor.running_keys().is_empty());
        assert!(matches!(
            sessions.send(&supervisor, &key, &serde_json::json!({})),
            Err(SessionError::NotFound(_))
        ));
        // 重复关闭无害
        sessions.close(&supervisor, &key);
    }

    #[test]
    fn empty_workspace_runs_in_user_chat_dir_and_session_file_resumes() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let sink = Collect::default();
        let key = sessions
            .open(
                &supervisor,
                &paths,
                "",
                Some("C:/会话/a.jsonl"),
                sink.clone(),
            )
            .unwrap();
        sink.wait_for(1, |r| r.get("start").is_some());
        let start = &starts(&sink)[0];
        assert_eq!(
            std::fs::canonicalize(start["cwd"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(paths.user_dir().join("chat")).unwrap()
        );
        assert_eq!(
            arg_after(start, "--session").as_deref(),
            Some("C:/会话/a.jsonl")
        );
        assert!(arg_after(start, "--session-id").is_none());
        sessions.close(&supervisor, &key);
    }

    #[test]
    fn missing_workspace_is_rejected() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let missing = tmp.0.join("missing");
        let result = sessions.open(
            &supervisor,
            &paths,
            missing.to_str().unwrap(),
            None,
            Collect::default(),
        );
        assert!(matches!(result, Err(SessionError::Workspace(_))));
        assert!(supervisor.running_keys().is_empty());
    }

    #[test]
    fn restart_rechecks_trust_and_only_downgrades() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let sink = Collect::default();
        let key = sessions
            .open_with_trust(&supervisor, &paths, "", None, true, sink.clone())
            .unwrap();
        let approve = |start: &serde_json::Value| {
            let argv = start["argv"].as_array().unwrap();
            assert!(
                argv.iter().any(|a| a == "--approve") != argv.iter().any(|a| a == "--no-approve")
            );
            argv.iter().any(|a| a == "--approve")
        };
        sink.wait_for(1, |r| r.get("start").is_some());
        assert!(approve(&starts(&sink)[0]));

        // 信任已失效（如 .primus 变化）：重启改为 --no-approve
        sessions
            .restart_checked(&supervisor, &key, |_| false)
            .expect("重启");
        sink.wait_for(1, |r| r.get("start").is_some() && !approve(&r["start"]));
        // 之后即使判定为信任也不会升级（需重新打开会话）
        sessions
            .restart_checked(&supervisor, &key, |_| true)
            .expect("重启");
        sessions
            .send(&supervisor, &key, &serde_json::json!({ "id": "after" }))
            .unwrap();
        sink.wait_for(1, |r| r["id"] == "after");
        let starts = starts(&sink);
        assert_eq!(starts.len(), 3, "应启动三次：{starts:?}");
        assert!(!approve(&starts[1]) && !approve(&starts[2]));
    }

    #[test]
    fn restart_keeps_session_id_and_continues_seq() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let sink = Collect::default();
        let key = sessions
            .open(&supervisor, &paths, "", None, sink.clone())
            .unwrap();
        sessions
            .send(&supervisor, &key, &serde_json::json!({ "id": "before" }))
            .unwrap();
        sink.wait_for(1, |r| r["id"] == "before");

        sessions.restart(&supervisor, &key).expect("重启");
        sessions
            .send(&supervisor, &key, &serde_json::json!({ "id": "after" }))
            .unwrap();
        sink.wait_for(1, |r| r["id"] == "after");

        let starts = starts(&sink);
        assert_eq!(starts.len(), 2, "应启动两次：{starts:?}");
        let first = arg_after(&starts[0], "--session-id").unwrap();
        assert_eq!(arg_after(&starts[1], "--session-id"), Some(first));

        let seqs = sink.seqs();
        assert!(
            seqs.windows(2).all(|w| w[1] == w[0] + 1),
            "seq 应从 1 起连续递增：{seqs:?}"
        );
        assert_eq!(seqs[0], 1);
        assert_eq!(supervisor.running_keys(), vec![key.clone()]);
        sessions.close(&supervisor, &key);
    }

    #[test]
    fn evicted_session_reports_not_running_until_restarted() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        supervisor.set_max_processes(1);
        let first = Collect::default();
        let a = sessions
            .open(&supervisor, &paths, "", None, first.clone())
            .unwrap();
        sessions
            .send(&supervisor, &a, &serde_json::json!({ "id": "a1" }))
            .unwrap();
        first.wait_for(1, |r| r["id"] == "a1");

        // 第二个会话超出上限，淘汰第一个
        let b = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        assert_eq!(supervisor.running_keys(), vec![b.clone()]);
        assert!(matches!(
            sessions.send(&supervisor, &a, &serde_json::json!({})),
            Err(SessionError::NotRunning(_))
        ));

        // 重启恢复，seq 接着编号
        sessions.restart(&supervisor, &a).unwrap();
        sessions
            .send(&supervisor, &a, &serde_json::json!({ "id": "a2" }))
            .unwrap();
        first.wait_for(1, |r| r["id"] == "a2");
        let seqs = first.seqs();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "{seqs:?}");
        sessions.close(&supervisor, &a);
        sessions.close(&supervisor, &b);
    }

    #[test]
    fn exited_core_session_reports_not_running_after_cleanup() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let first = Collect::default();
        let a = sessions
            .open(&supervisor, &paths, "", None, first.clone())
            .unwrap();
        first.wait_for(1, |r| r.get("start").is_some());
        kill_core(&supervisor, &a);
        // 打开 b 时清理已退出的 a：a 标为未运行，记录不再进桥
        let b = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        assert_eq!(supervisor.running_keys(), vec![b.clone()]);
        assert!(matches!(
            sessions.send(&supervisor, &a, &serde_json::json!({ "id": "lost" })),
            Err(SessionError::NotRunning(_))
        ));
        // 重启恢复
        sessions.restart(&supervisor, &a).unwrap();
        sessions
            .send(&supervisor, &a, &serde_json::json!({ "id": "a2" }))
            .unwrap();
        first.wait_for(1, |r| r["id"] == "a2");
        assert!(!first.records().iter().any(|r| r["id"] == "lost"));
        sessions.close(&supervisor, &a);
        sessions.close(&supervisor, &b);
    }

    #[test]
    fn send_to_exited_core_reports_not_running_without_cleanup() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let first = Collect::default();
        let a = sessions
            .open(&supervisor, &paths, "", None, first.clone())
            .unwrap();
        first.wait_for(1, |r| r.get("start").is_some());
        kill_core(&supervisor, &a);
        // 没有其他拉起来清理：发送时发现进程已退出，立即得到 NotRunning，不写进旧桥
        assert!(matches!(
            sessions.send(&supervisor, &a, &serde_json::json!({ "id": "lost" })),
            Err(SessionError::NotRunning(_))
        ));
        // 重启（按崩溃计数）恢复
        sessions.restart(&supervisor, &a).unwrap();
        sessions
            .send(&supervisor, &a, &serde_json::json!({ "id": "a2" }))
            .unwrap();
        first.wait_for(1, |r| r["id"] == "a2");
        assert!(!first.records().iter().any(|r| r["id"] == "lost"));
        sessions.close(&supervisor, &a);
    }

    #[test]
    fn restart_after_close_before_launch_reports_not_found() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let a = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        sessions.close(&supervisor, &a);
        // 会话已不在表里：不预留、不拉起
        assert!(matches!(
            sessions.launch(&supervisor, &a, &test_opts(), Collect::default(), 0),
            Err(SessionError::NotFound(_))
        ));
        assert!(supervisor.running_keys().is_empty());
    }

    #[test]
    fn finish_launch_after_close_reports_not_found() {
        let tmp = TempDir::new();
        let (supervisor, _paths, sessions) = setup(&tmp);
        // 重启期间会话被关闭：拉起失败也报告 NotFound，而不是拉起的错误
        let failed = Err(SessionError::Io(io::Error::other("拉起失败")));
        assert!(matches!(
            sessions.finish_launch(&supervisor, "gone", 0, failed),
            Err(SessionError::NotFound(_))
        ));
    }

    #[test]
    fn finish_launch_success_after_close_stops_new_core() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let a = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        // 模拟重启拉起成功、尚未放回桥时会话被关闭：取出新桥并从表中移除（不经 close，进程仍在）
        let bridge = sessions
            .entries()
            .get_mut(&a)
            .and_then(|e| e.bridge.take())
            .unwrap();
        let pid = supervisor.with_process(&a, |p| p.pid()).unwrap();
        sessions.entries().remove(&a);
        assert!(matches!(
            sessions.finish_launch(&supervisor, &a, 0, Ok(bridge)),
            Err(SessionError::NotFound(_))
        ));
        assert!(supervisor.running_keys().is_empty());
        assert!(!pid_alive(pid), "会话已关闭时拉起成功的新进程应已结束");
    }

    #[test]
    fn close_between_reservation_and_commit_is_not_registered() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let a = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        // 模拟重启：旧进程已结束，名额已预留、进程已创建，此时会话被关闭
        supervisor.stop(&a);
        let mut gone = Evicted::default();
        let reservation = supervisor.reserve(&a, |_| false, &mut gone).unwrap();
        let process = reservation.launch(&test_opts()).unwrap();
        let pid = process.pid();
        sessions.close(&supervisor, &a);
        // 登记前复查：不登记、结束新进程、归还名额
        assert!(matches!(
            sessions.register(&a, reservation, process),
            Err(SessionError::NotFound(_))
        ));
        assert!(supervisor.running_keys().is_empty());
        assert!(!pid_alive(pid), "未登记的新进程应已结束");
        // 名额已归还：同一会话可再次预留
        assert!(supervisor.reserve(&a, |_| false, &mut gone).is_ok());
    }

    #[test]
    fn cleanup_does_not_mark_restarting_session() {
        let tmp = TempDir::new();
        let supervisor = Supervisor::new(fake_layout(&tmp.0, ECHO), data_paths(&tmp.0)).unwrap();
        supervisor.spawn("s1", &test_opts()).unwrap();
        kill_core(&supervisor, "s1");
        let mut gone = Evicted::default();
        let reservation = supervisor.reserve("s2", |_| false, &mut gone).unwrap();
        assert_eq!(gone.keys(), vec!["s1".to_owned()]);
        let mut entries = HashMap::new();
        entries.insert("s1".to_owned(), test_entry(true));
        // 重启中的会话：被清理的是旧进程，不标未运行（否则重启成功后发送仍得到 NotRunning）
        mark_gone(&mut entries, &gone);
        assert!(!entries["s1"].evicted);
        entries.get_mut("s1").unwrap().restarting = false;
        mark_gone(&mut entries, &gone);
        assert!(entries["s1"].evicted);
        drop(reservation);
        drop(gone);
    }

    fn test_opts() -> LaunchOptions {
        LaunchOptions {
            cwd: PathBuf::from("."),
            session_file: None,
            session_id: None,
            approve: false,
            offline: false,
            telemetry: false,
        }
    }

    fn test_entry(restarting: bool) -> Entry<Collect> {
        Entry {
            bridge: None,
            restarting,
            evicted: false,
            last_seq: 0,
            opts: test_opts(),
            file_keys: Vec::new(),
            sink: Collect::default(),
        }
    }

    #[test]
    fn opening_or_restarting_session_counts_as_busy() {
        let mut entries = HashMap::new();
        entries.insert(
            "s1".to_owned(),
            Entry {
                bridge: None,
                restarting: true,
                evicted: false,
                last_seq: 0,
                opts: LaunchOptions {
                    cwd: PathBuf::from("."),
                    session_file: None,
                    session_id: None,
                    approve: false,
                    offline: false,
                    telemetry: false,
                },
                file_keys: Vec::new(),
                sink: Collect::default(),
            },
        );
        assert!(is_busy(&entries, "s1"), "桥尚未装入的会话不能被淘汰");
        entries.get_mut("s1").unwrap().restarting = false;
        assert!(!is_busy(&entries, "s1"));
        assert!(!is_busy(&entries, "s2"));
    }

    #[test]
    fn update_hold_blocks_prompts_and_launches_until_released() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        let a = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        let hold = sessions.hold_for_update(false).expect("空闲时可以进入安装");
        let prompt = serde_json::json!({ "type": "prompt", "message": "hi" });
        assert!(matches!(
            sessions.send(&supervisor, &a, &prompt),
            Err(SessionError::Updating)
        ));
        sessions
            .send(&supervisor, &a, &serde_json::json!({ "type": "get_state" }))
            .expect("安装期间非 prompt 命令照常");
        assert!(matches!(
            sessions.open(&supervisor, &paths, "", None, Collect::default()),
            Err(SessionError::Updating)
        ));
        assert!(matches!(
            sessions.restart(&supervisor, &a),
            Err(SessionError::Updating)
        ));
        drop(hold);
        sessions
            .send(&supervisor, &a, &prompt)
            .expect("取消安装后恢复发送");
    }

    #[test]
    fn busy_session_is_not_evicted() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        supervisor.set_max_processes(1);
        let sink = Collect::default();
        let a = sessions
            .open(&supervisor, &paths, "", None, sink.clone())
            .unwrap();
        // 回显的 agent_start 让会话进入忙碌
        sessions
            .send(
                &supervisor,
                &a,
                &serde_json::json!({ "type": "agent_start" }),
            )
            .unwrap();
        sink.wait_for(1, |r| r["type"] == "agent_start");
        assert!(sessions.any_busy(), "运行中的会话让自动更新先确认");
        assert!(
            sessions.hold_for_update(false).is_none(),
            "忙碌时不经确认不能进入安装"
        );
        let result = sessions.open(&supervisor, &paths, "", None, Collect::default());
        assert!(
            matches!(
                result,
                Err(SessionError::Supervisor(SupervisorError::LimitReached(1)))
            ),
            "忙碌的会话不应被淘汰"
        );
        assert_eq!(supervisor.running_keys(), vec![a.clone()]);
        // 被拒绝的打开不留下会话
        assert_eq!(sessions.entries().len(), 1);

        // 本轮结束后可以淘汰
        sessions
            .send(
                &supervisor,
                &a,
                &serde_json::json!({ "type": "agent_settled" }),
            )
            .unwrap();
        sink.wait_for(1, |r| r["type"] == "agent_settled");
        assert!(!sessions.any_busy());
        let b = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        assert_eq!(supervisor.running_keys(), vec![b.clone()]);
        sessions.close(&supervisor, &a);
        sessions.close(&supervisor, &b);
    }

    #[test]
    fn prompt_written_before_agent_start_is_not_evicted() {
        let tmp = TempDir::new();
        let (supervisor, paths, sessions) = setup(&tmp);
        supervisor.set_max_processes(1);
        let sink = Collect::default();
        let a = sessions
            .open(&supervisor, &paths, "", None, sink.clone())
            .unwrap();
        // prompt 刚写入、Core 还没回 agent_start（回显 Core 只回显，不会回）：已算忙碌，不淘汰
        sessions
            .send(
                &supervisor,
                &a,
                &serde_json::json!({ "type": "prompt", "message": "hi" }),
            )
            .unwrap();
        let result = sessions.open(&supervisor, &paths, "", None, Collect::default());
        assert!(
            matches!(
                result,
                Err(SessionError::Supervisor(SupervisorError::LimitReached(1)))
            ),
            "已写入 prompt 的会话不应被淘汰"
        );
        assert_eq!(supervisor.running_keys(), vec![a.clone()]);
        // 响应为拒绝（未开始）后即空闲，可以淘汰
        sessions
            .send(
                &supervisor,
                &a,
                &serde_json::json!({ "type": "response", "command": "prompt", "success": false }),
            )
            .unwrap();
        sink.wait_for(1, |r| r["type"] == "response");
        let b = sessions
            .open(&supervisor, &paths, "", None, Collect::default())
            .unwrap();
        assert_eq!(supervisor.running_keys(), vec![b.clone()]);
        sessions.close(&supervisor, &a);
        sessions.close(&supervisor, &b);
    }

    #[test]
    fn restart_unknown_session_fails() {
        let tmp = TempDir::new();
        let (supervisor, _paths, sessions) = setup(&tmp);
        assert!(matches!(
            sessions.restart(&supervisor, "s9"),
            Err(SessionError::NotFound(_))
        ));
    }
}
