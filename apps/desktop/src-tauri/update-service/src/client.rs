//! 应用侧的管道客户端（Windows）：按需启动服务，确认管道另一端就是服务进程，发一个安装请求、读一个应答。
//!
//! 任何人都能抢先创建同名管道（服务没运行时），所以连接后用 `GetNamedPipeServerProcessId` 核对管道服务端的
//! 进程 ID 与 SCM 报告的服务进程 ID 一致，不一致就当作服务不可用（应用随即回退到 UAC 安装），不把请求
//! （以及允许对方模拟的身份）交给冒充者。

use std::io;
use std::ptr::null;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, SECURITY_IMPERSONATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    GetNamedPipeServerProcessId, PIPE_READMODE_MESSAGE, SetNamedPipeHandleState, WaitNamedPipeW,
};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, SC_HANDLE,
    SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_START, SERVICE_STATUS_PROCESS, SERVICE_STOPPED, StartServiceW,
};

use crate::pipe::{Handle, last_error, read_message, write_message};
use crate::protocol::{InstallRequest, MAX_RESPONSE_BYTES, Response};
use crate::{PIPE_NAME, SERVICE_NAME};

/// 等服务进入运行状态的上限。
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// 写请求的上限；读应答的上限（服务要读、复制并验签最大 512 MB 的安装包）。
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

struct Sc(SC_HANDLE);

impl Drop for Sc {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: 句柄由本对象独占
            unsafe { CloseServiceHandle(self.0) };
        }
    }
}

fn query(service: &Sc) -> io::Result<SERVICE_STATUS_PROCESS> {
    let mut status = SERVICE_STATUS_PROCESS::default();
    let mut needed = 0u32;
    // SAFETY: 缓冲区大小如实传入
    let ok = unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        Err(last_error())
    } else {
        Ok(status)
    }
}

/// 确保服务在运行并返回其进程 ID（服务未安装、无权启动等都返回错误）。
fn ensure_running() -> io::Result<u32> {
    // SAFETY: 本机、默认数据库
    let scm = Sc(unsafe { OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT) });
    if scm.0.is_null() {
        return Err(last_error());
    }
    let name = wide(SERVICE_NAME);
    // SAFETY: 名称以 NUL 结尾
    let service =
        Sc(unsafe { OpenServiceW(scm.0, name.as_ptr(), SERVICE_START | SERVICE_QUERY_STATUS) });
    if service.0.is_null() {
        return Err(last_error());
    }
    let deadline = Instant::now() + START_TIMEOUT;
    let mut started = false;
    loop {
        let status = query(&service)?;
        match status.dwCurrentState {
            SERVICE_RUNNING if status.dwProcessId != 0 => return Ok(status.dwProcessId),
            SERVICE_STOPPED if started => {
                return Err(io::Error::other("更新服务启动后立即停止"));
            }
            SERVICE_STOPPED => {
                // SAFETY: 不带参数启动
                if unsafe { StartServiceW(service.0, 0, null()) } == 0 {
                    let err = last_error();
                    // ERROR_SERVICE_ALREADY_RUNNING（并发请求刚启动了它）：继续等待
                    if err.raw_os_error() != Some(1056) {
                        return Err(err);
                    }
                }
                started = true;
            }
            // 正在启动、正在停止（空闲退出）：等状态稳定
            _ => {}
        }
        if Instant::now() > deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "等待更新服务启动超时",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 连接管道并核对服务端进程。
fn connect(service_pid: u32) -> io::Result<Handle> {
    let name = wide(PIPE_NAME);
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        // SECURITY_IMPERSONATION：服务需要模拟本进程读取安装包、取得重新打开 Primus 用的令牌
        // SAFETY: 名称以 NUL 结尾，其余参数合法
        let pipe = Handle(unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION,
                std::ptr::null_mut(),
            )
        });
        if pipe.is_valid() {
            let mut server_pid = 0u32;
            // SAFETY: 输出参数有效
            if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server_pid) } == 0 {
                return Err(last_error());
            }
            if server_pid != service_pid {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "管道 {PIPE_NAME} 的服务端进程 {server_pid} 不是更新服务（{service_pid}）"
                    ),
                ));
            }
            let mode = PIPE_READMODE_MESSAGE;
            // SAFETY: 模式指针有效，其余不修改
            if unsafe { SetNamedPipeHandleState(pipe.0, &mode, null(), null()) } == 0 {
                return Err(last_error());
            }
            return Ok(pipe);
        }
        let err = last_error();
        let busy = err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32);
        // 服务刚启动还没建管道（文件不存在）或另一个请求正在处理（忙）：稍等重试
        if Instant::now() > deadline {
            return Err(err);
        }
        if busy {
            // SAFETY: 名称以 NUL 结尾
            unsafe { WaitNamedPipeW(name.as_ptr(), 1000) };
        } else {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// 发送安装请求并返回服务的应答。`Err` 表示服务不可用（未安装、无法启动、管道冒充、通信失败），
/// 调用方可以改走 UAC 安装；`Ok` 的应答由调用方按代码处理。
pub fn request_install(request: &InstallRequest) -> Result<Response, String> {
    let body = request.encode()?;
    let pid = ensure_running().map_err(|e| format!("无法启动更新服务：{e}"))?;
    let pipe = connect(pid).map_err(|e| format!("无法连接更新服务：{e}"))?;
    write_message(&pipe, &body, WRITE_TIMEOUT).map_err(|e| format!("发送请求失败：{e}"))?;
    let reply = read_message(&pipe, MAX_RESPONSE_BYTES, RESPONSE_TIMEOUT)
        .map_err(|e| format!("读取应答失败：{e}"))?;
    Response::decode(&reply)
}
