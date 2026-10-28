# Social Agency 3.2

## 边界与验收状态

本轮重点是归属正确的偏好、值得保留的想法和有条件的表达，不提高发言概率。
保留现有 Social Agent、ReplyPlan、协调器、唯一后台记忆 writer、账号身份与发送闸门。
不扩展 Desktop/Browser Worker、任务执行器或远程工作。源码完成不等于生产启用。

本轮禁止部署、推送、真实 QQ 发送、读取私人空间和付费模型调用。
测试只能使用隔离状态、假协议、假模型或离线回放；真人自然度不能由规则测试自评。

阶段提交顺序：

0. 最新源码与行为差异审计：已完成。
1. 偏好归属与稳定兴趣：源码及离线验收完成，`147e37f`。
2. 有界 Social Intent Journal：源码及离线验收完成，`129b92d`。
3. Discovery 兴趣选择与事件关注：源码及离线验收完成，`6047046`。
4. 参与、表达与连续性：源码及隔离集成验收完成，`efe831f`。
5. 公开来源的 QZone 草稿候选：源码完成，`2383fb4`；后续集成测试补齐了真实 runtime context 检查。
6. 防漂移、反循环、性能、管理及合成对照：见下文；真实模型/真实QQ/真人评测仍未执行，不能宣告社交效果最终验收。

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

| 模块 | 基线能力 | 本轮补齐 |
| --- | --- | --- |
| Social Agent | 同队列、预算、水位、ReplyPlan | 有来源的偏好和被动意图，不增加Agent |
| self-role-card | CAS、版本、冷却，但单次群证据可自动成长 | 稳定自身证据、当前核心哈希、冻结和精确追加回滚 |
| Discovery适配器 | 仅配置兴趣和静态profile | 验证自身兴趣、明确来源、缓存、禁区和固定槽位 |
| Interest Watch | 临时事件关注、TTL、防复活 | 有界持久想法，新事件才能认领，不安装想法定时器 |
| QZone | 显式管理员主题生成、审核、来源证明 | 公开Discovery资料派生待审草稿，不发表 |
| QQ表达 | 群语、语音、表情、拍一拍候选与闸门 | 账号偏好上下文，不增加固定概率或新权限 |

## 实际接入与算法

### 偏好与角色卡

`src/social-preferences.js` 是同步纯状态构建器；所有线上修改都由现有
`mutateMemory`/后台仓库提交。不会启动新的 writer 或单独记忆文件。

归属为 `socialAgents.bots[logicalId].socialPreferences`，每条记录包括
稳定 ID、kind、dimension、value、来源类型、原消息 ID/会话/发送时间/内容哈希、
首次和最近观察时间、程序计算的置信度、核心兼容哈希、有效期、状态及纠正信息。
模型没有置信度、actor 或权限字段。来源和原始时间不从模型 prose 中提取。

- Self：只接受已确认发送且宿主标记 `agencyEligible` 的实际社交回复；直接问答、
  工具结果、引用、旧的无标记经历和其他账号输出不能充当自身偏好证据。
- 稳定 Self 至少三次独立确认、跨两个上海日期且与当前核心一致；管理员确认兼容
  也不能制造缺失的互动次数。普通模型提案仅作候选。
- Group：至少三名真实成员的实际事件，只在当前群投影。Member：精确发送者、
  至少三次独立事件和两个日期；不凭昵称关联，不跨私聊借用。
- 自然过期只读投影，不会被自动写入复活；本机管理员可依据过期后的新事件显式
  重新确认。负反馈、纠正、拒绝及显式过期的墓碑不可复活。
- 冻结阻止自动增长；人工纠正和显式回滚仍可执行。角色卡回滚精确恢复旧字段，
  包括移除后来增加的字段；追加新版本而不是删除历史。
- 自动角色卡只采用经过验证的兼容标签。自由改写表达、互动示例、核心身份及
  重大立场仍进入已有管理员提案流程；冷却、容量或其他失败不悄悄丢掉待审提案。
- 核心提示词、静态兴趣或表达改变后，旧兼容哈希不能继续授权发现或成长。

容量：每逻辑账号最多256项偏好，每项32条证据；Self/Member有效期30天、Group7天。
满额背压，不FIFO删除事实或历史；显式重新确认同样不绕过容量与近期成熟门槛。
字面证据校验偏保守，不能证明语义理解或模型真正喜欢某个兴趣。

### 意图与事件关注

`src/social-intent-journal.js` 保存候选语义，**不是**现有运行器的发送占用账本。
每条带所属逻辑账号、当前群、真实来源、简短要点和动机、触发词、TTL、状态和消耗依据。
最多128条活跃、256条累计，TTL不超过24小时，并受公开素材本身有效期约束。
终态和来源去重栅栏保留，满额背压。读取过期状态不启动模型或写默认字段。

当前运行器可提出候选；后续相关人类消息或新的公开发现才提供再次判断机会。
宿主认领前重查真实新事件、语境、权限、quiet、逻辑身份和预算，不能只认模型给的ID。
`wait/dive + 新意图` 会降为被动观察，不为这条想法安装定时唤醒；已有明确调度且
不携带意图的兼容路径保持原样。定时恢复没有新相关事件时不能消费意图。

一次回复最多认领一条候选。认领后 pending 不再次提供；宿主只有在实际确认的
新回复包含相关触发内容时才记 expressed。部分气泡/不确定ACK不推进已读、不宣称
整轮完成、不重试；已确认的气泡保留真实记录，但不自动撤回。
用户明确针对本账号要求停止时，从实际合并消息中找到停止原句，先取消运行器与
临时关注，再持久取消当前群意图，不因停止句不是最后一条就失效。

继续复用 Interest Watch 的来源校验、短期TTL、取消及事件触发机制；没有扫描journal
产生模型轮次的定时器，不添加第二套Agent、发送队列或自言自语循环。

### 兴趣发现与表达

优先级：管理员明确兴趣 → 静态账号兴趣 → 已验证、自身来源且匹配当前核心哈希的兴趣。
禁区先过滤。Group/Member偏好、原始角色卡字符串、失效/拒绝/来源不明内容不生成搜索词。
管理员兴趣已占满槽位时，成长兴趣不会挤掉它们。

`src/social-agency-context.js` 最多选择 `min(3,maxSearchesPerRound)` 个公开标签，返回来源类型、
排除原因及卡片修订；最多128个缓存项，依据账号、配置、卡片/偏好修订、核心哈希和
到期边界失效。当前轮执行各查询前再检查选择是否有效。开启3.2后无合格兴趣就不搜索，
不绕过禁区补上通用主题；未开启的旧配置保留原默认主题行为。

正常直接回复只增加本地偏好投影，不增加串行审查或规划模型调用。自主规划复用当前
Social Agent、ReplyPlan及发送能力候选。偏好只影响可选表达，不以固定概率强制
表情、语音或拍一拍；能力不可用仍走原有安全降级和回执链路。

### QZone草稿

只有显式开启 `socialAgent.agency.publicDrafts`，且现有QZone策略允许时才接入。
模型只能从宿主提供的本账号公开素材中选择ID及固定动机枚举，不能提供空间正文。
正文只由实际Discovery公开标题/摘要生成，并显式标记未核实；不读取聊天、个人资料、
图片或私人空间。不增模型调用，受众固定64（仅自己）。

调用现有 `qzoneRuntime.open()` 得到受验证上下文，再调用 `createDraft()`；草稿停在
`draft`，保留既有来源证明、指纹去重、人工审核、批准及发表链路。不调用publish、
authorizeAutonomy、点赞、评论或读动态。重复草稿不是重试任务。

## 配置和本机管理

每账号新增 `socialAgent.agency = { enabled:false, publicDrafts:false }`。
旧配置默认关闭，不改变现有发言概率、范围、模型、发送能力和每日调用预算。
本轮只修改源码和安全模板，**未开启任何生产账号**。

侧栏不变：账号功能的现有社交策略内配置开关；问答的角色卡下增加折叠管理区。
可按账号/已配置群/明确成员查看来源、冻结成长、审核偏好、依据新证据重新确认、
取消意图和比较/追加回滚角色卡。管理快照显式刷新，不轮询；状态刷新不替换编辑节点。
使用现有深浅主题、控件和草稿机制，不做另一套App界面。

本机接口（均需既有loopback Host、同源POST及管理员会话令牌）：

- `GET /api/social-agent/accounts/:id/agency?conversation_id=group:...&user_id=...`
  返回配置CAS、偏好修订、冻结、分域偏好、所选群journal及完整角色卡历史。
- `POST .../agency/freeze`：`expectedRevision,preferenceRevision,frozen`。
- `POST .../agency/review`：共同CAS及`id,action`；批准Self需明确`compatibility:"compatible"`。
- `POST .../agency/reconfirm`：共同CAS及`id,evidenceMessageIds`；明确群、可选成员，
  只接受自然TTL到期后的实际新证据，可能仍为候选。
- `POST .../agency/cancel-intent`：共同CAS及`id,journalRevision`，只取消所选群。
- `POST .../agency/rollback`：共同CAS及`cardRevision,targetRevision`，不调用模型。

账号策略保存仍复用已有账户PATCH及版本冲突机制。QQ消息、模型JSON和网页内容
不能提供actor授权。错误不回显原聊天、凭据或思维链；失败保留草稿，不自动重试。

非凭据状态由原普通/完整备份中的memory.json承载。备份恢复保留偏好证据、冻结、
角色卡回滚历史和不可重放pending意图；恢复时旧社交调度仍暂停，journal不会启动发送。

## 可复现验收及成本

使用Node22（本机22.23.2）：

```sh
npm run test:social-agency-32
npm run test:self-role-card
npm run test:social-agent
npm run test:discovery
npm run test:kernel
npm run test:account-isolation
npm run test:backup
npm run test:console
npm run web:release:check
node scripts/social-agency-evaluation.js --summary
node scripts/social-agency-evaluation.js --cases
node scripts/social-agency-evaluation.js --replay-stdin < anonymized-paired-outputs.json
```

固定语料150组、15类各10组，两个版本使用完全相同输入。旧版适配器读取并实际执行
固定a8aa328源码的兴趣/成长/关注逻辑；输出固定blob哈希、提取行及候选文件哈希。
这不是完整旧/新模型进程，不把“不存在journal”曲解为旧版不存在短期关注。

合成规则代理结果：相关标签命中45/150→140/150；40项群友偏好冒充自身兴趣的
提案旧适配器可采用40项，新版0项；已认领重复提供0；过期候选提供0；跨账号
上下文20对均分离。**这些不是发言相关率、观点独立性、事实正确率或真人自然度评分。**

额外验收包括44组偏好用例、1835项journal断言、42组运行器场景、管理VM/DOM交互、
实际串行后台仓库＋假OneBot/TTS/模型HTTP的41项桥接检查，以及公开来源到既有
QZone草稿runtime的集成（协议请求为0）。部分ACK不确定、合并停止句、无新事件
定时恢复、角色卡字段精确删除回滚均有回归。后续新增测试数量以脚本实际输出为准。

性能脚本对同一合成根执行旧版snapshot和新版snapshot＋agency投影：20会话、2560条
消息、64项偏好、64条意图，150个预热后样本；本机初测本地P95增量约4.4ms，
低于100ms门槛。不是模型或网络端到端耗时；不同主机重新运行会得到不同值。

本轮真实模型调用0，真实QQ发送0，没有token计费数据（unknown/null，不冒充0token）。
增加本地上下文可能增加启用后的输入token；脚本另报字符数量，不伪装成供应商计费token。
兴趣数量不增加每轮搜索槽位，草稿生成不新开模型调用，所有实际自主调用仍走原总预算。

管理页49组离线VM/DOM测试通过。另用真实Chrome无头浏览器连接隔离桥接夹具，
验证按账号切换、冻结/解除后通过实际仓库GET回读、账号隔离、深浅主题、390px无横向
溢出及无页面异常，截图仅含虚构数据，留在未提交的`outputs/social-agency-32/`。
UI工作复用app-ui-design-workflow的现有设计路径；没有上传私人配置到Figma。
这不是实际Electron窗口验收；暂存App受下述依赖下载阻塞。

## 尚未通过的效果门槛

- 真实模型同条件A/B、付费token与每日模型成本：本轮禁止调用，未运行。
- 实际QQ原生动作、语音/表情偏好选择及真实QZone协议：未运行。
- 真人盲评、自然度、共情、独立观点、关键事实正确率和打扰程度：未评分。
- 生产App替换、开关启用、GitHub推送及远程CI：本轮未授权，均未执行。
- 暂存App构建已尝试，但官方 `release-assets.githubusercontent.com:443` 连接超时，
  本机也没有Electron44.4.5缓存，因此未完成。`test:packaged-core`因缺少暂存App未通过；
  不降低Electron版本、不关闭证书校验，不以旧App资源假冒新包。

离线通过不等于机器人已经更像人，也不等于所有账号可以扩大发言范围。
后续应先取得指定账号/群和真实模型调用的当次许可，导出匿名成对回放，再由管理员
盲评；不因候选内容“不够活跃”就提高概率、预算或改写原人格。

## 行为例子（预期契约，不是观测评分）

- 成员反复说喜欢某游戏：形成该成员偏好候选，不直接改Bot的Self。
- 群里流行新梗：仅限该群短期上下文，Bot可以不用，不改变核心语气。
- Bot在不同日期真实表达同一兴趣：可积累Self证据；兼容未知时留待核对。
- 曾有值得补充的观点但讨论很忙：保留有期意图；后来收到相关新消息才再判断。
- 对方说停止：取消关注及相关意图，不换群/私聊追问。
- 同一公开素材：一个Bot想作技术补充，另一个Bot选择表情或旁听；是否自然需后续真人评测。
