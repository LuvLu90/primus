//! 服务进程：注册到 SCM，在命名管道上逐个处理安装请求，空闲 [`IDLE_TIMEOUT`] 后自行停止（按需启动）。
//!
//! 处理一个请求（[`handle_request`]）：
//! 1. 读一条消息（限长、限时），按 [`InstallRequest::decode`] 白名单校验。
//! 2. **以客户端身份**（`ImpersonateNamedPipeClient`）打开安装包：只能读到请求者自己能读的文件；需要重开时同时取得
//!    请求者的令牌（复制为主令牌，提权的完整令牌换成其受限的关联令牌）。随即恢复为 SYSTEM。
//! 3. 读入安装包（≤ 512 MB），用编译进服务的公钥验签（含签名绑定的版本），版本须高于 MSI 记录的已安装版本。
//! 4. 锁住暂存目录（只有 SYSTEM 与 Administrators 可写，见 [`win::lock_staging_dir`]），把**已验签的字节**写成
//!    `package.msi`，以只共享读的方式重新打开并交给安装进程持有：从验签到 msiexec 读完，安装包不可能被替换。
//! 5. 把服务自身复制成暂存目录里的安装进程并启动（[`crate::worker`]），应答 `accepted`。

use std::ffi::c_void;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::time::Duration;

use primus_update::pipe::{
    Handle, event, finish_overlapped, last_error, read_message, write_message,
};
use primus_update::protocol::{
    InstallRequest, MAX_REQUEST_BYTES, PROTOCOL_VERSION, Response, ResponseCode, peek_protocol,
};
use primus_update::verify::{is_newer, parse_version, verify_signature};
use primus_update::{MAX_PACKAGE_BYTES, PIPE_NAME, SERVICE_NAME, compiled_pubkey};
use windows_sys::Win32::Foundation::{
    ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, NO_ERROR,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::{
    DuplicateTokenEx, GetTokenInformation, RevertToSelf, SecurityImpersonation, TOKEN_ALL_ACCESS,
    TOKEN_DUPLICATE, TOKEN_ELEVATION_TYPE, TOKEN_LINKED_TOKEN, TOKEN_QUERY, TokenElevationType,
    TokenElevationTypeFull, TokenLinkedToken, TokenPrimary,
};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_FLAG_OVERLAPPED, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_READ, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    GetNamedPipeClientSessionId, ImpersonateNamedPipeClient, PIPE_READMODE_MESSAGE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows_sys::Win32::System::Services::{
    RegisterServiceCtrlHandlerExW, SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP,
    SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_RUNNING,
    SERVICE_START_PENDING, SERVICE_STATUS, SERVICE_STATUS_HANDLE, SERVICE_STOP_PENDING,
    SERVICE_STOPPED, SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS, SetServiceStatus,
    StartServiceCtrlDispatcherW,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, GetCurrentThread, OpenProcess, OpenThreadToken,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, SetEvent, WaitForMultipleObjects,
    WaitForSingleObject,
};

use crate::win::{self, wide};

/// 没有请求时自动停止的空闲时间。
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// 读请求、写应答的上限（客户端连接后不发数据也不会卡住服务）。
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// 管道 ACL：SYSTEM、Administrators 完全控制，交互用户可读写（连接并发请求）；拒绝网络登录。
/// 管道本身另设 `PIPE_REJECT_REMOTE_CLIENTS`。
const PIPE_SDDL: &str = "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";

static STOP_EVENT: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static STATUS_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static EXIT_CODE: OnceLock<u32> = OnceLock::new();

pub fn run() -> i32 {
    let name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_ptr().cast_mut(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: null_mut(),
            lpServiceProc: None,
        },
    ];
    // SAFETY: 表以空项结尾，名称在调用期间有效；返回时服务已停止
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        eprintln!("无法连接服务控制管理器：{}", last_error());
        return 1;
    }
    EXIT_CODE.get().copied().unwrap_or(0) as i32
}

fn set_status(state: u32, exit_code: u32) {
    let handle = STATUS_HANDLE.load(Ordering::Acquire);
    if handle.is_null() {
        return;
    }
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: exit_code,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: if state == SERVICE_RUNNING || state == SERVICE_STOPPED {
            0
        } else {
            5000
        },
    };
    // SAFETY: 句柄来自 RegisterServiceCtrlHandlerExW
    unsafe { SetServiceStatus(handle as SERVICE_STATUS_HANDLE, &status) };
}

unsafe extern "system" fn control_handler(
    control: u32,
    _event_type: u32,
    _event_data: *mut c_void,
    _context: *mut c_void,
) -> u32 {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            set_status(SERVICE_STOP_PENDING, NO_ERROR);
            let event = STOP_EVENT.load(Ordering::Acquire);
            if !event.is_null() {
                // SAFETY: 事件在服务运行期间有效
                unsafe { SetEvent(event) };
            }
            NO_ERROR
        }
        SERVICE_CONTROL_INTERROGATE => NO_ERROR,
        // ERROR_CALL_NOT_IMPLEMENTED
        _ => 120,
    }
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
    let name = wide(SERVICE_NAME);
    // SAFETY: 名称以 NUL 结尾，处理函数在进程生命周期内有效
    let handle =
        unsafe { RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(control_handler), null()) };
    if handle.is_null() {
        return;
    }
    STATUS_HANDLE.store(handle, Ordering::Release);
    set_status(SERVICE_START_PENDING, NO_ERROR);
    let stop = match event() {
        Ok(stop) => stop,
        Err(e) => {
            let _ = EXIT_CODE.set(e.raw_os_error().unwrap_or(1) as u32);
            set_status(SERVICE_STOPPED, e.raw_os_error().unwrap_or(1) as u32);
            return;
        }
    };
    STOP_EVENT.store(stop.0, Ordering::Release);
    set_status(SERVICE_RUNNING, NO_ERROR);
    let code = match serve(&stop) {
        Ok(()) => NO_ERROR,
        Err(e) => {
            if let Ok(dir) = win::staging_dir() {
                win::log(&dir, &format!("服务异常停止：{e}"));
            }
            e.raw_os_error().unwrap_or(1) as u32
        }
    };
    STOP_EVENT.store(null_mut(), Ordering::Release);
    let _ = EXIT_CODE.set(code);
    set_status(SERVICE_STOPPED, code);
}

/// 建唯一的管道实例并反复使用它（断开后重新等待连接），服务运行期间不留出可被抢注的空档。
fn create_pipe() -> io::Result<Handle> {
    let sd = win::SecurityDescriptor::from_sddl(PIPE_SDDL)?;
    let attrs = sd.attributes();
    let name = wide(PIPE_NAME);
    // SAFETY: 名称以 NUL 结尾，安全属性在调用期间有效
    let pipe = Handle(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            primus_update::protocol::MAX_RESPONSE_BYTES as u32,
            MAX_REQUEST_BYTES as u32,
            0,
            &attrs,
        )
    });
    if !pipe.is_valid() {
        return Err(last_error());
    }
    Ok(pipe)
}

/// 等待连接：有客户端返回 true，停止或空闲超时返回 false。
fn wait_connect(pipe: &Handle, stop: &Handle) -> io::Result<bool> {
    let connected = event()?;
    let mut overlapped = OVERLAPPED {
        hEvent: connected.0,
        ..Default::default()
    };
    // SAFETY: overlapped 在操作结束前有效（下面所有分支都等到操作结束或取消完成）
    if unsafe { ConnectNamedPipe(pipe.0, &mut overlapped) } != 0 {
        return Ok(true);
    }
    let err = last_error();
    match err.raw_os_error().map(|c| c as u32) {
        Some(ERROR_PIPE_CONNECTED) => return Ok(true),
        Some(ERROR_IO_PENDING) => {}
        _ => return Err(err),
    }
    let handles = [stop.0, connected.0];
    let millis = IDLE_TIMEOUT.as_millis() as u32;
    // SAFETY: 两个句柄都有效
    let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, millis) };
    if waited == WAIT_OBJECT_0 + 1 {
        // SAFETY: 同上
        unsafe { finish_overlapped(pipe.0, &mut overlapped, Duration::ZERO) }?;
        return Ok(true);
    }
    // 停止或空闲：取消挂起的连接并等它结束
    // SAFETY: 同上
    let _ = unsafe { finish_overlapped(pipe.0, &mut overlapped, Duration::ZERO) };
    Ok(false)
}

fn serve(stop: &Handle) -> io::Result<()> {
    // 先确认暂存目录安全（之后才写日志、清理残留）；不安全时服务照常应答（每个请求都会被拒绝），不写任何文件。
    // 句柄在服务运行期间一直持有：暂存目录与其上级不能被改名或替换
    let locked = win::lock_staging_dir();
    let dir = match &locked {
        Ok((dir, _)) => dir.clone(),
        Err(_) => win::staging_dir()?,
    };
    let pipe = create_pipe()?;
    win::log(
        &dir,
        &format!("服务启动（版本 {}）", env!("CARGO_PKG_VERSION")),
    );
    if locked.is_ok() {
        cleanup_stale(&dir);
    }
    while wait_connect(&pipe, stop)? {
        let response = match handle_request(&pipe) {
            Ok(response) => response,
            Err(response) => response,
        };
        win::log(
            &dir,
            &format!("应答 {:?}：{}", response.code, response.message),
        );
        if write_message(&pipe, &response.encode(), IO_TIMEOUT).is_ok() {
            // 等客户端读完应答并关闭（再读会得到 ERROR_BROKEN_PIPE）：DisconnectNamedPipe 会丢掉没读走的数据。
            // 不用 FlushFileBuffers：它没有超时，客户端不读应答就会让服务永远卡住
            let _ = read_message(&pipe, 1, IO_TIMEOUT);
        }
        // SAFETY: 管道有效
        unsafe { DisconnectNamedPipe(pipe.0) };
    }
    win::log(&dir, "服务停止（空闲或收到停止请求）");
    Ok(())
}

/// 上次安装留下的暂存文件：没有安装进程持有时删除（被持有说明安装还在进行，删除会失败，忽略）。
fn cleanup_stale(dir: &Path) {
    for name in [win::PACKAGE_FILE, win::WORKER_FILE] {
        let _ = fs::remove_file(dir.join(name));
    }
}

/// 模拟管道客户端期间做的事；离开作用域一定恢复为 SYSTEM（恢复失败直接终止进程，不能带着别人的身份继续）。
struct Impersonation;

impl Impersonation {
    fn begin(pipe: HANDLE) -> io::Result<Self> {
        // SAFETY: 管道已连接
        if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
            return Err(last_error());
        }
        Ok(Self)
    }
}

impl Drop for Impersonation {
    fn drop(&mut self) {
        // SAFETY: 无参数
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

fn fail(code: ResponseCode, message: impl Into<String>) -> Response {
    Response::new(code, message)
}

/// 以客户端身份打开安装包，并按需取得用于重开 Primus 的主令牌。
fn open_as_client(
    pipe: HANDLE,
    request: &InstallRequest,
) -> Result<(Handle, Option<Handle>), Response> {
    let _as_client = Impersonation::begin(pipe)
        .map_err(|e| fail(ResponseCode::Failed, format!("无法模拟请求者：{e}")))?;
    let name = wide(&request.package);
    // SAFETY: 名称以 NUL 结尾；只读、只共享读（读取期间请求者也不能改写）
    let file = Handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
            null_mut(),
        )
    });
    if !file.is_valid() {
        return Err(fail(
            ResponseCode::Failed,
            format!("无法读取安装包：{}", last_error()),
        ));
    }
    let token = if request.relaunch {
        Some(client_primary_token().map_err(|e| {
            fail(
                ResponseCode::Unavailable,
                format!("无法取得请求者的令牌（安装后无法重新打开 Primus）：{e}"),
            )
        })?)
    } else {
        None
    };
    Ok((file, token))
}

/// 当前线程的模拟令牌 → 主令牌；完整的管理员令牌换成它关联的受限令牌，重新打开的 Primus 不以提权身份运行。
fn client_primary_token() -> io::Result<Handle> {
    let mut thread_token = Handle(null_mut());
    // SAFETY: OpenAsSelf = TRUE：按服务自身（SYSTEM）的身份检查令牌对象的访问权限
    if unsafe {
        OpenThreadToken(
            GetCurrentThread(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            1,
            &mut thread_token.0,
        )
    } == 0
    {
        return Err(last_error());
    }
    let mut elevation: TOKEN_ELEVATION_TYPE = 0;
    let mut len = 0u32;
    // SAFETY: 输出缓冲区大小如实传入
    let elevated = unsafe {
        GetTokenInformation(
            thread_token.0,
            TokenElevationType,
            (&mut elevation as *mut TOKEN_ELEVATION_TYPE).cast(),
            size_of::<TOKEN_ELEVATION_TYPE>() as u32,
            &mut len,
        )
    } != 0
        && elevation == TokenElevationTypeFull;
    let mut source = thread_token;
    if elevated {
        let mut linked = TOKEN_LINKED_TOKEN::default();
        // SAFETY: 同上；LocalSystem 持有 SeTcbPrivilege，取得的关联令牌可用作主令牌
        if unsafe {
            GetTokenInformation(
                source.0,
                TokenLinkedToken,
                (&mut linked as *mut TOKEN_LINKED_TOKEN).cast(),
                size_of::<TOKEN_LINKED_TOKEN>() as u32,
                &mut len,
            )
        } != 0
        {
            source = Handle(linked.LinkedToken);
        }
    }
    let mut primary = Handle(null_mut());
    // SAFETY: 源令牌有效
    if unsafe {
        DuplicateTokenEx(
            source.0,
            TOKEN_ALL_ACCESS,
            null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary.0,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(primary)
}

fn read_package(file: &Handle) -> Result<Vec<u8>, Response> {
    use std::os::windows::io::FromRawHandle;
    // 借用句柄读取：用 ManuallyDrop 包住 std 的 File，不让它关闭句柄
    // SAFETY: 句柄有效，File 不会关闭它
    let mut reader = std::mem::ManuallyDrop::new(unsafe { fs::File::from_raw_handle(file.0) });
    let len = reader
        .metadata()
        .map_err(|e| fail(ResponseCode::Failed, format!("无法读取安装包：{e}")))?
        .len();
    if len == 0 || len > MAX_PACKAGE_BYTES {
        return Err(fail(
            ResponseCode::Invalid,
            format!("安装包大小 {len} 字节不在允许范围内"),
        ));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    (&mut *reader)
        .take(MAX_PACKAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail(ResponseCode::Failed, format!("读取安装包失败：{e}")))?;
    if bytes.len() as u64 != len {
        return Err(fail(ResponseCode::Failed, "安装包在读取时发生了变化"));
    }
    Ok(bytes)
}

/// 把已验签的字节写成暂存目录里的 `package.msi`，再以只共享读的方式打开交给安装进程。
fn stage_package(dir: &Path, bytes: &[u8]) -> Result<Handle, Response> {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    let path = dir.join(win::PACKAGE_FILE);
    // 上一次的残留：删不掉说明安装进程还持有它（安装进行中）
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(fail(ResponseCode::Busy, "上一次更新仍在安装")),
    }
    let name = wide(&path);
    // SAFETY: 名称以 NUL 结尾；CREATE_NEW：不打开任何已存在的文件（包括硬链接）
    let handle = Handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    });
    if !handle.is_valid() {
        return Err(fail(
            ResponseCode::Failed,
            format!("无法创建暂存安装包：{}", last_error()),
        ));
    }
    {
        // SAFETY: 句柄的所有权转给 File，写完即关闭
        let mut file = unsafe { fs::File::from_raw_handle(handle.0) };
        std::mem::forget(handle);
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| fail(ResponseCode::Failed, format!("写入暂存安装包失败：{e}")))?;
    }
    // 只读、只共享读：msiexec 可以读取，任何人都不能写入、改名或删除
    // SAFETY: 同上
    let locked = Handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    });
    if !locked.is_valid() {
        return Err(fail(
            ResponseCode::Failed,
            format!("无法锁定暂存安装包：{}", last_error()),
        ));
    }
    Ok(locked)
}

fn install_dir() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("无法确定安装目录"))
}

fn handle_request(pipe: &Handle) -> Result<Response, Response> {
    let body = read_message(pipe, MAX_REQUEST_BYTES, IO_TIMEOUT)
        .map_err(|e| fail(ResponseCode::Invalid, format!("读取请求失败：{e}")))?;
    // 协议版本不同（薄壳与服务版本错配）：按服务不可用应答，薄壳回退到 UAC 并保留待装包
    match peek_protocol(&body) {
        Some(v) if v != u64::from(PROTOCOL_VERSION) => {
            return Err(fail(
                ResponseCode::Unavailable,
                format!("协议版本 {v} 不受支持（服务为 {PROTOCOL_VERSION}）"),
            ));
        }
        _ => {}
    }
    let request = InstallRequest::decode(&body).map_err(|e| fail(ResponseCode::Invalid, e))?;
    let pubkey = compiled_pubkey().ok_or_else(|| {
        fail(
            ResponseCode::Unavailable,
            "此版本的更新服务没有内置更新公钥",
        )
    })?;
    let installed = win::installed_version()
        .ok()
        .and_then(|v| parse_version(&v))
        .ok_or_else(|| fail(ResponseCode::Unavailable, "无法读取已安装的版本"))?;
    if !is_newer(&request.version, &installed) {
        return Err(fail(
            ResponseCode::NotNewer,
            format!("待装版本 {} 不高于已安装版本 {installed}", request.version),
        ));
    }

    let mut client_pid = 0u32;
    // SAFETY: 输出参数有效
    if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut client_pid) } == 0 {
        return Err(fail(
            ResponseCode::Failed,
            format!("无法确定请求者进程：{}", last_error()),
        ));
    }
    // SAFETY: 只请求等待与查询权限
    let client = Handle(unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            client_pid,
        )
    });
    if !client.is_valid() {
        return Err(fail(
            ResponseCode::Failed,
            format!("无法打开请求者进程：{}", last_error()),
        ));
    }

    // 其他 Windows 会话里还有安装目录下的程序在运行（另一个用户开着 Primus）：现在装只会在等待后放弃，
    // 而“立即重启更新”与启动时安装还会重新打开 Primus、再次请求，形成循环。直接应答忙，薄壳保留待装包照常运行
    let install_dir = install_dir().map_err(|e| fail(ResponseCode::Failed, e.to_string()))?;
    let mut client_session = 0u32;
    // SAFETY: 输出参数有效
    if unsafe { GetNamedPipeClientSessionId(pipe.0, &mut client_session) } == 0 {
        return Err(fail(
            ResponseCode::Failed,
            format!("无法确定请求者会话：{}", last_error()),
        ));
    }
    let others = win::processes_under(&install_dir.to_string_lossy())
        .map_err(|e| fail(ResponseCode::Failed, format!("无法枚举进程：{e}")))?
        .into_iter()
        .filter(|p| p.session != client_session)
        .count();
    if others > 0 {
        return Err(fail(
            ResponseCode::Busy,
            "其他 Windows 用户正在使用 Primus，等他们退出后再更新",
        ));
    }

    let (source, token) = open_as_client(pipe.0, &request)?;
    let bytes = read_package(&source)?;
    drop(source);
    verify_signature(&bytes, &request.signature, pubkey, &request.version)
        .map_err(|e| fail(ResponseCode::Signature, format!("安装包签名校验失败：{e}")))?;

    let (dir, _dir_locks) = win::lock_staging_dir()
        .map_err(|e| fail(ResponseCode::Unavailable, format!("暂存目录不可用：{e}")))?;
    let package = stage_package(&dir, &bytes)?;
    drop(bytes);

    // 安装进程从暂存目录里的副本运行：MSI 升级时会停止服务并替换安装目录里的 PrimusUpdate.exe
    let worker = dir.join(win::WORKER_FILE);
    let _ = fs::remove_file(&worker);
    fs::copy(install_dir.join("PrimusUpdate.exe"), &worker)
        .map_err(|e| fail(ResponseCode::Failed, format!("无法准备安装进程：{e}")))?;

    let mut inherit = vec![&package, &client];
    if let Some(token) = &token {
        inherit.push(token);
    }
    for handle in &inherit {
        win::make_inheritable(handle)
            .map_err(|e| fail(ResponseCode::Failed, format!("无法传递句柄：{e}")))?;
    }
    let mut command = format!(
        "\"{}\" --worker --package {} --client {} --service-pid {} --install-dir \"{}\" --version {}",
        worker.display(),
        win::handle_arg(&package),
        win::handle_arg(&client),
        // SAFETY: 无参数
        unsafe { GetCurrentProcessId() },
        install_dir.display(),
        request.version,
    );
    if let Some(token) = &token {
        command.push_str(&format!(" --relaunch-token {}", win::handle_arg(token)));
        if let Some(data_dir) = &request.data_dir {
            command.push_str(&format!(" --data-dir \"{data_dir}\""));
        }
    }
    let raw: Vec<HANDLE> = inherit.iter().map(|h| h.0).collect();
    let process = win::spawn(&worker, &command, &raw)
        .map_err(|e| fail(ResponseCode::Failed, format!("无法启动安装进程：{e}")))?;
    // 安装进程已继承需要的句柄；服务这边的副本随函数返回关闭
    // SAFETY: 进程句柄有效；只确认它没有立即退出（参数错误等）
    if unsafe { WaitForSingleObject(process.0, 200) } == WAIT_OBJECT_0 {
        return Err(fail(ResponseCode::Failed, "安装进程启动后立即退出"));
    }
    Ok(fail(
        ResponseCode::Accepted,
        format!(
            "已验签 {}，请求者（进程 {client_pid}）退出后静默安装{}",
            request.version,
            if request.relaunch {
                "并重新打开"
            } else {
                ""
            }
        ),
    ))
}
