//! 命名管道的读写（Windows）：重叠 I/O + 超时，客户端与服务端共用，任何一方都不会因为对端卡住而永远等待。

use std::io;
use std::ptr::null;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_MORE_DATA, GetLastError, HANDLE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

/// 拥有并在离开作用域时关闭的句柄（空句柄与 `INVALID_HANDLE_VALUE` 不关闭）。
#[derive(Debug)]
pub struct Handle(pub HANDLE);

// SAFETY: 内核句柄可以在线程之间传递
unsafe impl Send for Handle {}

impl Handle {
    pub fn is_valid(&self) -> bool {
        !self.0.is_null() && self.0 != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if self.is_valid() {
            // SAFETY: 句柄由本对象独占
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// 紧接失败的 API 调用构造错误。
pub fn last_error() -> io::Error {
    // SAFETY: 只读取线程的最后错误码
    io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

/// 手动复位的事件（重叠 I/O 用）。
pub fn event() -> io::Result<Handle> {
    // SAFETY: 参数都是合法的空指针 / 布尔值
    let h = Handle(unsafe { CreateEventW(null(), 1, 0, null()) });
    if h.is_valid() {
        Ok(h)
    } else {
        Err(last_error())
    }
}

/// 等待一个已经发起的重叠操作完成；超时则取消并返回 `TimedOut`。
///
/// # Safety
/// `overlapped` 必须是发起该操作时使用的同一个结构，且在操作结束前保持有效（本函数返回前操作一定已结束）。
pub unsafe fn finish_overlapped(
    handle: HANDLE,
    overlapped: &mut OVERLAPPED,
    timeout: Duration,
) -> io::Result<u32> {
    let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
    // SAFETY: 事件句柄在 overlapped 中，调用方保证有效
    let waited = unsafe { WaitForSingleObject(overlapped.hEvent, millis) };
    let mut transferred = 0u32;
    if waited != WAIT_OBJECT_0 {
        // 超时：取消后必须等取消完成，overlapped 才能释放
        // SAFETY: 同上
        unsafe {
            CancelIoEx(handle, overlapped);
            GetOverlappedResult(handle, overlapped, &mut transferred, 1);
        }
        return Err(io::Error::new(io::ErrorKind::TimedOut, "管道操作超时"));
    }
    // SAFETY: 同上
    if unsafe { GetOverlappedResult(handle, overlapped, &mut transferred, 0) } == 0 {
        return Err(last_error());
    }
    Ok(transferred)
}

/// 读一条消息（消息模式管道），超过 `max` 字节视为错误。
pub fn read_message(pipe: &Handle, max: usize, timeout: Duration) -> io::Result<Vec<u8>> {
    let event = event()?;
    let mut buf = vec![0u8; max + 1];
    let mut overlapped = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let mut read = 0u32;
    // SAFETY: 缓冲区与 overlapped 在操作结束前有效（finish_overlapped 保证返回前结束）
    let ok = unsafe {
        ReadFile(
            pipe.0,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut read,
            &mut overlapped,
        )
    };
    let read = if ok != 0 {
        read
    } else {
        let err = last_error();
        match err.raw_os_error().map(|c| c as u32) {
            Some(ERROR_IO_PENDING) => {
                // SAFETY: 同上
                match unsafe { finish_overlapped(pipe.0, &mut overlapped, timeout) } {
                    Ok(n) => n,
                    Err(e) if e.raw_os_error() == Some(ERROR_MORE_DATA as i32) => {
                        return Err(too_long());
                    }
                    Err(e) => return Err(e),
                }
            }
            Some(ERROR_MORE_DATA) => return Err(too_long()),
            _ => return Err(err),
        }
    };
    let read = read as usize;
    if read > max {
        return Err(too_long());
    }
    buf.truncate(read);
    Ok(buf)
}

fn too_long() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "消息过长")
}

/// 写一条消息。
pub fn write_message(pipe: &Handle, data: &[u8], timeout: Duration) -> io::Result<()> {
    let event = event()?;
    let mut overlapped = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let mut written = 0u32;
    // SAFETY: 数据与 overlapped 在操作结束前有效
    let ok = unsafe {
        WriteFile(
            pipe.0,
            data.as_ptr(),
            data.len() as u32,
            &mut written,
            &mut overlapped,
        )
    };
    if ok == 0 {
        let err = last_error();
        if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            return Err(err);
        }
        // SAFETY: 同上
        written = unsafe { finish_overlapped(pipe.0, &mut overlapped, timeout) }?;
    }
    if written as usize != data.len() {
        return Err(io::Error::new(io::ErrorKind::WriteZero, "消息未写完"));
    }
    Ok(())
}
