# Social Agency 3.2

## 边界与验收状态

本轮重点是归属正确的偏好、值得保留的想法和有条件的表达，不提高发言概率。
保留现有 Social Agent、ReplyPlan、协调器、唯一后台记忆 writer、账号身份与发送闸门。
不扩展 Desktop/Browser Worker、任务执行器或远程工作。源码完成不等于生产启用。

本轮禁止部署、推送、真实 QQ 发送、读取私人空间和付费模型调用。
测试只能使用隔离状态、假协议、假模型或离线回放；真人自然度不能由规则测试自评。

阶段提交顺序：

0. 最新源码与行为差异审计：已完成。
1. 偏好归属与稳定兴趣：实现中。
2. 有界 Social Intent Journal：实现中。
3. Discovery 兴趣选择与事件关注：待集成。
4. 参与、表达与连续性：待集成。
5. 公开来源的 QZone 草稿候选：待集成。
6. 防漂移、反循环、性能和同条件对照：待验收；真实模型/协议/真人评测另列门槛。

## Phase 0：重新核实的版本

2026-10-28 重新 fetch Hermes origin，并用 GitHub API 回读 main：

- Hermes：`a8aa328f2d4dd4da9a438e52e416b9eb2c76580b`，与指定基线相同。
- qq-bridge：`a49877f4e58d04e47532d44b803360d0f001160d`，与指定基线相同。

首次 Git HTTPS 获取遇到连接错误；以保持证书校验的 HTTP/1.1 fetch 成功复核。
不能因为网页星标或缓存显示变化，推断指定源码已有新版本。

固定版本的上游实际审计文件：

- [二代行为协议](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/dsh/agent-presets/qq-chat-v2/agent.cordis.yml)：56–101 的选择性参与、潜水与兴趣开话题是模型提示；117–128 要求清理过期想法及学习，不构成宿主已经执行的证据。
- [安全 MCP 接口](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/mcp-snowluma-safe.js)：653–680 暴露唤醒条件；906–995 提供 activeTopic/pendingThought 等记录工具。数组长度等部分限制存在于schema，但描述中的概率/等待范围不都由该层执行；不能把接口描述当作完整调度实现。
- [角色分层](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/roles/README.md)：9–24 将人格与执行协议分开。
- [角色过滤](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/role-card.js)：43–74、106–108 是模式小节过滤和兼容正则，不是完整成长引擎。
- [群语学习](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/slang-learner.js)：215–228 仅投影confirmed词条；模型返回confirmed并不能单独证明人工审核完成。
- [表情库](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/sticker-lib.js)：233–265 使用次数参与选择，但软频率建议不等于硬发送规则。
- [小鲸鱼人格](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/roles/小鲸鱼.md)：只作差异审计，不移植为所有账号的默认性格。

### 许可

GitHub许可证元数据为NOASSERTION，但[固定版本 LICENSE](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/LICENSE)前21行实际为MIT，署名Derpyu520及贡献者。
其附录涉及外部SnowLuma及依赖风险的自述，不构成我们获得这些第三方权利的证明。
本轮采用独立实现和行为原则转述；如后续实质复制代码/文本，必须保留原版权及完整MIT许可。
不复制品牌人格、固定口头禅、故意乱答、虚构经历、昵称删记忆或无水位ACK。

### Hermes a8aa328 的实际差异

| 模块 | 已有能力 | 3.2 缺口/处理 |
| --- | --- | --- |
| `social-agent-runtime.js` | 同一队列、预算、连续水位、reply/observe/wait/dive、候选表达 | 增加有证据的语义候选元数据，不新增Agent或发送循环 |
| `self-role-card.js` / bridge applyContinuity | 按逻辑账号保存、CAS、历史版本、日冷却 | bridge可在单次群证据上直接采用从属字段；需稳定证据、冻结、比较和回滚 |
| DiscoveryRuntime bridge适配器 | 管理员discovery.interests，其次profile.interests | 未使用经核实的成长兴趣；禁止直接把成长卡字符串当搜索指令 |
| `social-interest-watch.js` | 临时、事件触发、来源和TTL、消费后防复活 | 无持久待表达想法；复用其关注，不添加扫描pending的模型定时器 |
| `qzone-runtime.js` / `qzone-draft.js` | 草稿、来源对象身份证明、人工审核、受众、回执 | 显式管理员主题生成已存在，公开发现尚无自主草稿候选接入 |
| 群语/表情/语音/拍一拍 | 宿主候选、共享ReplyPlan及发送闸门 | 需让不同账号的可验证偏好参与选择，而非增加固定随机概率 |

## 偏好模型契约

归属分为Self、Group、Member，独立存储于逻辑账号的`socialPreferences`。
不是第二份人物事实库，也不是把群流行语升格为账号人格。

- 人类来源由同一逻辑账号、同一会话实际摄取的原始消息解析；引用/机器人消息不作成员自证。
- Self的自动证据只认实际确认发送且由宿主标记合格的自身社交表达，不能直接认成员说“你喜欢”。
- 稳定Self至少三次独立事件、两个上海日期，并有核心兼容依据；未知兼容保留候选，不让模型自报授权。
- Group只描述当前群近期趋势；Member绑定真实QQ及来源群，不凭昵称匹配，不跨私聊投影。
- 每项带来源指针、原始时间、程序置信度、核心兼容性、状态/有效期和负反馈；去重不重复加权。
- 拒绝/纠正具有稳定ID与修订，不模糊删除、不由模型复活。容量满则背压，不FIFO丢弃人格或事实。

## Social Intent Journal 契约

`candidate → pending → expressed / abandoned / expired`仅是想法生命周期，
与现有runtime的`intent_claimed`发送防重账本不同，不是第二条发送队列。

候选绑定逻辑身份、群、实际来源、触发关键词、动机摘要和不超过24小时有效期。
只存简短可审计理由，不存思维链。实际表达须匹配确认发送的自身经历，未知ACK不视为完成。
没有新的人类事件或公开发现时，pending不得唤醒模型。到期、拒绝、quiet、载体变更、
账号停用及预算不足都不能被候选绕过；终止候选不由同一来源重建。

## 兴趣选择与成本

固定优先级：管理员兴趣/禁区 → 静态人格兴趣 → 验证且未过期的自身兴趣。
Group Interest只作为当前群上下文，Member Preference只帮助与本人交流，不作为公开搜索词。
成长卡兴趣必须能对应稳定Self证据，不以自由文本的存在冒充已验证兴趣。

最多选三条安全公开标签，受原有`maxSearchesPerRound`进一步限制。兴趣再多不增加联网次数。
有界本地缓存须被账号、配置、偏好修订、成长卡修订、禁区及到期时间共同隔离。
搜索继续使用该账号实际绑定来源，调用及token沿用现有账本；未知token明确未知。

## 后续集成与验收要求

- 所有写入仅通过现有`mutateMemory`同步latest-draft builder；异步模型/工具不在事务中等待。
- 本机管理接口继续Host/Origin/会话认证及配置+对象CAS；QQ消息不能构造管理员actor。
- QZone只从授权公开素材/管理员预设主题产生文字候选，经既有来源证明创建draft；不读私聊、私人动态或群图片，不自动发表/点赞/评论。
- 偏好冻结阻止自动成长；回滚采用追加版本，保留原版本及纠正原因，不破坏已有历史。
- 至少150同条件场景覆盖相关性、误插话、重复、人格/观点、打扰、事实及成本。
- 合成规则/离线回放、真实模型A/B、QQ协议和真人评分必须分别报告。未获授权的付费/真人/协议门槛保持“未运行”，不能用全绿规则替代自然度提升。

## 行为例子（预期契约，不是观测评分）

- 成员反复说喜欢某游戏：形成该成员偏好候选，不直接改Bot的Self。
- 群里流行新梗：仅限该群短期上下文，Bot可以不用，不改变核心语气。
- Bot在不同日期真实表达同一兴趣：可积累Self证据；兼容未知时留待核对。
- 曾有值得补充的观点但讨论很忙：保留有期意图；后来收到相关新消息才再判断。
- 对方说停止：取消关注及相关意图，不换群/私聊追问。
- 同一公开素材：一个Bot想作技术补充，另一个Bot选择表情或旁听；是否自然需后续真人评测。
