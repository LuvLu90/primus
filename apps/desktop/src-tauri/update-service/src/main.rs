//! PrimusUpdate：乾元 Primus 的更新服务（ADR 0007）。由 MSI 安装为按需启动、LocalSystem 运行的 Windows 服务。
//!
//! - `PrimusUpdate.exe --service`：SCM 启动的服务进程（[`service`]），在命名管道上接受安装请求，空闲一段时间后自行停止。
//! - `PrimusUpdate.exe --worker …`：服务为每次安装拉起的安装进程（[`worker`]）。它从暂存目录里服务复制的副本运行，
//!   不占用安装目录里的文件，MSI 停止并替换服务时它不受影响：等请求者退出 → 确认安装目录下没有进程 →
//!   `msiexec /quiet` → 按需以请求者身份重新打开 Primus。
//! - `PrimusUpdate.exe --request --package <MSI> --signature-file <.sig> --version <SemVer> [--relaunch]`：以调用者身份
//!   当一次客户端（与 Primus.exe 发同样的请求），打印应答，接受时退出码 0。供安装冒烟测试与排查用；不需要也不获得任何额外权限。
//! - 其他平台只有库（[`primus_update`]）有意义，二进制直接退出。

#[cfg(windows)]
mod service;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod worker;

#[cfg(windows)]
fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let code = match args.first().and_then(|a| a.to_str()) {
        Some("--service") => service::run(),
        Some("--worker") => worker::run(&args[1..]),
        Some("--request") => request(&args[1..]),
        _ => {
            eprintln!(
                "PrimusUpdate 是乾元 Primus 的更新服务，由系统服务管理器启动，不能直接运行。"
            );
            2
        }
    };
    std::process::exit(code);
}

/// 客户端模式（见模块说明）。
#[cfg(windows)]
fn request(args: &[std::ffi::OsString]) -> i32 {
    use primus_update::protocol::{InstallRequest, PROTOCOL_VERSION};
    let mut package = None;
    let mut signature_file = None;
    let mut version = None;
    let mut relaunch = false;
    let mut iter = args.iter().map(|a| a.to_string_lossy().into_owned());
    while let Some(key) = iter.next() {
        match key.as_str() {
            "--relaunch" => relaunch = true,
            "--package" => package = iter.next(),
            "--signature-file" => signature_file = iter.next(),
            "--version" => version = iter.next(),
            other => {
                eprintln!("未知参数 {other}");
                return 2;
            }
        }
    }
    let (Some(package), Some(signature_file), Some(version)) = (package, signature_file, version)
    else {
        eprintln!(
            "用法：PrimusUpdate.exe --request --package <MSI> --signature-file <.sig> --version <SemVer> [--relaunch]"
        );
        return 2;
    };
    let signature = match std::fs::read_to_string(&signature_file) {
        Ok(s) => s.trim().to_owned(),
        Err(e) => {
            eprintln!("无法读取 {signature_file}：{e}");
            return 2;
        }
    };
    let request = InstallRequest {
        protocol: PROTOCOL_VERSION,
        package,
        version,
        signature,
        relaunch,
        data_dir: None,
    };
    match primus_update::client::request_install(&request) {
        Ok(response) => {
            println!("{}", String::from_utf8_lossy(&response.encode()));
            if response.accepted() { 0 } else { 1 }
        }
        Err(e) => {
            eprintln!("更新服务不可用：{e}");
            3
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("PrimusUpdate 只支持 Windows");
    std::process::exit(2);
}
