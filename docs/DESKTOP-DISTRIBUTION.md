# Hermes QQ Bot 桌面应用

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

`app:package` 生成 `out/` 下的应用包；`app:make` 生成 `out/make/` 下的 arm64 ZIP 与 DMG。若已有应用正在从默认 `out/` 运行，先设置 `HERMES_QQ_BUILD_OUT=out/parity-dev`，避免覆盖运行中的应用。打开 DMG 后将 App 拖入“应用程序”，再从该目录启动。当前代码版本是 `1.0.0-beta.4`；测试版采用 ad-hoc 签名，未完成 Apple 公证或跨设备验收。首次打开可能需要在 Finder 中右键应用并选择“打开”。

打包配置以不包含当前机器的 `config.json`、QQ 号、API 密钥、记忆、聊天记录、日志或 SnowLuma 登录态为目标；公开分发前必须检查实际 ZIP/DMG 内容，不能只依据忽略规则判断安全。

浏览器 WebUI 版应通过 `npm run web:start` 启动；它与桌面 App 使用同一宿主、同一桥接实现和同一默认用户状态目录。若 App 打开时 WebUI 已接管相同状态目录，App 会附着到现有宿主，不再启动第二个桥接。`npm start` 仅是旧开发兼容入口，使用项目目录状态，不提供完整宿主管理 API。发布前仍需分别验收两种入口的主要功能和数据迁移。参见[功能一致性清单](EDITION-PARITY.md)与[开源发布清单](OPEN-SOURCE-CHECKLIST.md)。

## 运行目录

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
