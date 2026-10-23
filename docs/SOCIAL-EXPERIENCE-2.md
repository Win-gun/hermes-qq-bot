# Social Experience 2.0 — 实施与验收台账

## Phase 0：源码基线（2026-10-23）

基线提交 `b25346e`，开发分支 `codex/social-experience-2`。不修改生产
配置、记忆、模型绑定或安装中的 App；不发送真实 QQ 消息、不推送远端。
本文件是开发台账，不是部署或真人体验通过的证明。

已阅读 AGENTS、README、PRD、Tech-Spec、SOCIAL-AGENT、SOCIAL-DISCOVERY、
CORE-UPGRADE、MEMORY-VERIFICATION、MULTI-ACCOUNT，以及示例配置和 package。
旧文档的主备称谓与固定人格不是当前运行权威，以账号 registry 和源码为准。

### 当前实际链路与能力矩阵

| 问题 | 源码证据与结论 |
| --- | --- |
| 消息入口 | bridge 的 OneBot callback：身份绑定、去重、原始时间、引用与图片补充、存档/记忆、debounce，再判断参与 |
| 明确消息 | 私聊、@、账号关键词、引用强信号保留快速路径；不能因普通问号认领别人问题 |
| 两套社交判断 | 启用且命中 socialAgent scope 的非直接消息交给 socialRuntime 并 return；其会话跳过旧主动定时器；未启用继续 socialPlanner |
| 合并/刷新 | ReplyCoordinator 按 logicalBotId×conversationId 建 lane，同发言人合并、相关消息取消、最多重生成，独立问题不合并 |
| 首答等待 | shouldWaitForMoreInput 主要是固定 min/base/incomplete 窗口；缺语义轮次与总等待上限 |
| 发送链 | replyDeliveryConfig → sendGroupMessage/oneBotRequest → dispatchAccountAction → GroupSendCoordinator → wire/ACK；每次 wire 检查身份、scope、quiet、类型 |
| 人格 | buildPrompt 与 social callModel 均取 systemPromptForAccount；直接路径有 social continuity 注入，表达协议仍不统一 |
| 多条回复 | social-agent-runtime 校验 messages:string[1..4]，桥接 sendIntent 将其 join；普通回复只收字符串 |
| 图片 | 既有 Vision 描述可复用；需独立验证新媒体 URL/DNS/redirect/大小边界，不能将语音 URL 正则当作图像下载安全证明 |
| 记忆 | 唯一后台 repository writer；人物事实/群摘要共享，bot continuity 按逻辑身份与会话隔离；canonical 证据/纠正不可绕过 |
| 接管 | 仅显式 failover group 共用逻辑身份、策略与当前健康 carrier；平级账号独立决策 |
| UI | 单文件共享管理页；账号 Map 草稿+CAS+fresh readback；QA behavior 目前为全局，不能把新控件误称按账号 |
| 素材 | discovery 为公开网络文字素材，不是群内梗，也不是收藏表情资产；不能相互冒充来源 |
| 持久化 | mutateMemory 同步 latest-draft builder，await 前后复核；不另写 stickers.json 或新的 memory writer |
| 回归 | reply、kernel、social-agent、discovery、account-isolation 在 Node 22 离线基线全部通过；基线 GitHub 完整 CI 成功 |

### 参考源码与许可

已从上游 main 固定到
[`a49877f4e58d04e47532d44b803360d0f001160d`](https://github.com/Derpyu520/qq-bridge/tree/a49877f4e58d04e47532d44b803360d0f001160d)。
检查 reserved2 preset、bridge、sticker-lib、slang-learner、role-card、
session-router、safe MCP、roles/README 与 RULES；研究思想，不执行上游脚本、
不引入 DSH、不复制角色身份。上游人格/工具协议分离、数组语义分条可借鉴；
其首答约 10s 和沉睡前 5min 等待不照搬。

上游 LICENSE 为 MIT（2026 Derpyu520 and qq-bridge / QSH contributors），
该许可不涵盖 SnowLuma；其许可说明将 SnowLuma 标为源码可见非商业许可，
SDK/MCP 包许可还存在单独说明。新增实现保持原创，不捆绑这些组件；如后续
复制实质代码须同时保留版权声明，并独立核实第三方分发资格。

### 模块与迁移决策

- 在现有 debounce/ReplyCoordinator 上添加可测试的轮次判断，不新建 lane。
- 统一 ReplyPlan 只表达内容意图，账号、目标会话、权限和可引用消息由宿主绑定。
- 默认一条，不按空格或字数切碎；JSON 无效时直接消息安全降级。
- 表情索引与群语感使用版本化可选子状态，必须经唯一 writer；读取不能创建
  持久字段，损坏子状态隔离报错而不是覆盖成空库。
- 新策略按账号拥有，显式接管组作为共享 policy；缺省 disabled/shadow，必须
  限定会话。关闭即走旧路径，既有生产开关与人设完全不变。
- 部分发送与不确定 ACK 不重试；只记录确认气泡，剩余内容可取消。重启不重放。
- 表情备注、群梗和网页都是不可信数据；不能成为权限或人格指令。

## 阶段验收

| 阶段 | 状态 |
| --- | --- |
| Phase 0 审计/基线 | 完成，证据见上；待实现后更新差异 |
| Phase 1 自适应轮次/共享 ReplyPlan | 模块、桥接、控制台回归及合成页面交互通过；独立审查的两项 P2 已修正并补测试 |
| Phase 2 表情库/同步/Vision/发送 | 未完成 |
| Phase 3 群梗/语感 | 未完成 |
| Phase 4 人格/原生互动整合 | 未完成 |
| Phase 5 综合/性能/盲评工具 | 未完成；真人盲评独立待验 |

真实 QQ、付费模型批量评测、生产启用、App 替换均需要另行授权。任何未验证
能力保持关闭；离线通过不等于协议端支持或人格评分通过。

## Phase 1 实现证据

- `conversation-turn-manager.js` 本地判断语义未完、显式即时请求、点名与轮次
  总预算；接入原 debounce，保留原事件、合并和 lane。新消息更新现有任务，
  不以普通问号作为参与权限。
- `reply-plan.js` 与 `expression-renderer.js` 共享直接/自主回复的文本计划、
  来源核验引用及顺序 ACK。未配置时保留旧路径；观察模式不修改主提示词或
  出站内容。正式任务输出不经过闲聊分条。
- 分条逐次经过原 `oneBotRequest → dispatchAccountAction`，宿主传入真实目的地、
  quote allowlist、binding 和取消 guard。确认气泡分别归档；未知 ACK 不记经历，
  不重发。已开始发送后新问题只取消剩余部分，不重新生成已发内容。
- `social-experience-policy.js` 作为可选账号 policy（接管组共享、独立账号隔离），
  修改只影响该逻辑身份修订。旧配置无字段不持久化默认值。
- 控制台“账号功能 → 社交表达”仅提交当前账号的 `socialExperience`；未保存、
  冲突、保存后读回与接管组保护沿用原实现。诊断经受认证的
  `GET /api/social-agent/expression-status`，仅有限固定代码/计数，不含原文或思考。

离线命令（Node 22，合成/临时数据）：`test:social-experience`、`test:reply`、
`test:console`、`test:config-revision`、`test:account-isolation`、`test:features`、
`test:kernel`、`test:memory-guards`、`test:social-agent`、`test:backup`、
`web:release:check`、`source:preview` 已通过；后续阶段仍须重跑受影响测试。

`node scripts/social-experience-benchmark.js`：2,000 个本地处理样本，P50 0.006ms、
P95 0.009ms；不含网络和模型，不能作为端到端提速承诺。新增直接路径无额外
串行模型调用；token 和生产吞吐未知。原 continuity 基准 1,000 个投影样本
P95 0.036ms，100 个 1MiB 合成持久化样本 P95 84.953ms；不是生产负载结果。

沿用现有 `social:evaluate -- --fixtures` 的 60 个固定人格×情境样本，已确认
工具可运行。没有人工评分，未宣称拟人化得分或真实 QQ 测试通过。

实际页面验收使用仅含虚构账号的内存预览：A 修改等待上限为 4000 并保存，
切 B 仍为 4500，返回 A 保留 4000；浅色及约 448px 窄窗口无横向溢出。
这不是打包 App 或生产页面验收。独立审查发现计划级素材标记被错误套给
首个气泡，以及学习标记泄漏风险；已按气泡绑定来源/确认收据，并在共享
清洗及解析入口剥离内部标记。分享终结引用已持久化的气泡收据，不二次计数；
部分发送/无可靠素材收据保持 uncertain，不能声称整项素材送达。

SnowLuma 的[官方 LICENSE](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE)
已另外核对：它不是 MIT，公开修改/衍生作品、商业使用等有单独限制。当前
源码不复制或捆绑 SnowLuma/SDK。此核对不等于法律意见或第三方分发授权；
未确认的打包/商用资格不得从上游 qq-bridge 的 MIT 许可推导。
