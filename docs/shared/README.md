# `@wop/shared` 文档索引

本文档覆盖 `core/shared` 包：服务端权威仿真与客户端共用的纯逻辑层（无 DOM、无 WebSocket 运行时）。

包入口：`core/shared/src/index.ts`  
包配置：`core/shared/package.json`（`@wop/shared`，构建输出 `dist/`）

## 模块地图

```
core/shared/src/
├── index.ts              # 公共导出、TICK、协议类型、GameStateSnapshot
├── map.ts                # 地图尺寸 MapConfig
├── terrain/              # 地形生成、首都/港口选址、路轨造价
├── buildings/            # 建筑目录、放置/修理、经济、通信、联络线、污染
├── units/                # 兵种、驻军、命令、寻路、tick、交战、封锁…
├── vision/               # 卫星/直接视野与快照过滤
└── debug/                # F2 行动日志类型与辅助
```

| 子域 | 主要源文件 | 文档 |
|------|------------|------|
| 包总览 / 协议 | `index.ts`, `map.ts` | [architecture.md](./architecture.md)、[types-protocol.md](./types-protocol.md) |
| 地形 | `terrain/*` | [terrain.md](./terrain.md) |
| 建筑 | `buildings/*` | [buildings.md](./buildings.md) |
| 单位核心 | `units/catalog`, `types`, `garrison`, `filter`, `occupy`, `radio`, `supply`, `train`, `carrier` | [units-core.md](./units-core.md) |
| 命令与寻路 | `units/orders`, `units/pathfind` | [orders-pathfind.md](./orders-pathfind.md) |
| Tick / 交战 | `units/tick`, `combat`, `fight`, `blockade`, `antiAir`, `liaisonAttack` | [tick-combat.md](./tick-combat.md) |
| 视野 | `vision/vision.ts` | [vision.md](./vision.md) |
| 调试 | `debug/actionLog.ts` | [debug.md](./debug.md) |

## 建议阅读顺序

1. **[architecture.md](./architecture.md)** — shared 相对 client/server 的职责、权威性、tick 节奏  
2. **[types-protocol.md](./types-protocol.md)** — `GameStateSnapshot`、`ClientToServer` / `ServerToClient`  
3. **[terrain.md](./terrain.md)** — 格子模型与选址约束（后续寻路依赖）  
4. **[buildings.md](./buildings.md)** — `PlacedBuilding`、目录、通信波、联络线  
5. **[units-core.md](./units-core.md)** — `UnitGroup`、驻军 `u` / `awayOccupiedU`、电台覆盖  
6. **[orders-pathfind.md](./orders-pathfind.md)** — 下达命令如何规划路径  
7. **[tick-combat.md](./tick-combat.md)** — 每 tick 如何推进移动与交战  
8. **[vision.md](./vision.md)** — 如何把权威世界滤成玩家快照  

## 刻意跳过

- `core/shared/_tmp_*` — 本地临时复现脚本  
- `dist/`、`node_modules/` — 编译产物与依赖  

## 包脚本

| 脚本 | 作用 |
|------|------|
| `npm run build`（在 `core/shared`） | `tsc` → `dist/` |
| `npm run dev` | `tsc --watch` |
