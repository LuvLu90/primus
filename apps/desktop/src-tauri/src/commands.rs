//! Tauri 命令入口（附录 B），只做参数校验与转发。

use tauri::State;
use tauri::ipc::Channel;

use crate::account::{AuthError, AuthStatus};
use crate::core_config::{ModelConfigState, ModelsInfo};
use crate::paths::DataPaths;
use crate::rpc_bridge::{BridgeError, CoreBatch};
use crate::sessions::{AppSessions, SessionError};
use crate::supervisor::Supervisor;

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

/// `session_open` 的返回值。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionHandle {
    session_key: String,
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
        .map(|session_key| SessionHandle { session_key })
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
