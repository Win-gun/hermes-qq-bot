# Digital Life 3.0

## 实施状态与边界

本轮先进行源代码与隔离验收。用户在恢复任务时已授权通过验证后替换 App；
QQ 实发、付费模型调用、读取真实私人文件、电脑操作仍没有本轮授权。
SnowLuma 2.1.1 不作任何变更。当前发布候选为 beta.26。
不能把纯模拟结果、工具名称、权限声明或完成状态当成真实 GUI 验收。

基线：主仓远端 main 于本轮核对为
`37646fad8283d461d6ccff68ccd5e61c83c3c92b`。之前未提交的 SnowLuma 2.1.1
兼容修复单独保留为本地提交 `b027612`；无关跨平台交接草稿不纳入本轮。
开发分支为 `codex/digital-life-30`，每阶段单独记录测试与未通过的门槛。

## Phase 0：审计与取舍

### 上游版本与许可

本轮用官方 GitHub API 核对 qq-bridge 默认分支 main，最新固定 SHA 仍为
`a49877f4e58d04e47532d44b803360d0f001160d`。该 SHA 的 LICENSE 1–21 行为
MIT，附后的第三方合规说明不属于 MIT；GitHub 元数据 Other/NOASSERTION 不能
替代实际许可文本。引用行为思想不复制其鲸鱼人格；实质复制须附完整许可、版权
与来源文件/版本。SnowLuma、Hermes 和其他依赖的许可分别处理。

已研究以下固定版本文件：

- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`：reserved2 的受限社交、已读
  水位、首答等待、等补句、回复后观察；草稿不自动转发。
- `dsh/agent-presets/qq-chat/agent.cordis.yml`：一代自动转发协议，不能与工具
  发送叠加，否则重复。
- `src/core/session-router.mjs`、`RULES.md`：closed-agent 与 owner 权限、策略
  指纹。模块的权限描述不等于执行拦截；上游实际入口仍有全局模式兼容路径。
- `src/mcp-snowluma-safe.js`：工具注册裁剪、执行复查、agent 标识和等待目的；
  名为 list 的工具可能同步并写盘，不能仅按名称决定读写属性。
- `src/role-card.js`、`roles/README.md`：人格与协议分开、角色片段投影。
- `src/slang-learner.js`、`src/sticker-lib.js`：候选与确认分开、部分同步不删除、
  来源与认知分开；不移植同步记忆 writer 或跨群共用素材备注。

Hermes 已有 Social Agent、ReplyPlan、Interest Watch、唯一 memory writer、
按逻辑身份的任务和发送门；继续复用，不再引入 DSH 或第二套聊天/任务队列。

### 发现的安全缺口

1. 旧 `runHermesAgentTask` 无工具时省略 `-t`，已安装 Hermes CLI 的静态实现
   会回退默认工具；`-t ""` 也不是 deny-all。`--ignore-rules` 只跳过上下文，
   不关闭工具、配置或 MCP。
2. computer grant 导致 sandbox-exec 被跳过；默认浏览器可能使用已配置的 CDP
   登录态。不能继续把这两条原始 CLI 通道作为安全 Work Worker。
3. 授权缺失 TTL、撤销、修订和独立的逻辑身份约束；取消只发 SIGTERM，不等于
   子进程已退出。研究期间取消后仍可能启动进程。
4. 模型非 JSON 输出可能被当成功；落盘与授权目标写入没有完整的取消/结果检查。
   文件读取与产物访问存在仅做词法边界、跟随 symlink 的缺口。
5. 任务通知已有账号/quiet/群发送门，但没有完整任务修订检查；不确定媒体回执后
   换文件重发可能重复交付。
6. 任务管理页请求没有统一附本机管理会话头，产物 URL/预览亦需鉴权 fetch；
   不能把 token 放 URL。

因此实施顺序先封住旧高权限 raw runner，再统一身份、授权与后端。模型仅提出
动作；任务、逻辑身份、能力、授权、目标、有效期及外部回执均由宿主核验。

## 架构契约

一个逻辑身份（`account:<id>` / 显式 `group:<id>`），同一份账号人格，两种能力：
社交运行器负责参与决策，TaskRuntime 负责正式工作调度。工作进程不拥有 QQ
直接发送或权限修改工具。任务运行不阻塞动态聊天协调器。

提示组合分 Core Safety、Social Simulation、Agent Persona、Runtime Context、
Work Agent；人格不携带权限。原始 QQ 消息、网页、工具输出和截图均为数据，
不能签发授权。提示预览不展示密钥或模型内部推理。

能力网关每个动作重查 task/account/logicalBot/grant revision/scope/expiry，
有副作用的动作先持久化 claim，再执行；不确定结果不重放。社交模型没有工作
工具。GUI 是全物理桌面独占资源，租约失效但执行者尚未确认退出时不能偷锁。

任务经历经 TaskRuntime 的宿主快照进入现有 MemoryRuntime.transact；只保存
事实、低敏摘要和产物引用。执行、验证、交付状态分别记录；读时限定 bot、会话
与委托人，重新核实产物是否仍可用。人格、人物事实和工具权限不由经历改写。

## 阶段验收记录

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| 0 | 当前代码与上游差异、安全审计 | 已完成静态审计；发现项待后续修复 |
| 1 | 统一分层提示、人格与社交模式 | 已集成直接、搜索、社交、任务与例行提示；保留原人格 |
| 2 | 同一身份、任务入口与生命周期 | 已集成原队列、带修订/attempt 的任务与取消 |
| 3 | 能力网关、隔离后端、GUI 租约 | 网关与假后端验收通过；真实 Browser/Desktop Worker 未完成 |
| 4 | 工作经历与活动投影 | 已接唯一 memory writer；按 bot/会话/委托人检索 |
| 5 | 按账号管理与鉴权产物操作 | 已集成原任务页，含草稿、CAS、时间线与鉴权预览 |
| 6 | 综合隔离验收、发布/回滚流程 | 隔离集成已通过；实际部署结果另记，不等于真实工作验收 |

## 已实施的安全与运行变化

- `agent-prompt.js` 以固定层序组合提示。人格保持原文，无预设继承；四种社交
  预设只是参与建议，不修改概率、预算或权限。疑似凭据/未展开模板明确拒绝，
  不偷偷改写保存的人格。预览诊断的长度为 UTF-16 字符数，不是 token 数。
  运行上下文总计最多 64k 字符；单个 14k 搜索证据包不因字段布局而被误拒绝。
- 正式 WorkPlan 始终使用绑定的 OpenAI-compatible 纯文本 API，不启动原始
  Hermes CLI，不附原生 tools。启用 `digitalLife.enabled` 的聊天也强制走此通道；
  缺少兼容端点或凭据时明确失败，不回退。没有启用的旧 CLI-only 聊天保留兼容，
  **不属于已验证的工作/社交隔离通道**。当前没有泛化读取 Hermes profile 凭据。
- `work-capabilities.js` 每个动作先持久化 claim，逐次核对逻辑身份、任务 attempt、
  授权修订、期限、目标、能力和后端证明。浏览器/桌面输入、本机写入还需精确
  operation digest 的两分钟单次外写授权。已声明/不确定执行副作用不能恢复重放。
- 普通确认只允许公开研究和当前任务的产物目录；公开研究沿用现有联网绑定，
  过滤证据来源域名。这不是系统全局网络防火墙。浏览器网络隔离未证明时不可用。
- Darwin 的文件后端仅支持宿主创建、当前用户拥有的 `0700` 专用任务目录，
  同步 no-follow、inode、范围、取消检查；不开放本机任意文件读写。它不是原生
  openat，也不抵御恶意同 UID 宿主程序。代码、浏览器、桌面工具不能借此绕入。
- PDF 排版改成异步专用进程组、独立空 profile、CSP、禁止页面网络与脚本；
  取消/超时 TERM→KILL 后等待 close，清理和发布均复查，避免阻塞聊天。
  这是受控格式转换，不是已验收的 Browser Worker。大小监控不是内核磁盘配额。
- `task-delivery.js` 在物理发送闸门持久化投递声明。整次通知贯穿固定的身份、
  attempt、授权与配置修订；取消/撤销后未发送的内容停止，不确定媒体/文件不换
  方式重发。投递状态与任务完成分开，旧通知不在重启后自动重放。
- `agent-life.js` 只接受宿主任务快照，经原 MemoryRuntime 后台写入。保留失败和
  中断的 attempt 历史；委托不等于执行，模型摘要标 `model_unverified`，成功能力
  仅来自对应 attempt 的成功 ledger。整项验收和交付仍标 `unknown`，不伪造证据。
- 任务/API 管理操作需本机 Host、会话令牌和同源写请求。预览/下载通过鉴权 fetch
  创建短期 Blob URL；令牌不放 URL。新页面不新增侧栏，不发送 QQ 测试消息。

## 后端的真实可用性与剩余差距

当前已接生产调用路径的是现有公开检索与任务专用文本/文档产物。以下不能称为
“已实现的真实电脑工作能力”：

1. `work-browser.js` 只有受控新 context 与 opaque handle 实现及假浏览器验收；
   真实 OS/网络隔离、DNS 固定及进程围栏没有完成，因此默认不可用，不接用户
   profile、CDP、系统 cookie，不自动下载安装或启动浏览器。
2. `gui-lease.js` 的进程内物理桌面 FIFO/随机围栏/停止确认已假测，但跨进程桌面
   租约、macOS AX/CG helper、TCC 与原子执行围栏没有完成。Desktop Worker 不可用。
3. RemoteWorkerHost 仅为认证加密/epoch/能力握手契约，不接受任意 URL、shell
   或未认证公网 RPC。代码执行驱动同样没有接入。
4. 尚无已鉴权的整项工作反馈/验收收据模式；模型摘要不会自动变成人物事实或
   “用户已经满意”。管理员人工评测、真实 QQ→浏览器→文件→回忆全链路仍待授权。

新策略默认关闭、不插入旧账号配置；不会自动给现有账号开启电脑权限、改模型、
提升预算、恢复旧任务或共享另一个账号的授权。

## 隔离验证与复现

使用 Node 22，运行 `npm run test:digital-life`：分层提示、经历、能力与租约、
文件边界、计划解析、投递、异步排版、界面及完整桥接集成。
`digital-life-integration-self-test.js` 仅用临时 HOME、loopback 假模型、两个假
OneBot，验证一次文档任务到持久经历、API 账号过滤、草稿冲突、鉴权下载、
opt-in 纯文本聊天及未确认任务不执行；真实模型/QQ/CLI/桌面调用均为零。

相关回归还包括 kernel、account-isolation、social-agent、API Center、console、
backup 与发布白名单。页面以虚构数据在桌面/390px 浏览器检查；打包后需再核对
共享源码与 App ASAR 一致。纯测试和截图不构成真人评分或真实 GUI 验收。

## 发布与回滚门槛

构建使用 `HERMES_QQ_BUILD_OUT` 的独立候选目录，`npm run app:package` 后运行
`npm run test:packaged-core`，检查签名、资源白名单与合成数据 App 预览。
获授权的替换流程：先备份旧 App → 退出并确认旧 writer 已停止 → 备份完整状态
与配置哈希 → 原子切换候选 App → 启动 → 验证版本、两个身份和 OneBot。
模型绑定、凭据来源、账号配置的语义必须不变。失败立即退出新版并恢复旧 App；
本轮仅加法经历结构通常不需恢复记忆；若确需状态回滚，必须先停掉所有 writer，
保留失败现场再恢复快照。不得把旧/新进程并行写入同一个状态目录。

2026-10-26 已按当次授权替换为 beta.26：旧 beta.25 App 和停机状态快照均保留，
使用 APFS copy-on-write 克隆而不是硬链接。实际启动版本、两个账号的真实 QQ
身份与 OneBot 连接已核对；配置文件 SHA-256 未变，群/成员记忆数量保持一致。
新版账号 Agent/电脑权限仍默认关闭；旧社交开关不变。App ASAR 与 Web 共用的
90 个资源一致；DMG/ZIP 已构建并核验。未作本轮真实 QQ 发信、付费模型或 GUI
Worker 验收，不能据部署成功认为 Phase 3 完成。发布源码仅在本地分支提交，
未据此自动推送 GitHub 或声称远端 CI 通过。

## 参考资料

- [qq-bridge 固定版本许可](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/LICENSE)
- [二代社交预设](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/dsh/agent-presets/qq-chat-v2/agent.cordis.yml)
- [会话策略模块](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/core/session-router.mjs)
- [人格分层说明](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/roles/README.md)
