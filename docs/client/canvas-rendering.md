# 画布渲染子系统

源码目录：`core/client/src/canvas/`。主绘制入口 `drawMap`；小地图 `drawMinimap`；颜色与图标辅助模块。

## 1. 模块一览

| 文件 | 导出重点 |
|------|----------|
| `drawMap.ts` | 布局、相机 clamp、拾取、`drawMap`、选中环尺寸常量 |
| `drawMinimap.ts` | 尺寸、视口 UV、拖拽 pan、`drawMinimap` |
| `terrainColors.ts` | `TERRAIN_COLORS`、`fillTerrainCells` |
| `buildingIcons.ts` | `getBuildingIcon(id, variant)` Image 缓存 |
| `unitIcons.ts` | `getUnitIcon`（同类缓存模式） |

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

1. **地形** `fillTerrainCells`（地面填色；油/铀描边，线宽随 zoom 变细）  
2. **网格线 + 交点灰点**（线宽同样随 zoom 变细）  
3. **联络线** `drawLiaisons`（己白 / 敌橙；通信覆盖时可青/灰）  
4. **联络线预览**（草稿，`preview: true`）  
5. **污染圈** 红，半径 `NUKE_POLLUTION_R_DU`  
6. **建筑** 图标 + 等级罗马数字、建造/训练进度、装填冷却扇形等  
7. **单位** 图标、朝向、选中高亮、剩余路径  
8. **pathPreviews** 调动/训练预演折线  
9. **focusMarks** 浅青圈  
10. **卫星雾** `drawSatelliteFog`（直接视野外半透明暗层；`airOnly` 源不驱散地面雾）  
11. **资源储量环**（雾后、且再按直接视野过滤 `resourceSight`）  
12. **敌方视野**（可选，米黄并集填充）  
13. **选都互斥红圈**（`showCapitalExclusion`）  
14. **工作射程环**（检视/开火）  
15. **通信电台范围描边**（可选 `showCommStatus`）  

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
- 储兵/外出 U、线性升级罗马数字、导弹冷却扇形（12 点起顺时针扫剩余冷却）。  

**单位**（`drawUnits`）：

- 图标尺寸相对格宽；朝向由路径下一段推算。  
- 移动中画剩余折线；选中加强描边。  

**联络线样式**：按 kind 虚实线；未完成更密虚线；预览略不同。

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
| oil / uranium | 描边金/绿 |

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

小地图只拿地形、视口与 `destructionMarks`（己方被毁、非自拆）。
