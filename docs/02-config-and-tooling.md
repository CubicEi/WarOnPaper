# 02 — 配置与工具链

本文汇总脚本、依赖、TypeScript/Vite 配置、环境变量与版本管理。字段说明均来自仓库内实际文件。

## 1. 包与依赖总表

| 包名 | 路径 | 运行时依赖 | 主要开发依赖 |
|------|------|------------|--------------|
| `war-on-paper`（workspace 根） | `core/` | — | `concurrently` |
| `@wop/shared` | `core/shared` | 无 | `typescript` |
| `@wop/server` | `core/server` | `@wop/shared`、`ws` | `tsx`、`typescript`、`@types/node`、`@types/ws` |
| `@wop/client` | `core/client` | `@wop/shared`、`react`、`react-dom` | `vite`、`@vitejs/plugin-react`、`typescript`、React 类型 |
| `@wop/manager` | `manager/` | `ws` | `tsx`、`typescript`、`@types/node`、`@types/ws` |
| `@wop/manager-client` | `manager/client` | `react`、`react-dom` | 同 core client 的 Vite/React 工具链 |

说明：

- `core/` 使用 npm **workspaces**（`shared` / `server` / `client`），在 `core/` 下一次 `npm install`。
- `manager/` 与 `manager/client` 是**独立**的 `package.json`（各自 lockfile），需分别安装。
- manager **不**把 `@wop/server` 写进 dependencies，而是运行时动态加载已构建的 `core/server/dist/room.js`。

## 2. npm 脚本

### 2.1 `core/package.json`

| 脚本 | 行为 |
|------|------|
| `dev` | `concurrently` 并行：`server` + `client` 的 `dev` |
| `dev:server` | `npm run dev -w server` |
| `dev:client` | `npm run dev -w client` |
| `build` | 依次：`shared` → `server` → `client` 的 `build` |

### 2.2 `core/shared`

| 脚本 | 行为 |
|------|------|
| `build` | `tsc -p tsconfig.json` → `dist/` |
| `dev` | `tsc --watch` |

### 2.3 `core/server`

| 脚本 | 行为 |
|------|------|
| `dev` | `tsx watch src/index.ts`（调试监听） |
| `build` | `tsc` → `dist/` |
| `start` | `node dist/index.js`（调试入口） |

### 2.4 `core/client`

| 脚本 | 行为 |
|------|------|
| `dev` | `vite`（默认端口见 vite 配置 `5173`） |
| `build` | `tsc -b && vite build` |
| `preview` | `vite preview` |

### 2.5 `manager/package.json`

| 脚本 | 行为 |
|------|------|
| `dev` | `tsx watch src/index.ts` |
| `build` | `tsc` + `manager/client` 的 `build` |
| `build:server` | 仅 `tsc` |
| `build:client` | `npm run build --prefix client` |
| `start` | `node dist/index.js` |
| `typecheck` | `tsc --noEmit` |

### 2.6 `manager/client`

| 脚本 | 行为 |
|------|------|
| `dev` | `vite`（端口 `5174`） |
| `build` | `tsc --noEmit && vite build` |
| `preview` | `vite preview` |

### 2.7 根目录与启动器

| 入口 | 行为 |
|------|------|
| `build.cmd` | `core` 全量 build → `manager` `build:server` → `manager/client` build |
| `start.cmd` | `node manager/start.js` |
| `start.sh` | `exec` `manager/start.sh` |
| `manager/start.sh` | 检查 `node`；`PORT` 默认 `4358`；执行 `node start.js` |
| `manager/start.js` | 确保依赖与构建后启动 `manager/dist/index.js` |

`start.js` 额外参数 / 环境：

| 开关 | 含义 |
|------|------|
| `WOP_BUILD=1` | 强制重建 core + manager |
| CLI `--build` | 同 `WOP_BUILD=1` |
| `PORT` | 传给 manager 进程（默认 `"4358"`） |

缺失检测文件（任一缺失则构建对应树）：

- core：`shared/dist/index.js`、`server/dist/index.js`、`server/dist/room.js`、`client/dist/index.html`
- manager：`dist/index.js`、`client/dist/index.html`

## 3. TypeScript 配置要点

| 包 | `module` / 解析 | 输出 | 其它 |
|----|-----------------|------|------|
| shared | `ESNext` + `bundler` | `dist/` + `declaration` | `strict` |
| server | `NodeNext` | `dist/` | `esModuleInterop` |
| client | `ESNext` + `bundler` | **`noEmit: true`**（由 Vite 打包） | `jsx: react-jsx`；`paths["@version.json"]` |
| manager | `NodeNext` | `dist/` + `declaration` + `sourceMap` | |
| manager-client | 同 client | `noEmit` | `paths["@version.json"]` |

各包 `target` 均为 `ES2022`，均开启 `strict`。

## 4. Vite 配置要点

### 4.1 `core/client/vite.config.ts`

| 项 | 值 / 含义 |
|----|-----------|
| 插件 | `@vitejs/plugin-react`；`watch-version-json` 监听根 `version.json` |
| `resolve.alias["@wop/shared"]` | `../shared/src/index.ts`（开发直连源码） |
| `resolve.alias["@version.json"]` | 仓库根 `version.json` |
| `server.port` | `5173` |
| `server.host` | `true` |
| `server.proxy["/ws"]` | `ws://localhost:4358` |
| `publicDir` | `../assets`（即 `core/assets`） |
| `fs.allow` | 上溯到仓库根（读 `version.json` 等） |
| `watch.ignored` | `assets` 下 jpg、`__pycache__`（避免文件锁） |

### 4.2 `manager/client/vite.config.ts`

| 项 | 值 / 含义 |
|----|-----------|
| `alias["@version.json"]` | 仓库根 `version.json` |
| `server.port` | `5174` |
| 代理 | `/ws`、`/play`、`/assets` → `http(s)://localhost:4358` |
| `build.outDir` | `dist`；`emptyOutDir: true` |

## 5. 环境变量与本地存储

### 5.1 进程环境变量

| 变量 | 使用位置 | 默认 | 含义 |
|------|----------|------|------|
| `PORT` | `manager/src/index.ts`、`start.js` / `start.sh` | `4358` | manager HTTP+WS 端口 |
| `PORT` | `core/server/src/index.ts` | `8787` | **仅调试**单房间 WS 端口 |
| `WOP_BUILD` | `manager/start.js` | 未设 | `"1"` 时强制 rebuild |
| `WOP_DEBUG_ROOM_ID` | `core/server/src/index.ts` | `"DEBUG1"` | 调试房间 ID |
| `VITE_WS_URL` | `core/client` `useGameSocket` | 未设则用 `ws(s)://当前 host/ws` | 覆盖 WebSocket URL（例如直连 `:8787`） |
| `WOP_SAVE_KEY` | `manager/src/saveCrypto.ts` | **必填才可存档** | AES-256-GCM 密钥材料；缺失则拒绝导出/读档（见 [manager/save-load.md](./manager/save-load.md)） |

`.gitignore` 忽略 `.env`、`.env.*`（保留 `!.env.example` 模式）；仓库中是否存在示例文件以实际检出为准。

### 5.2 浏览器 localStorage（对局 client）

定义于 `core/client/src/net/useGameSocket.ts`：

| Key | 用途 |
|-----|------|
| `wop:playerId` | 缓存玩家 UUID |
| `wop:playerName` | 显示名 |
| `wop:lastRoomId` | 最近房间，便于重连/回座 |

Manager 标题客户端另有 `manager/client/src/storage.ts` 做大厅侧持久化（与上表分离）。

### 5.3 服务端持久化

| 路径 | 用途 |
|------|------|
| `manager/data/identities.json` | 身份库：`version: 1` + `identities[]`（`playerId` / `name` / `lastSeenAt`）；断线后约 7 天 TTL |

目录已 gitignore，首次运行由 `IdentityStore` 创建。

## 6. 版本号

根目录 `version.json`：

```json
{
  "version": "beta1.4.5_261002"
}
```

| 消费者 | 用法 |
|--------|------|
| `manager/client` `TitleScreen` | 标题页展示 `versionJson.version` |
| `core/client` `DebugOverlay` | F2 调试面板顶部展示 |

各客户端 `package.json` 内的 `"version": "0.1.0"` 是 npm 包版本，**不是**面向玩家的产品版本字符串。

## 7. 包导出约定（生产加载相关）

### `@wop/shared`

```json
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": { ".": { "types": "...", "import": "..." } }
```

### `@wop/server`

```json
"main": "./dist/room.js",
"exports": {
  ".": → room.js,
  "./room": → room.js,
  "./package.json": "./package.json"
}
```

要点：默认入口是 **房间库**，不是 `index.js`。manager 的 `CORE_GAME_ROOM_MODULE` 指向 `core/server/dist/room.js`。

## 8. 常用命令速查

```bash
# 产品：构建并启动（Windows）
build.cmd
start.cmd

# 产品：Unix
./start.sh
WOP_BUILD=1 PORT=4358 ./start.sh

# 仅 core 开发
cd core && npm install && npm run dev

# 调试单房间 server
cd core && npm run build -w shared && npm run dev -w server
# PORT=8787 WOP_DEBUG_ROOM_ID=DEBUG1

# manager 开发（需已有 core dist 或先 build）
cd manager && npm install && npm run dev
cd manager/client && npm install && npm run dev
```

## 9. 相关文档

- [00-project-overview.md](./00-project-overview.md) — 架构与数据流  
- [01-repository-structure.md](./01-repository-structure.md) — 目录说明  
- [docs/README.md](./README.md) — 文档索引  
