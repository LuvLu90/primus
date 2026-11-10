//! 托盘：运行中会话数、打开窗口、退出（第 5.5 节、第 16 章“托盘”）。
//!
//! - 图标用应用图标的 32×32 版（`icons/32x32.png`，由 `scripts/render-app-icon.py` 生成），提示文字为“乾元 Primus”，
//!   有运行中的会话时附上会话数；菜单第一行（不可点）同样显示会话数，之后是“打开乾元”“退出”。
//! - 左键单击（Windows 上也包括双击）打开并聚焦主窗口；右键弹出菜单。
//! - 有会话正在运行时关闭主窗口：窗口隐藏到托盘，Agent 继续运行（[`keep_in_tray_on_close`]）；没有运行中的会话时照常退出。
//! - “退出”：没有运行中的会话时直接退出；否则先询问，确认后给运行中的会话发 `abort`，最多等 3 秒再退出。
//!   退出走 `app.exit`，由 `RunEvent::Exit` 统一保存窗口位置、结束全部 Core（与更新安装的处理）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::sessions::AppSessions;
use crate::supervisor::Supervisor;

const TRAY_ID: &str = "main";
const MENU_STATUS: &str = "status";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";

const APP_NAME: &str = "乾元 Primus";
const OPEN_LABEL: &str = "打开乾元";
const QUIT_LABEL: &str = "退出";
const IDLE_STATUS: &str = "没有运行中的会话";
const QUIT_CONFIRM_TITLE: &str = "退出乾元";
const QUIT_CONFIRM_OK: &str = "退出";
const QUIT_CONFIRM_CANCEL: &str = "取消";

/// 运行中会话数的刷新间隔：只在数值变化时更新提示文字与菜单
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// 退出时等待已发 `abort` 的会话停下的上限（第 5.5 节）
const ABORT_WAIT: Duration = Duration::from_secs(3);
/// 等待会话停下时的检查间隔
const POLL_STEP: Duration = Duration::from_millis(100);

/// 已确认退出、正在等待会话停下：重复点“退出”不再询问或重复发送 `abort`
static QUITTING: AtomicBool = AtomicBool::new(false);

fn running_status(running: usize) -> String {
    if running == 0 {
        IDLE_STATUS.to_owned()
    } else {
        format!("{running} 个会话正在运行")
    }
}

/// 托盘提示文字：应用名，有运行中的会话时另起一行附上会话数。
fn tooltip(running: usize) -> String {
    if running == 0 {
        APP_NAME.to_owned()
    } else {
        format!("{APP_NAME}\n{}", running_status(running))
    }
}

fn quit_confirm_message(running: usize) -> String {
    format!("{running} 个会话正在运行。退出会停止这些会话，确定退出吗？")
}

/// 每隔 `step` 检查一次 `running`，直到为 0 或超过 `timeout`；返回是否已全部停下。
fn wait_until_idle(running: impl Fn() -> usize, timeout: Duration, step: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if running() == 0 {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep(step.min(deadline - now));
    }
}

fn running_count(app: &AppHandle) -> usize {
    app.try_state::<AppSessions>()
        .map(|s| s.running_count())
        .unwrap_or(0)
}

/// 创建托盘图标与菜单，并在后台线程刷新运行中会话数。主窗口创建之后在 setup 中调用。
pub(crate) fn init(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, MENU_STATUS, running_status(0), false, None::<&str>)?;
    let open = MenuItem::with_id(app, MENU_OPEN, OPEN_LABEL, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, QUIT_LABEL, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &separator, &open, &quit])?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip(tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main_window(app),
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        })
        .build(app)?;

    // 会话忙碌状态由各会话的桥在读线程中维护，没有统一的变化通知：每秒取一次计数，变化时才更新
    let handle = app.clone();
    std::thread::Builder::new()
        .name("primus-tray".into())
        .spawn(move || {
            let mut shown = 0;
            loop {
                std::thread::sleep(POLL_INTERVAL);
                let running = running_count(&handle);
                if running != shown {
                    shown = running;
                    let _ = tray.set_tooltip(Some(tooltip(running)));
                    let _ = status.set_text(running_status(running));
                }
            }
        })?;
    Ok(())
}

/// 打开并聚焦主窗口（托盘单击、菜单“打开乾元”）。
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 主窗口收到关闭请求时调用：有会话正在运行（且不在退出过程中）时隐藏窗口留在托盘，返回 true（调用方阻止关闭）。
pub(crate) fn keep_in_tray_on_close(window: &tauri::WebviewWindow) -> bool {
    if QUITTING.load(Ordering::Acquire) || running_count(window.app_handle()) == 0 {
        return false;
    }
    let _ = window.hide();
    true
}

/// 托盘菜单“退出”。
fn request_quit(app: &AppHandle) {
    if QUITTING.load(Ordering::Acquire) {
        return;
    }
    let running = running_count(app);
    if running == 0 {
        QUITTING.store(true, Ordering::Release);
        app.exit(0);
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(quit_confirm_message(running))
        .title(QUIT_CONFIRM_TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            QUIT_CONFIRM_OK.to_owned(),
            QUIT_CONFIRM_CANCEL.to_owned(),
        ))
        .show(move |confirmed| {
            if confirmed && !QUITTING.swap(true, Ordering::AcqRel) {
                quit_after_abort(handle);
            }
        });
}

/// 给运行中的会话发 `abort`，在后台线程中最多等 3 秒，再退出（Core 由 `RunEvent::Exit` 结束）。
fn quit_after_abort(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("primus-quit".into())
        .spawn({
            let app = app.clone();
            move || {
                if let Some(sessions) = app.try_state::<AppSessions>() {
                    sessions.abort_running();
                    if !wait_until_idle(|| sessions.running_count(), ABORT_WAIT, POLL_STEP) {
                        eprintln!("[tray] 会话在 3 秒内没有停下，直接结束 Core");
                    }
                }
                app.exit(0);
            }
        });
    if spawned.is_err() {
        // 线程拉不起来时不再等待：直接结束 Core 并退出
        app.state::<Supervisor>().shutdown();
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn tooltip_shows_running_count_only_when_running() {
        assert_eq!(tooltip(0), "乾元 Primus");
        assert_eq!(tooltip(2), "乾元 Primus\n2 个会话正在运行");
        assert_eq!(running_status(0), "没有运行中的会话");
        assert_eq!(running_status(1), "1 个会话正在运行");
    }

    #[test]
    fn quit_confirm_names_running_count() {
        assert!(quit_confirm_message(3).starts_with("3 个会话正在运行"));
    }

    #[test]
    fn wait_until_idle_returns_once_sessions_stop() {
        let calls = Cell::new(0);
        let idle = wait_until_idle(
            || {
                calls.set(calls.get() + 1);
                if calls.get() >= 3 { 0 } else { 1 }
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
        );
        assert!(idle);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn wait_until_idle_gives_up_after_timeout() {
        let start = Instant::now();
        let idle = wait_until_idle(|| 1, Duration::from_millis(30), Duration::from_millis(5));
        assert!(!idle);
        assert!(start.elapsed() >= Duration::from_millis(30));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
