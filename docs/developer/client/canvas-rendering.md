# 画布渲染子系统

源码目录：`core/client/src/canvas/`。主绘制入口 `drawMap`；小地图 `drawMinimap`；颜色与图标辅助模块。

## 1. 模块一览

| 文件 | 导出重点 |
|------|----------|
| `drawMap.ts` | 布局、相机 clamp、拾取、`drawMap`、`mapZoomStrokeScreenPx`、选中环尺寸常量 |
| `drawMinimap.ts` | 尺寸、视口 UV、拖拽 pan、`drawMinimap` |
| `terrainColors.ts` | `TERRAIN_COLORS`、`fillTerrainCells`、`strokeOilUraniumBorders` |
| `buildingIcons.ts` | `getBuildingIcon(id, variant)` Image 缓存 |
| `unitIcons.ts` | `getUnitIcon`（同类缓存模式） |
| `liaisonBuildAnim.ts` | 联络线「逐步建成」：`LiaisonBuildAnchor`、`liaisonBuildFraction`、`liaisonBuiltSegments`、`pruneLiaisonWeightCache` |

## 2. 板面布局（`BoardLayout`）

`getBoardLayout(width, height, map)`：

- `cell`：在留白边距内，使整图刚好装入视口的最大格宽。  
- 边距：`max(56, min(w,h)*0.06)`。  
- `originX/Y`：板面左上角在 **layout 空间**（zoom=1、pan=0）的位置。  
- 格点 `(gx,gy)` → layout：`(originX + gx*cell, originY + gy*cell)`。

缩放常量：`MAP_ZOOM_MIN=1`，`MAP_ZOOM_MAX=16`。

## 3. 相机数学

| 函数 | 作用 |
|------|------|
| `layoutToScreen` / `screenToLayout` | 双向变换 |
| `clampPan` | 保证板面至少 `minVisible`(48px) 与视口重叠 |
| `panAfterZoomAt(mx,my,…)` | 缩放时保持枢轴下地图点不动 |
| `pickGridPoint` | 最近 0.1 Du 吸附；出板返回 null |
| `pickGridCoord` | 连续坐标（联络线斜向采样） |

## 4. `drawMap` 绘制顺序

在 DPR 变换后清空背景 `#2a2a2a`，再 `translate/scale` 进入 layout：

1. **地形填色** `fillTerrainCells`（平原/海洋/山地/森林等地面填充，在网格下）  
2. **网格线 + 交点灰点**（`mapZoomStrokeScreenPx(zoom, 0.05, w, h) * 2`；zoom≈1 时几乎看不见；横屏 `w≥h` 时基值再 ×1.5）  
3. **油/铀描边** `strokeOilUraniumBorders`（网格之上：`mapZoomStrokeScreenPx(zoom, 1, w, h) * 2`，屏上至少 2 CSS px，layout 下 `lineWidth = 屏上线宽 / zoom`；横屏同曲线 ×1.5）  
4. **联络线** `drawLiaisons`（己白 / 友蓝 / 敌橙；通信覆盖时可青/灰；己方/友方建造中按 `liaisonBuildProgress` 分段，见 §5）  
5. **联络线预览**（草稿，`preview: true`）  
6. **污染圈** 红，半径 `NUKE_POLLUTION_R_DU`  
7. **建筑** 图标 + 等级罗马数字、建造/训练进度、装填冷却扇形等  
8. **单位** 图标、朝向、选中高亮、剩余路径  
9. **pathPreviews** 调动/训练预演折线  
10. **focusMarks** 浅青圈  
11. **卫星雾** `drawSatelliteFog`（直接视野外半透明暗层；`airOnly` 源不驱散地面雾）  
12. **资源储量环**（雾后、且再按直接视野过滤 `resourceSight`）  
13. **敌方视野**（可选，米黄并集填充）  
14. **选都互斥红圈**（`showCapitalExclusion`）  
15. **工作射程环**（检视/开火）  
16. **通信电台范围描边**（可选 `showCommStatus`）  

然后 `restore`，在**屏幕空间**画：

- 点选半环 `drawSelectionMarkerScreen`（外径 `SEL_RING_OUTER=44`）  
- 开火取消钮 `drawFireAimCancelScreen`

### 雾实现要点

`ensureFogCanvas` 离屏缓冲：先铺 `SATELLITE_FOG`，再用 `destination-out` 挖掉直接视野圆，得到并集而非 XOR。源来自 `collectAllDirectVisionSources`（建筑+地面单位，过滤 `airOnly`）。

敌方视野：`collectKnownEnemyVisionSources`（已知敌建筑/单位）→ 同色半透明圆并集。

通信状态：`collectCommUsedEdges` 结果按签名缓存，避免每帧 Dijkstra；连通建筑用 online 图标色，断联 offline。

## 5. 建筑与单位绘制细节

**建筑**（`drawBuildings`）：

- 变体：己方 `own`；敌方 `enemy`（橙）；通信覆盖下己方 online/offline。  
- 建造中半透明；污染可特殊处理。  
- 储兵/外出 U、弹药、训练进度条（粗细随 `cell`，屏上上限 `BUILDING_BAR_SCREEN_MAX_PX=3`，避免竖屏高 zoom 过粗）；线性升级罗马数字、导弹冷却扇形（12 点起顺时针扫剩余冷却）。  
- **己方缩放 FX**（`buildingScaleAnims`，时长 `BUILDING_SCALE_ANIM_MS=400`，缓动 `cubic-bezier(0.22, 1, 0.36, 1)`）：  
  - **新建**：snapshot 中新出现的己方实例（或夺得所有权）→ 图标 0→1 放大；HP/驻军/弹药/训练条与图标共用中心 `scale`。  
  - **升级**：同 id 的 `buildingId`（变种链）或 `level`（线性等级）变化 → 旧 kind 1→0 缩小、新 kind 0→1 放大交叉过渡。  
  - **移除**：己方 id 从列表消失（主动拆除或被摧毁，含 `buildingsDelta.removes`）→ 用上一帧保存的建筑快照（含状态条数据、通讯链接态）画「幽灵」1→0 缩小后丢弃；幽灵不在 `buildings` 中，不参与点击/命中/视野/链接；同格立即出现新己方建筑（人工岛转陆地建筑）时不播。  
  - 首帧 / `myPlayerId` 切换 / 列表清空 / 整表替换（与上一帧 id 无交集，如换房、重连）只建基线、不播动画；敌方/盟友不播。  
  - 由 `GameCanvas` 对比上一帧建筑快照写入 ref map，经 `DrawMapArgs.buildingScaleAnims` 传入。  

**单位**（`drawUnits`）：

- 图标尺寸相对格宽；朝向由路径下一段推算。  
- 移动中画剩余折线；选中加强描边。  

**联络线样式**：按 kind 虚实线；未完成更密虚线；预览略不同。

**联络线逐步建成**（`liaisonBuildAnim.ts`，纯客户端，不改协议）：

- 进度源：快照 `PlacedLiaison.buildTicksRemaining / buildTicksTotal`（服务器 `advanceConstruction` 每 tick 无条件 −1）。`GameCanvas` 在剩余 tick 变化时记录锚点 `{ remaining, total, at }`（`liaisonBuildAnchorsRef`），每帧 `liaisonBuildFraction` 在锚点基础上最多外推 1 tick（`TICK_MS`）做 tick 间平滑，不越过下一包。
- 首次看到某条线（首帧 / 重连 / 新进视野）直接以当前进度为锚点，不从 0 回放。
- 建成前沿沿 `nodes[0] → nodes[n-1]`（即玩家绘制起点→终点；服务器的去重/拆分/铁路锚定都保持该顺序）推进。每段 E = 基础 `⌊L⌋×costPerDu×10`（`previewLiaisonCostForLength`）按段长分摊 + 该段单独的 `roadRailTerrainSurchargeE(terrain, [a,b], kind)`（仅公路/铁路）；段时长 ∝ 段 E。累计权重归一到 1，再乘服务器总耗时，因此取整误差不会让动画终点与实际完工错位；段内按时间线性推进。权重按 id + 节点签名缓存。
- `drawLiaisonPolyline` 的 `builtSegments`（分数段索引，如 2.4）：前缀用正式样式（α 0.95、kind 虚线），其余仍用建造中样式（α 0.4，公路改密虚线）。
- 仅己方与友方（`isFriendly(teams, ownerId, myPlayerId)`）记录锚点；`drawLiaisons` 对 `relation === "enemy"` 强制忽略进度，敌方建造中线整条按未完成样式显示。服务器对敌方只下发掩码 ticks（在建 `1/1`、完成 `0/0`，见 [vision.md](../shared/vision.md)），客户端仅据 `buildTicksRemaining > 0` 判断未完成。

## 6. 小地图（`drawMinimap.ts`）

| API | 作用 |
|-----|------|
| `getMinimapSize` | 面积比 1/30，宽高比=cellsX/cellsY |
| `getViewRectInBoard` | 主视口四角 → 板面 UV |
| `getViewRectOnMinimap` | UV → 小地图像素框 + 中心 UV |
| `panFromBoardUV` | 把主视口中心对准给定 UV |
| `drawMinimap` | 缩略地形 + 视口矩形 + 毁坏警告图 `/ui/warning.png` |

警告图标按需异步加载并缓存。

## 7. 地形色（`terrainColors.ts`）

| 键 | 色 |
|----|----|
| ocean | `#1e3340` |
| land | `#3d4a3a` |
| mountain | `#5c5852` |
| forest | `#2f6b3c`（资源填满格） |
| oil / uranium | 描边金/绿（网格之上；线宽与网格同曲线再 ×2，`minScreenPx=1` → 屏上至少 2px） |

耗尽后由 `resourceTerrain` 同步，客户端不再画对应资源边。

## 8. 图标加载

`getBuildingIcon` / `getUnitIcon`：

- `Map<src, HTMLImageElement|null>`；加载中存 `null`，失败也存 `null`。  
- 路径经 `buildingIconSrc` 改写变体目录。  
- 未解码完成的帧跳过图标（下帧再试）。

## 9. 与 GameCanvas 的契约

`GameCanvas` 每帧传入的关键 `DrawMapArgs` 字段：

- 相机：`pan`、`zoom`  
- 世界：`terrain`、`buildings`、`liaisons`、`units`、`pollutionZones`  
- 交互叠加：`selection`、`liaisonPreview`、`selectedLiaisonId`、`selectedUnitId`、`workRanges`、`focusMarks`、`pathPreviews`、`fireAimAt`  
- 视野/通信：`myPlayerId`、`connectedBuildingIds`、`resourceSight`、`showEnemyVision`、`showCommStatus`、`showCapitalExclusion`  
- `tick`：冷却 UI  
- `buildingScaleAnims?`：己方建筑新建/升级/移除图标缩放 FX（见 §5）  
- `liaisonBuildProgress?`：己方/友方建造中联络线 id → 已建成分数段索引（见 §5「联络线逐步建成」；敌方忽略）  

小地图只拿地形、视口与 `destructionMarks`（己方被毁、非自拆）。
