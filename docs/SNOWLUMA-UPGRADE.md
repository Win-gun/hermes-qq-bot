# SnowLuma 2.1.1 兼容与升级

## 数据目录

SnowLuma 2.1.1 官方镜像将网关工作目录固定为 `/app/data`。早期镜像及
现有凭据读取、备份清单使用 `/app/snowluma-data`。创建容器时：

- 同一网关卷同时挂载这两个目录，不能分别指向两份数据。
- QQ 配置、登录数据分别保留在 `/app/.config`、`/app/.local/share`。
- 主机任务上传目录仅绑定到 `/app/data/hermes-task-uploads`；不得再用
  整个主机 data 目录覆盖 `/app/data`，否则会遮住网关配置。
- 未使用命名卷时，同一主机 data 目录绑定两个网关路径。

挂载参数由 `src/snowluma-mounts.js` 统一生成。旧备份中的目的路径和卷键不变；
双挂载只导出一次网关卷。重建容器不自动同意第三方许可协议。

## 生产升级约束

升级前核对官方镜像架构、发行版本及许可协议；新版协议必须由运营者确认，
不能伪造接受记录。配置应固定已验证的版本或摘要，不依赖浮动 latest。

逐账号执行，不能同时停止所有账号：

1. 保存受保护的配置、容器定义、端口、镜像摘要及重启策略。
2. 使用带版本校验的账号接口关闭该账号协议参与，防止自动重连竞争；
   再停止这一容器，不影响其他账号。
3. 将全部三个数据卷复制到全新的账号专属卷；停机复制并逐文件校验。
   同时保留主机目录快照。旧卷不得交给新版写入。
4. 停放旧容器并关闭其自动重启，使用同名新容器和独立副本启动新版。
   保留必要端口、OneBot token、机器标识及原 QQ 登录数据；不要额外更新 QQ。
5. 通过真实 OneBot 查询核对发行版本、QQ 身份和在线状态；获授权后再做
   指定群收发测试。发送结果不确定时不重试。
6. 验证一次单账号重启后仍可连接，再确认稳定。失败只回滚该账号，旧卷和
   旧容器仍在；不要用整份过期配置覆盖其他账号的新设置。

完整备份会暂停其覆盖的协议容器，不应当作逐账号生产升级工具。
恢复到新电脑可能仍需重新扫码、确认协议或提供本机凭据。

## 验证

```sh
npm run test:snowluma
npm run check
npm run test:accounts
npm run test:backup
npm run web:release:check
```

挂载和备份测试使用隔离 fixture，不启动真实 Docker、QQ 或调用模型。
真实 QQ 登录、收发和重启验证需单独记录，不能由 fixture 成功代替。

官方参考：

- [2.1.1 发行页](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.1.1)
- [更新说明](https://snowluma.github.io/en/docs/guide/deploy/update)
- [数据布局迁移](https://snowluma.github.io/en/docs/guide/deploy/storage-migration)
- [该版本许可协议](https://github.com/SnowLuma/SnowLuma/blob/v2.1.1/EULA.md)
