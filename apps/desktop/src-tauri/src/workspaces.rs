//! 工作区管理（第 15.1 节、附录 B 的 `workspace_open` / `workspace_list` / `workspace_trust`）。
//!
//! 最近打开的工作区与信任状态存在 `users/<SID>/app/workspaces.json`（约束 C2：只写数据目录）。
//! 按最近打开时间倒序，最多保留 [`MAX_RECENT`] 个；同一目录按 [`crate::platform::path_key`] 去重
//! （Windows 不区分大小写、`/` 与 `\` 等价、忽略末尾分隔符）。写入先写临时文件再改名，不会留下半个文件。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 最近工作区列表的上限。
pub(crate) const MAX_RECENT: usize = 30;

/// 返回给前端的工作区信息（与 `WorkspaceInfo` 对应）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceInfo {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) trusted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    #[serde(default)]
    trusted: bool,
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
        let trusted = match store
            .workspaces
            .iter()
            .position(|e| crate::platform::path_key(&e.path) == key)
        {
            Some(i) => store.workspaces.remove(i).trusted,
            None => false,
        };
        store.workspaces.insert(
            0,
            Entry {
                path: path.clone(),
                trusted,
                last_opened: now_ms(),
            },
        );
        store.workspaces.truncate(MAX_RECENT);
        self.save(&store)?;
        Ok(info(&path, trusted))
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
            .map(|e| info(&e.path, e.trusted))
            .collect())
    }

    /// 设置信任状态；目标必须已打开过。
    pub(crate) fn trust(&self, path: &str, trusted: bool) -> Result<(), WorkspaceError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = self.load()?;
        let key = crate::platform::path_key(path);
        let entry = store
            .workspaces
            .iter_mut()
            .find(|e| crate::platform::path_key(&e.path) == key)
            .ok_or_else(|| WorkspaceError::Unknown(path.to_owned()))?;
        if entry.trusted == trusted {
            return Ok(());
        }
        entry.trusted = trusted;
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

fn info(path: &str, trusted: bool) -> WorkspaceInfo {
    WorkspaceInfo {
        path: path.to_owned(),
        name: display_name(path),
        trusted,
    }
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
