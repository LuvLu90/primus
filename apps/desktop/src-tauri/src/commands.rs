//! Tauri 命令入口（附录 B），只做参数校验与转发。

use std::io;
use std::path::{Component, Path};
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::account::{AuthError, AuthStatus};
use crate::core_config::{
    FetchInput, ModelConfigState, ModelsInfo, ProviderInput, ProviderView, ProvidersChanged,
};
use crate::fs_watch::{IndexChanged, IndexNotifier};
use crate::paths::DataPaths;
use crate::providers::ProviderModel;
use crate::rpc_bridge::{BatchSink, BridgeError, CoreBatch};
use crate::session_index::{SessionIndex, SessionPage, SessionSummary};
use crate::sessions::{AppSessions, SessionError, Sessions};
use crate::supervisor::Supervisor;
use crate::updater::{
    InstallTrigger, LaunchOutcome, UpdateChannel, UpdateError, UpdateStatus, Updater,
};
use crate::workspaces::{TrustDetails, WorkspaceInfo, Workspaces};

/// 可以打开的系统设置页（语音输入被系统隐私设置拒绝时，引导用户去开麦克风 / 联机语音识别）。只认这几个完整值。
const SETTINGS_PAGES: &[&str] = &[
    "ms-settings:privacy-microphone",
    "ms-settings:privacy-speech",
];

/// 外部链接只允许 http/https（以及 [`SETTINGS_PAGES`] 中的系统设置页），长度有限且不含空白与控制字符
/// （防止被当成命令行参数或本地路径执行）。
fn check_external_url(target: &str) -> Result<(), String> {
    if SETTINGS_PAGES.contains(&target) {
        return Ok(());
    }
    let lower = target.to_ascii_lowercase();
    let scheme_ok = lower.starts_with("https://") || lower.starts_with("http://");
    let host_ok = target.split_once("://").is_some_and(|(_, rest)| {
        !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('\\')
    });
    if !scheme_ok || !host_ok {
        return Err("只能打开 http 或 https 链接".into());
    }
    if target.len() > 2048 || target.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("链接格式不正确".into());
    }
    Ok(())
}

/// 用系统默认浏览器打开外部链接（附录 B `open_external`；前端已让用户确认）。
#[tauri::command]
pub fn open_external(target: String) -> Result<(), String> {
    check_external_url(&target)?;
    crate::platform::open_url(&target).map_err(|e| e.to_string())
}

/// 用系统默认程序打开回复里引用的本机文件（附录 B `open_path`）。路径须是已存在的本机绝对路径；
/// 可执行与脚本类文件不直接运行，改为在文件夹中显示并返回 `revealed`（见 open_path.rs）。
#[tauri::command]
pub fn open_path(path: String) -> Result<crate::open_path::OpenOutcome, String> {
    use crate::open_path::{OpenOutcome, check_path};
    let checked = check_path(&path)?;
    if checked.risky {
        crate::platform::reveal_in_folder(&checked.path).map_err(|e| e.to_string())?;
        return Ok(OpenOutcome::Revealed);
    }
    crate::platform::shell_open(&checked.path).map_err(|e| e.to_string())?;
    Ok(OpenOutcome::Opened)
}

/// 在系统文件管理器中显示回复里引用的本机文件（附录 B `reveal_path`），校验同 `open_path`。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let checked = crate::open_path::check_path(&path)?;
    crate::platform::reveal_in_folder(&checked.path).map_err(|e| e.to_string())
}

/// 右栏预览回复里引用或 Agent 写出的本机文件（附录 B `preview_file`）：校验同 `open_path`，只读，最多 1 MiB。
#[tauri::command(async)]
pub(crate) fn preview_file(path: String) -> Result<crate::preview::Preview, String> {
    let checked = crate::open_path::check_path(&path)?;
    crate::preview::read_preview(&checked.path)
}

/// 右栏按“打开后的样子”预览 Word / PowerPoint / Excel / PDF、音频视频与 GIF / ICO / AVIF 图片
/// （附录 B `preview_file_bytes`）：校验同 `open_path`，只读，只接受这些扩展名，文档与图片最多 30 MiB、
/// 音频视频最多 64 MiB；以原始字节返回（前端得到 ArrayBuffer，不走 JSON / base64）。
#[tauri::command(async)]
pub(crate) fn preview_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let checked = crate::open_path::check_path(&path)?;
    crate::preview::read_document(&checked.path).map(tauri::ipc::Response::new)
}

/// 右栏文件夹预览（附录 B `preview_dir`）：校验同 `open_path`，只读目录项元数据，列出直接子项
/// （文件夹在前、按名称排序，最多 2000 项），隐藏 / 系统项带 `hidden` 标记由前端决定是否显示。
#[tauri::command(async)]
pub(crate) fn preview_dir(path: String) -> Result<crate::preview::DirListing, String> {
    let checked = crate::open_path::check_path(&path)?;
    crate::preview::list_dir(&checked.path, crate::platform::is_hidden_entry)
}

/// 原子设置主窗口外框（物理像素），侧栏开关时窗口边缘跟随侧栏逐帧伸缩用。
#[tauri::command]
pub fn window_set_bounds(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("window size must be positive".into());
    }
    crate::platform::set_window_bounds(&window, x, y, width, height).map_err(|e| e.to_string())
}

/// 打开（登记）工作区：必须是已存在目录的绝对路径，返回显示名与信任状态（第 15.1 节）。
#[tauri::command(async)]
pub(crate) fn workspace_open(
    workspaces: State<'_, Workspaces>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    workspaces.open(&path).map_err(|e| e.to_string())
}

/// 最近工作区，最近打开的在前。
#[tauri::command(async)]
pub(crate) fn workspace_list(
    workspaces: State<'_, Workspaces>,
) -> Result<Vec<WorkspaceInfo>, String> {
    workspaces.list().map_err(|e| e.to_string())
}

/// 信任确认需要展示的项目内容：`AGENTS.md` 与 `.primus/` 下的扩展、技能、MCP 配置。
#[tauri::command(async)]
pub(crate) fn workspace_inspect(path: String) -> Result<TrustDetails, String> {
    crate::workspaces::inspect(&path).map_err(|e| e.to_string())
}

/// 记录信任确认的选择；信任时带回 `workspace_inspect` 给出的指纹（第 17.2 节）。
#[tauri::command(async)]
pub(crate) fn workspace_trust(
    workspaces: State<'_, Workspaces>,
    path: String,
    trusted: bool,
    fingerprint: Option<String>,
) -> Result<(), String> {
    workspaces
        .trust(&path, trusted, fingerprint.as_deref())
        .map_err(|e| e.to_string())
}

/// 对话框返回的路径转成本地路径字符串；不是本地路径时报错（不静默丢弃）。
fn local_path(p: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    p.into_path()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("所选项目不是本地路径：{e}"))
}

/// 系统文件夹对话框（tauri-plugin-dialog），以主窗口为父窗口；取消时返回 None。
/// 异步命令在线程池中执行，阻塞等待对话框不会卡住主线程。
/// 插件把打开失败与取消都报告为“无结果”，无法区分；所选路径不可用时返回错误。
#[tauri::command(async)]
pub(crate) fn dialog_pick_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder()
        .map(local_path)
        .transpose()
}

/// 系统文件对话框（可多选）；只返回本地路径，文件不复制。取消时返回空列表，
/// 所选路径不可用时返回错误。
#[tauri::command(async)]
pub(crate) fn dialog_pick_files(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(local_path)
        .collect()
}

/// `session_open` 的返回值。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionHandle {
    session_key: String,
    /// 新会话的会话 ID（与会话索引中的 `id` 对应，前端据此把列表项与打开中的标签对上）；恢复已有会话时为 None
    session_id: Option<String>,
}

/// 打开会话：拉起 Core，事件批次经 `on_event` 推送（第 7.1、7.3 节）。工作区为空时在默认目录对话。
#[tauri::command(async)]
pub(crate) fn session_open(
    sessions: State<'_, AppSessions>,
    supervisor: State<'_, Supervisor>,
    paths: State<'_, DataPaths>,
    workspaces: State<'_, Workspaces>,
    workspace: String,
    session_path: Option<String>,
    on_event: Channel<CoreBatch>,
) -> Result<SessionHandle, String> {
    // 信任状态由薄壳按 workspaces.json 判定，不取前端传入的值（第 17.2 节）；默认工作区不加载项目资源
    let approve = !workspace.trim().is_empty() && workspaces.approved(&workspace);
    sessions
        .open_with_trust(
            &supervisor,
            &paths,
            &workspace,
            session_path.as_deref(),
            approve,
            on_event,
        )
        .map(|session_key| SessionHandle {
            session_id: sessions.session_id(&session_key),
            session_key,
        })
        .map_err(|e| e.to_string())
}

/// 关闭会话并结束其 Core。
#[tauri::command(async)]
pub(crate) fn session_close(
    sessions: State<'_, AppSessions>,
    supervisor: State<'_, Supervisor>,
    session_key: String,
) -> Result<(), String> {
    sessions.close(&supervisor, &session_key);
    Ok(())
}

/// 会话命令的错误：`code` 供前端区分需要特别处理的情况（`coreNotRunning`：内核未运行，需重启内核），
/// 其余为 `null`；`message` 是界面文案。
#[derive(Debug, serde::Serialize)]
pub(crate) struct CoreCommandError {
    code: Option<&'static str>,
    message: String,
}

impl CoreCommandError {
    fn new(code: Option<&'static str>, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<SessionError> for CoreCommandError {
    fn from(e: SessionError) -> Self {
        let code = match e {
            SessionError::NotRunning(_) | SessionError::Bridge(BridgeError::Closed) => {
                Some("coreNotRunning")
            }
            _ => None,
        };
        Self {
            code,
            message: e.to_string(),
        }
    }
}

/// 把一条 RPC 记录原样写入 Core 的 stdin；响应经批次返回。
#[tauri::command]
pub(crate) fn core_send(
    sessions: State<'_, AppSessions>,
    supervisor: State<'_, Supervisor>,
    session_key: String,
    record: serde_json::Value,
) -> Result<(), CoreCommandError> {
    sessions
        .send(&supervisor, &session_key, &record)
        .map_err(Into::into)
}

/// 重启会话的 Core（同一会话文件恢复）；前端随后用 `get_messages` + `get_state` 重建状态。
#[tauri::command(async)]
pub(crate) fn core_restart(
    sessions: State<'_, AppSessions>,
    supervisor: State<'_, Supervisor>,
    workspaces: State<'_, Workspaces>,
    session_key: String,
) -> Result<(), CoreCommandError> {
    // 重启前重新判定信任：`.primus/` 变化或信任被撤销后不再以 --approve 启动（第 17.2 节）
    sessions
        .restart_checked(&supervisor, &session_key, |cwd| {
            workspaces.approved(&cwd.to_string_lossy())
        })
        .map_err(Into::into)
}

/// 会话列表与搜索的工作区过滤（ADR 0006）：None 为全部工作区；空串为未选工作区的默认目录；其余按路径键比较。
fn workspace_key(paths: &DataPaths, workspace: Option<&str>) -> Option<String> {
    let workspace = workspace?;
    Some(if workspace.trim().is_empty() {
        crate::platform::path_key(&crate::sessions::default_workspace_dir(paths).to_string_lossy())
    } else {
        crate::platform::path_key(workspace)
    })
}

/// 未选工作区时会话使用的默认工作目录（`users/<SID>/chat` 的完整路径），左栏据此区分“项目”与“最近”。
#[tauri::command]
pub(crate) fn session_default_workspace(paths: State<'_, DataPaths>) -> String {
    crate::sessions::default_workspace_dir(&paths)
        .to_string_lossy()
        .into_owned()
}

/// 会话列表（第 10.2 节）：最后活动时间倒序、每页 50 条、不含已归档；`cursor` 为上一页的 `nextCursor`。
#[tauri::command(async)]
pub(crate) fn session_list(
    index: State<'_, Arc<SessionIndex>>,
    paths: State<'_, DataPaths>,
    workspace: Option<String>,
    cursor: Option<String>,
) -> Result<SessionPage, String> {
    index
        .list(
            workspace_key(&paths, workspace.as_deref()).as_deref(),
            cursor.as_deref(),
        )
        .map_err(|e| e.to_string())
}

/// 搜索会话（含已归档，最多 50 条）：3 个字符以上匹配消息全文，更短只匹配会话名与首条消息。
#[tauri::command(async)]
pub(crate) fn session_search(
    index: State<'_, Arc<SessionIndex>>,
    paths: State<'_, DataPaths>,
    workspace: Option<String>,
    query: String,
) -> Result<Vec<SessionSummary>, String> {
    index
        .search(
            workspace_key(&paths, workspace.as_deref()).as_deref(),
            &query,
        )
        .map_err(|e| e.to_string())
}

/// 订阅会话索引的变化：每次变化经 `on_event` 推送 `{ seq }`，前端据此重新拉取列表。再次调用替换旧的订阅。
#[tauri::command]
pub(crate) fn session_watch(
    notifier: State<'_, Arc<IndexNotifier>>,
    on_event: Channel<IndexChanged>,
) {
    notifier.set_listener(move |e| {
        let _ = on_event.send(e);
    });
    // 注册前发生的索引变化没有推给前端（前端注册与首次拉取并发）：注册后补发一次，让前端重新拉取
    notifier.notify();
}

/// 归档或取消归档（只改索引，会话文件不动）。
#[tauri::command(async)]
pub(crate) fn session_archive(
    index: State<'_, Arc<SessionIndex>>,
    notifier: State<'_, Arc<IndexNotifier>>,
    session_path: String,
    archived: bool,
) -> Result<(), String> {
    match index.set_archived(&session_path, archived) {
        Ok(true) => {
            notifier.notify();
            Ok(())
        }
        Ok(false) => Err(format!("会话不在索引中：{session_path}")),
        Err(e) => Err(e.to_string()),
    }
}

/// 删除会话：永久删除会话文件（不进回收站，不可恢复）并删除索引。会话打开中也可以删除：先结束它的 Core。
#[tauri::command(async)]
pub(crate) fn session_delete(
    sessions: State<'_, AppSessions>,
    supervisor: State<'_, Supervisor>,
    index: State<'_, Arc<SessionIndex>>,
    notifier: State<'_, Arc<IndexNotifier>>,
    session_path: String,
) -> Result<(), CoreCommandError> {
    delete_session(
        &sessions,
        &index,
        &notifier,
        &session_path,
        |key| {
            supervisor.stop(key);
        },
        remove_file_retrying,
    )?;
    notifier.notify();
    Ok(())
}

/// 永久删除文件。刚结束的 Core 进程可能还没完全释放文件句柄（Windows 上删除会得到共享冲突），短暂重试几次。
fn remove_file_retrying(path: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            // 5 = ERROR_ACCESS_DENIED（删除挂起等），32 = ERROR_SHARING_VIOLATION（句柄未带 FILE_SHARE_DELETE）
            Err(e)
                if attempt < 10
                    && (e.kind() == io::ErrorKind::PermissionDenied
                        || (cfg!(windows) && e.raw_os_error() == Some(32))) =>
            {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e),
        }
    }
}

/// 删除会话的步骤（`stop`、`remove` 可替换，便于测试）：只接受会话目录下的 `.jsonl` 普通文件，
/// 拒绝相对路径、`..`、符号链接与目录外的文件。使用这个文件的打开中会话先关闭（`stop` 结束其 Core），
/// 关闭与删除之间登记“删除中”（`Sessions::delete_closing`），期间打开同一文件被拒绝。
fn delete_session<S: BatchSink + Clone>(
    sessions: &Sessions<S>,
    index: &SessionIndex,
    notifier: &IndexNotifier,
    session_path: &str,
    stop: impl FnMut(&str),
    remove: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), CoreCommandError> {
    let invalid = || CoreCommandError::new(None, format!("不是会话文件：{session_path}"));
    let path = Path::new(session_path);
    if !path.is_absolute()
        || !path.extension().is_some_and(|e| e == "jsonl")
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(invalid());
    }
    let meta =
        std::fs::symlink_metadata(path).map_err(|e| CoreCommandError::new(None, e.to_string()))?;
    if !meta.file_type().is_file() {
        return Err(invalid());
    }
    let inside = match (
        path.parent().map(std::fs::canonicalize),
        std::fs::canonicalize(index.sessions_dir()),
    ) {
        (Some(Ok(parent)), Ok(root)) => parent.starts_with(&root),
        _ => false,
    };
    if !inside {
        return Err(invalid());
    }
    // 会话 ID 先取索引中的，不在索引中（尚未扫描到）时读文件头：打开中的新会话只按会话 ID 登记
    let id = index
        .session_id(session_path)
        .map_err(|e| CoreCommandError::new(None, e.to_string()))?
        .or_else(|| crate::session_index::session_file_id(path));
    sessions
        .delete_closing(path, id.as_deref(), stop, || remove(path))
        .map_err(|e| CoreCommandError::new(None, e.to_string()))?
        .map_err(|e| CoreCommandError::new(None, e.to_string()))?;
    index
        .remove(session_path)
        .map_err(|e| CoreCommandError::new(None, e.to_string()))?;
    // 删除文件与删除索引之间，同一路径可能已出现新的会话文件并被监听器写入索引（刚被上面一并删掉）：
    // 按路径的当前文件状态重新同步，文件不在则保持删除，有新文件则重新入索引。文件已移走，同步失败不算删除失败；
    // 失败时请监听线程做一次全量扫描（失败按退避重试），保证新文件最终回到索引
    if let Err(e) = index.update_file(path) {
        eprintln!("会话删除后重新同步索引失败（{session_path}），改为全量扫描：{e}");
        if !notifier.request_rescan() {
            eprintln!("会话目录监听未建立，无法安排全量扫描");
        }
    }
    Ok(())
}

/// 账号状态（第 9.7 节）。账号服务接入前恒为未登录、不可登录。
#[tauri::command]
pub(crate) fn auth_status() -> AuthStatus {
    crate::account::status()
}

/// 系统浏览器登录（PKCE）。账号服务接入前返回 `notAvailable`。
#[tauri::command]
pub(crate) fn auth_login() -> Result<AuthStatus, AuthError> {
    crate::account::login()
}

/// 登出。账号服务接入前返回 `notAvailable`。
#[tauri::command]
pub(crate) fn auth_logout() -> Result<(), AuthError> {
    crate::account::logout()
}

/// 可用模型列表、默认值与配置状态（第 9.2、9.5 节）。
#[tauri::command]
pub(crate) fn models_get(models: State<'_, ModelConfigState>) -> ModelsInfo {
    models.info()
}

/// 重新读取 `providers.json` 并重写 Core 的 `models.json` 与默认模型（不联网获取模型列表）。
#[tauri::command(async)]
pub(crate) fn models_refresh(models: State<'_, ModelConfigState>) -> ModelsInfo {
    models.refresh()
}

/// 订阅模型配置变化：每次渠道保存 / 删除、刷新、改默认模型或启动时后台获取到内置渠道的模型后推送完整的 `ModelsInfo`。
/// 再次调用替换旧的订阅。
#[tauri::command]
pub(crate) fn models_watch(models: State<'_, ModelConfigState>, on_event: Channel<ModelsInfo>) {
    models.set_listener(move |info| {
        let _ = on_event.send(info);
    });
}

/// 全部模型渠道（含 `hasKey` 与密钥末 4 位 `keyHint`，不含密钥）。
#[tauri::command(async)]
pub(crate) fn providers_list(
    models: State<'_, ModelConfigState>,
) -> Result<Vec<ProviderView>, String> {
    models.providers_list()
}

/// 新建（`input.id` 缺省）或修改渠道；`input.apiKey` 缺省为保留已存的密钥。保存后重写 Core 配置。
#[tauri::command(async)]
pub(crate) fn provider_save(
    models: State<'_, ModelConfigState>,
    input: ProviderInput,
) -> Result<ProvidersChanged, String> {
    models.provider_save(input)
}

/// 删除渠道及其密钥，重写 Core 配置。
#[tauri::command(async)]
pub(crate) fn provider_delete(
    models: State<'_, ModelConfigState>,
    id: String,
) -> Result<ProvidersChanged, String> {
    models.provider_delete(&id)
}

/// 从渠道的模型列表接口获取模型（不保存）：已保存的渠道给 `id`（可带未保存的修改），草稿给 `api` + `baseUrl` + `apiKey`。
/// 已保存的模型保留用户改过的参数，新模型用默认参数。
#[tauri::command]
pub(crate) async fn provider_fetch_models(
    models: State<'_, ModelConfigState>,
    input: FetchInput,
) -> Result<Vec<ProviderModel>, String> {
    let target = models.fetch_target(input)?;
    let fetched = crate::providers::fetch_models(target.api, &target.base_url, &target.key).await?;
    Ok(crate::providers::merge_models(&target.saved, &fetched))
}

/// 设置页改选默认模型（`provider/modelId`，只能选列表中的模型；新拉起的 Core 进程生效）。
#[tauri::command]
pub(crate) fn models_set_default(
    models: State<'_, ModelConfigState>,
    model: String,
) -> Result<ModelsInfo, String> {
    models.set_default(&model)
}

/// 自动更新状态：当前版本、是否可用、设置、进行中的阶段与已下载待装的版本（第 3.6 节、ADR 0007）。
#[tauri::command]
pub(crate) fn update_status(updater: State<'_, Arc<Updater>>) -> UpdateStatus {
    updater.status()
}

/// 订阅更新状态：注册后立即推送一次，之后每次变化（检查、下载进度、下载完成、设置修改）推送完整状态。
/// 再次调用替换旧的订阅。
#[tauri::command]
pub(crate) fn update_watch(updater: State<'_, Arc<Updater>>, on_event: Channel<UpdateStatus>) {
    updater.set_listener(move |status| {
        let _ = on_event.send(status);
    });
}

/// 立即检查更新（设置页“立即检查”）；有更高版本时下载、验签并存为待装包，返回检查后的状态。
/// `channel` 只用于本次检查（不保存），缺省用设置中的通道。
#[tauri::command]
pub(crate) async fn update_check(
    app: tauri::AppHandle,
    updater: State<'_, Arc<Updater>>,
    channel: Option<UpdateChannel>,
) -> Result<UpdateStatus, UpdateError> {
    let updater = updater.inner().clone();
    updater.check_and_download(&app, channel, true).await
}

/// 修改更新设置（自动更新开关、通道），保存到 `users/<SID>/app/update.json`；自动更新从关到开时立即在后台检查一次。
#[tauri::command]
pub(crate) fn update_settings_set(
    app: tauri::AppHandle,
    updater: State<'_, Arc<Updater>>,
    auto_update: Option<bool>,
    channel: Option<UpdateChannel>,
) -> Result<UpdateStatus, UpdateError> {
    if updater.set_settings(auto_update, channel)? && updater.available() {
        let updater = updater.inner().clone();
        tauri::async_runtime::spawn(async move {
            let _ = updater.check_and_download(&app, None, false).await;
        });
    }
    Ok(updater.status())
}

/// 立即重启并安装已下载的更新。有正在运行的 Agent 时返回 `busy`，前端确认后带 `force` 再调。
/// 忙碌检查与“安装中”标记在会话表的同一次加锁内完成，之后新的 prompt 与会话拉起被拒绝，直到安装取消或失败。
/// 安装包校验通过后交给更新服务（静默安装、装完重新打开），服务不可用时经 UAC 拉起安装器；服务接手或安装器已运行
/// 才结束全部 Core 并退出。用户取消 UAC 返回 `cancelled`、失败返回 `failed` / `invalid`：这些情况下 Core 都没有被停掉，
/// 会话照常可用，待装包（未被判为无效时）保留，下次启动或退出时再装。
#[tauri::command(async)]
pub(crate) fn update_install(
    app: tauri::AppHandle,
    updater: State<'_, Arc<Updater>>,
    sessions: State<'_, AppSessions>,
    supervisor: State<'_, Supervisor>,
    force: Option<bool>,
) -> Result<(), UpdateError> {
    let hold = sessions
        .hold_for_update(force.unwrap_or(false))
        .ok_or_else(|| UpdateError::new("busy", "有正在运行的 Agent，更新会停止它们"))?;
    let package = updater.prepare_install()?;
    updater.set_installing(true);
    match crate::updater::launch(&updater, package, InstallTrigger::RestartNow) {
        Ok(LaunchOutcome::Started) => {
            // 安装器会替换 resources 下的 node.exe 与 Core 文件：结束全部 Core（含工具子进程）后退出
            supervisor.shutdown();
            app.exit(0);
            std::mem::forget(hold);
            Ok(())
        }
        Ok(LaunchOutcome::Cancelled | LaunchOutcome::Deferred) => {
            drop(hold);
            updater.set_installing(false);
            Err(UpdateError::new(
                "cancelled",
                "已取消管理员授权。更新包已保留，下次启动 Primus 时会再次安装",
            ))
        }
        Err(e) => {
            drop(hold);
            updater.set_installing(false);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::check_external_url;

    #[test]
    fn attachment_image_rejects_remote_and_relative_paths() {
        for bad in [
            r"\\server\share\a.png",
            "//server/share/a.png",
            r"\\?\C:\a.png",
            "file:///C:/a.png",
            "a.png",
            "C:\\a\u{7}.png",
        ] {
            assert!(super::attachment_image(bad.into(), 512).is_err(), "{bad}");
        }
    }

    #[test]
    fn external_url_only_http_https() {
        assert!(check_external_url("https://example.com/a?b=1").is_ok());
        assert!(check_external_url("HTTP://example.com").is_ok());
        assert!(check_external_url("ms-settings:privacy-microphone").is_ok());
        assert!(check_external_url("ms-settings:privacy-speech").is_ok());
        for bad in [
            "file:///C:/Windows/System32/cmd.exe",
            "C:\\Windows\\notepad.exe",
            "javascript:alert(1)",
            "https://",
            "https:///etc/passwd",
            "https://example.com/a b",
            "https://example.com/\n",
            "ms-settings:",
            "ms-settings:privacy-webcam",
            "ms-settings:privacy-microphone ",
            "MS-SETTINGS:privacy-microphone",
        ] {
            assert!(check_external_url(bad).is_err(), "{bad}");
        }
    }

    use super::*;

    mod delete {
        use super::*;
        use crate::rpc_bridge::BridgeConfig;
        use crate::supervisor::tests::TempDir;
        use std::cell::Cell;

        #[derive(Clone)]
        struct NoSink;
        impl BatchSink for NoSink {
            fn send(&self, _batch: CoreBatch) -> bool {
                true
            }
        }

        fn setup() -> (TempDir, std::path::PathBuf, SessionIndex, Sessions<NoSink>) {
            let tmp = TempDir::new();
            let dir = tmp.0.join("sessions");
            std::fs::create_dir(&dir).unwrap();
            let index = SessionIndex::open_in_memory(&dir).unwrap();
            (tmp, dir, index, Sessions::new(BridgeConfig::default()))
        }

        fn no_stop(_key: &str) {}

        fn write_session(dir: &Path, name: &str) -> String {
            let p = dir.join(name);
            std::fs::write(
                &p,
                "{\"type\":\"session\",\"id\":\"x\",\"timestamp\":\"2026-11-03T00:00:00.000Z\",\"cwd\":\"/w\"}\n",
            )
            .unwrap();
            p.to_str().unwrap().to_owned()
        }

        #[test]
        fn removes_file_and_index_entry() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            std::fs::write(
                &path,
                format!(
                    "{}{}\n",
                    std::fs::read_to_string(&path).unwrap(),
                    "{\"type\":\"message\",\"id\":\"m\",\"parentId\":null,\"timestamp\":\"2026-11-03T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"hi\",\"timestamp\":1}}"
                ),
            )
            .unwrap();
            index.sync_all().unwrap();
            let removed = Cell::new(false);
            delete_session(
                &sessions,
                &index,
                &IndexNotifier::default(),
                &path,
                no_stop,
                |p| {
                    removed.set(true);
                    std::fs::remove_file(p)
                },
            )
            .unwrap();
            assert!(removed.get());
            assert!(!Path::new(&path).exists());
            assert!(index.list(None, None).unwrap().items.is_empty());
        }

        #[test]
        fn file_recreated_at_same_path_is_reindexed_after_delete() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            index.sync_all().unwrap();
            index.set_archived(&path, true).unwrap();
            delete_session(&sessions, &index, &IndexNotifier::default(), &path, no_stop, |p| {
                std::fs::remove_file(p)?;
                // 删除后、删除索引前，同一路径出现新的会话文件，监听器已把它写入索引
                std::fs::write(
                    p,
                    "{\"type\":\"session\",\"id\":\"y\",\"timestamp\":\"2026-11-03T00:00:00.000Z\",\"cwd\":\"/w\"}\n",
                )?;
                index.update_file(p).map(|_| ()).map_err(io::Error::other)
            })
            .unwrap();
            let items = index.list(None, None).unwrap().items;
            assert_eq!(items.len(), 1, "同一路径的新会话文件应留在索引中");
            assert_eq!(items[0].id, "y");
            assert!(!items[0].archived, "新文件不继承旧文件的归档标记");
        }

        #[test]
        fn failed_resync_after_delete_requests_full_scan() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            index.sync_all().unwrap();
            let notifier = IndexNotifier::default();
            let (tx, rx) = std::sync::mpsc::channel();
            notifier.set_rescanner(tx);
            // 删除后的重新同步写不进索引（同一路径的新文件 `y`）
            index.execute_batch_for_test(
                "CREATE TEMP TRIGGER fail_y BEFORE INSERT ON sessions WHEN NEW.id = 'y'
                 BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            );
            delete_session(&sessions, &index, &notifier, &path, no_stop, |p| {
                std::fs::remove_file(p)?;
                std::fs::write(
                    p,
                    "{\"type\":\"session\",\"id\":\"y\",\"timestamp\":\"2026-11-03T00:00:00.000Z\",\"cwd\":\"/w\"}\n",
                )
            })
            .unwrap();
            assert!(index.list(None, None).unwrap().items.is_empty());
            // 请求了一次全量扫描（由监听线程执行并按退避重试）
            let event = rx.try_recv().expect("应请求全量扫描").unwrap();
            assert!(event.need_rescan());
            index.execute_batch_for_test("DROP TRIGGER fail_y;");
            index.sync_all().unwrap();
            assert_eq!(index.list(None, None).unwrap().items[0].id, "y");
            // 重新同步成功时不请求
            let path_b = write_session(&dir, "b.jsonl");
            delete_session(&sessions, &index, &notifier, &path_b, no_stop, |p| {
                std::fs::remove_file(p)
            })
            .unwrap();
            assert!(rx.try_recv().is_err());
        }

        #[test]
        fn rejects_paths_outside_sessions_dir() {
            let (tmp, dir, index, sessions) = setup();
            let outside = write_session(&tmp.0, "outside.jsonl");
            let escaped = format!("{}/../outside.jsonl", dir.display());
            let txt = dir.join("a.txt");
            std::fs::write(&txt, "x").unwrap();
            let never = |_: &Path| -> io::Result<()> { panic!("不应删除文件") };
            for bad in [
                outside.as_str(),
                escaped.as_str(),
                "relative.jsonl",
                txt.to_str().unwrap(),
                dir.to_str().unwrap(),
            ] {
                assert!(
                    delete_session(
                        &sessions,
                        &index,
                        &IndexNotifier::default(),
                        bad,
                        no_stop,
                        never
                    )
                    .is_err(),
                    "{bad}"
                );
            }
            assert!(Path::new(&outside).exists());
        }

        #[cfg(unix)]
        #[test]
        fn rejects_symlinks() {
            let (tmp, dir, index, sessions) = setup();
            let target = write_session(&tmp.0, "target.jsonl");
            let link = dir.join("link.jsonl");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let never = |_: &Path| -> io::Result<()> { panic!("不应删除文件") };
            assert!(
                delete_session(
                    &sessions,
                    &index,
                    &IndexNotifier::default(),
                    link.to_str().unwrap(),
                    no_stop,
                    never
                )
                .is_err()
            );
        }

        #[test]
        fn open_session_is_closed_then_deleted() {
            // 恢复的会话按文件登记、新会话只按会话 ID（文件头的 `x`）登记：两种都先结束 Core 再删除
            for (file, id) in [(true, None), (false, Some("x"))] {
                let (_tmp, dir, index, sessions) = setup();
                // Core 为新会话建的文件名为 `<时间戳>_<会话 ID>.jsonl`
                let path = write_session(&dir, "2026-11-03T00-00-00-000Z_x.jsonl");
                index.sync_all().unwrap();
                sessions.insert_idle_for_test("s1", file.then_some(path.as_str()), id, NoSink);
                sessions.insert_idle_for_test("other", None, Some("unrelated"), NoSink);
                let stopped = std::cell::RefCell::new(Vec::new());
                delete_session(
                    &sessions,
                    &index,
                    &IndexNotifier::default(),
                    &path,
                    |k| stopped.borrow_mut().push(k.to_owned()),
                    |p| {
                        // 删除文件时会话已移出会话表
                        assert!(!sessions.is_using(p, Some("x")));
                        std::fs::remove_file(p)
                    },
                )
                .unwrap();
                assert_eq!(*stopped.borrow(), vec!["s1".to_owned()]);
                assert!(!Path::new(&path).exists());
                assert!(index.list(None, None).unwrap().items.is_empty());
                // 无关的会话不受影响
                assert!(sessions.session_id("other").is_some());
            }
        }

        #[test]
        fn deleting_a_copy_keeps_the_new_session_open() {
            // 副本保留原文件头的会话 ID `x`，但不是 Core 为新会话 `x` 建的文件：删除副本不关闭那个新会话
            let (_tmp, dir, index, sessions) = setup();
            let copy = write_session(&dir, "copy.jsonl");
            index.sync_all().unwrap();
            sessions.insert_idle_for_test("s1", None, Some("x"), NoSink);
            let stopped = std::cell::RefCell::new(Vec::new());
            delete_session(
                &sessions,
                &index,
                &IndexNotifier::default(),
                &copy,
                |k| stopped.borrow_mut().push(k.to_owned()),
                |p| std::fs::remove_file(p),
            )
            .unwrap();
            assert!(stopped.borrow().is_empty());
            assert!(!Path::new(&copy).exists());
            assert!(sessions.session_id("s1").is_some());
        }

        #[test]
        fn remove_failure_keeps_index_entry() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            std::fs::write(&path, format!("{}{}\n", std::fs::read_to_string(&path).unwrap(),
                "{\"type\":\"message\",\"id\":\"m\",\"parentId\":null,\"timestamp\":\"2026-11-03T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"hi\",\"timestamp\":1}}")).unwrap();
            index.sync_all().unwrap();
            let err = delete_session(
                &sessions,
                &index,
                &IndexNotifier::default(),
                &path,
                no_stop,
                |_| Err(io::Error::other("busy")),
            )
            .unwrap_err();
            assert_eq!(err.code, None);
            assert_eq!(index.list(None, None).unwrap().items.len(), 1);
        }
    }

    #[test]
    fn core_not_running_code_covers_closed_bridge() {
        for e in [
            SessionError::NotRunning("k".to_owned()),
            SessionError::Bridge(BridgeError::Closed),
        ] {
            assert_eq!(CoreCommandError::from(e).code, Some("coreNotRunning"));
        }
        assert_eq!(
            CoreCommandError::from(SessionError::NotFound("k".to_owned())).code,
            None
        );
    }
}

/// 工作区所在 Git 仓库的当前分支（只读，直接读 `.git/HEAD`）；不是仓库时返回 `null`。
#[tauri::command(async)]
pub(crate) fn git_branch(workspace: String) -> Option<crate::git::GitBranch> {
    let path = Path::new(&workspace);
    if workspace.is_empty() || !path.is_absolute() {
        return None;
    }
    crate::git::branch(path)
}

/// 输入框图片附件与右栏图片预览：读取本地图片，在内存中按最长边 `max_edge` 缩小并编码为 base64，附带缩略图（不写任何文件）。
/// 预览的路径来自助手回复（不可信）：读取前做与 `open_path` 相同的本机路径校验，拒绝网址、UNC / 设备路径
/// （读取 UNC 路径的元数据就会向对方服务器发起 SMB 认证）与控制字符。
#[tauri::command(async)]
pub(crate) fn attachment_image(
    path: String,
    max_edge: u32,
) -> Result<crate::attachments::AttachmentImage, String> {
    let checked = crate::open_path::check_path(&path)?;
    crate::attachments::read_image(&checked.path, max_edge)
}

/// 语音输入是否可用（Windows 有系统语音语言时为 true）。
#[tauri::command]
pub(crate) fn speech_available(speech: State<'_, crate::platform::speech::Speech>) -> bool {
    speech.available()
}

/// 开始语音听写：识别事件（interim / final / error / end）经 Channel 推送；已有会话时先停止旧的。
/// 启动失败也走事件（`error` 带可解决它的系统设置页，随后 `end`），命令本身只在 IPC 层失败。
#[tauri::command(async)]
pub(crate) fn speech_start(
    speech: State<'_, crate::platform::speech::Speech>,
    on_event: Channel<crate::platform::speech::SpeechEvent>,
) -> Result<(), String> {
    let sink: crate::platform::speech::SpeechSink = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    if let Err(failure) = speech.start(sink.clone()) {
        sink(failure.into());
        sink(crate::platform::speech::SpeechEvent::End);
    }
    Ok(())
}

/// 停止语音听写（之后推送 `end`）。
#[tauri::command]
pub(crate) fn speech_stop(speech: State<'_, crate::platform::speech::Speech>) {
    speech.stop();
}
