# Hermes QQ Bot（本地测试版）

本仓库包含同一套 QQ 机器人桥接服务的两种本地入口：浏览器 WebUI 和 Apple Silicon macOS Electron 应用。两者共用桥接、管理页与备份核心；WebUI 宿主提供本机备份和运行管理 API，App 提供原生文件选择、Finder 定位和菜单栏入口。

目前仍是 beta；已知验证范围与尚未完成的跨设备验收见 [开源发布清单](docs/OPEN-SOURCE-CHECKLIST.md)。两种入口的对应功能见 [功能一致性清单](docs/EDITION-PARITY.md)，桌面构建、安装与迁移说明见 [桌面分发指南](docs/DESKTOP-DISTRIBUTION.md)。

本公开仓库从经过安全审查的干净快照建立，不包含开发机的原有 Git 历史或运行数据。`npm run source:preview` 可生成可复核的源码候选包。项目采用 [MIT 许可证](LICENSE)。

`npm run web:start` 与打包 App 默认使用同一数据目录：`~/Library/Application Support/Hermes QQ Bot/`。同一时间只能有一个本机宿主接管 QQ；App 遇到同一数据目录的 WebUI 宿主时会连接现有服务，不启动第二个桥接。旧的 `npm start` 仍是开发兼容入口，默认在项目目录读取 `config.json` 和 `data/`，不提供完整的宿主管理能力。两处数据都可能包含账号、聊天记录或凭据，不应提交到 Git 或打入安装包。

当前处理 `config.json` 里的 `targetGroups`。设为 `["*"]` 时，会在机器人加入的所有群里聊天。

## 管理页面

桥接服务启动后，可以在本机打开：

```text
http://127.0.0.1:6200/admin
```

管理页提供：

- 查看 OneBot / QQ 连接状态、日志尾部和当前队列；
- 展示 NapCat 登录二维码，打开 NapCat WebUI，重启 NapCat；
- 开关联网搜索，调整 Google / 百度搜索配置和代理端口；
- 调整活跃度、默认克制/正常/活跃模式、主动插话概率和冷却；
- 编辑系统提示词；
- 调整 Hermes 调用命令、provider、model、args、超时和 API key 环境变量名；
- 测试模型调用；
- 查看、搜索、导出 `data/memory.json`；
- 从页面发送测试群消息、重启桥接服务。

管理页默认只监听 `127.0.0.1`。API key 不会在页面里保存明文；如需切换密钥，请在运行环境中配置对应环境变量，再在页面填写环境变量名。

## 启动

以下命令启动完整的本地 WebUI 版。需要 Node.js 22.12–25、Hermes CLI，以及已配置的 OneBot 协议端；QQ 登录和模型认证需在本机分别完成。

```bash
npm ci --omit=dev
npm run web:start
```

桌面应用从同一仓库构建，并使用同一默认数据目录；不要直接复制旧项目的实时数据进应用包。WebUI 与 App 的备份、恢复和旧项目迁移均在管理页的“备份与迁移”中完成。参见[桌面分发指南](docs/DESKTOP-DISTRIBUTION.md)。

桥接监听：

```text
ws://127.0.0.1:6199/onebot
```

如果 NapCat 跑在 Docker 里，反向 WebSocket 地址通常要填：

```text
ws://host.docker.internal:6199/onebot
```

## NapCat 配置

在 NapCat WebUI 中：

1. 登录 QQ 小号。
2. 打开 OneBot / 网络配置。
3. 新增 WebSocket 客户端 / 反向 WebSocket。
4. URL 填 `ws://127.0.0.1:6199/onebot`，Docker 环境用 `host.docker.internal`。
5. 消息格式建议使用 `string` 或 OneBot v11 默认格式。

## 群 ID

OneBot 的 `group_id` 不一定等于群名。如果桥接日志出现：

```text
ignored group message from group_id=...
```

把日志里的真实 `group_id` 写入 `config.json` 的 `targetGroups`，然后重启桥接。

如果要允许所有群：

```json
"targetGroups": ["*"]
```

私聊窗口默认也会回复：

```json
"privateChats": {
  "enabled": true,
  "targetUsers": ["*"]
}
```

如果只想回复指定私聊对象，把 `targetUsers` 改成 QQ 号列表；如果不想处理私聊，把 `enabled` 改成 `false`。

## 回复策略

默认策略比较保守：

- @ 机器人：必回。
- 消息里包含 `Hermes`、`小跟班`、`机器人`、`GPT`：会回。
- 私聊机器人：会直接回复，不需要 @ 或关键词。
- 没有 @ 但像是在接机器人上一句话：会判断为“隐式对话”并积极回复。
- 普通无关消息：只保留较低概率主动接话，避免“每句都接”。
- 多人正在讨论、问观点、抛选择题时，会进入“讨论参与”加成，但仍保持克制。
- 定时主动发言：只在最近 10 分钟内有真人消息时，按概率插一句；bot 自己发完后，如果没人接话，不会继续自言自语。
- 主动插话会先做上下文判断；纯问号、纯图、低信息量消息通常会跳过。
- 如果群友说“话真密”“谁问你了”“别插嘴”“话好多”“每句都接”等负反馈，会自动降低该群主动性一段时间。
- 多人同时跟 bot 说话时，同一个群会按队列逐条回复，避免并发刷屏，也避免漏掉明确对它说的话。

你可以在 `config.json` 里调整概率和冷却时间。

## 活跃 / 正常 / 克制模式

每个群可以用一句指令切换 bot 的主动程度：

```text
/bot mode restrained
/bot mode normal
/bot mode lively
```

也可以用中文：

```text
/bot 克制
/bot 正常
/bot 活泼
/bot 活跃
```

- `normal` / `正常版`：等于之前的克制版；无关聊天少接，被 @、私聊、关键词、明显接 bot 的话仍会回。
- `restrained` / `克制版`：新的更安静档；更少主动接话，只在明确 cue 到、强相关或必要时回复。
- `lively` / `活跃版`：保持原活泼/活跃参数；更愿意参与讨论，但仍保留“没人说话不自言自语”的保护。

查看当前模式：

```text
/bot mode
/bot status
```

查看记忆：

```text
/bot memory
/bot memory @某人
/bot memory 123456
```

`/bot memory` 默认只输出发命令者在当前群里的记忆；带 `@某人` 或 QQ 号时，输出指定群友在当前群里的记忆，不再默认展开 bot 自我记忆或整群记忆。

记忆命令不会使用普通聊天的 `send.maxLength` 截断，而是按 `commands.memoryChunkLength` 自动分段发送，默认每段约 1200 字，尽量完整输出该群友的记忆内容；分段之间会按 `commands.chunkDelayMs` 间隔发送，默认约 1 秒。

## 隐式对话识别

当群友没有 @ 机器人，也没有提关键词，但消息像是在接机器人上一句话，例如：

```text
那你刚才还说可以？
错了
为什么
？
谁问你了
继续说
```

桥接会结合上下文判断是不是在跟机器人说话。如果满足条件，会绕过随机主动概率，直接回复。

相关配置：

```json
"implicitReply": {
  "enabled": true,
  "windowMs": 480000,
  "maxMessagesAfterBot": 8,
  "earlyMessagesAfterBot": 2,
  "immediateFollowupBoost": 0.38,
  "earlyFollowupBoost": 0.28,
  "nearMessagesAfterBot": 3,
  "confidenceThreshold": 0.55,
  "cooldownMs": 10000,
  "replyToMessage": true
}
```

- `windowMs`: 机器人上一句话多久内才算可接续。
- `maxMessagesAfterBot`: 机器人说完后，中间最多隔几条群友消息；如果消息里有明显“你/你刚才/为什么”等指向 bot 的词，会更积极判断。
- `earlyMessagesAfterBot`: bot 发言后的前几条消息会被重点判断是否在接 bot。
- `immediateFollowupBoost`: bot 后第一条消息的额外置信度加成。
- `earlyFollowupBoost`: bot 后第二条左右消息的额外置信度加成。
- `nearMessagesAfterBot`: 中间隔得很近时，短追问/短评价会额外加分。
- `mentionedUserFollowupBoost`: 如果 bot 上一句 @ 或提到某个群友，而该群友随后发言，会额外提高“在接 bot”的置信度。
- `mentionedUserMaxMessagesAfterBot`: bot 提到某人后，最多隔几条消息仍然考虑该人的后续发言与 bot 有关。
- `confidenceThreshold`: 判断为“在跟 bot 说话”的置信度阈值；当前比之前更克制，弱相关消息会少回。
- `replyToMessage`: 隐式回复时是否引用原消息。

## 讨论参与度

机器人会观察最近几条消息里是否存在多人来回讨论、提问、征求观点或选择分歧。命中后，它会提高主动参与概率，但仍会跳过纯表情、纯图片、低信息量消息和近期有负反馈的群。

相关配置：

```json
"discussionParticipation": {
  "enabled": true,
  "activeProbabilityBoost": 0.12,
  "maxActiveProbability": 0.38,
  "proactiveProbabilityBoost": 0.08,
  "maxProactiveProbability": 0.45,
  "minRecentDistinctSpeakers": 2
}
```

定时主动发言还受 `proactive` 控制：

```json
"proactive": {
  "intervalMs": 180000,
  "probability": 0.25,
  "cooldownMs": 900000,
  "activeWindowMs": 600000,
  "requireHumanAfterBot": true
}
```

- `activeWindowMs`: 最近多久内有真人消息，才允许定时主动插话。
- `requireHumanAfterBot`: bot 发完后必须等群友再说话，才允许下一次定时主动插话。

## 回复队列

为了应对多人同时跟 bot 说话，桥接会按群串行处理回复任务：

```json
"responseQueue": {
  "enabled": true,
  "minDelayMs": 1000
}
```

- @、关键词、隐式接话、已选中的主动接话都会入队。
- 同一个群按顺序逐条生成和发送。
- `minDelayMs` 控制两条回复之间的最小间隔。
- 定向消息不会再因为关键词/隐式冷却被直接丢掉。

## 记忆重整器

如果旧记忆已经积累得比较乱，可以用专门的重整器把每个群、每个成员的旧字段交给 AI 重新归类、合并语义重复项，并写入新的 `canonicalMemory` 字段。旧字段会保留兼容，正式回复 prompt 会优先使用 `canonicalMemory`。

先检查计划，不调用 AI：

```bash
npm run memory:rebuild -- --check
```

默认 dry-run 会调用 AI 分析，但不会改写 `data/memory.json`，只生成报告：

```bash
npm run memory:rebuild
```

限制范围：

```bash
npm run memory:rebuild -- --group 364433603
npm run memory:rebuild -- --group 364433603 --user 123456
npm run memory:rebuild -- --limit 5
```

确认报告没问题后再应用：

```bash
npm run memory:rebuild:apply
```

`--apply` 会先备份当前记忆到：

```text
data/memory.json.bak.<timestamp>
```

每次运行都会生成报告：

```text
data/memory-rebuild-report.<timestamp>.json
```

报告里会列出每个群整理了多少人、输入/输出记忆项数量，以及合并或删除了多少重复/低价值项。

## 分层上下文

回复时不只看最后一句，会组合：

- 最近 20–30 条原始聊天；
- 更早聊天的滚动摘要；
- 当前话题和未完结内容；
- 当前发言者、被提到的人、最近活跃群友的记忆；
- 本群近期是否对 bot 有“话多/插嘴”的负反馈。

相关配置：

```json
"history": {
  "rawMaxMessages": 120,
  "promptRecentMessages": 28,
  "summaryAfterMessages": 40,
  "rollingSummaryMaxLength": 800
}
```

## AI 模型配置

桥接通过 `config.json` 的 `ai` 字段调用 Hermes：

```json
"ai": {
  "command": "hermesqq2",
  "args": ["--provider", "deepseek", "-m", "deepseek-v4-flash", "-z"],
  "timeoutMs": 120000
}
```

当前 Hermes profile 同步配置为 `deepseek-v4-flash`，并把 `agent.reasoning_effort` 设为 `high`。`display.show_reasoning` 保持关闭，避免把思考过程发到 QQ 群里。

## 受控联网搜索

默认普通聊天不会联网。群消息里先出现搜索候选词，随后会由 AI 裁判判断是否真的需要联网；只有 AI 明确判定需要搜索时，bot 才会先发确认消息，然后进入 `mode=web` 搜索并回复。例如：

```text
小跟班 搜一下 DeepSeek V4 Flash
联网查一下今天的 AI 新闻
帮我查某个报错是什么意思
最新 iPhone 消息
小跟班，今天北京天气怎么样
查一下这个
```

相关配置：

```json
"webSearch": {
  "enabled": true,
  "aiJudge": {
    "enabled": true,
    "minConfidence": 0.55,
    "timeoutMs": 120000,
    "fallback": "skip"
  },
  "provider": "google",
  "providerOrder": ["google", "baidu"],
  "maxResults": 4,
  "timeoutMs": 8000,
  "aggregateProviders": false,
  "minResultScore": 1,
  "proxy": {
    "enabled": true,
    "autoDetect": true,
    "urls": ["http://127.0.0.1:7897", "http://127.0.0.1:7890"],
    "directFallback": true
  },
  "google": {
    "proxy": true,
    "newsLang": "zh-CN",
    "newsRegion": "CN",
    "newsCeid": "CN:zh-Hans"
  },
  "baidu": {
    "proxy": false
  },
  "appendDateForFreshQueries": true,
  "weather": {
    "enabled": true,
    "provider": "wttr.in",
    "timeoutMs": 8000
  },
  "preReply": {
    "enabled": true,
    "replyToMessage": true,
    "templates": ["我搜一下，等我几秒。", "等下，我去翻一下网页。"]
  },
  "triggerPhrases": ["联网查", "联网搜", "搜一下", "帮我查", "查一下"],
  "softTriggerPhrases": ["最新", "最近", "今天", "现在", "新闻", "价格", "天气"]
}
```

搜索结果会作为上下文交给模型总结；如果搜不到或搜索失败，bot 会说明没查到可靠结果。普通主动插话、隐式接话、日常聊天都不会自动联网。当前默认用 Bing，失败时会尝试 DuckDuckGo 作为备用。

搜索意图分三层：

- `triggerPhrases` 是搜索候选词，例如“搜一下”“帮我查”。出现后不会立刻搜索，而是交给 AI 裁判确认。
- `softTriggerPhrases` 是软实时候选词，例如“最新”“今天”“价格”“天气”。它们只有在消息像是在问 bot、私聊 bot，或者句子本身像查询命令时才进入候选，避免把“最新一集真好看”这类普通聊天误判成搜索。
- `aiJudge` 是最终裁判：它会结合最近上下文判断是否真的要联网，并重写更具体的搜索词。`fallback: "skip"` 表示 AI 裁判失败时不搜索；如果改成 `"rule"`，裁判失败时会退回旧规则搜索。

如果用户说“查一下这个 / 它现在怎么样”这类省略对象的句子，bot 会优先从最近几条上下文里补搜索主题，再发起搜索。`appendDateForFreshQueries` 开启时，会给“今天/最新/实时/天气/价格”等查询自动补上当天日期，减少搜到旧结果的概率。

天气类问题会走专门的 `weather` 直查通道，而不是依赖普通网页搜索。普通搜索默认优先走本机代理访问 Google；新闻/24小时/走势/价格类查询优先使用 Google News RSS。如果 Google 不通或没有可用结果，再尝试百度。搜索结果会按核心关键词相关性排序，尽量避免把不相干结果喂给模型。

本机代理会自动尝试 `proxy.urls` 里的端口以及常见代理端口，例如 Clash 常用的 `127.0.0.1:7897/7890`。如果你的代理端口不同，把它加进 `proxy.urls` 即可。

`preReply` 开启后，bot 会在 AI 裁判确认需要搜索后、真正搜索前先回一句短提示，避免群友以为它卡住。

## 图片识别 / Vision

默认日常聊天不盲目识图。消息里出现当前图片、引用历史图片、或图片类型表情包时，bot 会先让 AI 判断“这次是否真的需要看图”；只有当前文字、引用上下文或私聊 / @ 场景确实需要理解图片时，才调用 Vision 模型。

相关配置：

```json
"vision": {
  "enabled": true,
  "provider": "xiaomi",
  "model": "mimo-v2.5",
  "toolsets": "vision",
  "onlyWhenMentionedOrAsked": true,
  "includeQuotedImages": true,
  "includeImageEmojis": true,
  "aggressiveFollowup": true,
  "describeWhenUncertain": true,
  "followupWindowMs": 300000,
  "followupMaxMessagesAfterBot": 3,
  "maxQuotedMessages": 2,
  "aiJudge": {
    "enabled": true,
    "minConfidence": 0.55,
    "uncertainMaxConfidence": 0.7,
    "timeoutMs": 120000,
    "fallback": "rule"
  }
}
```

- `includeQuotedImages`: 用户引用一条历史图片消息再问“这是什么/啥意思/图里有什么”时，桥接会通过 OneBot `get_msg` 拉取被引用消息，再识别其中图片。
- `includeImageEmojis`: 把 `mface`、`bface`、`marketface` 等图片类表情包也作为可识别图片候选。
- `aggressiveFollowup`: bot 刚回复过某人、刚提到某人，或 bot 发言后临近几条消息里出现图片/图片表情时，更积极地先识别。
- `describeWhenUncertain`: 拿不准是否该看图时，先识别图片补上下文；识图结果进入后续回复决策，不代表一定发言。
- `aiJudge`: 在真正调用 Vision 前用对话模型判断是否需要识图，并选择最相关的图片 index；`fallback: "rule"` 表示 AI 判断失败时退回旧规则。
- 识图结果会作为 `[图片#1识别：...]` 或 `[引用图片表情#1识别：...]` 写入上下文，再交给日常聊天模型回复；没有识图结果时，prompt 要求 bot 不假装看到了图片。

## 记忆功能

记忆保存在本地：

```text
data/memory.json
```

机器人会自动记录：

- 群友用过的昵称 / 群名片
- “我喜欢…”、“我讨厌…”这类偏好或雷点；
- “这是梗”、“记住…”这类群梗和显式记录；
- 每 4 条消息左右调用一次 AI 结构化提取，记录群友概况、说话风格、互动关系、相处建议和当前话题；
- 每日总结

默认会过滤手机号、身份证、密码、验证码、银行卡、详细住址等敏感信息。

也可以在群里让管理员手动写入：

```text
/bot remember 狗哥=本群神秘传说
```

查看记忆：

```text
/bot memory
```

关键配置：

```json
"memory": {
  "aiExtraction": {
    "enabled": true,
    "everyMessages": 4
  },
  "privacyFilter": true
}
```

## 群内管理员命令

默认只有群主、管理员，或 `config.json` 里 `commands.adminUserIds` 配置的 QQ 号能使用管理命令。

```text
/bot quiet 10m
```

让机器人安静 10 分钟。也支持 `30s`、`2h`。

```text
/bot resume
```

恢复说话。

```text
/bot status
```

查看在线、安静状态和记忆概况。

## 每日自动消息

在 `config.json` 的 `dailyMessages.schedules` 里配置：

- `morning`: 早安
- `evening`: 晚安 / 晚间收尾
- `summary`: 每日群聊总结

默认时间：

```text
08:30 早安
23:00 晚安
23:30 总结
```

定时消息只会发送到机器人启动后见过消息的群；这样可以避免不知道上下文时乱发。

## Dry-run 测试

可以用一段聊天文本离线测试它会如何理解上下文，不会真实发 QQ。

文本格式：

```text
张三: 今天这个梗太离谱了
李四: 确实，积积阳阳德
张三: @小跟班 你怎么看
```

运行：

```bash
node src/bridge.js --dry-run ./sample-chat.txt --group 364433603
```

不调用 AI、只看上下文包和决策：

```bash
node src/bridge.js --dry-run ./sample-chat.txt --group 364433603 --no-ai
```
