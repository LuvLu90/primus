//! 工作区管理（第 15.1 节、附录 B 的 `workspace_open` / `workspace_list` / `workspace_trust`）
//! 与项目信任（第 17.2 节）。
//!
//! 最近打开的工作区与信任状态存在 `users/<SID>/app/workspaces.json`（约束 C2：只写数据目录）。
//! 按最近打开时间倒序，最多保留 [`MAX_RECENT`] 个；同一目录按 [`crate::platform::path_key`] 去重
//! （Windows 不区分大小写、`/` 与 `\` 等价、忽略末尾分隔符）。写入先写临时文件再改名，不会留下半个文件。
//!
//! 信任：首次打开时需要用户确认（[`WorkspaceInfo::needs_trust`]）；选择“信任”时记下 `.primus/` 的内容指纹，
//! 之后内容变化则视为未信任，下次打开时重新确认。会话以 `--approve` 启动只看 [`Workspaces::approved`]。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 最近工作区列表的上限。
pub(crate) const MAX_RECENT: usize = 30;

/// 返回给前端的工作区信息（与 `WorkspaceInfo` 对应）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceInfo {
    pub(crate) path: String,
    pub(crate) name: String,
    /// 当前有效的信任状态：已信任且 `.primus/` 未变化
    pub(crate) trusted: bool,
    /// 需要显示信任确认：从未确认过，或信任后 `.primus/` 内容已变化
    pub(crate) needs_trust: bool,
}

/// 信任确认展示的项目内容（`workspace_inspect`）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustDetails {
    pub(crate) path: String,
    /// 根目录 `AGENTS.md` 的内容（超过 [`AGENTS_MD_LIMIT`] 字节时截断）；不存在为 None
    pub(crate) agents_md: Option<String>,
    pub(crate) agents_md_truncated: bool,
    /// `.primus/extensions/` 下的条目名
    pub(crate) extensions: Vec<String>,
    /// `.primus/skills/` 下的条目名
    pub(crate) skills: Vec<String>,
    /// `.primus/mcp.json` 中的服务器名；文件存在但无法解析时为 `["mcp.json"]`
    pub(crate) mcp_servers: Vec<String>,
}

/// 信任确认中 `AGENTS.md` 最多展示的字节数。
pub(crate) const AGENTS_MD_LIMIT: usize = 64 * 1024;
/// 计算 `.primus/` 指纹时最多读取的文件数与总字节数；超出部分只计入一个“已截断”标记。
const HASH_MAX_FILES: usize = 2_000;
const HASH_MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    #[serde(default)]
    trusted: bool,
    /// 用户是否已对信任确认做过选择（“信任”或“不信任”）
    #[serde(default)]
    decided: bool,
    /// 选择“信任”时 `.primus/` 的内容指纹
    #[serde(default, skip_serializing_if = "Option::is_none")]
    primus_hash: Option<String>,
    /// 最近打开时间（Unix 毫秒）
    #[serde(default)]
    last_opened: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    workspaces: Vec<Entry>,
}

/// 工作区命令的错误：`message` 是界面文案。
#[derive(Debug)]
pub(crate) enum WorkspaceError {
    /// 路径不是已存在目录的绝对路径
    NotADirectory(String),
    /// 信任操作的目标不在最近工作区中
    Unknown(String),
    Io(io::Error),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotADirectory(p) => write!(f, "文件夹不存在或不可访问：{p}"),
            Self::Unknown(p) => write!(f, "不是已打开过的工作区：{p}"),
            Self::Io(e) => write!(f, "无法保存工作区列表：{e}"),
        }
    }
}

impl From<io::Error> for WorkspaceError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 最近工作区存储；读写串行，避免两个命令同时改文件。
pub(crate) struct Workspaces {
    file: PathBuf,
    lock: Mutex<()>,
}

impl Workspaces {
    /// `app_dir` 为 `users/<SID>/app`。
    pub(crate) fn new(app_dir: &Path) -> Self {
        Self {
            file: app_dir.join("workspaces.json"),
            lock: Mutex::new(()),
        }
    }

    /// 打开（登记）一个工作区：必须是已存在目录的绝对路径。已登记的保留信任状态并移到最前。
    pub(crate) fn open(&self, path: &str) -> Result<WorkspaceInfo, WorkspaceError> {
        let path = normalize(path).ok_or_else(|| WorkspaceError::NotADirectory(path.to_owned()))?;
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = self.load()?;
        let key = crate::platform::path_key(&path);
        let mut entry = match store
            .workspaces
            .iter()
            .position(|e| crate::platform::path_key(&e.path) == key)
        {
            Some(i) => store.workspaces.remove(i),
            None => Entry {
                path: path.clone(),
                trusted: false,
                decided: false,
                primus_hash: None,
                last_opened: 0,
            },
        };
        entry.path = path;
        entry.last_opened = now_ms();
        let result = entry_info(&entry);
        store.workspaces.insert(0, entry);
        store.workspaces.truncate(MAX_RECENT);
        self.save(&store)?;
        Ok(result)
    }

    /// 最近工作区，最近打开的在前；已不存在的目录不列出（记录保留，目录恢复后重新出现）。
    /// 文件读取失败（不是“不存在”）时返回错误，由界面提示，而不是显示成空列表。
    pub(crate) fn list(&self) -> io::Result<Vec<WorkspaceInfo>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut items = self.load()?.workspaces;
        items.sort_by_key(|e| std::cmp::Reverse(e.last_opened));
        Ok(items
            .iter()
            .filter(|e| Path::new(&e.path).is_dir())
            .map(entry_info)
            .collect())
    }

    /// 会话是否以 `--approve` 启动：已登记、用户选择过“信任”，且 `.primus/` 未变化。
    /// 读取失败或未登记一律按未信任处理。
    pub(crate) fn approved(&self, path: &str) -> bool {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let key = crate::platform::path_key(path);
        self.load()
            .ok()
            .and_then(|s| {
                s.workspaces
                    .into_iter()
                    .find(|e| crate::platform::path_key(&e.path) == key)
            })
            .is_some_and(|e| entry_info(&e).trusted)
    }

    /// 记录信任确认的选择；目标必须已打开过。选择“信任”时记下 `.primus/` 当前的指纹。
    pub(crate) fn trust(&self, path: &str, trusted: bool) -> Result<(), WorkspaceError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = self.load()?;
        let key = crate::platform::path_key(path);
        let entry = store
            .workspaces
            .iter_mut()
            .find(|e| crate::platform::path_key(&e.path) == key)
            .ok_or_else(|| WorkspaceError::Unknown(path.to_owned()))?;
        entry.trusted = trusted;
        entry.decided = true;
        entry.primus_hash = trusted.then(|| primus_hash(Path::new(&entry.path)));
        self.save(&store)?;
        Ok(())
    }

    /// 读文件；不存在或内容损坏时视为空列表（损坏的文件在下次保存时被覆盖）。
    /// 其他读取错误原样返回，避免 `open` / `trust` 拿空列表覆盖原有记录。
    fn load(&self) -> io::Result<StoreFile> {
        match std::fs::read(&self.file) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!("工作区列表损坏，按空列表处理：{e}");
                StoreFile::default()
            })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(StoreFile::default()),
            Err(e) => Err(e),
        }
    }

    fn save(&self, store: &StoreFile) -> io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_vec_pretty(store).map_err(io::Error::other)?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &self.file).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
}

/// 校验并规范路径：绝对路径、目录存在；去掉末尾分隔符（根目录除外）。
fn normalize(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() || !p.is_dir() {
        return None;
    }
    let mut s = trimmed.to_owned();
    while s.len() > 1 && (s.ends_with('/') || s.ends_with('\\')) {
        let rest = &s[..s.len() - 1];
        // 保留 `C:\` 这样的盘符根
        if rest.len() == 2 && rest.ends_with(':') {
            break;
        }
        s.pop();
    }
    Some(s)
}

fn entry_info(e: &Entry) -> WorkspaceInfo {
    // 只有选择过“信任”的才需要比对指纹
    let changed =
        e.trusted && e.primus_hash.as_deref() != Some(primus_hash(Path::new(&e.path)).as_str());
    let needs_trust = !e.decided || changed;
    WorkspaceInfo {
        path: e.path.clone(),
        name: display_name(&e.path),
        trusted: e.trusted && !needs_trust,
        needs_trust,
    }
}

/// `.primus/` 的内容指纹：按相对路径排序，依次计入路径、长度与内容；不跟随符号链接（只计入链接本身）。
/// 目录不存在时为空集合的指纹。
fn primus_hash(workspace: &Path) -> String {
    let root = workspace.join(".primus");
    let mut files = Vec::new();
    let mut truncated = false;
    collect_files(&root, &root, &mut files, &mut truncated);
    files.sort();
    let mut hasher = Sha256::new();
    let mut budget = HASH_MAX_BYTES;
    for (rel, path, is_link) in &files {
        hasher.update(rel.as_bytes());
        hasher.update([0]);
        if *is_link {
            let target = std::fs::read_link(path).unwrap_or_default();
            hasher.update(b"link:");
            hasher.update(target.to_string_lossy().as_bytes());
        } else {
            match std::fs::read(path) {
                Ok(bytes) if (bytes.len() as u64) <= budget => {
                    budget -= bytes.len() as u64;
                    hasher.update((bytes.len() as u64).to_le_bytes());
                    hasher.update(&bytes);
                }
                Ok(bytes) => {
                    truncated = true;
                    hasher.update((bytes.len() as u64).to_le_bytes());
                }
                Err(_) => hasher.update(b"unreadable"),
            }
        }
        hasher.update([0]);
    }
    if truncated {
        hasher.update(b"truncated");
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn collect_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf, bool)>,
    truncated: &mut bool,
) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        if out.len() >= HASH_MAX_FILES {
            *truncated = true;
            return;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if meta.file_type().is_symlink() {
            out.push((rel, path, true));
        } else if meta.is_dir() {
            collect_files(root, &path, out, truncated);
        } else if meta.is_file() {
            out.push((rel, path, false));
        }
    }
}

/// 读取信任确认要展示的内容；路径必须是已存在的目录。
pub(crate) fn inspect(path: &str) -> Result<TrustDetails, WorkspaceError> {
    let path = normalize(path).ok_or_else(|| WorkspaceError::NotADirectory(path.to_owned()))?;
    let root = Path::new(&path);
    let (agents_md, agents_md_truncated) = match std::fs::read(root.join("AGENTS.md")) {
        Ok(mut bytes) => {
            let truncated = bytes.len() > AGENTS_MD_LIMIT;
            bytes.truncate(AGENTS_MD_LIMIT);
            (
                Some(String::from_utf8_lossy(&bytes).into_owned()),
                truncated,
            )
        }
        Err(_) => (None, false),
    };
    let primus = root.join(".primus");
    let mcp_servers = match std::fs::read(primus.join("mcp.json")) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| {
                v.get("mcpServers")
                    .and_then(|m| m.as_object())
                    .map(|m| m.keys().cloned().collect())
            })
            .unwrap_or_else(|| vec!["mcp.json".to_owned()]),
        Err(_) => Vec::new(),
    };
    Ok(TrustDetails {
        agents_md,
        agents_md_truncated,
        extensions: dir_names(&primus.join("extensions")),
        skills: dir_names(&primus.join("skills")),
        mcp_servers,
        path,
    })
}

/// 目录下的条目名（排序，跳过隐藏项）；目录不存在时为空。
fn dir_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// 显示名：路径最后一段（兼容 `\` 与 `/`）；根目录用路径本身。
fn display_name(path: &str) -> String {
    path.split(['\\', '/'])
        .rfind(|s| !s.is_empty())
        .filter(|s| !s.ends_with(':'))
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "primus-ws-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn open_registers_and_lists_most_recent_first() {
        let root = temp_dir("order");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let ws = Workspaces::new(&root.join("app"));
        let first = ws.open(a.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "a");
        assert!(!first.trusted);
        std::thread::sleep(std::time::Duration::from_millis(2));
        ws.open(b.to_str().unwrap()).unwrap();
        let names: Vec<_> = ws.list().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["b", "a"]);
        // 再次打开 a：去重并移到最前
        std::thread::sleep(std::time::Duration::from_millis(2));
        ws.open(&format!("{}/", a.to_str().unwrap())).unwrap();
        let names: Vec<_> = ws.list().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["a", "b"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn open_rejects_missing_or_relative_paths() {
        let root = temp_dir("reject");
        let ws = Workspaces::new(&root.join("app"));
        assert!(matches!(
            ws.open(root.join("missing").to_str().unwrap()),
            Err(WorkspaceError::NotADirectory(_))
        ));
        assert!(matches!(
            ws.open("relative/dir"),
            Err(WorkspaceError::NotADirectory(_))
        ));
        assert!(matches!(
            ws.open("  "),
            Err(WorkspaceError::NotADirectory(_))
        ));
        // 文件不是目录
        let file = root.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(ws.open(file.to_str().unwrap()).is_err());
        assert!(ws.list().unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unreadable_store_is_reported_not_overwritten() {
        let root = temp_dir("unreadable");
        let a = root.join("proj");
        std::fs::create_dir_all(&a).unwrap();
        let app = root.join("app");
        // workspaces.json 位置被目录占用：读取失败（不是“不存在”），不能当空列表写回
        std::fs::create_dir_all(app.join("workspaces.json")).unwrap();
        let ws = Workspaces::new(&app);
        assert!(ws.open(a.to_str().unwrap()).is_err());
        assert!(ws.trust(a.to_str().unwrap(), true).is_err());
        assert!(ws.list().is_err());
        assert!(app.join("workspaces.json").is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn trust_persists_and_survives_reopen() {
        let root = temp_dir("trust");
        let a = root.join("proj");
        std::fs::create_dir_all(&a).unwrap();
        let app = root.join("app");
        let ws = Workspaces::new(&app);
        let path = ws.open(a.to_str().unwrap()).unwrap().path;
        assert!(matches!(
            ws.trust(root.join("other").to_str().unwrap(), true),
            Err(WorkspaceError::Unknown(_))
        ));
        ws.trust(&path, true).unwrap();
        // 新实例读同一文件
        let again = Workspaces::new(&app);
        assert!(again.list().unwrap()[0].trusted);
        assert!(again.open(&path).unwrap().trusted);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn first_open_needs_trust_until_a_choice_is_made() {
        let root = temp_dir("needs");
        let path = root.join("proj").to_string_lossy().into_owned();
        std::fs::create_dir_all(&path).unwrap();
        let ws = Workspaces::new(&root.join("app"));

        let first = ws.open(&path).unwrap();
        assert!(first.needs_trust && !first.trusted);
        assert!(!ws.approved(&path));

        // “不信任”同样记为已确认，之后不再询问，会话以 --no-approve 启动
        ws.trust(&path, false).unwrap();
        let again = ws.open(&path).unwrap();
        assert!(!again.needs_trust && !again.trusted);
        assert!(!ws.approved(&path));

        ws.trust(&path, true).unwrap();
        let trusted = ws.open(&path).unwrap();
        assert!(!trusted.needs_trust && trusted.trusted);
        assert!(ws.approved(&path));
        assert!(!ws.approved(&root.join("other").to_string_lossy()));
    }

    #[test]
    fn changed_primus_dir_requires_reconfirmation() {
        let root = temp_dir("rehash");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::write(proj.join(".primus/extensions/a.js"), "one").unwrap();
        let path = proj.to_string_lossy().into_owned();
        let ws = Workspaces::new(&root.join("app"));
        ws.open(&path).unwrap();
        ws.trust(&path, true).unwrap();
        assert!(ws.approved(&path));

        std::fs::write(proj.join(".primus/extensions/a.js"), "two").unwrap();
        let info = ws.open(&path).unwrap();
        assert!(info.needs_trust && !info.trusted);
        assert!(!ws.approved(&path));

        ws.trust(&path, true).unwrap();
        assert!(ws.approved(&path));
        // 新增文件同样视为变化
        std::fs::create_dir_all(proj.join(".primus/skills/s")).unwrap();
        std::fs::write(proj.join(".primus/skills/s/SKILL.md"), "x").unwrap();
        assert!(!ws.approved(&path));
    }

    #[test]
    fn inspect_lists_project_resources() {
        let root = temp_dir("inspect");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::create_dir_all(proj.join(".primus/skills/review")).unwrap();
        std::fs::write(proj.join(".primus/extensions/guard.js"), "").unwrap();
        std::fs::write(proj.join(".primus/extensions/.hidden"), "").unwrap();
        std::fs::write(
            proj.join(".primus/mcp.json"),
            r#"{"mcpServers":{"github":{},"db":{}}}"#,
        )
        .unwrap();
        std::fs::write(proj.join("AGENTS.md"), "# 规则").unwrap();

        let d = inspect(&proj.to_string_lossy()).unwrap();
        assert_eq!(d.agents_md.as_deref(), Some("# 规则"));
        assert!(!d.agents_md_truncated);
        assert_eq!(d.extensions, vec!["guard.js"]);
        assert_eq!(d.skills, vec!["review"]);
        let mut mcp = d.mcp_servers.clone();
        mcp.sort();
        assert_eq!(mcp, vec!["db", "github"]);

        std::fs::write(proj.join(".primus/mcp.json"), "not json").unwrap();
        std::fs::write(proj.join("AGENTS.md"), "a".repeat(AGENTS_MD_LIMIT + 10)).unwrap();
        let d = inspect(&proj.to_string_lossy()).unwrap();
        assert_eq!(d.mcp_servers, vec!["mcp.json"]);
        assert!(d.agents_md_truncated);
        assert_eq!(d.agents_md.unwrap().len(), AGENTS_MD_LIMIT);

        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let d = inspect(&empty.to_string_lossy()).unwrap();
        assert_eq!(d.agents_md, None);
        assert!(d.extensions.is_empty() && d.skills.is_empty() && d.mcp_servers.is_empty());
        assert!(inspect("relative/path").is_err());
    }

    #[test]
    fn missing_directories_are_hidden_and_corrupt_file_is_empty() {
        let root = temp_dir("hidden");
        let a = root.join("gone");
        std::fs::create_dir_all(&a).unwrap();
        let app = root.join("app");
        let ws = Workspaces::new(&app);
        ws.open(a.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&a).unwrap();
        assert!(ws.list().unwrap().is_empty());
        std::fs::write(app.join("workspaces.json"), "{not json").unwrap();
        assert!(ws.list().unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recent_list_is_capped() {
        let root = temp_dir("cap");
        let ws = Workspaces::new(&root.join("app"));
        for i in 0..MAX_RECENT + 5 {
            let d = root.join(format!("d{i}"));
            std::fs::create_dir_all(&d).unwrap();
            ws.open(d.to_str().unwrap()).unwrap();
        }
        assert_eq!(ws.list().unwrap().len(), MAX_RECENT);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn display_name_handles_separators_and_roots() {
        assert_eq!(display_name(r"C:\Work\Proj"), "Proj");
        assert_eq!(display_name("/home/a/proj"), "proj");
        assert_eq!(display_name(r"C:\"), r"C:\");
        assert_eq!(display_name("/"), "/");
    }
}
