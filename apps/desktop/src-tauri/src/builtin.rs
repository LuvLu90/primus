//! 内置模型配置与内置账号（临时方案，替代第 9 章的账号服务下发；登录与下发接入后删除本模块）。
//!
//! - 端点与模型清单在 `builtin/catalog.json`，格式与账号服务“客户端配置”接口（第 9.2 节）相同，
//!   由 `core_config` 按同一套规则校验后写入 Core 的 `models.json`。
//! - 访问令牌只有下面一个常量：首次启动（以及常量变化后的启动）写入 DPAPI 保险库（`vault`），
//!   `models.json` 里只放取令牌命令，不含明文。CI 的真实模型冒烟（`scripts/builtin-models.mjs`）也从这里读取。

/// 内置模型网关的访问令牌。
///
/// 临时内置，后续改为账号服务下发。更换令牌只改这一行：下次启动时薄壳发现与保险库中的值不同，会自动重写保险库。
pub(crate) const BUILTIN_API_KEY: &str = "sk-bb4055656ec644379b3571c8be0dc74e";

/// 内置客户端配置（第 9.2 节的下发格式）。
pub(crate) const BUILTIN_CATALOG: &str = include_str!("../builtin/catalog.json");

/// 内置账号的展示名；`auth_status` 直接返回它为已登录。
pub(crate) const BUILTIN_ACCOUNT_NAME: &str = "内置测试账号";

/// 内置账号的标识（不是秘密，只用于界面与日志区分）。
pub(crate) const BUILTIN_ACCOUNT_ID: &str = "builtin";
