# Owner First 3.4

本轮以实际主人控制、跨群人物理解和低打扰运行为目标。沿用现有
MemoryRuntime、Owner Services、发送闸门及通知中心，不新增第二套数据库或发送队列。

## 状态与验收口径

当前为集成验收记录，**尚不能据此认定生产已升级**。生产安装、配置回读、
QQ 实际协议和 GitHub 推送结果在完成后另行更新。

- 单元测试：纯函数、临时目录及假宿主，只证明对应契约。
- 桥接集成：真实桥接进程、临时 HOME、两个假 OneBot、回放模型；不连接真实 QQ。
- 生产健康：检查实际运行包、配置和两个账号的真实身份、连接、记忆仓库状态。
- 协议接受、消息回读、客户端显示和真人体验是不同证据，不互相替代。
- 不调用付费聊天模型制造验收数据；未知历史用量仍是 unknown。

## 模块与数据契约

### 主人路由和持续要求

`src/owner-intent.js` 优先解析常见中文事实查询及低风险操作。
`src/owner-services.js` 将意图接入已有能力，`src/owner-authority.js`
持久 claim 后执行，最后校验身份、路由、配置及会话控制，再记录真实回执。

普通私聊不增加一次规划模型调用。模型只能提出白名单候选，不能生成主人身份、
新的群权限、任意 OneBot action 或成功回执。群内自称主人、引用和普通成员消息
不获得 Owner 权限。

`ownerControl.lowRiskDirect` 只省略已授权低风险动作的第二次确认，不省略身份、
目标范围、quiet、持久 claim 或发送闸门。不确定动作不自动重试。

称呼偏好、拍一拍限制和减少主动参与要求进入原有 Owner Directives。
减少主动参与必须影响实际主动行为，不以提示词中的一句承诺代替程序限制；
明确点名和直接求助仍走正常问答。

### 自动继承目标范围

`ownerControl.targetMode` 区分：

- `explicit`：旧配置语义不变，空目标列表不授予群权限。
- `inherited`：宿主提供实际已加入群，与当前账号消息处理范围相交；
  非空的既有人工限制继续缩小范围。没有可信群证据时拒绝操作，不解释为通配授权。

群名只用于解析显示，不是权限依据。重名时优先当前账号和真实最近目标，
仍不唯一就澄清。不把自主社交会话列表误用成所有主人操作的权限表。

### 人物记忆

`src/people-memory.js` 继续以 `logicalBotId + verified QQ` 归属。
私人内容、关系和临时事件不会因启用跨群理解而公开到其他群。

区分内部 `understanding` 和对外 `disclosure`。首次明确、非敏感、来源验证的
公开自述可成为不确定的内部理解；不因此允许复述来源群或证明已经知道确定事实。
删除、撤销、冻结、纠正和 tombstone 优先于旧来源及兼容摘要。

稳定事实、偏好、称呼和边界超出新鲜度期限后降低可信度并标记陈旧，不直接删除。
短期事件继续过期。容量拒绝必须可见，不静默 FIFO 淘汰重要事实。

`src/people-memory-migration.js` 是同步、分批、可恢复的迁移变换，仍由唯一仓库
writer 提交。它不拼接旧画像，不猜历史观察账号，不用迁移时刻刷新原始事实时间。
缺少真实来源或逻辑身份归属的历史不能冒充完成的跨群人物档案。

只读生产审计发现旧 canonical 资料存在于 `groups[].users[]`，但缺少新版本的
`peopleSourceIndex`。因此需要保留安全的原群兼容上下文，并诚实区分已核验迁移
和来源不足的历史；启用新索引不等于所有旧记忆已经转换。

### 通知与真实运行账本

`src/owner-notifications.js` 是常规给主人汇报的唯一入口。默认
`Asia/Shanghai` 每日 09:00、21:00，实际窗口 claim 和回执持久保存；
重启不补发不确定的旧发送。主人主动查询不受每天两次常规推送限制。

普通上线、恢复、任务进度和记忆核实事项进入摘要或事件，不逐条私聊。
群内固定问好、总结仍属于各账号自动化，不因合并主人通知而删除。
严重告警保留独立等级、白名单和冷却，断开的 QQ 通道不可能成功告警。

升级前只读检查：旧 `com.codex.qq-hermes-status-report` 配置文件仍在，但
`Disabled=true` 且不在已加载任务中；旧 bridge/bootstrap 启动文件已停用，
用户 crontab 为空。文件存在不等于通知正在运行。实际重复汇报控制仍须检查
桥接内部通知、账号自动化和最终发送闸门，不能只看 launchd。

`src/operational-ledger.js` 记录可信 provider usage 和宿主实际事件。
缺失 usage 的调用单独计数，不当作零；费用未核实不估算。账本保持不可信状态
验证，合并重复扫描并增量维护已验证分区统计，不通过停记账换性能。

合成基准仅测模块内存操作，不代表生产磁盘提交耗时或自然度提升。

### 配置升级与发布

`src/owner-first-migration.js` 提供无 IO 的一次性升级。只有配置了真实私聊主人的
安装才自动启用；无主人时不猜通知收件人。保留已有模型、密钥来源、人格、账号、
范围、预算及更严格限制。升级后明确关闭的功能不得在后续启动被重新打开。

兼容说明：首次升级无法仅凭旧模板的 `enabled:false` 判断它是模板默认值还是
用户历史意图，因此本次按照明确授权启用新能力。已有 opt-out 标记、明确的
`lowRiskDirect:false`、目标限制及升级完成后的关闭设置继续保留；不能声称能
自动还原所有旧配置中未记录的关闭原因。本机生产预演中这些新增模块原本未配置。

实际宿主负责原配置备份、原子保存、验证及回读，检查命令和隔离测试不写生产。
共享模块必须进入 Web 发布白名单；App 和 Web 都使用同一套运行代码。

## 测试命令

使用项目支持的 Node 22：

```sh
npm run check
node scripts/owner-first-router-self-test.js
node scripts/owner-first-migration-self-test.js
node scripts/owner-first-people-self-test.js
node scripts/owner-first-ledger-self-test.js
npm run test:people-owner
npm run test:memory
npm run test:memory-verification
npm run test:kernel
npm run test:social-freedom
npm run test:backup
npm run test:api-center
npm run test:console
npm run web:release:check
```

桥接集成、构建及生产回读结果完成后补录。现阶段不以源码测试宣称真实 QQ
发送、消息客户端显示或真人评分已经通过。

本轮已独立复跑的专项结果：主人路由 301 项、迁移 320 项、账本 389 项、人物
记忆 24 组场景、当前桥接通知及发送前置回复防护 99 项/16 组。已有 People/Owner
真实桥接进程隔离测试 37 项通过。还覆盖账号、API、备份、记忆、语音、社交、
配置页面和 Web 发布资源回归；这些都不冒充真实 QQ 或真人体验验收。

## 回滚原则

部署前保留旧 App、停止状态下的配置和记忆快照，并验证文件哈希。
替换 App 不重新初始化协议端、不清空记忆、不同时重启两个 QQ 容器。
失败先停止推进，保存失败版本的较新状态和日志，再恢复旧包及经过验证的配置。
不得用旧快照静默覆盖替换之后真实收到的消息或人物更正。

## 生产与发布记录

尚未替换 App，尚未开启本轮生产配置，尚未推送本轮全部代码。
