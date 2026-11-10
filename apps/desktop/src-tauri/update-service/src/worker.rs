//! 安装进程：由服务从暂存目录里的副本启动（SYSTEM），继承三个句柄——只共享读的暂存安装包、请求者进程
//! （SYNCHRONIZE）、按需的请求者主令牌。依次：
//! 1. 等请求者退出（最多 [`CLIENT_EXIT_TIMEOUT`]；超时说明它没有退出，放弃本次安装）。
//! 2. 等安装目录下的进程全部结束（其他 Windows 会话里还开着 Primus、Core 的 node.exe 还没退干净等），
//!    最多 [`OTHERS_TIMEOUT`]；仍有进程就放弃本次安装（安装包保留在请求者那里，下次再试）。
//! 3. `msiexec /i package.msi /quiet /norestart …`，另一个安装正在进行（1618）时稍后重试。
//! 4. 关闭并删除暂存安装包；需要重开时以请求者身份在其会话中重新打开 Primus（安装失败也重开旧版本）。

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use primus_update::msiexec::{Outcome, install_params};
use primus_update::pipe::{Handle, last_error};
use primus_update::protocol::{relaunch_command_line, validate_local_path};
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, GetExitCodeProcess, PROCESS_INFORMATION,
    STARTUPINFOW, WaitForSingleObject,
};

use crate::win::{self, wide};

const CLIENT_EXIT_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const OTHERS_TIMEOUT: Duration = Duration::from_secs(30);
const MSIEXEC_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const BUSY_RETRIES: u32 = 5;
const BUSY_DELAY: Duration = Duration::from_secs(15);

struct Args {
    package: Handle,
    client: Handle,
    install_dir: String,
    version: String,
    token: Option<Handle>,
    data_dir: Option<String>,
}

fn parse(args: &[OsString]) -> Result<Args, String> {
    let mut package = None;
    let mut client = None;
    let mut install_dir = None;
    let mut version = None;
    let mut token = None;
    let mut data_dir = None;
    let mut iter = args.iter().map(|a| a.to_str().ok_or("参数不是 Unicode"));
    while let Some(key) = iter.next() {
        let key = key?;
        let value = iter.next().ok_or(format!("{key} 缺少值"))??;
        let handle = || win::parse_handle(value).ok_or(format!("{key} 不是句柄"));
        match key {
            "--package" => package = Some(handle()?),
            "--client" => client = Some(handle()?),
            "--relaunch-token" => token = Some(handle()?),
            "--install-dir" => {
                validate_local_path(value, None).map_err(|e| format!("安装目录{e}"))?;
                install_dir = Some(value.to_owned());
            }
            "--data-dir" => {
                validate_local_path(value, None).map_err(|e| format!("数据目录{e}"))?;
                data_dir = Some(value.to_owned());
            }
            "--version" => version = Some(value.to_owned()),
            other => return Err(format!("未知参数 {other}")),
        }
    }
    Ok(Args {
        package: package.ok_or("缺少 --package")?,
        client: client.ok_or("缺少 --client")?,
        install_dir: install_dir.ok_or("缺少 --install-dir")?,
        version: version.ok_or("缺少 --version")?,
        token,
        data_dir,
    })
}

/// 暂存目录 = 本进程（暂存目录里的副本）所在目录；不是从暂存目录运行就拒绝（只能由服务启动）。
fn own_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().map(Path::to_path_buf).ok_or("无法确定目录")?;
    let staging = win::staging_dir().map_err(|e| e.to_string())?;
    let same = dir.to_string_lossy().to_lowercase() == staging.to_string_lossy().to_lowercase();
    if !same {
        return Err(format!("安装进程只能从 {} 运行", staging.display()));
    }
    Ok(dir)
}

pub fn run(args: &[OsString]) -> i32 {
    let dir = match own_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    // 复查并锁住暂存目录（服务可能已空闲退出、不再持有它）；之后才写日志
    let _locks = match win::lock_staging_dir() {
        Ok((_, locks)) => locks,
        Err(e) => {
            eprintln!("暂存目录不可用：{e}");
            return 2;
        }
    };
    let args = match parse(args) {
        Ok(args) => args,
        Err(e) => {
            win::log(&dir, &format!("安装进程参数错误：{e}"));
            return 2;
        }
    };
    let code = install(&dir, &args);
    drop(args.package);
    let _ = fs::remove_file(dir.join(win::PACKAGE_FILE));
    // 请求者没有退出（3）时它仍在运行，不再打开第二个
    if let Some(token) = args.token.as_ref().filter(|_| code != 3) {
        relaunch(&dir, token, &args.install_dir, args.data_dir.as_deref());
    }
    code
}

fn install(dir: &Path, args: &Args) -> i32 {
    win::log(dir, &format!("等待请求者退出后安装 {}", args.version));
    // SAFETY: 继承的进程句柄带 SYNCHRONIZE
    let waited =
        unsafe { WaitForSingleObject(args.client.0, CLIENT_EXIT_TIMEOUT.as_millis() as u32) };
    if waited != WAIT_OBJECT_0 {
        win::log(dir, "请求者没有退出，放弃本次安装");
        return 3;
    }
    let deadline = Instant::now() + OTHERS_TIMEOUT;
    loop {
        match win::processes_under(&args.install_dir) {
            Ok(running) if running.is_empty() => break,
            Ok(running) => {
                if Instant::now() > deadline {
                    let list: Vec<String> = running
                        .iter()
                        .map(|(pid, image)| format!("{pid} {image}"))
                        .collect();
                    win::log(
                        dir,
                        &format!(
                            "安装目录下仍有进程在运行，放弃本次安装：{}",
                            list.join("；")
                        ),
                    );
                    return 4;
                }
            }
            Err(e) => {
                win::log(dir, &format!("无法枚举进程，放弃本次安装：{e}"));
                return 4;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    let msiexec = win::system_dir().join("msiexec.exe");
    let package = dir.join(win::PACKAGE_FILE);
    let log = dir.join(win::MSI_LOG_FILE);
    let params = install_params(&package.to_string_lossy(), &log.to_string_lossy());
    let command = format!("\"{}\" {params}", msiexec.display());
    for attempt in 1..=BUSY_RETRIES {
        win::log(dir, &format!("开始安装（第 {attempt} 次）：{command}"));
        let outcome = match run_msiexec(&msiexec, &command) {
            Ok(code) => Outcome::from_exit_code(code),
            Err(e) => {
                win::log(dir, &format!("无法运行 msiexec：{e}"));
                return 5;
            }
        };
        win::log(dir, &format!("msiexec 结束：{outcome:?}"));
        match outcome {
            Outcome::Success => return 0,
            Outcome::RebootRequired => {
                win::log(dir, "部分文件需要重启 Windows 后才会替换");
                return 0;
            }
            Outcome::Busy if attempt < BUSY_RETRIES => std::thread::sleep(BUSY_DELAY),
            _ => return 6,
        }
    }
    6
}

fn run_msiexec(msiexec: &Path, command: &str) -> std::io::Result<u32> {
    let process = win::spawn(msiexec, command, &[])?;
    // SAFETY: 进程句柄有效
    let waited = unsafe { WaitForSingleObject(process.0, MSIEXEC_TIMEOUT.as_millis() as u32) };
    if waited == WAIT_TIMEOUT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "msiexec 超过一小时没有结束",
        ));
    }
    let mut code = 0u32;
    // SAFETY: 输出参数有效
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
        return Err(last_error());
    }
    Ok(code)
}

/// 以请求者的令牌在其会话的默认桌面上重新打开 Primus（环境变量取自该用户的配置）。
fn relaunch(dir: &Path, token: &Handle, install_dir: &str, data_dir: Option<&str>) {
    let exe = format!("{}\\Primus.exe", install_dir.trim_end_matches('\\'));
    let command = relaunch_command_line(&exe, data_dir);
    let app = wide(&exe);
    let mut cmd = wide(&command);
    let cwd = wide(install_dir);
    let mut desktop = wide("winsta0\\default");
    let mut env: *mut std::ffi::c_void = null_mut();
    // SAFETY: 令牌有效；失败时 env 保持为空，子进程继承本进程环境（SYSTEM 的）——不可接受，直接放弃
    if unsafe { CreateEnvironmentBlock(&mut env, token.0, 0) } == 0 {
        win::log(
            dir,
            &format!("无法取得用户环境，不重新打开 Primus：{}", last_error()),
        );
        return;
    }
    let si = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        lpDesktop: desktop.as_mut_ptr(),
        ..Default::default()
    };
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY: 字符串以 NUL 结尾，命令行可写，环境块来自 CreateEnvironmentBlock
    let ok = unsafe {
        CreateProcessAsUserW(
            token.0,
            app.as_ptr(),
            cmd.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_UNICODE_ENVIRONMENT,
            env,
            cwd.as_ptr(),
            &si,
            &mut pi,
        )
    };
    let err = (ok == 0).then(last_error);
    // SAFETY: 环境块由 CreateEnvironmentBlock 分配
    unsafe { DestroyEnvironmentBlock(env) };
    match err {
        None => {
            drop(Handle(pi.hThread));
            drop(Handle(pi.hProcess));
            win::log(dir, &format!("已重新打开 Primus：{command}"));
        }
        Some(e) => win::log(dir, &format!("重新打开 Primus 失败：{e}")),
    }
}
