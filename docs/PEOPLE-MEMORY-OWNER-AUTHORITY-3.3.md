# People Memory & Owner Authority 3.3

## 边界与基线

2026-10-28 开始、2026-10-29 继续核对。重新 fetch 后远端 main 为
`ea1b98e3112ac4336367ada424617ea67fa3c626`；开发分支
`codex/people-memory-owner-33`。生产只读审计，没有替换 App、修改生产配置、
启用权限、调用付费模型或发送真实 QQ 消息。

复用 AccountRuntime、MemoryRuntime 唯一后台 writer、原发送闸门、表情库、
任务状态与 WebUI/App 共享页面。没有新增长期记忆 writer、发送队列、shell
工具、Desktop/Browser Worker 或自由 OneBot action 接口。

## Phase 0：真实通知来源

只读检查了生产配置、安全状态计数、用户 LaunchAgent、crontab 和本机 Codex
自动化文件。未输出凭据、通知正文或私人聊天。

- 桥接状态变化通知启用，检查间隔 15 秒。
- 内置周期状态报备启用，每 30 分钟检查发送机会。
- 一个账号的独立 hourly 例行私聊启用，与状态报备接收人重合；另一个账号未开启。
- 旧全局 hourly/daily 是禁用兼容视图，不能据此认定账号目录中的例行任务也关闭。
- 旧 shell 状态报备 LaunchAgent 的 plist 为 Disabled，未加载；未发现用户 crontab。
- 相关 Codex 定时任务处于 PAUSED。另有 Hermes gateway 进程，但仅凭其存在
  不能证明它发送状态通知。没有审计其他用户、系统级或其他主机调度。

强于配置推测的原因证据：有限日志窗口内，hourly 相邻发送间隔不足一小时存在
多次；其中一次间隔约 34 分钟，中间正好发生桥接重启。原
`hourlyChatByOwner.lastSentAt` 只在进程内保存，重启归零，这是提前再发的具体机制。
不能据此声称两次正文完全相同，也不能把未加载的旧脚本当作当前重复源。

参考仓库最新主分支固定为 `a49877f4e58d04e47532d44b803360d0f001160d`：

- [session-router](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/core/session-router.mjs)：策略指纹、会话隔离与失效检查。
- [安全协议工具](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/mcp-snowluma-safe.js)：显式身份标记与返回状态核验。
- [Token Ledger](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/token-ledger.js)、[说明](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/docs/guides/TOKEN_USAGE_CONSOLE.md)：基线、去重、未知归属；其 append 失败处理不能直接作为 Hermes 的持久接受证明。
- [RULES](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/RULES.md)：部分 preset 描述与实际 router 不一致，以执行代码为准。

只借鉴设计，没有复制其完整工具授权、会话 GUI 转发或同步文件 writer。

## 人物长期记忆

`src/people-memory.js` 使用 `peopleMemory.bots[logicalBotId].people[QQ]`。
人物事实、偏好、边界、关系、短期经历与原群兼容层分离；人物、证据、归属及
撤销墓碑都由现有 MemoryRuntime 同步 draft builder 提交，持久成功后才发布。

1. 真实接收时按逻辑身份记录 `groups[jobKey].peopleSourceIndex[messageId]`，包含
   物理账号、真实发送者、原始时间及实际会话，不存消息正文。
2. 共享群提取任务仍只处理一次原文，但来源索引保留每个真正收到消息的 bot。
   未观察到该消息的 peer 不能借另一个 bot 的来源补证。
3. 只将现有提取器已接受、精确来源绑定且与 canonical 条目一致的断言渐进投影。
   不拼接旧群画像，不将仅同名的人合并，不改原 `groups[].users`。
4. 跨群投影只允许足够置信、跨日期证据确认的公开稳定事实。私聊内容和关系边
   默认只在来源范围使用。私聊兼容键保留账号/接管组后缀，不串入另一 bot。
5. 管理员按准确条目 ID 和全局人物修订执行纠正、冻结、撤销、删除。
   墓碑及语义/来源 fence 阻止旧证据重放；原摘要、旧画像和归档检索不能作为
   被控制人物的备用事实再注入。实际聊天存档不会被批量删除。
6. 人物模式启用时，聊天与 `/bot memory` 使用人物索引；旧纠错指令不会仅改
   兼容数组而留下相冲突的新档案。纠错应使用人物管理页。
7. 真实管理变更在同一持久事务递增逻辑身份的 `controlRevision`；失败和无变化
   不递增，普通证据入库也不递增。该修订参与原账号上下文和最终发送门禁。
   管理提交后取消该身份未发出的旧回复、社交和发现工作，不取消独立 peer；
   禁用人物投影也不能绕过这道栅栏。已经发到协议端的内容不能宣称撤回。

`memory.people.enabled` 默认 false。新模式的后台提取使用既有绑定的纯文本 API，
不回退到工具型 CLI；未配置兼容接口时明确失败。旧模式原有调用方式保持兼容。
没有将旧私人画像自动迁移为公开人物信息。容量、过期、归档和拒绝原因见模块导出
`PEOPLE_MEMORY_LIMITS`；满额返回压力，不自动淘汰有效人物或撤销墓碑。

## 主人通知中心

`src/owner-notifications.js` 默认关闭。时间缺省为 Asia/Shanghai 的 09:00、21:00，
最多两个时间点。窗口键绑定主人、当地日期和时间点，不绑定发送物理账号。
修改时区/时间不能重置当天次数。过时窗口不补跑；重启未完成 claim 显示 uncertain，
不会重放。发送前重新验证策略、主人、在线 Carrier、修订和实际持久 claim。

启用中心后，桥接旧状态变化、半小时报备、恢复过程、小时私聊及核实通知不再独立
常规推送；待办进入摘要或管理查询。源代码保留旧配置及回滚能力，不删除旧规则。
旧 shell/Python 脚本在中心开启、探针不可达或响应不明确时拒绝发送，带来源标记；
服务端在最终发送门再次检查，封堵探针与发送之间的竞态。
中心未开启时不擅自修改实际 launchd/cron。

严重告警需要明确 critical 级别、允许代码、持久去重和至少一小时冷却，默认未开启。
普通模型失败只记录 warning，不自动升级成紧急告警。全部 QQ 通道离线时无法通过
这些通道告警；系统不记录假成功。即时主人查询不消耗每天两次的常规窗口。

## 用量、故障与交互账本

- `completeText()` 默认继续返回字符串；可信宿主可要求 `{text,usage,model,provider}`。
  usage 只来自真实 HTTP 响应，缺失/非法字段是 null；模型正文不能提供计数。
- bridge 在调用前持久 claim，真实调用结束后结算。聊天、Social Agent、自写卡、
  Discovery、记忆提取、QZone 草稿、正式任务规划及其他文本调用共用该入口。
  MiMo 官方联网插件也是模型调用，按独立类型计入；插件服务本身费用不能冒充 token。
- CLI 未返回可信用量时明确 unknown。账本区分已记录值、未知调用和未覆盖时段，
  不把部署前历史补成零，不估造价格或兑换成本。仅经宿主独立核实的价格可计算费用。
  调用数是持久登记的调用尝试，包括可能在本地验证失败的尝试，不等于供应商
  已计费请求；Token 只接受供应商响应中的有效数值。主人私聊用确定性摘要显示
  查询时段、已知下界、未知覆盖和费用说明，不截断大段 JSON 后丢失这些限定。
- 按请求开始时间查询 `[from,to)`，今日/七日使用指定时区的自然日边界，支持 DST。
  支持模型、账号、逻辑身份、会话及类型过滤。共享后台提取未有单一 Carrier
  时保留 unknown 归属，不把一次调用重复计给两个 bot。
- Operational Event Ledger 只存脱敏代码、时间、归属、功能、严重级别和恢复事实。
  当前阻碍按最新事件折叠，后续已恢复不继续展示旧的未解决快照。
- 收到的人类消息及有真实 message_id 的成功发送才计入交互记录；回应动作不冒充
  新 QQ 消息。未知、失败、只受理和未覆盖期间分别显示，不计成零。

账本详细调用有七日滚动保留和显式容量限制；未结算 claim 不被静默删除。容量/持久化
问题停止新的受账本约束调用，不自动重试付费操作。高负载性能问题见下方待办。

## 主人命令和持续指令

`src/owner-authority.js` 与 `src/owner-services.js` 是受限业务路由，不是 shell 或
通用 OneBot 代理。只接受真实 Carrier 验证的主人私聊；QQ 文本自称管理员无效。
群内 `/owner`、其他成员、旧配置修订、换绑 Carrier、quiet 和撤权都不能越过最终门禁。

示例（账号和群号均需已明确授权，非生产配置示例）：

```text
/owner status
/owner tokens
/owner tokens 7d
/owner blockers
/owner tasks
/owner history
/owner people <accountId> <QQ>
/owner send <accountId> <groupId> <文字>
/owner sticker <accountId> <groupId> <表情含义>
/owner quiet <accountId> <groupId> <分钟>
/owner resume <accountId> <groupId>
/owner notifications on 09:00,21:00 Asia/Shanghai
/owner autonomy <accountId> off
/owner no-poke <accountId> <groupId> <QQ>
/owner revoke <directiveId>
/owner confirm <commandId>
```

控制写入默认关闭，目标列表默认空。一次性明确指令可在已有目标授权内执行；
配置/持续指令须两分钟内再次确认。可选自然语言解析只提出严格 JSON 候选，
写操作仍需显式确认；模型不能替主人确认、创建新目标授权或指定任意 action。
不明确/重名的目标要求明确账号和 QQ 群，不猜目的地。

回执严格区分 confirmed、accepted、failed、uncertain、blocked、not_supported。
claimed 不等于完成；不确定发送不自动重试。历史只展示脱敏元数据和明确分页范围，
不回显待发送正文或私人提示词。停止拍一拍规则有主人来源、逻辑归属、修订和撤销，
在共享物理发送闸门最终执行；群友不能覆盖它。
账号与日期过滤实际应用于历史，不只是界面标签；过期的待确认提案在只读投影中
标为 blocked / OWNER_APPROVAL_EXPIRED，不再伪装成有效待办。通知 Carrier 选择先
验证私聊范围、文字发送能力和身份，再持久 claim，不固定选首个在线账号。

## 管理页与接口

沿用现有设计系统和导航，WebUI/App 共用：

- 记忆页：人物长期档案，按账号/QQ/明确会话加载，精确 ID 操作。
- 自动化页：主人控制与汇报，时间、时区、开启状态、明确目标及只读查询。
- 自动刷新/迟到请求不覆盖草稿；配置修订与人物全局修订分开。

`/api/owner/status`、`/api/owner/query`、`PATCH /api/owner/settings`、
`/api/people`、`POST /api/people/admin` 都要求本机 Host、管理会话，浏览器请求
必须同源；web-host 代理保留同样的检查。公开策略探针只返回 centralized 布尔值。
读取和界面保存不会发 QQ 消息。

## 验收与回滚

主入口：`npm run test:people-owner`，另运行既有内核、隔离、记忆、通知、界面、
备份、语音、API、任务及发布资源相关回归。使用假 OneBot、假 HTTP 模型、临时
HOME，并拒绝外部网络、外部进程、Keychain 和生产文件访问。

首次完整集成确实发现并修正了：布尔发送封装丢失 ACK、双账号原文去重误丢证据
归属、跨源 GET、提取路径误落到 CLI，以及旧画像通过提取提示词回流。不能以
单模块全绿代替完整宿主闭环。

2026-10-29，Node 22.23.2，复现主入口 `npm run test:people-owner`：

| 验收项 | 实际结果 |
| --- | --- |
| 人物模型、管理修订、后台持久重开 | 114 组通过 |
| 用量与事件账本 | 自测通过，含未知值、保留、容量和恢复投影 |
| 通知核心（假时钟/writer/wire） | 341 项通过 |
| 提取当前 bridge 的通知接线 | 14 场景、86 断言通过 |
| 旧 Python/shell 通知客户端 | 36 场景、506 断言通过，无真实网络及状态写入 |
| 主人命令核心 / 宿主服务 / 实际交互统计 | 40 / 36 / 96 项通过 |
| 页面控制器 | 13 组通过，含草稿、CAS、超时、迟到回复和折叠元数据 |
| 真 bridge + 假 OneBot/HTTP + 临时 HOME | 37 场景通过；4 次假 HTTP（含 2 次提取），真实 QQ/模型/生产 IO 均为 0 |
| 多账号源码隔离回放 | 642 断言通过 |
| 普通 / 加密完整备份恢复 | 137 项通过，含 5 次 3.3 往返 |

另通过 `check`、`test:kernel`、`test:accounts`、`test:memory`、
`test:memory-guards`、`test:memory-verification`、`test:reply`、
`test:bot-commands`、`test:social-agency-32`、`test:social-life-31`、
`test:self-role-card`、`test:digital-life`、`test:discovery`、`test:features`、
`test:api-center`、`test:text-completion`、`test:console`、`test:web-host`、
`test:audit` 及 `web:release:check`。已有 PDF 审计的可选中文提取未设置
Python 依赖，仍跳过，不能算作通过。上面的断言数量不互相相加当作独立场景数。

恢复后的配置保留主人时间、目标及历史 claim，但主人通知与控制开关关闭，
必须明确重新启用。人物证据、私聊隔离、冻结和删除 fence 保留；旧备份不新增
这些开关。孤立通知 claim 只转为 uncertain，不重放。

### 仍未完成或未验证的门槛

- **高负载账本优化未完成。** `node scripts/operational-ledger-benchmark.js`
  提供合法合成夹具，不逐条进行 O(n²) 建库。Node 22 单次样本：1k/7 个维度桶，
  claim + settle 含两次 clone 约 37ms；7k/7k 桶约 423ms；49k/20k 桶约 1.86s，
  JSON 约 31MiB。后者的 query 约 668ms；未包括持久化、发布和其他记忆子树。
  六组均未提前误报容量，但同步全量校验/聚合和根克隆会阻塞回复线程。
  不能以提高容量上限解决；上线长时间采集前应在同一仓库 writer 下改进增量
  聚合/详情分区，并重跑损坏状态、唯一 claim、重启和延迟验收。
- **真实 GUI 仅部分验收。** 在临时 HOME 的实际 bridge 页面验证了加载、
  主人摘要及“编辑后显式刷新仍保留草稿”。发现并修正大段 JSON 挤占操作区。
  IAB/Chrome 的原生确认框后浏览器控制超时，无法完成保存后的真实页面回读；
  HTTP 保存闭环和 VM 交互通过，不等于此 GUI 门槛通过。窄窗口与打包 App
  未完成本轮实测，没有使用生产页面替代隔离验收。
- **线上协议、自然语言实际模型效果、生产早晚通知未验证。** 均未获得本轮
  授权；没有真实 QQ 发送、付费模型调用、App 替换或生产开关修改。
- 查询只提供有限的近期操作详情，达到固定容量会拒绝新操作，不静默遗忘旧 claim。
  共享后台提取的模型调用尚无单一 Carrier 归属时保留 unknown；成本与缺失
  供应商用量不推测。迟到于已 ACK 提取批次的 peer 观察不会自动拼接旧画像补证。
- 审计范围只覆盖本用户、已找到的调度源。显式标记的旧报备客户端被接管，
  不能证明任意未知程序或未标记的本机手工私聊请求都是常规通知；不宣称全主机
  所有程序的发送都被每天两次限制。

源码验收不等于已部署或生产就绪；真实群测试、替换 App、启用生产通知和
GitHub 推送仍分别需要当次授权。本轮没有执行它们。

## 后续授权部署记录：2026-10-29 beta.29

用户另行授权替换 App、沿用最新生产配置并推送 GitHub。以上“未部署”描述
是原源码验收阶段的历史状态，不覆盖本节实际操作记录。

- 已构建并安装 `1.0.0-beta.29`，发布源码基线为 `143d271`；后续文档提交
  不改变安装代码。111 个共享 src/public 文件与候选 ASAR 逐项一致，安装
  ASAR 与候选 SHA-256 一致，候选与暂存 App 均通过 deep/strict 验签。
- Electron 44.4.5 官方 arm64 ZIP 同时匹配锁定 npm 包 checksums.json 与
  官方 release SHA-256；未降低版本、跳过 TLS 或修改全局网络设置。
- 打包 App 在独立状态/端口、无系统 Node PATH 下启动成功；实际原生窗口
  加载管理页、主人通知摘要和权限状态通过。保存确认后的 GUI 回读和窄窗
  验收仍未完成，不能据启动与只读加载推定它们通过。
- 先停桥接、正常退出旧 App，再建立私有 App 备份和停止后的桥接状态克隆，
  校验配置及 memory 哈希后暂存验签、原子替换。未重启协议客户端或容器；
  此状态克隆不是停止容器后的完整迁移备份。
- 恢复运行后两个物理账号连接且实际 QQ 身份匹配，后台记忆仓库可写、
  无恢复要求；生产 config.json 的 SHA-256 与替换前逐字节一致。
- 模型、凭据、人格、预算和范围不变；人物长期档案、主人命令及主人通知
  中心保留生产原来的关闭状态，没有自动开启新权限。没有新增 QQ 发送
  测试或付费模型测试；原有获准的正常机器人行为继续运行。
- 源码已推送现有远端 main。首轮 Linux CI 在隔离夹具的 procfs 存在性
  探针失败；`143d271` 仅放行 Linux `existsSync('/proc/self/fd')` 元数据检查，
  没有放行 procfs 内容读取、FD 打开、外部网络或生产文件。

回滚目录位于本机私有 `Hermes QQ Bot Rollbacks`，实际位置与哈希由未纳入
Git 的 deployment.json 记录。默认只回滚 App、保留部署后的新记忆；若新增了
旧程序不理解的人物撤销栅栏，则阻止直接旧程序回滚。高负载账本问题仍保留，
本次替换不代表该性能门槛已解决。

回滚前先备份停止后的 App/配置及完整状态。保留旧群结构，关闭新人物投影即可
退回兼容读取，但纠正/撤销/删除 fence 仍必须生效，不能通过关闭开关复活旧事实。
回滚程序不盲目覆盖部署后新增记忆；旧版本不理解新撤销 fence 时不得直接上线，
需要先完成隐私安全投影或继续使用支持 fence 的版本。
