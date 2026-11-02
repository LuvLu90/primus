//! 乾元（Primus）薄壳。目标代码量约 4000 行 Rust 以内（第 5.1 节）。
//!
//! 启动顺序：提权修复模式（`--repair-data-dir`）→ 准备数据目录（第 4 章，不可写时弹修复引导）→ 单实例 → 主窗口。
//! 各模块随开发计划逐步实现。

mod commands;
mod core_config;
mod fs_watch;
mod git;
mod job;
mod paths;
mod platform;
mod rpc_bridge;
mod session_index;
mod sessions;
mod shell_detect;
mod supervisor;
mod tray;
mod updater;
mod vault;

use tauri::Manager;

pub fn run() {
    // 修复引导以管理员身份拉起的子进程：只修复 data 权限，不打开窗口
    if paths::has_repair_arg(std::env::args_os().skip(1)) {
        std::process::exit(paths::run_repair_mode());
    }

    // 数据目录必须在任何其他模块之前就绪；不可写时只引导修复，绝不回退到 AppData（约束 C2）
    let Some(data_paths) = paths::prepare_or_guide() else {
        std::process::exit(1);
    };
    platform::configure_webview_data_dir(&data_paths.webview_dir());

    // Core 进程监管：所有 Core 进程放进同一个 Job Object，主进程被强杀时由系统统一回收（第 2.2 节）
    let supervisor = paths::exe_dir()
        .map_err(|e| e.to_string())
        .and_then(|exe_dir| {
            let layout = supervisor::CoreLayout::resolve(
                cfg!(debug_assertions),
                &exe_dir,
                &paths::repo_root(),
            );
            supervisor::Supervisor::new(layout, data_paths.clone())
                .map_err(|e| format!("无法创建内核进程作业对象：{e}"))
        });
    let supervisor = match supervisor {
        Ok(supervisor) => supervisor,
        Err(message) => {
            platform::show_error(&message);
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        // 单实例必须最先注册：第二个实例启动时把已有主窗口带到前台（第 2.2 节）
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // WebView2 用户数据放进 data\users\<SID>\webview（约束 C2，第 4.2 节），不落到 %LOCALAPPDATA%：
        // tauri.conf.json 中主窗口设 create: false，在这里按同一份配置创建并指定数据目录
        .setup({
            let webview_dir = data_paths.webview_dir();
            move |app| {
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .cloned()
                    .ok_or("tauri.conf.json 缺少 main 窗口配置")?;
                tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .data_directory(webview_dir)
                    .build()?;
                Ok(())
            }
        })
        .manage(data_paths)
        .manage(supervisor)
        .manage(sessions::AppSessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::window_set_bounds,
            commands::session_open,
            commands::session_close,
            commands::core_send,
            commands::core_restart,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Primus")
        .run(|app, event| {
            // 正常退出时主动结束 Core；异常退出由 Job Object 兜底
            if let tauri::RunEvent::Exit = event {
                app.state::<supervisor::Supervisor>().shutdown();
            }
        });
}
