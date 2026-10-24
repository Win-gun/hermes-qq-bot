# Social Experience 2.0 — 实施与验收台账

## 后续源码：群表情自主学习与消息表情回应

本节是 beta.22 部署之后的源码增量，不是新 App 已替换或生产开关已开启的
声明。两个新能力默认关闭；沿用每个逻辑账号现有会话范围、人格与模型绑定。

### 群表情学习

- 当前群原始人类图片事件进入独立、有界后台学习通道，不依赖账号收藏详情
  接口，不自动把图片加入 QQ 收藏，也不串行阻塞正常回复。
- `socialExperience.stickers.groupLearning` 控制学习，`visionLearning` 控制视觉
  调用，`autonomousEligibility` 允许合格素材无需逐张审批，`autoSend` 仍独立
  控制发送。根策略、实际模式、群范围及图片发送权限都要有效。
- 结合当前文字和同群近期有限人类语境，分别记录视觉含义、观察用途、
  不适用场景和来源消息 ID/真实时间；原始上下文不进入素材 API 或素材账本。
  分类器对照片、文档、聊天截图、隐私及不确定用途的判断不是完美保证，
  不应把“模型给出高分”宣称为绝对内容安全。
- 自动资格由宿主按严格结构、当前策略、图片 hash、用途证据和版本验证；
  不伪造管理员确认。人工拒绝优先，换 URL、重复观察和同步收藏不能复活。
  在途 revision 仍严格校验，已持久资格不绑定重启后会变化的运行 epoch。
- 同内容哈希去重，解释按逻辑账号×群隔离。收藏同步不能停用群来源。
  模型只获得宿主提供的少量合格 ID，不能输出任意图片地址或本机路径。
- 全局单学习处理器，每逻辑账号最多 16 个排队/运行项，单轮硬取消 60 秒，
  200ms 检查策略/身份变化。依赖不响应取消时隔离占位，不并行启动第二次
  不确定调用。原始事件过期或重复不重试，直接消息回复无需等待学习。
- 每日下载缺省 16 次、最多配置 100；视觉共享既有每日 8 次预算。
  下载前持久 claim、模型前预算预留，故障/不确定写入不自动重放。
  反重放账本上限 10,000 条，满额明确停学，不删人物记忆凑容量。
- 新 `sticker-assets` 缓存按逻辑身份隔离，每账号 128 MiB / 500 项，单图
  5 MiB，私有权限、内容校验、不覆盖已有文件、不无限缓存或自动淘汰。
  不支持所需文件安全原语的平台只禁用缓存/新学习，不阻止旧聊天桥接启动。
  不是防御恶意宿主所有者并发替换父目录的 OS 沙箱。

### 消息表情回应

- `socialExperience.reactions` 独立默认关闭；不是表情包气泡或拍一拍。
  首版只提供有明确语义映射的 QQ 表情 `76`（赞），不向模型开放原始动作。
- 宿主从真实当前人类群消息生成短期不透明 ID；模型只可选这些 ID。
  目标最长有效五分钟。直接提问不能仅用一个回应代替答案，计划至多一个
  回应，仍计入同一表达计划的动作数。
- 唯一协议动作是 `set_group_reaction`，参数严格为
  `group_id/message_id/code/is_set:true`。不支持时记录 unsupported，不猜测
  备用动作、不变成拍一拍，也不发送“伪回应”文字。
- 该动作即使不以 `send_` 命名，也通过原同群物理发送闸门，在写线前复核
  quiet、参与、接管、会话范围、文字发送权限与专用策略，并标记真正的
  deliveryStarted。不能绕过闸门，不能给 reaction 注入多余 message 字段。
- 每个逻辑账号每日总上限默认 30 次（跨群合计），同群默认冷却一分钟；
  发送前原子占位，失败或超时不猜测重试，重启不重放。账本背压有上限。
- `retcode=0` 仅记录接口 accepted，不伪造新消息 ID，不写作机器人说过的
  文字/共同经历。accepted、真实聊天 sent、uncertain 在返回值与管理页区分；
  仅回应的自主轮次可正常结束，不因没有新聊天消息而报发送失败。

### 管理、备份与验收范围

共享“账号功能 → 社交表达”加入学习、自动资格、下载预算和消息回应设置；
同一保存区域、草稿隔离与配置 CAS 不变。素材区区分群聊学习/账号收藏、
候选/自动可用/人工确认/禁用，展示用途、预算、缓存及接口状态，不自动测试 QQ。

普通备份包含非凭据素材索引与受限缓存；缓存素材不依赖签名 URL，备份额外
清洗遗留的群素材传输地址。恢复在隔离 incoming 目录验证缓存布局、大小并
恢复 0700/0600 权限后才替换目标。缓存临时文件不进入备份。

验收包含纯模拟模块、真实桥接进程＋假 OneBot/模型/媒体的集成、现有账号
隔离/内核/quiet、备份恢复及 UI 草稿/冲突回归。控制台用虚构数据做实际浏览器
交互与深浅窄窗口检查；不将它等同于新打包 App 或真实 QQ 发送验收。
真实群图片识别效果、当前协议回应支持程度和真实 QQ 显示效果仍需另行部署
及当次授权验证。本轮不升级 SnowLuma，不替换 App，不启用新生产策略。

能力调查与版本差异见 [SnowLuma 核查](GROUP-STICKER-CAPABILITIES.md)。

### beta.23 本机部署核验（2026-10-24）

以上“本轮不部署”描述源码开发阶段。随后收到当次替换与开启生产开关授权，
完成 beta.23 ARM64 App/ZIP/DMG 构建、ad-hoc 签名验证、74 个共享资源逐字节
核对及隔离桌面启动测试后，替换本机安装。停机期间保留旧 App、配置和记忆
快照/日志见证；启动后两个独立账号连接正常，后台记忆仓库可写。

只在原已授权的一个账号、一个群范围内开启群学习、合格素材自动使用和消息
表情回应，其他账号、模型、风格及策略经保存前后比较保持不变。预算维持
下载 16 次/日、视觉 8 次/日、消息回应 30 次/日。配置经管理会话、CAS 保存
并从磁盘及 API 回读；新缓存可用、初始为空。

此次部署未额外发送 QQ 测试消息。当前协议的消息回应能力仍为 unknown，
不能把开关已生效等同于真实 QQ 显示验收；自然触发后的受理、失败和不支持
状态仍按实际回执记录，不以文字假装完成。

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
| Phase 2 表情库/同步/Vision/发送 | 离线实现与桥接接入完成；真实协议/Vision/QQ 试点尚未验收 |
| Phase 3 群梗/语感 | 分逻辑身份×群的候选、审核、统计、检索及 UI 已实现；生产默认不启用 |
| Phase 4 人格/原生互动整合 | 统一表达、引用、语音兼容已接入；拍一拍未验证，明确禁用而非假定支持 |
| Phase 5 综合/性能/盲评工具 | 离线回归、合成基准及 60 场景工具通过；真人评分及生产指标仍待验 |

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
- 相邻气泡按阅读长度在配置的最短/最长间隔间确定性取值，不模拟逐字打字，
  不用随机长等待；原同群物理发送间隔仍可额外延迟，不能绕过它。
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

## Phase 2 / 3：表情与群语感

### 实际接入与权限

```text
真实原始事件 → 账号/会话校验 → 原有 bounded MemoryIntake → 唯一 memory writer
                                   ↓
                          群统计 / 待审核释义
                                   ↓
直接或自主生成 ← 本地相关检索 ← 当前账号、当前群已确认的数据
       ↓
共享 ReplyPlan → 语义气泡 → 原发送闸门 / 当前审批修订 → ACK → 记录实际内容
```

- `sticker-service.js` 仅同步账号已经拥有的 QQ 收藏表情；只调用参考实现中
  确认存在的 `fetch_custom_face_detail`。未支持、超时或脏响应明确失败，不
  猜测其他协议动作。列表存在不证明发送能力，仍需实际 QQ 试点验证。
- `public-media.js` 限公开 HTTP(S) 标准端口，拒绝认证信息和内网地址；所有
  DNS 答案检查、固定连接地址、逐次重定向复验、禁止 HTTPS 降级；限 5MiB、
  15 秒与 PNG/JPEG/GIF/WebP 容器签名。不是完整图像解码安全保证。
- Vision 使用当前账号实际绑定的识图方案，单项管理员触发，有每日预算
  和持久化调用占位；下载后才尝试模型调用。不新增串行回复审查或隐藏服务。
  临时目录 0700、图片 0600，成功或失败均清理；取消/超时终止 CLI 进程组。
- 标注首先是候选，审核绑定逻辑身份、目标会话与 exact revision。模型只
  获得最多 3 个相关的已确认 ID/语义/标签，不得到 URL、字节、路径或收据。
  认真求助场景不提供候选；每表情冷却独立生效，选择完全可放弃。
- 直接回答和社交规划都进入同一个 renderer。社交规划的完整计划由宿主
  校验并用 WeakMap 附加；模型不能靠 JSON 伪造宿主凭据、目标或发送权限。
- 媒体下载/准备失败且确定未尝试发送，才允许计划里的文字替代；进入 wire
  后缺 ACK 或回执不确定不补发。下载后和物理发送队列的 wire 前再检查库修订，
  审批撤销、quiet、账号暂停及接管变化能阻止剩余气泡。
- 只把真实 ACK 的图片记录成“发送了已审核表情”，不把未发的 fallbackText
  记成机器人说过的话。晚到 ACK 可以记录事实，不恢复已撤销的发送权限。
- 不支持自动收藏群友图片，不调用 add/modify 收藏动作；同步和审核不等于
  授权自动发送。新策略根、表情库、视觉学习、自动发送、群语感均可独立关闭。
- 每逻辑库限制 500 个索引、1,000 个会话标注与 10,000 个发送收据，超限
  整笔拒绝，不删旧数据；收据满时准备阶段即拒绝新图片，而不是发出后才发现
  无法记账。视觉预算账本只保留当前及前六个上海日期；不清理人物记忆。

### 群语感不是人物事实

`group-language-learning.js` 是同步 latest-draft builder，没有独立写入器、模型
或定时器。桥接只将当前群的真实人类原始消息放入 bounded intake，不读其他
bot 私聊、不引用第三方内容当本人自证。统计保留长度、间隔、时段、图片与
emoji 比例，不保存聊天全文。规则候选只识别明确的“X 在本群/这里的意思是 Y”，
并保留有限来源证据；不声称已经实现对所有隐晦群梗的自动理解。

候选需本机管理员按 revision 确认后才供该 bot、该群检索；拒绝/撤销记录不
复活，释义 30 天到期。最多 200 候选，超限背压，不偷偷删原记忆。观察模式
允许收集统计和待审核候选，但不把它们注入出站表达。统计、沉默和点赞都不
能授权互损、人格改变或私聊。来源时间异常、重放、损坏 scope 都安全拒绝。

### 配置、界面和 API

按账号的 `socialExperience` 增加：

```json
{
  "stickers": {
    "enabled": false, "autoSend": false, "visionLearning": false,
    "maxDailyVisionCalls": 8, "cooldownMs": 60000
  },
  "language": { "enabled": false, "autoCandidates": true }
}
```

仍需根 `enabled=true`、`shadowMode=false` 和明确的 `conversationIds` 才可能
影响回复；账号 image 发送权限不能被此设置提升。旧配置缺失时不持久化默认值。

侧栏不变，“账号功能 → 社交表达”中统一保存此账号策略；素材管理只列已保存
策略与当前草稿共同允许的范围，切账号/范围取消旧界面结果。管理页不加载远程
图片，不显示来源原文或完整收据。视觉标注逐项确认费用，不后台批量触发。

- `GET /api/social-agent/accounts/:id/expression-library?conversation_id=group:123`
- `POST` 同路径后接 `/sync`、`/annotate`、`/review-sticker`、`/review-language`

所有接口均受既有 loopback Host、本机会话令牌、写入 Origin/JSON 校验保护。
操作携带 `expectedStateRevision`，审核另携带 item `expectedRevision`；每次写入
在唯一 writer 的 latest draft 内复验。失败不自动重试，配置草稿不变。

非凭据数据位于 memory 的可选分支 `socialExpressionAssets`、
`socialExpressionLanguage`、`socialExpressionLibrary`；普通备份保留它们，恢复
不重放图片/模型调用，数据本身不能打开策略。没有新增竞争写入进程或 JSON 文件。

## Phase 4：已支持与明确不支持

人格仍只来自账号原始人设与已授权连续状态，不引入“大肥鱼”默认人设，不
共用独立账号的经历。技术答案保留完整代码、Unicode、URL，语义分条不按空格
切碎。当前消息和已核实历史 ID 才可引用；每个气泡经过原账号路由/quiet 闸门。
强制语音或收到语音需要镜像回复时不提供表情候选；原来的语音识别、TTS、
本人克隆及 VoiceDesign 授权流程不变。

拍一拍尚无当前协议实例的可靠能力回执，故不向模型暴露此动作、不提供假启用
开关；`group_poke`、`friend_poke`、`send_poke` 均明确拒绝，尤其不能因
`group_poke` 名字没有 send_ 前缀而绕过发送规则。后续必须有当次真实测试授权、
协议证据、目标成员证据、频率限制与共享发送闸门，才可实现灰度，不盲开。

## 本轮交付边界与回滚

本轮只修改源码、测试与文档，没有修改运行目录、账号配置、模型绑定、人设、
记忆或权限，没有替换 App、生产启用、调用付费模型或推送 GitHub。
本地阶段提交可作为恢复点；关闭单项 policy 可停止新行为而保留来源与收据，
不需要删库。正式部署前仍需新授权及运行数据备份。

### 最终离线证据（2026-10-24）

- 表达计划/renderer 152 项、社交运行器 43 组、表情/安全媒体 38 组、
  宿主库适配器 36 组、群语感 89 组、UI 22 组全部通过。取消、部分发送、
  未知 ACK、伪造 ID、跨 bot/群、审批撤销、容量与失败不重试均有合成回归。
- 真实 bridge 进程使用临时状态目录、fake OneBot、fake Vision 和公开媒体
  transport，走通同步→单项标注→审核→自主结构化计划→图片 wire→ACK 唯一
  记账，管理请求未发送消息、未调用隐藏模型。它不是实际 QQ 或 MiMo 验收。
- 实际浏览器仅使用虚构账号内存预览，群词义确认后出现 fresh readback 反馈，
  切 B 不串 A 的范围/状态；暗色窄窗口无横向溢出。未验收打包 App。
- `test:accounts`、`test:account-isolation`、`test:kernel`、`test:reply`、
  `test:features`、`test:api-center`、`test:console`、`test:config-revision`、
  `test:memory-guards`、`test:audit`、`test:backup`、普通 memory 备份恢复、
  `web:release:check`、`source:preview` 通过；语法、diff、提交前 secret scan
  单独核对。没有运行远端 CI 或推送远端。
- 新本地基准：2,000 个轮次/计划样本 P95 约 0.01ms；500 条群消息与 100
  表情的 300 个本地检索/库投影样本 P95 约 2ms（以机器负载为准）。均无网络、
  模型或生产负载；端到端延迟、token、吞吐与真人五维评分仍未知。
- `social:evaluate -- --fixtures` 生成 60 个固定人格×情境盲评场景。仅验证工具，
  没有自己给人格辨识、自然度、共情和打扰程度打分，更没有声称达到 4/5。

额外发现并修正旧 `voice-mode-self-test` 的隔离缺陷：它曾沿用示例的本机
协议地址，测试子进程误连该地址，该次结果未计为通过。现清除 forward/
容器入口、补正确 fake login/member/ACK、阻止真实宿主命令，并重跑 15 条
语音模式指令成功；付费语音路由测试新增显式 LIVE opt-in，没有授权时跳过。
不以这次问题推导“真实 QQ 测试成功”或对生产发送情况作无证据保证。

## beta.22 部署追加记录

上述“未部署”是开发阶段状态。2026-10-24 收到新的“替换 App，启用生产”授权后，
构建并替换为 beta.22，保留旧 App、受保护的配置和记忆快照。实际启用范围仅写入
本机账号配置，不写入公开安装包；未扩大其他账号/会话，模型、风格、自动化和
原有社交策略逐项核对未变。打包源码 71 个共享文件比对、ad-hoc 签名、DMG 校验
及隔离桌面启动通过；生产两个账号身份/连接和后台记忆可写已核对。

实际协议对收藏表情读取返回“不支持”，目前表情库没有已审核候选，因此不能
声称真实表情发送已经可用。文字表达、群语感已启用，拍一拍仍禁用；没有通过
部署自动审核素材、批量识图或扩展私人联系权限。真实生成质量与真人盲评仍需
后续独立验收，部署健康检查不替代这些验收。
