//! 数据目录（技术方案第 4 章）：定位 `data` 根目录、创建 `users/<SID>` 并收紧 ACL、可写性检查。
//!
//! - 定位规则（第 4.1 节）：`--data-dir <path>` > 开发模式（debug 构建）仓库下 `.dev-data/` >
//!   `<Primus.exe 所在目录>/data`。**任何情况下都不回退到 `%APPDATA%` 或用户主目录**（约束 C2）。
//! - 目录布局见第 4.2 节；每个 Windows 用户一份 `users/<SID>/`，创建时 ACL 设为仅当前用户与 SYSTEM（第 4.3 节）；
//!   已存在的 `users/<SID>` 必须归当前用户所有且不是重解析点，防止其他本地用户预先创建或做成 junction。
//! - `data` 不可写时由 [`prepare_or_guide`] 弹出修复引导（第 3.7 节），平台相关部分在 `platform` 模块。
//! - 数据版本与迁移（第 4.5 节，`install.json`）属于开发计划第 17 周，不在本模块当前范围内。

// 各子目录的访问器由后续模块（supervisor、core_config、vault、session_index 等）使用；
// 它们接入前，非测试构建先放行未使用告警，全部接入后删除此属性。
#![cfg_attr(not(test), allow(dead_code))]

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::platform;

/// 覆盖数据目录的命令行参数（仅用于测试和便携使用，第 4.1 节）。
pub(crate) const DATA_DIR_ARG: &str = "--data-dir";

/// 修复引导以管理员身份重新拉起自身时使用的参数：给 `<exe 目录>/data` 重新授予 Users 组修改权限后退出。
/// 不接受路径参数，避免被提权进程用来修改任意目录的权限。
pub(crate) const REPAIR_DATA_DIR_ARG: &str = "--repair-data-dir";

/// 安装目录下数据目录的名称（与 `Primus.wxs` 中的 `DATADIR` 一致）。
pub(crate) const DATA_DIR_NAME: &str = "data";

/// 仓库根目录（`apps/desktop/src-tauri` 向上三级），仅开发模式使用。
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

/// 开发模式数据目录：仓库根下的 `.dev-data/`。
const DEV_DATA_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.dev-data");

/// 可写性检查用的探测文件名前缀；检查完立即删除。
const PROBE_PREFIX: &str = ".primus-write-test-";

/// 数据根目录从哪里来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DataRootSource {
    /// `--data-dir` 命令行参数
    CommandLine,
    /// 开发模式（debug 构建）：仓库下 `.dev-data/`
    Dev,
    /// 正常安装：`<Primus.exe 所在目录>/data`
    Install,
}

/// 定位出的数据根目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DataRoot {
    pub(crate) path: PathBuf,
    pub(crate) source: DataRootSource,
}

/// 数据目录准备失败的原因。
#[derive(Debug)]
pub(crate) enum PathsError {
    /// `--data-dir` 后面缺少路径，或路径为空
    MissingArgValue,
    /// 无法确定可执行文件所在目录
    ExeDir(io::Error),
    /// 目录无法创建或无法写入
    NotWritable { path: PathBuf, source: io::Error },
    /// 无法取得当前 Windows 用户的 SID
    UserId(io::Error),
    /// 无法把 `users/<SID>` 的 ACL 设为仅当前用户与 SYSTEM
    Acl { path: PathBuf, source: io::Error },
}

impl fmt::Display for PathsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingArgValue => write!(f, "{DATA_DIR_ARG} 参数后缺少数据目录路径"),
            Self::ExeDir(e) => write!(f, "无法确定 Primus.exe 所在目录：{e}"),
            Self::NotWritable { path, source } => {
                write!(f, "数据目录不可写：{}（{source}）", path.display())
            }
            Self::UserId(e) => write!(f, "无法取得当前 Windows 用户标识：{e}"),
            Self::Acl { path, source } => {
                write!(
                    f,
                    "无法设置用户数据目录权限：{}（{source}）",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for PathsError {}

/// 从命令行参数中取出 `--data-dir`：支持 `--data-dir <path>` 与 `--data-dir=<path>`，只取第一次出现。
/// 相对路径按当前工作目录解析为绝对路径。
pub(crate) fn parse_data_dir_arg<I>(args: I) -> Result<Option<PathBuf>, PathsError>
where
    I: IntoIterator<Item = OsString>,
{
    let prefix = format!("{DATA_DIR_ARG}=");
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let value = if arg == DATA_DIR_ARG {
            args.next().ok_or(PathsError::MissingArgValue)?
        } else if let Some(rest) = arg.to_str().and_then(|s| s.strip_prefix(&prefix)) {
            OsString::from(rest)
        } else {
            continue;
        };
        if value.is_empty() {
            return Err(PathsError::MissingArgValue);
        }
        let path = PathBuf::from(value);
        let path = std::path::absolute(&path).unwrap_or(path);
        return Ok(Some(path));
    }
    Ok(None)
}

/// 命令行参数中是否包含提权修复模式参数。
pub(crate) fn has_repair_arg<I>(args: I) -> bool
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter().any(|a| a == REPAIR_DATA_DIR_ARG)
}

/// 按第 4.1 节的优先级确定数据根目录（纯函数，便于测试）。
pub(crate) fn resolve_root(
    cli: Option<PathBuf>,
    dev_mode: bool,
    exe_dir: &Path,
    dev_dir: &Path,
) -> DataRoot {
    match cli {
        Some(path) => DataRoot {
            path,
            source: DataRootSource::CommandLine,
        },
        None if dev_mode => DataRoot {
            path: normalize(dev_dir),
            source: DataRootSource::Dev,
        },
        None => DataRoot {
            path: exe_dir.join(DATA_DIR_NAME),
            source: DataRootSource::Install,
        },
    }
}

/// 当前可执行文件所在目录。
pub(crate) fn exe_dir() -> Result<PathBuf, PathsError> {
    let exe = std::env::current_exe().map_err(PathsError::ExeDir)?;
    exe.parent().map(Path::to_path_buf).ok_or_else(|| {
        PathsError::ExeDir(io::Error::new(
            io::ErrorKind::NotFound,
            "可执行文件路径没有父目录",
        ))
    })
}

/// 开发模式数据目录（仓库下 `.dev-data/`）。
pub(crate) fn dev_data_dir() -> PathBuf {
    normalize(Path::new(DEV_DATA_DIR))
}

/// 仓库根目录（开发模式下 Core 构建产物在其 `dist/` 中）。
pub(crate) fn repo_root() -> PathBuf {
    normalize(Path::new(REPO_ROOT))
}

/// 去掉路径中的 `.` 与 `..`（不访问文件系统、不解析符号链接），让日志与界面上显示的路径更易读。
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// 一个 Windows 用户的全部数据路径（第 4.2 节）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DataPaths {
    root: PathBuf,
    source: DataRootSource,
    user_id: String,
}

impl DataPaths {
    /// 只计算路径，不访问文件系统。
    pub(crate) fn new(root: DataRoot, user_id: impl Into<String>) -> Self {
        Self {
            root: root.path,
            source: root.source,
            user_id: user_id.into(),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn source(&self) -> DataRootSource {
        self.source
    }
    /// 当前 Windows 用户的 SID 字符串（如 `S-1-5-21-…`）。
    pub(crate) fn user_id(&self) -> &str {
        &self.user_id
    }

    /// `data/shared/logs`：薄壳日志
    pub(crate) fn logs_dir(&self) -> PathBuf {
        self.root.join("shared").join("logs")
    }
    /// `data/shared/crash`：崩溃转储
    pub(crate) fn crash_dir(&self) -> PathBuf {
        self.root.join("shared").join("crash")
    }
    /// `data/users/<SID>`
    pub(crate) fn user_dir(&self) -> PathBuf {
        self.root.join("users").join(&self.user_id)
    }
    /// `users/<SID>/app`：settings.toml、workspaces.json、index.db
    pub(crate) fn app_dir(&self) -> PathBuf {
        self.user_dir().join("app")
    }
    /// `users/<SID>/core`：`PRIMUS_CODING_AGENT_DIR`
    pub(crate) fn core_dir(&self) -> PathBuf {
        self.user_dir().join("core")
    }
    /// `users/<SID>/core/sessions`：`PRIMUS_CODING_AGENT_SESSION_DIR`
    pub(crate) fn sessions_dir(&self) -> PathBuf {
        self.core_dir().join("sessions")
    }
    /// `users/<SID>/vault`：secrets.bin
    pub(crate) fn vault_dir(&self) -> PathBuf {
        self.user_dir().join("vault")
    }
    /// `users/<SID>/checkpoints`：检查点影子仓库
    pub(crate) fn checkpoints_dir(&self) -> PathBuf {
        self.user_dir().join("checkpoints")
    }
    /// `users/<SID>/artifacts`：大工具输出原文
    pub(crate) fn artifacts_dir(&self) -> PathBuf {
        self.user_dir().join("artifacts")
    }
    /// `users/<SID>/webview`：WebView2 用户数据
    pub(crate) fn webview_dir(&self) -> PathBuf {
        self.user_dir().join("webview")
    }
    /// `users/<SID>/tmp`：Core 与工具进程的 TEMP/TMP
    pub(crate) fn tmp_dir(&self) -> PathBuf {
        self.user_dir().join("tmp")
    }
    /// `users/<SID>/updates`：自动更新的待装包与 pending.json（ADR 0007）
    pub(crate) fn updates_dir(&self) -> PathBuf {
        self.user_dir().join("updates")
    }

    /// 启动时需要存在的全部目录（`users/<SID>` 本身除外，它单独创建并设置 ACL）。
    fn shared_dirs(&self) -> [PathBuf; 2] {
        [self.logs_dir(), self.crash_dir()]
    }
    fn user_subdirs(&self) -> [PathBuf; 9] {
        [
            self.app_dir(),
            self.core_dir(),
            self.sessions_dir(),
            self.vault_dir(),
            self.checkpoints_dir(),
            self.artifacts_dir(),
            self.webview_dir(),
            self.tmp_dir(),
            self.updates_dir(),
        ]
    }
}

/// 在 `root` 下创建目录布局：先检查根目录可写，再安全地创建 `users/<SID>`（受限 ACL），最后创建各子目录。
pub(crate) fn prepare_at(root: DataRoot, user_id: &str) -> Result<DataPaths, PathsError> {
    let paths = DataPaths::new(root, user_id);
    create_dir(paths.root())?;
    check_writable(paths.root())?;

    for dir in paths.shared_dirs() {
        create_dir(&dir)?;
    }

    // data 对 Users 组可写，其他本地用户可能抢先创建、重命名 users 或 users/<SID>（SID 不是秘密）：
    // users 带受保护 DACL（普通用户只能新建子目录，不能删除、重命名或改权限），不能是重解析点；
    // users/<SID> 新建时直接带受限 DACL，已存在时所有者须可信且不是重解析点
    let users_dir = paths.root().join("users");
    platform::secure_users_root(&users_dir).map_err(|source| PathsError::Acl {
        path: users_dir.clone(),
        source,
    })?;
    let user_dir = paths.user_dir();
    // 每次启动都重设：幂等，且能纠正被手工放宽的权限；子目录随继承规则自动生效
    platform::secure_user_dir(&user_dir).map_err(|source| PathsError::Acl {
        path: user_dir.clone(),
        source,
    })?;
    for dir in paths.user_subdirs() {
        create_dir(&dir)?;
    }
    check_writable(&user_dir)?;
    Ok(paths)
}

/// 按当前进程的命令行、构建模式与可执行文件位置准备数据目录。
pub(crate) fn prepare() -> Result<DataPaths, PathsError> {
    let cli = parse_data_dir_arg(std::env::args_os().skip(1))?;
    let root = resolve_root(cli, cfg!(debug_assertions), &exe_dir()?, &dev_data_dir());
    let user_id = platform::current_user_id().map_err(PathsError::UserId)?;
    prepare_at(root, &user_id)
}

/// 用户在修复引导中的选择（第 3.7 节）。
// 非 Windows 的最小实现只会返回 Quit
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RepairChoice {
    /// 以管理员身份修复 `data` 权限后重试
    RepairAsAdmin,
    /// 重新安装到其他目录（打开安装包下载页后退出）
    Reinstall,
    /// 直接退出
    Quit,
}

/// 准备数据目录；不可写时弹出修复引导。返回 `None` 表示用户选择退出或修复失败，调用方应结束进程。
/// 绝不回退到 AppData（约束 C2）。
pub(crate) fn prepare_or_guide() -> Option<DataPaths> {
    let mut repaired = false;
    loop {
        let err = match prepare() {
            Ok(paths) => return Some(paths),
            Err(err) => err,
        };
        // 只有安装目录下的 data 才提供“以管理员身份修复”：--data-dir 与开发目录由使用者自己负责
        let repairable = !repaired
            && matches!(err, PathsError::NotWritable { .. })
            && is_install_root_error(&err);
        match platform::show_data_dir_guide(&err.to_string(), repairable) {
            RepairChoice::RepairAsAdmin if repairable => {
                repaired = true;
                match platform::run_elevated_repair() {
                    Ok(true) => continue,
                    Ok(false) => {
                        platform::show_error("修复未完成：管理员授权被取消或修复失败。");
                        return None;
                    }
                    Err(e) => {
                        platform::show_error(&format!("无法以管理员身份运行修复：{e}"));
                        return None;
                    }
                }
            }
            RepairChoice::Reinstall => {
                platform::open_reinstall_page();
                return None;
            }
            _ => return None,
        }
    }
}

/// 错误是否发生在安装目录下的 `data` 中（而不是 `--data-dir` 指定的目录或开发目录）。
fn is_install_root_error(err: &PathsError) -> bool {
    let Ok(cli) = parse_data_dir_arg(std::env::args_os().skip(1)) else {
        return false;
    };
    if cli.is_some() || cfg!(debug_assertions) {
        return false;
    }
    let (PathsError::NotWritable { path, .. }, Ok(exe_dir)) = (err, exe_dir()) else {
        return false;
    };
    path.starts_with(exe_dir.join(DATA_DIR_NAME))
}

/// 提权修复模式：给 `<exe 目录>/data` 重新授予 Users 组修改权限（与 MSI 安装时一致）。返回进程退出码。
pub(crate) fn run_repair_mode() -> i32 {
    let result = exe_dir().and_then(|dir| {
        let data = dir.join(DATA_DIR_NAME);
        create_dir(&data)?;
        platform::grant_users_modify(&data).map_err(|source| PathsError::NotWritable {
            path: data.clone(),
            source,
        })
    });
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn create_dir(path: &Path) -> Result<(), PathsError> {
    fs::create_dir_all(path).map_err(|source| PathsError::NotWritable {
        path: path.to_path_buf(),
        source,
    })
}

/// 实际创建、写入并删除一个探测文件来判断目录可写（只看只读属性或 ACL 不可靠）。
pub(crate) fn check_writable(dir: &Path) -> Result<(), PathsError> {
    let probe = dir.join(format!("{PROBE_PREFIX}{}", std::process::id()));
    let attempt = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&probe)?;
        file.write_all(b"primus")?;
        file.sync_all()?;
        drop(file);
        fs::remove_file(&probe)
    })();
    attempt.map_err(|source| {
        let _ = fs::remove_file(&probe);
        PathsError::NotWritable {
            path: dir.to_path_buf(),
            source,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 每个用例一个独立的临时目录，用例结束时删除。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!(
                "primus-paths-{}-{nanos}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).expect("创建临时目录");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            #[cfg(unix)]
            {
                // 恢复权限，保证只读用例的目录也能删掉
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn root_at(path: &Path) -> DataRoot {
        DataRoot {
            path: path.to_path_buf(),
            source: DataRootSource::CommandLine,
        }
    }

    #[test]
    fn data_dir_arg_absent() {
        assert_eq!(parse_data_dir_arg(args(&["--foo", "bar"])).unwrap(), None);
    }

    #[test]
    fn data_dir_arg_separate_and_equals_forms() {
        let base = std::env::temp_dir();
        let p = base.join("primus-portable");
        let separate = parse_data_dir_arg(args(&["--data-dir", p.to_str().unwrap()])).unwrap();
        assert_eq!(separate, Some(p.clone()));
        let equals = parse_data_dir_arg(args(&[&format!("--data-dir={}", p.display())])).unwrap();
        assert_eq!(equals, Some(p));
    }

    #[test]
    fn data_dir_arg_first_occurrence_wins() {
        let a = std::env::temp_dir().join("a");
        let b = std::env::temp_dir().join("b");
        let parsed = parse_data_dir_arg(args(&[
            "--data-dir",
            a.to_str().unwrap(),
            "--data-dir",
            b.to_str().unwrap(),
        ]))
        .unwrap();
        assert_eq!(parsed, Some(a));
    }

    #[test]
    fn data_dir_arg_relative_becomes_absolute() {
        let parsed = parse_data_dir_arg(args(&["--data-dir", "portable-data"]))
            .unwrap()
            .unwrap();
        assert!(parsed.is_absolute());
        assert!(parsed.ends_with("portable-data"));
    }

    #[test]
    fn data_dir_arg_missing_or_empty_value_is_error() {
        assert!(matches!(
            parse_data_dir_arg(args(&["--data-dir"])),
            Err(PathsError::MissingArgValue)
        ));
        assert!(matches!(
            parse_data_dir_arg(args(&["--data-dir="])),
            Err(PathsError::MissingArgValue)
        ));
        assert!(matches!(
            parse_data_dir_arg(args(&["--data-dir", ""])),
            Err(PathsError::MissingArgValue)
        ));
    }

    #[test]
    fn repair_arg_detected() {
        assert!(has_repair_arg(args(&["--repair-data-dir"])));
        assert!(!has_repair_arg(args(&["--data-dir", "x"])));
    }

    #[test]
    fn resolve_root_priority() {
        let exe = Path::new("/opt/Primus");
        let dev = Path::new("/repo/apps/desktop/src-tauri/../../../.dev-data");
        let cli = PathBuf::from("/portable/data");

        let r = resolve_root(Some(cli.clone()), true, exe, dev);
        assert_eq!(r.source, DataRootSource::CommandLine);
        assert_eq!(r.path, cli);

        let r = resolve_root(None, true, exe, dev);
        assert_eq!(r.source, DataRootSource::Dev);
        assert_eq!(r.path, PathBuf::from("/repo/.dev-data"));

        let r = resolve_root(None, false, exe, dev);
        assert_eq!(r.source, DataRootSource::Install);
        assert_eq!(r.path, exe.join("data"));
    }

    #[test]
    fn dev_data_dir_is_repo_root() {
        let dir = dev_data_dir();
        assert!(dir.ends_with(".dev-data"));
        // 仓库根下有 pnpm-workspace.yaml
        assert!(dir.parent().unwrap().join("pnpm-workspace.yaml").is_file());
    }

    #[test]
    fn layout_matches_spec() {
        let p = DataPaths::new(root_at(Path::new("/d")), "S-1-5-21-1");
        let user = PathBuf::from("/d/users/S-1-5-21-1");
        assert_eq!(p.root(), Path::new("/d"));
        assert_eq!(p.source(), DataRootSource::CommandLine);
        assert_eq!(p.user_id(), "S-1-5-21-1");
        assert_eq!(p.user_dir(), user);
        assert_eq!(p.logs_dir(), PathBuf::from("/d/shared/logs"));
        assert_eq!(p.crash_dir(), PathBuf::from("/d/shared/crash"));
        assert_eq!(p.app_dir(), user.join("app"));
        assert_eq!(p.core_dir(), user.join("core"));
        assert_eq!(p.sessions_dir(), user.join("core").join("sessions"));
        assert_eq!(p.vault_dir(), user.join("vault"));
        assert_eq!(p.checkpoints_dir(), user.join("checkpoints"));
        assert_eq!(p.artifacts_dir(), user.join("artifacts"));
        assert_eq!(p.webview_dir(), user.join("webview"));
        assert_eq!(p.tmp_dir(), user.join("tmp"));
        assert_eq!(p.updates_dir(), user.join("updates"));
    }

    #[test]
    fn prepare_creates_layout_in_missing_root() {
        let tmp = TempDir::new();
        let root = tmp.0.join("nested").join("data");
        let user = platform::current_user_id().expect("当前用户标识");
        let paths = prepare_at(root_at(&root), &user).expect("准备数据目录");
        for dir in paths
            .shared_dirs()
            .iter()
            .chain(paths.user_subdirs().iter())
        {
            assert!(dir.is_dir(), "{} 应已创建", dir.display());
        }
        // 探测文件不留痕迹
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(PROBE_PREFIX))
            .collect();
        assert!(leftovers.is_empty());
        // 第二次启动幂等
        prepare_at(root_at(&root), &user).expect("重复准备应成功");
    }

    #[test]
    fn root_that_is_a_file_is_not_writable() {
        let tmp = TempDir::new();
        let file = tmp.0.join("data");
        fs::write(&file, b"x").unwrap();
        let err = prepare_at(root_at(&file), "u").unwrap_err();
        assert!(matches!(err, PathsError::NotWritable { ref path, .. } if path == &file));
        assert!(err.to_string().contains("数据目录不可写"));
    }

    #[cfg(unix)]
    #[test]
    fn read_only_root_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        fs::set_permissions(&tmp.0, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(tmp.0.join("probe"), b"x").is_ok() {
            // 以 root 运行时权限位不生效，跳过
            return;
        }
        assert!(matches!(
            check_writable(&tmp.0),
            Err(PathsError::NotWritable { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn user_dir_restricted_to_owner() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let paths = prepare_at(root_at(&tmp.0), "u").unwrap();
        let mode = fs::metadata(paths.user_dir()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn existing_user_dir_is_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let user = tmp.0.join("users").join("u");
        fs::create_dir_all(&user).unwrap();
        fs::set_permissions(&user, fs::Permissions::from_mode(0o777)).unwrap();
        let paths = prepare_at(root_at(&tmp.0), "u").unwrap();
        let mode = fs::metadata(paths.user_dir()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn user_dir_symlink_is_rejected() {
        let tmp = TempDir::new();
        let target = tmp.0.join("elsewhere");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(tmp.0.join("users")).unwrap();
        std::os::unix::fs::symlink(&target, tmp.0.join("users").join("u")).unwrap();
        let err = prepare_at(root_at(&tmp.0), "u").unwrap_err();
        assert!(matches!(err, PathsError::Acl { .. }), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn users_dir_symlink_is_rejected() {
        let tmp = TempDir::new();
        let target = tmp.0.join("elsewhere");
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, tmp.0.join("users")).unwrap();
        let err = prepare_at(root_at(&tmp.0), "u").unwrap_err();
        assert!(matches!(err, PathsError::Acl { .. }), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn existing_user_dir_acl_is_tightened() {
        let tmp = TempDir::new();
        let user = platform::current_user_id().unwrap();
        let dir = tmp.0.join("users").join(&user);
        fs::create_dir_all(&dir).unwrap();
        prepare_at(root_at(&tmp.0), &user).unwrap();
        let (protected, aces) = platform::dacl_summary(&dir).unwrap();
        assert!(protected);
        assert_eq!(aces, 2);
        // 预先存在、继承了上级权限的 users 也在同一句柄上被收紧
        let (protected, aces) = platform::dacl_summary(&tmp.0.join("users")).unwrap();
        assert!(protected);
        assert_eq!(aces, 4);
    }

    #[cfg(windows)]
    #[test]
    fn grant_users_modify_adds_an_ace() {
        let tmp = TempDir::new();
        let (_, before) = platform::dacl_summary(&tmp.0).unwrap();
        platform::grant_users_modify(&tmp.0).unwrap();
        let (_, after) = platform::dacl_summary(&tmp.0).unwrap();
        assert!(after > before, "应追加 Users 组 ACE：{before} -> {after}");
    }

    #[cfg(windows)]
    #[test]
    fn user_dir_acl_is_protected_with_user_and_system_only() {
        let tmp = TempDir::new();
        let user = platform::current_user_id().unwrap();
        assert!(user.starts_with("S-1-"), "应为 SID 字符串：{user}");
        let paths = prepare_at(root_at(&tmp.0), &user).unwrap();
        let (protected, aces) = platform::dacl_summary(&paths.user_dir()).unwrap();
        assert!(protected, "DACL 应禁止继承上级权限");
        assert_eq!(aces, 2, "只应有当前用户与 SYSTEM 两条 ACE");
        let (protected, aces) = platform::dacl_summary(&tmp.0.join("users")).unwrap();
        assert!(
            protected,
            "users 的 DACL 应禁止继承 data 上的 Users 修改权限"
        );
        assert_eq!(
            aces, 4,
            "SYSTEM、Administrators、Users、OWNER RIGHTS 四条 ACE"
        );
    }
}
