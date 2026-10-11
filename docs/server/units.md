# 单位子系统（`units.ts`）

文件：`core/server/src/units.ts`。  
由 `room.ts` 在 `dispatch` 与 `tick` 中调用；本身不持有全局状态，通过 `UnitWorld` / `UnitSession` 操作房间世界与 HUD。

## 1. 职责

- 把单位相关客户端命令转给 `@wop/shared` 的 `apply*` / `enqueueTraining` 等。
- 校验阶段、地形、通讯（部分）、E/O 余额。
- 用「清空再 push」方式写回 `buildings` / `units` / `liaisons`（与 shared 返回的新数组对齐）。
- 封装每 tick 的移动、训练交付、封锁、驻守/战斗、防空推进。

## 2. 核心类型

### `UnitSession`

```ts
{ id: string; hud: PlayerHudState; ws: WebSocket }
```

与房间 `PlayerSession` 结构兼容（同字段子集）。

### `UnitWorld`

| 字段 | 含义 |
|------|------|
| `map` | 地图配置 |
| `terrain` | 地形；移动/多数命令需要非 null |
| `buildings` / `liaisons` / `units` | 可变世界数组 |
| `connectedByOwner` | 通讯连通图（防空等按主人查询） |

## 3. Tick 推进函数

| 函数 | Shared 调用 | 副作用 |
|------|-------------|--------|
| `advanceUnitMovement` | `advanceUnits(..., dt=DT_SEC_PER_TICK)` | 替换 units；按 id 更新 buildings |
| `advanceUnitTraining` | `advanceTrainingQueues` + 完工 `createUnitGroup` + `applyUnitMove(..., asTrainingDelivery)` | 可能生成单位并自动开往目标建筑入库 |
| `advanceUnitBlockades` | `advanceBlockades` | 替换 units/buildings；返回各主人应扣 E 的 Map |
| `advanceUnitCombat` | `advanceHolds` → `advanceFightsAndSieges` → `advanceLiaisonCuts` | 替换单位/建筑/联络线；返回驻守 E 消耗 Map |
| `advanceUnitAntiAir` | `advanceAntiAir(..., { tick })` | 替换 units/buildings；返回 `AntiAirAmmoEvent[]` |

房间在封锁与战斗后把返回的 E 消耗落到 `player.hud.energy`（不低于 0）。防空事件经 `notifyAaAmmoEvents` 发 `tip`。

## 4. 命令处理模式（共性）

几乎所有 `handle*`：

1. `playing` 为 false → `not_playing`「请先选定首都」
2. 需要地形则检查 `world.terrain`
3. 调用 shared `apply*` / `enqueue*`
4. 失败 → 对应 `*_rejected` 或业务 code
5. 检查 `organization` / `energy`（按命令）
6. 扣费 → 写回世界 → `log` → `broadcast()`

部分命令额外：

- `handleTrainUnits` / `handleBuildCarrier`：需要 `commsLinked`
- `handleAttackUnits`：可选 `targetLiaison` 走 `applyLiaisonAttack`，否则 `applyUnitAttack`
- `handleStopUnits`：`retreat` 传给 `applyUnitStop`

## 5. 命令与消息对照

| Handler | 典型 ClientToServer | 主要费用常量（shared） |
|---------|---------------------|------------------------|
| `handleMoveUnits` | `move_units` | `UNIT_MOVE_O_COST`（及路径返回的 O/E） |
| `handleAssignHome` | `assign_home` | 返回的 `organizationCost` |
| `handleTrainUnits` | `train` | O + E（`TRAIN_O_COST` + `energyCost`） |
| `handleBlockadeUnits` | `blockade_units` | O + E（`UNIT_BLOCKADE_O_COST`） |
| `handleEndBlockade` | `end_blockade` | 无额外 HUD 费 |
| `handleSupplyUnits` | `supply_units` | O（`UNIT_SUPPLY_O_COST`） |
| `handleAttackUnits` | `attack_units` | O |
| `handleHoldUnits` | `hold_units` | O + E（`UNIT_HOLD_O_COST`） |
| `handleEndHold` | `end_hold` | 无 |
| `handleMutualDefense` | `mutual_defense` | O（`UNIT_MUTUAL_DEFENSE_O_COST`） |
| `handleEndMutualDefense` | `end_mutual_defense` | 无 |
| `handleBuildCarrier` | `build_carrier` | E（`CARRIER_BUILD_E`） |
| `handleEmbarkAir` / `handleDisembarkAir` | `embark_air` / `disembark_air` | 通常无 HUD 费 |
| `handleStopUnits` | `stop_units` | 可能 O/E（含撤退） |

## 6. 训练交付路径（tick）

`advanceUnitTraining` 完工后：

1. `createUnitGroup`：`homeBuildingId` 优先交货目标建筑。
2. 若目标建筑存在：`applyUnitMove` 带 `asTrainingDelivery`、`depositOnArrival`、`depositBuildingId`。
3. 寻路失败则单位留在出生格待命。

注释说明：home 选择是为了残余兵力/返回/撤退入库正确。

## 7. 与房间的耦合点

- **不**直接 import `room.ts`（避免环）；回调注入 `sendError` / `broadcast` / `log`。
- `nextId` 一律 `randomUUID`。
- `connectedIds` 取 `connectedByOwner.get(session.id) ?? new Set()` 传入 path/order 上下文。

单位战斗导致的首都毁灭不在 `units.ts` 内处理，而由房间 `reconcileCapitals` 在同一 tick 稍后执行。
