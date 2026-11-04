//! Tauri 命令入口（附录 B），只做参数校验与转发。

use std::io;
use std::path::{Component, Path};
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::account::{AuthError, AuthStatus};
use crate::core_config::{ModelConfigState, ModelsInfo};
use crate::fs_watch::{IndexChanged, IndexNotifier};
use crate::paths::DataPaths;
use crate::rpc_bridge::{BatchSink, BridgeError, CoreBatch};
use crate::session_index::{SessionIndex, SessionPage, SessionSummary};
use crate::sessions::{AppSessions, SessionError, Sessions};
use crate::supervisor::Supervisor;
use crate::workspaces::{WorkspaceInfo, Workspaces};

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
pub(crate) fn workspace_list(workspaces: State<'_, Workspaces>) -> Vec<WorkspaceInfo> {
    workspaces.list()
}

/// 设置工作区信任状态。
#[tauri::command(async)]
pub(crate) fn workspace_trust(
    workspaces: State<'_, Workspaces>,
    path: String,
    trusted: bool,
) -> Result<(), String> {
    workspaces.trust(&path, trusted).map_err(|e| e.to_string())
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
    workspace: String,
    session_path: Option<String>,
    on_event: Channel<CoreBatch>,
) -> Result<SessionHandle, String> {
    sessions
        .open(
            &supervisor,
            &paths,
            &workspace,
            session_path.as_deref(),
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
    session_key: String,
) -> Result<(), CoreCommandError> {
    sessions
        .restart(&supervisor, &session_key)
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

/// 删除会话：移到回收站并删除索引。打开中的会话拒绝删除（`code` 为 `sessionOpen`）。
#[tauri::command(async)]
pub(crate) fn session_delete(
    sessions: State<'_, AppSessions>,
    index: State<'_, Arc<SessionIndex>>,
    notifier: State<'_, Arc<IndexNotifier>>,
    session_path: String,
) -> Result<(), CoreCommandError> {
    delete_session(
        &sessions,
        &index,
        &notifier,
        &session_path,
        crate::platform::move_to_trash,
    )?;
    notifier.notify();
    Ok(())
}

/// 删除会话的步骤（`trash` 可替换，便于测试）：只接受会话目录下的 `.jsonl` 普通文件，
/// 拒绝相对路径、`..`、符号链接与目录外的文件；会话打开中时拒绝。占用检查与移到回收站之间登记“删除中”
/// （`Sessions::delete_unless_using`），期间打开同一文件被拒绝。
fn delete_session<S: BatchSink + Clone>(
    sessions: &Sessions<S>,
    index: &SessionIndex,
    notifier: &IndexNotifier,
    session_path: &str,
    trash: impl FnOnce(&Path) -> io::Result<()>,
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
        .delete_unless_using(path, id.as_deref(), || trash(path))
        .ok_or_else(|| {
            CoreCommandError::new(Some("sessionOpen"), "会话正在打开中，请先关闭再删除")
        })?
        .map_err(|e| CoreCommandError::new(None, e.to_string()))?;
    index
        .remove(session_path)
        .map_err(|e| CoreCommandError::new(None, e.to_string()))?;
    // 移到回收站与删除索引之间，同一路径可能已出现新的会话文件并被监听器写入索引（刚被上面一并删掉）：
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

/// 账号状态（第 9.7 节）。内置账号阶段恒为已登录。
#[tauri::command]
pub(crate) fn auth_status() -> AuthStatus {
    crate::account::status()
}

/// 系统浏览器登录（PKCE）。内置账号阶段返回 `notAvailable`。
#[tauri::command]
pub(crate) fn auth_login() -> Result<AuthStatus, AuthError> {
    crate::account::login()
}

/// 登出。内置账号阶段返回 `notAvailable`。
#[tauri::command]
pub(crate) fn auth_logout() -> Result<(), AuthError> {
    crate::account::logout()
}

/// 可用模型列表、默认值与配置状态（第 9.2、9.5 节）。
#[tauri::command]
pub(crate) fn models_get(models: State<'_, ModelConfigState>) -> ModelsInfo {
    models.info()
}

/// 重新获取并写入模型配置；内置阶段为按内置配置重写 `models.json` 与保险库中的令牌。
#[tauri::command(async)]
pub(crate) fn models_refresh(models: State<'_, ModelConfigState>) -> ModelsInfo {
    models.refresh()
}

/// 设置页改选默认模型（`provider/modelId`，只能选列表中的模型；新拉起的 Core 进程生效）。
#[tauri::command]
pub(crate) fn models_set_default(
    models: State<'_, ModelConfigState>,
    model: String,
) -> Result<ModelsInfo, String> {
    models.set_default(&model)
}

#[cfg(test)]
mod tests {
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
        fn trashes_file_and_removes_index_entry() {
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
            let trashed = Cell::new(false);
            delete_session(&sessions, &index, &IndexNotifier::default(), &path, |p| {
                trashed.set(true);
                std::fs::remove_file(p)
            })
            .unwrap();
            assert!(trashed.get());
            assert!(index.list(None, None).unwrap().items.is_empty());
        }

        #[test]
        fn file_recreated_at_same_path_is_reindexed_after_delete() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            index.sync_all().unwrap();
            index.set_archived(&path, true).unwrap();
            delete_session(&sessions, &index, &IndexNotifier::default(), &path, |p| {
                std::fs::remove_file(p)?;
                // 移走后、删除索引前，同一路径出现新的会话文件，监听器已把它写入索引
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
            delete_session(&sessions, &index, &notifier, &path, |p| {
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
            delete_session(&sessions, &index, &notifier, &path_b, |p| {
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
            let never = |_: &Path| -> io::Result<()> { panic!("不应移到回收站") };
            for bad in [
                outside.as_str(),
                escaped.as_str(),
                "relative.jsonl",
                txt.to_str().unwrap(),
                dir.to_str().unwrap(),
            ] {
                assert!(
                    delete_session(&sessions, &index, &IndexNotifier::default(), bad, never)
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
            let never = |_: &Path| -> io::Result<()> { panic!("不应移到回收站") };
            assert!(
                delete_session(
                    &sessions,
                    &index,
                    &IndexNotifier::default(),
                    link.to_str().unwrap(),
                    never
                )
                .is_err()
            );
        }

        #[test]
        fn open_session_is_not_deleted() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            index.sync_all().unwrap();
            let never = |_: &Path| -> io::Result<()> { panic!("不应移到回收站") };
            // 恢复的会话按文件登记
            sessions.insert_idle_for_test("s1", Some(&path), None, NoSink);
            let err = delete_session(&sessions, &index, &IndexNotifier::default(), &path, never)
                .unwrap_err();
            assert_eq!(err.code, Some("sessionOpen"));
            // 新会话只按会话 ID（文件头的 `x`）登记
            sessions.close_for_test("s1");
            sessions.insert_idle_for_test("s2", None, Some("x"), NoSink);
            let err = delete_session(&sessions, &index, &IndexNotifier::default(), &path, never)
                .unwrap_err();
            assert_eq!(err.code, Some("sessionOpen"));
            assert!(Path::new(&path).exists());
            assert_eq!(index.list(None, None).unwrap().items.len(), 1);
        }

        #[test]
        fn trash_failure_keeps_index_entry() {
            let (_tmp, dir, index, sessions) = setup();
            let path = write_session(&dir, "a.jsonl");
            std::fs::write(&path, format!("{}{}\n", std::fs::read_to_string(&path).unwrap(),
                "{\"type\":\"message\",\"id\":\"m\",\"parentId\":null,\"timestamp\":\"2026-11-03T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"hi\",\"timestamp\":1}}")).unwrap();
            index.sync_all().unwrap();
            let err = delete_session(&sessions, &index, &IndexNotifier::default(), &path, |_| {
                Err(io::Error::other("busy"))
            })
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
