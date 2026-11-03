//! 会话索引（第 10.2 节、ADR 0006）：扫描会话目录，解析 JSONL 头部、`session_info` 与消息，写入
//! `users/<SID>/app/index.db`（SQLite），并对消息文本建立 FTS5 全文索引（trigram 分词，可做中文子串匹配）。
//!
//! - 会话文件只追加：记住解析到的字节偏移（只算到最后一个 `\n`），文件变大时从偏移处继续；变小或文件头变了时整份重解析。
//! - 逐行按 `\n` 切分并去掉 `\r`（与第 5.4 节分帧规则一致），解析不了的行跳过。
//! - 索引是会话文件的派生数据：`schema_version` 不符或数据库损坏时重建；归档标记存在独立的 `archived` 表，
//!   因版本变化重建时保留。
//! - 薄壳不理解会话内容，只取列表与搜索需要的字段。

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, params};
use serde_json::Value;

/// 列表每页条数（第 10.2 节）。
pub(crate) const PAGE_SIZE: usize = 50;
/// 搜索结果上限。
pub(crate) const SEARCH_LIMIT: usize = 50;
/// 索引结构版本；改表结构时加一，旧库整体重建（`archived` 表保留）。
const SCHEMA_VERSION: i64 = 1;
/// 列表标题（首条用户消息）最多保留的字符数。
const TITLE_CHARS: usize = 200;
/// trigram 分词器能匹配的最短查询（字符数）；更短的查询改为对标题做子串匹配。
const TRIGRAM_MIN_CHARS: usize = 3;

#[derive(Debug)]
pub(crate) enum IndexError {
    Sqlite(rusqlite::Error),
    Io(io::Error),
}

impl fmt::Display for IndexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "会话索引出错：{e}"),
            Self::Io(e) => write!(f, "读取会话文件出错：{e}"),
        }
    }
}

impl std::error::Error for IndexError {}

impl From<rusqlite::Error> for IndexError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

impl From<io::Error> for IndexError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 列表与搜索返回给前端的一条会话。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    /// 会话文件绝对路径（打开、删除、归档都用它）
    pub(crate) path: String,
    pub(crate) id: String,
    /// 用户或 Core 设置的会话名；没有时前端用 `title`
    pub(crate) name: Option<String>,
    /// 首条用户消息（截断）；还没有用户消息时为空串
    pub(crate) title: String,
    /// 所属工作区（文件头 `cwd` 原样）
    pub(crate) workspace: String,
    /// 创建时间（毫秒）
    pub(crate) created_at: i64,
    /// 最后活动时间（毫秒）
    pub(crate) updated_at: i64,
    pub(crate) message_count: i64,
    pub(crate) archived: bool,
}

/// `session_list` 的一页；`next_cursor` 原样传回即得下一页，没有更多时为 None。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPage {
    pub(crate) items: Vec<SessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) next_cursor: Option<String>,
}

/// 一次更新的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Change {
    /// 索引没有变化
    Unchanged,
    /// 新增或更新了条目
    Updated,
    /// 删除了条目
    Removed,
}

impl Change {
    pub(crate) fn changed(self) -> bool {
        self != Self::Unchanged
    }
}

pub(crate) struct SessionIndex {
    conn: Mutex<Connection>,
    sessions_dir: PathBuf,
}

impl SessionIndex {
    /// 打开（必要时新建或重建）索引库。库文件损坏、不是数据库时删掉重建一次。
    pub(crate) fn open(db_path: &Path, sessions_dir: &Path) -> Result<Self, IndexError> {
        let conn = match open_and_init(db_path) {
            Ok(conn) => conn,
            Err(IndexError::Sqlite(e)) if is_corrupt(&e) => {
                remove_db_files(db_path)?;
                open_and_init(db_path)?
            }
            Err(e) => return Err(e),
        };
        Ok(Self {
            conn: Mutex::new(conn),
            sessions_dir: sessions_dir.to_path_buf(),
        })
    }

    /// 内存库：测试用；索引库文件打不开时也用它兜底（本次运行内列表可用，下次启动再试文件）。
    pub(crate) fn open_in_memory(sessions_dir: &Path) -> Result<Self, IndexError> {
        let conn = Connection::open_in_memory()?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            sessions_dir: sessions_dir.to_path_buf(),
        })
    }

    pub(crate) fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 全量扫描会话目录（及其下一层子目录）：更新有变化的文件，删除磁盘上已不存在的条目。返回索引是否有变化。
    pub(crate) fn sync_all(&self) -> Result<bool, IndexError> {
        let files = session_files(&self.sessions_dir);
        let mut changed = false;
        let mut seen = HashSet::with_capacity(files.len());
        for file in files {
            let Some(key) = file.to_str().map(str::to_owned) else {
                continue;
            };
            // 单个文件读不了（被占用、权限）不影响其他文件；下次事件或扫描再试
            match self.update_file(&file) {
                Ok(change) => changed |= change.changed(),
                Err(IndexError::Io(_)) => {}
                Err(e) => return Err(e),
            }
            seen.insert(key);
        }
        let stale: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT path FROM sessions")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut stale = Vec::new();
            for path in rows {
                let path = path?;
                if !seen.contains(&path) {
                    stale.push(path);
                }
            }
            stale
        };
        for path in stale {
            changed |= self.remove(&path)?;
        }
        Ok(changed)
    }

    /// 按一个文件的当前状态更新索引：不存在则删除条目，有变化则增量或整份解析。
    pub(crate) fn update_file(&self, path: &Path) -> Result<Change, IndexError> {
        let Some(key) = path.to_str() else {
            return Ok(Change::Unchanged);
        };
        if !is_session_file_name(path) {
            return Ok(Change::Unchanged);
        }
        let meta = match fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_file() => meta,
            Ok(_) => return self.remove(key).map(removed),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return self.remove(key).map(removed),
            Err(e) => return Err(e.into()),
        };
        let size = meta.len() as i64;
        let mtime = mtime_ms(&meta);
        let existing = self.load_state(key)?;
        if let Some(state) = &existing
            && state.file_size == size
            && state.file_mtime == mtime
        {
            return Ok(Change::Unchanged);
        }

        let mut file = File::open(path)?;
        // 增量：文件只追加，从上次解析到的完整行之后继续；文件变小或文件头变了说明被改写，整份重解析
        let resume = existing.filter(|state| {
            size >= state.parsed_offset
                && read_header_id(&mut file).ok().flatten().as_deref()
                    == Some(state.meta.id.as_str())
        });
        let (mut meta_acc, offset, full) = match resume {
            Some(state) => (Some(state.meta), state.parsed_offset, false),
            None => (None, 0, true),
        };
        file.seek(SeekFrom::Start(offset as u64))?;
        let mut reader = BufReader::new(file);
        let mut texts = Vec::new();
        let mut parsed = offset;
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = reader.read_until(b'\n', &mut line)?;
            if n == 0 || line.last() != Some(&b'\n') {
                // 末尾半行（Core 正在写）留到下次
                break;
            }
            parsed += n as i64;
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let Ok(entry) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            match meta_acc.as_mut() {
                None => match SessionMeta::from_header(&entry, mtime) {
                    Some(m) => meta_acc = Some(m),
                    // 第一条完整记录不是会话头：不是会话文件，不入索引
                    None => return self.remove(key).map(removed),
                },
                Some(m) => m.apply(&entry, &mut texts),
            }
        }
        let Some(meta_acc) = meta_acc else {
            // 还没有完整的会话头（空文件或第一行未写完）：先不入索引
            return self.remove(key).map(removed);
        };

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if full {
            tx.execute("DELETE FROM session_text WHERE path = ?1", [key])?;
        }
        upsert(
            &tx,
            key,
            &meta_acc,
            &RowFile {
                size,
                mtime,
                parsed_offset: parsed,
            },
        )?;
        if !texts.is_empty() {
            tx.execute(
                "INSERT INTO session_text (path, body) VALUES (?1, ?2)",
                params![key, texts.join("\n")],
            )?;
        }
        tx.commit()?;
        Ok(Change::Updated)
    }

    /// 删除一条会话的索引（含全文与归档标记）。返回是否删掉了条目。
    pub(crate) fn remove(&self, path: &str) -> Result<bool, IndexError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let n = tx.execute("DELETE FROM sessions WHERE path = ?1", [path])?;
        tx.execute("DELETE FROM session_text WHERE path = ?1", [path])?;
        tx.execute("DELETE FROM archived WHERE path = ?1", [path])?;
        tx.commit()?;
        Ok(n > 0)
    }

    /// 会话 ID（删除前判断会话是否打开中用）；不在索引中时为 None。
    pub(crate) fn session_id(&self, path: &str) -> Result<Option<String>, IndexError> {
        Ok(self
            .conn()
            .query_row("SELECT id FROM sessions WHERE path = ?1", [path], |row| {
                row.get(0)
            })
            .optional()?)
    }

    /// 设置或取消归档。会话不在索引中时返回 false。
    pub(crate) fn set_archived(&self, path: &str, archived: bool) -> Result<bool, IndexError> {
        let conn = self.conn();
        let exists: bool = conn
            .query_row("SELECT 1 FROM sessions WHERE path = ?1", [path], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(false);
        }
        if archived {
            conn.execute("INSERT OR IGNORE INTO archived (path) VALUES (?1)", [path])?;
        } else {
            conn.execute("DELETE FROM archived WHERE path = ?1", [path])?;
        }
        Ok(true)
    }

    /// 按最后活动时间倒序列出未归档的会话，键集分页。`workspace_key` 为 None 时列出全部工作区。
    pub(crate) fn list(
        &self,
        workspace_key: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<SessionPage, IndexError> {
        // 无法解析的游标按第一页处理
        let parsed = cursor.and_then(parse_cursor);
        let first_page = parsed.is_none();
        let (after_time, after_path) = parsed.unwrap_or((i64::MAX, String::new()));
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {SUMMARY_COLUMNS} FROM sessions s
             WHERE NOT EXISTS (SELECT 1 FROM archived a WHERE a.path = s.path)
               AND (?1 IS NULL OR s.workspace_key = ?1)
               AND (?2 OR s.updated_at < ?3 OR (s.updated_at = ?3 AND s.path < ?4))
             ORDER BY s.updated_at DESC, s.path DESC
             LIMIT ?5"
        ))?;
        let rows = stmt.query_map(
            params![
                workspace_key,
                first_page,
                after_time,
                after_path,
                (PAGE_SIZE + 1) as i64
            ],
            summary_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if items.len() > PAGE_SIZE {
            items.truncate(PAGE_SIZE);
            items.last().map(|s| format!("{}:{}", s.updated_at, s.path))
        } else {
            None
        };
        Ok(SessionPage { items, next_cursor })
    }

    /// 搜索会话（含已归档）：查询至少 3 个字符时匹配消息全文与标题，更短时只对会话名与首条消息做子串匹配。
    pub(crate) fn search(
        &self,
        workspace_key: Option<&str>,
        query: &str,
    ) -> Result<Vec<SessionSummary>, IndexError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{}%", escape_like(query));
        let conn = self.conn();
        let rows = if query.chars().count() >= TRIGRAM_MIN_CHARS {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {SUMMARY_COLUMNS} FROM sessions s
                 WHERE (?1 IS NULL OR s.workspace_key = ?1)
                   AND (s.path IN (SELECT path FROM session_text WHERE session_text MATCH ?2)
                        OR s.name LIKE ?3 ESCAPE '\\' OR s.first_message LIKE ?3 ESCAPE '\\')
                 ORDER BY s.updated_at DESC, s.path DESC
                 LIMIT ?4"
            ))?;
            stmt.query_map(
                params![workspace_key, fts_phrase(query), like, SEARCH_LIMIT as i64],
                summary_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {SUMMARY_COLUMNS} FROM sessions s
                 WHERE (?1 IS NULL OR s.workspace_key = ?1)
                   AND (s.name LIKE ?2 ESCAPE '\\' OR s.first_message LIKE ?2 ESCAPE '\\')
                 ORDER BY s.updated_at DESC, s.path DESC
                 LIMIT ?3"
            ))?;
            stmt.query_map(
                params![workspace_key, like, SEARCH_LIMIT as i64],
                summary_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    fn load_state(&self, path: &str) -> Result<Option<RowState>, IndexError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT id, workspace, name, first_message, created_at, updated_at, message_count,
                        parent_path, file_size, file_mtime, parsed_offset
                 FROM sessions WHERE path = ?1",
                [path],
                |row| {
                    Ok(RowState {
                        meta: SessionMeta {
                            id: row.get(0)?,
                            workspace: row.get(1)?,
                            name: row.get(2)?,
                            first_message: row.get(3)?,
                            created_at: row.get(4)?,
                            updated_at: row.get(5)?,
                            message_count: row.get(6)?,
                            parent_path: row.get(7)?,
                        },
                        file_size: row.get(8)?,
                        file_mtime: row.get(9)?,
                        parsed_offset: row.get(10)?,
                    })
                },
            )
            .optional()?)
    }
}

fn removed(was_indexed: bool) -> Change {
    if was_indexed {
        Change::Removed
    } else {
        Change::Unchanged
    }
}

const SUMMARY_COLUMNS: &str =
    "s.path, s.id, s.name, s.first_message, s.workspace, s.created_at, s.updated_at,
     s.message_count, EXISTS (SELECT 1 FROM archived a WHERE a.path = s.path)";

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        path: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        title: row.get(3)?,
        workspace: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        message_count: row.get(7)?,
        archived: row.get(8)?,
    })
}

/// 解析出的会话元数据（随增量解析累积）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionMeta {
    id: String,
    workspace: String,
    name: Option<String>,
    /// 首条用户消息（截断）；还没有时为空串
    first_message: String,
    created_at: i64,
    updated_at: i64,
    message_count: i64,
    parent_path: Option<String>,
}

impl SessionMeta {
    /// 由会话头创建；不是会话头（`type != "session"` 或没有 `id`）时为 None。
    fn from_header(entry: &Value, file_mtime: i64) -> Option<Self> {
        if entry.get("type").and_then(Value::as_str) != Some("session") {
            return None;
        }
        let id = entry.get("id").and_then(Value::as_str)?.to_owned();
        let created_at = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_millis)
            .unwrap_or(file_mtime);
        Some(Self {
            id,
            workspace: entry
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            name: None,
            first_message: String::new(),
            created_at,
            updated_at: created_at,
            message_count: 0,
            parent_path: entry
                .get("parentSession")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// 合并一条记录：`session_info` 更新会话名（空名为清除），`message` 计数、更新活动时间、收集正文。
    fn apply(&mut self, entry: &Value, texts: &mut Vec<String>) {
        match entry.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                self.name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
            }
            Some("message") => {
                self.message_count += 1;
                let Some(message) = entry.get("message") else {
                    return;
                };
                let role = message.get("role").and_then(Value::as_str);
                if !matches!(role, Some("user" | "assistant")) {
                    return;
                }
                let Some(content) = message.get("content") else {
                    return;
                };
                let activity = message
                    .get("timestamp")
                    .and_then(Value::as_i64)
                    .or_else(|| {
                        entry
                            .get("timestamp")
                            .and_then(Value::as_str)
                            .and_then(parse_iso_millis)
                    });
                if let Some(t) = activity {
                    self.updated_at = self.updated_at.max(t);
                }
                let text = text_content(content);
                if text.is_empty() {
                    return;
                }
                if self.first_message.is_empty() && role == Some("user") {
                    self.first_message = truncate_chars(text.trim(), TITLE_CHARS);
                }
                texts.push(text);
            }
            _ => {}
        }
    }
}

/// 消息正文：字符串原样，数组取其中 `text` 块的文本以空格连接（与 Core 的会话列表一致）。
fn text_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_owned(),
        None => s.to_owned(),
    }
}

struct RowState {
    meta: SessionMeta,
    file_size: i64,
    file_mtime: i64,
    parsed_offset: i64,
}

struct RowFile {
    size: i64,
    mtime: i64,
    parsed_offset: i64,
}

fn upsert(tx: &Transaction<'_>, path: &str, m: &SessionMeta, f: &RowFile) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO sessions (path, id, workspace, workspace_key, name, first_message, created_at,
                               updated_at, message_count, parent_path, file_size, file_mtime, parsed_offset)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (path) DO UPDATE SET
           id = excluded.id, workspace = excluded.workspace, workspace_key = excluded.workspace_key,
           name = excluded.name, first_message = excluded.first_message, created_at = excluded.created_at,
           updated_at = excluded.updated_at, message_count = excluded.message_count,
           parent_path = excluded.parent_path, file_size = excluded.file_size,
           file_mtime = excluded.file_mtime, parsed_offset = excluded.parsed_offset",
        params![
            path,
            m.id,
            m.workspace,
            crate::platform::path_key(&m.workspace),
            m.name,
            m.first_message,
            m.created_at,
            m.updated_at,
            m.message_count,
            m.parent_path,
            f.size,
            f.mtime,
            f.parsed_offset
        ],
    )?;
    Ok(())
}

fn open_and_init(db_path: &Path) -> Result<Connection, IndexError> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// 建表；`schema_version` 不符时删掉派生表重建（`archived` 保留）。
fn init_schema(conn: &Connection) -> Result<(), IndexError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS archived (path TEXT PRIMARY KEY);",
    )?;
    let version: Option<i64> = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version != Some(SCHEMA_VERSION) {
        conn.execute_batch(&format!(
            "BEGIN;
             DROP TABLE IF EXISTS sessions;
             DROP TABLE IF EXISTS session_text;
             CREATE TABLE sessions (
               path TEXT PRIMARY KEY,
               id TEXT NOT NULL,
               workspace TEXT NOT NULL,
               workspace_key TEXT NOT NULL,
               name TEXT,
               first_message TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               message_count INTEGER NOT NULL,
               parent_path TEXT,
               file_size INTEGER NOT NULL,
               file_mtime INTEGER NOT NULL,
               parsed_offset INTEGER NOT NULL
             );
             CREATE INDEX sessions_recent ON sessions (updated_at DESC, path DESC);
             CREATE INDEX sessions_workspace ON sessions (workspace_key, updated_at DESC, path DESC);
             CREATE VIRTUAL TABLE session_text USING fts5 (path UNINDEXED, body, tokenize = 'trigram');
             INSERT INTO meta (key, value) VALUES ('schema_version', '{SCHEMA_VERSION}')
               ON CONFLICT (key) DO UPDATE SET value = excluded.value;
             COMMIT;"
        ))?;
    }
    Ok(())
}

fn is_corrupt(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn remove_db_files(db_path: &Path) -> io::Result<()> {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = db_path.as_os_str().to_owned();
        p.push(suffix);
        match fs::remove_file(PathBuf::from(p)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn is_session_file_name(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "jsonl")
}

/// 会话目录及其下一层子目录中的 `.jsonl` 文件（不跟随符号链接）。
fn session_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let Ok(ty) = entry.file_type() else { continue };
        let path = entry.path();
        if ty.is_file() && is_session_file_name(&path) {
            files.push(path);
        } else if ty.is_dir()
            && let Ok(sub) = fs::read_dir(&path)
        {
            for e in sub.flatten() {
                if e.file_type().is_ok_and(|t| t.is_file()) && is_session_file_name(&e.path()) {
                    files.push(e.path());
                }
            }
        }
    }
    files
}

/// 读第一行完整记录的会话 ID（判断文件是否被改写）；没有完整的第一行或不是会话头时为 None。
fn read_header_id(file: &mut File) -> io::Result<Option<String>> {
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(&mut *file);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if line.last() != Some(&b'\n') {
        return Ok(None);
    }
    Ok(serde_json::from_slice::<Value>(&line)
        .ok()
        .and_then(|v| SessionMeta::from_header(&v, 0))
        .map(|m| m.id))
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 解析游标 `<毫秒>:<路径>`。
fn parse_cursor(cursor: &str) -> Option<(i64, String)> {
    let (time, path) = cursor.split_once(':')?;
    Some((time.parse().ok()?, path.to_owned()))
}

/// FTS5 查询串：整体作为一个短语（双引号转义），不让用户输入的运算符生效。
fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

/// LIKE 模式转义（配合 `ESCAPE '\'`）。
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// 解析 Core 写入的 ISO 8601 UTC 时间（`Date.toISOString()`：`YYYY-MM-DDTHH:MM:SS[.fff]Z`），返回毫秒。
fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let rest = &s[19..];
    let (frac, tail) = match rest.strip_prefix('.') {
        Some(r) => {
            let digits = r.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            let ms: String = r[..digits].chars().chain("000".chars()).take(3).collect();
            (ms.parse::<i64>().ok()?, &r[digits..])
        }
        None => (0, rest),
    };
    if tail != "Z" {
        return None;
    }
    // 公历日期 → 自 1970-01-01 的天数（Howard Hinnant 的 days_from_civil）
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + frac)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::tests::TempDir;
    use std::io::Write;

    fn header(id: &str, cwd: &str, ts: &str) -> String {
        serde_json::json!({ "type": "session", "version": 3, "id": id, "timestamp": ts, "cwd": cwd })
            .to_string()
    }

    fn user(text: &str, ts: i64) -> String {
        serde_json::json!({
            "type": "message", "id": format!("u{ts}"), "parentId": null,
            "timestamp": "2026-11-03T00:00:00.000Z",
            "message": { "role": "user", "content": text, "timestamp": ts }
        })
        .to_string()
    }

    fn assistant(text: &str, ts: i64) -> String {
        serde_json::json!({
            "type": "message", "id": format!("a{ts}"), "parentId": null,
            "timestamp": "2026-11-03T00:00:00.000Z",
            "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "不应被索引的思考" },
                { "type": "text", "text": text },
                { "type": "toolCall", "id": "t1", "name": "read", "arguments": {} }
            ], "timestamp": ts }
        })
        .to_string()
    }

    fn info(name: &str) -> String {
        serde_json::json!({ "type": "session_info", "id": "i", "parentId": null,
            "timestamp": "2026-11-03T00:00:00.000Z", "name": name })
        .to_string()
    }

    fn write_lines(path: &Path, lines: &[String]) {
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn append(path: &Path, text: &str) {
        let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    /// 修改时间精度可能是秒：改动后把 mtime 推开，确保索引看到变化
    fn bump_mtime(path: &Path, secs: u64) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(secs))
            .unwrap();
    }

    fn setup() -> (TempDir, SessionIndex) {
        let dir = TempDir::new();
        let index = SessionIndex::open_in_memory(&dir.0).unwrap();
        (dir, index)
    }

    fn key(p: &Path) -> String {
        p.to_str().unwrap().to_owned()
    }

    #[test]
    fn parses_header_messages_and_name() {
        let (dir, index) = setup();
        let p = dir.0.join("2026-11-03T00-00-00-000Z_a.jsonl");
        write_lines(
            &p,
            &[
                header("a", "/work/proj", "2026-11-03T00:00:00.000Z"),
                user("  帮我看看登录模块  ", 1_000),
                assistant("好的，先读文件", 2_000),
                info("登录排查"),
            ],
        );
        assert_eq!(index.update_file(&p).unwrap(), Change::Updated);
        let page = index.list(None, None).unwrap();
        assert_eq!(page.next_cursor, None);
        assert_eq!(
            page.items,
            vec![SessionSummary {
                path: key(&p),
                id: "a".into(),
                name: Some("登录排查".into()),
                title: "帮我看看登录模块".into(),
                workspace: "/work/proj".into(),
                created_at: 1_793_664_000_000,
                // 消息自带的时间早于文件头：活动时间取较晚的文件头时间
                updated_at: 1_793_664_000_000,
                message_count: 2,
                archived: false,
            }]
        );
        // 未变化的文件不重复解析
        assert_eq!(index.update_file(&p).unwrap(), Change::Unchanged);
    }

    #[test]
    fn activity_time_comes_from_latest_message() {
        let (dir, index) = setup();
        let p = dir.0.join("b.jsonl");
        let later = 1_793_664_000_000 + 60_000;
        write_lines(
            &p,
            &[
                header("b", "/w", "2026-11-03T00:00:00.000Z"),
                user("hi", later),
            ],
        );
        index.update_file(&p).unwrap();
        assert_eq!(index.list(None, None).unwrap().items[0].updated_at, later);
    }

    #[test]
    fn empty_name_clears_and_title_is_truncated() {
        let (dir, index) = setup();
        let p = dir.0.join("c.jsonl");
        let long = "长".repeat(TITLE_CHARS + 50);
        write_lines(
            &p,
            &[
                header("c", "/w", "2026-11-03T00:00:00.000Z"),
                info("先起个名"),
                user(&long, 1),
                info("   "),
            ],
        );
        index.update_file(&p).unwrap();
        let s = &index.list(None, None).unwrap().items[0];
        assert_eq!(s.name, None);
        assert_eq!(s.title.chars().count(), TITLE_CHARS);
    }

    #[test]
    fn incremental_append_keeps_partial_line_for_later() {
        let (dir, index) = setup();
        let p = dir.0.join("d.jsonl");
        write_lines(
            &p,
            &[
                header("d", "/w", "2026-11-03T00:00:00.000Z"),
                user("第一句话", 1),
            ],
        );
        index.update_file(&p).unwrap();

        // Core 写到一半：半行不计入
        let line = assistant("第二句回答内容", 2);
        let (head, tail) = line.split_at(10);
        append(&p, head);
        bump_mtime(&p, 5);
        assert_eq!(index.update_file(&p).unwrap(), Change::Updated);
        assert_eq!(index.list(None, None).unwrap().items[0].message_count, 1);

        append(&p, &format!("{tail}\r\n"));
        bump_mtime(&p, 10);
        index.update_file(&p).unwrap();
        assert_eq!(index.list(None, None).unwrap().items[0].message_count, 2);
        // 增量追加的正文可以搜到，首条消息仍是第一句
        let found = index.search(None, "第二句回答").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "第一句话");
    }

    #[test]
    fn rewritten_file_is_fully_reparsed() {
        let (dir, index) = setup();
        let p = dir.0.join("e.jsonl");
        write_lines(
            &p,
            &[
                header("e", "/w", "2026-11-03T00:00:00.000Z"),
                user("旧的内容很长很长很长", 1),
            ],
        );
        index.update_file(&p).unwrap();
        // 改写成更短的另一个会话
        write_lines(
            &p,
            &[
                header("e2", "/w", "2026-11-03T00:00:00.000Z"),
                user("新内容", 1),
            ],
        );
        bump_mtime(&p, 5);
        index.update_file(&p).unwrap();
        let s = &index.list(None, None).unwrap().items[0];
        assert_eq!(s.id, "e2");
        assert_eq!(s.title, "新内容");
        assert!(index.search(None, "旧的内容").unwrap().is_empty());
    }

    #[test]
    fn non_session_and_incomplete_files_are_not_indexed() {
        let (dir, index) = setup();
        let p = dir.0.join("f.jsonl");
        write_lines(&p, &[user("没有文件头", 1)]);
        assert_eq!(index.update_file(&p).unwrap(), Change::Unchanged);
        fs::write(&p, header("f", "/w", "2026-11-03T00:00:00.000Z")).unwrap();
        assert_eq!(index.update_file(&p).unwrap(), Change::Unchanged);
        let other = dir.0.join("notes.txt");
        fs::write(&other, "x").unwrap();
        assert_eq!(index.update_file(&other).unwrap(), Change::Unchanged);
        assert!(index.list(None, None).unwrap().items.is_empty());
    }

    #[test]
    fn garbage_lines_are_skipped() {
        let (dir, index) = setup();
        let p = dir.0.join("g.jsonl");
        write_lines(
            &p,
            &[
                header("g", "/w", "2026-11-03T00:00:00.000Z"),
                "{not json".into(),
                user("ok", 1),
            ],
        );
        index.update_file(&p).unwrap();
        assert_eq!(index.list(None, None).unwrap().items[0].message_count, 1);
    }

    #[test]
    fn deleted_file_is_removed() {
        let (dir, index) = setup();
        let p = dir.0.join("h.jsonl");
        write_lines(
            &p,
            &[header("h", "/w", "2026-11-03T00:00:00.000Z"), user("x", 1)],
        );
        index.update_file(&p).unwrap();
        index.set_archived(&key(&p), true).unwrap();
        fs::remove_file(&p).unwrap();
        assert_eq!(index.update_file(&p).unwrap(), Change::Removed);
        assert!(index.search(None, "x").unwrap().is_empty());
        // 重新出现同名文件不继承归档标记
        write_lines(
            &p,
            &[header("h", "/w", "2026-11-03T00:00:00.000Z"), user("x", 1)],
        );
        index.update_file(&p).unwrap();
        assert!(!index.list(None, None).unwrap().items[0].archived);
    }

    #[test]
    fn sync_all_scans_top_level_and_one_subdirectory_level() {
        let (dir, index) = setup();
        let a = dir.0.join("a.jsonl");
        write_lines(
            &a,
            &[header("a", "/w", "2026-11-03T00:00:00.000Z"), user("1", 1)],
        );
        let sub = dir.0.join("--w--");
        fs::create_dir(&sub).unwrap();
        let b = sub.join("b.jsonl");
        write_lines(
            &b,
            &[header("b", "/w", "2026-11-03T00:00:00.000Z"), user("2", 2)],
        );
        let deep = sub.join("deeper");
        fs::create_dir(&deep).unwrap();
        write_lines(
            &deep.join("c.jsonl"),
            &[header("c", "/w", "2026-11-03T00:00:00.000Z"), user("3", 3)],
        );
        assert!(index.sync_all().unwrap());
        assert_eq!(index.list(None, None).unwrap().items.len(), 2);
        assert!(!index.sync_all().unwrap());
        fs::remove_file(&a).unwrap();
        assert!(index.sync_all().unwrap());
        let items = index.list(None, None).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "b");
    }

    fn seed(index: &SessionIndex, dir: &Path, n: usize, cwd: &str) -> Vec<String> {
        (0..n)
            .map(|i| {
                let p = dir.join(format!(
                    "{cwd_tag}-{i:03}.jsonl",
                    cwd_tag = cwd.replace('/', "")
                ));
                write_lines(
                    &p,
                    &[
                        header(&format!("{cwd}{i}"), cwd, "2026-11-03T00:00:00.000Z"),
                        // 每 3 个会话共用一个活动时间，测试同一时间内按路径排序
                        user(&format!("会话{i}"), 1_793_664_000_000 + (i / 3) as i64),
                    ],
                );
                index.update_file(&p).unwrap();
                key(&p)
            })
            .collect()
    }

    #[test]
    fn keyset_pagination_covers_every_session_once_in_order() {
        let (dir, index) = setup();
        let mut paths = seed(&index, &dir.0, PAGE_SIZE * 2 + 7, "/w");
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = index.list(None, cursor.as_deref()).unwrap();
            assert!(page.items.len() <= PAGE_SIZE);
            seen.extend(page.items.iter().map(|s| s.path.clone()));
            match page.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        // 期望顺序：活动时间倒序，同一时间按路径倒序
        paths.reverse();
        assert_eq!(seen, paths);
    }

    #[test]
    fn invalid_cursor_returns_first_page() {
        let (dir, index) = setup();
        seed(&index, &dir.0, 3, "/w");
        let page = index.list(None, Some("garbage")).unwrap();
        assert_eq!(page.items.len(), 3);
    }

    #[test]
    fn workspace_filter_and_archive() {
        let (dir, index) = setup();
        let w1 = seed(&index, &dir.0, 2, "/w1");
        seed(&index, &dir.0, 3, "/w2");
        let key1 = crate::platform::path_key("/w1/");
        assert_eq!(index.list(Some(&key1), None).unwrap().items.len(), 2);
        assert_eq!(index.list(None, None).unwrap().items.len(), 5);

        assert!(index.set_archived(&w1[0], true).unwrap());
        assert_eq!(index.list(Some(&key1), None).unwrap().items.len(), 1);
        // 搜索包含已归档会话并带上标记
        let found = index.search(Some(&key1), "会话0").unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].archived);
        assert!(index.set_archived(&w1[0], false).unwrap());
        assert_eq!(index.list(Some(&key1), None).unwrap().items.len(), 2);
        assert!(!index.set_archived("/no/such.jsonl", true).unwrap());
    }

    #[test]
    fn search_short_queries_match_titles_and_escape_like() {
        let (dir, index) = setup();
        let p = dir.0.join("s.jsonl");
        write_lines(
            &p,
            &[
                header("s", "/w", "2026-11-03T00:00:00.000Z"),
                user("修复 100% 的 bug_x", 1),
                assistant("正文里的关键词：数据库迁移", 2),
            ],
        );
        index.update_file(&p).unwrap();
        // 少于 3 个字：只匹配标题
        assert_eq!(index.search(None, "修复").unwrap().len(), 1);
        assert!(index.search(None, "迁移").unwrap().is_empty());
        // 3 个字及以上：匹配全文
        assert_eq!(index.search(None, "数据库迁移").unwrap().len(), 1);
        // LIKE 通配符按字面匹配
        assert_eq!(index.search(None, "0%").unwrap().len(), 1);
        assert!(index.search(None, "1_0").unwrap().is_empty());
        assert_eq!(index.search(None, "g_x").unwrap().len(), 1);
        // FTS 运算符与引号按字面处理，不报错
        assert!(index.search(None, "\"OR NEAR(").unwrap().is_empty());
        assert!(index.search(None, "   ").unwrap().is_empty());
        // 思考与工具调用不入全文
        assert!(index.search(None, "不应被索引").unwrap().is_empty());
    }

    #[test]
    fn schema_upgrade_rebuilds_but_keeps_archived_marks() {
        let dir = TempDir::new();
        let db = dir.0.join("index.db");
        let sessions = dir.0.join("sessions");
        fs::create_dir(&sessions).unwrap();
        let p = sessions.join("a.jsonl");
        write_lines(
            &p,
            &[header("a", "/w", "2026-11-03T00:00:00.000Z"), user("x", 1)],
        );
        {
            let index = SessionIndex::open(&db, &sessions).unwrap();
            index.sync_all().unwrap();
            index.set_archived(&key(&p), true).unwrap();
            index
                .conn()
                .execute(
                    "UPDATE meta SET value = '0' WHERE key = 'schema_version'",
                    [],
                )
                .unwrap();
        }
        let index = SessionIndex::open(&db, &sessions).unwrap();
        assert!(index.search(None, "x").unwrap().is_empty());
        index.sync_all().unwrap();
        assert!(index.search(None, "x").unwrap()[0].archived);
    }

    #[test]
    fn corrupt_database_is_recreated() {
        let dir = TempDir::new();
        let db = dir.0.join("index.db");
        fs::write(
            &db,
            b"this is not a sqlite database, just some bytes padding padding",
        )
        .unwrap();
        let index = SessionIndex::open(&db, &dir.0).unwrap();
        assert!(index.list(None, None).unwrap().items.is_empty());
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_millis("2026-11-03T00:00:00.000Z"),
            Some(1_793_664_000_000)
        );
        assert_eq!(
            parse_iso_millis("2000-02-29T12:34:56.789Z"),
            Some(951_827_696_789)
        );
        assert_eq!(
            parse_iso_millis("2000-02-29T12:34:56Z"),
            Some(951_827_696_000)
        );
        assert_eq!(
            parse_iso_millis("2000-02-29T12:34:56.7Z"),
            Some(951_827_696_700)
        );
        assert_eq!(parse_iso_millis("2000-02-29T12:34:56.789+08:00"), None);
        assert_eq!(parse_iso_millis("2000-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso_millis("not a date at all!!"), None);
    }
}
