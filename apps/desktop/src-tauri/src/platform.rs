//! 平台差异集中在此（Windows / macOS / Linux）。第 20 章。
//!
//! 当前提供数据目录（第 4 章）需要的能力：当前用户标识、用户目录 ACL、`data` 修复引导与提权修复。
//! Windows 为完整实现；macOS / Linux 只提供让薄壳能编译、单测能运行的最小实现，
//! 完整适配见开发计划 P3（第 19、21 周）。

use std::io;
use std::path::Path;

use crate::paths::RepairChoice;

/// 安装包下载页：修复引导中“重新安装到其他目录”打开它。
pub(crate) const REINSTALL_URL: &str = "https://github.com/skaduv/primus/releases";

/// 修复引导的标题。
const GUIDE_TITLE: &str = "乾元 Primus：数据目录不可写";

/// WebView2 的环境变量优先于 builder 参数与 UserDataFolder 注册表策略。
/// 启动时固定为已准备好的用户目录，不能只清除继承的覆盖值。
pub(crate) fn configure_webview_data_dir(path: &Path) {
    #[cfg(windows)]
    // SAFETY: Windows 上修改进程环境是线程安全的；仅在创建 WebView2 前调用。
    unsafe {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", path);
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// 修复引导正文（第 3.7 节）。`repairable` 为 false 时不提供“以管理员身份修复”。
pub(crate) fn guide_text(detail: &str, repairable: bool) -> String {
    if repairable {
        format!(
            "{detail}\n\n乾元的所有数据（会话、配置、日志）只保存在安装目录下的 data 文件夹，\
             不会改存到 AppData。\n\n\
             · 选择“是”：以管理员身份修复 data 文件夹的写入权限\n\
             · 选择“否”：打开下载页，重新安装到其他目录（如 D:\\Primus）\n\
             · 选择“取消”：退出"
        )
    } else {
        format!(
            "{detail}\n\n乾元不会改存到 AppData。请换一个当前用户可写的数据目录\
             （--data-dir），或重新安装到其他目录。\n\n\
             · 选择“是”：打开下载页，重新安装到其他目录\n\
             · 选择“否”：退出"
        )
    }
}

/// 路径比较用的键（会话索引按工作区过滤，ADR 0006）：Windows 上不区分大小写、`/` 与 `\` 等价；
/// 去掉末尾分隔符（根目录除外）。
pub(crate) fn path_key(path: &str) -> String {
    path_key_for(path, cfg!(windows))
}

/// 按文件身份比较用的键（会话文件占用检查）：先解析符号链接、`.` 段与 Windows 短名（`canonicalize`），
/// 解析不了（文件不存在等）时用原路径；Windows 上去掉 `canonicalize` 加的 `\\?\` 前缀，再按 [`path_key`] 规范化。
pub(crate) fn file_identity_key(path: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    resolved
        .to_str()
        .map(|p| path_key(strip_verbatim_prefix(p, cfg!(windows))))
}

/// 去掉 Windows 的 `\\?\` 前缀（`\\?\UNC\` 网络路径保留原样，二者都经 `canonicalize` 时仍一致）。
fn strip_verbatim_prefix(path: &str, windows: bool) -> &str {
    match path.strip_prefix(r"\\?\") {
        Some(rest) if windows && !rest.starts_with(r"UNC\") => rest,
        _ => path,
    }
}

fn path_key_for(path: &str, windows: bool) -> String {
    let (mut key, sep) = if windows {
        (path.replace('/', "\\").to_lowercase(), '\\')
    } else {
        (path.to_owned(), '/')
    };
    while key.ends_with(sep) {
        let rest = &key[..key.len() - 1];
        // 保留根目录：`/`、`c:\`
        let is_root = rest.is_empty() || (windows && rest.len() == 2 && rest.ends_with(':'));
        if is_root {
            break;
        }
        key.pop();
    }
    key
}

#[cfg(windows)]
pub(crate) use windows_impl::*;

#[cfg(not(windows))]
pub(crate) use fallback_impl::*;

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_CANCELLED, ERROR_SUCCESS,
        GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, WIN32_ERROR,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, SE_FILE_OBJECT,
        SET_ACCESS, SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, CreateWellKnownSid, DACL_SECURITY_INFORMATION,
        EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation,
        InitializeSecurityDescriptor, NO_INHERITANCE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
        SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
        TOKEN_QUERY, TOKEN_USER, TokenUser, WELL_KNOWN_SID_TYPE, WinBuiltinAdministratorsSid,
        WinBuiltinUsersSid, WinCreatorOwnerRightsSid, WinLocalSystemSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateDirectoryW, CreateFileW, DELETE, FILE_ADD_SUBDIRECTORY,
        FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
        FILE_READ_EA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
        GetFileInformationByHandle, OPEN_EXISTING, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, INFINITE, OpenProcessToken, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::Shell::{
        SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW, ShellExecuteW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDNO, IDYES, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
        MB_YESNOCANCEL, MessageBoxW, SW_HIDE, SW_SHOWNORMAL,
    };

    /// `SECURITY_DESCRIPTOR_REVISION`（winnt.h），windows-sys 中位于另一个 feature，这里直接定义。
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

    /// 以 NUL 结尾的 UTF-16 字符串。
    fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
        s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn win32_err(code: WIN32_ERROR) -> io::Error {
        io::Error::from_raw_os_error(code as i32)
    }

    /// 自动关闭的内核句柄。
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: 句柄由本进程打开且只关闭一次
            unsafe { CloseHandle(self.0) };
        }
    }

    /// 由 LocalAlloc 分配、需 LocalFree 释放的内存（ACL、SID 字符串、安全描述符）。
    struct LocalBox<T>(*mut T);
    impl<T> Drop for LocalBox<T> {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: 指针由 Win32 API 用 LocalAlloc 分配
                unsafe { LocalFree(self.0.cast()) };
            }
        }
    }

    /// 当前进程令牌中的用户 SID（TOKEN_USER 缓冲区，SID 指针指向缓冲区内部）。
    struct TokenUserBuf(Vec<u64>);
    impl TokenUserBuf {
        fn current() -> io::Result<Self> {
            let mut token: HANDLE = null_mut();
            // SAFETY: 输出参数指向有效的局部变量
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let token = OwnedHandle(token);
            let mut len = 0u32;
            // SAFETY: 第一次调用只取所需长度
            unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut len) };
            if len == 0 {
                return Err(io::Error::last_os_error());
            }
            // u64 缓冲区保证 TOKEN_USER 的对齐
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            // SAFETY: 缓冲区长度不小于 len
            if unsafe {
                GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), len, &mut len)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(buf))
        }

        fn sid(&self) -> PSID {
            // SAFETY: 缓冲区由 GetTokenInformation(TokenUser) 填充，开头即 TOKEN_USER
            unsafe { (*(self.0.as_ptr() as *const TOKEN_USER)).User.Sid }
        }
    }

    /// 众所周知的 SID（SYSTEM、Users 组）。
    struct WellKnownSid([u8; SECURITY_MAX_SID_SIZE as usize]);
    impl WellKnownSid {
        fn new(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Self> {
            let mut sid = Self([0; SECURITY_MAX_SID_SIZE as usize]);
            let mut size = SECURITY_MAX_SID_SIZE;
            // SAFETY: 缓冲区大小为 SECURITY_MAX_SID_SIZE
            if unsafe { CreateWellKnownSid(kind, null_mut(), sid.0.as_mut_ptr().cast(), &mut size) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(sid)
        }
        fn psid(&mut self) -> PSID {
            self.0.as_mut_ptr().cast()
        }
    }

    /// 可继承到子目录与文件的 ACE。
    fn explicit_access(
        sid: PSID,
        permissions: u32,
        mode: i32,
        trustee_type: i32,
    ) -> EXPLICIT_ACCESS_W {
        explicit_access_with(
            sid,
            permissions,
            mode,
            trustee_type,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        )
    }

    fn explicit_access_with(
        sid: PSID,
        permissions: u32,
        mode: i32,
        trustee_type: i32,
        inheritance: u32,
    ) -> EXPLICIT_ACCESS_W {
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: permissions,
            grfAccessMode: mode,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: trustee_type,
                ptstrName: sid.cast(),
                ..Default::default()
            },
        }
    }

    /// 以不跟随重解析点的方式打开目录句柄；目录是 symlink、junction 等重解析点或不是目录时报错。
    /// 之后的检查与 DACL 修改都基于同一句柄，避免路径检查与使用之间的竞争。
    fn open_dir_no_follow(dir: &Path, access: u32) -> io::Result<OwnedHandle> {
        let path = wide(dir);
        // SAFETY: path 以 NUL 结尾
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let handle = OwnedHandle(handle);
        // SAFETY: 全零是 BY_HANDLE_FILE_INFORMATION 的合法初值
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: 句柄有效，info 指向有效内存
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "目录是符号链接或 junction 等重解析点，拒绝使用",
            ));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, "不是目录"));
        }
        Ok(handle)
    }

    /// 读取句柄对象的安全信息：返回安全描述符（持有内存）与指向其内部的所有者、DACL。
    fn get_security(
        handle: &OwnedHandle,
        info: u32,
    ) -> io::Result<(LocalBox<core::ffi::c_void>, PSID, *mut ACL)> {
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut sd = null_mut();
        // SAFETY: 输出参数指向有效局部变量；安全描述符由 LocalFree 释放
        let code = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                info,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut sd,
            )
        };
        if code != ERROR_SUCCESS {
            return Err(win32_err(code));
        }
        Ok((LocalBox(sd), owner, dacl))
    }

    /// 写入句柄对象的 DACL；`protected` 为 true 时同时禁止继承上级权限。
    fn set_dacl(handle: &OwnedHandle, acl: *const ACL, protected: bool) -> io::Result<()> {
        let mut info = DACL_SECURITY_INFORMATION;
        if protected {
            info |= PROTECTED_DACL_SECURITY_INFORMATION;
        }
        // SAFETY: 句柄与 acl 有效
        let code = unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                info,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        if code != ERROR_SUCCESS {
            return Err(win32_err(code));
        }
        Ok(())
    }

    /// 只含当前用户与 SYSTEM 两条可继承完全控制 ACE 的 ACL（SID 已复制进 ACL，与入参生命周期无关）。
    fn restricted_acl(user: &TokenUserBuf) -> io::Result<LocalBox<ACL>> {
        let mut system = WellKnownSid::new(WinLocalSystemSid)?;
        let entries = [
            explicit_access(user.sid(), FILE_ALL_ACCESS, SET_ACCESS, TRUSTEE_IS_USER),
            explicit_access(
                system.psid(),
                FILE_ALL_ACCESS,
                SET_ACCESS,
                TRUSTEE_IS_WELL_KNOWN_GROUP,
            ),
        ];
        let mut acl: *mut ACL = null_mut();
        // SAFETY: entries 中的 SID 在调用期间有效；不基于旧 ACL，结果只含这两条
        let code =
            unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), null(), &mut acl) };
        if code != ERROR_SUCCESS {
            return Err(win32_err(code));
        }
        Ok(LocalBox(acl))
    }

    /// 当前 Windows 用户的 SID 字符串，如 `S-1-5-21-…-1001`。
    pub(crate) fn current_user_id() -> io::Result<String> {
        let user = TokenUserBuf::current()?;
        let mut raw = null_mut();
        // SAFETY: SID 来自有效的 TOKEN_USER；输出字符串由 LocalFree 释放
        if unsafe { ConvertSidToStringSidW(user.sid(), &mut raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let raw = LocalBox(raw);
        // SAFETY: ConvertSidToStringSidW 返回以 NUL 结尾的 UTF-16 字符串
        let len = (0..).take_while(|&i| unsafe { *raw.0.add(i) } != 0).count();
        // SAFETY: 前 len 个元素均已初始化
        let slice = unsafe { std::slice::from_raw_parts(raw.0, len) };
        Ok(String::from_utf16_lossy(slice))
    }

    /// 已存在的 `users/<SID>` 可接受的所有者：当前用户；或 Administrators 组 / SYSTEM——管理员以提权方式运行时
    /// 新建对象的默认所有者是 Administrators 组，而普通用户无法把所有者设成这两者，所以它们不可能是其他普通用户预先创建的。
    fn is_trusted_owner(owner: PSID, user: &TokenUserBuf) -> io::Result<bool> {
        if owner.is_null() {
            return Ok(false);
        }
        // SAFETY: owner 指向调用方持有的安全描述符内部，user.sid() 指向 user 缓冲区，二者均有效
        if unsafe { EqualSid(owner, user.sid()) } != 0 {
            return Ok(true);
        }
        for kind in [WinBuiltinAdministratorsSid, WinLocalSystemSid] {
            let mut trusted = WellKnownSid::new(kind)?;
            // SAFETY: 两个 SID 均有效
            if unsafe { EqualSid(owner, trusted.psid()) } != 0 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// ACE 类型（winnt.h），windows-sys 中位于另一个 feature，这里直接定义。
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;

    /// `data/users` 上普通主体（Users 组、OWNER RIGHTS）允许拥有的全部权限：遍历、列出、新建子目录、读属性。
    /// 不含 DELETE、FILE_DELETE_CHILD、WRITE_DAC、WRITE_OWNER，因此其他用户无法删除、重命名 `users` 或其中他人的目录，
    /// 也无法改它的权限。
    const USERS_ROOT_LIMITED: u32 = FILE_TRAVERSE
        | FILE_LIST_DIRECTORY
        | FILE_ADD_SUBDIRECTORY
        | FILE_READ_ATTRIBUTES
        | FILE_READ_EA
        | READ_CONTROL
        | SYNCHRONIZE;

    /// 用给定 DACL（受保护）新建目录；`owner` 为 None 时用默认所有者。返回 `Ok(false)` 表示目录已存在。
    fn create_dir_with_dacl(dir: &Path, acl: *const ACL, owner: Option<PSID>) -> io::Result<bool> {
        let mut sd = SECURITY_DESCRIPTOR::default();
        let psd: *mut core::ffi::c_void = (&mut sd as *mut SECURITY_DESCRIPTOR).cast();
        // SAFETY: sd 为本地变量，acl 与 owner 在 CreateDirectoryW 返回前有效
        let ok = unsafe {
            InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION) != 0
                && owner.is_none_or(|o| SetSecurityDescriptorOwner(psd, o, 0) != 0)
                && SetSecurityDescriptorDacl(psd, 1, acl, 0) != 0
                && SetSecurityDescriptorControl(psd, SE_DACL_PROTECTED, SE_DACL_PROTECTED) != 0
        };
        if !ok {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: psd,
            bInheritHandle: 0,
        };
        let path = wide(dir);
        // SAFETY: path 以 NUL 结尾，attributes 有效
        if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } != 0 {
            return Ok(true);
        }
        // SAFETY: 紧接失败的 API 调用读取错误码
        let code = unsafe { GetLastError() };
        if code == ERROR_ALREADY_EXISTS {
            Ok(false)
        } else {
            Err(win32_err(code))
        }
    }

    /// `data/users` 的 DACL（受保护）：SYSTEM 与 Administrators 完全控制（可继承）；Users 组与 OWNER RIGHTS
    /// 只有 [`USERS_ROOT_LIMITED`]（仅本目录）。OWNER RIGHTS 取消了创建者作为所有者隐含的 WRITE_DAC，
    /// 所以先启动的用户也不能事后放宽它。
    fn users_root_acl() -> io::Result<LocalBox<ACL>> {
        let mut system = WellKnownSid::new(WinLocalSystemSid)?;
        let mut admins = WellKnownSid::new(WinBuiltinAdministratorsSid)?;
        let mut users = WellKnownSid::new(WinBuiltinUsersSid)?;
        let mut owner_rights = WellKnownSid::new(WinCreatorOwnerRightsSid)?;
        let entries = [
            explicit_access(
                system.psid(),
                FILE_ALL_ACCESS,
                SET_ACCESS,
                TRUSTEE_IS_WELL_KNOWN_GROUP,
            ),
            explicit_access(
                admins.psid(),
                FILE_ALL_ACCESS,
                SET_ACCESS,
                TRUSTEE_IS_WELL_KNOWN_GROUP,
            ),
            explicit_access_with(
                users.psid(),
                USERS_ROOT_LIMITED,
                SET_ACCESS,
                TRUSTEE_IS_WELL_KNOWN_GROUP,
                NO_INHERITANCE,
            ),
            explicit_access_with(
                owner_rights.psid(),
                USERS_ROOT_LIMITED,
                SET_ACCESS,
                TRUSTEE_IS_WELL_KNOWN_GROUP,
                NO_INHERITANCE,
            ),
        ];
        let mut acl: *mut ACL = null_mut();
        // SAFETY: entries 中的 SID 在调用期间有效
        let code =
            unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), null(), &mut acl) };
        if code != ERROR_SUCCESS {
            return Err(win32_err(code));
        }
        Ok(LocalBox(acl))
    }

    /// 已存在的 `data/users` 的权限是否安全：DACL 受保护；除 SYSTEM、Administrators 外，任何允许 ACE 都不超出
    /// [`USERS_ROOT_LIMITED`]；所有者若不是 SYSTEM / Administrators / 当前用户，必须有 OWNER RIGHTS ACE 取消其隐含权限。
    fn users_root_is_safe(handle: &OwnedHandle, user: &TokenUserBuf) -> io::Result<bool> {
        let (sd, owner, dacl) = get_security(
            handle,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        )?;
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: sd 有效
        if unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if control & SE_DACL_PROTECTED == 0 || dacl.is_null() {
            return Ok(false);
        }
        let mut system = WellKnownSid::new(WinLocalSystemSid)?;
        let mut admins = WellKnownSid::new(WinBuiltinAdministratorsSid)?;
        let mut owner_rights = WellKnownSid::new(WinCreatorOwnerRightsSid)?;
        // SAFETY: 以下 SID 指针均有效（owner、dacl 指向 sd 内部）
        let is = |a: PSID, b: PSID| unsafe { EqualSid(a, b) } != 0;
        let mut has_owner_rights = false;
        // SAFETY: dacl 非空且有效
        let count = unsafe { (*dacl).AceCount };
        for i in 0..u32::from(count) {
            let mut ace = null_mut();
            // SAFETY: i 小于 AceCount
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: GetAce 返回指向 ACE 的有效指针，开头为 ACE_HEADER
            let header = unsafe { *(ace as *const ACE_HEADER) };
            match header.AceType {
                ACCESS_DENIED_ACE_TYPE => continue,
                ACCESS_ALLOWED_ACE_TYPE => {}
                // 对象 ACE、回调 ACE 等不应出现在这里
                _ => return Ok(false),
            }
            let allowed = ace as *const ACCESS_ALLOWED_ACE;
            // SAFETY: ACCESS_ALLOWED_ACE 的 SID 紧随 Mask 存放在 SidStart 处
            let (mask, sid) = unsafe {
                (
                    (*allowed).Mask,
                    std::ptr::addr_of!((*allowed).SidStart) as PSID,
                )
            };
            if is(sid, system.psid()) || is(sid, admins.psid()) {
                continue;
            }
            if mask & !USERS_ROOT_LIMITED != 0 {
                return Ok(false);
            }
            if is(sid, owner_rights.psid()) {
                has_owner_rights = true;
            }
        }
        let owner_ok = !owner.is_null()
            && (is(owner, system.psid())
                || is(owner, admins.psid())
                || is(owner, user.sid())
                || has_owner_rights);
        Ok(owner_ok)
    }

    /// 安全地创建或校验 `data/users`：
    /// - 不存在：带 [`users_root_acl`] 新建；
    /// - 已存在：以不跟随重解析点的句柄打开（拒绝 symlink / junction），权限安全则直接使用；不安全时若该句柄可写 DACL
    ///   且所有者可信（见 [`is_trusted_owner`]）就在同一句柄上重设，否则报错——它可能被其他本地用户预先创建，需要管理员删除后重试。
    pub(crate) fn secure_users_root(dir: &Path) -> io::Result<()> {
        let acl = users_root_acl()?;
        if create_dir_with_dacl(dir, acl.0, None)? {
            return Ok(());
        }
        let user = TokenUserBuf::current()?;
        // 校验与修复必须基于同一句柄：能拿到 WRITE_DAC 就用带写权限的句柄；拿不到（例如 users 由其他用户创建）
        // 只读校验，不安全时直接拒绝，不再按路径重新打开，避免两次打开之间目录被替换
        let (handle, writable) = match open_dir_no_follow(dir, READ_CONTROL | WRITE_DAC) {
            Ok(handle) => (handle, true),
            Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                (open_dir_no_follow(dir, READ_CONTROL)?, false)
            }
            Err(e) => return Err(e),
        };
        if users_root_is_safe(&handle, &user)? {
            return Ok(());
        }
        let (_sd, owner, _) = get_security(&handle, OWNER_SECURITY_INFORMATION)?;
        if !writable || !is_trusted_owner(owner, &user)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "data\\users 的所有者与权限不可信（可能被其他用户预先创建），请让管理员删除该目录后重试",
            ));
        }
        set_dacl(&handle, acl.0, true)
    }

    /// 安全地创建或收紧 `users/<SID>`（第 4.3 节）：
    /// - 不存在：`CreateDirectoryW` 时直接带上“所有者 = 当前用户、受保护 DACL（仅当前用户与 SYSTEM）”，不存在先建后改的窗口；
    /// - 已存在：以不跟随重解析点的句柄打开，拒绝重解析点，且所有者必须可信（见 [`is_trusted_owner`]，防止其他本地用户预先创建），
    ///   再在同一句柄上重设受保护 DACL（幂等，能纠正被手工放宽的权限）。
    pub(crate) fn secure_user_dir(dir: &Path) -> io::Result<()> {
        let user = TokenUserBuf::current()?;
        let acl = restricted_acl(&user)?;
        if create_dir_with_dacl(dir, acl.0, Some(user.sid()))? {
            return Ok(());
        }
        let handle = open_dir_no_follow(dir, READ_CONTROL | WRITE_DAC)?;
        let (_sd, owner, _) = get_security(&handle, OWNER_SECURITY_INFORMATION)?;
        if !is_trusted_owner(owner, &user)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "用户数据目录的所有者不是当前用户（可能被其他用户预先创建），请删除该目录后重试",
            ));
        }
        set_dacl(&handle, acl.0, true)
    }

    /// 在现有 DACL 上为 Users 组追加可继承的“修改”权限（等价 icacls `(OI)(CI)M`，与 MSI 的 data 授权一致）。
    /// 只在提权修复模式中调用；目录以不跟随重解析点的句柄打开，拒绝 symlink / junction，读取与写入基于同一句柄。
    /// `users/<SID>` 的 DACL 受保护，不受影响。
    pub(crate) fn grant_users_modify(dir: &Path) -> io::Result<()> {
        let handle = open_dir_no_follow(dir, READ_CONTROL | WRITE_DAC)?;
        let (_sd, _, old) = get_security(&handle, DACL_SECURITY_INFORMATION)?;
        let mut users = WellKnownSid::new(WinBuiltinUsersSid)?;
        let modify = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
        let entry = explicit_access(
            users.psid(),
            modify,
            GRANT_ACCESS,
            TRUSTEE_IS_WELL_KNOWN_GROUP,
        );
        let mut acl: *mut ACL = null_mut();
        // SAFETY: old 指向 _sd 内部，在 _sd 释放前有效
        let code = unsafe { SetEntriesInAclW(1, &entry, old, &mut acl) };
        if code != ERROR_SUCCESS {
            return Err(win32_err(code));
        }
        let acl = LocalBox(acl);
        set_dacl(&handle, acl.0, false)
    }

    fn message_box(text: &str, style: u32) -> i32 {
        let text = wide(text);
        let title = wide(GUIDE_TITLE);
        // SAFETY: 字符串以 NUL 结尾
        unsafe {
            MessageBoxW(
                null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                style | MB_TOPMOST | MB_SETFOREGROUND,
            )
        }
    }

    /// 弹出修复引导（原生对话框：此时 WebView 尚未创建）。
    pub(crate) fn show_data_dir_guide(detail: &str, repairable: bool) -> RepairChoice {
        let buttons = if repairable { MB_YESNOCANCEL } else { MB_YESNO };
        let result = message_box(&guide_text(detail, repairable), buttons | MB_ICONWARNING);
        match (repairable, result) {
            (true, IDYES) => RepairChoice::RepairAsAdmin,
            (true, IDNO) | (false, IDYES) => RepairChoice::Reinstall,
            _ => RepairChoice::Quit,
        }
    }

    pub(crate) fn show_error(message: &str) {
        message_box(message, MB_OK | MB_ICONERROR);
    }

    /// 以管理员身份（UAC）重新运行自身的修复模式并等待结束。
    /// 返回 `Ok(true)` 表示修复成功；用户取消 UAC 或修复进程失败返回 `Ok(false)`。
    pub(crate) fn run_elevated_repair() -> io::Result<bool> {
        let exe = wide(std::env::current_exe()?);
        let verb = wide("runas");
        let params = wide(crate::paths::REPAIR_DATA_DIR_ARG);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: verb.as_ptr(),
            lpFile: exe.as_ptr(),
            lpParameters: params.as_ptr(),
            nShow: SW_HIDE,
            ..Default::default()
        };
        // SAFETY: info 中的字符串在调用期间有效
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            // SAFETY: 紧接失败的 API 调用读取错误码
            let code = unsafe { GetLastError() };
            if code == ERROR_CANCELLED {
                return Ok(false);
            }
            return Err(win32_err(code));
        }
        if info.hProcess.is_null() {
            return Ok(false);
        }
        let process = OwnedHandle(info.hProcess);
        let mut exit_code = 1u32;
        // SAFETY: 句柄有效
        unsafe {
            WaitForSingleObject(process.0, INFINITE);
            if GetExitCodeProcess(process.0, &mut exit_code) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(exit_code == 0)
    }

    pub(crate) fn open_reinstall_page() {
        let verb = wide("open");
        let url = wide(REINSTALL_URL);
        // SAFETY: 字符串以 NUL 结尾
        unsafe {
            ShellExecuteW(
                null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        };
    }

    /// 测试用：目录 DACL 是否受保护、ACE 条数。
    #[cfg(test)]
    pub(crate) fn dacl_summary(dir: &Path) -> io::Result<(bool, u16)> {
        let handle = open_dir_no_follow(dir, READ_CONTROL)?;
        let (sd, _, dacl) = get_security(&handle, DACL_SECURITY_INFORMATION)?;
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: sd 有效
        if unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: dacl 指向 sd 内部，在 sd 释放前有效
        let aces = unsafe { (*dacl).AceCount };
        Ok((control & SE_DACL_PROTECTED != 0, aces))
    }

    /// 把文件移到回收站（会话删除，ADR 0006）。`path` 须为不带 `\\?\` 前缀的绝对路径。
    pub(crate) fn move_to_trash(path: &Path) -> io::Result<()> {
        use windows_sys::Win32::UI::Shell::{
            FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
            FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
        };

        let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
        if from.contains(&0) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "路径含 NUL"));
        }
        // pFrom 是以两个 NUL 结尾的路径列表
        from.extend([0, 0]);
        // SAFETY: SHFILEOPSTRUCTW 是纯数据结构，全零（空指针、0 标志）是合法初值
        let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
        op.wFunc = FO_DELETE as _;
        op.pFrom = from.as_ptr();
        // FOF_WANTNUKEWARNING：卷上没有回收站、只能永久删除时先警告用户；用户取消则 fAnyOperationsAborted 置位、
        // 返回错误，索引保持不变（不会在没有回收站副本的情况下静默删除）
        op.fFlags =
            (FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT)
                as _;
        // SAFETY: op 的指针字段指向本函数内存活的缓冲区（from），调用期间有效
        let rc = unsafe { SHFileOperationW(&mut op) };
        if rc != 0 {
            return Err(io::Error::other(format!("移到回收站失败（错误码 {rc}）")));
        }
        if op.fAnyOperationsAborted != 0 {
            return Err(io::Error::other("移到回收站被取消"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod fallback_impl {
    use super::*;

    /// 非 Windows：用 `uid-<uid>` 作为用户子目录名（Linux 读 /proc/self 的属主；完整实现见 P3）。
    pub(crate) fn current_user_id() -> io::Result<String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Ok(meta) = std::fs::metadata("/proc/self") {
                return Ok(format!("uid-{}", meta.uid()));
            }
        }
        Ok("local".to_owned())
    }

    /// 非 Windows：创建 `users`，并拒绝符号链接（多用户隔离的完整实现见 P3）。
    pub(crate) fn secure_users_root(path: &Path) -> io::Result<()> {
        std::fs::create_dir_all(path)?;
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "目录是符号链接，拒绝使用",
            ));
        }
        Ok(())
    }

    /// 非 Windows：以 0700 创建；已存在时拒绝符号链接、校验属主（Linux），再设为 0700。
    pub(crate) fn secure_user_dir(dir: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
            match std::fs::DirBuilder::new().mode(0o700).create(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            let meta = std::fs::symlink_metadata(dir)?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "用户数据目录是符号链接或不是目录，拒绝使用",
                ));
            }
            if let Ok(me) = std::fs::metadata("/proc/self")
                && meta.uid() != me.uid()
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "用户数据目录的属主不是当前用户",
                ));
            }
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(dir)?;
        Ok(())
    }

    pub(crate) fn grant_users_modify(_dir: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "提权修复仅在 Windows 上提供",
        ))
    }

    pub(crate) fn show_data_dir_guide(detail: &str, _repairable: bool) -> RepairChoice {
        eprintln!("{GUIDE_TITLE}\n{}", guide_text(detail, false));
        RepairChoice::Quit
    }

    pub(crate) fn show_error(message: &str) {
        eprintln!("{GUIDE_TITLE}：{message}");
    }

    pub(crate) fn run_elevated_repair() -> io::Result<bool> {
        Ok(false)
    }

    pub(crate) fn open_reinstall_page() {
        eprintln!("请从 {REINSTALL_URL} 下载安装包重新安装。");
    }

    /// 移到回收站：macOS / Linux 在 P3 阶段实现，目前不支持。
    pub(crate) fn move_to_trash(_path: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "当前平台暂不支持移到回收站",
        ))
    }
}

/// 一次性设置窗口外框位置与尺寸（物理像素）。
/// Windows 上用一次 `SetWindowPos` 原子更新。前端侧栏伸缩时原点（左边缘）保持不变，只改宽度，右边缘随之移动。
#[cfg(windows)]
pub fn set_window_bounds(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> tauri::Result<()> {
    use std::ffi::c_void;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    let hwnd = window.hwnd()?;
    let cx = i32::try_from(width).unwrap_or(i32::MAX);
    let cy = i32::try_from(height).unwrap_or(i32::MAX);
    // SAFETY: hwnd 是 Tauri 持有且仍存活的主窗口句柄；SetWindowPos 不保留任何指针。
    let ok = unsafe {
        SetWindowPos(
            hwnd.0,
            std::ptr::null_mut(),
            x,
            y,
            cx,
            cy,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

/// 其他平台没有原子接口，分两步设置。
#[cfg(not(windows))]
pub fn set_window_bounds(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> tauri::Result<()> {
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    window.set_size(tauri::PhysicalSize::new(width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_key_normalizes_per_platform() {
        assert_eq!(path_key_for("C:/Work/Proj/", true), r"c:\work\proj");
        assert_eq!(path_key_for(r"C:\Work\Proj\\", true), r"c:\work\proj");
        assert_eq!(path_key_for(r"C:\", true), r"c:\");
        assert_eq!(path_key_for("/home/a/Proj/", false), "/home/a/Proj");
        assert_eq!(path_key_for("/", false), "/");
        assert_eq!(path_key_for("", false), "");
    }

    #[test]
    fn verbatim_prefix_is_stripped_on_windows_only() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\a.jsonl", true),
            r"C:\a.jsonl"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\srv\a.jsonl", true),
            r"\\?\UNC\srv\a.jsonl"
        );
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\a", false), r"\\?\C:\a");
        assert_eq!(strip_verbatim_prefix("/a/b.jsonl", true), "/a/b.jsonl");
    }

    #[test]
    fn file_identity_key_resolves_dot_segments_and_symlinks() {
        let dir = std::env::temp_dir().join(format!("primus-fik-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let file = dir.join("sub").join("a.jsonl");
        std::fs::write(&file, "x").unwrap();
        let dotted = dir
            .join(".")
            .join("sub")
            .join("..")
            .join("sub")
            .join("a.jsonl");
        assert_eq!(file_identity_key(&dotted), file_identity_key(&file));
        #[cfg(unix)]
        {
            let link = dir.join("link");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(dir.join("sub"), &link).unwrap();
            assert_eq!(
                file_identity_key(&link.join("a.jsonl")),
                file_identity_key(&file)
            );
        }
        // 不存在的文件：用原路径
        let missing = dir.join("missing.jsonl");
        assert_eq!(file_identity_key(&missing), missing.to_str().map(path_key));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn webview_data_dir_overrides_inherited_environment() {
        const CHILD: &str = "PRIMUS_TEST_WEBVIEW_ENV";
        if std::env::var_os(CHILD).is_some() {
            let expected = Path::new(r"C:\Primus\data\users\test\webview");
            configure_webview_data_dir(expected);
            assert_eq!(
                std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").unwrap(),
                expected
            );
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::tests::webview_data_dir_overrides_inherited_environment",
            ])
            .env(CHILD, "1")
            .env("WEBVIEW2_USER_DATA_FOLDER", r"C:\outside-data\webview")
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn guide_text_offers_admin_repair_only_when_repairable() {
        let with = guide_text("数据目录不可写：C:\\Program Files\\Primus\\data", true);
        assert!(with.contains("以管理员身份修复"));
        assert!(with.contains("重新安装到其他目录"));
        assert!(with.contains("不会改存到 AppData"));

        let without = guide_text("数据目录不可写：D:\\portable", false);
        assert!(!without.contains("以管理员身份修复"));
        assert!(without.contains("重新安装到其他目录"));
    }

    #[test]
    fn current_user_id_is_non_empty_and_path_safe() {
        let id = current_user_id().unwrap();
        assert!(!id.is_empty());
        assert!(!id.contains(['/', '\\', ':']));
    }
}
