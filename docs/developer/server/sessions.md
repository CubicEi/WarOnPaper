# 会话与身份边界

`core/server` **没有**独立的鉴权、账号或 cookie 模块。本节说明房间内「玩家会话」是什么，以及身份由谁负责。

## 1. 房间内会话：`PlayerSession`

定义于 `createRoom` 闭包（`room.ts`）：

| 字段 | 含义 |
|------|------|
| `id` | 玩家 ID（调用方传入；调试入口可来自 `hello.playerId` 或 `randomUUID()`） |
| `name` | 显示名，最长 24 |
| `hud` | 能源/组织度/首都 HP 等权威余额 |
| `ws` | 出站适配器（`makeSocket(RoomSend)`），不是真实浏览器 WebSocket |

生命周期：

- **创建**：`join` 成功且非重连
- **重连**：同 `playerId` 再次 `join`，或 `setSend` 只换通道
- **离开**：`leave` 删除 Map 项并发 `player_left`；**世界实体保留**
- **关房**：`destroyRoom` 清空全部 `players`

相关集合：

- `spectatorIds`：无重生时首都沦陷后的观战身份
- `knownCapitalOwners`：胜负/沦陷逻辑用的「曾拥首都」集合

## 2. 调试入口如何绑定连接

`src/index.ts`：

- `WeakMap<WebSocket, playerId>`
- 每连接本地变量 `playerId`：首条消息完成 `join` 后固定
- `close` → `room.leave(id)`

无密码、无 token 校验；本地联调信任客户端自报 `playerId`。

## 3. 生产路径（manager，非本包源码）

权威加载：`manager/src/gameBridge.ts` → `core/server/dist/room.js`。

典型分工（据 manager 代码，便于理解边界）：

| 能力 | 位置 |
|------|------|
| 身份文件 / 会话 | `manager`（如 `identity.ts`、`IDENTITY_DATA_PATH`） |
| 大厅消息 `create_room`/`join_room`/匹配 | `manager` |
| 进房后游戏消息 | `RoomRegistry.dispatch` → `GameRoom.dispatch` |
| 全局 tick | `RoomRegistry.start` → 每房 `game.tick()` |

因此：**不要在 server 文档中假设 OAuth/JWT**；若需文档化鉴权，应另写 `docs/manager/`。

## 4. 与协议字段的关系

- `ClientToServer.hello.playerId`：可选缓存 UUID；房间 `join` 时由**外层**决定最终 id。
- `ServerToClient.welcome.playerId` / `activeRoomId`：确认座位与可重连房间。
- `GameStateSnapshot.players`：仅 id+name，供 HUD 显示所有者名。

## 5. 安全相关事实（如实）

- 房间信任调用方传入的 `playerId` 与 `RoomSend`。
- `dispatch` 只处理已 join 的 id；未知 id 静默忽略。
- 资源与建造结果以服务端为准；客户端伪造坐标会在规则函数处被拒。
- 本包不加密、不签名消息。
