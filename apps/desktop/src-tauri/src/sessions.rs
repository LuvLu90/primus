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

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

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
    sink: S,
}

pub(crate) struct Sessions<S> {
    entries: Mutex<HashMap<String, Entry<S>>>,
    next: AtomicU64,
    config: BridgeConfig,
}

impl<S: BatchSink + Clone> Default for Sessions<S> {
    fn default() -> Self {
        Self::new(BridgeConfig::default())
    }
}

impl<S: BatchSink + Clone> Sessions<S> {
    pub(crate) fn new(config: BridgeConfig) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            config,
        }
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry<S>>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 打开会话：拉起 Core 并开始推送批次，返回 `sessionKey`。
    pub(crate) fn open(
        &self,
        supervisor: &Supervisor,
        paths: &DataPaths,
        workspace: &str,
        session_file: Option<&str>,
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
        let opts = LaunchOptions {
            cwd,
            session_file,
            session_id,
            approve: false,
            offline: false,
            telemetry: false,
        };
        // 先登记（标记启动中）再拉起：拉起期间若被其他会话的拉起淘汰，标记能落到这一条上；
        // 期间被关闭则结束新进程
        // 占用检查与登记在同一次加锁内完成，并发打开同一会话文件时只有一个能通过
        {
            let mut entries = self.entries();
            if let Some(file) = &opts.session_file
                && using(&entries, file, None)
            {
                return Err(SessionError::InUse(file.clone()));
            }
            entries.insert(
                key.clone(),
                Entry {
                    bridge: None,
                    restarting: true,
                    evicted: false,
                    last_seq: 0,
                    opts: opts.clone(),
                    sink: sink.clone(),
                },
            );
        }
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

    /// 薄壳为新会话定好的会话 ID（`--session-id`）；恢复已有会话文件时为 None。
    pub(crate) fn session_id(&self, key: &str) -> Option<String> {
        self.entries()
            .get(key)
            .and_then(|entry| entry.opts.session_id.clone())
    }

    /// 是否有打开中的会话使用这个会话文件或会话 ID（删除前检查）。新会话按薄壳定好的会话 ID 判断，
    /// 恢复的会话按会话文件路径判断（路径按 `platform::path_key` 比较）。
    pub(crate) fn is_using(&self, session_file: &Path, session_id: Option<&str>) -> bool {
        using(&self.entries(), session_file, session_id)
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
    pub(crate) fn restart(&self, supervisor: &Supervisor, key: &str) -> Result<(), SessionError> {
        // 取出旧桥并标记重启中；耗时的结束与拉起在锁外进行，不阻塞其他会话
        let (old, opts, sink, last_seq) = {
            let mut entries = self.entries();
            let entry = entries
                .get_mut(key)
                .ok_or_else(|| SessionError::NotFound(key.to_owned()))?;
            if entry.restarting {
                return Err(SessionError::Restarting(key.to_owned()));
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
            )
        };
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

/// 是否有打开中的会话在使用这个会话文件或会话 ID（调用方持有 `entries` 锁）。
fn using<S>(
    entries: &HashMap<String, Entry<S>>,
    session_file: &Path,
    session_id: Option<&str>,
) -> bool {
    let file_key = session_file.to_str().map(crate::platform::path_key);
    entries.values().any(|entry| {
        let same_file = file_key.is_some()
            && entry
                .opts
                .session_file
                .as_deref()
                .and_then(Path::to_str)
                .map(crate::platform::path_key)
                == file_key;
        let same_id = session_id.is_some() && entry.opts.session_id.as_deref() == session_id;
        same_file || same_id
    })
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
        assert!(sessions.is_using(Path::new("/elsewhere/b.jsonl"), Some("primus-new")));
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
                sink: Collect::default(),
            },
        );
        assert!(is_busy(&entries, "s1"), "桥尚未装入的会话不能被淘汰");
        entries.get_mut("s1").unwrap().restarting = false;
        assert!(!is_busy(&entries, "s1"));
        assert!(!is_busy(&entries, "s2"));
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
