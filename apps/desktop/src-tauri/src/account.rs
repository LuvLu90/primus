//! 账号（技术方案第 9.7 节）。
//!
//! 当前没有账号：模型由用户自己管理的渠道提供（`providers`），对话不需要登录。`auth_status` 返回未登录且不可登录；
//! 系统浏览器 + PKCE 登录、令牌刷新与登出放到接入账号服务时实现，接口形状保持不变，
//! 在此之前 `auth_login` / `auth_logout` 返回“未开放”。

/// 账号信息。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    /// 接入账号服务后为 `service`
    pub(crate) kind: &'static str,
}

/// `auth_status` 的返回值。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthStatus {
    pub(crate) logged_in: bool,
    pub(crate) account: Option<AccountInfo>,
    /// 是否可以发起登录 / 登出（账号服务接入前为 false，界面据此禁用按钮）
    pub(crate) login_available: bool,
}

/// 账号命令的错误：`code` 为 `notAvailable` 表示功能尚未开放。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct AuthError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

/// 尚未开放的错误码。
pub(crate) const NOT_AVAILABLE: &str = "notAvailable";

pub(crate) fn status() -> AuthStatus {
    AuthStatus {
        logged_in: false,
        account: None,
        login_available: false,
    }
}

fn not_available(action: &str) -> AuthError {
    AuthError {
        code: NOT_AVAILABLE,
        message: format!("账号{action}暂未开放"),
    }
}

pub(crate) fn login() -> Result<AuthStatus, AuthError> {
    Err(not_available("登录"))
}

pub(crate) fn logout() -> Result<(), AuthError> {
    Err(not_available("登出"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_out_and_login_is_not_available() {
        let s = status();
        assert!(!s.logged_in && !s.login_available && s.account.is_none());
        assert_eq!(login().unwrap_err().code, NOT_AVAILABLE);
        assert_eq!(logout().unwrap_err().code, NOT_AVAILABLE);
        let json = serde_json::to_value(status()).unwrap();
        assert_eq!(json["loggedIn"], false);
        assert_eq!(json["account"], serde_json::Value::Null);
        assert_eq!(json["loginAvailable"], false);
    }
}
