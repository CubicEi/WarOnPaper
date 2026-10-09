# WarOnPaper Manager 文档（`manager`）

本文档描述 `@wop/manager`（路径：`manager`）的架构与实现。Manager 是产品进程入口：托管标题 SPA、对局 SPA 静态资源、大厅 WebSocket（`/ws`），并通过 `gameBridge` 动态加载 `@wop/server` 的 `createRoom` / `GameRoom`，以 15 Hz 调度多房间。

## 文档索引

| 文档 | 内容 |
|------|------|
| [architecture.md](./architecture.md) | 包结构、进程边界、启动数据流、与 core 的关系 |
| [start-and-hosting.md](./start-and-hosting.md) | `start.js` / `start.sh`、路径常量、HTTP 静态托管 |
| [game-bridge.md](./game-bridge.md) | `gameBridge`：加载 `room.js`、`GameRoomHandle` 契约、tick 常量 |
| [lobby-ws.md](./lobby-ws.md) | 协议、身份、匹配队列、`RoomRegistry`、WS 消息分流 |
| [title-spa.md](./title-spa.md) | `manager/client` 标题大厅 SPA |
| [save-load.md](./save-load.md) | `.wopsave` 加解密、`config.json` saveKey、开局/读档准备大厅 |

## 源码一览

```
manager/
  package.json              # @wop/manager；scripts: build / start / dev
  tsconfig.json             # NodeNext → dist/
  start.js                  # 跨平台启动器：install / build / 跑 dist/index.js
  start.sh                  # bash 包装；默认 PORT=4358
  src/
    index.ts                # HTTP + WebSocket /ws 主进程
    paths.ts                # 相对路径常量（core / dist / identity）
    httpStatic.ts           # 静态：标题、/play/、资产、健康检查
    gameBridge.ts           # 动态 import createRoom
    rooms.ts                # RoomRegistry：建房 / 入座 / tick / 销毁
    lobby.ts                # MatchQueues：2–5 人匹配
    identity.ts             # UUID↔昵称；7 天 TTL；JSON 持久化
    protocol.ts             # 大厅消息类型与类型守卫
    saveCrypto.ts           # AES-GCM `.wopsave` 封包 / 解包
  client/                   # @wop/manager-client（独立 Vite 包）
    package.json
    vite.config.ts          # :5174；代理 /ws /play /assets → :4358
    src/
      main.tsx / App.tsx
      screens/TitleScreen.tsx
      net.ts / storage.ts / styles.css
  data/                     # 运行时（gitignore）
    identities.json
  dist/                     # tsc 产物（概念上：运行入口）
```

## 一句话架构

- **一个 Node 进程**监听 `PORT`（默认 `4358`）：HTTP 静态 + `WebSocketServer` 路径 `/ws`。
- **大厅消息**（`protocol.ts`）在 manager 内处理：身份、建房、加入、匹配、离房。
- **对局消息**不透明转发到对应 `GameRoom.dispatch`；推送经 `RoomSend` 写回同一 WebSocket。
- **权威房间**来自 `core/server/dist/room.js`（`createRoom`），**不要**加载会起调试监听的 `dist/index.js`。
- **时钟**由 `RoomRegistry` 按 `GAME_TICK_MS = 1000/15` 对所有房间调用 `tick()`。

## 快速启动

仓库根或 `manager/`：

```bash
# 推荐：根目录入口（内部转调 manager/start.js）
# Windows: start.cmd
# Unix:    ./start.sh

# 或直接
node manager/start.js
# 强制重建：WOP_BUILD=1 或 --build
# 端口：PORT=4358（默认）
```

开发热重载服务端（需已构建 `core/server/dist/room.js` 等）：

```bash
cd manager
npm run dev    # tsx watch src/index.ts
```

标题 SPA 单独开发：

```bash
cd manager/client
npm run dev    # Vite :5174，代理到 manager :4358
```

## 相关文档

- [../00-project-overview.md](../00-project-overview.md) — 仓库总览  
- [../01-repository-structure.md](../01-repository-structure.md) — 目录树  
- [../02-config-and-tooling.md](../02-config-and-tooling.md) — 脚本与环境变量  
- [../server/README.md](../server/README.md) — `GameRoom` 权威房间库  
