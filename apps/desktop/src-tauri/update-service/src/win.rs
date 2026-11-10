//! 服务与安装进程共用的 Windows 辅助：路径、日志、注册表、安全描述符、暂存目录校验、进程枚举与带句柄的进程创建。

use std::ffi::{OsStr, OsString, c_void};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{SystemTime, UNIX_EPOCH};

use primus_update::pipe::{Handle, last_error};
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    LocalFree, SetHandleInformation,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
    OPEN_EXISTING, READ_CONTROL,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegGetValueW,
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcessId, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    OpenProcess, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, STARTUPINFOEXW,
    UpdateProcThreadAttribute,
};
use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};

/// 暂存目录（相对 ProgramData）：只有 SYSTEM 与 Administrators 可写，MSI 安装时建好并锁定，服务每次使用前复查。
pub const STAGING_PARENT: &str = "Primus";
pub const STAGING_DIR: &str = "Update";
/// 暂存目录内的固定文件名。
pub const PACKAGE_FILE: &str = "package.msi";
pub const WORKER_FILE: &str = "PrimusUpdateWorker.exe";
pub const LOG_FILE: &str = "service.log";
pub const MSI_LOG_FILE: &str = "msiexec.log";
const LOG_MAX_BYTES: u64 = 1024 * 1024;

/// 暂存目录与 MSI 中 UpdateDir 组件相同的安全描述符：所有者 SYSTEM，受保护的 DACL，只有 SYSTEM 与 Administrators（完全控制）。
pub const STAGING_SDDL: &str = "O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

fn from_wide(buf: &[u16]) -> PathBuf {
    PathBuf::from(OsString::from_wide(buf))
}

/// `C:\Windows\System32`（msiexec 从这里取，不经 PATH）。
pub fn system_dir() -> PathBuf {
    let mut buf = [0u16; 260];
    // SAFETY: 缓冲区长度如实传入
    let len = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if len == 0 || len >= buf.len() {
        return PathBuf::from(r"C:\Windows\System32");
    }
    from_wide(&buf[..len])
}

/// `%ProgramData%`（按已知文件夹取，不读环境变量）。
pub fn program_data_dir() -> io::Result<PathBuf> {
    let mut ptr: *mut u16 = null_mut();
    // SAFETY: 输出指针有效；返回的字符串用 CoTaskMemFree 释放
    let hr = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, null_mut(), &mut ptr) };
    if hr < 0 || ptr.is_null() {
        return Err(io::Error::other(format!(
            "无法取得 ProgramData 目录（0x{hr:08x}）"
        )));
    }
    // SAFETY: ptr 是以 NUL 结尾的宽字符串
    let path = unsafe {
        let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
        let path = from_wide(std::slice::from_raw_parts(ptr, len));
        windows_sys::Win32::System::Com::CoTaskMemFree(ptr.cast());
        path
    };
    Ok(path)
}

/// 暂存目录 `%ProgramData%\Primus\Update`。
pub fn staging_dir() -> io::Result<PathBuf> {
    Ok(program_data_dir()?.join(STAGING_PARENT).join(STAGING_DIR))
}

/// 已安装的版本：MSI 写在 `HKLM\Software\Primus` 的 `Version`（SemVer，64 位视图）。
pub fn installed_version() -> io::Result<String> {
    let key = wide(r"Software\Primus");
    let value = wide("Version");
    let mut buf = [0u16; 128];
    let mut size = size_of_val(&buf) as u32;
    // SAFETY: 缓冲区大小如实传入
    let code = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    let len = (size as usize / 2).saturating_sub(1).min(buf.len());
    Ok(String::from_utf16_lossy(&buf[..len])
        .trim_end_matches('\0')
        .to_owned())
}

/// 已确认安全的暂存目录（[`lock_staging_dir`] 成功后设置）。只有它设置之后才写日志文件：以 SYSTEM 身份往一个
/// 普通用户能放联接的目录里追加文件，等于给了他“以 SYSTEM 写任意文件”的能力。
static LOG_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 追加一行日志到暂存目录下的 `service.log`（超过 1MB 时清空重写）。暂存目录还没确认安全、或 `dir` 不是它时不写；失败忽略。
pub fn log(dir: &Path, message: &str) {
    if LOG_DIR.get().map(PathBuf::as_path) != Some(dir) {
        return;
    }
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let _ = fs::remove_file(&path);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // SAFETY: 无参数
    let pid = unsafe { GetCurrentProcessId() };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{now} [{pid}] {message}");
    }
}

/// 由 SDDL 生成的自相对安全描述符（LocalFree 释放）。
pub struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        let text = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: 字符串以 NUL 结尾，输出指针有效
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(Self(sd))
    }

    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: 由 Convert…ToSecurityDescriptorW 分配
        unsafe { LocalFree(self.0) };
    }
}

struct LocalSid(PSID);

impl LocalSid {
    fn new(text: &str) -> io::Result<Self> {
        let text = wide(text);
        let mut sid: PSID = null_mut();
        // SAFETY: 字符串以 NUL 结尾
        if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) } == 0 {
            return Err(last_error());
        }
        Ok(Self(sid))
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        // SAFETY: 由 ConvertStringSidToSidW 分配
        unsafe { LocalFree(self.0) };
    }
}

/// 允许写入目录的权限位：写数据 / 追加（建文件 / 子目录）、写扩展属性、删除子项、删除、改权限、改所有者、通用写 / 全部。
const WRITE_BITS: u32 = 0x0002
    | 0x0004
    | 0x0010
    | 0x0040
    | 0x0001_0000
    | 0x0004_0000
    | 0x0008_0000
    | 0x1000_0000
    | 0x4000_0000;

/// 以不跟随重解析点、不共享删除的方式打开目录：持有期间目录不能被改名、删除或换成联接。
pub fn open_dir_locked(path: &Path) -> io::Result<Handle> {
    let name = wide(path);
    // SAFETY: 名称以 NUL 结尾
    let handle = Handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if !handle.is_valid() {
        return Err(last_error());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: 输出结构有效
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(last_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(io::Error::other(format!("{} 不是目录", path.display())));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other(format!(
            "{} 是重解析点（联接或符号链接）",
            path.display()
        )));
    }
    Ok(handle)
}

/// 目录的所有者须是 SYSTEM 或 Administrators，DACL 中能写入的条目只能给 SYSTEM、Administrators 或 CREATOR OWNER
/// （本目录里的文件都由 SYSTEM 创建）。不满足就拒绝使用（服务不去修改它：交给下一次修复安装）。
pub fn check_dir_secure(handle: &Handle, path: &Path) -> io::Result<()> {
    let system = LocalSid::new("S-1-5-18")?;
    let admins = LocalSid::new("S-1-5-32-544")?;
    let creator = LocalSid::new("S-1-3-0")?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: 输出指针有效；sd 用 LocalFree 释放，owner 与 dacl 指向 sd 内部
    let code = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut sd,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    struct Free(PSECURITY_DESCRIPTOR);
    impl Drop for Free {
        fn drop(&mut self) {
            // SAFETY: 由 GetSecurityInfo 分配
            unsafe { LocalFree(self.0) };
        }
    }
    let _free = Free(sd);
    let insecure = |why: &str| io::Error::other(format!("{} 不安全：{why}", path.display()));
    // SAFETY: SID 指针都有效
    let is = |sid: PSID, other: &LocalSid| unsafe { EqualSid(sid, other.0) } != 0;
    if owner.is_null() || !(is(owner, &system) || is(owner, &admins)) {
        return Err(insecure("所有者不是 SYSTEM 或 Administrators"));
    }
    if dacl.is_null() {
        return Err(insecure("没有 DACL（任何人可写）"));
    }
    // SAFETY: dacl 指向 sd 内部的有效 ACL
    let count = unsafe { (*dacl).AceCount };
    for index in 0..u32::from(count) {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: 索引在 AceCount 之内
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err(last_error());
        }
        // SAFETY: GetAce 返回的条目以 ACE_HEADER 开头
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        // 0 = ACCESS_ALLOWED_ACE_TYPE；拒绝条目与其他类型（审核等）不会放宽写入
        if header.AceType != 0 {
            continue;
        }
        // SAFETY: 类型为允许条目
        let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        if allowed.Mask & WRITE_BITS == 0 {
            continue;
        }
        let sid = (&allowed.SidStart as *const u32)
            .cast_mut()
            .cast::<c_void>();
        if !(is(sid, &system) || is(sid, &admins) || is(sid, &creator)) {
            return Err(insecure("有 SYSTEM、Administrators 以外的写入权限"));
        }
    }
    Ok(())
}

/// 取得并锁住暂存目录：`%ProgramData%\Primus` 与其下 `Update` 都须安全（不存在则以 [`STAGING_SDDL`] 新建）。
/// 返回两个目录句柄：持有期间它们不能被改名或替换。
pub fn lock_staging_dir() -> io::Result<(PathBuf, [Handle; 2])> {
    let parent = program_data_dir()?.join(STAGING_PARENT);
    let dir = parent.join(STAGING_DIR);
    let sd = SecurityDescriptor::from_sddl(STAGING_SDDL)?;
    let mut handles = Vec::with_capacity(2);
    for path in [&parent, &dir] {
        let name = wide(path);
        let attrs = sd.attributes();
        // SAFETY: 名称以 NUL 结尾，安全属性有效
        if unsafe { CreateDirectoryW(name.as_ptr(), &attrs) } == 0 {
            let err = last_error();
            if err.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
                return Err(err);
            }
        }
        let handle = open_dir_locked(path)?;
        check_dir_secure(&handle, path)?;
        handles.push(handle);
    }
    let [a, b]: [Handle; 2] = handles
        .try_into()
        .map_err(|_| io::Error::other("内部错误"))?;
    let _ = LOG_DIR.set(dir.clone());
    Ok((dir, [a, b]))
}

/// 进程映像的完整路径（Win32 格式）。
pub fn process_image(process: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: 缓冲区长度如实传入
    let ok = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
    };
    (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

/// 映像位于 `dir` 之内的进程（不含本进程）：返回 `(pid, 路径)`。查询不了的进程（受保护进程等）跳过。
pub fn processes_under(dir: &str) -> io::Result<Vec<(u32, String)>> {
    // SAFETY: 快照所有进程
    let snapshot = Handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) });
    if !snapshot.is_valid() {
        return Err(last_error());
    }
    // SAFETY: 无参数
    let me = unsafe { GetCurrentProcessId() };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = Vec::new();
    // SAFETY: entry.dwSize 已设置
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    while more {
        let pid = entry.th32ProcessID;
        if pid != 0 && pid != me {
            // SAFETY: 只请求查询权限
            let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
            if process.is_valid()
                && let Some(image) = process_image(process.0)
                && primus_update::protocol::path_is_under(&image, dir)
            {
                found.push((pid, image));
            }
        }
        // SAFETY: 同上
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    Ok(found)
}

/// 把句柄设为可继承（只用于交给子进程的显式句柄列表）。
pub fn make_inheritable(handle: &Handle) -> io::Result<()> {
    // SAFETY: 句柄有效
    if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// 启动无窗口子进程，只继承 `inherit` 中列出的句柄（`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`，不会把服务的其他句柄漏给它）。
/// 返回进程句柄。
pub fn spawn(application: &Path, command_line: &str, inherit: &[HANDLE]) -> io::Result<Handle> {
    let app = wide(application);
    let mut cmd = wide(command_line);
    let mut si = STARTUPINFOEXW::default();
    si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // 属性列表的存储：CreateProcessW 返回前一直有效
    let mut attr_store: Option<Vec<u8>> = None;
    let mut flags = CREATE_NO_WINDOW;
    let list_ready = !inherit.is_empty();
    if list_ready {
        let mut size = 0usize;
        // SAFETY: 第一次调用只查询所需大小
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        let buf = attr_store.insert(vec![0u8; size]);
        let list = buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: 缓冲区大小来自上一次查询
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
            return Err(last_error());
        }
        // SAFETY: 句柄数组在 CreateProcessW 返回前有效
        let ok = unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherit.as_ptr().cast(),
                size_of_val(inherit),
                null_mut(),
                null(),
            )
        };
        if ok == 0 {
            let err = last_error();
            // SAFETY: 已初始化
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(err);
        }
        si.lpAttributeList = list;
        flags |= EXTENDED_STARTUPINFO_PRESENT;
    }
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY: 字符串以 NUL 结尾，命令行缓冲区可写，其余参数合法
    let ok = unsafe {
        CreateProcessW(
            app.as_ptr(),
            cmd.as_mut_ptr(),
            null(),
            null(),
            i32::from(list_ready),
            flags,
            null(),
            null(),
            &si.StartupInfo,
            &mut pi,
        )
    };
    let err = (ok == 0).then(last_error);
    if list_ready {
        // SAFETY: 已初始化
        unsafe { DeleteProcThreadAttributeList(si.lpAttributeList) };
    }
    if let Some(err) = err {
        return Err(err);
    }
    drop(Handle(pi.hThread));
    Ok(Handle(pi.hProcess))
}

/// 命令行里句柄的十进制表示（子进程继承后句柄值不变）。
pub fn handle_arg(handle: &Handle) -> String {
    (handle.0 as usize).to_string()
}

/// 解析命令行传来的句柄值。
pub fn parse_handle(text: &str) -> Option<Handle> {
    let value: usize = text.parse().ok()?;
    let handle = Handle(value as HANDLE);
    (value != 0 && handle.0 != INVALID_HANDLE_VALUE).then_some(handle)
}
