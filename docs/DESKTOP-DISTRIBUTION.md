# Hermes QQ Bot 桌面应用

## beta.27（Social Life 3.1）

当前源码版本为 `1.0.0-beta.27`。本版增加有界表情互动、真实拍一拍事件唤醒、
按账号隔离的空间草稿与审核流程，以及可追溯社交经历；具体能力和未完成门槛见
[Social Life 3.1](SOCIAL-LIFE-3.1.md)。这些能力不等于空间自动公开发帖已启用。

克制档默认普通接话概率为 0.08、冷却 180 秒；定时插话概率为 0.16，
检查间隔 10 分钟、冷却 25 分钟。仍低于正常档；quiet、直接问答优先、
各账号自己的档位、会话权限和模型预算不变。已有安装需显式迁移克制预设，
安装新版不会自动覆盖用户自定义的活跃度参数。

本轮隔离构建目录为 `out/social-life-31-beta27`；部署前应验证源码/ASAR 一致、
签名、独立状态冒烟和 DMG 完整性，并备份停止后的状态。实际部署、真实 QQ
测试和功能启用结果分别记录在本机 `outputs/`，不纳入公开安装包。

## 构建

当前构建目标是 Apple 芯片 Mac（macOS 13+）。构建机使用受 `package.json` 约束的 Node.js 版本（22.12–25）；从项目根目录执行：

```bash
npm ci
npm run check
npm run test:backup
npm run test:docker-backup
npm run app:package
npm run app:make
```

`app:package` 生成 `out/` 下的应用包；`app:make` 生成 `out/make/` 下的 arm64 ZIP 与 DMG。若已有应用正在从默认 `out/` 运行，先设置 `HERMES_QQ_BUILD_OUT=out/parity-dev`，避免覆盖运行中的应用。打开 DMG 后将 App 拖入“应用程序”，再从该目录启动。当前代码版本是 `1.0.0-beta.24`（包含 [Social Experience 2.1](SOCIAL-EXPERIENCE-2.1.md)、[可靠性审查修复](AUDIT-REMEDIATION.md)、[记忆核实及学习升级](MEMORY-VERIFICATION.md)、[按账号自主社交与人格提案](SOCIAL-AGENT.md)、[社交表达及群表情学习](SOCIAL-EXPERIENCE-2.md)、凭据管理及文本调用优化）；测试版采用 ad-hoc 签名，未完成 Apple 公证或跨设备验收。首次打开可能需要在 Finder 中右键应用并选择“打开”。

`beta.15` 修复了其他 API 草稿误拦截密钥保存、Keychain 空值写入及新建模型方案默认关联错误连接的问题。旧版已保存的空凭据需要在本机重新录入；新写入会回读核对，成功后才显示已配置。页面 Keychain 写入支持单行可打印 ASCII，完整转义命令上限为 4000 字节，超出限制应使用环境变量配置；不会截断后写入。新增方案保持为草稿，不会自动切换功能或账号的线上模型绑定。

`beta.16` 在 API 管理页增加 API Key 列表，显示各连接的本机 Keychain 状态、首次保存及最近更新时间、脱敏预览和使用情况。预览仅显示长密钥的前后各 4 位，短密钥全部隐藏；时间来自 Keychain，无法读取时显示未知。环境变量和 Hermes 管理的密钥不在此列表枚举。正在被全局功能、账号或故障转移组使用的密钥不能删除；连接移除或切换凭据来源前，需要先解绑并删除旧密钥。

`beta.17` 增加 `ai.textTransport`：默认 `hermes` 保持原调用方式；设为 `direct` 时，仅对明确配置 Base URL、使用本机 Keychain 的 `custom` / `openai-api` 纯文本请求直接调用 `/chat/completions`。Bridge 构建的角色、历史、记忆、搜索证据和输出要求完整传入，不额外加载 Hermes CLI 的工具、技能及环境探测提示词。当前模型和选定的 low/medium/high 思考强度保留，后者显式发送为 `reasoning_effort`；none 不发送此参数，沿用供应商默认语义。正式任务工具执行、权限沙箱、识图和语音保持原流程。其他连接继续走 Hermes；直连失败不自动改用其他模型、不重复请求。恢复 `ai.textTransport: "hermes"` 可热切回原路径。取消和超时会终止 HTTP 请求，响应大小有限制，空文本、工具调用或截断回答会报错。

连接编辑器可在保存前测试 `/models` 接口可访问性；模型方案编辑器可测试指定模型，无需先切换线上绑定。输入框内未保存的密钥只用于该次请求，测试后清空，不落盘；连接地址或 Provider 改变时，需重新输入临时密钥或先保存新目标，不能在草稿测试中沿用旧目标的已存密钥。模型测试可能产生供应商费用，不发送 QQ 消息，也不保存草稿或修改线上绑定。测试期间修改草稿后，旧结果会失效。

打包配置以不包含当前机器的 `config.json`、QQ 号、API 密钥、记忆、聊天记录、日志或 SnowLuma 登录态为目标；公开分发前必须检查实际 ZIP/DMG 内容，不能只依据忽略规则判断安全。

浏览器 WebUI 版应通过 `npm run web:start` 启动；它与桌面 App 使用同一宿主、同一桥接实现和同一默认用户状态目录。若 App 打开时 WebUI 已接管相同状态目录，App 会附着到现有宿主，不再启动第二个桥接。`npm start` 仅是旧开发兼容入口，使用项目目录状态，不提供完整宿主管理 API。发布前仍需分别验收两种入口的主要功能和数据迁移。参见[功能一致性清单](EDITION-PARITY.md)与[开源发布清单](OPEN-SOURCE-CHECKLIST.md)。

## 运行目录

`beta.23` 增加群表情后台自主学习、受限图片缓存和消息表情回应。能力沿用账号
独立策略及共享发送闸门，默认关闭；只按当次授权的账号、群启用。消息回应接口
受理不代表 QQ 客户端显示已验证，协议不支持时不猜测备用动作、不重试。
参见 [群表情实施与验收](SOCIAL-EXPERIENCE-2.md#后续源码群表情自主学习与消息表情回应)。

`beta.19` 增加按账号管理的[空闲网络采风](SOCIAL-DISCOVERY.md)：采集、素材检索、受控分享和反馈。安装不会自动开启该功能；生产范围和发送权限须另行确认。

`beta.20–21` 加强管理台保存可靠性：非法数值明确拒绝，合法自定义值在保存后回读核对；迟到的 API 刷新不覆盖新保存；账号回读失败保留草稿并显示未核实，保存期间继续编辑不误判为外部冲突。WebUI 与 App 共用实现，升级不自动改动现有配置。

`beta.22` 增加按账号、会话限定的社交表达：自适应轮次、共享 ReplyPlan 与语义气泡、受审核的收藏表情库和群语感。缺省仍关闭/观察模式，生产须显式启用；收藏同步依赖协议实际支持 `fetch_custom_face_detail`，不支持时明确降级，不假造图片或尝试未知动作。拍一拍保持禁用。参见 [Social Experience 2.0](SOCIAL-EXPERIENCE-2.md)。桌面冒烟测试明确清空示例的外部 OneBot/容器入口，避免连接当前机器的真实 QQ 协议端。

桌面应用将只读代码与用户状态分离：

- 应用代码：`Hermes QQ Bot.app/Contents/Resources/app/`
- 用户数据：`~/Library/Application Support/Hermes QQ Bot/`
- 日志：`~/Library/Logs/Hermes QQ Bot/`
- 默认备份：`~/Documents/Hermes QQ Bot Backups/`

桥接支持以下环境变量：

- `HERMES_QQ_HOME`
- `HERMES_QQ_RESOURCE_ROOT`
- `HERMES_QQ_LOG_DIR`
- `HERMES_HOME`

未设置时仍按原项目目录运行，因此 `npm start` 和现有开发工作流保持兼容。

## 首次启动

向导会检测 Apple Silicon、Docker Desktop、Hermes CLI、本机端口和桥接状态。首次打开时不会自动接管旧网页项目或启动同名 QQ 容器。若本机已有网页端项目，先在向导中选择原项目目录并执行“验证并迁移”；迁移成功后再进入控制台。没有旧项目时，使用“准备主备账号”拉取 SnowLuma 镜像、创建容器并打开 WebUI/noVNC。Docker Desktop、Hermes 与 SnowLuma 镜像是外部依赖，不写入 DMG。QQ 尚未登录时桥接也能启动；进入控制台后继续扫码和模型配置。

完成向导后，打包 App 会为当前用户安装登录启动项；之后可以在管理页关闭。关闭窗口只隐藏到菜单栏；选择“退出并停止机器人”才会停止由 App 管理的桥接。若 App 附着到已运行的 WebUI 宿主，停止操作会作用于该宿主，请先确认当前接管入口。

## 备份类型

普通数据备份：

- 包含配置、提示词、记忆、聊天存档、图片、任务与产物。
- 清洗直接写入配置的 token、密码和 API key。
- 不包含 Hermes `.env`、SnowLuma/QQ 登录态、日志和缓存。
- 可在机器人运行时创建。

完整迁移备份：

- 额外包含应用专用 Hermes 凭据和 SnowLuma Docker 登录卷。
- 强制使用 `scrypt + AES-256-GCM` 加密。
- 创建期间会短暂停止桥接和 SnowLuma，完成后自动恢复。
- 密码不会保存；丢失后无法恢复。

两类备份扩展名均为 `.hermesqqbackup`，内部清单包含版本、组件、文件大小与 SHA-256。
完整迁移备份可选附带诊断日志；日志可能包含聊天内容或敏感信息，因此仅允许放入密码加密的完整备份，默认不包含。恢复时不会覆盖目标电脑现有日志。

## 恢复与迁移

恢复会先校验格式、密码、版本和全部文件哈希，再创建当前系统回滚包。配置与数据从隔离暂存目录整体替换；完整备份会恢复为确定命名的 Docker volumes 并让桥接重建 SnowLuma 容器。

QQ 可能因为腾讯的新设备策略要求重新扫码。这只显示为警告，不会回滚已经恢复的记忆和配置。

“从旧项目迁移”会复制旧项目的配置、数据、协议端宿主目录、Hermes 配置，并将 SnowLuma 数据卷迁到新命名卷。新桥接需确认账号身份与模型调用，验证通过后停用旧桥接 LaunchAgent；失败则恢复旧环境。旧项目、旧容器和旧卷保留在回滚位置。

## 安全边界

- BrowserWindow 启用 `contextIsolation`，禁用 renderer Node 权限。
- 本地操作只通过 preload 白名单 IPC。
- 控制服务继续只监听 `127.0.0.1`。
- 恢复拒绝未知格式、路径越界、符号链接和校验失败文件。
- 临时目录权限为 `0700`，敏感文件权限为 `0600`。
