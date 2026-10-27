# Social Life 3.1 — 实施与验收

## 基线、范围和授权

2026-10-27 从 `134ff9bc4aef3eb655b6abc02f474e187e0a1216` 开始，在独立
分支 `codex/social-life-31` 开发。远端 main 已复核，上一轮 CI 已通过。
任务执行器继续暂缓；不部署、不推送、不升级协议、不使用真实 QQ 写操作或
付费模型调用。未提交的跨平台交接草稿和本地 outputs 保留。

参考 qq-bridge 固定提交 `a49877f4e58d04e47532d44b803360d0f001160d`，
不是把其 DSH 工具、人设或发送机制搬入 Hermes。实质复用需保留 MIT 声明。

## Phase 0：先审计后实施

| 行为/能力 | 当前事实 | 3.1 工作边界 |
| --- | --- | --- |
| 参与、沉默、主体性 | 已有单一 Social Agent 和四种行为建议 | 分章节选择性投影，保留各账号原人格 |
| 等待、分条和潜水 | 已有动态协调器、ReplyPlan、事件驱动 Interest Watch | 不增加长轮询、第二套发送队列或固定发送频率 |
| 提示词层级 | 管理员私聊重复插入完整组合 system | 消除重复，记录字符和估算 token 成本，不冒充供应商实测 |
| 群梗、记忆卫生和关系 | 已有来源核实、生命周期和负反馈 | 不凭沉默/点赞/互动次数推断亲密或授权 |
| 群表情学习、语义候选 | 已有 group-observed、Vision 预算、缓存和资格审核 | 不依赖 QQ 收藏；补短期人类驱动互动与停止机制 |
| 拍一拍、消息回应 | 已有持久 claim、候选和发送闸门 | 协议支持与开关分开，补交互来源、防循环和限制 |
| QZone | 没有专用运行时；通用请求的 like/comment 会落入只读分支 | 先补显式动作分类与不可绕过权限，再接只读、草稿和审核写入 |
| 跨场景经历 | 已有会话连续性及受理动作记录，但无空间经历 | 同一逻辑身份、来源分区，私聊/空间原文不能投影到群 |
| 管理与测试 | 共用单文件界面、认证、CAS、草稿和现有设计变量 | 原导航不变，配置/支持/授权/回执分开显示 |

### 协议文档与运行事实

官方文档只确定参数契约，不证明运行实例支持。已阅读
[动作目录](https://snowluma.github.io/zh/docs/api)、
[好友动态](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_feeds)、
[说说列表](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_msg_list)、
[发表](https://snowluma.github.io/zh/docs/api/qzone/send_qzone_msg)、
[点赞](https://snowluma.github.io/zh/docs/api/qzone/like_qzone)、
[评论](https://snowluma.github.io/zh/docs/api/qzone/comment_qzone)。
`ugc_right` 的接口默认值是公开，本项目不得使用该默认值，草稿默认 64（仅自己）。
首页与原样游标不表示读取过完整历史；HTML 不进入提示词或系统指令。

本轮新动作真实读/写能力尚未验收，初始一律 unknown。只读成功只能证明该次
读取；写入接口受理与客户端可见需分别记录。不会用接口文档、版本号、配置开关
或合成测试把 unknown 改成 supported。

### 固定上游证据映射（Phase 0 补充审计，2026-10-27）

本节只记录只读审计与迁移取舍，不替代上文的授权和生产验收。
通过 `gh api repos/Derpyu520/qq-bridge/contents/<path>?ref=<sha>` 的 GET
读取下列固定版本；所有来源统一为
`a49877f4e58d04e47532d44b803360d0f001160d`，不以浮动 main 代替。
行号是该固定版本的上游行号；长文件注明实际重点核查的符号/区段，
不把文件存在、提示词宣称或本节阅读当作其整套运行时已通过安全验收。

| 编号与实读路径 | 符号/章节及精确行号 | 本项目取舍：改写借鉴，不是直接代码移植 |
| --- | --- | --- |
| U1 [dsh/agent-presets/qq-chat/agent.cordis.yml](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/dsh/agent-presets/qq-chat/agent.cordis.yml#L29-L49) | L29–49 安全、对象判断、搜索、自动转发 | 借鉴先判断引用对象、如实答复；不搬自动转发、沉默哨兵、原生 MCP 发送或默认视觉能力宣称，避免与 Hermes 发送器叠加。 |
| U2 [dsh/agent-presets/qq-chat-v2/agent.cordis.yml](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/dsh/agent-presets/qq-chat-v2/agent.cordis.yml#L30-L142) | L30–50 工具协议；L56–86 参与/主体性；L94–109 等待/分条；L111–142 离场、记忆、群语感 | 选择性改写为 participation/agency/silence/waiting/rhythm 等章节；不搬工具调用模板、唤醒概率、固定长等待、固定表情频次、故意误答或虚构日常。 |
| U3 [roles/README.md](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/roles/README.md#L9-L55) | L9–24 人格/行为分离；L28–55 按模式取章节与字符预算 | 借鉴职责分层和按需投影；不导入角色卡模板、注入上限或其 token 换算。原账号 persona 保持逐字原文，成本仅本机字符数及明确估算。 |
| U4 [roles/小鲸鱼.md](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/roles/%E5%B0%8F%E9%B2%B8%E9%B1%BC.md#L1-L182) | L1–182 全卡；重点 L16–59、L165–175 表达、节奏与群文化 | 作为必须隔离的人格样本核查；不复制身份、品牌、外形、关系、梗、回复示例、黑名单或 1–10 字风格。合理的对象/节奏原则只从通用行为层改写，不把该角色变成框架默认人格。 |
| U5 [src/role-card.js](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/role-card.js#L39-L108) | `parseRoleSections` L43、`selectRoleText` L67、`roleSectionReport` L81、`roleCharStats` L92；L108 旧指令过滤 | 借鉴显式章节选择和可解释长度；本地用枚举选择行为章节，不复制解析器、正则或按行过滤 persona，不采用其 v1/v2 角色语法。 |
| U6 [src/mcp-snowluma-safe.js](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/mcp-snowluma-safe.js#L153-L190) | `agentApi` L153–169、`agentHeaders` L176–190；旧读门 L278–294；注册裁剪 L298–359、L378–434；等待 L802–824；收藏列表 L1086–1114 | 借鉴调用者身份不能因缺令牌而提权、注册可见性不代替执行检查、等待目的须区分。列表 refresh 实际会同步并写盘，不能按 list 名称当纯读。不移植 MCP 服务、管理令牌通路、长轮询或收藏依赖；仍由本地现有 broker/发送门约束。 |
| U7 [src/sticker-lib.js](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/sticker-lib.js#L1-L303) | `loadStickerStore` L87、`mergeStickerLibrary` L123–166、`buildStickerContext` L233、`buildStickerStrategyHint` L254–265、`applyStickerNote` L269 | 借鉴来源与认知分开、部分同步不代表删除、素材是数据、互动随对方停止；不复制同步 writer、账号级跨群备注、收藏抓取、固定七成回图或 3–5 轮频率。这里只收敛提示建议，不声称已实现/验收完整斗图。 |
| U8 [src/slang-learner.js](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/slang-learner.js#L16-L282) | `SLANG_STATUS` L16；`loadSlang` L111、`saveSlang` L142；`buildSlangContext` L215–229；提取/研究提示 L231–282 | 借鉴候选/确认/拒绝分离、真实来源和不可信语料边界；不搬独立 learner/model 调用、同步持久化、按频次淘汰、跨群共享存储或联网结果自动成为本群含义的假设。 |
| U9 [src/core/session-router.mjs](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/core/session-router.mjs#L1-L623) | 纯路由约束 L1–39；权限描述 L121–130；`normalizePolicy` L231–281；`policyFor` L466；`modeAllowsKey` L528；`policyFingerprint` L536；`setConversation` L545 | 借鉴会话策略 fail-closed、调用层认证与持久审计分工。权限对象只是描述，不是执行边界；不移植 closed-agent owner 默认赋权、预设安装、全局模式兼容或模型/effort 路由。Hermes 原逻辑身份与逐任务授权仍是唯一权威。 |

#### 本地章节片段与来源

下表引用的是本地 `src/social-behavior.js:14–25` 的改写片段，不是上游原文。
“改写并收紧”表示拒绝上游中与本项目授权、可靠问答或事件驱动节奏冲突的建议。

| 本地章节/适用模式 | 具体片段 | 来源与保留边界（同一固定 SHA） |
| --- | --- | --- |
| request / direct、search | “不为表现个性故意误答” | U1 L36–49、U2 L62–86：保留可靠直接回应，明确不采用故意乱答。 |
| participation、agency / social | “旁人的问号、互相引用和群内热闹不是在叫你”；“主体性来自账号已有观点和兴趣” | U2 L56–86、L130–139：相关时选择参与，不增加人格或主持职责。 |
| silence / social | “没有新的人类输入时不自言自语” | U2 L81–101、L111–115 改写并收紧：不采用冷场自动搜索、编造生活话题或无条件继续开口。 |
| waiting / social | “等待目的要区分补句、等回应与离场” | U2 L94–101、U6 L802–824：映射现有 turn/Interest Watch，不复制固定五分钟或长轮询。 |
| rhythm / direct、social、search | “不硬拆短语”；“实际气泡数与发送间隔由宿主约束” | U2 L103–109：保留完整意群；代码、严肃答案与长答请求不能受角色短句限制。 |
| expression / direct、social | “表情互动只能接实际新输入与宿主候选”；“用户停下也停下” | U2 L44–48、L123–128，U7 L254–265：不搬固定概率/轮数，不推断喜好、亲密或发送许可。 |
| memory / direct、social、search | “引用和自己的回复不作群友自证”；“不自行删记忆、复活撤销项或修改人设” | U2 L117–121、U7 L9–12、L120–166、U8 L215–243 改写并收紧；实际证据/审核/唯一 writer 约束来自 Hermes 既有实现，不冒称上游已提供。 |
| boundaries、protocol / 非 task | “熟悉不等于同意”；“预设只是参与建议” | U1 L29–34、U3 L9–24、U6 L176–190、U9 L121–130 仅作边界设计参照；收件人双授权、quiet 与 wire 复查属于本地硬契约，提示词不授予权限。 |
| evidence / search | “无证据时不得宣称已经搜索” | U1 L42–45、U2 L140–142 改写为宿主证据约束；不引入额外搜索模型、工具步骤或成功宣称。 |

direct 不投影 social 的参与/离场/长等待章节；search 仅加事实证据约束，
不带表情互动章节；task 不注入社交章节，原 task 提示正文逐字保持。
四预设只调整表达和参与建议，existing 保留原习惯/空人格兼容；不改宿主概率、
权限、模型或推理档。`previewAgentPrompt` 仅为宿主纯函数，未注册模型/UI 工具。
本阶段没有直接移植上游函数、整章人格、DSH 配置或原生工具协议；行为语义为
独立改写，当前未新增第三方许可文件。若后续实质复制源码或原文，须另附完整
MIT 声明与精确来源，不能把本节作为免除署名/许可义务的依据。

#### 128 场景实际验证范围与缺口

Node `22.23.2` 重跑 `scripts/social-life-behavior-self-test.js` 通过。
它有 16 类、每类 8 个确定性场景；每个场景都断言实际 observed 与 expected
深相等，并检查组合、人设原文、隔离及 baseline，而非只有关键词存在。
但 128 不是 128 个真实社交回复，也不是 128 个完整发送/plan 门控测试：

| 实际执行路径 | 数量 | 已证实/未证实 |
| --- | --- | --- |
| `evaluateConversationTurn`（直接、第三方对象、空输入、补句、立即答、结束、片段节奏） | 56 | 断言 status/reason/waitMs；仅本地轮次建议，不证明真实 sleep/合并队列或最终静默发送。结束语返回 ready 不等于允许发言。 |
| `buildSocialStyleContext`（负反馈、严肃完整性、重复开头） | 24 | 断言 restrained/complete/avoidOpenings 与沉默非负反馈；不证明持久降活跃或 quiet 硬门。 |
| `ingestSocialMessage/getSocialSnapshot/socialContinuityPrompt`（记忆、异逻辑身份） | 16 | 断言去重、原时间、未擅自推进水位、外身份空投影；非完整记忆纠正/持久发布验收。 |
| `socialContactAllowed` | 8 | 实测策略/好友未确认、来源或目标 quiet、静默时段、无同意、无私聊关系的拒绝原因；没有获准联系或真实发送样本。 |
| `createSocialInterestWatch.create/observe/cancel` | 8 | 实测匹配一次、错人/无图/bot/引用不匹配、结束/取消/消费后不再命中；该 8 例没有完整 TTL/重启覆盖，亦未执行发送。 |
| `composeAgentPrompt`（主体性章节、search/task 层隔离） | 16 | 仅组合结果和层选择，不是模型作出的参与决策；没有据此推断自然度、人格表现或工具执行正确。 |

合计 112 个宿主纯函数探针 + 16 个组合探针。该 128 套件没有调用
`validateReplyPlan`、`executeReplyPlan`、调度执行器或真实 wire；不能用提示词里
出现 quiet、wait 或 ReplyPlan 就认定对应硬门通过。独立重跑的既有
`scripts/conversation-turn-self-test.js`（17 项）、
`scripts/social-interest-watch-self-test.js`（TTL、修订、取消、重启）与
`scripts/social-expression-self-test.js`（164 项，真实本地 plan 校验/renderer
函数配合合成回执，含 direct 非回复拒绝、取消、候选与发送 guard）均通过；
这些是额外的源码级合成证据，不计入 128，也不等于桥接端到端或真实 QQ 验收。
成对导出仅合成提示与本地结果，baseline 为 `134ff9b`，不是两组模型回复；
没有自授评分。模型自然度、群友接受度、真实协议回执与客户端可见仍待单独授权
和验收；本轮真实模型调用与 QQ 写操作均为零。

## 实施进度

源码已完成以下基础闭环，但**不是全部 Social Life 3.1 已验收**。
源码测试、真实协议回执、客户端可见和真人体验评分是四种不同证据。

| 阶段 | 本轮实现 | 仍未完成 / 不宣称 |
| --- | --- | --- |
| 0 审计 | 固定版本行为差异、官方参数契约与权限绕行检查 | 新动作真实协议能力保持 unknown |
| 1 行为 | 按 direct/social/search/task 选择章节；移除管理员私聊重复 system；四预设与成本预览 | 不自授人格自然度、人类评分或 token 节省比例 |
| 2 表情 | 独立表情输出复用 renderer；真实人类驱动的定向/来回/斗图状态，短 TTL、最多四次、停止/严肃场景/不确定回执终止 | QQ 新增收藏写入仍拒绝；不从已发图片反向制造无人互动循环 |
| 3 原生互动 | 拍一拍 notice 的宿主证明、持久去重、独立唤醒 ID；复用原 Social Agent、预算和发送门；一次性管理员确认回拍探测 | 好友拍一拍不开放；主动拍陌生人不开放；接口受理不代表对端已显示 |
| 4–5 空间 | 账号独立策略、安全路由、首页/游标读取、手写与模型草稿、逐版本审核、发表/点赞/评论提案与单次执行、仅自己发表重新读取核验 | 无人值守灵感调度与自动发帖触发器尚未接入；图片、16/128 好友名单、删除/改权限等写入不开放 |
| 6 连续性和管理 | 分来源的 Social Episode；空间工作台、行为诊断、受众/频率配置；共享 WebUI/App 源码与回归入口 | App 构建产物一致性、真实 QQ 灰度和真人 A/B 评价待执行 |

### 表情和拍一拍

`sticker-interaction.js` 是原发送路径的短期有界状态，不是第二个队列。
宿主只接受当前账号实际收到的人类消息；引用、转发、机器人消息不能续轮。
单次 source/ticket 在尝试时消费，只有本 bot 确认成功的图片回执推进轮次。
最长硬期限十分钟、静默两分钟结束、最多四次回图；用户停下不会自发继续。
默认 `socialExperience.stickers.interactionEnabled=false`，独立于已有学习开关。

`poke-observation.js` 只接受实际 OneBot notify/poke，目标必须是此登录 QQ，
真实发送时间不超过五分钟；独立 bot 均过滤已知机器人。通知无 QQ message ID，
因此不会伪造 messageId、quote/reaction 目标或聊天 unread seq。重复 notice 不再
触发模型；忙于人类请求时只记录观察，不取消原问题。

通知唤醒只允许 reply/observe，无工具、提醒、搜索、关系或人格修改。
响应实际拍一拍是受控的人类定向交互，不因 proactive=false 而假装无人请求；
仍要求聊天职责、已保存 Social Agent 范围、quiet、载体和发送类型的最终检查。
模型未获原生能力时可选择文字或沉默，不能把 unknown 当 supported。

账号“社交表达”的素材状态内，仅对近期真实 notice 提供“测试一次回拍”按钮；
点击需明确确认。`native-pokes/probe` 校验本机会话、来源句柄和配置 CAS，由服务端
创建不出现在 JSON/模型中的单次授权。目标不能手填，受十分钟跨群目标冷却、
账号日限额与同一物理群发送门约束。不确定结果不重试。
支持证据绑定账号 QQ、载体会话和已知协议版本；重连/接管不能沿用旧载体证明。

### QQ 空间：默认、权限和回执

物理账号的 `accounts.items[].qzone` 不加入 failover 共享人格策略。
空间状态在逻辑 bot 下再按真实 QQ 分隔；同一逻辑人格接管不等于能访问另一 QQ
的私人动态、草稿或授权。默认值：关闭、`draft_only`、`ugcRight=64`、
`allowedAudiences=[64]`，所有读/写开关关闭。

正文草稿最多1000字、每个物理账号最多128份；满额停止新增，不覆盖旧记录。
当前只接受文字，`images` 必须为空。默认每天读取20次、发表2次、点赞5次、
评论2次，均可在高级设置减少；冷却独立计算，所有预算先持久 claim 再请求。
公开/好友可见受众必须先显式配置，公开内容仍须逐条批准。16/128 因缺少安全
名单解析器而明确拒绝，绝不降级为公开。

新增认证接口均在 `/api/social-agent/accounts/:id/` 下：

- `qzone`：仅读取本地状态，不隐式访问远端。
- `qzone/read-feeds`、`read-own`：显式、有限量远端读取。
- `qzone/create-draft`：管理员手写草稿；不授予发布权限。
- `qzone/generate-draft`：仅管理员填写的主题与所选账号人格，一次无工具的当前
  问答模型调用。没有聊天、人物记忆或好友动态输入；计入同一逻辑 bot 自主调用
  总账。输出严格验证、理由持久化，取消/撤销后不落新草稿，不自动重试。
- `qzone/submit-review`、`approve`、`publish`、`verify`、`cancel`：各自独立的
  逐版本操作。配置启用、正文生成、批准、接口受理、可见核验分开记录。
- `qzone/propose-interaction`：仅接受此账号临时动态句柄，不接受 QQ/tid 原值。
- `behavior-preview`、`episodes`：只返回受限宿主元数据或精确会话的经历。

草稿中“是否含私人内容”不是模型保证：私人动态评论为 true，管理员主题或
生成文字为待核对（null）。过滤器只识别明显敏感串，不能取代逐条隐私审核。
API、UI、日志不输出模型原始错误、鉴权信息、原样签名 URL 或动态 HTML。

所有 QZone 名称/别名、点赞评论和收藏写入在通用请求及 Raw 请求入口明确分类；
没有宿主对象证明时直接拒绝。空间动作不能落入普通群聊/私聊发送路径。
证明在实际 wire 前再次检查 QQ、socket、路由、配置、来源、审批、受众、额度。
超时/断线/缺少或矛盾 ACK 均不重放；只有严格拒绝回执才是已知失败。
只有匹配 tid 哈希、正文哈希及 `is_private=true` 的独立自己空间读取，才将
64 受众草稿标记 confirmed。1/4 目前无法从该响应区分真实可见范围，维持未核验。

旧 `scoped_autonomy` 配置可读；内核仍要求先前有效写入证据、明确非公开受众、
精确预配置来源/正文、频率与身份检查。**本轮没有后台自动发表驱动器或其 UI
授权入口**，不能把这些权限检查描述成已经上线的自主空间生活。生产配置未改。

### 经历、恢复和停止

`social-episodes.js` 仅由实际事件/回执写入同一 MemoryRuntime 仓库，区分聊天、
表情、拍一拍、reaction、草稿、发表和空间互动。受理不是“说过一句话”；草稿
不是已发表。私聊/好友动态/仅自己说说不会投影到群；仅已独立核验的本账号公开
发表才具备跨表面投影资格，目前公开可见核验仍未开放。

每逻辑身份最多512份经历投影；满额停止此可选投影并保留旧证据，普通存档与
事实记忆不受影响，未实现自动归档扩容。读取与备份不新增竞争 writer。
安全和完整备份包含非凭据状态；恢复时 approved 退回 review，进行中写入成为
uncertain，失效所有历史能力/审批授权，保留 claim、终态、正文与回执，不自动续发。
空间无隐式群来源的管理员操作使用独立空间开关停止；没有从 quiet 群转到空间
自动发帖的路径。关闭账号/空间、载体变化或配置变化均撤销未开始的请求。

## 验收记录（源码与隔离环境）

Node 22.23.2，未调用付费模型或真实 QQ。没有独立 worker 安全审查结论；
本轮由主代理复查差异，特别核查动作分类、Raw 入口、授权对象、持久 claim、
载体/QQ 隔离与真实 wire 复查，并以负向测试验证。

| 验证 | 实际结果 |
| --- | --- |
| 人格组合 / 固定社交场景 | 46组合检查；128合成场景、16类别，具体局限见上文 |
| 表情互动 / poke 观察 | 108表情互动检查；独立 poke 来源、时间、去重和隔离检查 |
| native wake / native actions | 17唤醒检查；57原生动作检查，含旧载体证明不可继承 |
| QZone 安全核 | 105检查，覆盖权限、CAS、来源、受众、图片拒绝、去重、恢复、回执 |
| 模型草稿 | 17检查：主题/隐私字段、同账预算、错误、并发、取消、撤销、无隐式发布 |
| Social Episode | 49检查，含精确来源投影、私聊隔离、回执和容量无 FIFO 丢失 |
| 共享界面 | 21合成契约场景；真实浏览器检查深/浅主题、390px、配置保存、草稿与审核禁用状态 |
| 桥接端到端 | 2个假 OneBot + 本机假 HTTP 模型；50检查、2次假模型调用；真实模型/QQ写入为0 |
| 备份恢复 | 安全/加密完整/旧格式等102检查，含空间批准失效、不确定操作不重放、旧社交状态缺省和源状态不变 |
| 受影响既有回归 | check、social-experience-21、social-agent、account-isolation、accounts、kernel、console、digital-life、web-host 通过 |
| 发布资源 | Web/source 白名单补齐全部新模块；source preview可构造；本轮未构建/替换 App、未推送，远端 CI 未运行本分支 |

统一入口 `npm run test:social-life-31` 已加入 CI；测试文件使用临时 HOME、合成
身份、假 WebSocket 与 loopback 模型，无生产凭据与真实群聊输入。
还修正了旧账号隔离 VM 测试缺少新导入的夹具问题，没有降低断言或屏蔽真实错误。

本机合成性能测量（不代表生产延迟）：原本地表达处理 P95约0.02ms，500条合成
群消息/100张表情的投影 P95约5.18ms；新增512经历的投影+提示组合 P95约0.048ms。
测试无模型，token/生产吞吐未知。直接问答没有新增串行模型调用；手动空间生成
一次调用计入共享自主预算，拍一拍每个合格新通知至多一轮，不为空闲持续轮询。

## 后续门槛与回滚

后续依次完成：无人值守公开素材灵感/草稿事件接入、严格配置的非公开自主发帖
驱动及 UI；受授权图片解析；安全受众名单；空间可见状态的可靠核验；真人 A/B。
它们未完成不能靠“开关已存在”或合成分数认定完成。QQ 收藏与好友拍一拍继续
不可用；当前文字审核闭环可独立验收，不以这些能力作为前置依赖。

真实协议顺序仍为：当次授权 → 单测试账号只读版本/能力 → 单条表情 → 单次回拍
→ 空间首页 → 草稿 → 逐条批准仅自己可见发表 → 独立核验 → 限定点赞/评论 → 撤销。
未取得该授权前不执行，不复用旧一轮的生产授权。

未来部署前先备份 App、状态和配置；保留旧 App。回滚时停止桥接、关闭新开关，
还原旧 App/已核对的配置后启动；保留新增状态字段，不删除人物记忆或聊天存档。
若需要还原整个状态，使用已验证的加密回滚包，恢复后不重放空间写入或旧社交计划。
本轮没有执行生产切换，因此不需要对运行中 App 做回滚动作。
