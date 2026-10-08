# GameCanvas 深度说明

文件：`core/client/src/canvas/GameCanvas.tsx`（约 3399 行）。本文按**职责块**说明，不逐行罗列。

## 1. 角色与导出

- **导出**：`GameCanvas`（唯一组件）。
- **职责**：主 canvas + 小地图 canvas 的输入与相机；选中环与点位菜单；建造/联络线编辑；建筑/单位检视 HUD；调动与训练面板；开火/互防瞄准；聊天叠层。
- **不负责**：WebSocket、权威状态合并（由 `App` 完成）。

绘制委托 `drawMap` / `drawMinimap`；每帧 rAF 读 refs，避免把 pan/zoom 放进 React state。

## 2. Props 命名约定

| 前缀 / 名 | 含义 |
|-----------|------|
| `map` / `terrain` | 格网配置与本地地形 |
| `buildings` / `liaisons` / `units` | 世界实体 |
| `connectedBuildingIds` | 己方通信连通实例 id |
| `resourceSight` | 已揭示资源储量采样点 |
| `myPlayerId` | 区分己方/敌方图标与可操作 |
| `gx` / `gy` | 网格坐标（Du，建筑节点多为整数） |
| `onBuild` / `onMoveUnits` / … | 向上发命令的回调 |
| `energy` / `organization` | 仅用于 UI 负担得起判断 |
| `showEnemyVision` / `showCommStatus` | 高级覆盖层 |

## 3. 核心本地状态

### 3.1 Refs（高频 / 事件闭包）

| Ref | 用途 |
|-----|------|
| `canvasRef` / `miniRef` | DOM |
| `*Ref` 镜像 props | `buildingsRef`、`unitsRef`… 供 rAF 与 pointer 闭包读最新值 |
| `panRef` / `zoomRef` | 相机；`MAP_ZOOM_MIN=1` … `MAX=16` |
| `cameraAnimRef` | 焦点缓动的 rAF id |
| `followUnitIdRef` | 检视单位时相机跟随 |
| `pendingBuildingFocusRef` | 建筑焦点延迟（150ms，让 Shift+双击拆除抢先） |
| `dragRef` | 拖拽：平移 / 联络线 pending / Ctrl 强制平移 |
| `pointersRef` / `pinchRef` | 多指捏合缩放 |
| `selectionRef` | 点选格点（画屏幕半环）；建筑/单位选中时为 null |
| `liaison*Ref` | 联络线 kind/draft/编辑/确认/拆除 |
| `destructionMarksRef` | 小地图毁坏警示 |
| `pendingDemolishIdsRef` | 己方主动拆除，跳过警示 |
| `workRangeRef` | 当前要画的射程圈（开火或检视） |
| `inspectFocusRef` | 检视 HUD 打开时传给 `drawMap` 的焦点图标（调暗其余） |
| `pathPreviewsRef` | 调动/训练路径预览折线 |
| `fireAimRef` / `mutualAimRef` | 瞄准模式建筑 id |

### 3.2 React state（驱动 DOM 浮层）

| State | 含义 |
|-------|------|
| `selectionUi` | `SelectionView`：`point` \| `building` \| `unit` + 屏幕坐标 |
| `inspectHudReady` | 焦点动画结束后才显示检视 HUD |
| `buildMode` | 建造叠加层：锚点、地面、`pendingBuildingId`、联络线 nonce |
| `liaisonKind` / `liaisonDraft` / `liaisonEditActive` / `liaisonAwaitConfirm` / `liaisonDemolishId` | 联络线编辑机 |
| `liaisonLocalError` | 本地错误条（铁路起点等） |
| `fireAim` / `fireAimNote` | 开火瞄准 |
| `mutualAim` / `mutualAimNote` | 互防瞄准 |
| `mobilize` | 调动面板：`mode` + 目的地 + `sources`/`unitIds` + 目标字段 |
| `trainUi` | 训练：`sourceId`/`kind`/`u`/`targetIds` |
| `focusMarks` | 面板勾选时的浅青色圈 |
| `enemyLiaison` | 点击敌方线段后的进攻入口 |
| `shiftDemolishHint` | 按住 Shift 时跟随光标的拆除提示 |
| `miniSize` | 小地图像素尺寸 |

## 4. 相机系统

坐标约定（`drawMap.ts`）：

```text
screen = center + zoom * (layout - center) + pan
```

| 函数 | 逻辑 |
|------|------|
| `animateCameraTo(pan, zoom, onDone?)` | 500ms `easeInOutCubic` 插值；会 `cancelCameraAnim` 并清 follow |
| `panGridToScreen` / `panForGridAtScreen` | 把格点放到指定屏幕位置并 `clampPan` |
| `fitWorkRangeCircles` | 包围所有射程圆后算 zoom/pan（开火时常用） |
| `fitPathNodes` | 包围行军折线（调动/训练勾选） |
| 滚轮 | 以指针为枢轴 `panAfterZoomAt`，因子 1.08 |
| 双指 | 距比缩放 + 中点平移；松手不当作点击 |

单位检视：`UNIT_FOCUS_X_RATIO=0.38`（略偏左）或 `focusCenter` 后跟随。建筑检视：点击后立即居中并显示信息框；Shift+点击仍跳过焦点（仅用于双击拆除检测）。

## 5. 选中逻辑（`setSelectionAt` / 点击）

### 缩放门控

对局中点击地图（非开火/互防瞄准）时，若 `zoom < MAP_CLICK_ZOOM_GATE`（**3**）：以点击点为枢轴将 `zoom + 1`（`animateCameraTo` 平滑插值，`panAfterZoomAt` 保持点位），**本次不打开菜单/检视**。`zoom` 为相机放大倍数（`MAP_ZOOM_MIN=1` … `MAP_ZOOM_MAX=16`）。

### ≥3 倍时的点选（`playing`，命中圆 R = `MAP_CLICK_HIT_R_DU` = **0.3 Du**）

Du = 格点距离单位（与 `findUnitNear` / 网格坐标一致）。人工岛不计入「建筑」命中（仍可单独打开点菜单）。点击后按 **4 → 3 → 2 → 1** 倒序判定：

4. **建筑 + 单位** → `RadialPickMenu` 叠放菜单（坐标 → 建筑 → 单位）  
3. **仅单位** → 叠放菜单（坐标 → 单位）  
2. **仅建筑** → 镜头居中 + `BuildingInspectHud`；Shift+点击仍只做双击拆除计时（跳过焦点）  
1. **皆无** → 半环点菜单（或敌方联络线进攻）；仅人工岛命中 → 点菜单  

叠放菜单：左右侧环位（正上/正下不排）；「坐标（x，y）」在环正下方居中；建筑/单位角度 **−45° / 0° / 45°（右）→ 135° / 180° / 225°（左）**，右侧优先（不均分全环）；各方内 **我方优先**、同方按 **id**；环上建筑+单位 &gt;6 时最多 6 +「更多」列表；菜单图标一律黑版。点建筑/单位走与直接点选相同的 `focusCenter` 流程（`selectionUiRef` 在 `setSelectionAt` 内同步写入，焦点动画经 `pendingBuildingFocusRef` 延后一拍，避免仍读到上一选中态而中止）。

开火/互防瞄准逻辑不变（仍用既有近点拾取）。观战/结束：R=0.3 最近单位优先，其次建筑，可检视不可操作。选都阶段：缩放门控后点菜单仅「定为首都」。

`clearSelection`：取消 pending 焦点、相机动画、follow、互防/敌线选中；**不**退出开火瞄准（见下）。

`terrain?.seed` 变化时清空选中与 buildMode。

## 6. 渲染循环

`useEffect`（依赖 map/地形/实体等）启动：

```text
paint → drawMap(ctx, { pan, zoom, selection, buildings, … })
      → drawMinimap(...)
      → requestAnimationFrame(paint)
```

`selectionRef` 只服务点选半环；建筑/单位检视环由 DOM HUD 表达。`workRanges` / `pathPreviews` / `focusMarks` / `fireAimAt` / `inspectFocus` 每帧从 refs 组装。

检视态（`inspectHudReady` 且 `BuildingInspectHud` / `UnitInspectHud` 打开）：`drawMap` 用半透明暗层盖住棋盘后，再以正常亮度重绘选中目标图标（其余地物保持调暗）；取消选中后 `inspectFocus` 清空并恢复。叠放菜单阶段不启用此调暗。

## 7. 联络线编辑

进入：`BuildModeOverlay`「编辑联络线」或快捷键 **E** → `liaisonEditActive`。

画线：

1. 按下设 `liaisonPending`；移动超过 5px 后 `snapToIntegerNode` 起点。  
2. 铁路：起点必须已连通车站（`hasRailwayOriginStationAt`）。  
3. 移动中 `extendLiaisonPath`；`sampleLiaisonSpeed` 把 Du/s 映射为 blunt 0..1（快绘钝化）。  
4. 松开：按峰值再 `bluntLiaisonPath`；铁路锚定端点并 `railwayEndpointRejectReason`；通过则 `liaisonAwaitConfirm`。  
5. Enter 确认 / Esc 取消；确认调 `onBuildLiaison`。

拆除：编辑模式下点己方线 → 确认；**Shift+双击**直接拆（450ms 窗口）。Ctrl+拖拽强制平移而不画线。

造价预览：`previewLiaisonCost` + 公路/铁路地形附加 `roadRailTerrainSurchargeE`。

## 8. 建造模式

`openBuildAt(anchor, "buildings"|"liaison")`：

- `snapToBuildNode`；`groundAt` 看四角是否有非洋面（海岸算 land）。  
- `setBuildMode`；点选建筑 → `onPickBuilding` → `onBuild`；`pendingBuildingId` 直到该格出现对应建筑再关层。  
- 港口额外 `isValidPortSite`。

快捷键：**Q** 在点选菜单上开建造；**E** 开/切联络线模式。

## 9. 调动（`mobilize`）与训练（`trainUi`）

点菜单「调动/封锁」或建筑/单位检视动作写入 `mobilize`：

| mode | Go 时发送 |
|------|-----------|
| `move` | `move_units` |
| `blockade` | `blockade_units` |
| `supply` | `supply_units` |
| `attack` | `attack_units`（可含联络线段端点） |
| `hold` | `hold_units` |
| `assign` | `assign_home` |

`planError` / `marchPathPreviews`：对勾选来源调用 shared 的 `previewUnitMove` / `previewTrainingDeliveryPath`。勾选时 `syncFocus` 画路径并 fit 相机。

训练面板多目标 `targetIds`；确认 `onTrain`。

## 10. 开火与互防

- **开火**：检视「发射」→ `fireAim=buildingId`；相机 fit 射程；点击目标发 `fire`；**仅**建筑旁取消叉号（×）退出瞄准（Esc / 点空白 / 平移缩放 / 再点发射均不退出）。炮可打单位。  
- **互防**：`mutualAim`；点击对角/相邻己方建筑发 `mutual_defense`。已互防时检视钮为「解除互防」→ `end_mutual_defense`；伙伴消失时服务端自动清 `mutualDefensePartnerId`。

污染或未通信建筑：多数动作 `logLocalReject`；拆除仍允许。

## 11. 小地图交互

`getMinimapSize`：面积 ≈ 窗口面积/30，比例=地图格。拖视口框：`panFromBoardUV`。毁坏标记过滤过期后画警告图标。

## 12. JSX 叠层结构（自上而下逻辑）

1. 主 `<canvas className="game-canvas">`（DPR 缓冲）  
2. 点选：`PointActionMenu`  
3. 建筑：`BuildingInspectHud`（需 `inspectHudReady`）  
4. 单位：`UnitInspectHud`  
5. 敌联络线进攻钮  
6. `MobilizePanel` / `TrainPanel`  
7. `BuildModeOverlay` + 确认条  
8. Shift / 开火 / 互防跟随提示  
9. 小地图 canvas + `ChatPanel`  

具体组件行为见 [ui-components.md](./ui-components.md)；绘制细节见 [canvas-rendering.md](./canvas-rendering.md)。

## 13. 区块导航（行号约略）

| 区间（约） | 内容 |
|------------|------|
| 1–210 | import、Props、常量、`easeInOutCubic` |
| 212–520 | state/refs、毁坏检测、清空选中 |
| 520–880 | 相机 helpers、mobilize 预览 memo |
| 888–1108 | `setSelectionAt` / `syncFocus` |
| 1129–1202 | rAF 绘制 |
| 1204–2034 | 主 canvas 指针/滚轮/捏合 |
| 2036–2142 | 小地图拖拽 |
| 2144–2630 | 建造/点菜单/键盘确认 |
| 2631–末 | JSX 与面板回调 |
