# 类型、协议与地图

源文件：

- `core/shared/src/index.ts` — 协议、快照、全局常量与 re-export
- `core/shared/src/map.ts` — 地图尺寸

## `map.ts`

### `MapSizeId` / `MapConfig`

| 字段 | 含义 |
|------|------|
| `id` | `"89x59"` \| `"119x79"` |
| `cellsX` / `cellsY` | 经向/纬向**格子**数 |
| `linesX` / `linesY` | 经线/纬线数（= cells + 1） |

`MAP_SIZES` 提供两档；`MAP_SIZE_OPTIONS` 给 UI；`DEFAULT_MAP_SIZE_ID = "89x59"`；`isMapSizeId` 做运行时收窄。

注释：线网尺寸对应「格数 + 1」的节点网格（建筑落在整数节点上）。

---

## 游戏阶段与 HUD（`index.ts`）

### `GamePhase`

| 值 | 含义 |
|----|------|
| `need_init` | 房间待初始化地图 |
| `pick_capital` | 选首都（含允许重生时的再选） |
| `playing` | 对局中 |
| `spectating` | 观战 |
| `ended` | 结束 |

### `SnapshotRole`

`"player"` \| `"spectator"` — 观战者拿未过滤世界。

### `PlayerHudState`

| 字段 | 含义 |
|------|------|
| `capitalHp` / `capitalHpMax` | 首都生命 |
| `energy` | 能源 E（服务端权威） |
| `organization` / `organizationMax` | 组织度 O |

---

## `GameStateSnapshot`

服务端周期性下发的世界切片（已按观众过滤，观战除外）。部分顶层字段按发送规则省略；客户端用 `mergeGameStateSnapshot` 合并。细节见 [tick-packets.md](./tick-packets.md) §3.0。

| 字段 | 类型来源 | 含义 | 发送 |
|------|----------|------|------|
| `tick` | `number` | 当前仿真 tick | 每帧 |
| `map?` | `MapConfig` | 本局地图尺寸 | 仅开局 / 再入房 |
| `you` | `PlayerHudState` | 本观众 HUD | 每帧 |
| `buildings` | `PlacedBuilding[]` | 可见建筑 | 每帧 |
| `liaisons` | `PlacedLiaison[]` | 可见联络线 | 每帧 |
| `units` | `UnitGroup[]` | 可见单位组 | 每帧 |
| `connectedBuildingIds` | `string[]` | **本玩家**与首都通信连通的建筑实例 id | 每帧 |
| `pollutionZones` | `PollutionZone[]` | 核污染区 | 每帧 |
| `phase` | `GamePhase` | 阶段 | 每帧 |
| `terrainSeed?` | `number \| null` | 地形种子；客户端本地 `generateTerrain` | 仅开局 / 再入房 |
| `resourceSight` | `ResourceSightCell[]` | 已揭示储量环（再经视野过滤） | 每帧 |
| `resourceTerrain` | `ResourceTerrainSync` | 枯竭格与矿点储量，驱动地形重绘 | 每帧 |
| `players?` | `{id,name}[]` | 检查面板显示所有者名 | 每帧 |
| `roomId?` | `string` | 托管对局房间 id | 每帧 |
| `allowRespawn?` | `boolean` | 首都陷落后再选都 vs 观战 | 仅开局 / 再入房 |
| `role?` | `SnapshotRole` | 观众角色 | 仅相对该连接上次发送值变化时 |
| `winnerId?` / `winnerName?` | `string \| null` | 终局 | 仅相对该连接上次发送值变化时 |

---

## `ClientToServer`

客户端 → 服务端消息联合类型。按主题分组：

### 会话 / 房间

| `type` | 要点 |
|--------|------|
| `hello` | 可选 `playerId`、`name`；服务端可新发 UUID |
| `ping` | 延迟探测，带 `t` |
| `create_room` | `mapSize`、`seed?`、`allowRespawn`、`maxPlayers` 2–10 |
| `join_room` | `roomId` |
| `queue_match` | 匹配大厅人数 2–5 |
| `cancel_queue` / `leave_room` | 取消匹配 / 离开 |
| `init` | 遗留单房：地图与种子 |
| `chat` | 明文，服务端截断 |

### 定都与建造

| `type` | 要点 |
|--------|------|
| `place_capital` | `gx,gy` |
| `build` | `buildingId`、坐标、`ground: GroundContext`（客户端地形上下文，服务端接管前） |
| `build_liaison` | `kind` + `nodes` |
| `demolish` / `demolish_liaison` | 实例 id |
| `repair` / `level_upgrade` | 修理 / 线性升级 |
| `relocate_capital` | 指定首府变首都 |
| `reload` / `deploy` | 装填弹药 / 补给站部署步数 |

### 训练与火力

| `type` | 要点 |
|--------|------|
| `train` | 训练场 id、`TrainableKind`、`u`、`targetIds`（或弃用的单 `targetId`） |
| `fire` | 发射建筑；目标建筑或（臼炮）`targetUnitId` |

### 单位命令

| `type` | 对应 shared 入口（典型） |
|--------|---------------------------|
| `move_units` | `applyUnitMove` |
| `assign_home` | `applyAssignHome` |
| `stop_units` | `applyUnitStop`（`retreat?`） |
| `blockade_units` / `end_blockade` | `applyUnitBlockade` / `applyEndBlockade` |
| `supply_units` | `applyUnitSupply` |
| `attack_units` | `applyUnitAttack` 或 `applyLiaisonAttack`（联络线段） |
| `hold_units` / `end_hold` | `applyUnitHold` / `applyEndHold` |
| `mutual_defense` | `applyMutualDefense` |
| `end_mutual_defense` | `applyEndMutualDefense` |
| `build_carrier` / `embark_air` / `disembark_air` | `carrier.ts` |

单位命令共用模式：

- `sources?: { buildingId, u }[]` — 从建筑派出新组  
- `unitIds?: string[]` — 已派出单位  

联络线进攻额外字段：`targetLiaisonId` + 段端点 `liaisonAx/Ay/Bx/By`。

---

## `ServerToClient`

| `type` | 含义 |
|--------|------|
| `welcome` | `playerId`、`name`、可选 `activeRoomId` / 初始 `state` |
| `state` | `GameStateSnapshot`（常规帧可省略 bootstrap / 未变化字段，见 tick-packets §3.0） |
| `pong` | 回显 `t` |
| `error` | `code` + `message` |
| `tip` | 提示文案 |
| `room_ready` / `room_status` / `match_status` | 房间与匹配 |
| `game_over` / `room_closed` | 终局与关房（`idle` \| `game_over` \| `destroyed`） |
| `chat` | 广播聊天 |
| `action_result` | 见 `debug/actionLog.ts` 的 `PlayerActionResultMsg` |

---

## `index.ts` 的 re-export 结构

`index.ts` 几乎 re-export 全包公开 API，按域聚类：

1. 地图、阶段、快照、协议  
2. `buildings/actions` — 放置/修理/拆除常量与函数  
3. `terrain/*` — 类型、生成、首都、路轨放置  
4. `buildings/catalog|workRange|pollution|levelUpgrade|economy|liaison|comm`  
5. `units/*` — 目录、驻军、寻路、命令、tick、交战、补给、航母、防空、训练  
6. `vision/vision`  
7. `debug/actionLog`  

查阅具体符号时：以 `index.ts` 导出列表为准，实现细节见各子域文档。

## 与子文档的交叉引用

- 每 tick 通信载荷（谁发谁收、字段表、过滤）→ [tick-packets.md](./tick-packets.md)  
- 建筑字段详解 → [buildings.md](./buildings.md)  
- `UnitGroup` 字段 → [units-core.md](./units-core.md)  
- 视野过滤如何改写快照字段 → [vision.md](./vision.md)  
