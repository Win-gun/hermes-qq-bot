# 北邮校园 API 接入

## 配置契约

北邮网关使用现有 OpenAI-compatible 文本传输，不需要安装或启动 DSH，
也不需要新增模型 SDK。连接及模型由 API 管理维护：

| 项目 | 值 |
| --- | --- |
| 连接名称 | 北邮校园 API |
| Hermes Provider | `custom` |
| Base URL | `https://myai.bupt.edu.cn/llm-gw/v1` |
| 请求路径 | `/llm-gw/v1/chat/completions` |
| 模型 | `deepseek-v4-flash` |
| 用途 | 问答、任务（`kind: chat`） |
| 普通问答思考强度 | `none` |
| 超时 | 120000 毫秒 |
| 文本传输 | `ai.textTransport: direct` |
| 凭据 | 本机 Keychain；配置只保存 `credentialRef` |
| 可选环境变量名称 | `BUPT_API_KEY` |

`bupt-campus` 是交接文档中的 DSH provider 名称，不是 Hermes 的传输适配器名称。
在 Hermes 中使用 `custom`，保留上述完整网关路径；不能误用 DeepSeek 官方地址。
使用 Keychain 时，即使环境变量存在，也不会在 Keychain 不可用后静默降级。

交接给出的上下文 131072、最大输出 8192 是另一客户端的声明，不作为服务端能力保证。
目前仅验证文本；不能据模型名称启用识图、语音或官方 MiMo 联网插件。

参数参考：[BUPTapi-dsh 配置实现](https://github.com/yifanchen12/BUPTapi-dsh/blob/main/desktop/configure.cjs)。

## 2026-11-03 本机接入结果

按用户明确选择，两个现有账号的问答、任务均解析到北邮文本方案；
账号原有功能启停不变，关闭任务功能的账号不会因为绑定模型而自动开启任务。
本次仅热更新配置，没有替换 App 二进制。

- 从用户指定交接位置一次性读取 `refs.BUPT_API_KEY`，只导入 Bot 自己的 Keychain。
  原始文件只读，未修改 DSH 配置，也没有为 Bot 增加读取 DSH 凭据的运行时回退。
- 保留全部原有连接、模型、账号风格、人物记忆、权限及预算。
- 语音识别、合成和 MiMo 官方联网的有效绑定保持不变。
- 切换前识图实际上使用了问答 MiMo 的管理员能力快照，而不是旧独立识图模型。
  为保留实际能力，新增独立 `kind: vision` 方案绑定原 MiMo 连接及
  `mimo-v2.6-flash`。旧能力快照不迁移给北邮；不重新勾选“问答模型识图”来伪造能力。
- 原问答 CLI profile 参数保持不变，避免破坏独立识图及联网使用的现有 Hermes 凭据。

接入前发现既有记忆后台写入器锁存 `MEMORY_OPERATION_UNCERTAIN`，
此时模型账本无法登记调用，管理页模型测试因此失败。
已先备份配置、记忆快照和日志式提交记录，再通过 App 的“重启”按钮重启桥接，
确认记忆重新可写、两个 OneBot 连接恢复后才继续切换。
未删除记忆、清除提交记录或重放结果不确定的操作。
本次只确认恢复成功，尚未定位此前写入超时的最初诱因。

## 验证范围

真实接口（不向 QQ 发消息）：

- 北邮最小文本请求成功，并取得服务端报告的 `deepseek-v4-flash` 与真实 usage。
- Bot 的北邮连接测试、草稿模型测试、保存后 Keychain 模型测试成功。
- 切换后的任务绑定测试成功；额外以任务常用 `reasoning_effort: medium`
  测试当前北邮兼容性成功，未将该草稿参数保存为问答配置。
- 独立 MiMo 识图在切换前、后均完成合成测试图的实际模型调用。
- API、磁盘配置、两个账号的有效路由一致；配置响应和磁盘配置不包含导入的密钥。
- App API 管理页显示问答／任务为北邮，识图为保留的 MiMo，语音和联网仍为原方案。

隔离回归：

```sh
npm run test:bupt-api
npm run test:text-completion
npm run test:api-center
npm run test:config-revision
npm run test:backup
node scripts/model-credentials-self-test.js
node scripts/vision-process-self-test.js
node scripts/digital-life-integration-self-test.js
npm run check
```

新增 `test:bupt-api` 使用假响应验证网关子路径不会被截断或重复追加、
Keychain 不静默换钥、文本路由不携带图片／工具、实际 usage 解析及媒体绑定隔离，
并纳入 CI。这里的 CI 纳入不代表尚未推送的 GitHub 检查已经运行。

未执行真实 QQ 发消息、完整正式任务、TTS/ASR 或付费联网插件测试；
它们与路由、参数兼容和隔离测试是不同的验收范围。
服务端费用没有可验证报价，不能将 token 数当作金额；校外可达性可能依赖校园 VPN。
本轮上述本地测试全部通过；备份测试为临时目录与假 Keychain，137 项检查通过，
没有将生产密钥写入测试产物。

## 管理和回滚

App 与 WebUI 共用 API 管理。模型和凭据在该页编辑，不在问答／任务页另存密钥。
选择连接只改变编辑对象；真正使用的方案以“功能绑定”和账号覆盖为准。

接入前备份及验证报告保存在运行状态目录的 `backups/`，权限仅限当前用户，
不属于源码或发布包。切换验证失败时恢复原绑定，但保留未使用的北邮连接和 Keychain
凭据，避免不必要删除。原 MiMo 问答、任务方案均仍在，可在 API 管理中重新绑定。
完整回滚应先停止桥接并核对配置版本，不用旧备份直接覆盖后续用户修改。
不要为了回滚 API 绑定而恢复旧人物记忆。

普通备份不得携带密钥；加密完整备份沿用现有 API Keychain 迁移机制。
卸载或换机时不要把 DSH 的凭据 YAML 放进 Bot 配置、日志、仓库或发布包。
