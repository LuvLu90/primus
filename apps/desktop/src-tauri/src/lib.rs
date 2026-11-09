//! 乾元（Primus）薄壳。目标代码量约 4000 行 Rust 以内（第 5.1 节）。
//!
//! 启动顺序：取令牌模式（`--secret`，无窗口）→ 提权修复模式（`--repair-data-dir`）→ 准备数据目录
//! （第 4 章，不可写时弹修复引导）→ 单实例 → 安装待装的更新（有则拉起安装器并退出，第 3.6 节）→
//! 写入内置渠道（仅首次）并按模型渠道生成 Core 配置（第 9.2、9.4 节）→ 主窗口 → 约 10 秒后自动检查更新。
//! 各模块随开发计划逐步实现。

mod account;
mod attachments;
mod builtin;
mod commands;
mod core_config;
mod fs_watch;
mod git;
mod job;
mod model_catalog;
mod paths;
mod platform;
mod providers;
mod rpc_bridge;
mod session_index;
mod sessions;
mod shell_detect;
mod supervisor;
mod tray;
mod updater;
mod vault;
mod window_placement;
mod workspaces;

use std::sync::Arc;

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
    let model_config = core_config::ModelConfigState::new(
        data_paths.core_dir(),
        data_paths.vault_dir(),
        &data_paths.app_dir(),
    );

    // Core 进程监管：所有 Core 进程放进同一个 Job Object，主进程被强杀时由系统统一回收（第 2.2 节）
    let supervisor = paths::exe_dir()
        .map_err(|e| e.to_string())
        .and_then(|exe_dir| {
            let layout = supervisor::CoreLayout::resolve(
                cfg!(debug_assertions),
                &exe_dir,
                &paths::repo_root(),
            )
            .prefer_system_node();
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

    // 最近工作区与信任状态：users/<SID>/app/workspaces.json（第 15.1 节）
    let workspaces_dir = data_paths.app_dir();

    // 自动更新（第 3.6 节、ADR 0007）：设置在 users/<SID>/app/update.json，待装包在 users/<SID>/updates/；
    // 公钥在构建时编译进来，没有公钥的构建整体禁用
    let current_version = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .expect("Cargo.toml 的 version 是合法的 SemVer");
    let updater = Arc::new(
        updater::Updater::new(
            current_version,
            &paths::exe_dir().unwrap_or_default(),
            data_paths.updates_dir(),
            &data_paths.app_dir(),
            updater::compiled_pubkey(),
        )
        // --data-dir 指定的数据目录：安装后重新打开时带上，否则新版本会改用默认目录
        .with_relaunch_data_dir(
            (data_paths.source() == paths::DataRootSource::CommandLine)
                .then(|| data_paths.root().to_path_buf()),
        ),
    );

    tauri::Builder::default()
        // 单实例必须最先注册：第二个实例启动时把已有主窗口带到前台（第 2.2 节）
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // 系统文件/文件夹对话框（dialog_pick_folder / dialog_pick_files）
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：只在 Rust 侧使用（updater.rs），capabilities 不授予 WebView 任何 updater 权限
        .plugin(tauri_plugin_updater::Builder::new().build())
        // WebView2 用户数据放进 data\users\<SID>\webview（约束 C2，第 4.2 节），不落到 %LOCALAPPDATA%：
        // tauri.conf.json 中主窗口设 create: false，在这里按同一份配置创建并指定数据目录
        .setup({
            let webview_dir = data_paths.webview_dir();
            let sessions_dir = data_paths.sessions_dir();
            let index_db = data_paths.app_dir().join("index.db");
            move |app| {
                // 待装的更新（第 3.6 节）：插件（含单实例）已初始化，到这里已确认是主实例；在创建窗口、写入模型配置
                // 与拉起 Core 之前处理。版本更高时校验后经 UAC 拉起安装器并立即退出（安装器结束后以普通权限重新打开）；
                // 已装过或无效的待装包清理掉；用户取消 UAC 时照常启动，前端再次提示
                let updater = app.state::<Arc<updater::Updater>>().inner().clone();
                if updater::install_on_startup(&updater) {
                    std::process::exit(0);
                }
                // 模型配置：首次启动写入内置渠道与其密钥（之后由用户管理），删除旧版内置令牌，
                // 再按 providers.json 生成 Core 的 models.json 与默认模型。
                // 插件（含单实例）在 setup 之前初始化，到这里已确认是主实例。
                // 失败不阻止启动：设置页与输入框据 models_get 的 error 提示，并可用 models_refresh 重试
                let model_config = app.state::<core_config::ModelConfigState>();
                let seeded = model_config.seed_and_migrate();
                model_config.refresh();
                if seeded {
                    // 内置渠道的模型列表在后台获取一次，不阻塞启动；失败时留空，设置页提示用户获取
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<core_config::ModelConfigState>();
                        if let Err(e) = state.fetch_and_save(builtin::SEED_PROVIDER_ID).await {
                            eprintln!("[core_config] 内置渠道模型列表获取失败：{e}");
                        }
                    });
                }
                // 会话索引（第 10.2 节）：同样在 setup 中打开，第二个实例不碰主实例的库。
                // 库文件打不开时退回内存库，本次运行内列表照常可用
                let session_index = Arc::new(
                    session_index::SessionIndex::open(&index_db, &sessions_dir)
                        .or_else(|e| {
                            eprintln!("会话索引库打不开，改用内存索引：{e}");
                            session_index::SessionIndex::open_in_memory(&sessions_dir)
                        })
                        .map_err(|e| format!("无法创建会话索引：{e}"))?,
                );
                let index_notifier = Arc::new(fs_watch::IndexNotifier::default());
                app.manage(session_index.clone());
                app.manage(index_notifier.clone());
                // 会话目录监听与首次全量扫描在后台线程进行，不阻塞窗口创建（第 10.2 节）
                fs_watch::start(session_index, index_notifier);
                let mut config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .cloned()
                    .ok_or("tauri.conf.json 缺少 main 窗口配置")?;
                // 先隐藏创建，按光标所在显示器摆好位置与大小再显示（window_placement）；
                // 不用配置里的 center（只按主显示器、按逻辑像素居中，窗口大于工作区时会出屏）
                let size = (config.width, config.height);
                let min = (
                    config.min_width.unwrap_or(0.0),
                    config.min_height.unwrap_or(0.0),
                );
                let visible = config.visible;
                config.center = false;
                config.visible = false;
                let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .data_directory(webview_dir)
                    .build()?;
                place_main_window(app.handle(), &window, size, min);
                // App 自己的页面直接授予麦克风权限（语音输入的波形），不弹 WebView2 权限框
                platform::auto_grant_microphone(&window);
                if visible {
                    window.show()?;
                }
                // 主窗口起来后约 10 秒自动检查更新，之后每 24 小时一次（自动更新关闭时跳过，失败只记日志）
                updater::start_auto_check(app.handle().clone(), updater);
                Ok(())
            }
        })
        .manage(data_paths)
        .manage(supervisor)
        .manage(sessions::AppSessions::default())
        .manage(workspaces::Workspaces::new(&workspaces_dir))
        .manage(model_config)
        .manage(updater)
        .manage(platform::speech::Speech::default())
        .invoke_handler(tauri::generate_handler![
            commands::window_set_bounds,
            commands::open_external,
            commands::workspace_open,
            commands::workspace_list,
            commands::workspace_inspect,
            commands::workspace_trust,
            commands::dialog_pick_folder,
            commands::dialog_pick_files,
            commands::session_list,
            commands::session_search,
            commands::session_watch,
            commands::session_archive,
            commands::session_delete,
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
            commands::models_watch,
            commands::providers_list,
            commands::provider_save,
            commands::provider_delete,
            commands::provider_fetch_models,
            commands::update_status,
            commands::update_watch,
            commands::update_check,
            commands::update_settings_set,
            commands::update_install,
            commands::git_branch,
            commands::attachment_image,
            commands::speech_available,
            commands::speech_start,
            commands::speech_stop,
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

/// 主窗口首次摆放：光标所在显示器（取不到时为主显示器）的工作区内居中，默认尺寸放不下时缩小（window_placement）。
fn place_main_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    size: (f64, f64),
    min: (f64, f64),
) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    let area = monitor.work_area();
    let bounds = window_placement::centered_bounds(
        window_placement::WorkArea {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        monitor.scale_factor(),
        size,
        min,
    );
    // 设两次：第一次把窗口移到目标显示器，跨缩放比例时系统会按新 DPI 调整窗口大小；第二次定下最终的物理尺寸与位置
    for _ in 0..2 {
        if let Err(e) =
            platform::set_window_bounds(window, bounds.x, bounds.y, bounds.width, bounds.height)
        {
            eprintln!("主窗口摆放失败，改用系统居中：{e}");
            let _ = window.center();
            return;
        }
    }
}
