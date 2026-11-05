//! Core RPC 桥（技术方案第 5.4、7 章）：stdin 写队列、stdout 只按 LF 分帧并去 \r、16ms 合批、Channel 推送、64MB 缓冲。
//!
//! 每个 Core 进程一座桥，三条线程：
//! - **写线程**：前端 `core_send` 的记录序列化为一行 JSON 放进有界队列，由写线程写入 stdin；
//!   Core 读得慢时阻塞的是写线程，不是 invoke 调用方；队列满时返回 [`BridgeError::QueueFull`]。
//! - **读线程**：持续读取 stdout（绝不因前端卡顿停读，否则 Core 因背压阻塞），[`LineFramer`] 分帧，
//!   每帧校验为 JSON 后原样（不改字节）放进待推缓冲。待推缓冲与分帧器中未成帧的尾部**合计**不超过上限
//!   （默认 64MB）：超出时丢弃最旧的已成帧记录并计数（未成帧的尾部是最新的数据，优先保留）；
//!   单帧（含未成帧的尾部）本身超过上限时丢弃该帧。合批线程已取出、正在推送的那一批不在此列，
//!   其大小受 [`MAX_BATCH_BYTES`] 约束。
//! - **合批线程**：有记录到达后最多等 16ms，把缓冲中的记录打成一个 [`CoreBatch`]（第 7.3 节：`sessionKey`、
//!   按会话单调递增的 `seq`、`records`、`dropped`）交给 [`BatchSink`]（Tauri `Channel`）。
//!   `dropped` 非零时前端用 `get_messages` + `get_state` 重建会话状态。
//! - 忙碌状态：读线程只看每条记录的 `type` 字段（第 5.1 节“只解析少量字段”），`agent_start` 到 `agent_settled`
//!   之间视为忙碌，供进程上限只淘汰空闲进程（第 2.2 节）。

// 统计等接口留给健康检查与诊断（后续接入）；非测试构建放行未使用告警。
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::VecDeque;
use std::fmt;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// 合批窗口（第 5.4、7.3 节）。
pub(crate) const BATCH_INTERVAL: Duration = Duration::from_millis(16);
/// 待推缓冲上限（第 5.4 节）。
pub(crate) const BUFFER_LIMIT: usize = 64 * 1024 * 1024;
/// 单个批次的记录字节上限：积压很多时拆成多批，避免一次 IPC 过大。
pub(crate) const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
/// stdin 写队列容量（条）。
pub(crate) const WRITE_QUEUE_CAPACITY: usize = 1024;
/// 每次从 stdout 读取的块大小。
const READ_CHUNK: usize = 64 * 1024;

/// Core stdout 的 JSONL 分帧器。
///
/// 只按 `\n`（LF）切分，并去掉行尾的一个 `\r`；`U+2028`、`U+2029` 等字符原样留在帧内
/// （它们在 JSON 字符串里合法，把它们当换行的通用行读取器会把一条记录切断）。
/// 不完整的尾部留在缓冲区，与下一块数据拼接；空行跳过。按字节处理，
/// 因为 UTF-8 多字节字符的任何字节都不会是 `0x0A`，块边界落在字符中间也不影响分帧。
#[derive(Debug, Default)]
pub(crate) struct LineFramer {
    buf: Vec<u8>,
    /// `buf` 开头已确认不含 LF 的字节数：下次只扫描新追加的部分，
    /// 大帧分成许多小块到达时总扫描量保持线性。
    scanned: usize,
    /// 正在丢弃一个超长帧：跳过字节直到下一个 LF
    discarding: bool,
}

impl LineFramer {
    /// 追加一块原始字节，返回其中所有完整的帧（不含行尾）。
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut chunk = chunk;
        if self.discarding {
            match chunk.iter().position(|&b| b == b'\n') {
                Some(pos) => {
                    chunk = &chunk[pos + 1..];
                    self.discarding = false;
                }
                None => return Vec::new(),
            }
        }
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut start = 0;
        let mut search_from = self.scanned;
        while let Some(offset) = self.buf[search_from..].iter().position(|&b| b == b'\n') {
            let end = search_from + offset;
            let line = &self.buf[start..end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if !line.is_empty() {
                frames.push(line.to_vec());
            }
            start = end + 1;
            search_from = start;
        }
        self.buf.drain(..start);
        // 剩下的都是不含 LF 的不完整尾部
        self.scanned = self.buf.len();
        frames
    }

    /// 缓冲区中尚未成帧的字节数（供 64MB 缓冲上限判断）。
    pub(crate) fn pending_len(&self) -> usize {
        self.buf.len()
    }

    /// 丢弃当前不完整的帧，并跳过其后续字节直到下一个 LF（单帧超过缓冲上限时调用）。
    pub(crate) fn discard_partial(&mut self) {
        self.buf = Vec::new();
        self.scanned = 0;
        self.discarding = true;
    }
}

/// 推给前端的一个批次（第 7.3 节）。`records` 是 Core 输出的原始 JSON，薄壳不修改内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreBatch {
    pub(crate) session_key: String,
    pub(crate) seq: u64,
    pub(crate) records: Vec<Box<RawValue>>,
    pub(crate) dropped: u64,
}

/// 批次的去处。返回 false 表示接收端已关闭（之后的批次照常生成并丢弃，stdout 仍持续读取）。
pub(crate) trait BatchSink: Send + 'static {
    fn send(&self, batch: CoreBatch) -> bool;
}

impl BatchSink for tauri::ipc::Channel<CoreBatch> {
    fn send(&self, batch: CoreBatch) -> bool {
        tauri::ipc::Channel::send(self, batch).is_ok()
    }
}

/// 桥的参数（测试可调小）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct BridgeConfig {
    pub(crate) batch_interval: Duration,
    pub(crate) buffer_limit: usize,
    pub(crate) max_batch_bytes: usize,
    pub(crate) write_queue_capacity: usize,
    /// 第一批之前的序号：重启后的新桥从旧桥的最后一批接着编号，前端的 `seq` 保持单调递增（第 7.3 节）
    pub(crate) first_seq: u64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            batch_interval: BATCH_INTERVAL,
            buffer_limit: BUFFER_LIMIT,
            max_batch_bytes: MAX_BATCH_BYTES,
            write_queue_capacity: WRITE_QUEUE_CAPACITY,
            first_seq: 0,
        }
    }
}

/// 写入 Core 失败的原因。
#[derive(Debug)]
pub(crate) enum BridgeError {
    /// 写队列已满（Core 长时间不读 stdin）
    QueueFull,
    /// Core 的 stdin 已关闭（进程退出或写入失败）
    Closed,
    /// 记录无法序列化
    Encode(serde_json::Error),
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::QueueFull => write!(f, "内核写队列已满"),
            Self::Closed => write!(f, "内核输入已关闭"),
            Self::Encode(e) => write!(f, "记录序列化失败：{e}"),
        }
    }
}

impl std::error::Error for BridgeError {}

/// 运行统计。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BridgeStats {
    /// 从 stdout 收到的有效记录数
    pub(crate) received: u64,
    /// 因缓冲溢出丢弃的记录数（含超长帧）
    pub(crate) dropped: u64,
    /// 不是合法 JSON 而被跳过的帧数
    pub(crate) invalid: u64,
    /// 已推出的批次数
    pub(crate) batches: u64,
}

#[derive(Default)]
struct Pending {
    records: VecDeque<Box<RawValue>>,
    bytes: usize,
    /// 自上一批次以来丢弃的记录数，随下一批次报告
    dropped: u64,
    /// stdout 已读到 EOF
    closed: bool,
}

struct Shared {
    pending: Mutex<Pending>,
    ready: Condvar,
    received: AtomicU64,
    dropped: AtomicU64,
    invalid: AtomicU64,
    batches: AtomicU64,
    /// 写线程已退出（stdin 关闭）
    writer_closed: AtomicBool,
    /// Core 正在运行一轮（`agent_start` 到 `agent_settled` 之间）
    turn: AtomicBool,
    /// prompt 已响应 `disposition: "started"`、尚未收到 `agent_start`（响应先于事件到达时的空档）
    starting: AtomicBool,
    /// 已写入、尚未收到响应的 prompt 条数：写入即算忙碌，不留“已发 prompt、未到 agent_start”的空档
    prompts: AtomicU64,
}

impl Shared {
    fn is_busy(&self) -> bool {
        self.prompts.load(Ordering::Acquire) > 0
            || self.starting.load(Ordering::Acquire)
            || self.turn.load(Ordering::Acquire)
    }

    /// 收到一条 prompt 的响应（或写入失败）：未响应计数减一，不减到 0 以下
    fn prompt_answered(&self) {
        let mut n = self.prompts.load(Ordering::Acquire);
        while n > 0 {
            match self
                .prompts
                .compare_exchange_weak(n, n - 1, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(current) => n = current,
            }
        }
    }

    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 放入一条记录；超过上限时丢弃最旧的记录。
    fn push(&self, record: Box<RawValue>, limit: usize) {
        let len = record.get().len();
        let mut pending = self.pending();
        self.evict_oldest(&mut pending, limit.saturating_sub(len));
        pending.bytes += len;
        pending.records.push_back(record);
        drop(pending);
        self.received.fetch_add(1, Ordering::Relaxed);
        self.ready.notify_one();
    }

    /// 丢弃最旧的记录，直到待推缓冲不超过 `limit` 字节（为未成帧的尾部腾出空间）。
    fn trim(&self, limit: usize) {
        let mut pending = self.pending();
        if self.evict_oldest(&mut pending, limit) {
            drop(pending);
            self.ready.notify_one();
        }
    }

    /// 从队首丢弃记录直到 `bytes <= limit`；返回是否丢弃过。
    fn evict_oldest(&self, pending: &mut Pending, limit: usize) -> bool {
        let mut evicted = false;
        while pending.bytes > limit {
            let Some(old) = pending.records.pop_front() else {
                break;
            };
            pending.bytes -= old.get().len();
            pending.dropped += 1;
            self.dropped.fetch_add(1, Ordering::Relaxed);
            evicted = true;
        }
        evicted
    }

    /// 记一次丢弃（超长帧）。
    fn drop_one(&self) {
        self.pending().dropped += 1;
        self.dropped.fetch_add(1, Ordering::Relaxed);
        self.ready.notify_one();
    }

    fn close(&self) {
        self.pending().closed = true;
        self.ready.notify_all();
    }
}

/// 一个 Core 进程的 RPC 桥。drop 时关闭写队列（Core 的 stdin 随之关闭）；读、合批线程在 stdout EOF 后自行结束。
pub(crate) struct Bridge {
    writer: Option<SyncSender<Vec<u8>>>,
    first_seq: u64,
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl Bridge {
    /// 接管 Core 的 stdin / stdout，启动三条线程。
    pub(crate) fn start<W, R, S>(
        session_key: String,
        stdin: W,
        stdout: R,
        sink: S,
        config: BridgeConfig,
    ) -> io::Result<Self>
    where
        W: Write + Send + 'static,
        R: Read + Send + 'static,
        S: BatchSink,
    {
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending::default()),
            ready: Condvar::new(),
            received: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            invalid: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            writer_closed: AtomicBool::new(false),
            turn: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            prompts: AtomicU64::new(0),
        });
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(config.write_queue_capacity.max(1));

        let mut threads = Vec::with_capacity(3);
        let writer_shared = Arc::clone(&shared);
        threads.push(
            std::thread::Builder::new()
                .name("core-stdin".into())
                .spawn(move || {
                    let mut stdin = stdin;
                    for line in rx {
                        if stdin.write_all(&line).and_then(|()| stdin.flush()).is_err() {
                            break;
                        }
                    }
                    writer_shared.writer_closed.store(true, Ordering::Release);
                })?,
        );
        let reader_shared = Arc::clone(&shared);
        threads.push(
            std::thread::Builder::new()
                .name("core-stdout".into())
                .spawn(move || read_loop(stdout, &reader_shared, config.buffer_limit))?,
        );
        let batch_shared = Arc::clone(&shared);
        threads.push(
            std::thread::Builder::new()
                .name("core-batch".into())
                .spawn(move || batch_loop(&session_key, &batch_shared, &sink, config))?,
        );

        Ok(Self {
            writer: Some(tx),
            first_seq: config.first_seq,
            shared,
            threads,
        })
    }

    /// 把一条 RPC 记录写入 Core 的 stdin（序列化为一行 JSON + LF）。不阻塞。
    pub(crate) fn send(&self, record: &serde_json::Value) -> Result<(), BridgeError> {
        let mut line = serde_json::to_vec(record).map_err(BridgeError::Encode)?;
        line.push(b'\n');
        // 先记为忙碌再入队：调用方（会话表）在同一把锁下写入与挑选淘汰对象，写入成功的 prompt 不会被淘汰
        let prompt = record.get("type").and_then(serde_json::Value::as_str) == Some("prompt");
        if prompt {
            self.shared.prompts.fetch_add(1, Ordering::AcqRel);
        }
        let result = self.send_line(line);
        if prompt && result.is_err() {
            self.shared.prompt_answered();
        }
        result
    }

    fn send_line(&self, line: Vec<u8>) -> Result<(), BridgeError> {
        if self.shared.writer_closed.load(Ordering::Acquire) {
            return Err(BridgeError::Closed);
        }
        let writer = self.writer.as_ref().ok_or(BridgeError::Closed)?;
        writer.try_send(line).map_err(|e| match e {
            TrySendError::Full(_) => BridgeError::QueueFull,
            TrySendError::Disconnected(_) => BridgeError::Closed,
        })
    }

    /// Core 是否正在运行一轮（`agent_start` 之后、`agent_settled` 之前），或有已写入、未响应的 prompt。
    pub(crate) fn is_busy(&self) -> bool {
        self.shared.is_busy()
    }

    pub(crate) fn stats(&self) -> BridgeStats {
        BridgeStats {
            received: self.shared.received.load(Ordering::Relaxed),
            dropped: self.shared.dropped.load(Ordering::Relaxed),
            invalid: self.shared.invalid.load(Ordering::Relaxed),
            batches: self.shared.batches.load(Ordering::Relaxed),
        }
    }

    /// 同 [`Bridge::join`]，返回已推出的最后一批的序号（一批也没有时为 `first_seq`），供重启后的新桥接着编号。
    pub(crate) fn finish(self) -> u64 {
        let first_seq = self.first_seq;
        first_seq + self.join().batches
    }

    /// 关闭写队列并等待三条线程结束（Core 已退出、stdout 已 EOF 时调用，否则会一直等到 EOF）。
    pub(crate) fn join(mut self) -> BridgeStats {
        self.writer.take();
        for handle in self.threads.drain(..) {
            let _ = handle.join();
        }
        self.stats()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // 只关闭写队列，不等待线程：stdout 读线程要到 Core 退出才结束
        self.writer.take();
    }
}

/// 读线程：持续读 stdout、分帧、校验 JSON、放入缓冲。
fn read_loop<R: Read>(mut stdout: R, shared: &Shared, limit: usize) {
    let mut framer = LineFramer::default();
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        let n = match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let frames = framer.push(&chunk[..n]);
        // 未成帧的尾部本身超限：丢弃该帧
        if framer.pending_len() > limit {
            framer.discard_partial();
            shared.drop_one();
        }
        // 待推缓冲 + 未成帧尾部合计不超过上限：尾部占用的部分从待推缓冲的额度中扣除
        let budget = limit - framer.pending_len();
        for frame in frames {
            accept_frame(frame, shared, budget);
        }
        shared.trim(budget);
    }
    // stdout EOF：进程已退出，不再忙碌
    shared.turn.store(false, Ordering::Release);
    shared.starting.store(false, Ordering::Release);
    shared.prompts.store(0, Ordering::Release);
    shared.close();
}

fn accept_frame(frame: Vec<u8>, shared: &Shared, limit: usize) {
    if frame.len() > limit {
        shared.drop_one();
        return;
    }
    let parsed = String::from_utf8(frame)
        .ok()
        .and_then(|text| RawValue::from_string(text).ok());
    match parsed {
        Some(record) => {
            track_busy(shared, &record);
            shared.push(record, limit);
        }
        None => {
            shared.invalid.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// 只读记录的 `type`，以及 prompt 响应的 `command`、`success`、`data.disposition`（其余字段跳过，不改动记录）。
#[derive(Deserialize)]
struct RecordType<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<&'a str>,
    #[serde(borrow, default)]
    command: Option<&'a str>,
    #[serde(default)]
    success: Option<bool>,
    #[serde(borrow, default)]
    data: Option<ResponseData<'a>>,
}

#[derive(Deserialize)]
struct ResponseData<'a> {
    #[serde(borrow, default)]
    disposition: Option<&'a str>,
}

fn track_busy(shared: &Shared, record: &RawValue) {
    let Ok(RecordType {
        kind: Some(kind),
        command,
        success,
        data,
    }) = serde_json::from_str(record.get())
    else {
        return;
    };
    match kind {
        "agent_start" => {
            shared.turn.store(true, Ordering::Release);
            shared.starting.store(false, Ordering::Release);
        }
        "agent_settled" => {
            shared.turn.store(false, Ordering::Release);
            shared.starting.store(false, Ordering::Release);
        }
        "response" if command == Some("prompt") => {
            // 已开始的一轮在 agent_start 到达前仍算忙碌：先置 starting 再结清未响应计数，忙碌不出现空档
            let started = data.and_then(|d| d.disposition) == Some("started");
            if success == Some(true) && started && !shared.turn.load(Ordering::Acquire) {
                shared.starting.store(true, Ordering::Release);
            }
            shared.prompt_answered();
        }
        _ => {}
    }
}

/// 合批线程：有记录后等满一个合批窗口，再按字节上限分批推出。
fn batch_loop(session_key: &str, shared: &Shared, sink: &dyn BatchSink, config: BridgeConfig) {
    let mut seq = config.first_seq;
    loop {
        // 等待第一条记录（或丢弃计数、或关闭）
        let mut pending = shared.pending();
        while pending.records.is_empty() && pending.dropped == 0 && !pending.closed {
            pending = shared
                .ready
                .wait(pending)
                .unwrap_or_else(PoisonError::into_inner);
        }
        if pending.records.is_empty() && pending.dropped == 0 && pending.closed {
            return;
        }
        // 合批窗口：让 16ms 内到达的记录并进同一批
        if !pending.closed {
            let deadline = Instant::now() + config.batch_interval;
            loop {
                let now = Instant::now();
                if now >= deadline || pending.closed {
                    break;
                }
                pending = shared
                    .ready
                    .wait_timeout(pending, deadline - now)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        }
        // 取出至多 max_batch_bytes 的记录（至少一条）
        let mut records = Vec::new();
        let mut bytes = 0;
        while let Some(front) = pending.records.front() {
            let len = front.get().len();
            if !records.is_empty() && bytes + len > config.max_batch_bytes {
                break;
            }
            bytes += len;
            pending.bytes -= len;
            records.extend(pending.records.pop_front());
        }
        let dropped = std::mem::take(&mut pending.dropped);
        drop(pending);

        seq += 1;
        shared.batches.fetch_add(1, Ordering::Relaxed);
        // 接收端关闭后仍继续消费，保证读线程不被缓冲上限之外的因素阻塞
        let _ = sink.send(CoreBatch {
            session_key: session_key.to_owned(),
            seq,
            records,
            dropped,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_str(framer: &mut LineFramer, chunk: &str) -> Vec<String> {
        framer
            .push(chunk.as_bytes())
            .into_iter()
            .map(|frame| String::from_utf8(frame).expect("帧应为合法 UTF-8"))
            .collect()
    }

    #[test]
    fn splits_on_lf_and_strips_trailing_cr() {
        let mut framer = LineFramer::default();
        let frames = push_str(&mut framer, "{\"a\":1}\r\n{\"b\":2}\n");
        assert_eq!(frames, vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(framer.pending_len(), 0);
    }

    #[test]
    fn keeps_unicode_line_separators_inside_frame() {
        let mut framer = LineFramer::default();
        let record = "{\"text\":\"a\u{2028}b\u{2029}c\u{0085}d\"}";
        let frames = push_str(&mut framer, &format!("{record}\n"));
        assert_eq!(frames, vec![record]);
    }

    #[test]
    fn buffers_partial_frame_across_chunks() {
        let mut framer = LineFramer::default();
        assert!(push_str(&mut framer, "{\"type\":\"mess").is_empty());
        assert_eq!(framer.pending_len(), 13);
        // CR 与 LF 落在两块数据里，CR 仍应被去掉
        assert!(push_str(&mut framer, "age\"}\r").is_empty());
        assert_eq!(push_str(&mut framer, "\n"), vec!["{\"type\":\"message\"}"]);
        assert_eq!(framer.pending_len(), 0);
    }

    #[test]
    fn handles_multibyte_char_split_between_chunks() {
        let mut framer = LineFramer::default();
        let bytes = "{\"text\":\"乾元\"}\n".as_bytes();
        // "乾" 占 3 字节，从它中间切开
        let split = "{\"text\":\"".len() + 1;
        assert!(framer.push(&bytes[..split]).is_empty());
        let frames = framer.push(&bytes[split..]);
        assert_eq!(
            frames,
            vec![b"{\"text\":\"\xE4\xB9\xBE\xE5\x85\x83\"}".to_vec()]
        );
    }

    #[test]
    fn scans_only_new_bytes_across_many_small_chunks() {
        let mut framer = LineFramer::default();
        for _ in 0..1000 {
            assert!(framer.push(b"ab").is_empty());
        }
        assert_eq!(framer.pending_len(), 2000);
        // 一块里同时有上一帧的结尾、LF 与下一帧的开头
        let frames = framer.push(b"c\n{\"x\"");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), 2001);
        assert_eq!(framer.pending_len(), 4);
        assert_eq!(push_str(&mut framer, ":1}\n"), vec!["{\"x\":1}"]);
        assert_eq!(framer.pending_len(), 0);
    }

    #[test]
    fn skips_empty_lines() {
        let mut framer = LineFramer::default();
        let frames = push_str(&mut framer, "\n\r\n{}\n\n");
        assert_eq!(frames, vec!["{}"]);
    }

    #[test]
    fn discard_partial_skips_until_next_lf() {
        let mut framer = LineFramer::default();
        assert!(framer.push(b"{\"huge\":\"aaaa").is_empty());
        framer.discard_partial();
        assert_eq!(framer.pending_len(), 0);
        assert!(framer.push(b"bbbbbb").is_empty());
        assert_eq!(framer.pending_len(), 0);
        assert_eq!(
            push_str(&mut framer, "cc\"}\n{\"ok\":1}\n"),
            vec!["{\"ok\":1}"]
        );
    }

    /// 收集批次的测试接收端；`delay` 模拟前端卡顿。
    /// (seq, records, dropped)
    type Received = Arc<Mutex<Vec<(u64, Vec<String>, u64)>>>;

    #[derive(Clone, Default)]
    struct Collect {
        batches: Received,
        delay: Duration,
    }

    impl BatchSink for Collect {
        fn send(&self, batch: CoreBatch) -> bool {
            if !self.delay.is_zero() {
                std::thread::sleep(self.delay);
            }
            assert_eq!(batch.session_key, "s");
            let records = batch.records.iter().map(|r| r.get().to_owned()).collect();
            self.batches
                .lock()
                .unwrap()
                .push((batch.seq, records, batch.dropped));
            true
        }
    }

    impl Collect {
        fn records(&self) -> Vec<String> {
            self.batches
                .lock()
                .unwrap()
                .iter()
                .flat_map(|(_, r, _)| r.clone())
                .collect()
        }
    }

    /// 只读不写的 stdin 占位。
    struct NullWriter;
    impl Write for NullWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// 按给定块切分的 stdout。
    struct Chunks(VecDeque<Vec<u8>>);
    impl Read for Chunks {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let Some(mut chunk) = self.0.pop_front() else {
                return Ok(0);
            };
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            if n < chunk.len() {
                self.0.push_front(chunk.split_off(n));
            }
            Ok(n)
        }
    }

    #[test]
    fn records_are_forwarded_unchanged_with_increasing_seq() {
        let sink = Collect::default();
        let input = "{\"type\":\"a\", \"x\": 1}\r\nnot json\n{\"type\":\"b\",\"t\":\"\u{2028}\"}\n";
        let chunks = input.as_bytes().chunks(3).map(<[u8]>::to_vec).collect();
        let bridge = Bridge::start(
            "s".into(),
            NullWriter,
            Chunks(chunks),
            sink.clone(),
            BridgeConfig::default(),
        )
        .unwrap();
        let stats = bridge.join();
        assert_eq!(
            sink.records(),
            vec![
                "{\"type\":\"a\", \"x\": 1}".to_owned(),
                "{\"type\":\"b\",\"t\":\"\u{2028}\"}".to_owned()
            ],
            "原样转发（含空格与 U+2028），非 JSON 帧跳过"
        );
        assert_eq!(stats.received, 2);
        assert_eq!(stats.invalid, 1);
        assert_eq!(stats.dropped, 0);
        let seqs: Vec<u64> = sink.batches.lock().unwrap().iter().map(|b| b.0).collect();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
        assert_eq!(seqs.first(), Some(&1));
    }

    #[test]
    fn batch_serializes_in_protocol_shape() {
        let batch = CoreBatch {
            session_key: "ws1:sess-01".into(),
            seq: 7,
            records: vec![RawValue::from_string("{\"type\":\"x\"}".into()).unwrap()],
            dropped: 0,
        };
        assert_eq!(
            serde_json::to_string(&batch).unwrap(),
            "{\"sessionKey\":\"ws1:sess-01\",\"seq\":7,\"records\":[{\"type\":\"x\"}],\"dropped\":0}"
        );
    }

    #[test]
    fn overflow_drops_oldest_and_reports_dropped() {
        // 前端卡住：每批耗时 200ms，缓冲只有 100 字节
        let sink = Collect {
            delay: Duration::from_millis(200),
            ..Default::default()
        };
        let mut input = String::new();
        for i in 0..100 {
            input.push_str(&format!("{{\"i\":\"{i:03}\"}}\n"));
        }
        let config = BridgeConfig {
            buffer_limit: 100,
            ..Default::default()
        };
        let started = Instant::now();
        let bridge = Bridge::start(
            "s".into(),
            NullWriter,
            Chunks(VecDeque::from([input.into_bytes()])),
            sink.clone(),
            config,
        )
        .unwrap();
        let stats = bridge.join();
        assert!(started.elapsed() < Duration::from_secs(5));
        let batches = sink.batches.lock().unwrap();
        let delivered: u64 = batches.iter().map(|b| b.1.len() as u64).sum();
        let reported: u64 = batches.iter().map(|b| b.2).sum();
        assert_eq!(stats.received, 100);
        assert!(stats.dropped > 0);
        assert_eq!(reported, stats.dropped, "丢弃数全部随批次报告");
        assert_eq!(delivered + stats.dropped, 100);
        // 留下的是最新的记录
        assert_eq!(batches.last().unwrap().1.last().unwrap(), "{\"i\":\"099\"}");
    }

    #[test]
    fn oversized_frame_is_dropped_without_stalling() {
        let sink = Collect::default();
        let mut input = vec![b'{'; 300];
        input.extend_from_slice(b"\n{\"ok\":1}\n");
        let config = BridgeConfig {
            buffer_limit: 100,
            ..Default::default()
        };
        let chunks = input.chunks(32).map(<[u8]>::to_vec).collect();
        let bridge =
            Bridge::start("s".into(), NullWriter, Chunks(chunks), sink.clone(), config).unwrap();
        let stats = bridge.join();
        assert_eq!(sink.records(), vec!["{\"ok\":1}".to_owned()]);
        assert_eq!(stats.dropped, 1);
    }

    #[test]
    fn pending_and_partial_frame_share_one_limit() {
        // 不启动合批线程（模拟前端停滞），直接驱动读循环
        let shared = Shared {
            pending: Mutex::new(Pending::default()),
            ready: Condvar::new(),
            received: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            invalid: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            writer_closed: AtomicBool::new(false),
            turn: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            prompts: AtomicU64::new(0),
        };
        // 8 条 11 字节的记录（88 字节），随后是 60 字节、尚未收到 LF 的大帧
        let mut records = String::new();
        for i in 0..8 {
            records.push_str(&format!("{{\"i\":\"{i:03}\"}}\n"));
        }
        let partial = vec![b'x'; 60];
        let chunks = VecDeque::from([records.into_bytes(), partial]);
        read_loop(Chunks(chunks), &shared, 100);

        let pending = shared.pending();
        assert!(
            pending.bytes + 60 <= 100,
            "待推 {} 字节 + 尾部 60 字节超限",
            pending.bytes
        );
        let kept: Vec<&str> = pending.records.iter().map(|r| r.get()).collect();
        // 丢的是最旧的记录，保留最新的 3 条
        assert_eq!(
            kept,
            ["{\"i\":\"005\"}", "{\"i\":\"006\"}", "{\"i\":\"007\"}"]
        );
        assert_eq!(pending.dropped, 5);
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 5);
    }

    #[test]
    fn large_backlog_is_split_by_batch_bytes() {
        let sink = Collect::default();
        let line = format!("{{\"p\":\"{}\"}}\n", "x".repeat(1000));
        let input = line.repeat(50);
        let config = BridgeConfig {
            max_batch_bytes: 10_000,
            batch_interval: Duration::from_millis(200),
            ..Default::default()
        };
        let bridge = Bridge::start(
            "s".into(),
            NullWriter,
            Chunks(VecDeque::from([input.into_bytes()])),
            sink.clone(),
            config,
        )
        .unwrap();
        bridge.join();
        let batches = sink.batches.lock().unwrap();
        assert!(batches.len() >= 5);
        assert!(batches.iter().all(|b| b.1.len() <= 10));
        assert_eq!(batches.iter().map(|b| b.1.len()).sum::<usize>(), 50);
        let seqs: Vec<u64> = batches.iter().map(|b| b.0).collect();
        assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
    }

    /// 回显 stdin 的每一行，并按要求输出大量记录。
    const ECHO_CORE: &str = r#"
// 只按 \n 分帧：readline 会把 U+2028/U+2029 当换行，切断含这些字符的命令
let pending = "";
const handle = (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "flood") {
    const payload = "x".repeat(cmd.size);
    let i = 0;
    const write = () => {
      while (i < cmd.count) {
        const ok = process.stdout.write(JSON.stringify({ type: "chunk", i, payload }) + "\n");
        i++;
        if (!ok) return process.stdout.once("drain", write);
      }
      process.stdout.write(JSON.stringify({ type: "done", id: cmd.id }) + "\n");
    };
    write();
  } else {
    process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, echo: cmd }) + "\n");
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl).replace(/\r$/, "");
    pending = pending.slice(nl + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
"#;

    fn spawn_echo() -> std::process::Child {
        std::process::Command::new("node")
            .args(["-e", ECHO_CORE])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("需要 PATH 中有 node")
    }

    fn wait_for(sink: &Collect, pred: impl Fn(&[String]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !pred(&sink.records()) {
            assert!(Instant::now() < deadline, "等待记录超时");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn tracks_busy_between_agent_start_and_settled() {
        let run = |lines: &str| {
            let sink = Collect::default();
            // 管道保持打开：读到 EOF（进程退出）会清除忙碌
            let (reader, mut pipe_writer) = std::io::pipe().unwrap();
            pipe_writer.write_all(lines.as_bytes()).unwrap();
            let bridge = Bridge::start(
                "s".into(),
                NullWriter,
                reader,
                sink.clone(),
                BridgeConfig::default(),
            )
            .unwrap();
            let n = lines.lines().count();
            wait_for(&sink, |r| r.len() == n);
            let busy = bridge.is_busy();
            drop(pipe_writer);
            bridge.join();
            busy
        };
        assert!(run(
            "{\"type\":\"agent_start\"}\n{\"type\":\"message_update\"}\n"
        ));
        assert!(!run(
            "{\"type\":\"agent_start\"}\n{\"type\":\"agent_settled\",\"aborted\":false}\n"
        ));
        // 字段顺序、转义与非对象记录不影响判断
        assert!(run("{\"id\":\"x\",\"type\":\"agent_start\"}\n[1]\n\"s\"\n"));
        assert!(!run(
            "{\"type\":\"response\",\"command\":\"agent_start\"}\n"
        ));
    }

    #[test]
    fn prompt_counts_as_busy_from_write_until_turn_settles() {
        let shared = Shared {
            pending: Mutex::new(Pending::default()),
            ready: Condvar::new(),
            received: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            invalid: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            writer_closed: AtomicBool::new(false),
            turn: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            prompts: AtomicU64::new(0),
        };
        let feed = |line: &str| track_busy(&shared, &RawValue::from_string(line.into()).unwrap());
        // 写入的 prompt（Bridge::send 计数）
        shared.prompts.fetch_add(1, Ordering::AcqRel);
        assert!(shared.is_busy(), "写入即忙碌");
        // 响应先于 agent_start：之间不出现空闲
        feed(
            r#"{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}"#,
        );
        assert!(shared.is_busy());
        feed(r#"{"type":"agent_start"}"#);
        assert!(shared.is_busy());
        feed(r#"{"type":"agent_settled","aborted":false}"#);
        assert!(!shared.is_busy());
        // agent_start 先于响应：本轮结束后同样空闲
        shared.prompts.fetch_add(1, Ordering::AcqRel);
        feed(r#"{"type":"agent_start"}"#);
        feed(
            r#"{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}"#,
        );
        feed(r#"{"type":"agent_settled","aborted":false}"#);
        assert!(!shared.is_busy());
        // 被拒绝的 prompt 结清计数；多余的响应不减到 0 以下
        shared.prompts.fetch_add(1, Ordering::AcqRel);
        feed(r#"{"type":"response","command":"prompt","success":false,"error":"x"}"#);
        assert!(!shared.is_busy());
        feed(r#"{"type":"response","command":"prompt","success":false}"#);
        assert_eq!(shared.prompts.load(Ordering::Acquire), 0);
        // 其他命令的响应不影响
        shared.prompts.fetch_add(1, Ordering::AcqRel);
        feed(r#"{"type":"response","command":"get_state","success":true}"#);
        assert!(shared.is_busy());
    }

    #[test]
    fn two_outstanding_prompts_stay_busy_until_both_answered() {
        let shared = Shared {
            pending: Mutex::new(Pending::default()),
            ready: Condvar::new(),
            received: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            invalid: AtomicU64::new(0),
            batches: AtomicU64::new(0),
            writer_closed: AtomicBool::new(false),
            turn: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            prompts: AtomicU64::new(0),
        };
        let feed = |line: &str| track_busy(&shared, &RawValue::from_string(line.into()).unwrap());
        // 两条 prompt 先后写入，均未响应：一次响应只结清一条
        shared.prompts.fetch_add(1, Ordering::AcqRel);
        shared.prompts.fetch_add(1, Ordering::AcqRel);
        feed(r#"{"type":"response","command":"prompt","success":true}"#);
        assert_eq!(shared.prompts.load(Ordering::Acquire), 1);
        assert!(shared.is_busy());
        // 本轮结束时仍有未响应的 prompt：保持忙碌
        feed(r#"{"type":"agent_settled","aborted":false}"#);
        assert!(shared.is_busy());
        feed(r#"{"type":"response","command":"prompt","success":true}"#);
        assert_eq!(shared.prompts.load(Ordering::Acquire), 0);
        assert!(!shared.is_busy());
    }

    #[test]
    fn send_marks_prompt_busy_before_core_answers() {
        let (reader, pipe_writer) = std::io::pipe().unwrap();
        let bridge = Bridge::start(
            "s".into(),
            NullWriter,
            reader,
            Collect::default(),
            BridgeConfig::default(),
        )
        .unwrap();
        bridge
            .send(&serde_json::json!({ "type": "get_state" }))
            .unwrap();
        assert!(!bridge.is_busy());
        bridge
            .send(&serde_json::json!({ "type": "prompt", "message": "hi" }))
            .unwrap();
        assert!(bridge.is_busy(), "prompt 一写入就算忙碌");
        drop(pipe_writer);
        bridge.join();
    }

    #[test]
    fn writes_commands_to_core_stdin() {
        let mut child = spawn_echo();
        let sink = Collect::default();
        let bridge = Bridge::start(
            "s".into(),
            child.stdin.take().unwrap(),
            child.stdout.take().unwrap(),
            sink.clone(),
            BridgeConfig::default(),
        )
        .unwrap();
        bridge
            .send(&serde_json::json!({ "type": "get_state", "id": "s-1", "text": "乾元\u{2028}" }))
            .unwrap();
        wait_for(&sink, |r| r.iter().any(|l| l.contains("\"s-1\"")));
        let record: serde_json::Value = serde_json::from_str(&sink.records()[0]).unwrap();
        assert_eq!(record["echo"]["text"], "乾元\u{2028}");

        let stats = bridge.join();
        let _ = child.wait();
        assert_eq!(stats.received, 1);
    }

    /// 验收：10MB/s 输出不丢不卡。Core 以全速写出约 40MB（4 万条 1KB 记录），
    /// 全部按序到达、无丢弃，且总耗时不超过 4 秒（≥ 10MB/s）。
    #[test]
    fn sustains_10mb_per_second_without_loss() {
        let mut child = spawn_echo();
        let sink = Collect::default();
        let bridge = Bridge::start(
            "s".into(),
            child.stdin.take().unwrap(),
            child.stdout.take().unwrap(),
            sink.clone(),
            BridgeConfig::default(),
        )
        .unwrap();
        let count = 40_000;
        let started = Instant::now();
        bridge
            .send(&serde_json::json!({ "type": "flood", "id": "f", "count": count, "size": 1000 }))
            .unwrap();
        wait_for(&sink, |r| r.last().is_some_and(|l| l.contains("\"done\"")));
        let elapsed = started.elapsed();

        let records = sink.records();
        assert_eq!(records.len(), count + 1);
        for (i, line) in records[..count].iter().enumerate() {
            assert!(
                line.starts_with(&format!("{{\"type\":\"chunk\",\"i\":{i},")),
                "第 {i} 条乱序或缺失"
            );
        }
        let bytes: usize = records.iter().map(String::len).sum();
        let mb_per_sec = bytes as f64 / 1_048_576.0 / elapsed.as_secs_f64();
        assert!(
            mb_per_sec >= 10.0,
            "吞吐 {mb_per_sec:.1} MB/s 低于 10 MB/s（{bytes} 字节，{elapsed:?}）"
        );

        let stats = bridge.join();
        let _ = child.wait();
        assert_eq!(stats.dropped, 0);
        assert_eq!(stats.invalid, 0);
    }
}
