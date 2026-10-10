# WarOnPaper 服务端文档（`core/server`）

本文档描述 `@wop/server`（路径：`core/server`）的架构与实现。服务端**不直接对外提供生产级多房间大厅**；它导出可嵌入的 `GameRoom` 库，由上层 `manager` 负责 WebSocket 接入、房间注册与 tick 调度。`src/index.ts` 仅是可选的单房间调试入口。

## 文档索引

| 文档 | 内容 |
|------|------|
| [architecture.md](./architecture.md) | 包结构、启动方式、与 shared/manager 的边界 |
| [room.md](./room.md) | `GameRoom` / `createRoom`：状态、进出房、建造/经济/胜负 |
| [networking.md](./networking.md) | 消息协议、`RoomSend` 适配、与客户端的同步约定 |
| [game-loop.md](./game-loop.md) | `tick()` 顺序、经济节奏、通讯波、污染与广播 |
| [tick-packets.md](../shared/tick-packets.md) | 每 tick 下发的 `state` 数据包字段与按玩家裁剪 |
| [units.md](./units.md) | `units.ts`：单位命令与逐 tick 推进 |
| [sessions.md](./sessions.md) | 房间内玩家会话（无独立鉴权模块） |
| [shared-integration.md](./shared-integration.md) | 如何依赖 `@wop/shared` |

## 源码一览

```
core/server/
  package.json          # 包名 @wop/server；main → dist/room.js
  tsconfig.json
  src/
    index.ts            # 可选调试：单房间 + WebSocket 监听
    room.ts             # 核心：createRoom / GameRoom / GameRoomHandle
    units.ts            # 单位命令处理与 tick 推进封装
```

## 一句话架构

- **权威状态**在 `GameRoom` 闭包内（建筑、联络线、单位、污染、HUD 的 E/O）。
- **规则与协议类型**来自 `@wop/shared`（`ClientToServer` / `ServerToClient` / 建造·单位·视野过滤等纯函数）。
- **传输层**由调用方提供：`join({ send })` 注入 `RoomSend`；房间只通过该回调推送 JSON 消息对象。
- **时钟**由外部按 `TICK_MS`（5 Hz，见 `time.ts`）调用 `room.tick()`。

## 快速启动（调试）

在 `core/` 工作区：

```bash
# 先构建 shared，再跑 server
npm run build -w shared
npm run dev -w server
# 默认 ws://localhost:8787 ，房间 DEBUG1
# PORT / WOP_DEBUG_ROOM_ID 可覆盖
```

生产路径：构建 `core/server` → `manager` 动态加载 `core/server/dist/room.js` 的 `createRoom`（见 `manager/src/gameBridge.ts`），**不要** import `dist/index.js`（会启动调试监听）。
