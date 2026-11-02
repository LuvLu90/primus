//! 乾元（Primus）薄壳。目标代码量约 4000 行 Rust 以内（第 5.1 节）。
//!
//! 启动顺序：取令牌模式（`--secret`，无窗口）→ 提权修复模式（`--repair-data-dir`）→ 准备数据目录
//! （第 4 章，不可写时弹修复引导）→ 写入模型配置与令牌（第 9.2、9.4 节）→ 单实例 → 主窗口。
//! 各模块随开发计划逐步实现。

mod account;
mod builtin;
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
    // Core 经 models.json 的取令牌命令拉起的子进程：不初始化 Tauri、不触发单实例转发，输出令牌后立即退出（第 9.4 节）
    if let Some(id) = vault::parse_secret_arg(std::env::args_os().skip(1)) {
        std::process::exit(vault::run_secret_mode(&id) as i32);
    }

    // 修复引导以管理员身份拉起的子进程：只修复 data 权限，不打开窗口
    if paths::has_repair_arg(std::env::args_os().skip(1)) {
        std::process::exit(paths::run_repair_mode());
    }

    // 数据目录必须在任何其他模块之前就绪；不可写时只引导修复，绝不回退到 AppData（约束 C2）
    let Some(data_paths) = paths::prepare_or_guide() else {
        std::process::exit(1);
    };
    platform::configure_webview_data_dir(&data_paths.webview_dir());

    // 模型配置状态；写入（refresh）放到 setup 中，等单实例插件放行本进程之后再做，
    // 避免被转发后退出的第二个实例改写主实例正在使用的保险库与 models.json
    let model_config =
        core_config::ModelConfigState::new(data_paths.core_dir(), data_paths.vault_dir());

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
                // 模型配置：校验内置配置（将来为账号服务下发），令牌写入保险库，生成 Core 的 models.json 与默认模型。
                // 插件（含单实例）在 setup 之前初始化，到这里已确认是主实例。
                // 失败不阻止启动：设置页与输入框据 models_get 的 error 提示，并可用 models_refresh 重试
                app.state::<core_config::ModelConfigState>().refresh();
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
        .manage(model_config)
        .invoke_handler(tauri::generate_handler![
            commands::window_set_bounds,
            commands::session_open,
            commands::session_close,
            commands::core_send,
            commands::core_restart,
            commands::auth_status,
            commands::auth_login,
            commands::auth_logout,
            commands::models_get,
            commands::models_refresh,
            commands::models_set_default,
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
