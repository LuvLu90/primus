//! 模型渠道（用户自管的供应商，技术方案第 9.2 节）：`users/<SID>/app/providers.json` 的读写、校验，与模型列表获取。
//!
//! - 文件格式：`{"version":1,"providers":[{id,name,api,baseUrl,enabled,models:[...]}]}`；只有两种协议（约束 C1）、
//!   `baseUrl` 必须是 HTTP(S) 地址，文件中不得出现 `apiKey`（结构体拒绝未知字段）。写入先写临时文件再替换。
//! - 密钥按渠道存进 DPAPI 保险库（`provider:<id>`），文件、日志、命令行与返回给 WebView 的数据里都没有明文，
//!   界面只拿到 `hasKey` 与 `keyHint`（末 4 位）。
//! - 模型列表获取（`provider_fetch_models`）：openai-responses 为 `GET {baseUrl}/models`（Bearer），
//!   anthropic-messages 为 `GET {baseUrl}/v1/models`（`x-api-key` + `anthropic-version`）。取 `data[].id`（可含 `/`）与名称，
//!   接口给出能力信息时一并识别（上下文长度、最大输出、图片输入、思考；字段见 [`parse_models_response`]），
//!   没给的用默认参数（文本输入、不支持思考、128000 / 32000）。

use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 渠道文件名（在 `users/<SID>/app/` 下）。
pub(crate) const PROVIDERS_FILE: &str = "providers.json";

/// 文件格式版本。
const VERSION: u32 = 1;

/// 保险库中渠道密钥名的前缀：`provider:<id>`。
pub(crate) const SECRET_PREFIX: &str = "provider:";

/// 渠道 ID 最长字符数（密钥名 `provider:<id>` 会出现在命令行里）。
const MAX_ID_LEN: usize = 48;

/// 获取模型列表的超时。
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// anthropic-messages 的版本头。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 获取到的新模型的默认参数。
const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
const DEFAULT_MAX_TOKENS: u64 = 32_000;

/// 两种协议（约束 C1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Api {
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

impl Api {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "openai-responses",
            Self::AnthropicMessages => "anthropic-messages",
        }
    }
}

/// 模型输入类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Input {
    Text,
    Image,
}

/// 渠道下的一个模型（也是 `provider_fetch_models` 的返回项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderModel {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) reasoning: bool,
    pub(crate) input: Vec<Input>,
    pub(crate) context_window: u64,
    pub(crate) max_tokens: u64,
}

impl ProviderModel {
    /// 新获取到的模型：每项能力按 接口给出的值 → 已知模型能力表（`model_catalog`）→ 默认参数 的顺序取。
    pub(crate) fn from_fetched(f: &FetchedModel) -> Self {
        let known = crate::model_catalog::lookup(&f.id);
        let mut m = Self::with_defaults(&f.id, f.display_name.as_deref());
        m.reasoning = f
            .reasoning
            .or(known.map(|k| k.reasoning))
            .unwrap_or(m.reasoning);
        if f.image.or(known.map(|k| k.image)).unwrap_or(false) {
            m.input = vec![Input::Text, Input::Image];
        }
        m.context_window = f
            .context_window
            .or(known.map(|k| k.context_window))
            .unwrap_or(m.context_window);
        m.max_tokens = f
            .max_tokens
            .or(known.map(|k| k.max_tokens))
            .unwrap_or(m.max_tokens);
        // 最大输出不超过上下文长度
        m.max_tokens = m.max_tokens.min(m.context_window);
        m
    }

    /// 新获取到的模型的默认参数。
    pub(crate) fn with_defaults(id: &str, name: Option<&str>) -> Self {
        Self {
            id: id.to_owned(),
            name: name
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(id)
                .to_owned(),
            reasoning: false,
            input: vec![Input::Text],
            context_window: DEFAULT_CONTEXT_WINDOW,
            max_tokens: DEFAULT_MAX_TOKENS,
        }
    }

    pub(crate) fn image(&self) -> bool {
        self.input.contains(&Input::Image)
    }

    /// 能力仍是默认参数（不思考、仅文本、128000 / 32000）：多半是当时没识别出来，而不是用户改的。
    pub(crate) fn has_default_capabilities(&self) -> bool {
        !self.reasoning
            && self.input == [Input::Text]
            && self.context_window == DEFAULT_CONTEXT_WINDOW
            && self.max_tokens == DEFAULT_MAX_TOKENS
    }
}

/// 一个渠道（`providers.json` 中的一项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Provider {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) api: Api,
    pub(crate) base_url: String,
    pub(crate) enabled: bool,
    pub(crate) models: Vec<ProviderModel>,
}

/// `providers.json` 的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderStore {
    pub(crate) version: u32,
    pub(crate) providers: Vec<Provider>,
}

impl Default for ProviderStore {
    fn default() -> Self {
        Self {
            version: VERSION,
            providers: Vec::new(),
        }
    }
}

/// 渠道 ID：小写字母开头，只含小写字母、数字与 `-`（会作为 `provider/model` 的前缀与密钥名出现在设置与命令行中）。
pub(crate) fn is_valid_id(id: &str) -> bool {
    (1..=MAX_ID_LEN).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 渠道密钥在保险库中的名字。
pub(crate) fn secret_name(id: &str) -> String {
    format!("{SECRET_PREFIX}{id}")
}

/// 模型 ID：非空、不含控制字符；可以含 `/`（聚合网关的 `厂商/模型`，如 `moonshotai/kimi-k3`），但不能以 `/` 开头或结尾、
/// 不能有空段。`provider/modelId` 只按第一个 `/` 拆分（Core 的 `set_model` 分开传两项，`settings.json` 分开存
/// `defaultProvider` / `defaultModel`，模型引用按第一个 `/` 取渠道），渠道 ID 本身不含 `/`，所以不会歧义。
pub(crate) fn is_valid_model_id(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && !id.chars().any(char::is_control)
        && id.split('/').all(|segment| !segment.is_empty())
}

/// `baseUrl` 必须是 HTTP(S) 地址（内置渠道为内网 HTTP）。
pub(crate) fn check_base_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or_default();
    if rest.is_empty() || rest.starts_with('/') || url.chars().any(char::is_whitespace) {
        return Err("接口地址必须是 http:// 或 https:// 开头的地址".to_owned());
    }
    Ok(())
}

/// 规范化接口地址：去掉首尾空白与末尾的 `/`。
pub(crate) fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_owned()
}

/// 从名称生成 ID：ASCII 字母数字转小写，其余连续字符折成一个 `-`；不以字母开头时加 `p-`，
/// 生成不出时用 `provider`；与已有 ID 重复时依次加 `-2`、`-3`…
pub(crate) fn generate_id(name: &str, existing: &[&str]) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let mut slug = slug.trim_end_matches('-').to_owned();
    if slug.is_empty() {
        slug = "provider".to_owned();
    } else if !slug.starts_with(|c: char| c.is_ascii_lowercase()) {
        slug = format!("p-{slug}");
    }
    // 给去重后缀留位置
    slug.truncate(MAX_ID_LEN - 4);
    let slug = slug.trim_end_matches('-').to_owned();
    if !existing.contains(&slug.as_str()) {
        return slug;
    }
    (2..)
        .map(|n| format!("{slug}-{n}"))
        .find(|candidate| !existing.contains(&candidate.as_str()))
        .unwrap_or(slug)
}

/// 密钥提示：末 4 位；密钥少于 8 个字符时不提示（避免泄露大半个密钥）。
pub(crate) fn key_hint(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    (chars.len() >= 8).then(|| chars[chars.len() - 4..].iter().collect())
}

/// 校验一个模型。
fn check_model(owner: &str, model: &ProviderModel) -> Result<(), String> {
    if !is_valid_model_id(&model.id) {
        return Err(format!("{owner} 有模型 ID 无效：{:?}", model.id));
    }
    if model.name.trim().is_empty() {
        return Err(format!("{owner}/{} 的名称不能为空", model.id));
    }
    if model.input.is_empty() || !model.input.contains(&Input::Text) {
        return Err(format!("{owner}/{} 的输入类型必须包含文本", model.id));
    }
    if model.context_window == 0 || model.max_tokens == 0 {
        return Err(format!(
            "{owner}/{} 的上下文窗口与最大输出必须是正整数",
            model.id
        ));
    }
    Ok(())
}

/// 校验一个渠道。
pub(crate) fn check_provider(provider: &Provider) -> Result<(), String> {
    if !is_valid_id(&provider.id) {
        return Err(format!("渠道 ID {:?} 无效", provider.id));
    }
    let name = provider.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("渠道名称不能为空，且不超过 64 个字符".to_owned());
    }
    check_base_url(&provider.base_url).map_err(|e| format!("{}：{e}", provider.name))?;
    for (i, model) in provider.models.iter().enumerate() {
        check_model(&provider.name, model)?;
        if provider.models[..i].iter().any(|m| m.id == model.id) {
            return Err(format!("{} 的模型 {} 重复", provider.name, model.id));
        }
    }
    Ok(())
}

impl ProviderStore {
    /// 校验整份配置；任一项不合格整份拒绝。
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.version != VERSION {
            return Err(format!("不支持的版本 {}", self.version));
        }
        for (i, provider) in self.providers.iter().enumerate() {
            check_provider(provider)?;
            if self.providers[..i].iter().any(|p| p.id == provider.id) {
                return Err(format!("渠道 ID {} 重复", provider.id));
            }
        }
        Ok(())
    }

    /// 解析并校验文件内容。
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        let store: Self =
            serde_json::from_str(text).map_err(|e| format!("渠道配置解析失败：{e}"))?;
        store.check().map_err(|e| format!("渠道配置无效：{e}"))?;
        Ok(store)
    }

    /// 读取；文件不存在时返回 `Ok(None)`。
    pub(crate) fn load(file: &Path) -> Result<Option<Self>, String> {
        match fs::read_to_string(file) {
            Ok(text) => Self::parse(&text).map(Some),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("读取渠道配置失败：{e}")),
        }
    }

    /// 校验后写入：先写同目录临时文件再替换。
    pub(crate) fn save(&self, file: &Path) -> Result<(), String> {
        self.check()?;
        let mut text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        text.push('\n');
        write_atomic(file, &text).map_err(|e| format!("保存渠道配置失败：{e}"))
    }

    pub(crate) fn get(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub(crate) fn ids(&self) -> Vec<&str> {
        self.providers.iter().map(|p| p.id.as_str()).collect()
    }
}

/// 先写同目录临时文件再替换。
pub(crate) fn write_atomic(file: &Path, text: &str) -> io::Result<()> {
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
    result
}

/// 用获取到的模型列表生成新的模型清单：已保存的模型保留用户改过的参数，新模型用接口给出的能力（没给的用默认参数）；
/// 顺序按获取结果。已保存但能力仍是默认参数的模型（当时没识别出来）按现在的规则重新识别，名称保留。
pub(crate) fn merge_models(
    saved: &[ProviderModel],
    fetched: &[FetchedModel],
) -> Vec<ProviderModel> {
    fetched
        .iter()
        .map(|f| match saved.iter().find(|m| m.id == f.id) {
            Some(m) if !m.has_default_capabilities() => m.clone(),
            Some(m) => ProviderModel {
                name: m.name.clone(),
                ..ProviderModel::from_fetched(f)
            },
            None => ProviderModel::from_fetched(f),
        })
        .collect()
}

// ---- 模型列表获取 ----

/// 接口返回的一个模型（能力字段为接口给出的值，接口没提到时为 None）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct FetchedModel {
    pub(crate) id: String,
    pub(crate) display_name: Option<String>,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_tokens: Option<u64>,
    /// 接口给出的是否支持图片输入
    pub(crate) image: Option<bool>,
    /// 接口给出的是否支持思考
    pub(crate) reasoning: Option<bool>,
}

/// 能力数值的合理上限（防止异常值）：1 亿 token。
const MAX_TOKEN_COUNT: u64 = 100_000_000;

/// 按路径取字段（`a.b.c`）。
fn field<'a>(item: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    path.split('.').try_fold(item, |v, key| v.get(key))
}

/// 正整数 token 数：数字（含整数值的小数）或数字字符串；超出合理范围的忽略。
fn token_count(v: &serde_json::Value) -> Option<u64> {
    let n = match v {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.fract() == 0.0 && *f > 0.0)
                .map(|f| f as u64)
        }),
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }?;
    (1..=MAX_TOKEN_COUNT).contains(&n).then_some(n)
}

/// 第一个给出有效 token 数的字段。
fn first_count(item: &serde_json::Value, paths: &[&str]) -> Option<u64> {
    paths
        .iter()
        .find_map(|p| field(item, p).and_then(token_count))
}

/// 能力开关：布尔值，或 `{"supported": true}`（Anthropic 的能力对象写法）；其他写法视为没给。
fn flag(v: &serde_json::Value) -> Option<bool> {
    match v {
        serde_json::Value::Bool(b) => Some(*b),
        serde_json::Value::Object(o) => o.get("supported").and_then(serde_json::Value::as_bool),
        _ => None,
    }
}

/// 若干字段里有一个为真 → Some(true)；都没有出现 → None；出现了但都不为真 → Some(false)。
fn tri_state(values: impl IntoIterator<Item = Option<bool>>) -> Option<bool> {
    values.into_iter().flatten().reduce(|a, b| a || b)
}

fn flags<'a>(
    item: &'a serde_json::Value,
    paths: &'a [&str],
) -> impl Iterator<Item = Option<bool>> + 'a {
    paths.iter().map(|p| field(item, p).and_then(flag))
}

/// 输入模态里是否有图片：数组（`["text","image"]`）或字符串（`"text+image->text"`，只看 `->` 之前的输入部分）。
fn modalities_include_image(v: &serde_json::Value) -> bool {
    let is_image = |s: &str| {
        let s = s.trim().to_ascii_lowercase();
        s == "image" || s == "images" || s == "vision"
    };
    match v {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(is_image),
        serde_json::Value::String(s) => {
            let input = s.split("->").next().unwrap_or_default();
            input.split(['+', ',', ' ']).any(is_image)
        }
        // `{"input": [...], "output": [...]}`
        serde_json::Value::Object(o) => o.get("input").is_some_and(modalities_include_image),
        _ => false,
    }
}

/// 从一项模型信息里识别能力（字段都可缺省；不认识的忽略）。
fn detect_capabilities(item: &serde_json::Value, model: &mut FetchedModel) {
    model.context_window = first_count(
        item,
        &[
            "context_length",
            "context_window",
            "max_context_length",
            "max_input_tokens",
            "top_provider.context_length",
        ],
    );
    model.max_tokens = first_count(
        item,
        &[
            "top_provider.max_completion_tokens",
            "max_output_tokens",
            "max_tokens",
            "max_completion_tokens",
        ],
    );
    let modalities = [
        "architecture.input_modalities",
        "input_modalities",
        "modalities",
        "architecture.modality",
    ]
    .iter()
    .map(|p| field(item, p).map(modalities_include_image));
    model.image = tri_state(modalities.chain(flags(
        item,
        &[
            "capabilities.vision",
            "capabilities.image_input",
            "capabilities.image",
        ],
    )));
    let params = field(item, "supported_parameters")
        .and_then(serde_json::Value::as_array)
        .map(|params| {
            params
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|p| matches!(p, "reasoning" | "include_reasoning" | "reasoning_effort"))
        });
    model.reasoning = tri_state(std::iter::once(params).chain(flags(
        item,
        &[
            "capabilities.reasoning",
            "capabilities.thinking",
            "reasoning",
        ],
    )));
}

/// 模型列表接口地址：openai-responses 为 `{baseUrl}/models`；anthropic-messages 为 `{baseUrl}/v1/models`
/// （`baseUrl` 已以 `/v1` 结尾时不重复）。
pub(crate) fn models_url(api: Api, base_url: &str) -> String {
    let base = normalize_base_url(base_url);
    match api {
        Api::OpenAiResponses => format!("{base}/models"),
        Api::AnthropicMessages if base.ends_with("/v1") => format!("{base}/models"),
        Api::AnthropicMessages => format!("{base}/v1/models"),
    }
}

/// 鉴权请求头（名称, 值）。
pub(crate) fn auth_headers(api: Api, key: &str) -> Vec<(&'static str, String)> {
    match api {
        Api::OpenAiResponses => vec![("authorization", format!("Bearer {key}"))],
        Api::AnthropicMessages => vec![
            ("x-api-key", key.to_owned()),
            ("anthropic-version", ANTHROPIC_VERSION.to_owned()),
        ],
    }
}

/// 解析模型列表响应：`{"data":[{"id":"...", ...}]}`；跳过无效与重复的 ID。
///
/// 名称取 `display_name`（Anthropic）或 `name`（OpenRouter 等）。接口给出时识别能力，字段都可缺省：
/// - 上下文长度：`context_length` / `context_window` / `max_context_length` / `max_input_tokens` /
///   `top_provider.context_length`
/// - 最大输出：`top_provider.max_completion_tokens` / `max_output_tokens` / `max_tokens` / `max_completion_tokens`
/// - 图片输入：`architecture.input_modalities` / `input_modalities` / `modalities` / `architecture.modality`
///   含 image（数组或 `"text+image->text"` 字符串），或 `capabilities.vision` / `image_input` 为真
/// - 思考：`supported_parameters` 含 `reasoning` / `include_reasoning` / `reasoning_effort`，
///   或 `capabilities.reasoning` / `capabilities.thinking` / `reasoning` 为真
///
/// 能力开关也接受 `{"supported": true}` 的写法。
pub(crate) fn parse_models_response(body: &[u8]) -> Result<Vec<FetchedModel>, String> {
    #[derive(Deserialize)]
    struct Body {
        data: Vec<serde_json::Value>,
    }
    let body: Body =
        serde_json::from_slice(body).map_err(|_| "返回内容不是有效的模型列表".to_owned())?;
    let mut models: Vec<FetchedModel> = Vec::new();
    for item in body.data {
        let Some(id) = item
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(|id| id.trim().to_owned())
        else {
            continue;
        };
        if !is_valid_model_id(&id) || models.iter().any(|m| m.id == id) {
            continue;
        }
        let display_name = ["display_name", "name"]
            .iter()
            .filter_map(|k| item.get(*k).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .find(|n| !n.is_empty())
            .map(str::to_owned);
        let mut model = FetchedModel {
            id,
            display_name,
            ..FetchedModel::default()
        };
        detect_capabilities(&item, &mut model);
        models.push(model);
    }
    Ok(models)
}

/// HTTP 状态码对应的提示（不含密钥与响应正文）。
pub(crate) fn status_message(status: u16) -> String {
    match status {
        401 | 403 => format!("密钥无效或没有权限（HTTP {status}）"),
        404 => format!("找不到模型列表接口（HTTP {status}），请检查接口地址与协议"),
        429 => format!("请求过于频繁（HTTP {status}），请稍后再试"),
        500..=599 => format!("服务暂时不可用（HTTP {status}）"),
        _ => format!("获取模型列表失败（HTTP {status}）"),
    }
}

/// 网络错误的提示：只说明类别，不带地址与密钥。
fn request_error_message(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("请求超时（{} 秒）", FETCH_TIMEOUT.as_secs())
    } else if e.is_connect() {
        "无法连接到服务器，请检查接口地址与网络".to_owned()
    } else if e.is_builder() {
        "接口地址无效".to_owned()
    } else {
        "请求失败，请检查接口地址与网络".to_owned()
    }
}

/// 获取模型列表（系统代理与更新检查一致：reqwest 的 system-proxy）。
pub(crate) async fn fetch_models(
    api: Api,
    base_url: &str,
    key: &str,
) -> Result<Vec<FetchedModel>, String> {
    check_base_url(&normalize_base_url(base_url))?;
    // 与 updater 插件相同：rustls 未设默认加密实现时装上 ring
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Primus/", env!("CARGO_PKG_VERSION")))
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|_| "无法创建网络客户端".to_owned())?;
    let mut request = client.get(models_url(api, base_url));
    for (name, value) in auth_headers(api, key) {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|e| request_error_message(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_message(status.as_u16()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|e| request_error_message(&e))?;
    parse_models_response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_provider(id: &str) -> Provider {
        Provider {
            id: id.to_owned(),
            name: format!("渠道 {id}"),
            api: Api::OpenAiResponses,
            base_url: "https://gw.example/v1".to_owned(),
            enabled: true,
            models: vec![ProviderModel::with_defaults("m1", None)],
        }
    }

    #[test]
    fn ids_and_slugs() {
        assert!(is_valid_id("ioply") && is_valid_id("a-1"));
        for bad in ["", "1abc", "A", "a_b", "a/b", "a:b", &"a".repeat(49)] {
            assert!(!is_valid_id(bad), "{bad:?}");
        }
        assert_eq!(generate_id("My Gateway!", &[]), "my-gateway");
        assert_eq!(generate_id("  --OpenAI  官方--  ", &[]), "openai");
        assert_eq!(generate_id("我的渠道", &[]), "provider");
        assert_eq!(generate_id("123 api", &[]), "p-123-api");
        assert_eq!(generate_id("ioply", &["ioply"]), "ioply-2");
        assert_eq!(generate_id("ioply", &["ioply", "ioply-2"]), "ioply-3");
        let long = generate_id(&"x".repeat(100), &[]);
        assert!(is_valid_id(&long) && is_valid_id(&format!("{long}-99")));
        assert_eq!(secret_name("ioply"), "provider:ioply");
    }

    #[test]
    fn key_hint_shows_last_four_only() {
        assert_eq!(key_hint("sk-abcdefgh1234").as_deref(), Some("1234"));
        assert_eq!(
            key_hint("密钥一二三四五六七八").as_deref(),
            Some("五六七八")
        );
        assert_eq!(key_hint("short"), None);
        assert_eq!(key_hint(""), None);
    }

    #[test]
    fn validation_rejects_bad_providers() {
        let mut store = ProviderStore::default();
        store.providers.push(sample_provider("a"));
        assert!(store.check().is_ok());
        type Mutation = Box<dyn Fn(&mut Provider)>;
        let cases: Vec<(&str, Mutation)> = vec![
            ("坏 id", Box::new(|p| p.id = "Bad".into())),
            ("空名称", Box::new(|p| p.name = "  ".into())),
            ("ftp", Box::new(|p| p.base_url = "ftp://x".into())),
            ("空主机", Box::new(|p| p.base_url = "https://".into())),
            ("空白", Box::new(|p| p.base_url = "https://a b".into())),
            ("模型 id", Box::new(|p| p.models[0].id = "a//b".into())),
            ("模型 id 开头 /", Box::new(|p| p.models[0].id = "/b".into())),
            ("模型 id 结尾 /", Box::new(|p| p.models[0].id = "a/".into())),
            (
                "模型 id 控制字符",
                Box::new(|p| p.models[0].id = "a\nb".into()),
            ),
            ("模型重复", Box::new(|p| p.models.push(p.models[0].clone()))),
            (
                "无文本",
                Box::new(|p| p.models[0].input = vec![Input::Image]),
            ),
            ("零", Box::new(|p| p.models[0].max_tokens = 0)),
        ];
        for (name, mutate) in cases {
            let mut s = store.clone();
            mutate(&mut s.providers[0]);
            assert!(s.check().is_err(), "{name} 应被拒绝");
        }
        let mut dup = store.clone();
        dup.providers.push(sample_provider("a"));
        assert!(dup.check().is_err(), "ID 重复");
        // 其他协议、apiKey 与未知字段在解析时拒绝
        let json = serde_json::to_value(&store).unwrap();
        let mut other_api = json.clone();
        other_api["providers"][0]["api"] = "openai-completions".into();
        assert!(ProviderStore::parse(&other_api.to_string()).is_err());
        let mut with_key = json.clone();
        with_key["providers"][0]["apiKey"] = "k".into();
        assert!(ProviderStore::parse(&with_key.to_string()).is_err());
        let mut model_key = json.clone();
        model_key["providers"][0]["models"][0]["apiKey"] = "k".into();
        assert!(ProviderStore::parse(&model_key.to_string()).is_err());
        let mut top_key = json.clone();
        top_key["apiKey"] = "k".into();
        assert!(ProviderStore::parse(&top_key.to_string()).is_err());
        let mut bad_input = json.clone();
        bad_input["providers"][0]["models"][0]["input"] = serde_json::json!(["audio"]);
        assert!(ProviderStore::parse(&bad_input.to_string()).is_err());
        assert_eq!(ProviderStore::parse(&json.to_string()).unwrap(), store);
    }

    #[test]
    fn store_round_trip_is_atomic_and_camel_case() {
        let dir = std::env::temp_dir().join(format!("primus-providers-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let file = dir.join(PROVIDERS_FILE);
        assert_eq!(ProviderStore::load(&file).unwrap(), None);
        let mut store = ProviderStore::default();
        store.providers.push(sample_provider("a"));
        store.save(&file).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"baseUrl\"") && text.contains("\"contextWindow\""));
        assert!(text.contains("\"openai-responses\"") && !text.contains("apiKey"));
        assert_eq!(ProviderStore::load(&file).unwrap(), Some(store));
        assert!(
            fs::read_dir(&dir).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
        fs::write(&file, "{bad").unwrap();
        assert!(ProviderStore::load(&file).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_preserves_edited_fields_and_follows_fetched_order() {
        let mut edited = ProviderModel::with_defaults("b", None);
        edited.name = "改过的名字".into();
        edited.reasoning = true;
        edited.input = vec![Input::Text, Input::Image];
        edited.context_window = 1_000_000;
        let saved = vec![ProviderModel::with_defaults("gone", None), edited.clone()];
        let fetched = vec![
            FetchedModel {
                id: "a".into(),
                display_name: Some("Model A".into()),
                ..FetchedModel::default()
            },
            FetchedModel {
                id: "b".into(),
                display_name: Some("B 服务端名".into()),
                ..FetchedModel::default()
            },
        ];
        let merged = merge_models(&saved, &fetched);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "Model A");
        assert_eq!(
            (
                merged[0].reasoning,
                merged[0].context_window,
                merged[0].max_tokens
            ),
            (false, 128_000, 32_000)
        );
        assert_eq!(merged[0].input, vec![Input::Text]);
        assert_eq!(merged[1], edited, "保留用户改过的参数");
    }

    #[test]
    fn merge_applies_detected_capabilities_to_new_models_only() {
        let detected = FetchedModel {
            id: "r1".into(),
            display_name: None,
            context_window: Some(200_000),
            max_tokens: Some(64_000),
            image: Some(true),
            reasoning: Some(true),
        };
        let mut saved = ProviderModel::with_defaults("r1", None);
        saved.context_window = 50_000;
        // 新模型：用接口给出的能力
        let fresh = merge_models(&[], std::slice::from_ref(&detected));
        assert!(fresh[0].reasoning && fresh[0].image());
        assert_eq!(
            (fresh[0].context_window, fresh[0].max_tokens),
            (200_000, 64_000)
        );
        // 已保存的模型：保留用户的值（含 reasoning=false）
        let kept = merge_models(std::slice::from_ref(&saved), &[detected]);
        assert_eq!(kept[0], saved);
        // 已保存但仍是默认参数（当时没识别出来）：按现在的规则重新识别，名称保留
        let mut unrecognized = ProviderModel::with_defaults("kimi-k3.1-pro", None);
        unrecognized.name = "我的 Kimi".into();
        assert!(unrecognized.has_default_capabilities());
        let fetched_kimi = FetchedModel {
            id: "kimi-k3.1-pro".into(),
            ..FetchedModel::default()
        };
        let again = merge_models(std::slice::from_ref(&unrecognized), &[fetched_kimi]);
        assert_eq!(again[0].name, "我的 Kimi");
        assert!(again[0].reasoning && again[0].image());
        assert_eq!(again[0].context_window, 1_048_576);
        // 最大输出大于上下文长度时收窄
        let wide = ProviderModel::from_fetched(&FetchedModel {
            id: "w".into(),
            max_tokens: Some(1_000_000),
            ..FetchedModel::default()
        });
        assert_eq!((wide.context_window, wide.max_tokens), (128_000, 128_000));
    }

    #[test]
    fn detects_capabilities_from_common_model_list_payloads() {
        // OpenRouter 风格
        let openrouter = br#"{"data":[{
            "id":"vision-thinker","name":"Vision Thinker",
            "context_length":1048576,
            "architecture":{"modality":"text+image->text","input_modalities":["text","image"],"output_modalities":["text"]},
            "top_provider":{"context_length":1048576,"max_completion_tokens":65536},
            "supported_parameters":["max_tokens","temperature","reasoning","include_reasoning"]
        },{
            "id":"plain","name":"Plain","context_length":"32768",
            "architecture":{"modality":"text->text"},
            "top_provider":{"max_completion_tokens":null},
            "supported_parameters":["temperature"]
        }]}"#;
        let m = parse_models_response(openrouter).unwrap();
        assert_eq!(
            m[0],
            FetchedModel {
                id: "vision-thinker".into(),
                display_name: Some("Vision Thinker".into()),
                context_window: Some(1_048_576),
                max_tokens: Some(65_536),
                image: Some(true),
                reasoning: Some(true),
            }
        );
        assert_eq!(
            m[1],
            FetchedModel {
                id: "plain".into(),
                display_name: Some("Plain".into()),
                context_window: Some(32_768),
                max_tokens: None,
                // 接口明确给了模态与参数：不支持
                image: Some(false),
                reasoning: Some(false),
            }
        );

        // OpenAI 兼容网关的各种写法
        let compat = br#"{"object":"list","data":[
            {"id":"a","context_window":200000,"max_output_tokens":8192,"modalities":"text+image","capabilities":{"reasoning":true}},
            {"id":"b","max_context_length":64000,"max_completion_tokens":4096,"input_modalities":["TEXT"],"reasoning":true},
            {"id":"c","capabilities":{"vision":true,"thinking":false},"supported_parameters":["reasoning_effort"]},
            {"id":"d","modalities":{"input":["text","image"],"output":["text"]},"context_length":-5,"max_tokens":0},
            {"id":"e","capabilities":{"image_input":true},"context_length":1e12}
        ]}"#;
        let m = parse_models_response(compat).unwrap();
        let caps: Vec<_> = m
            .iter()
            .map(|f| {
                (
                    f.id.as_str(),
                    f.context_window,
                    f.max_tokens,
                    f.image,
                    f.reasoning,
                )
            })
            .collect();
        assert_eq!(
            caps,
            vec![
                ("a", Some(200_000), Some(8192), Some(true), Some(true)),
                ("b", Some(64_000), Some(4096), Some(false), Some(true)),
                ("c", None, None, Some(true), Some(true)),
                ("d", None, None, Some(true), None),
                ("e", None, None, Some(true), None),
            ]
        );

        // Anthropic /v1/models：display_name、max_input_tokens、max_tokens 与能力对象
        let anthropic = br#"{"data":[
            {"type":"model","id":"claude-z","display_name":"Claude Z","created_at":"2026-01-01T00:00:00Z",
             "max_input_tokens":200000,"max_tokens":64000,
             "capabilities":{"image_input":{"supported":true},"thinking":{"supported":true,"types":{}}}},
            {"type":"model","id":"claude-old","display_name":"Claude Old","created_at":"2024-01-01T00:00:00Z"}
        ],"has_more":false,"first_id":"claude-z","last_id":"claude-old"}"#;
        let m = parse_models_response(anthropic).unwrap();
        assert_eq!(
            m[0],
            FetchedModel {
                id: "claude-z".into(),
                display_name: Some("Claude Z".into()),
                context_window: Some(200_000),
                max_tokens: Some(64_000),
                image: Some(true),
                reasoning: Some(true),
            }
        );
        // 没有能力信息：全部缺省
        assert_eq!(
            m[1],
            FetchedModel {
                id: "claude-old".into(),
                display_name: Some("Claude Old".into()),
                ..FetchedModel::default()
            }
        );
    }

    #[test]
    fn missing_capabilities_come_from_known_models_then_defaults() {
        // CLIProxyAPI 一类网关：只有 id / object / owned_by（可能带 display_name）
        let body = br#"{"object":"list","data":[
            {"id":"claude-opus-5-5-high","object":"model","owned_by":"anthropic","display_name":"Claude Opus 5.5 (High)"},
            {"id":"gpt-5.5","object":"model","owned_by":"openai"},
            {"id":"gemini-3-pro","object":"model","owned_by":"google"},
            {"id":"my-private-model","object":"model","owned_by":"me"},
            {"id":"gpt-5.5-mini-text","object":"model","architecture":{"input_modalities":["text"]},"context_length":64000}
        ]}"#;
        let models = merge_models(&[], &parse_models_response(body).unwrap());
        let summary: Vec<_> = models
            .iter()
            .map(|m| {
                (
                    m.id.as_str(),
                    m.name.as_str(),
                    m.context_window,
                    m.max_tokens,
                    m.image(),
                    m.reasoning,
                )
            })
            .collect();
        let opus = crate::model_catalog::lookup("claude-opus-5-5").unwrap();
        let gpt = crate::model_catalog::lookup("gpt-5-5").unwrap();
        assert_eq!(
            summary,
            vec![
                (
                    "claude-opus-5-5-high",
                    "Claude Opus 5.5 (High)",
                    opus.context_window,
                    opus.max_tokens,
                    true,
                    true
                ),
                (
                    "gpt-5.5",
                    "gpt-5.5",
                    gpt.context_window,
                    gpt.max_tokens,
                    true,
                    true
                ),
                (
                    "gemini-3-pro",
                    "gemini-3-pro",
                    1_048_576,
                    65_536,
                    true,
                    true
                ),
                // 不认识：默认参数
                (
                    "my-private-model",
                    "my-private-model",
                    128_000,
                    32_000,
                    false,
                    false
                ),
                // 接口给出的字段优先于能力表（gpt-5 系列默认支持图片，这里接口说只有文本）
                (
                    "gpt-5.5-mini-text",
                    "gpt-5.5-mini-text",
                    64_000,
                    64_000,
                    false,
                    true
                ),
            ]
        );
        assert_eq!(
            models[3],
            ProviderModel::with_defaults("my-private-model", None)
        );
        // 已保存的模型（含用户关掉的思考）在重新获取时保持不变
        let mut saved = models[0].clone();
        saved.reasoning = false;
        saved.context_window = 100_000;
        let again = merge_models(
            std::slice::from_ref(&saved),
            &parse_models_response(body).unwrap(),
        );
        assert_eq!(again[0], saved);
    }

    #[test]
    fn urls_and_headers_for_both_protocols() {
        assert_eq!(
            models_url(Api::OpenAiResponses, "http://h:1/openai/v1/"),
            "http://h:1/openai/v1/models"
        );
        assert_eq!(
            models_url(Api::AnthropicMessages, "https://api.example"),
            "https://api.example/v1/models"
        );
        assert_eq!(
            models_url(Api::AnthropicMessages, "https://api.example/v1/"),
            "https://api.example/v1/models"
        );
        assert_eq!(
            auth_headers(Api::OpenAiResponses, "k1"),
            vec![("authorization", "Bearer k1".to_owned())]
        );
        assert_eq!(
            auth_headers(Api::AnthropicMessages, "k2"),
            vec![
                ("x-api-key", "k2".to_owned()),
                ("anthropic-version", "2023-06-01".to_owned())
            ]
        );
    }

    #[test]
    fn parses_model_list_responses() {
        let body = br#"{"object":"list","data":[
            {"id":"gpt-x","object":"model"},
            {"id":"claude-y","display_name":"Claude Y","type":"model"},
            {"id":"gpt-x"},{"id":"org/model"},{"id":"/bad"},{"id":""},{"object":"model"}
        ],"has_more":false}"#;
        let models = parse_models_response(body).unwrap();
        assert_eq!(
            models,
            vec![
                FetchedModel {
                    id: "gpt-x".into(),
                    display_name: None,
                    ..FetchedModel::default()
                },
                FetchedModel {
                    id: "claude-y".into(),
                    display_name: Some("Claude Y".into()),
                    ..FetchedModel::default()
                },
                FetchedModel {
                    id: "org/model".into(),
                    display_name: None,
                    ..FetchedModel::default()
                },
            ]
        );
        assert!(parse_models_response(br#"{"data":[]}"#).unwrap().is_empty());
        assert!(parse_models_response(b"<html>").is_err());
        assert!(parse_models_response(br#"{"models":[]}"#).is_err());
        assert!(status_message(401).contains("密钥无效"));
        assert!(status_message(404).contains("接口地址"));
    }
}
