# NAS 多端同步成熟方案对照

更新时间：2026-09-20

## 结论

当前项目适合继续采用“服务器中心 + 三端本地数据库 + 增量事件”的架构，不建议为了同步能力直接改成 CouchDB 或引入完整商业同步 SDK。需要把成熟方案中已经验证过的协议约束补齐到现有服务：

1. 每个客户端操作必须有 operationId，服务端重复收到时返回同一个结果，不能重复改数据。
2. 每个设备维护自己的 sequence 和服务端 revision 游标，断线后从游标继续拉取。
3. 删除必须写墓碑，不能用“列表里没有”推断删除；墓碑在所有已登记设备确认后才可清理。
4. 排序必须作为完整快照同步，不能只同步一个移动动作；服务端校验快照完整性后原子落库。
5. 云端为空、响应超限、分页不完整或校验失败时，只能报错或延迟同步，不能执行镜像删除。

## 方案对照

### Replicache

Replicache 的核心是客户端本地立即变更，后台通过 pull/push 与服务端交换版本和 mutation。这个模型适合我们“点收藏立即生效、后台同步”的体验。我们已经有类似的 operationId、设备序号和 revision，但需要继续统一所有实体，不只用于歌曲和插件。

参考：

- https://replicache.dev/
- https://doc.replicache.dev/
- https://github.com/rocicorp/replicache

### CouchDB / PouchDB

PouchDB/CouchDB 使用文档 revision、冲突树和删除标记，断线后可继续复制；删除不是从列表消失，而是显式删除文档。它提醒我们不能把“云端列表没有插件”当成删除事件。我们的服务端事件日志和 deleted_at 墓碑应保持这个语义。

参考：

- https://pouchdb.com/guides/replication.html
- https://pouchdb.com/guides/conflicts.html
- https://github.com/pouchdb/pouchdb

### PowerSync

PowerSync 把服务端数据库同步到客户端 SQLite，客户端继续离线读写，再由上传队列提交变更。这个方向和桌面端 Rust SQLite、安卓本地仓库最接近。我们暂时不引入其运行时，但应采用同样的“本地先写、上传队列可重试、冲突策略由服务端定义”的边界。

参考：

- https://www.powersync.com/
- https://github.com/powersync-ja/powersync-js

## 当前实现与缺口

已经具备：

- 服务端 revision 和增量事件。
- 歌曲操作的设备序号、时间排序和幂等记录。
- 插件操作的设备序号、墓碑和脚本 blob。
- 歌单、歌曲、收藏、播客、插件的显式 position 字段。
- 云端空列表保护和插件合并式上传。
- 桌面端本地歌单整体顺序 SQLite 持久化。

仍需继续补强：

- 所有客户端都要调用 /sync/register 并上报已确认 revision，服务端才知道墓碑何时可清理。
- 重排事件要携带实体类型、完整顺序数组和快照校验值，客户端必须拒绝不完整快照。
- 服务端的批量重排需要只更新实际变化的行，并确保事件和数据写入在同一事务中。
- 三端应增加同一组跨设备测试：离线收藏、并发删除、旧设备恢复、重复请求、空云端、分页中断、顺序冲突。
- 生产部署必须使用 NAS 管理员授权或把部署用户加入 Docker 组；同步服务的 CERU_SYNC_ADMIN_TOKEN 只能调用服务管理 API，不能替代 Docker root 权限。

## 推荐协议

以服务端为唯一仲裁者：

    本地事务
      -> pending mutation(operationId, deviceId, sequence)
      -> 服务端幂等应用 + revision + tombstone/event
      -> 客户端确认 mutation
      -> 客户端按 revision 拉取事件
      -> 完整快照校验后落本地 SQLite

冲突规则建议固定为：歌曲/收藏/插件内容按服务端操作序列仲裁；排序按最新完整排序快照仲裁；删除优先于更旧的更新，只有带更高设备序号或明确用户重新添加的操作才能复活。这样才能接近 QQ 音乐式的多端统一体验，同时避免一次错误空响应清空本地数据。
