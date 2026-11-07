# 0008 用户自配模型渠道与内置 ioply 渠道

- 状态：已接受（取代 [ADR 0005](0005-builtin-model-config-and-account.md)）
- 日期：2026-11-07

## 背景
ADR 0005 在账号服务接入前用一份内置客户端配置（`builtin/catalog.json`）+ 内置网关令牌 + “内置测试账号”跑通了对话闭环。实际使用中暴露出几个问题：模型清单写死在安装包里，网关新增或下线模型都要发版；用户想接自己的 OpenAI / Anthropic 兼容网关时没有入口；CI 的内置模型真实冒烟依赖外部网关，经常因限流失败。项目负责人决定：模型由用户在设置中自行管理（“模型渠道”），账号服务以后再接；同时保留一个开箱即用的预置渠道。

## 决策

### 渠道由用户管理
- 设置·模型新增“模型渠道”：用户可添加、编辑、启用 / 停用、删除渠道。一个渠道 = 名称 + 协议（只允许 `openai-responses`、`anthropic-messages`，约束 C1）+ 接口地址（`http://` 或 `https://`）+ API 密钥 + 模型清单（每个模型的上下文长度、最大输出、是否支持图片 / 思考可调）。
- 渠道保存在 `data/users/<SID>/app/providers.json`（`{ version: 1, providers: [...] }`，不含密钥；结构体拒绝未知字段，`apiKey` 出现即整份拒绝）。写入先写同目录临时文件再替换；文件损坏时读取报错并在设置与输入框提示，下一次保存先备份为 `providers.json.bak` 再从空配置开始。
- 每个渠道的密钥存进 DPAPI 保险库 `provider:<渠道 ID>`。返回给 WebView 的只有 `hasKey` 与末 4 位 `keyHint`（密钥少于 8 个字符时不提示）；编辑时 `apiKey` 缺省表示保留已存密钥，空字符串或含控制字符的密钥被拒绝。删除渠道同时删除其密钥。
- Core 的 `models.json` 只收录“启用 + 已存密钥 + 至少一个模型”的渠道，供应商键 = 渠道 ID，`apiKey` 写成 `!"<Primus.exe>" --secret provider:<渠道 ID>`。`--secret` 模式只接受 `provider:<合法渠道 ID>` 形式的名字，Job Object 校验不变。默认模型失效（渠道被删、停用或模型被去掉）时回退为第一个可用模型，没有可用模型时清除；`models_get.error` 给出“还没有可用的模型”。
- 模型列表获取（`provider_fetch_models`）由薄壳发起，不保存：openai-responses 为 `GET {baseUrl}/models`（Bearer），anthropic-messages 为 `GET {baseUrl}/v1/models`（`baseUrl` 已以 `/v1` 结尾时不重复，`x-api-key` + `anthropic-version: 2023-06-01`），15 秒超时、系统代理。错误只返回分类文案（HTTP 状态 / 超时 / 连不上 / 格式不对），不带地址、密钥与响应正文。HTTP 客户端复用自动更新插件依赖树里已有的 `reqwest` 0.13.5 + `rustls` 0.23.46（ring、tls12），不引入新的 HTTP 栈。
- 新增命令 `providers_list`、`provider_save`、`provider_delete`、`provider_fetch_models`、`models_watch`（附录 B）；`models_get` / `models_refresh` / `models_set_default` 形状不变，`models_refresh` 只重读 `providers.json` 并重写 `models.json`，不联网。

### 内置 ioply 渠道（种子）
- 首次启动（`providers.json` 不存在）写入一个预置渠道 `ioply`（openai-responses，`http://218.93.48.244:3304/openai/v1`），密钥写入保险库后再写文件；模型清单为空，启动后在后台获取一次，成功后经 `models_watch` 推送。后台结果只在该渠道仍存在、仍没有模型、协议与地址与获取时相同的情况下写入，不覆盖用户在获取期间的修改。
- 之后该渠道与用户自建的渠道完全一样：用户修改、停用或删除后不会被加回或覆盖。
- 密钥只放在 `apps/desktop/src-tauri/src/builtin.rs` 的常量 `BUILTIN_API_KEY` 一处。项目负责人明确选择直接内置在源码中，并知悉仓库公开、任何人都能取出使用该渠道额度的风险，会自行更换密钥。更换后只影响新安装（已安装的保险库不再被覆盖）。

### 账号与迁移
- 没有账号：`auth_status` 返回 `{ loggedIn: false, account: null, loginAvailable: false }`，`auth_login` / `auth_logout` 返回 `notAvailable`。对话不需要登录；设置·账号显示“未登录”与说明。
- 删除 `builtin/catalog.json`、内置测试账号、`pnpm smoke:builtin`（`scripts/builtin-models.mjs`）与 CI 中的内置模型真实冒烟。
- 旧版安装升级：保险库中的 `model-token` 每次启动删除；旧的内置默认模型不在新列表中，按“默认模型失效”规则回退。

## 后果
- 模型清单不再随版本发布变化；用户可以接任意两协议兼容网关，代价是首次可用依赖 ioply 的模型列表接口可达（不可达时设置页提示用户手动获取）。
- ioply 渠道是内网 HTTP 地址，密钥随公开源码分发；这是项目负责人接受的风险。
- CI 不再有真实模型冒烟；真实模型验证改为发布前人工执行（第 23 章）。
- 接入账号服务时：账号下发的配置作为一个只读渠道并入同一套 `models.json` 生成逻辑，`auth_*` 接入 PKCE 登录；“用户自配渠道”是否保留另行决定并写新 ADR。
