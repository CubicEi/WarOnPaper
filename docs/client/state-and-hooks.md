# 状态、App 与 hooks

源码：`App.tsx`、`game/initGame.ts`、`debug/playerActionLog.ts`。客户端没有 Redux；以 React state + refs + 一个联网 hook 为主。

## 1. `App` 状态一览

| 状态变量 | 类型 / 来源 | 作用 |
|----------|-------------|------|
| `viewport` | `{ w, h }` | 窗口尺寸 → canvas 宽高 |
| `state` | `GameStateSnapshot \| null` | 权威对局快照 |
| `terrain` | `TerrainMap \| null` | 由 seed + resourceTerrain 派生 |
| `debugOpen` | boolean | F2 切换 |
| `showEnemyVision` | boolean | 角落「视野」按钮 → 画布米黄敌方视野 |
| `showCommStatus` | boolean | 角落「通信」按钮 → 青/红通信覆盖 |
| `errorLog` | `DebugErrorEntry[]` | 最近 50 条 raw 错误（F2） |
| `toastMessage` / `toastKey` / `toastVariant` | toast UI | 友好提示；`error` \| `warn` |

来自 `useGameSocket`：`status`、`send`、`lastError`、`lastTip`、`playerId`、`chatMessages`、`leaveRoom`。

## 2. 地形同步逻辑

`useEffect` 依赖 `state.map`、`state.terrainSeed`、`state.phase`、`state.resourceTerrain`：

1. 无 map/seed：若 `phase === "need_init"` 则 `setTerrain(null)`。
2. 否则 `applyTerrainSeed(map, seed, prev)`：seed 与尺寸未变则复用 prev，避免每 tick 重生。
3. 再 `syncTerrainResources(base, resourceTerrain)`：应用服务器耗尽补丁（林→平原、油/铀边消失）；有变更时返回新引用以触发重绘。

`initGame.ts`：

| 函数 | 作用 |
|------|------|
| `requestGameInit(send, mapSize?, seed?)` | 发 `init`（调试/旧流；托管房间通常已有地图） |
| `applyTerrainSeed` | `generateTerrain({ map, seed })` |
| `syncTerrainResources` | `applyResourceTerrainSync`；变则浅拷贝 `cells`/`deposits` |

## 3. 定都本地校验（`onPlaceCapital`）

在发网前：

1. 无 terrain → 拒绝「请先初始化」
2. `capitalSiteRejectReason(terrain, gx, gy)` → 友好文案
3. `capitalExclusionRejectReason` 相对其它首都距离
4. 通过则 `send({ type: "place_capital", gx, gy })`

失败均 `logLocalReject` + `pushError`。

## 4. 命令包装模式

几乎每个 `onXxx` 都是：

```text
log.info → send({ type, ... }) → 若 !ok 则 log.error
```

能源/组织**只作为 affordance 传给 GameCanvas**（按钮灰显、装填上限），数值本身不在 App 内运算。

## 5. 键盘与辅助 UI

- **F2**：切换 `DebugOverlay`（输入框聚焦时忽略）。
- **返回**：`leaveRoom` + 跳转 `/`。
- **角落工具**：`showCommStatus` / `showEnemyVision`；旁侧 `phaseHint` chip。

`windowHudSize = max(w,h) / 16` 控制左上角 HUD 环直径上限。

## 6. 传给 `GameCanvas` 的关键 props

世界数据：`map`、`terrain`、`buildings`、`liaisons`、`units`、`resourceSight`、`connectedBuildingIds`、`pollutionZones`。

身份与阶段：`phase`、`myPlayerId`、`tick`、`playerNames`、`energy`、`organization`。

覆盖开关：`showEnemyVision`、`showCommStatus`。

聊天：`chatMessages`、`onSendChat`。

回调：建造/拆除/训练/开火/调动全套（见 [networking.md](./networking.md)）。

## 7. `playerActionLog`

`debug/playerActionLog.ts`：

- 单例 `PlayerActionLog(200)`（shared 实现）。
- `usePlayerActionLog()`：`useSyncExternalStore` 订阅，供 F2 列表。
- `logOutgoingAction`：过滤 `shouldLogClientAction`，摘要 `summarizeClientAction`。
- `applyServerActionResult`：把 pending 标为 ok/fail。
- `logLocalReject`：未发网的失败。

## 8. 没有其它自定义 hooks

除 `useGameSocket` / `usePlayerActionLog` 外，交互状态集中在 `GameCanvas` 内部的 `useState`/`useRef`/`useMemo`（见 [game-canvas.md](./game-canvas.md)）。组件级如 `BuildModeOverlay`、`ChatPanel` 自管展开/动画状态。
