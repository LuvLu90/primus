//! 内置渠道（种子）：首次启动（`providers.json` 还不存在）时写入一个预置渠道与其密钥，之后完全由用户管理。
//!
//! - 只在渠道文件不存在时写一次：用户删除或修改它之后不会再被加回或覆盖。
//! - 密钥只有下面一个常量：种子写入时存进 DPAPI 保险库（`provider:ioply`），`models.json` 里只放取密钥命令。
//! - 模型清单起初为空，启动后在后台按该渠道的模型列表接口获取一次（`lib.rs`）；失败时留空，由设置页提示用户获取。

use crate::providers::{Api, Provider};

/// 内置渠道 ID（也是名称）。
pub(crate) const SEED_PROVIDER_ID: &str = "ioply";

/// 内置渠道协议。
const SEED_API: Api = Api::OpenAiResponses;

/// 内置渠道接口地址。
const SEED_BASE_URL: &str = "http://218.93.48.244:3304/openai/v1";

/// 内置渠道密钥，用户要求直接写在源码中，后续会更换。
pub(crate) const BUILTIN_API_KEY: &str = "sk-bb4055656ec644379b3571c8be0dc74e";

/// 旧版内置模型配置在保险库中的令牌 ID：启动时删除（迁移）。
pub(crate) const LEGACY_TOKEN_ID: &str = "model-token";

/// 内置渠道（模型清单为空，启动后获取）。
pub(crate) fn seed_provider() -> Provider {
    Provider {
        id: SEED_PROVIDER_ID.to_owned(),
        name: SEED_PROVIDER_ID.to_owned(),
        api: SEED_API,
        base_url: SEED_BASE_URL.to_owned(),
        enabled: true,
        models: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_provider_is_valid() {
        let p = seed_provider();
        crate::providers::check_provider(&p).unwrap();
        assert!(p.models.is_empty() && p.enabled);
        assert!(!serde_json::to_string(&p).unwrap().contains(BUILTIN_API_KEY));
    }
}
