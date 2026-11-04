//! Windows Job Object（`KILL_ON_JOB_CLOSE`），覆盖全部 Core 及其子孙进程（技术方案第 2.2、5.5 节）。
//!
//! 每个 Core 进程一个作业，句柄只由薄壳持有；主进程正常退出、崩溃或被任务管理器强杀时，系统关闭这些句柄，
//! 作业内的所有进程（Core、Core 拉起的 bash / PowerShell 等工具进程）随之结束。
//! 单独结束某个 Core 时 [`Job::terminate`] 连同其子孙进程一起结束。
//! Windows 8 起作业可以嵌套，子进程默认继承父进程所在的作业，因此只需把 Core 进程本身放进作业。
//!
//! 非 Windows 平台没有等价机制，[`Job`] 为空实现，由 `supervisor` 在退出时逐个结束子进程（完整适配见 P3）。
//!
//! 作业带名字（`Local\Primus-Core-<主进程 pid>-<序号>-<时间>`），名字经环境变量 [`JOB_NAME_ENV`] 传给 Core：
//! `Primus.exe --secret` 据此打开作业并确认自己在其中（第 9.4 节），作业外的进程拿不到令牌。

// 由 supervisor 使用；它接入启动流程前非测试构建先放行未使用告警。
#![cfg_attr(not(test), allow(dead_code))]

use std::io;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};

/// Core 进程环境中的作业名变量；Core 及其子孙进程（含 `--secret` 取令牌进程）都继承它。
pub(crate) const JOB_NAME_ENV: &str = "PRIMUS_CORE_JOB";

/// 作业名前缀；`--secret` 只接受这个前缀的作业名。
pub(crate) const JOB_NAME_PREFIX: &str = "Local\\Primus-Core-";

static NEXT_JOB: AtomicU64 = AtomicU64::new(0);

/// 本进程内唯一的作业名：pid + 序号 + 纳秒时间，避免与残留或他人预先创建的同名对象重合。
fn unique_job_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "{JOB_NAME_PREFIX}{}-{}-{nanos}",
        std::process::id(),
        NEXT_JOB.fetch_add(1, Ordering::Relaxed)
    )
}

/// 一个设置了 `KILL_ON_JOB_CLOSE` 的作业对象；drop 时关闭句柄，作业内进程全部结束。
pub(crate) struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    name: String,
}

impl Job {
    /// 作业名（传给 Core 的 [`JOB_NAME_ENV`]）。
    pub(crate) fn name(&self) -> &str {
        &self.name
    }
}

// SAFETY: 作业句柄是内核对象句柄，可在任意线程上使用与关闭；Job 不暴露可变内部状态。
#[cfg(windows)]
unsafe impl Send for Job {}
// SAFETY: 同上，AssignProcessToJobObject / TerminateJobObject 对同一句柄并发调用是安全的。
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// 创建命名作业并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；同名对象已存在时失败，不复用他人的作业。
    pub(crate) fn new() -> io::Result<Self> {
        use std::ptr::null;
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        let name = unique_job_name();
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // SAFETY: 默认安全属性；名字是以 NUL 结尾的 UTF-16 字符串
        let handle = unsafe { CreateJobObjectW(null(), wide.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: 紧接在 CreateJobObjectW 之后读取
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            // SAFETY: 句柄有效且只关闭一次
            unsafe { CloseHandle(handle) };
            return Err(io::Error::from_raw_os_error(ERROR_ALREADY_EXISTS as i32));
        }
        let job = Self { handle, name };
        // SAFETY: 全零是该结构体的合法初值
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: 句柄有效，info 指向大小正确的结构体
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// 把子进程放进作业。应在拉起后立即调用：Core 在 RPC 握手前不会拉起任何子进程，
    /// 之后它的所有子孙进程都自动继承本作业。
    pub(crate) fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        // SAFETY: 两个句柄都有效；child 在调用期间存活
        if unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// 立即结束作业内的全部进程（作业本身保留，可继续放入新进程）。
    pub(crate) fn terminate(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: 句柄有效
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// 往上查几层祖先：Core（node）→ Git Bash 启动器 → MSYS bash → `Primus.exe --secret`，留出余量。
#[cfg(windows)]
const MAX_ANCESTORS: usize = 4;

/// 打开命名作业（只要查询权限）；名字须带 [`JOB_NAME_PREFIX`]，否则返回 None。
#[cfg(windows)]
fn open_job(name: &str) -> io::Result<Option<OwnedHandle>> {
    use windows_sys::Win32::System::JobObjects::OpenJobObjectW;
    /// winnt.h 的 JOB_OBJECT_QUERY（windows-sys 把它放在 SystemServices 中，为一个常量不引入该特性）
    const JOB_OBJECT_QUERY: u32 = 0x0004;

    if !name.starts_with(JOB_NAME_PREFIX) {
        return Ok(None);
    }
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: 名字是以 NUL 结尾的 UTF-16 字符串；只请求查询权限
    let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(OwnedHandle(handle)))
}

/// 关闭时自动 `CloseHandle` 的内核句柄。
#[cfg(windows)]
struct OwnedHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: 句柄有效且只在这里关闭一次
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
fn process_in_job(
    process: windows_sys::Win32::Foundation::HANDLE,
    job: &OwnedHandle,
) -> io::Result<bool> {
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    let mut inside = 0;
    // SAFETY: 两个句柄都有效，inside 是有效的输出位置
    if unsafe { IsProcessInJob(process, job.0, &mut inside) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(inside != 0)
}

/// 进程创建时间（FILETIME 的 100ns 计数）。
#[cfg(windows)]
fn creation_time(process: windows_sys::Win32::Foundation::HANDLE) -> io::Result<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: 句柄有效，四个输出位置有效
    if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// 父进程 pid（进程快照）；找不到时返回 None。
#[cfg(windows)]
fn parent_pid(pid: u32) -> io::Result<Option<u32>> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: 只读快照
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = OwnedHandle(snapshot);
    // SAFETY: 全零是该结构体的合法初值；dwSize 按要求设置
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: 快照句柄有效，entry 大小已设置
    let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID == pid {
            return Ok(Some(entry.th32ParentProcessID).filter(|&p| p != 0 && p != pid));
        }
        // SAFETY: 同上
        ok = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(None)
}

/// `--secret` 用：当前进程是否在名为 `name` 的作业中（名字须带 [`JOB_NAME_PREFIX`]）。
#[cfg(windows)]
pub(crate) fn current_process_in_job(name: &str) -> io::Result<bool> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let Some(job) = open_job(name)? else {
        return Ok(false);
    };
    // SAFETY: GetCurrentProcess 返回伪句柄，无需关闭
    process_in_job(unsafe { GetCurrentProcess() }, &job)
}

/// `--secret` 用：调用方是否来自名为 `name` 的 Core 作业——当前进程在作业中，或者往上
/// [`MAX_ANCESTORS`] 层内有祖先进程在作业中。
///
/// 只查自己不够：Core 在 Windows 上经 Git Bash 执行取令牌命令，node（libuv）把 bash 放进自己的作业，
/// 该作业允许脱离（`BREAKAWAY_OK`），MSYS 的 bash 因此用 `CREATE_BREAKAWAY_FROM_JOB` 拉起原生程序，
/// `Primus.exe --secret` 就可能不在 Core 的作业里，于是拒绝出令牌（报错 “Failed to resolve API key …
/// from shell command”）。父进程 bash 仍在作业中，所以沿父进程链查找。
///
/// 防 pid 复用：每一层祖先的创建时间必须早于它的子进程，否则视为链条断开。
#[cfg(windows)]
pub(crate) fn caller_in_job(name: &str) -> io::Result<bool> {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Some(job) = open_job(name)? else {
        return Ok(false);
    };
    // SAFETY: GetCurrentProcess 返回伪句柄，无需关闭
    let current = unsafe { GetCurrentProcess() };
    if process_in_job(current, &job)? {
        return Ok(true);
    }
    let mut pid = std::process::id();
    let mut child_created = creation_time(current)?;
    for _ in 0..MAX_ANCESTORS {
        let Some(ppid) = parent_pid(pid)? else {
            break;
        };
        // SAFETY: 只请求有限查询权限
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, ppid) };
        if handle.is_null() {
            break;
        }
        let parent = OwnedHandle(handle);
        let created = creation_time(parent.0)?;
        if created > child_created {
            // pid 已被晚于子进程创建的进程复用，不是真正的父进程
            break;
        }
        if process_in_job(parent.0, &job)? {
            return Ok(true);
        }
        pid = ppid;
        child_created = created;
    }
    Ok(false)
}

/// 非 Windows 没有作业对象，取令牌模式一律拒绝。
#[cfg(not(windows))]
pub(crate) fn caller_in_job(_name: &str) -> io::Result<bool> {
    Ok(false)
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        // SAFETY: 句柄由 CreateJobObjectW 创建且只关闭一次；关闭即触发 KILL_ON_JOB_CLOSE
        unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(not(windows))]
impl Job {
    pub(crate) fn new() -> io::Result<Self> {
        Ok(Self {
            name: unique_job_name(),
        })
    }

    pub(crate) fn assign(&self, _child: &Child) -> io::Result<()> {
        Ok(())
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// 等待指定 pid 的进程结束；超时返回 false。
    fn wait_pid_exit(pid: u32, timeout: Duration) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        // SAFETY: 只请求 SYNCHRONIZE 权限
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            // 进程已不存在
            return true;
        }
        // SAFETY: 句柄有效
        let result = unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) };
        // SAFETY: 句柄有效且只关闭一次
        unsafe { CloseHandle(handle) };
        result == WAIT_OBJECT_0
    }

    /// 子进程收到一行输入后再拉起一个常驻孙进程并打印其 pid：保证孙进程在放入作业之后才创建。
    const PARENT_SCRIPT: &str = r#"
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  console.log(String(g.pid));
});
setInterval(() => {}, 1000);
"#;

    #[test]
    fn closing_job_kills_child_and_grandchild() {
        let job = Job::new().expect("创建作业");
        let mut child = Command::new("node")
            .args(["-e", PARENT_SCRIPT])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("需要 PATH 中有 node");
        job.assign(&child).expect("放入作业");

        child.stdin.as_mut().unwrap().write_all(b"go\n").unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let grandchild: u32 = line.trim().parse().expect("孙进程 pid");

        // 模拟主进程退出：关闭作业句柄
        drop(job);
        assert!(
            wait_pid_exit(child.id(), Duration::from_secs(10)),
            "子进程应随作业关闭结束"
        );
        assert!(
            wait_pid_exit(grandchild, Duration::from_secs(10)),
            "孙进程应随作业关闭结束"
        );
        let _ = child.wait();
    }

    #[test]
    fn named_job_membership_check() {
        let job = Job::new().unwrap();
        assert!(job.name().starts_with(JOB_NAME_PREFIX));
        assert_ne!(job.name(), Job::new().unwrap().name(), "作业名不重复");
        // 测试进程本身不在新建的作业里
        assert!(!current_process_in_job(job.name()).unwrap());
        // 前缀不对的名字直接拒绝，不存在的作业名报错
        assert!(!current_process_in_job("Local\\Other").unwrap());
        assert!(current_process_in_job(&format!("{JOB_NAME_PREFIX}missing")).is_err());
        // 测试进程及其祖先（cargo / nextest）都不在新建的作业里
        assert!(!caller_in_job(job.name()).unwrap());
        assert!(!caller_in_job("Local\\Other").unwrap());
    }

    /// 由下面的链路测试经 bash / cmd 拉起：打印本进程（取令牌进程的位置）对作业的两种判断
    #[test]
    #[ignore = "只由 secret_chain_through_node_and_shells_reaches_core_job 作为子进程运行"]
    fn probe_job_membership() {
        let Ok(name) = std::env::var("PRIMUS_TEST_PROBE_JOB") else {
            return;
        };
        let direct = current_process_in_job(&name).map_err(|e| e.to_string());
        let caller = caller_in_job(&name).map_err(|e| e.to_string());
        println!("PROBE direct={direct:?} caller={caller:?}");
    }

    /// 模拟 Core 解析 `!命令`：node 在作业中，先经 Git Bash（`spawnSync(bash, ["-c", cmd])`）、
    /// 再经 cmd（`execSync`）拉起探针，探针必须判定调用方来自 Core 作业。
    const CHAIN_SCRIPT: &str = r#"
const { spawnSync, execSync } = require("node:child_process");
const fs = require("node:fs");
process.stdin.once("data", () => {
  const cmd = process.env.PROBE_CMD;
  const out = {};
  const bash = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter(Boolean)
    .map((d) => `${d}\\Git\\bin\\bash.exe`)
    .find((p) => fs.existsSync(p));
  if (bash) {
    const r = spawnSync(bash, ["-c", cmd], { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    out.bash = { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error ? String(r.error) : null };
  }
  try {
    out.cmd = { status: 0, stdout: execSync(cmd, { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    out.cmd = { status: e.status, stdout: e.stdout, stderr: e.stderr, error: String(e) };
  }
  console.log(JSON.stringify(out));
  process.exit(0);
});
"#;

    #[test]
    fn secret_chain_through_node_and_shells_reaches_core_job() {
        let job = Job::new().unwrap();
        let exe = std::env::current_exe().unwrap();
        let cmd = format!(
            "\"{}\" --exact job::tests::probe_job_membership --ignored --nocapture",
            exe.display()
        );
        let mut child = Command::new("node")
            .args(["-e", CHAIN_SCRIPT])
            .env(JOB_NAME_ENV, job.name())
            .env("PRIMUS_TEST_PROBE_JOB", job.name())
            .env("PROBE_CMD", &cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("需要 PATH 中有 node");
        job.assign(&child).expect("放入作业");
        child.stdin.as_mut().unwrap().write_all(b"go\n").unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let _ = child.wait();
        eprintln!("取令牌链路：{line}");
        let out: serde_json::Value = serde_json::from_str(line.trim()).expect("node 输出 JSON");
        let mut checked = 0;
        for shell in ["bash", "cmd"] {
            let Some(result) = out.get(shell) else {
                continue;
            };
            let stdout = result["stdout"].as_str().unwrap_or_default();
            let probe = stdout
                .lines()
                .find(|l| l.starts_with("PROBE "))
                .unwrap_or_else(|| panic!("{shell} 没能运行探针：{result}"));
            assert!(
                probe.contains("caller=Ok(true)"),
                "{shell} 拉起的取令牌进程不被认作 Core 作业的调用方：{probe}"
            );
            checked += 1;
        }
        assert!(checked > 0, "bash 与 cmd 都没有结果：{out}");
    }

    #[test]
    fn terminate_kills_members_but_job_stays_usable() {
        let job = Job::new().unwrap();
        let mut first = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .spawn()
            .unwrap();
        job.assign(&first).unwrap();
        job.terminate().unwrap();
        assert!(wait_pid_exit(first.id(), Duration::from_secs(10)));
        let _ = first.wait();

        let mut second = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .spawn()
            .unwrap();
        // TerminateJobObject 是异步的：成员尚在退出时放入新进程可能得到 ERROR_ACCESS_DENIED，
        // 稍等重试；超时仍失败才算作业不可再用
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match job.assign(&second) {
                Ok(()) => break,
                Err(e)
                    if e.kind() == io::ErrorKind::PermissionDenied
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => panic!("作业结束成员后仍可放入新进程: {e:?}"),
            }
        }
        drop(job);
        assert!(wait_pid_exit(second.id(), Duration::from_secs(10)));
        let _ = second.wait();
    }
}
