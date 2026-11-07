//! 已知模型的能力（技术方案第 9.2 节）：获取模型列表时，接口没给出的上下文长度、最大输出、图片输入与思考从这里补。
//!
//! - 能力表 `model_capabilities.json` 由 `scripts/generate-model-capabilities.mjs` 从 Core 锁定的模型目录
//!   （`agent-core/nix/model-catalog.json` 的修订版）生成后提交，编译时嵌入；`--check` 核对与锁定目录一致。
//! - 匹配顺序：规范化 ID 精确匹配（小写，去掉 `厂商/` 前缀与 `:变体`，`.` `_` 换成 `-`）→ 逐个去掉末尾的
//!   推理强度 / 变体 / 日期后缀（`-high`、`-thinking`、`-latest`、`-20251001` 等）再查 → 按模型系列的规则推断
//!   （claude、gpt-5 / o 系列、gpt-4.1 / 4o、gemini 2.5 以后、deepseek 推理模型、glm 4.5 以后）。都不匹配时返回 None，
//!   由调用方用默认参数。

use std::collections::HashMap;
use std::sync::OnceLock;

/// 一个模型的能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Capabilities {
    pub(crate) context_window: u64,
    pub(crate) max_tokens: u64,
    pub(crate) image: bool,
    pub(crate) reasoning: bool,
}

const TABLE_JSON: &str = include_str!("model_capabilities.json");

/// 能力表：规范化 ID → 能力。表损坏时为空（只靠系列规则），由单测保证不会发生。
fn table() -> &'static HashMap<String, Capabilities> {
    static TABLE: OnceLock<HashMap<String, Capabilities>> = OnceLock::new();
    TABLE.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct File {
            models: HashMap<String, [u64; 4]>,
        }
        serde_json::from_str::<File>(TABLE_JSON)
            .map(|f| {
                f.models
                    .into_iter()
                    .map(|(k, [context_window, max_tokens, image, reasoning])| {
                        (
                            k,
                            Capabilities {
                                context_window,
                                max_tokens,
                                image: image != 0,
                                reasoning: reasoning != 0,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// 规范化模型 ID（与生成脚本的 normalizeModelId 一致）。
pub(crate) fn normalize_model_id(id: &str) -> String {
    let s = id.trim().to_lowercase();
    let s = s.strip_prefix('~').unwrap_or(&s);
    let s = s.rsplit('/').next().unwrap_or(s);
    let s = s.split(':').next().unwrap_or(s);
    s.replace(['.', '_'], "-")
}

/// 可去掉的末尾后缀：推理强度、思考开关、别名与渠道变体。
const VARIANT_SUFFIXES: &[&str] = &[
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
    "max",
    "none",
    "thinking",
    "nothinking",
    "no-thinking",
    "non-thinking",
    "latest",
    "preview",
    "exp",
    "batch",
    "fast",
];

/// 去掉一个末尾后缀（变体或日期 `-20251001` / `-2025-10-01` / `-0514` / `-250514`）；没有可去的返回 None。
fn strip_suffix(key: &str) -> Option<String> {
    for suffix in VARIANT_SUFFIXES {
        if let Some(rest) = key.strip_suffix(suffix).and_then(|r| r.strip_suffix('-'))
            && !rest.is_empty()
        {
            return Some(rest.to_owned());
        }
    }
    // 连字符分隔的日期：YYYY-MM-DD
    let parts: Vec<&str> = key.rsplitn(4, '-').collect();
    if parts.len() == 4
        && [2, 2, 4] == [parts[0].len(), parts[1].len(), parts[2].len()]
        && parts[..3]
            .iter()
            .all(|p| p.bytes().all(|b| b.is_ascii_digit()))
        && parts[2].starts_with("20")
    {
        return Some(parts[3].to_owned());
    }
    let (rest, last) = key.rsplit_once('-')?;
    let is_date = matches!(last.len(), 4 | 6 | 8) && last.bytes().all(|b| b.is_ascii_digit());
    (is_date && !rest.is_empty()).then(|| rest.to_owned())
}

/// 按模型系列推断（能力表里没有的新版本或网关自定的别名）。`key` 已规范化并去掉后缀。
fn family(key: &str) -> Option<Capabilities> {
    let caps = |context_window, max_tokens, image, reasoning| {
        Some(Capabilities {
            context_window,
            max_tokens,
            image,
            reasoning,
        })
    };
    let starts = |p: &str| key.starts_with(p);
    if starts("claude-") {
        // Claude 3 系列（3.7 除外）不支持思考
        if starts("claude-3-") && !starts("claude-3-7") {
            return caps(200_000, 8_192, true, false);
        }
        let max_tokens = if key.contains("opus-4-1") || key.ends_with("opus-4") {
            32_000
        } else {
            64_000
        };
        return caps(200_000, max_tokens, true, true);
    }
    if starts("gpt-5") {
        return caps(400_000, 128_000, true, true);
    }
    let o_series = key.len() >= 2
        && key.starts_with('o')
        && key.as_bytes()[1].is_ascii_digit()
        && key[1..].split('-').next().is_some_and(|n| n.len() == 1);
    if o_series {
        return caps(200_000, 100_000, true, true);
    }
    if starts("gpt-4-1") {
        return caps(1_047_576, 32_768, true, false);
    }
    if starts("gpt-4o") {
        return caps(128_000, 16_384, true, false);
    }
    if starts("gemini-2-5") || starts("gemini-3") || starts("gemini-4") {
        return caps(1_048_576, 65_536, true, true);
    }
    if starts("deepseek-r1") || starts("deepseek-reasoner") {
        return caps(128_000, 32_000, false, true);
    }
    if ["glm-4-5", "glm-4-6", "glm-4-7", "glm-5"]
        .iter()
        .any(|p| starts(p))
    {
        return caps(200_000, 131_072, false, true);
    }
    None
}

/// 查一个模型 ID 的已知能力；不认识时返回 None。
pub(crate) fn lookup(id: &str) -> Option<Capabilities> {
    let table = table();
    let mut key = normalize_model_id(id);
    loop {
        if let Some(caps) = table.get(&key) {
            return Some(*caps);
        }
        match strip_suffix(&key) {
            Some(shorter) => key = shorter,
            None => break,
        }
    }
    family(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_embedded_and_matches_its_format() {
        let table = table();
        assert!(table.len() > 100, "能力表应已生成并嵌入");
        for (key, caps) in table {
            assert_eq!(&normalize_model_id(key), key, "键应已规范化：{key}");
            assert!(caps.context_window > 0 && caps.max_tokens > 0, "{key}");
            assert!(caps.max_tokens <= caps.context_window, "{key}");
        }
        // 与 Core 锁定的模型目录同步由 scripts/generate-model-capabilities.test.ts 检查
        let file: serde_json::Value = serde_json::from_str(TABLE_JSON).unwrap();
        assert!(
            file["revision"]
                .as_str()
                .is_some_and(|r| r.starts_with("sha256-"))
        );
    }

    #[test]
    fn normalizes_ids() {
        assert_eq!(
            normalize_model_id(" Anthropic/Claude-Opus-4.5 "),
            "claude-opus-4-5"
        );
        assert_eq!(normalize_model_id("~openai/gpt_5.5:batch"), "gpt-5-5");
        assert_eq!(normalize_model_id("gemini-3-pro"), "gemini-3-pro");
    }

    #[test]
    fn strips_effort_variant_and_date_suffixes() {
        assert_eq!(
            strip_suffix("claude-opus-5-5-high").as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(strip_suffix("gpt-5-5-xhigh").as_deref(), Some("gpt-5-5"));
        assert_eq!(strip_suffix("x-thinking").as_deref(), Some("x"));
        assert_eq!(
            strip_suffix("claude-haiku-4-5-20251001").as_deref(),
            Some("claude-haiku-4-5")
        );
        assert_eq!(strip_suffix("m-2025-10-01").as_deref(), Some("m"));
        assert_eq!(strip_suffix("gpt-4o-0513").as_deref(), Some("gpt-4o"));
        assert_eq!(strip_suffix("gpt-5-5"), None);
        assert_eq!(strip_suffix("high"), None);
        assert_eq!(strip_suffix("qwen3-coder"), None);
    }

    #[test]
    fn looks_up_catalog_then_family_then_nothing() {
        // 网关的推理强度变体：去掉 -high 后命中能力表
        let opus = lookup("claude-opus-5-5-high").unwrap();
        assert_eq!(opus, table()["claude-opus-5-5"]);
        assert!(opus.image && opus.reasoning);
        let gpt = lookup("gpt-5.5").unwrap();
        assert_eq!(gpt, table()["gpt-5-5"]);
        assert!(gpt.image && gpt.reasoning);
        assert_eq!(lookup("openai/GPT-5.5-high"), Some(gpt));
        // 能力表里没有的版本：按系列推断
        assert!(!table().contains_key("gemini-3-pro"));
        assert_eq!(
            lookup("gemini-3-pro"),
            Some(Capabilities {
                context_window: 1_048_576,
                max_tokens: 65_536,
                image: true,
                reasoning: true
            })
        );
        assert_eq!(
            lookup("claude-sonnet-9-thinking").map(|c| (c.context_window, c.reasoning)),
            Some((200_000, true))
        );
        assert_eq!(
            lookup("claude-3-5-sonnet-20241022").map(|c| c.reasoning),
            Some(false)
        );
        assert_eq!(lookup("o4-mini-high").map(|c| c.reasoning), Some(true));
        assert_eq!(lookup("omni-1"), None);
        // 不认识的模型
        assert_eq!(lookup("my-private-model-v2"), None);
        assert_eq!(lookup("auto"), None);
    }
}
