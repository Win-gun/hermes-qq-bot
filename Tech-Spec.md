# QQ Bot 真人感优化 Tech Spec

## Decision flow

硬规则优先级保持不变：quiet/命令/主人私聊/明确 @ 与引用。普通消息完成 debounce 后，先解析所有原始消息的引用、@、图片和消息 ID，形成结构化 `replyContexts`；随后完成识图上下文补充、原始消息归档、记忆更新和决策前历史检索。只有模糊接话和讨论参与候选进入社交判断。

`replyContexts` 的最小契约：

```json
{
  "messageId": "OneBot message id",
  "senderId": "QQ id",
  "senderName": "昵称或群名片",
  "text": "被引用正文",
  "isBot": false,
  "resolved": true
}
```

引用 bot 时绕过模糊阈值并可靠回复。非引用的隐式回复不再只比较最后一条 bot 消息，而是在最近若干条 bot 消息中选择关联度最高的一条。

社交判断返回严格 JSON：

```json
{
  "action": "reply | wait | observe",
  "intent": "followup | discussion | reaction | proactive",
  "confidence": 0.0,
  "target_user_ids": [],
  "tone": "casual | teasing | serious | supportive",
  "length": "one_line | short | detailed",
  "reason": ""
}
```

解析失败、超时或低于当前行为档阈值时，对模糊消息默认 `observe`。明确消息继续走原生成路径。

## Compatibility

- `data/memory.json` 只做增量扩展；已有 `profile`、`memes`、`style`、`preferences` 和 canonical profile 均保留。
- bot 自我立场追加到可选 `botSelf.stances`，每项包含 topic、stance、confidence、sourceMessageId、updatedAt；不重写既有 self memory。
- 现有三档模式保留，通过阈值和冷却影响社交判断。
- 旧启发式路径保留为 feature-flag fallback。

## Configuration contract

新增 `socialPlanner`：`enabled`、`shadowMode`、`timeoutMs`、`minConfidence`、`recentMessages`。模式 preset 可覆盖 `minConfidence`。新增 `reply.repetitionWindow` 和 `reply.maxRepeatedOpening`。

管理 API 的配置白名单允许这些字段；管理页展示开关、影子状态和最近判断，不展示聊天全文或敏感数据。

## Reliability

- 修复聊天归档引用消息 ID 提取函数缺失，并添加降级逻辑，归档失败不能阻塞回复。
- quiet 状态继续执行归档、摘要和记忆提取，但在任何搜索、生成或发送前返回。
- 社交判断日志只记录模式、动作、置信度和简短理由，不记录完整敏感消息。
- debounce 保留所有原始 event，只合并用于理解的文本；引用和图片从全部原始 event 聚合。
- 运行时 history 按事件时间排序；启动时从 JSONL 存档恢复最近用户消息、bot 回复和最近 bot 消息。
- 决策前检索只在引用、模糊指代、已知话题或连续讨论等场景触发，避免每条闲聊都扫描存档。
- 存档摘要使用真实群 ID；读取旧空摘要时回退到现有结构化群记忆。

## Verification additions

- 引用 bot、引用群友和引用解析失败三种路径。
- 同一人“引用 + 后续补充”合并后仍保留引用。
- 两个用户分别回复 bot 的不同近邻消息，均能得到正确关联。
- 群摘要键、摘要尾部更新、旧空摘要回退。
- 启动恢复后的最近上下文和最近 bot 消息。

## Rollout

默认先启用 `shadowMode`：生成新判断但发送行为仍使用旧路径。dry-run 与日志确认后关闭 shadow；任何异常可通过 `socialPlanner.enabled=false` 回退。

## 登录后启动

- `com.codex.qq-hermes-onebot-bridge` 保持 `RunAtLoad + KeepAlive`，负责桥接服务启动和崩溃恢复。
- `com.codex.qq-hermes-snowluma-bootstrap` 在登录时及之后每五分钟运行一次：启动 Docker Desktop、等待 Docker API、从实时配置读取已启用的 SnowLuma 容器并启动它们，最后用无 `-k` 的 `kickstart` 确保桥接已运行，禁止周期性强制重启桥接。
- 启动守护不读取或记录 API key、QQ 登录态或 WebUI token。Docker 尚未可用时正常退出，由下一次间隔调度重试，避免失败热循环。
