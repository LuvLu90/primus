//! 会话目录监听（第 10.2 节、ADR 0006）：notify 监听 `core/sessions/`，按路径合并事件后交给会话索引增量更新，
//! 索引有变化时经 `session_watch` 注册的 Channel 通知前端（只推“变了”的信号与序号，不推内容）。
//!
//! - 启动后先开始监听、再全量扫描一次，扫描期间写入的文件不会漏掉。
//! - 事件自第一条起最多攒 250ms 再处理：Core 流式写入时每秒最多更新 4 次索引，不会因持续写入一直推迟。
//! - 监听器报错或提示丢了事件（`need_rescan`）时改做一次全量扫描。重命名（含目录重命名）、目录删除与目录创建
//!   也改做全量扫描：notify 对这类事件只报告目录本身，不逐个报告其中的会话文件（Windows 上移入的目录只报告 `Create`）。
//! - 全量扫描（含启动时的首次扫描）失败时按退避重新安排全量扫描，直到成功；失败前已写入的变化照常通知前端。
//! - 监听工作区文件（文件树，第 15.2 节）以后在这里按监听目标扩展。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
use notify::{Event, RecursiveMode, Watcher};

use crate::session_index::SessionIndex;

/// 事件合并窗口。
const DEBOUNCE: Duration = Duration::from_millis(250);
/// 全量扫描失败后首次重试的间隔；之后每次失败加倍，最多到 [`RETRY_MAX_FACTOR`] 倍。
const RESCAN_RETRY: Duration = Duration::from_secs(2);
const RETRY_MAX_FACTOR: u32 = 16;

/// 推给前端的“索引变了”信号；`seq` 递增，前端收到后重新拉取列表。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub(crate) struct IndexChanged {
    pub(crate) seq: u64,
}

type Listener = Box<dyn Fn(IndexChanged) + Send + Sync>;

/// 索引变化的通知出口：同一时刻只有一个监听者（前端再次注册时替换）。
#[derive(Default)]
pub(crate) struct IndexNotifier {
    listener: Mutex<Option<Listener>>,
    seq: AtomicU64,
}

impl IndexNotifier {
    pub(crate) fn set_listener(&self, listener: impl Fn(IndexChanged) + Send + Sync + 'static) {
        *self.listener.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(listener));
    }

    pub(crate) fn notify(&self) {
        // 持锁分配序号并推送：并发调用（归档命令与监听线程）时监听者收到的序号严格递增
        let listener = self.listener.lock().unwrap_or_else(PoisonError::into_inner);
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(listener) = listener.as_ref() {
            listener(IndexChanged { seq });
        }
    }
}

/// 在后台线程中监听会话目录并维护索引。监听器建不起来时只做一次全量扫描（列表仍可用，只是不自动刷新）。
pub(crate) fn start(index: Arc<SessionIndex>, notifier: Arc<IndexNotifier>) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("primus-session-watch".into())
        .spawn(move || {
            let (tx, rx) = mpsc::channel();
            // 首次启动时 Core 可能还没建会话目录；目录不存在时 notify 无法监听
            if let Err(e) = std::fs::create_dir_all(index.sessions_dir()) {
                eprintln!("无法创建会话目录：{e}");
            }
            let watcher = notify::recommended_watcher(tx).and_then(|mut w| {
                w.watch(index.sessions_dir(), RecursiveMode::Recursive)?;
                Ok(w)
            });
            if let Err(e) = &watcher {
                eprintln!("会话目录监听启动失败，会话列表不会自动刷新：{e}");
            }
            let scanned = scan(&index, &notifier);
            if let Ok(watcher) = watcher {
                // 首次扫描失败（如会话目录暂时读不了；索引因版本升级刚重建时列表会是空的）：由事件循环重试
                run(&rx, &index, &notifier, DEBOUNCE, RESCAN_RETRY, !scanned);
                drop(watcher);
            }
        })
        .expect("failed to spawn session watch thread")
}

/// 首次全量扫描；返回是否成功。
fn scan(index: &SessionIndex, notifier: &IndexNotifier) -> bool {
    match index.sync_all() {
        // 首次扫描即使没有变化也通知一次：前端可能在扫描完成前拉到了不完整的列表
        Ok(_) => {
            notifier.notify();
            true
        }
        Err(e) => {
            eprintln!("会话索引扫描失败：{e}");
            if e.changed {
                notifier.notify();
            }
            false
        }
    }
}

/// 事件循环：合并事件、更新索引、通知。发送端全部断开时处理完剩余事件后返回。
/// `rescan` 为 true 时先安排一次全量扫描（`retry` 后执行）；全量扫描失败时按 `retry` 起步、加倍退避重新安排。
fn run(
    rx: &Receiver<notify::Result<Event>>,
    index: &SessionIndex,
    notifier: &IndexNotifier,
    debounce: Duration,
    retry: Duration,
    rescan: bool,
) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut rescan = rescan;
    let mut retry_delay = retry;
    let mut deadline: Option<Instant> = None;
    if rescan {
        deadline = next_retry(true, &mut retry_delay, retry);
    }
    loop {
        let message = match deadline {
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => {
                    flush(index, notifier, &mut pending, &mut rescan);
                    return;
                }
            },
        };
        match message {
            Some(Ok(event)) => {
                if event.need_rescan() || needs_full_scan(&event) {
                    rescan = true;
                }
                pending.extend(
                    event
                        .paths
                        .into_iter()
                        .filter(|p| p.extension().is_some_and(|e| e == "jsonl")),
                );
            }
            Some(Err(e)) => {
                eprintln!("会话目录监听出错，改为全量扫描：{e}");
                rescan = true;
            }
            None => {
                let failed = flush(index, notifier, &mut pending, &mut rescan);
                deadline = next_retry(failed, &mut retry_delay, retry);
                continue;
            }
        }
        if deadline.is_none() && (rescan || !pending.is_empty()) {
            deadline = Some(Instant::now() + debounce);
        }
        // 事件源源不断时 recv_timeout 不会超时：到点就处理，不被持续写入推迟
        if deadline.is_some_and(|at| Instant::now() >= at) {
            let failed = flush(index, notifier, &mut pending, &mut rescan);
            deadline = next_retry(failed, &mut retry_delay, retry);
        }
    }
}

/// 处理之后的下一个截止时间：全量扫描失败时在退避间隔后重试（间隔加倍，有上限），成功时复位间隔、不安排。
fn next_retry(failed: bool, delay: &mut Duration, base: Duration) -> Option<Instant> {
    if failed {
        let at = Instant::now() + *delay;
        *delay = (*delay * 2).min(base * RETRY_MAX_FACTOR);
        Some(at)
    } else {
        *delay = base;
        None
    }
}

/// 只报告目录、不报告其中文件的事件：重命名（文件或目录，旧新路径不一定成对到达）、目录删除，
/// 以及路径不是会话文件的删除与非文件创建（Windows 不区分文件与目录，移入的已含会话文件的目录只报告目录本身的
/// `Create`）。明确是文件的创建（Linux、macOS 的 `CreateKind::File`）不触发。
fn needs_full_scan(event: &Event) -> bool {
    match event.kind {
        EventKind::Modify(ModifyKind::Name(_)) | EventKind::Remove(RemoveKind::Folder) => true,
        EventKind::Create(CreateKind::File) => false,
        EventKind::Create(_) | EventKind::Remove(_) => event
            .paths
            .iter()
            .any(|p| !p.extension().is_some_and(|e| e == "jsonl")),
        _ => false,
    }
}

/// 处理攒下的事件；返回全量扫描是否失败（失败时已重新标记全量扫描）。
fn flush(
    index: &SessionIndex,
    notifier: &IndexNotifier,
    pending: &mut HashSet<PathBuf>,
    rescan: &mut bool,
) -> bool {
    let mut failed = false;
    let changed = if std::mem::take(rescan) {
        pending.clear();
        index.sync_all().unwrap_or_else(|e| {
            // 未处理的文件与待删除的条目留给重试的全量扫描；失败前已写入的变化照常通知
            eprintln!("会话索引扫描失败，稍后重试：{e}");
            *rescan = true;
            failed = true;
            e.changed
        })
    } else {
        let mut changed = false;
        for path in pending.drain() {
            match index.update_file(&path) {
                Ok(change) => changed |= change.changed(),
                Err(e) => eprintln!("会话索引更新失败（{}）：{e}", path.display()),
            }
        }
        changed
    };
    if changed {
        notifier.notify();
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::tests::TempDir;
    use notify::event::{CreateKind, Flag};
    use std::sync::mpsc::Sender;

    fn session_file(dir: &std::path::Path, name: &str, id: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(
            &p,
            format!(
                "{}\n{}\n",
                serde_json::json!({"type":"session","id":id,"timestamp":"2026-11-03T00:00:00.000Z","cwd":"/w"}),
                serde_json::json!({"type":"message","id":"m","parentId":null,"timestamp":"2026-11-03T00:00:00.000Z",
                    "message":{"role":"user","content":"hello","timestamp":1}}),
            ),
        )
        .unwrap();
        p
    }

    fn recorder() -> (Arc<IndexNotifier>, Arc<Mutex<Vec<u64>>>) {
        let notifier = Arc::new(IndexNotifier::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        notifier.set_listener(move |e| sink.lock().unwrap().push(e.seq));
        (notifier, seen)
    }

    fn created(tx: &Sender<notify::Result<Event>>, path: PathBuf) {
        tx.send(Ok(
            Event::new(EventKind::Create(CreateKind::File)).add_path(path)
        ))
        .unwrap();
    }

    #[test]
    fn notifier_numbers_signals_and_replaces_listener() {
        let (notifier, seen) = recorder();
        notifier.notify();
        notifier.notify();
        let second = Arc::new(Mutex::new(Vec::new()));
        let sink = second.clone();
        notifier.set_listener(move |e| sink.lock().unwrap().push(e.seq));
        notifier.notify();
        assert_eq!(*seen.lock().unwrap(), vec![1, 2]);
        assert_eq!(*second.lock().unwrap(), vec![3]);
    }

    #[test]
    fn events_are_merged_and_indexed_once() {
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        let a = session_file(&dir.0, "a.jsonl", "a");
        for _ in 0..5 {
            created(&tx, a.clone());
        }
        // 非会话文件被忽略
        created(&tx, dir.0.join("notes.txt"));
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(20),
            Duration::from_millis(20),
            false,
        );
        assert_eq!(index.list(None, None).unwrap().items.len(), 1);
        assert_eq!(*seen.lock().unwrap(), vec![1]);
    }

    #[test]
    fn flushes_while_events_keep_arriving() {
        let dir = TempDir::new();
        let index = Arc::new(SessionIndex::open_in_memory(&dir.0).unwrap());
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        let a = session_file(&dir.0, "a.jsonl", "a");
        let worker = {
            let index = index.clone();
            let notifier = notifier.clone();
            std::thread::spawn(move || {
                run(
                    &rx,
                    &index,
                    &notifier,
                    Duration::from_millis(30),
                    Duration::from_millis(30),
                    false,
                )
            })
        };
        // 持续写入（间隔小于合并窗口）期间也要更新索引
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(200) {
            created(&tx, a.clone());
            std::thread::sleep(Duration::from_millis(5));
            if !seen.lock().unwrap().is_empty() {
                break;
            }
        }
        assert!(!seen.lock().unwrap().is_empty(), "持续事件期间没有刷新索引");
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn rescan_flag_and_errors_trigger_full_scan() {
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        session_file(&dir.0, "a.jsonl", "a");
        tx.send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)))
            .unwrap();
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(10),
            Duration::from_millis(10),
            false,
        );
        assert_eq!(index.list(None, None).unwrap().items.len(), 1);
        assert_eq!(seen.lock().unwrap().len(), 1);

        let (tx, rx) = mpsc::channel();
        session_file(&dir.0, "b.jsonl", "b");
        tx.send(Err(notify::Error::generic("boom"))).unwrap();
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(10),
            Duration::from_millis(10),
            false,
        );
        assert_eq!(index.list(None, None).unwrap().items.len(), 2);
    }

    #[test]
    fn directory_rename_triggers_full_scan() {
        use notify::event::RenameMode;
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        let old_dir = dir.0.join("old");
        std::fs::create_dir(&old_dir).unwrap();
        let a = session_file(&old_dir, "a.jsonl", "a");
        index.update_file(&a).unwrap();
        let new_dir = dir.0.join("new");
        std::fs::rename(&old_dir, &new_dir).unwrap();
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        // Linux 上目录重命名只报告目录路径
        tx.send(Ok(Event::new(EventKind::Modify(ModifyKind::Name(
            RenameMode::Both,
        )))
        .add_path(old_dir)
        .add_path(new_dir.clone())))
            .unwrap();
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(10),
            Duration::from_millis(10),
            false,
        );
        let items = index.list(None, None).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(
            std::path::Path::new(&items[0].path),
            new_dir.join("a.jsonl").as_path()
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn directory_removal_triggers_full_scan() {
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        let sub = dir.0.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let a = session_file(&sub, "a.jsonl", "a");
        index.update_file(&a).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();
        let (notifier, _seen) = recorder();
        let (tx, rx) = mpsc::channel();
        tx.send(Ok(
            Event::new(EventKind::Remove(RemoveKind::Any)).add_path(sub)
        ))
        .unwrap();
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(10),
            Duration::from_millis(10),
            false,
        );
        assert!(index.list(None, None).unwrap().items.is_empty());
    }

    #[test]
    fn directory_creation_triggers_full_scan() {
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        let sub = dir.0.join("moved");
        std::fs::create_dir(&sub).unwrap();
        session_file(&sub, "a.jsonl", "a");
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        // Windows 上移入已含会话文件的目录只报告目录本身的 Create（不区分文件与目录）
        tx.send(Ok(
            Event::new(EventKind::Create(CreateKind::Any)).add_path(sub)
        ))
        .unwrap();
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(10),
            Duration::from_millis(10),
            false,
        );
        assert_eq!(index.list(None, None).unwrap().items.len(), 1);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    fn wait_until(mut done: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while !done() {
            if start.elapsed() > Duration::from_secs(10) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    #[test]
    fn failed_initial_scan_is_retried() {
        let dir = TempDir::new();
        let index = Arc::new(SessionIndex::open_in_memory(&dir.0).unwrap());
        session_file(&dir.0, "a.jsonl", "a");
        // 首次扫描失败（索引写入失败；目录读不了时同理）
        index.execute_batch_for_test(
            "CREATE TEMP TRIGGER fail_all BEFORE INSERT ON sessions
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        );
        assert!(index.sync_all().is_err());
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let worker = {
            let index = index.clone();
            let notifier = notifier.clone();
            std::thread::spawn(move || {
                run(
                    &rx,
                    &index,
                    &notifier,
                    Duration::from_millis(10),
                    Duration::from_millis(10),
                    true,
                )
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(index.list(None, None).unwrap().items.is_empty());
        // 故障消除后，没有任何新事件，重试的全量扫描也会把会话入索引
        index.execute_batch_for_test("DROP TRIGGER fail_all;");
        assert!(
            wait_until(|| index.list(None, None).unwrap().items.len() == 1),
            "扫描失败后没有重试"
        );
        assert!(wait_until(|| !seen.lock().unwrap().is_empty()));
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn partially_failed_scan_notifies_and_retries() {
        let dir = TempDir::new();
        let index = Arc::new(SessionIndex::open_in_memory(&dir.0).unwrap());
        // 根目录的文件先于子目录处理：a 写入后，bad 写入失败中止扫描
        session_file(&dir.0, "a.jsonl", "a");
        let sub = dir.0.join("sub");
        std::fs::create_dir(&sub).unwrap();
        session_file(&sub, "bad.jsonl", "bad");
        index.execute_batch_for_test(
            "CREATE TEMP TRIGGER fail_bad BEFORE INSERT ON sessions WHEN NEW.id = 'bad'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        );
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        tx.send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)))
            .unwrap();
        let worker = {
            let index = index.clone();
            let notifier = notifier.clone();
            std::thread::spawn(move || {
                run(
                    &rx,
                    &index,
                    &notifier,
                    Duration::from_millis(10),
                    Duration::from_millis(20),
                    false,
                )
            })
        };
        // 失败前写入的 a 照常通知前端
        assert!(wait_until(|| !seen.lock().unwrap().is_empty()));
        assert_eq!(index.list(None, None).unwrap().items.len(), 1);
        index.execute_batch_for_test("DROP TRIGGER fail_bad;");
        assert!(
            wait_until(|| index.list(None, None).unwrap().items.len() == 2),
            "扫描失败后没有重新安排全量扫描"
        );
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn concurrent_notifications_arrive_in_order() {
        let (notifier, seen) = recorder();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    for _ in 0..200 {
                        notifier.notify();
                    }
                });
            }
        });
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 800);
        assert!(seen.windows(2).all(|w| w[1] == w[0] + 1));
    }

    #[test]
    fn unchanged_files_do_not_notify() {
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        let a = session_file(&dir.0, "a.jsonl", "a");
        index.update_file(&a).unwrap();
        let (notifier, seen) = recorder();
        let (tx, rx) = mpsc::channel();
        created(&tx, a);
        drop(tx);
        run(
            &rx,
            &index,
            &notifier,
            Duration::from_millis(10),
            Duration::from_millis(10),
            false,
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn watcher_picks_up_new_session_files() {
        let dir = TempDir::new();
        let index = Arc::new(SessionIndex::open_in_memory(&dir.0).unwrap());
        let (notifier, seen) = recorder();
        let _worker = start(index.clone(), notifier);
        // 等首次扫描的通知，确认监听已建立
        let wait = |n: usize| {
            let start = Instant::now();
            while seen.lock().unwrap().len() < n && start.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait(1);
        session_file(&dir.0, "new.jsonl", "n");
        let start = Instant::now();
        while index.list(None, None).unwrap().items.is_empty()
            && start.elapsed() < Duration::from_secs(10)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(index.list(None, None).unwrap().items[0].id, "n");
        wait(2);
        assert!(seen.lock().unwrap().len() >= 2);
    }
}
