# 01 — 仓库结构

本文说明 WarOnPaper 仓库中重要目录与文件的用途。已忽略：`node_modules/`、`dist/`、`.git/`、`__pycache__/`、图标二进制资产细节、`core/shared/_tmp_*` 临时脚本。

## 1. 顶层树

```text
WarOnPaper/
├── config.json               # 产品版本号 + saveKey（标题页 / F2 / 存档）
├── build.cmd                 # 一键构建 core + manager
├── start.cmd                 # Windows：node manager/start.js
├── start.sh                  # Unix：转调 manager/start.sh
├── .gitignore
├── 纸上谈兵4-规则文档.md      # 游戏规则（非工程文档）
├── docs/                     # 本架构文档树
├── core/                     # 游戏核心 npm workspaces
└── manager/                  # 产品入口：大厅 + 静态托管 + 房间调度
```

## 2. `docs/`

| 路径 | 用途 |
|------|------|
| `README.md` | 文档总索引 |
| `00-project-overview.md` | 整体架构 |
| `01-repository-structure.md` | 本文件 |
| `02-config-and-tooling.md` | 配置与工具链 |
| `shared/` | `@wop/shared` 包级文档索引（及规划中的子页） |
| `server/` | `@wop/server` 包级文档索引 |
| `client/` | `@wop/client` 包级文档索引 |
| `manager/` | `@wop/manager` 包级文档索引（架构、大厅 WS、gameBridge、标题 SPA） |

## 3. `core/` — 游戏核心

```text
core/
├── package.json              # workspaces + concurrently 开发脚本
├── package-lock.json
├── .gitignore
├── scripts/
│   └── gen-ui-icons.mjs      # 生成 core/assets/ui 下简易 PNG
├── assets/                   # 客户端静态资源（Vite publicDir）
│   ├── icons/                # 建筑/单位等图标（多主题目录）
│   │   └── manifest.json
│   └── ui/                   # UI 图（含脚本生成物）
├── shared/                   # @wop/shared
├── server/                   # @wop/server
└── client/                   # @wop/client
```

### 3.1 `core/shared`

| 路径 | 用途 |
|------|------|
| `package.json` | 包名 `@wop/shared`；`main`/`exports` → `dist/index.js` |
| `tsconfig.json` | 编译到 `dist/`，生成 `.d.ts` |
| `src/index.ts` | 公共导出：TICK、协议、快照类型、各子域 re-export |
| `src/map.ts` | `MapSizeId`、`MAP_SIZES`、`DEFAULT_MAP_SIZE_ID` |
| `src/terrain/` | 地形生成、首都/港口选址、放置相关 |
| `src/buildings/` | 建筑目录、放置/修理/拆除、经济、通信、联络线、污染、作业范围 |
| `src/units/` | 兵种目录、驻军、命令、寻路、tick、交战、封锁、防空、训练、补给、航母等 |
| `src/vision/` | 视野与快照过滤 |
| `src/debug/` | F2 行动日志相关类型/辅助 |

详见 [shared/README.md](./shared/README.md)。

### 3.2 `core/server`

| 路径 | 用途 |
|------|------|
| `package.json` | `@wop/server`；**库入口** `dist/room.js`；依赖 `@wop/shared`、`ws` |
| `tsconfig.json` | `module`/`moduleResolution`: `NodeNext` → `dist/` |
| `src/room.ts` | `createRoom`、`GameRoom`、`GameRoomHandle`：权威房间 |
| `src/units.ts` | 单位命令处理与逐 tick 推进（供 room 调用） |
| `src/index.ts` | **可选调试**：单房间 + `WebSocketServer`（默认 `:8787`） |
| `scripts/transform-room.mjs` | 房间相关脚本工具（非运行时入口） |

详见 [server/README.md](./server/README.md)。

### 3.3 `core/client`

| 路径 | 用途 |
|------|------|
| `index.html` | 对局页；标题「纸上谈兵 4」 |
| `package.json` | `@wop/client`；Vite + React 19；依赖 `@wop/shared` |
| `vite.config.ts` | `@wop/shared`→源码、`@config.json`、`publicDir`→`../assets`、代理 `/ws`→`:4358` |
| `tsconfig.json` | `noEmit`；路径 `@config.json` |
| `src/main.tsx` | React 挂载 |
| `src/App.tsx` | 状态枢纽：快照、地形、命令转发、回标题 |
| `src/styles.css` | 全局样式 |
| `src/vite-env.d.ts` | Vite 客户端类型引用 |
| `src/canvas/` | `GameCanvas`、`drawMap`、小地图、地形色、建筑/单位图标 |
| `src/components/` | HUD、建造树、训练/动员、检视、聊天、调试覆盖层等 |
| `src/net/` | `useGameSocket`、日志 |
| `src/game/initGame.ts` | 按 `terrainSeed` 复现地形、同步资源可见性 |
| `src/ui/buildingUiIcon.ts` | 建筑 UI 图标路径辅助 |
| `src/debug/playerActionLog.ts` | 本地行动日志 |

详见 [client/README.md](./client/README.md)。

Manager 产品入口与大厅调度详见 [manager/README.md](./manager/README.md)。

### 3.4 `core/assets`

| 路径 | 用途 |
|------|------|
| `icons/` | 游戏图标资源；`manifest.json` 索引；多主题子目录（如 online / offline / orange / black） |
| `ui/` | 界面用图；可由 `core/scripts/gen-ui-icons.mjs` 生成部分文件 |

Vite 将 `core/assets` 作为 `core/client` 的 `publicDir`，开发与构建后可按 `/icons/...`、`/ui/...` 访问。manager 静态托管也会从 `core/assets` 与各 `client/dist` 提供同类路径。

## 4. `manager/` — 产品入口

```text
manager/
├── package.json              # @wop/manager
├── tsconfig.json
├── start.js                  # 跨平台启动器：install / build / 跑 dist
├── start.sh                  # bash 包装，默认 PORT=4358
├── src/                      # 服务端源码 → dist/
├── client/                   # 标题 SPA（独立 npm 包）
└── data/                     # 运行时身份库（gitignore）
    └── identities.json
```

### 4.1 `manager/src`

| 文件 | 用途 |
|------|------|
| `index.ts` | HTTP + `/ws` 主循环；会话、大厅消息、转发对局消息 |
| `paths.ts` | 相对路径常量：`CORE_ROOT`、各 dist、`IDENTITY_DATA_PATH`、`CORE_GAME_ROOM_MODULE` |
| `httpStatic.ts` | 静态文件：`/` 标题、`/play/` 对局、`/assets`、健康检查 |
| `gameBridge.ts` | 动态加载 `createRoom`；定义 `GameRoomHandle` 契约镜像 |
| `rooms.ts` | `RoomRegistry`：建房/加入/tick 全房间/空闲销毁 |
| `lobby.ts` | `MatchQueues`：按人数 2–5 匹配；地图尺寸映射 |
| `identity.ts` | UUID↔昵称；7 天 TTL；持久化 JSON |
| `protocol.ts` | 大厅消息类型与 `isLobbyClientMessage`（与 shared 大厅字段对齐） |

### 4.2 `manager/client`

| 路径 | 用途 |
|------|------|
| `package.json` | `@wop/manager-client`；Vite + React 19（**不**依赖 `@wop/shared`） |
| `vite.config.ts` | 端口 `5174`；代理 `/ws`、`/play`、`/assets` → manager |
| `src/App.tsx` | 渲染 `TitleScreen` |
| `src/screens/TitleScreen.tsx` | 标题 / 建房 / 加入 / 匹配；展示 `config.json` 版本 |
| `src/net.ts` | `LobbySocket`；大厅消息类型 |
| `src/storage.ts` | 本地身份等存储 |
| `src/styles.css` | 标题页样式 |

深入说明见 [manager/README.md](./manager/README.md)。

## 5. 构建产物（不入库，运行需要）

| 产物路径 | 来源 | 谁使用 |
|----------|------|--------|
| `core/shared/dist/` | `tsc` | `@wop/server`、（生产）可能被其它包引用 |
| `core/server/dist/room.js` | `tsc` | **manager `gameBridge` 必载** |
| `core/server/dist/index.js` | `tsc` | 仅调试 `npm run start -w server` |
| `core/client/dist/` | Vite build | manager `/play/` |
| `manager/dist/` | `tsc` | `start.js` 启动入口 |
| `manager/client/dist/` | Vite build | manager `/` 标题 |

`manager/start.js` 在缺少上述关键产物时会自动触发对应 `npm run build`。

## 6. 刻意不展开的内容

- **图标二进制**：只说明目录角色；具体 PNG 命名以 `icons/manifest.json` 与代码中的路径规则为准。  
- **`_tmp_*`**：shared 下本地复现/实验脚本，非正式模块。  
- **`.cursor/`**：编辑器/计划文件，已 gitignore。  
- **规则文档**：玩法数值与设计见根目录规则 Markdown，不在本结构文档复述。  
