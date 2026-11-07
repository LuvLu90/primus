//! Core 配置生成（技术方案第 9.2 节）：由用户管理的模型渠道（`providers` 模块）生成 Core 的 `models.json`
//! 与 `settings.json` 默认模型。
//!
//! - 来源：`users/<SID>/app/providers.json`。只有启用、已存密钥且至少有一个模型的渠道写进 `models.json`
//!   （供应商键 = 渠道 ID，模型键 `<渠道 ID>/<模型 ID>`）；一个都没有时写空的 `providers`，界面据 `models_get` 的
//!   `error` 提示添加渠道，不影响 App 启动。
//! - 写入：每个渠道的 `apiKey` 写成取密钥命令 `!"<Primus.exe>" --secret provider:<id>`（第 9.4 节），
//!   `models.json` 不含明文密钥；内容不变时不重写文件。
//! - 默认模型写进 Core 的 `settings.json`（`defaultProvider` / `defaultModel`），其余设置项原样保留；
//!   用户改选的默认模型只要仍在列表中就不覆盖，失效时改为第一个可用模型，没有可用模型时清除。
//!   变化只影响新拉起的 Core 进程。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::{Map, Value, json};

use crate::providers::{
    self, Api, FetchedModel, PROVIDERS_FILE, Provider, ProviderModel, ProviderStore,
};
use crate::vault::Vault;

const MODELS_FILE: &str = "models.json";
const SETTINGS_FILE: &str = "settings.json";

/// 没有可用模型时 `models_get` 的提示。
pub(crate) const NO_MODELS: &str = "还没有可用的模型：请在设置中添加模型渠道并获取模型列表";

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

/// 由渠道生成 Core 的 `models.json` 内容与模型摘要。
///
/// 只收录启用、`has_key` 为真且至少有一个模型的渠道；`command` 给出某渠道的取密钥命令。
pub(crate) fn models_json(
    store: &ProviderStore,
    has_key: impl Fn(&str) -> bool,
    command: impl Fn(&str) -> String,
) -> (String, Vec<ModelSummary>) {
    let mut out = Map::new();
    let mut summaries = Vec::new();
    for p in store
        .providers
        .iter()
        .filter(|p| p.enabled && !p.models.is_empty() && has_key(&p.id))
    {
        let models: Vec<Value> = p
            .models
            .iter()
            .map(|m| {
                summaries.push(ModelSummary {
                    key: format!("{}/{}", p.id, m.id),
                    provider: p.id.clone(),
                    id: m.id.clone(),
                    name: m.name.clone(),
                    api: p.api.as_str().to_owned(),
                    reasoning: m.reasoning,
                    image: m.image(),
                    context_window: m.context_window,
                    max_tokens: m.max_tokens,
                });
                json!({
                    "id": m.id,
                    "name": m.name,
                    "reasoning": m.reasoning,
                    "input": m.input,
                    "contextWindow": m.context_window,
                    "maxTokens": m.max_tokens,
                })
            })
            .collect();
        out.insert(
            p.id.clone(),
            json!({
                "name": p.name,
                "baseUrl": p.base_url,
                "api": p.api.as_str(),
                "apiKey": command(&p.id),
                "models": models,
            }),
        );
    }
    let mut text = serde_json::to_string_pretty(&json!({ "providers": out })).unwrap_or_default();
    text.push('\n');
    (text, summaries)
}

/// `models.json` 中的取密钥命令：`!"<Primus.exe>" --secret provider:<id>`。
///
/// Core 在 Windows 上用 Git Bash（没有时用 cmd）执行它，路径放在双引号里；为保证两种 shell 下都按字面解释，
/// 拒绝含 `"`、`$`、`` ` ``、`%`、`!` 或换行的路径。
pub(crate) fn secret_command(exe: &Path, provider_id: &str) -> io::Result<String> {
    let path = exe
        .to_str()
        .ok_or_else(|| io::Error::other("Primus.exe 路径不是有效的 Unicode"))?;
    if path.contains(['"', '$', '`', '%', '!', '\n', '\r']) {
        return Err(io::Error::other(
            "Primus.exe 所在路径含有 \" $ ` % ! 等字符，无法安全地写入取密钥命令，请安装到其他目录",
        ));
    }
    if !providers::is_valid_id(provider_id) {
        return Err(io::Error::other("渠道 ID 无效"));
    }
    Ok(format!(
        "!\"{path}\" {} {}",
        crate::vault::SECRET_ARG,
        providers::secret_name(provider_id)
    ))
}

/// 内容不同才写：先写临时文件再替换。返回是否写入。
fn write_if_changed(file: &Path, text: &str) -> io::Result<bool> {
    if fs::read_to_string(file).is_ok_and(|current| current == text) {
        return Ok(false);
    }
    providers::write_atomic(file, text).map(|()| true)
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

/// 清除 `settings.json` 中的默认模型（没有可用模型时）。
fn clear_default(core_dir: &Path) -> io::Result<()> {
    let mut settings = read_settings(core_dir);
    let had =
        settings.remove("defaultProvider").is_some() | settings.remove("defaultModel").is_some();
    if had {
        write_settings(core_dir, &settings)?;
    }
    Ok(())
}

/// 应用渠道配置：写 `models.json`，默认模型失效时改为第一个可用模型（没有时清除）。返回可用模型。
pub(crate) fn apply(
    store: &ProviderStore,
    core_dir: &Path,
    vault: &Vault,
    exe: &Path,
) -> io::Result<Vec<ModelSummary>> {
    // 先确认路径能安全写进命令（与渠道无关），再逐个生成
    secret_command(exe, "check")?;
    let (text, models) = models_json(
        store,
        |id| matches!(vault.get(&providers::secret_name(id)), Ok(Some(_))),
        |id| secret_command(exe, id).unwrap_or_default(),
    );
    write_if_changed(&core_dir.join(MODELS_FILE), &text)?;
    let keep = current_default(core_dir).is_some_and(|key| models.iter().any(|m| m.key == key));
    if !keep {
        match models.first() {
            Some(first) => set_default(core_dir, &first.key)?,
            None => clear_default(core_dir)?,
        }
    }
    Ok(models)
}

/// `models_get` 的返回值。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelsInfo {
    /// `providers.json` 的格式版本；渠道配置读取失败时为 null
    pub(crate) version: Option<u32>,
    pub(crate) models: Vec<ModelSummary>,
    /// 当前默认模型（用户改选的，或第一个可用模型）
    pub(crate) default_model: Option<String>,
    /// 压缩与标题生成用的模型：当前与默认模型相同
    pub(crate) compaction_model: Option<String>,
    pub(crate) title_model: Option<String>,
    /// 不能对话的原因（配置读取 / 写入失败，或没有可用模型）；为 null 表示可以对话
    pub(crate) error: Option<String>,
}

/// 渠道在界面上的样子：渠道本身 + 是否已存密钥与密钥末 4 位（绝不返回密钥）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderView {
    #[serde(flatten)]
    pub(crate) provider: Provider,
    pub(crate) has_key: bool,
    pub(crate) key_hint: Option<String>,
}

/// `provider_save` / `provider_delete` 的返回值。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvidersChanged {
    pub(crate) providers: Vec<ProviderView>,
    pub(crate) models: ModelsInfo,
}

/// `provider_save` 的参数。不实现 Debug：含密钥。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderInput {
    /// 缺省为新建（由名称生成 ID）
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) api: Api,
    pub(crate) base_url: String,
    /// 缺省为保留已存的密钥；新建时必填；空字符串无效
    pub(crate) api_key: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) models: Vec<ProviderModel>,
}

/// `provider_fetch_models` 的参数：已保存的渠道给 `id`（其余字段可覆盖，用于测试未保存的修改），
/// 草稿给 `api` + `baseUrl` + `apiKey`。不实现 Debug：含密钥。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FetchInput {
    pub(crate) id: Option<String>,
    pub(crate) api: Option<Api>,
    pub(crate) base_url: Option<String>,
    pub(crate) api_key: Option<String>,
}

/// 获取模型列表所需的参数（已从保险库取出密钥）。
pub(crate) struct FetchTarget {
    pub(crate) api: Api,
    pub(crate) base_url: String,
    pub(crate) key: String,
    /// 已保存的模型（合并时保留用户改过的参数）
    pub(crate) saved: Vec<ProviderModel>,
}

type Listener = Box<dyn Fn(ModelsInfo) + Send + Sync>;

/// 模型配置的运行时状态（渠道命令与 `models_*` 共用）。
pub(crate) struct ModelConfigState {
    core_dir: PathBuf,
    vault_dir: PathBuf,
    providers_file: PathBuf,
    inner: Mutex<Applied>,
    listener: Mutex<Option<Listener>>,
}

#[derive(Default)]
struct Applied {
    loaded: bool,
    /// 渠道配置读取成功时为其格式版本
    version: Option<u32>,
    models: Vec<ModelSummary>,
    error: Option<String>,
}

/// 非空的密钥（去掉首尾空白）；空字符串与含控制字符的密钥无效。
fn clean_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        Err("API 密钥不能为空".to_owned())
    } else if key.chars().any(char::is_control) {
        // 换行等控制字符既放不进请求头，也会截断 `--secret` 的输出
        Err("API 密钥含有换行等无效字符".to_owned())
    } else {
        Ok(key.to_owned())
    }
}

impl ModelConfigState {
    /// `core_dir` 为 `users/<SID>/core`，`vault_dir` 为 `users/<SID>/vault`，`app_dir` 为 `users/<SID>/app`。
    pub(crate) fn new(core_dir: PathBuf, vault_dir: PathBuf, app_dir: &Path) -> Self {
        Self {
            core_dir,
            vault_dir,
            providers_file: app_dir.join(PROVIDERS_FILE),
            inner: Mutex::new(Applied::default()),
            listener: Mutex::new(None),
        }
    }

    fn vault(&self) -> Vault {
        Vault::new(&self.vault_dir)
    }

    fn lock(&self) -> MutexGuard<'_, Applied> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 订阅配置变化（`models_watch`）：每次重新生成后推送一次完整的 `ModelsInfo`。再次调用替换旧的订阅。
    pub(crate) fn set_listener(&self, listener: impl Fn(ModelsInfo) + Send + Sync + 'static) {
        *self.listener.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(listener));
    }

    fn notify(&self) -> ModelsInfo {
        let info = self.info();
        if let Some(listener) = self
            .listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            listener(info.clone());
        }
        info
    }

    /// 读取渠道配置（文件不存在时为空配置）。
    fn load(&self) -> Result<ProviderStore, String> {
        ProviderStore::load(&self.providers_file).map(Option::unwrap_or_default)
    }

    /// 修改前读取：文件损坏时备份为 `.bak` 后从空配置开始，避免用户永远无法保存。
    fn load_for_write(&self) -> ProviderStore {
        self.load().unwrap_or_else(|e| {
            eprintln!("[core_config] {e}；已备份为 {PROVIDERS_FILE}.bak 并重建");
            let _ = fs::copy(
                &self.providers_file,
                self.providers_file.with_extension("json.bak"),
            );
            ProviderStore::default()
        })
    }

    /// 按渠道配置重新生成 `models.json` 与默认模型（调用方持有锁）。
    fn regenerate(&self, inner: &mut Applied, store: Result<ProviderStore, String>) {
        inner.version = store.as_ref().ok().map(|s| s.version);
        let result = store.and_then(|store| {
            let exe = std::env::current_exe().map_err(|e| format!("无法定位 Primus.exe：{e}"))?;
            apply(&store, &self.core_dir, &self.vault(), &exe)
                .map_err(|e| format!("写入模型配置失败：{e}"))
        });
        inner.loaded = true;
        match result {
            Ok(models) => {
                inner.error = models.is_empty().then(|| NO_MODELS.to_owned());
                inner.models = models;
            }
            Err(message) => {
                eprintln!("[core_config] {message}");
                inner.models.clear();
                inner.error = Some(message);
            }
        }
    }

    /// 首次启动写入内置渠道（只在 `providers.json` 不存在时），并删除旧版内置令牌。返回是否写入了内置渠道
    /// （调用方随后在后台获取它的模型列表）。失败只记日志，下次启动再试。
    pub(crate) fn seed_and_migrate(&self) -> bool {
        let _inner = self.lock();
        let vault = self.vault();
        if let Err(e) = vault.remove(crate::builtin::LEGACY_TOKEN_ID) {
            eprintln!("[core_config] 删除旧版内置令牌失败：{e}");
        }
        if self.providers_file.exists() {
            return false;
        }
        let provider = crate::builtin::seed_provider();
        // 先存密钥再写文件：密钥存不进去时不写文件，下次启动重试
        if let Err(e) = vault.ensure(
            &providers::secret_name(&provider.id),
            crate::builtin::BUILTIN_API_KEY,
        ) {
            eprintln!("[core_config] 内置渠道密钥写入保险库失败：{e}");
            return false;
        }
        let store = ProviderStore {
            providers: vec![provider],
            ..ProviderStore::default()
        };
        match store.save(&self.providers_file) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[core_config] {e}");
                false
            }
        }
    }

    /// 重新读取 `providers.json` 并生成 Core 配置（启动时与 `models_refresh`）。失败时记录原因，不影响 App 启动。
    pub(crate) fn refresh(&self) -> ModelsInfo {
        {
            let mut inner = self.lock();
            let store = self.load();
            self.regenerate(&mut inner, store);
        }
        self.notify()
    }

    pub(crate) fn info(&self) -> ModelsInfo {
        let inner = self.lock();
        let default_model = (!inner.models.is_empty()).then(|| {
            current_default(&self.core_dir)
                .filter(|key| inner.models.iter().any(|m| &m.key == key))
                .unwrap_or_else(|| inner.models[0].key.clone())
        });
        ModelsInfo {
            version: inner.version,
            models: inner.models.clone(),
            compaction_model: default_model.clone(),
            title_model: default_model.clone(),
            default_model,
            error: if inner.loaded {
                inner.error.clone()
            } else {
                Some("模型配置尚未就绪".to_owned())
            },
        }
    }

    /// 设置页改选默认模型：只能选列表中的模型。新拉起的 Core 进程生效。
    pub(crate) fn set_default(&self, key: &str) -> Result<ModelsInfo, String> {
        {
            let inner = self.lock();
            if !inner.models.iter().any(|m| m.key == key) {
                return Err(format!("模型 {key} 不在可用列表中"));
            }
            set_default(&self.core_dir, key).map_err(|e| format!("保存默认模型失败：{e}"))?;
        }
        Ok(self.notify())
    }

    fn views(&self, store: &ProviderStore) -> Vec<ProviderView> {
        let vault = self.vault();
        store
            .providers
            .iter()
            .map(|p| {
                let key = vault.get(&providers::secret_name(&p.id)).ok().flatten();
                ProviderView {
                    provider: p.clone(),
                    has_key: key.is_some(),
                    key_hint: key.as_deref().and_then(providers::key_hint),
                }
            })
            .collect()
    }

    /// `providers_list`：全部渠道（含 `hasKey` / `keyHint`）。
    pub(crate) fn providers_list(&self) -> Result<Vec<ProviderView>, String> {
        let _inner = self.lock();
        Ok(self.views(&self.load()?))
    }

    /// `provider_save`：新建（无 `id`）或修改渠道，校验后保存，按需写入密钥并重新生成 Core 配置。
    pub(crate) fn provider_save(&self, input: ProviderInput) -> Result<ProvidersChanged, String> {
        let providers = {
            let mut inner = self.lock();
            let mut store = self.load_for_write();
            let key = input.api_key.as_deref().map(clean_key).transpose()?;
            let name = input.name.trim().to_owned();
            let index = match &input.id {
                Some(id) => Some(
                    store
                        .providers
                        .iter()
                        .position(|p| &p.id == id)
                        .ok_or("渠道不存在，可能已被删除")?,
                ),
                None => None,
            };
            let id = match &input.id {
                Some(id) => id.clone(),
                None => providers::generate_id(&name, &store.ids()),
            };
            if index.is_none() && key.is_none() {
                return Err("请填写 API 密钥".to_owned());
            }
            let provider = Provider {
                id: id.clone(),
                name,
                api: input.api,
                base_url: providers::normalize_base_url(&input.base_url),
                enabled: input.enabled,
                models: input.models,
            };
            providers::check_provider(&provider)?;
            if let Some(key) = key {
                self.vault()
                    .ensure(&providers::secret_name(&id), &key)
                    .map_err(|e| format!("保存密钥失败：{e}"))?;
            }
            match index {
                Some(i) => store.providers[i] = provider,
                None => store.providers.push(provider),
            }
            store.save(&self.providers_file)?;
            let views = self.views(&store);
            self.regenerate(&mut inner, Ok(store));
            views
        };
        Ok(ProvidersChanged {
            providers,
            models: self.notify(),
        })
    }

    /// `provider_delete`：删除渠道与其密钥，重新生成 Core 配置。
    pub(crate) fn provider_delete(&self, id: &str) -> Result<ProvidersChanged, String> {
        let providers = {
            let mut inner = self.lock();
            let mut store = self.load_for_write();
            let before = store.providers.len();
            store.providers.retain(|p| p.id != id);
            if store.providers.len() == before {
                return Err("渠道不存在，可能已被删除".to_owned());
            }
            store.save(&self.providers_file)?;
            if let Err(e) = self.vault().remove(&providers::secret_name(id)) {
                eprintln!("[core_config] 删除渠道密钥失败：{e}");
            }
            let views = self.views(&store);
            self.regenerate(&mut inner, Ok(store));
            views
        };
        Ok(ProvidersChanged {
            providers,
            models: self.notify(),
        })
    }

    /// `provider_fetch_models` 的参数整理：已保存的渠道从配置与保险库补齐，草稿三项必填。
    pub(crate) fn fetch_target(&self, input: FetchInput) -> Result<FetchTarget, String> {
        let draft_key = input.api_key.as_deref().map(clean_key).transpose()?;
        let target = match &input.id {
            Some(id) => {
                let _inner = self.lock();
                let store = self.load()?;
                let saved = store.get(id).ok_or("渠道不存在，可能已被删除")?;
                let key = match draft_key {
                    Some(key) => key,
                    None => self
                        .vault()
                        .get(&providers::secret_name(id))
                        .map_err(|e| format!("读取密钥失败：{e}"))?
                        .ok_or("该渠道还没有保存 API 密钥")?,
                };
                FetchTarget {
                    api: input.api.unwrap_or(saved.api),
                    base_url: input.base_url.unwrap_or_else(|| saved.base_url.clone()),
                    key,
                    saved: saved.models.clone(),
                }
            }
            None => match (input.api, input.base_url, draft_key) {
                (Some(api), Some(base_url), Some(key)) => FetchTarget {
                    api,
                    base_url,
                    key,
                    saved: Vec::new(),
                },
                _ => return Err("请填写协议、接口地址与 API 密钥".to_owned()),
            },
        };
        let base_url = providers::normalize_base_url(&target.base_url);
        providers::check_base_url(&base_url)?;
        Ok(FetchTarget { base_url, ..target })
    }

    /// 启动时内置渠道的后台获取结果写回：只在该渠道仍然存在、还没有模型、且协议与接口地址与获取时相同时写入，
    /// 避免覆盖用户在获取期间做的修改（获取期间不持锁）。返回是否写入。
    pub(crate) fn save_fetched(
        &self,
        id: &str,
        fetched_from: (Api, &str),
        fetched: &[FetchedModel],
    ) -> Result<bool, String> {
        {
            let mut inner = self.lock();
            let mut store = self.load()?;
            let Some(provider) = store.providers.iter_mut().find(|p| p.id == id) else {
                return Ok(false);
            };
            if !provider.models.is_empty()
                || (provider.api, provider.base_url.as_str()) != fetched_from
            {
                return Ok(false);
            }
            provider.models = providers::merge_models(&[], fetched);
            store.save(&self.providers_file)?;
            self.regenerate(&mut inner, Ok(store));
        }
        self.notify();
        Ok(true)
    }

    /// 获取一个已保存渠道的模型列表并保存（启动时内置渠道用；结果为空或渠道已被用户改动时不写入）。
    pub(crate) async fn fetch_and_save(&self, id: &str) -> Result<usize, String> {
        let target = self.fetch_target(FetchInput {
            id: Some(id.to_owned()),
            api: None,
            base_url: None,
            api_key: None,
        })?;
        let fetched = providers::fetch_models(target.api, &target.base_url, &target.key).await?;
        if fetched.is_empty() || !self.save_fetched(id, (target.api, &target.base_url), &fetched)? {
            return Ok(0);
        }
        Ok(fetched.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::Input;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("primus-core-config-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn model(id: &str) -> ProviderModel {
        ProviderModel::with_defaults(id, None)
    }

    fn provider(id: &str, api: Api, models: &[&str]) -> Provider {
        Provider {
            id: id.to_owned(),
            name: format!("渠道 {id}"),
            api,
            base_url: format!("https://{id}.example/v1"),
            enabled: true,
            models: models.iter().map(|m| model(m)).collect(),
        }
    }

    fn store(providers: Vec<Provider>) -> ProviderStore {
        ProviderStore {
            providers,
            ..ProviderStore::default()
        }
    }

    fn input(id: Option<&str>, name: &str, key: Option<&str>, models: &[&str]) -> ProviderInput {
        ProviderInput {
            id: id.map(str::to_owned),
            name: name.to_owned(),
            api: Api::AnthropicMessages,
            base_url: "https://gw.example/".to_owned(),
            api_key: key.map(str::to_owned),
            enabled: true,
            models: models.iter().map(|m| model(m)).collect(),
        }
    }

    #[test]
    fn models_json_uses_per_provider_secret_commands_and_skips_unusable() {
        let mut big = model("big");
        big.reasoning = true;
        big.input = vec![Input::Text, Input::Image];
        let mut a = provider("gw-a", Api::AnthropicMessages, &[]);
        a.models = vec![big, model("small")];
        let mut disabled = provider("off", Api::OpenAiResponses, &["x"]);
        disabled.enabled = false;
        let s = store(vec![
            a,
            provider("gw-b", Api::OpenAiResponses, &["fast"]),
            disabled,
            provider("empty", Api::OpenAiResponses, &[]),
            provider("nokey", Api::OpenAiResponses, &["y"]),
        ]);
        let (text, models) = models_json(&s, |id| id != "nokey", |id| format!("!cmd {id}"));
        let v: Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<_> = v["providers"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["gw-a", "gw-b"]);
        assert_eq!(v["providers"]["gw-a"]["apiKey"], "!cmd gw-a");
        assert_eq!(v["providers"]["gw-b"]["apiKey"], "!cmd gw-b");
        assert_eq!(v["providers"]["gw-a"]["api"], "anthropic-messages");
        assert_eq!(v["providers"]["gw-a"]["baseUrl"], "https://gw-a.example/v1");
        let m0 = &v["providers"]["gw-a"]["models"][0];
        assert_eq!(m0["input"], json!(["text", "image"]));
        assert_eq!(
            (m0["reasoning"].as_bool(), m0["maxTokens"].as_u64()),
            (Some(true), Some(32_000))
        );
        let keys: Vec<_> = models.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["gw-a/big", "gw-a/small", "gw-b/fast"]);
        assert!(models[0].image && models[0].reasoning && !models[1].image);
        assert_eq!(models[2].api, "openai-responses");

        let (empty, none) = models_json(&ProviderStore::default(), |_| true, |_| String::new());
        assert_eq!(
            serde_json::from_str::<Value>(&empty).unwrap(),
            json!({ "providers": {} })
        );
        assert!(none.is_empty());
    }

    #[test]
    fn secret_command_quotes_path_and_rejects_shell_metacharacters() {
        let cmd = secret_command(
            Path::new(r"C:\Program Files\乾元 Primus\Primus.exe"),
            "ioply",
        )
        .unwrap();
        assert_eq!(
            cmd,
            r#"!"C:\Program Files\乾元 Primus\Primus.exe" --secret provider:ioply"#
        );
        for bad in [
            r#"C:\a"b\P.exe"#,
            r"C:\$x\P.exe",
            r"C:\%x%\P.exe",
            r"C:\a!b\P.exe",
            "C:\\a`b\\P.exe",
        ] {
            assert!(secret_command(Path::new(bad), "ioply").is_err(), "{bad}");
        }
        assert!(secret_command(Path::new("/p"), "Bad Id").is_err());
    }

    #[test]
    fn apply_writes_files_and_falls_back_default() {
        let root = temp_dir("apply");
        let core = root.join("core");
        let vault = Vault::new(&root.join("vault"));
        let exe = Path::new("/opt/primus/Primus");
        vault.set("provider:gw-a", "sk-secret-aaaa").unwrap();
        vault.set("provider:gw-b", "sk-secret-bbbb").unwrap();
        fs::create_dir_all(&core).unwrap();
        fs::write(
            core.join(SETTINGS_FILE),
            r#"{"theme":"dark","defaultProvider":"primus-messages","defaultModel":"kimi"}"#,
        )
        .unwrap();
        let s = store(vec![
            provider("gw-a", Api::AnthropicMessages, &["big"]),
            provider("gw-b", Api::OpenAiResponses, &["fast"]),
        ]);
        let models = apply(&s, &core, &vault, exe).unwrap();
        assert_eq!(models.len(), 2);
        let text = fs::read_to_string(core.join(MODELS_FILE)).unwrap();
        assert!(!text.contains("sk-secret"), "models.json 不含明文密钥");
        assert!(text.contains("--secret provider:gw-a") && text.contains("--secret provider:gw-b"));
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(core.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(settings["theme"], "dark", "保留其他设置");
        assert_eq!(
            current_default(&core).as_deref(),
            Some("gw-a/big"),
            "旧默认模型失效后取第一个"
        );

        set_default(&core, "gw-b/fast").unwrap();
        apply(&s, &core, &vault, exe).unwrap();
        assert_eq!(
            current_default(&core).as_deref(),
            Some("gw-b/fast"),
            "有效的默认值不覆盖"
        );

        // 内容不变时不重写 models.json
        let before = fs::metadata(core.join(MODELS_FILE))
            .unwrap()
            .modified()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        apply(&s, &core, &vault, exe).unwrap();
        assert_eq!(
            fs::metadata(core.join(MODELS_FILE))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );

        // 没有可用模型：空 providers，清除默认模型，保留其他设置
        assert!(
            apply(&ProviderStore::default(), &core, &vault, exe)
                .unwrap()
                .is_empty()
        );
        assert_eq!(current_default(&core), None);
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(core.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(settings["theme"], "dark");
        assert!(apply(&s, &core, &vault, Path::new(r"C:\a!b\P.exe")).is_err());
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

    fn state(tag: &str) -> (PathBuf, ModelConfigState) {
        let root = temp_dir(tag);
        let state = ModelConfigState::new(root.join("core"), root.join("vault"), &root.join("app"));
        (root, state)
    }

    #[test]
    fn seed_only_once_and_migrates_legacy_token() {
        let (root, state) = state("seed");
        let vault = Vault::new(&root.join("vault"));
        vault
            .set(crate::builtin::LEGACY_TOKEN_ID, "old-token")
            .unwrap();
        assert!(state.info().error.is_some(), "未就绪");

        assert!(state.seed_and_migrate(), "首次启动写入内置渠道");
        assert_eq!(
            vault.get(crate::builtin::LEGACY_TOKEN_ID).unwrap(),
            None,
            "旧令牌被删除"
        );
        assert_eq!(
            vault.get("provider:ioply").unwrap().as_deref(),
            Some(crate::builtin::BUILTIN_API_KEY)
        );
        let text = fs::read_to_string(root.join("app").join(PROVIDERS_FILE)).unwrap();
        assert!(!text.contains(crate::builtin::BUILTIN_API_KEY));
        let list = state.providers_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].provider.id, "ioply");
        assert!(list[0].has_key);
        assert_eq!(list[0].key_hint.as_deref(), Some("c74e"));
        let json = serde_json::to_string(&list).unwrap();
        assert!(json.contains("\"hasKey\":true") && json.contains("\"baseUrl\""));
        assert!(
            !json.contains(crate::builtin::BUILTIN_API_KEY),
            "不返回密钥"
        );

        // 内置渠道还没有模型：空配置 + 提示，不崩溃
        let info = state.refresh();
        assert!(info.models.is_empty() && info.default_model.is_none());
        assert_eq!(info.error.as_deref(), Some(NO_MODELS));
        assert_eq!(info.version, Some(1));

        // 用户删掉内置渠道后不再写回
        state.provider_delete("ioply").unwrap();
        assert_eq!(
            vault.get("provider:ioply").unwrap(),
            None,
            "删除渠道同时删除密钥"
        );
        assert!(!state.seed_and_migrate());
        assert!(state.providers_list().unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_creates_updates_and_keeps_key() {
        let (root, state) = state("save");
        let vault = Vault::new(&root.join("vault"));
        state.refresh();
        assert!(
            state
                .provider_save(input(None, "My GW", None, &["m"]))
                .is_err(),
            "新建必须给密钥"
        );
        assert!(
            state
                .provider_save(input(None, "My GW", Some("  "), &["m"]))
                .is_err(),
            "空密钥无效"
        );
        assert!(
            state
                .provider_save(input(None, "My GW", Some("sk-a\nb"), &["m"]))
                .is_err(),
            "含换行的密钥无效"
        );
        let created = state
            .provider_save(input(None, "My GW", Some("sk-first-1234"), &["m1", "m2"]))
            .unwrap();
        let p = &created.providers[0];
        assert_eq!(p.provider.id, "my-gw");
        assert_eq!(p.provider.base_url, "https://gw.example", "去掉末尾的 /");
        assert_eq!(p.key_hint.as_deref(), Some("1234"));
        assert_eq!(created.models.error, None);
        assert_eq!(created.models.default_model.as_deref(), Some("my-gw/m1"));
        assert_eq!(created.models.compaction_model.as_deref(), Some("my-gw/m1"));

        // 同名再建：ID 去重
        let second = state
            .provider_save(input(None, "My GW", Some("sk-second-5678"), &[]))
            .unwrap();
        assert_eq!(second.providers[1].provider.id, "my-gw-2");
        assert_eq!(
            second.models.models.len(),
            2,
            "没有模型的渠道不进 models.json"
        );

        // 修改：不给密钥则保留
        let mut edit = input(Some("my-gw"), "改名", None, &["m2"]);
        edit.enabled = true;
        let updated = state.provider_save(edit).unwrap();
        assert_eq!(updated.providers[0].provider.name, "改名");
        assert_eq!(
            vault.get("provider:my-gw").unwrap().as_deref(),
            Some("sk-first-1234")
        );
        assert_eq!(
            updated.models.default_model.as_deref(),
            Some("my-gw/m2"),
            "默认模型失效后回退"
        );

        // 换密钥、禁用
        let mut disable = input(Some("my-gw"), "改名", Some("sk-new-9999"), &["m2"]);
        disable.enabled = false;
        let disabled = state.provider_save(disable).unwrap();
        assert_eq!(disabled.providers[0].key_hint.as_deref(), Some("9999"));
        assert!(disabled.models.models.is_empty());
        assert_eq!(disabled.models.error.as_deref(), Some(NO_MODELS));

        assert!(
            state
                .provider_save(input(Some("nope"), "x", None, &[]))
                .is_err()
        );
        let mut bad = input(None, "x", Some("k"), &[]);
        bad.base_url = "ftp://x".into();
        assert!(state.provider_save(bad).is_err());
        assert!(state.provider_delete("nope").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn default_choice_and_fetched_merge() {
        let (root, state) = state("default");
        state
            .provider_save(input(None, "gw", Some("sk-key-0000"), &["a", "b"]))
            .unwrap();
        assert_eq!(
            state.set_default("gw/b").unwrap().default_model.as_deref(),
            Some("gw/b")
        );
        assert!(state.set_default("nope/model").is_err());

        // 后台获取结果：渠道已有模型（用户改过）时不覆盖
        let fetched = [
            FetchedModel {
                id: "b".into(),
                display_name: None,
            },
            FetchedModel {
                id: "c".into(),
                display_name: Some("C".into()),
            },
        ];
        let from = (Api::AnthropicMessages, "https://gw.example");
        assert!(!state.save_fetched("gw", from, &fetched).unwrap());
        assert!(!state.save_fetched("nope", from, &fetched).unwrap());
        // 模型为空时写入；协议或地址在获取期间被改过时不写入
        state
            .provider_save(input(Some("gw"), "gw", None, &[]))
            .unwrap();
        assert!(
            !state
                .save_fetched("gw", (Api::OpenAiResponses, "https://gw.example"), &fetched)
                .unwrap()
        );
        assert!(
            !state
                .save_fetched(
                    "gw",
                    (Api::AnthropicMessages, "https://old.example"),
                    &fetched
                )
                .unwrap()
        );
        assert!(state.save_fetched("gw", from, &fetched).unwrap());
        let p = &state.providers_list().unwrap()[0].provider;
        assert_eq!(
            p.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["b", "c"]
        );
        assert_eq!(p.models[1].name, "C");
        assert_eq!(state.info().default_model.as_deref(), Some("gw/b"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fetch_target_resolves_saved_and_draft() {
        let (root, state) = state("fetch");
        state
            .provider_save(input(None, "gw", Some("sk-key-0000"), &["a"]))
            .unwrap();
        let t = state
            .fetch_target(FetchInput {
                id: Some("gw".into()),
                api: None,
                base_url: None,
                api_key: None,
            })
            .unwrap();
        assert_eq!(
            (t.api, t.base_url.as_str(), t.key.as_str()),
            (Api::AnthropicMessages, "https://gw.example", "sk-key-0000")
        );
        assert_eq!(t.saved.len(), 1);
        let t = state
            .fetch_target(FetchInput {
                id: Some("gw".into()),
                api: Some(Api::OpenAiResponses),
                base_url: Some("http://other/v1/".into()),
                api_key: None,
            })
            .unwrap();
        assert_eq!(
            (t.api, t.base_url.as_str()),
            (Api::OpenAiResponses, "http://other/v1")
        );
        let t = state
            .fetch_target(FetchInput {
                id: None,
                api: Some(Api::OpenAiResponses),
                base_url: Some("https://d.example".into()),
                api_key: Some("sk-draft".into()),
            })
            .unwrap();
        assert!(t.saved.is_empty() && t.key == "sk-draft");
        for bad in [
            FetchInput {
                id: None,
                api: Some(Api::OpenAiResponses),
                base_url: Some("https://d".into()),
                api_key: None,
            },
            FetchInput {
                id: None,
                api: Some(Api::OpenAiResponses),
                base_url: Some("ftp://d".into()),
                api_key: Some("k".into()),
            },
            FetchInput {
                id: Some("gw".into()),
                api: None,
                base_url: None,
                api_key: Some(" ".into()),
            },
            FetchInput {
                id: Some("nope".into()),
                api: None,
                base_url: None,
                api_key: None,
            },
        ] {
            assert!(state.fetch_target(bad).is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_providers_file_reports_error_then_recovers_on_save() {
        let (root, state) = state("corrupt");
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("app").join(PROVIDERS_FILE), "{bad").unwrap();
        let info = state.refresh();
        assert!(info.error.unwrap().contains("解析失败") && info.version.is_none());
        assert!(state.providers_list().is_err());
        state
            .provider_save(input(None, "gw", Some("sk-key-0000"), &["a"]))
            .unwrap();
        assert!(root.join("app").join("providers.json.bak").exists());
        assert_eq!(state.providers_list().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn listener_receives_changes() {
        let (root, state) = state("listen");
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        state.set_listener(move |info| sink.lock().unwrap().push(info.models.len()));
        state.refresh();
        state
            .provider_save(input(None, "gw", Some("sk-key-0000"), &["a"]))
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), [0, 1]);
        let _ = fs::remove_dir_all(&root);
    }
}
