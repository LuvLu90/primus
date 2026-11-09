//! WebView 权限：语音输入的波形要在 WebView 里用 getUserMedia 读麦克风音量，
//! 默认 WebView2 会弹出“http://… 想要使用麦克风 [阻止][允许]”。App 自己的页面直接授予麦克风权限，不弹窗：
//!
//! - 只认 App 自己的源：`http(s)://tauri.localhost`、`tauri://localhost`，开发构建另认 devUrl `http://localhost:3000`；
//!   其他源（外部网页、iframe）与其他权限种类一律不处理，保持 WebView2 默认行为。
//! - Windows：挂 WebView2 的 `PermissionRequested` 事件（麦克风 → ALLOW）；并在 Profile 上把这几个源的麦克风权限
//!   预先设为 ALLOW，覆盖用户以前在弹窗里点过、被 WebView2 记住的“阻止”（记住的决定不会再触发事件）。
//! - 系统隐私设置（麦克风、联机语音识别）App 无权更改：被拒时由前端提示并打开对应的 ms-settings 页面。

/// App 自己的页面源（开发构建另加 devUrl）。
const APP_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];
const DEV_ORIGIN: &str = "http://localhost:3000";

/// 本构建应自动授予麦克风权限的源。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn granted_origins() -> Vec<&'static str> {
    let mut origins = APP_ORIGINS.to_vec();
    if cfg!(debug_assertions) {
        origins.push(DEV_ORIGIN);
    }
    origins
}

/// 请求权限的页面 URI 的源（`scheme://host[:port]`，小写）；不是带主机的 URI 时为 None。
#[cfg_attr(not(windows), allow(dead_code))]
fn origin_of(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // 带用户信息（user@host）的 URI 不是 App 自己的页面
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{authority}").to_ascii_lowercase())
}

/// 请求来自 App 自己的页面时返回 true（只比较源，路径不限）。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_app_origin(uri: &str, dev: bool) -> bool {
    let Some(origin) = origin_of(uri) else {
        return false;
    };
    // 默认端口写出来也算同一个源
    let origin = origin
        .strip_suffix(":80")
        .filter(|o| o.starts_with("http://"))
        .or_else(|| {
            origin
                .strip_suffix(":443")
                .filter(|o| o.starts_with("https://"))
        })
        .map(str::to_owned)
        .unwrap_or(origin);
    APP_ORIGINS.contains(&origin.as_str()) || (dev && origin == DEV_ORIGIN)
}

#[cfg(windows)]
pub(crate) use windows_impl::grant_microphone;

#[cfg(windows)]
mod windows_impl {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, ICoreWebView2_13, ICoreWebView2Controller,
        ICoreWebView2Profile4,
    };
    use webview2_com::{
        PermissionRequestedEventHandler, SetPermissionStateCompletedHandler, take_pwstr,
    };
    use windows::core::{HSTRING, Interface, PWSTR};

    use super::{granted_origins, is_app_origin};

    /// 给这个 WebView 挂上麦克风自动授权（每个 WebView 调用一次）。
    pub(crate) fn grant_microphone(
        controller: &ICoreWebView2Controller,
    ) -> windows::core::Result<()> {
        // SAFETY: 以下均为 WebView2 COM 调用，controller 由 Tauri 持有且在 UI 线程上使用（with_webview 回调）。
        unsafe {
            let webview = controller.CoreWebView2()?;
            let dev = cfg!(debug_assertions);
            let mut token = 0i64;
            webview.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        return Ok(());
                    }
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    if is_app_origin(&take_pwstr(uri), dev) {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            // 覆盖 Profile 里记住的决定（WebView2 运行时较旧、没有 Profile4 时跳过，事件仍然生效）
            if let Ok(profile) = webview
                .cast::<ICoreWebView2_13>()
                .and_then(|w| w.Profile())
                .and_then(|p| p.cast::<ICoreWebView2Profile4>())
            {
                for origin in granted_origins() {
                    // 设置失败（旧运行时等）不影响事件授权，结果不处理
                    let handler = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
                    let _ = profile.SetPermissionState(
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        &HSTRING::from(origin),
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        &handler,
                    );
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_origins_are_granted() {
        assert!(is_app_origin("http://tauri.localhost/", false));
        assert!(is_app_origin("http://tauri.localhost/chat/?s=abc", false));
        assert!(is_app_origin("https://tauri.localhost/index.html", false));
        assert!(is_app_origin("tauri://localhost", false));
        assert!(is_app_origin("HTTP://Tauri.Localhost:80/x", false));
    }

    #[test]
    fn dev_origin_only_in_dev() {
        assert!(is_app_origin("http://localhost:3000/", true));
        assert!(!is_app_origin("http://localhost:3000/", false));
        assert!(!is_app_origin("http://localhost:3001/", true));
        assert!(!is_app_origin("http://localhost/", true));
    }

    #[test]
    fn other_origins_are_left_alone() {
        assert!(!is_app_origin("https://example.com/", true));
        assert!(!is_app_origin("http://tauri.localhost.evil.com/", true));
        assert!(!is_app_origin("http://evil@tauri.localhost/", true));
        assert!(!is_app_origin("https://tauri.localhost:8443/", true));
        assert!(!is_app_origin("about:blank", true));
        assert!(!is_app_origin("", true));
    }

    #[test]
    fn dev_build_includes_dev_origin() {
        let origins = granted_origins();
        assert!(origins.contains(&"http://tauri.localhost"));
        assert_eq!(origins.contains(&DEV_ORIGIN), cfg!(debug_assertions));
    }
}
