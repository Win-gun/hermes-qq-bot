# Digital Life 3.0

## 实施状态与边界

本轮为源代码与隔离验收，不授权部署、QQ 实发、付费模型调用、读取真实文件或
操作用户桌面。已运行的 beta.25 / SnowLuma 2.1.1 不作任何变更。
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
| 1 | 统一分层提示、人格与社交模式 | 实施中 |
| 2 | 同一身份、任务入口与生命周期 | 实施中 |
| 3 | 能力网关、隔离后端、GUI 租约 | 实施中；真实 GUI 不在本轮授权内 |
| 4 | 工作经历与活动投影 | 实施中 |
| 5 | 按账号管理与鉴权产物操作 | 待集成 |
| 6 | 综合隔离验收、发布/回滚流程 | 待执行；不自动发布 |

## 参考资料

- [qq-bridge 固定版本许可](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/LICENSE)
- [二代社交预设](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/dsh/agent-presets/qq-chat-v2/agent.cordis.yml)
- [会话策略模块](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/core/session-router.mjs)
- [人格分层说明](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/roles/README.md)
