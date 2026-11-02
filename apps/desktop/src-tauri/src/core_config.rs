//! Core 配置生成（技术方案第 9.2 节）：校验客户端配置，写 Core 的 `models.json` 与 `settings.json` 默认模型。
//!
//! - 客户端配置的格式就是账号服务“客户端配置”接口的下发格式（`version` / `providers` / `defaults`）。
//!   当前来源是内置配置（`builtin` 模块，临时方案）；接入账号服务后只换来源，校验与写入不变。
//! - 校验（约束 C1）：`api` 只允许 `openai-responses` / `anthropic-messages`，`baseUrl` 必须是 HTTPS，
//!   配置中不得出现 `apiKey`；任一项不合格整份拒绝。
//! - 写入：每个供应商的 `apiKey` 统一写成取令牌命令 `!"<Primus.exe>" --secret model-token`（第 9.4 节），
//!   `models.json` 不含明文令牌；内容不变时不重写文件。
//! - 默认模型写进 Core 的 `settings.json`（`defaultProvider` / `defaultModel`），其余设置项原样保留；
//!   用户在设置页改选的默认模型只要仍在列表中就不覆盖。变化只影响新拉起的 Core 进程。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::{Map, Value};

use crate::vault::{MODEL_TOKEN_ID, Vault};

/// 允许的两种协议（约束 C1）。
pub(crate) const ALLOWED_APIS: [&str; 2] = ["openai-responses", "anthropic-messages"];

const MODELS_FILE: &str = "models.json";
const SETTINGS_FILE: &str = "settings.json";

/// 配置不合格的原因（界面与日志用）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InvalidConfig(pub(crate) String);

impl std::fmt::Display for InvalidConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "模型配置无效：{}", self.0)
    }
}

fn bad(message: impl Into<String>) -> InvalidConfig {
    InvalidConfig(message.into())
}

/// 供应商 ID：小写字母、数字、`-`，以字母开头（会作为 `provider/model` 的前缀出现在设置与命令行中）。
fn is_valid_provider_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 一个模型的界面摘要（`models_get` 返回给前端，第 9.5 节下拉框显示的字段）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSummary {
    /// `provider/modelId`
    pub(crate) key: String,
    pub(crate) provider: String,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) api: String,
    pub(crate) reasoning: bool,
    pub(crate) image: bool,
    pub(crate) context_window: u64,
    pub(crate) max_tokens: u64,
}

/// 通过校验的客户端配置。
#[derive(Debug, Clone)]
pub(crate) struct ClientConfig {
    pub(crate) version: u64,
    /// 供应商对象，原样写入 `models.json`（只补 `apiKey`）
    providers: Map<String, Value>,
    pub(crate) models: Vec<ModelSummary>,
    pub(crate) default_model: String,
    pub(crate) compaction_model: String,
    pub(crate) title_model: String,
}

impl ClientConfig {
    /// 解析并校验下发格式的 JSON；不合格时整份拒绝。
    pub(crate) fn parse(text: &str) -> Result<Self, InvalidConfig> {
        let root: Value =
            serde_json::from_str(text).map_err(|e| bad(format!("JSON 解析失败：{e}")))?;
        let root = root.as_object().ok_or_else(|| bad("顶层必须是对象"))?;
        let version = root
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("缺少 version"))?;
        let providers = root
            .get("providers")
            .and_then(Value::as_object)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| bad("providers 不能为空"))?;

        let mut models = Vec::new();
        for (pid, provider) in providers {
            if !is_valid_provider_id(pid) {
                return Err(bad(format!("供应商 ID {pid:?} 无效")));
            }
            let provider = provider
                .as_object()
                .ok_or_else(|| bad(format!("{pid} 必须是对象")))?;
            if provider.contains_key("apiKey") {
                return Err(bad(format!("{pid} 含 apiKey，配置中不得出现令牌")));
            }
            let base_url = provider
                .get("baseUrl")
                .and_then(Value::as_str)
                .ok_or_else(|| bad(format!("{pid} 缺少 baseUrl")))?;
            check_https(pid, base_url)?;
            let provider_api = provider.get("api").and_then(Value::as_str);
            if let Some(api) = provider_api {
                check_api(pid, api)?;
            }
            let list = provider
                .get("models")
                .and_then(Value::as_array)
                .filter(|m| !m.is_empty())
                .ok_or_else(|| bad(format!("{pid} 的 models 不能为空")))?;
            let name = |m: &Map<String, Value>, key: &str| {
                m.get(key).and_then(Value::as_str).map(str::to_owned)
            };
            for model in list {
                let model = model
                    .as_object()
                    .ok_or_else(|| bad(format!("{pid} 的模型必须是对象")))?;
                let id = name(model, "id")
                    .filter(|id| !id.is_empty() && !id.contains(['/', '\0']))
                    .ok_or_else(|| bad(format!("{pid} 有模型缺少有效 id")))?;
                if model.contains_key("apiKey") {
                    return Err(bad(format!("{pid}/{id} 含 apiKey")));
                }
                let api = match model.get("api") {
                    Some(v) => v
                        .as_str()
                        .ok_or_else(|| bad(format!("{pid}/{id} 的 api 无效")))?,
                    None => provider_api.ok_or_else(|| bad(format!("{pid}/{id} 缺少 api")))?,
                };
                check_api(&format!("{pid}/{id}"), api)?;
                if let Some(url) = model.get("baseUrl") {
                    let url = url
                        .as_str()
                        .ok_or_else(|| bad(format!("{pid}/{id} 的 baseUrl 无效")))?;
                    check_https(&format!("{pid}/{id}"), url)?;
                }
                let number = |key: &str, default: u64| -> Result<u64, InvalidConfig> {
                    match model.get(key) {
                        None => Ok(default),
                        Some(v) => v
                            .as_u64()
                            .filter(|n| *n > 0)
                            .ok_or_else(|| bad(format!("{pid}/{id} 的 {key} 必须是正整数"))),
                    }
                };
                let reasoning = match model.get("reasoning") {
                    None => false,
                    Some(v) => v
                        .as_bool()
                        .ok_or_else(|| bad(format!("{pid}/{id} 的 reasoning 必须是布尔值")))?,
                };
                let image = match model.get("input") {
                    None => false,
                    Some(v) => {
                        let input = v
                            .as_array()
                            .ok_or_else(|| bad(format!("{pid}/{id} 的 input 必须是数组")))?;
                        if !input
                            .iter()
                            .all(|i| matches!(i.as_str(), Some("text" | "image")))
                        {
                            return Err(bad(format!("{pid}/{id} 的 input 只能含 text / image")));
                        }
                        input.iter().any(|i| i == "image")
                    }
                };
                let context_window = number("contextWindow", 128_000)?;
                let max_tokens = number("maxTokens", 16_384)?;
                let key = format!("{pid}/{id}");
                if models.iter().any(|m: &ModelSummary| m.key == key) {
                    return Err(bad(format!("{key} 重复")));
                }
                models.push(ModelSummary {
                    name: name(model, "name").unwrap_or_else(|| id.clone()),
                    key,
                    provider: pid.clone(),
                    id,
                    api: api.to_owned(),
                    reasoning,
                    image,
                    context_window,
                    max_tokens,
                });
            }
        }

        let defaults = root.get("defaults").and_then(Value::as_object);
        let pick = |key: &str, fallback: Option<&str>| -> Result<String, InvalidConfig> {
            let value = defaults
                .and_then(|d| d.get(key))
                .and_then(Value::as_str)
                .or(fallback)
                .unwrap_or(&models[0].key)
                .to_owned();
            if models.iter().any(|m| m.key == value) {
                Ok(value)
            } else {
                Err(bad(format!("defaults.{key} 指向不存在的模型 {value}")))
            }
        };
        let default_model = pick("model", None)?;
        let compaction_model = pick("compactionModel", Some(&default_model))?;
        let title_model = pick("titleModel", Some(&compaction_model))?;
        Ok(Self {
            version,
            providers: providers.clone(),
            models,
            default_model,
            compaction_model,
            title_model,
        })
    }

    /// 生成 Core 的 `models.json` 内容：各供应商补上取令牌命令。
    pub(crate) fn models_json(&self, secret_command: &str) -> String {
        let mut providers = self.providers.clone();
        for provider in providers.values_mut() {
            if let Some(p) = provider.as_object_mut() {
                p.insert("apiKey".into(), Value::String(secret_command.to_owned()));
            }
        }
        let mut root = Map::new();
        root.insert("providers".into(), Value::Object(providers));
        let mut text = serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_default();
        text.push('\n');
        text
    }

    pub(crate) fn has_model(&self, key: &str) -> bool {
        self.models.iter().any(|m| m.key == key)
    }
}

fn check_api(owner: &str, api: &str) -> Result<(), InvalidConfig> {
    if ALLOWED_APIS.contains(&api) {
        Ok(())
    } else {
        Err(bad(format!(
            "{owner} 的协议 {api:?} 不受支持（只允许 openai-responses / anthropic-messages）"
        )))
    }
}

fn check_https(owner: &str, url: &str) -> Result<(), InvalidConfig> {
    let rest = url.strip_prefix("https://").unwrap_or_default();
    if rest.is_empty() || rest.starts_with('/') || url.chars().any(char::is_whitespace) {
        return Err(bad(format!("{owner} 的 baseUrl 必须是 HTTPS 地址")));
    }
    Ok(())
}

/// `models.json` 中的取令牌命令：`!"<Primus.exe>" --secret model-token`。
///
/// Core 在 Windows 上用 Git Bash（没有时用 cmd）执行它，路径放在双引号里；为保证两种 shell 下都按字面解释，
/// 拒绝含 `"`、`$`、`` ` ``、`%`、`!` 或换行的路径。
pub(crate) fn secret_command(exe: &Path) -> io::Result<String> {
    let path = exe
        .to_str()
        .ok_or_else(|| io::Error::other("Primus.exe 路径不是有效的 Unicode"))?;
    if path.contains(['"', '$', '`', '%', '!', '\n', '\r']) {
        return Err(io::Error::other(
            "Primus.exe 所在路径含有 \" $ ` % ! 等字符，无法安全地写入取令牌命令，请安装到其他目录",
        ));
    }
    Ok(format!(
        "!\"{path}\" {} {MODEL_TOKEN_ID}",
        crate::vault::SECRET_ARG
    ))
}

/// 内容不同才写：先写临时文件再替换。返回是否写入。
fn write_if_changed(file: &Path, text: &str) -> io::Result<bool> {
    if fs::read_to_string(file).is_ok_and(|current| current == text) {
        return Ok(false);
    }
    let dir = file
        .parent()
        .ok_or_else(|| io::Error::other("配置路径无效"))?;
    fs::create_dir_all(dir)?;
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
    let result = fs::write(&tmp, text).and_then(|()| fs::rename(&tmp, file));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map(|()| true)
}

/// 读取 Core 的 `settings.json`；不存在或不是对象时返回空对象（解析失败的旧文件备份为 `.bak` 后重建）。
fn read_settings(core_dir: &Path) -> Map<String, Value> {
    let file = core_dir.join(SETTINGS_FILE);
    let Ok(text) = fs::read_to_string(&file) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        _ => {
            let _ = fs::copy(&file, core_dir.join(format!("{SETTINGS_FILE}.bak")));
            Map::new()
        }
    }
}

fn write_settings(core_dir: &Path, settings: &Map<String, Value>) -> io::Result<bool> {
    let mut text =
        serde_json::to_string_pretty(&Value::Object(settings.clone())).map_err(io::Error::other)?;
    text.push('\n');
    write_if_changed(&core_dir.join(SETTINGS_FILE), &text)
}

/// 当前 `settings.json` 中的默认模型（`provider/modelId`）。
pub(crate) fn current_default(core_dir: &Path) -> Option<String> {
    let settings = read_settings(core_dir);
    let provider = settings.get("defaultProvider")?.as_str()?;
    let model = settings.get("defaultModel")?.as_str()?;
    Some(format!("{provider}/{model}"))
}

/// 把默认模型写进 `settings.json`，保留其他设置项。
pub(crate) fn set_default(core_dir: &Path, key: &str) -> io::Result<()> {
    let (provider, model) = key
        .split_once('/')
        .ok_or_else(|| io::Error::other("模型标识应为 provider/modelId"))?;
    let mut settings = read_settings(core_dir);
    settings.insert("defaultProvider".into(), Value::String(provider.to_owned()));
    settings.insert("defaultModel".into(), Value::String(model.to_owned()));
    write_settings(core_dir, &settings).map(|_| ())
}

/// 应用一份客户端配置：写令牌、`models.json`，默认模型不在列表中时改为下发的默认值。
pub(crate) fn apply(
    config: &ClientConfig,
    core_dir: &Path,
    vault: &Vault,
    token: &str,
    exe: &Path,
) -> io::Result<()> {
    vault.ensure(MODEL_TOKEN_ID, token)?;
    let command = secret_command(exe)?;
    write_if_changed(&core_dir.join(MODELS_FILE), &config.models_json(&command))?;
    let keep = current_default(core_dir).is_some_and(|key| config.has_model(&key));
    if !keep {
        set_default(core_dir, &config.default_model)?;
    }
    Ok(())
}

/// 模型配置的运行时状态（`models_get` / `models_refresh` / `models_set_default` 共用）。
pub(crate) struct ModelConfigState {
    core_dir: PathBuf,
    vault_dir: PathBuf,
    inner: Mutex<Applied>,
}

struct Applied {
    config: Option<ClientConfig>,
    error: Option<String>,
}

/// `models_get` 的返回值。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelsInfo {
    pub(crate) version: Option<u64>,
    pub(crate) models: Vec<ModelSummary>,
    /// 当前默认模型（用户改选的或下发的默认值）
    pub(crate) default_model: Option<String>,
    pub(crate) compaction_model: Option<String>,
    pub(crate) title_model: Option<String>,
    /// 配置未能生效的原因；为 null 表示可以对话
    pub(crate) error: Option<String>,
}

impl ModelConfigState {
    pub(crate) fn new(core_dir: PathBuf, vault_dir: PathBuf) -> Self {
        Self {
            core_dir,
            vault_dir,
            inner: Mutex::new(Applied {
                config: None,
                error: None,
            }),
        }
    }

    /// 解析并应用内置配置（启动时与 `models_refresh` 调用）。失败时记录原因，不影响 App 启动。
    pub(crate) fn refresh(&self) -> ModelsInfo {
        let result = ClientConfig::parse(crate::builtin::BUILTIN_CATALOG)
            .map_err(|e| e.to_string())
            .and_then(|config| {
                let exe =
                    std::env::current_exe().map_err(|e| format!("无法定位 Primus.exe：{e}"))?;
                apply(
                    &config,
                    &self.core_dir,
                    &Vault::new(&self.vault_dir),
                    crate::builtin::BUILTIN_API_KEY,
                    &exe,
                )
                .map_err(|e| format!("写入模型配置失败：{e}"))?;
                Ok(config)
            });
        {
            let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            match result {
                Ok(config) => {
                    inner.config = Some(config);
                    inner.error = None;
                }
                Err(message) => {
                    eprintln!("[core_config] {message}");
                    inner.error = Some(message);
                }
            }
        }
        self.info()
    }

    pub(crate) fn info(&self) -> ModelsInfo {
        let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let config = inner.config.as_ref();
        ModelsInfo {
            version: config.map(|c| c.version),
            models: config.map(|c| c.models.clone()).unwrap_or_default(),
            default_model: config.and_then(|c| {
                current_default(&self.core_dir)
                    .filter(|key| c.has_model(key))
                    .or_else(|| Some(c.default_model.clone()))
            }),
            compaction_model: config.map(|c| c.compaction_model.clone()),
            title_model: config.map(|c| c.title_model.clone()),
            error: inner.error.clone(),
        }
    }

    /// 设置页改选默认模型：只能选列表中的模型。新拉起的 Core 进程生效。
    pub(crate) fn set_default(&self, key: &str) -> Result<ModelsInfo, String> {
        {
            let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
            let config = inner.config.as_ref().ok_or("模型配置尚未就绪")?;
            if !config.has_model(key) {
                return Err(format!("模型 {key} 不在可用列表中"));
            }
            set_default(&self.core_dir, key).map_err(|e| format!("保存默认模型失败：{e}"))?;
        }
        Ok(self.info())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("primus-core-config-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn sample() -> Value {
        serde_json::json!({
            "version": 3,
            "providers": {
                "gw-messages": {
                    "name": "M", "baseUrl": "https://gw.example:8318", "api": "anthropic-messages",
                    "models": [
                        { "id": "big", "name": "Big", "reasoning": true, "input": ["text", "image"],
                          "contextWindow": 1000000, "maxTokens": 128000, "compat": { "forceAdaptiveThinking": true } },
                        { "id": "small" }
                    ]
                },
                "gw-responses": {
                    "baseUrl": "https://gw.example:8318/v1", "api": "openai-responses",
                    "models": [{ "id": "fast-1.5", "input": ["text"] }]
                }
            },
            "defaults": { "model": "gw-messages/big", "compactionModel": "gw-responses/fast-1.5" }
        })
    }

    type Mutation = Box<dyn Fn(&mut Value)>;

    fn parse(v: &Value) -> Result<ClientConfig, InvalidConfig> {
        ClientConfig::parse(&v.to_string())
    }

    #[test]
    fn builtin_catalog_is_valid_and_uses_both_protocols() {
        let config =
            ClientConfig::parse(crate::builtin::BUILTIN_CATALOG).expect("内置配置必须通过校验");
        for api in ALLOWED_APIS {
            assert!(
                config.models.iter().any(|m| m.api == api),
                "内置配置应包含 {api} 模型"
            );
        }
        assert!(config.has_model(&config.default_model));
        assert!(!crate::builtin::BUILTIN_CATALOG.contains(crate::builtin::BUILTIN_API_KEY));
    }

    #[test]
    fn parses_summaries_and_defaults() {
        let config = parse(&sample()).unwrap();
        assert_eq!(config.version, 3);
        let keys: Vec<_> = config.models.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "gw-messages/big",
                "gw-messages/small",
                "gw-responses/fast-1.5"
            ]
        );
        let big = &config.models[0];
        assert!(big.reasoning && big.image);
        assert_eq!((big.context_window, big.max_tokens), (1_000_000, 128_000));
        let small = &config.models[1];
        assert_eq!(small.name, "small");
        assert_eq!(small.api, "anthropic-messages");
        assert_eq!((small.context_window, small.max_tokens), (128_000, 16_384));
        assert_eq!(config.default_model, "gw-messages/big");
        assert_eq!(config.compaction_model, "gw-responses/fast-1.5");
        assert_eq!(
            config.title_model, "gw-responses/fast-1.5",
            "标题模型缺省取压缩模型"
        );
    }

    #[test]
    fn rejects_whole_config_on_any_violation() {
        let cases: Vec<(&str, Mutation)> = vec![
            (
                "其他协议",
                Box::new(|v| v["providers"]["gw-responses"]["api"] = "openai-completions".into()),
            ),
            (
                "模型级其他协议",
                Box::new(|v| {
                    v["providers"]["gw-messages"]["models"][1]["api"] =
                        "google-generative-ai".into()
                }),
            ),
            (
                "HTTP",
                Box::new(|v| {
                    v["providers"]["gw-messages"]["baseUrl"] = "http://gw.example:8318".into()
                }),
            ),
            (
                "空主机",
                Box::new(|v| v["providers"]["gw-messages"]["baseUrl"] = "https://".into()),
            ),
            (
                "模型级 HTTP",
                Box::new(|v| {
                    v["providers"]["gw-messages"]["models"][0]["baseUrl"] = "http://x".into()
                }),
            ),
            (
                "供应商 apiKey",
                Box::new(|v| v["providers"]["gw-messages"]["apiKey"] = "k".into()),
            ),
            (
                "模型 apiKey",
                Box::new(|v| v["providers"]["gw-messages"]["models"][0]["apiKey"] = "k".into()),
            ),
            (
                "缺协议",
                Box::new(|v| {
                    v["providers"]["gw-responses"]
                        .as_object_mut()
                        .unwrap()
                        .remove("api");
                }),
            ),
            (
                "空模型",
                Box::new(|v| v["providers"]["gw-messages"]["models"] = serde_json::json!([])),
            ),
            (
                "坏 id",
                Box::new(|v| v["providers"]["gw-messages"]["models"][0]["id"] = "a/b".into()),
            ),
            (
                "坏供应商 id",
                Box::new(|v| {
                    let p = v["providers"]["gw-messages"].take();
                    v["providers"]["Bad Id"] = p;
                }),
            ),
            (
                "默认模型不存在",
                Box::new(|v| v["defaults"]["model"] = "gw-messages/none".into()),
            ),
            (
                "坏 input",
                Box::new(|v| {
                    v["providers"]["gw-messages"]["models"][0]["input"] =
                        serde_json::json!(["audio"])
                }),
            ),
            (
                "坏数字",
                Box::new(|v| v["providers"]["gw-messages"]["models"][0]["maxTokens"] = 0.into()),
            ),
            (
                "缺 version",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("version");
                }),
            ),
        ];
        for (name, mutate) in cases {
            let mut v = sample();
            mutate(&mut v);
            assert!(parse(&v).is_err(), "{name} 应被拒绝");
        }
    }

    #[test]
    fn models_json_adds_secret_command_and_keeps_fields() {
        let config = parse(&sample()).unwrap();
        let text = config.models_json("!cmd --secret model-token");
        let v: Value = serde_json::from_str(&text).unwrap();
        for p in ["gw-messages", "gw-responses"] {
            assert_eq!(v["providers"][p]["apiKey"], "!cmd --secret model-token");
        }
        assert_eq!(
            v["providers"]["gw-messages"]["models"][0]["compat"]["forceAdaptiveThinking"],
            true
        );
        assert!(v.get("defaults").is_none() && v.get("version").is_none());
    }

    #[test]
    fn secret_command_quotes_path_and_rejects_shell_metacharacters() {
        let cmd = secret_command(Path::new(r"C:\Program Files\乾元 Primus\Primus.exe")).unwrap();
        assert_eq!(
            cmd,
            r#"!"C:\Program Files\乾元 Primus\Primus.exe" --secret model-token"#
        );
        for bad in [
            r#"C:\a"b\P.exe"#,
            r"C:\$x\P.exe",
            r"C:\%x%\P.exe",
            r"C:\a!b\P.exe",
            "C:\\a`b\\P.exe",
        ] {
            assert!(secret_command(Path::new(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn apply_writes_files_and_respects_user_default() {
        let root = temp_dir("apply");
        let core = root.join("core");
        let vault = Vault::new(&root.join("vault"));
        let exe = Path::new("/opt/primus/Primus");
        let config = parse(&sample()).unwrap();
        fs::create_dir_all(&core).unwrap();
        fs::write(
            core.join(SETTINGS_FILE),
            r#"{"theme":"dark","defaultProvider":"old","defaultModel":"x"}"#,
        )
        .unwrap();

        apply(&config, &core, &vault, "tok-1", exe).unwrap();
        let models = fs::read_to_string(core.join(MODELS_FILE)).unwrap();
        assert!(!models.contains("tok-1"), "models.json 不含明文令牌");
        assert!(models.contains("--secret model-token"));
        assert_eq!(vault.get(MODEL_TOKEN_ID).unwrap().as_deref(), Some("tok-1"));
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(core.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(settings["theme"], "dark", "保留其他设置");
        assert_eq!(
            current_default(&core).as_deref(),
            Some("gw-messages/big"),
            "无效默认值被替换"
        );

        // 用户改选的默认模型仍在列表中：重新应用不覆盖
        set_default(&core, "gw-responses/fast-1.5").unwrap();
        apply(&config, &core, &vault, "tok-2", exe).unwrap();
        assert_eq!(
            current_default(&core).as_deref(),
            Some("gw-responses/fast-1.5")
        );
        assert_eq!(
            vault.get(MODEL_TOKEN_ID).unwrap().as_deref(),
            Some("tok-2"),
            "令牌变化时重写"
        );

        // 内容不变时不重写 models.json
        let before = fs::metadata(core.join(MODELS_FILE))
            .unwrap()
            .modified()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        apply(&config, &core, &vault, "tok-2", exe).unwrap();
        assert_eq!(
            fs::metadata(core.join(MODELS_FILE))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_settings_are_backed_up_and_rebuilt() {
        let core = temp_dir("settings");
        fs::create_dir_all(&core).unwrap();
        fs::write(core.join(SETTINGS_FILE), "{not json").unwrap();
        assert_eq!(current_default(&core), None);
        set_default(&core, "a/b").unwrap();
        assert_eq!(current_default(&core).as_deref(), Some("a/b"));
        assert!(core.join("settings.json.bak").exists());
        assert!(set_default(&core, "no-slash").is_err());
        let _ = fs::remove_dir_all(&core);
    }

    #[test]
    fn state_reports_errors_and_validates_default_choice() {
        let root = temp_dir("state");
        let state = ModelConfigState::new(root.join("core"), root.join("vault"));
        assert!(
            state
                .set_default("primus-messages/claude-opus-5-5-high")
                .is_err(),
            "未就绪时拒绝"
        );
        let info = state.refresh();
        // 测试中 current_exe 是测试二进制；加解密在非 Windows 上用测试替身，因此应当成功
        assert_eq!(info.error, None, "{:?}", info.error);
        assert!(info.models.len() >= 2);
        let other = info
            .models
            .iter()
            .find(|m| Some(&m.key) != info.default_model.as_ref())
            .unwrap()
            .key
            .clone();
        assert_eq!(
            state.set_default(&other).unwrap().default_model.as_deref(),
            Some(other.as_str())
        );
        assert!(state.set_default("nope/model").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
