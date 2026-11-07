# 0005 账号服务接入前内置模型配置与测试账号

- 状态：已废止（2026-11-07 被 [ADR 0008 用户自配模型渠道与内置 ioply 渠道](0008-user-providers-and-builtin-ioply.md) 取代：内置 `catalog.json`、内置测试账号与 `pnpm smoke:builtin` 均已删除）
- 日期：2026-11-02

## 背景
技术方案第 9 章要求登录 Primus 账号后由账号服务下发模型配置与访问令牌，客户端与仓库都不内置模型密钥（第 17.5 节）。账号服务尚未就绪，项目负责人决定把第 5 周的登录与下发放到最后期，先让 App “装好即可对话”，以便其余功能（多会话、工具卡片、确认框、压缩等）能用真实模型开发与验收。

## 决策
- 薄壳内置一份客户端配置 `apps/desktop/src-tauri/builtin/catalog.json`，格式与账号服务的下发格式相同，经 `core_config` 同一套校验（只两协议、只 HTTPS、不含 `apiKey`）后写入 Core 的 `models.json`。
- 网关访问令牌集中在 `apps/desktop/src-tauri/src/builtin.rs` 的常量 `BUILTIN_API_KEY` 一处（注释“临时内置，后续改为账号服务下发”）。启动时写入 DPAPI 保险库 `data/users/<SID>/vault/secrets.bin`；`models.json` 只含 `!"<Primus.exe>" --secret model-token`，令牌不进命令行参数、环境变量与会话文件。项目负责人明确选择直接内置在代码中（而不是构建时从 CI 密钥注入），并知悉仓库公开的风险，测试后更换令牌。
- `--secret` 模式通过命名 Job Object（`PRIMUS_CORE_JOB`）确认调用方在本 App 的 Core 作业内。
- `auth_status` 返回内置测试账号已登录；`auth_login` / `auth_logout` 返回 `notAvailable`。命令形状（`auth_*`、`models_get` / `models_refresh`，新增 `models_set_default`）保持正式方案的样子，前端不需要为接入账号服务再改接口。
- 网关证书为 Let's Encrypt 签发的 IP 地址证书，Node 自带根证书即可验证，不内置证书、不设 `NODE_EXTRA_CA_CERTS`、不关闭校验。
- CI 每次推送用内置配置对每个内置模型跑一次含工具调用的真实对话（`pnpm smoke:builtin`），日志遮蔽令牌。

## 后果
- 令牌随公开源码与安装包分发，任何人都能取出并使用网关额度；这是测试阶段接受的风险。更换令牌只改 `builtin.rs` 一行，已安装的 App 升级后首次启动自动重写保险库。
- 网关不可用时 CI 的内置模型冒烟会失败，属于外部依赖。
- 接入账号服务时：删除 `builtin` 模块与 `catalog.json`，`ModelConfigState::refresh` 改为调用账号服务的客户端配置接口，令牌改为下发的模型访问令牌，`auth_*` 接入 PKCE 登录；同时删除本 ADR 对第 17.5 节的例外与 AGENTS.md 中的对应说明。
