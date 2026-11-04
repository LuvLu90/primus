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
    /// `.primus/mcp.json` 中的服务器名；文件存在但无法解析或过大时为 `["mcp.json"]`
    pub(crate) mcp_servers: Vec<String>,
    /// 此刻 `.primus/` 的内容指纹，`workspace_trust` 信任时必须原样带回；
    /// 内容过多或无法完整读取时为 None，此时不能信任
    pub(crate) fingerprint: Option<String>,
}

/// 信任确认中 `AGENTS.md` 最多展示的字节数。
pub(crate) const AGENTS_MD_LIMIT: usize = 64 * 1024;
/// `.primus/mcp.json` 最多读取的字节数，超过时只显示文件名。
const MCP_JSON_LIMIT: u64 = 1024 * 1024;
/// 计算 `.primus/` 指纹时最多计入的文件数与总字节数；超出则指纹不完整，不能信任。
const HASH_MAX_FILES: usize = 20_000;
const HASH_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 列出技能时最多递归的目录层数。
const SKILL_MAX_DEPTH: usize = 16;

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
    /// 确认弹窗展示之后 `.primus/` 内容又变了
    TrustChanged,
    /// `.primus/` 内容过多或无法完整读取，无法生成指纹
    Incomplete,
    /// 读取项目文件失败（`workspace_inspect`）
    Read(PathBuf, io::Error),
    Io(io::Error),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotADirectory(p) => write!(f, "文件夹不存在或不可访问：{p}"),
            Self::Unknown(p) => write!(f, "不是已打开过的工作区：{p}"),
            Self::TrustChanged => write!(f, "项目内容在确认后发生了变化，请重新查看后再决定"),
            Self::Incomplete => write!(f, "项目的 .primus 内容过多或无法完整读取，不能信任"),
            Self::Read(p, e) => write!(f, "读取 {} 失败：{e}", p.display()),
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
            // 只差大小写等的另一个路径可能是另一个目录（区分大小写的目录），不沿用信任
            Some(i) if store.workspaces[i].path == path => store.workspaces.remove(i),
            Some(i) => {
                store.workspaces.remove(i);
                untrusted(path.clone())
            }
            None => untrusted(path.clone()),
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
    /// 只认与登记记录完全相同的路径：只差大小写的路径可能是另一个目录。
    pub(crate) fn approved(&self, path: &str) -> bool {
        let Some(path) = normalize(path) else {
            return false;
        };
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load()
            .ok()
            .and_then(|s| s.workspaces.into_iter().find(|e| e.path == path))
            .is_some_and(|e| entry_info(&e).trusted)
    }

    /// 记录信任确认的选择；目标必须已打开过（路径完全一致）。
    /// 选择“信任”时 `fingerprint` 必须是弹窗展示内容时 [`inspect`] 给出的指纹，且与当前内容一致，
    /// 保证记为信任的正是用户看到的内容。
    pub(crate) fn trust(
        &self,
        path: &str,
        trusted: bool,
        fingerprint: Option<&str>,
    ) -> Result<(), WorkspaceError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = self.load()?;
        let entry = store
            .workspaces
            .iter_mut()
            .find(|e| e.path == path)
            .ok_or_else(|| WorkspaceError::Unknown(path.to_owned()))?;
        let hash = if trusted {
            let current = primus_hash(Path::new(&entry.path)).ok_or(WorkspaceError::Incomplete)?;
            if fingerprint != Some(current.as_str()) {
                return Err(WorkspaceError::TrustChanged);
            }
            Some(current)
        } else {
            None
        };
        entry.trusted = trusted;
        entry.decided = true;
        entry.primus_hash = hash;
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

fn untrusted(path: String) -> Entry {
    Entry {
        path,
        trusted: false,
        decided: false,
        primus_hash: None,
        last_opened: 0,
    }
}

fn entry_info(e: &Entry) -> WorkspaceInfo {
    // 只有选择过“信任”的才需要比对指纹；指纹不完整（None）同样视为变化
    let changed =
        e.trusted && (e.primus_hash.is_none() || primus_hash(Path::new(&e.path)) != e.primus_hash);
    let needs_trust = !e.decided || changed;
    WorkspaceInfo {
        path: e.path.clone(),
        name: display_name(&e.path),
        trusted: e.trusted && !needs_trust,
        needs_trust,
    }
}

/// 指纹中的一项：相对路径、经由的符号链接目标、实际文件（目录项为 None）。
struct HashItem {
    rel: String,
    link: Option<PathBuf>,
    file: Option<PathBuf>,
}

/// `.primus/` 的内容指纹（SHA-256）：按相对路径排序，依次计入路径、符号链接目标、长度与内容。
/// 跟随符号链接（Core 加载扩展与技能时也跟随），按规范路径防止循环。目录不存在时为空集合的指纹。
/// 任何目录或文件读取失败、断开的链接、超过 [`HASH_MAX_FILES`] / [`HASH_MAX_BYTES`] 时返回 None：
/// 不完整的指纹无法代表全部内容，不能用于信任。
fn primus_hash(workspace: &Path) -> Option<String> {
    let root = workspace.join(".primus");
    let mut items = Vec::new();
    match std::fs::symlink_metadata(&root) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return None,
        Ok(_) => {
            let mut visited = std::collections::HashSet::new();
            walk_hash(&root, "", &mut items, &mut visited)?;
        }
    }
    items.sort_by(|a, b| a.rel.cmp(&b.rel));
    let mut hasher = Sha256::new();
    let mut budget = HASH_MAX_BYTES;
    for item in &items {
        hasher.update(item.rel.as_bytes());
        hasher.update([0]);
        if let Some(target) = &item.link {
            hasher.update(b"link:");
            hasher.update(target.to_string_lossy().as_bytes());
            hasher.update([0]);
        }
        match &item.file {
            None => hasher.update(b"dir"),
            Some(path) => {
                let file = std::fs::File::open(path).ok()?;
                let len = file.metadata().ok()?.len();
                // 先看长度再读：超出预算时不读内容，指纹作废
                budget = budget.checked_sub(len)?;
                hasher.update(b"file:");
                hasher.update(len.to_le_bytes());
                let copied = io::copy(&mut io::Read::take(file, len), &mut hasher).ok()?;
                if copied != len {
                    return None;
                }
            }
        }
        hasher.update([0]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

fn walk_hash(
    dir: &Path,
    rel: &str,
    out: &mut Vec<HashItem>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Option<()> {
    // 同一目录经不同链接到达时只展开一次（防止循环）；再次到达的位置只计入链接本身
    let canonical = std::fs::canonicalize(dir).ok()?;
    if !visited.insert(canonical) {
        return Some(());
    }
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        if out.len() >= HASH_MAX_FILES {
            return None;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let link = std::fs::symlink_metadata(&path)
            .ok()?
            .file_type()
            .is_symlink()
            .then(|| std::fs::read_link(&path))
            .transpose()
            .ok()?;
        // 跟随链接取实际类型；断开的链接无法确认内容
        let meta = std::fs::metadata(&path).ok()?;
        if meta.is_dir() {
            out.push(HashItem {
                rel: child_rel.clone(),
                link,
                file: None,
            });
            walk_hash(&path, &child_rel, out, visited)?;
        } else {
            out.push(HashItem {
                rel: child_rel,
                link,
                file: Some(path),
            });
        }
    }
    Some(())
}

/// 读取信任确认要展示的内容；路径必须是已存在的目录。只有“不存在”视为没有，其他读取错误返回失败，
/// 避免弹窗把读不到的内容显示成“没有”。
pub(crate) fn inspect(path: &str) -> Result<TrustDetails, WorkspaceError> {
    let path = normalize(path).ok_or_else(|| WorkspaceError::NotADirectory(path.to_owned()))?;
    let root = Path::new(&path);
    let agents = root.join("AGENTS.md");
    let (agents_md, agents_md_truncated) = match read_prefix(&agents, AGENTS_MD_LIMIT) {
        Ok(Some((bytes, truncated))) => (
            Some(String::from_utf8_lossy(&bytes).into_owned()),
            truncated,
        ),
        Ok(None) => (None, false),
        Err(e) => return Err(WorkspaceError::Read(agents, e)),
    };
    let primus = root.join(".primus");
    let mcp_file = primus.join("mcp.json");
    let mcp_limit = usize::try_from(MCP_JSON_LIMIT).unwrap_or(usize::MAX);
    let mcp_servers = match read_prefix(&mcp_file, mcp_limit) {
        Ok(None) => Vec::new(),
        Ok(Some((_, true))) => vec!["mcp.json".to_owned()],
        Ok(Some((bytes, false))) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| {
                v.get("mcpServers")
                    .and_then(|m| m.as_object())
                    .map(|m| m.keys().cloned().collect())
            })
            .unwrap_or_else(|| vec!["mcp.json".to_owned()]),
        Err(e) => return Err(WorkspaceError::Read(mcp_file, e)),
    };
    let ext_dir = primus.join("extensions");
    let extensions = list_extensions(&ext_dir).map_err(|e| WorkspaceError::Read(ext_dir, e))?;
    let skill_dir = primus.join("skills");
    let mut skills = Vec::new();
    let mut visited = std::collections::HashSet::new();
    list_skills(&skill_dir, "", true, 0, &mut skills, &mut visited)
        .map_err(|e| WorkspaceError::Read(skill_dir, e))?;
    skills.sort();
    Ok(TrustDetails {
        agents_md,
        agents_md_truncated,
        extensions,
        skills,
        mcp_servers,
        fingerprint: primus_hash(root),
        path,
    })
}

/// 最多读 `limit` 字节（多读 1 字节判断是否截断）；文件不存在为 None。
fn read_prefix(path: &Path, limit: usize) -> io::Result<Option<(Vec<u8>, bool)>> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    io::Read::read_to_end(&mut io::Read::take(file, limit as u64 + 1), &mut bytes)?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    Ok(Some((bytes, truncated)))
}

/// 读目录项；目录不存在为空。
fn read_entries(dir: &Path) -> io::Result<Vec<std::fs::DirEntry>> {
    match std::fs::read_dir(dir) {
        Ok(r) => r.collect(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Core 会加载的扩展（与 agent-core 的发现规则一致，只看一层）：直接的 `*.ts` / `*.js`，
/// 以及含 `package.json`（`pi.extensions`）或 `index.ts` / `index.js` 的子目录。均跟随符号链接。
fn list_extensions(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in read_entries(dir)? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let loads = if meta.is_dir() {
            path.join("index.ts").exists()
                || path.join("index.js").exists()
                || has_pi_extensions(&path.join("package.json"))
        } else {
            name.ends_with(".ts") || name.ends_with(".js")
        };
        if loads {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn has_pi_extensions(manifest: &Path) -> bool {
    read_prefix(manifest, 1024 * 1024)
        .ok()
        .flatten()
        .and_then(|(bytes, _)| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| {
            v.get("pi")?
                .get("extensions")?
                .as_array()
                .map(|a| !a.is_empty())
        })
        .unwrap_or(false)
}

/// Core 会加载的技能（与 agent-core 的发现规则一致）：含 `SKILL.md` 的目录是一个技能且不再往下找；
/// 否则根目录下直接的 `*.md` 各是一个技能，并递归子目录（跳过隐藏项与 `node_modules`，跟随符号链接）。
fn list_skills(
    dir: &Path,
    rel: &str,
    root_files: bool,
    depth: usize,
    out: &mut Vec<String>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> io::Result<()> {
    if depth > SKILL_MAX_DEPTH {
        return Ok(());
    }
    if let Ok(canonical) = std::fs::canonicalize(dir)
        && !visited.insert(canonical)
    {
        return Ok(());
    }
    let entries = read_entries(dir)?;
    if entries
        .iter()
        .any(|e| e.file_name() == "SKILL.md" && e.path().is_file())
    {
        out.push(if rel.is_empty() {
            "SKILL.md".to_owned()
        } else {
            rel.to_owned()
        });
        return Ok(());
    }
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if meta.is_dir() {
            list_skills(&path, &child, false, depth + 1, out, visited)?;
        } else if root_files && name.ends_with(".md") {
            out.push(child);
        }
    }
    Ok(())
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

    /// 按 `inspect` 给出的当前指纹信任（等同用户在弹窗中点“信任”）。
    fn trust_now(ws: &Workspaces, path: &str) {
        let fp = inspect(path).unwrap().fingerprint;
        ws.trust(path, true, fp.as_deref()).unwrap();
    }

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
        assert!(ws.trust(a.to_str().unwrap(), false, None).is_err());
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
            ws.trust(root.join("other").to_str().unwrap(), false, None),
            Err(WorkspaceError::Unknown(_))
        ));
        trust_now(&ws, &path);
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
        ws.trust(&path, false, None).unwrap();
        let again = ws.open(&path).unwrap();
        assert!(!again.needs_trust && !again.trusted);
        assert!(!ws.approved(&path));

        trust_now(&ws, &path);
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
        trust_now(&ws, &path);
        assert!(ws.approved(&path));

        std::fs::write(proj.join(".primus/extensions/a.js"), "two").unwrap();
        let info = ws.open(&path).unwrap();
        assert!(info.needs_trust && !info.trusted);
        assert!(!ws.approved(&path));

        trust_now(&ws, &path);
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
        std::fs::write(proj.join(".primus/skills/review/SKILL.md"), "").unwrap();
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
    fn trust_requires_the_fingerprint_the_user_saw() {
        let root = temp_dir("seen");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::write(proj.join(".primus/extensions/a.js"), "one").unwrap();
        let path = proj.to_string_lossy().into_owned();
        let ws = Workspaces::new(&root.join("app"));
        ws.open(&path).unwrap();

        let seen = inspect(&path).unwrap().fingerprint;
        assert!(seen.is_some());
        // 弹窗展示之后内容被改：拒绝记为信任
        std::fs::write(proj.join(".primus/extensions/b.js"), "new").unwrap();
        assert!(matches!(
            ws.trust(&path, true, seen.as_deref()),
            Err(WorkspaceError::TrustChanged)
        ));
        assert!(matches!(
            ws.trust(&path, true, None),
            Err(WorkspaceError::TrustChanged)
        ));
        assert!(!ws.approved(&path));
        trust_now(&ws, &path);
        assert!(ws.approved(&path));
    }

    #[test]
    fn trust_binds_to_the_exact_path() {
        let root = temp_dir("exact");
        let proj = root.join("Proj");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.to_string_lossy().into_owned();
        let ws = Workspaces::new(&root.join("app"));
        ws.open(&path).unwrap();
        trust_now(&ws, &path);
        assert!(ws.approved(&path));
        // 末尾分隔符经规范化后仍是同一路径
        assert!(ws.approved(&format!("{path}/")));

        // 只差大小写的路径（在区分大小写的目录里是另一个目录）不沿用信任
        let other = root.join("proj");
        std::fs::create_dir_all(&other).unwrap();
        let other = other.to_string_lossy().into_owned();
        assert!(!ws.approved(&other));
        assert!(matches!(
            ws.trust(&other, false, None),
            Err(WorkspaceError::Unknown(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_content_is_part_of_the_fingerprint() {
        let root = temp_dir("link");
        let proj = root.join("proj");
        let outside = root.join("outside");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("index.js"), "one").unwrap();
        std::os::unix::fs::symlink(&outside, proj.join(".primus/extensions/ext")).unwrap();
        // 指回自身的链接不会无限递归
        std::os::unix::fs::symlink(proj.join(".primus"), proj.join(".primus/loop")).unwrap();
        let path = proj.to_string_lossy().into_owned();
        let ws = Workspaces::new(&root.join("app"));
        ws.open(&path).unwrap();
        assert_eq!(inspect(&path).unwrap().extensions, vec!["ext"]);
        trust_now(&ws, &path);
        assert!(ws.approved(&path));

        std::fs::write(outside.join("index.js"), "two").unwrap();
        assert!(!ws.approved(&path));
        trust_now(&ws, &path);

        // 断开的链接无法确认内容：指纹不完整，不能信任
        std::os::unix::fs::symlink(root.join("missing"), proj.join(".primus/broken")).unwrap();
        assert!(!ws.approved(&path));
        assert_eq!(inspect(&path).unwrap().fingerprint, None);
        assert!(matches!(
            ws.trust(&path, true, None),
            Err(WorkspaceError::Incomplete)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_project_files_are_errors_not_absent() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir("noread");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/skills")).unwrap();
        let agents = proj.join("AGENTS.md");
        std::fs::write(&agents, "x").unwrap();
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o000)).unwrap();
        // 以 root 运行时权限不起作用，跳过
        if std::fs::read(&agents).is_ok() {
            return;
        }
        assert!(matches!(
            inspect(&proj.to_string_lossy()),
            Err(WorkspaceError::Read(..))
        ));
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o644)).unwrap();
        let skills = proj.join(".primus/skills");
        std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o000)).unwrap();
        let d = inspect(&proj.to_string_lossy());
        std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(d, Err(WorkspaceError::Read(..))));
    }

    #[test]
    fn lists_only_what_core_loads() {
        let root = temp_dir("loads");
        let p = root.join("proj/.primus");
        let ext = p.join("extensions");
        std::fs::create_dir_all(ext.join("with-index")).unwrap();
        std::fs::create_dir_all(ext.join("with-pkg")).unwrap();
        std::fs::create_dir_all(ext.join("empty-pkg")).unwrap();
        std::fs::create_dir_all(ext.join("plain-dir")).unwrap();
        std::fs::write(ext.join("a.ts"), "").unwrap();
        std::fs::write(ext.join("notes.txt"), "").unwrap();
        std::fs::write(ext.join("with-index/index.js"), "").unwrap();
        std::fs::write(
            ext.join("with-pkg/package.json"),
            r#"{"pi":{"extensions":["./main.ts"]}}"#,
        )
        .unwrap();
        std::fs::write(ext.join("empty-pkg/package.json"), r#"{"name":"x"}"#).unwrap();

        let sk = p.join("skills");
        std::fs::create_dir_all(sk.join("review")).unwrap();
        std::fs::create_dir_all(sk.join("group/deep/inner")).unwrap();
        std::fs::create_dir_all(sk.join("nothing")).unwrap();
        std::fs::create_dir_all(sk.join("node_modules/pkg")).unwrap();
        std::fs::write(sk.join("review/SKILL.md"), "").unwrap();
        std::fs::write(sk.join("review/extra.md"), "").unwrap();
        std::fs::write(sk.join("group/deep/inner/SKILL.md"), "").unwrap();
        std::fs::write(sk.join("group/readme.md"), "").unwrap();
        std::fs::write(sk.join("nothing/x.txt"), "").unwrap();
        std::fs::write(sk.join("node_modules/pkg/SKILL.md"), "").unwrap();
        std::fs::write(sk.join("top.md"), "").unwrap();
        std::fs::write(sk.join("data.json"), "").unwrap();

        let d = inspect(&root.join("proj").to_string_lossy()).unwrap();
        assert_eq!(d.extensions, vec!["a.ts", "with-index", "with-pkg"]);
        assert_eq!(d.skills, vec!["group/deep/inner", "review", "top.md"]);
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
