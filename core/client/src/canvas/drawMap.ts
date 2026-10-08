import type {
  MapConfig,
  TerrainMap,
  PlacedBuilding,
  PlacedLiaison,
  ResourceSightCell,
  GridNode,
  LiaisonKind,
  UnitGroup,
  PollutionZone,
} from "@wop/shared";
import {
  BUILDING_BY_ID,
  CAPITAL_EXCLUSION_R_DU,
  DIRECT_VISION_R_AIR,
  DIRECT_VISION_R_ARMOR_NAVY,
  DIRECT_VISION_R_INFANTRY,
  NUKE_POLLUTION_R_DU,
  buildingLevel,
  collectAllDirectVisionSources,
  collectCommUsedEdges,
  directVisionRadiusForBuilding,
  awayOccupiedU,
  effectiveUmax,
  filterResourceSightForViewer,
  isBuildingComplete,
  isBuildingCommsLinked,
  isLaunchCoolingDown,
  isMovingState,
  launchCooldownTicks,
  resourceSightSamplePoint,
  romanLevelLabel,
  supportsLinearUpgrade,
  trainingHeadProgress,
  undirectedCommEdgeKey,
  workRangeCircles,
} from "@wop/shared";
import type { VisionSource } from "@wop/shared";
import { fillTerrainCells } from "./terrainColors";
import { getBuildingIcon } from "./buildingIcons";
import { getUnitIcon } from "./unitIcons";
import { log } from "../net/log";

const BG = "#2a2a2a";
const GRID = "#4a4a4a";
/** Satellite-only areas (outside direct vision). */
const SATELLITE_FOG = "rgba(10, 12, 16, 0.5)";
/** Inspect HUD focus: dim board so the selected icon stays readable. */
const INSPECT_FOCUS_DIM = "rgba(8, 10, 14, 0.48)";
/** Known enemy vision overlay (beige / 米黄, no stroke; union fill, uniform alpha). */
const ENEMY_VISION_FILL = "rgba(235, 210, 155, 0.14)";
/** Match selection half-ring fill. */
const RESERVE_RING_FILL = "rgba(255, 255, 255, 0.28)";
const RESERVE_RING_TRACK = "rgba(255, 255, 255, 0.1)";
/** Own liaison stroke (white). */
const LIAISON_OWN = "#ffffff";
/** Enemy liaison — same orange as `buildings - orange` map icons. */
const LIAISON_ENEMY = "#eb6040";
/** Comm-status overlay: linked building / liaison / radio range (teal). */
const COMM_STATUS_LINKED = "#2bbbad";
/** Comm-status overlay: own building not in connectedIds. */
const COMM_STATUS_UNLINKED = "#8a2f2f";
/** Comm-status overlay: own liaison segment not carrying signal. */
const COMM_STATUS_LIAISON_IDLE = "#7a7a7a";
const RADIO_BUILDING_ID = "boardcast";
let lastDrawnBuildingSig = "";
/** Cache for comm-status used liaison edges (avoid Dijkstra every frame). */
let cachedCommUsedEdgesSig = "";
let cachedCommUsedEdges: ReadonlySet<string> = new Set();

/** Padding around the board at zoom=1 (min zoom shows whole map with slight 留白). */
export const MAP_FIT_MARGIN_RATIO = 0.06;
export const MAP_FIT_MARGIN_MIN = 56;
export const MAP_ZOOM_MIN = 1;
export const MAP_ZOOM_MAX = 16;

export function mapFitMargin(width: number, height: number): number {
  return Math.max(MAP_FIT_MARGIN_MIN, Math.min(width, height) * MAP_FIT_MARGIN_RATIO);
}

export interface BoardLayout {
  cell: number;
  boardW: number;
  boardH: number;
  /** Top-left of board in layout space (zoom=1, pan=0). */
  originX: number;
  originY: number;
}

export function getBoardLayout(width: number, height: number, map: MapConfig): BoardLayout {
  const margin = mapFitMargin(width, height);
  const cell = Math.min((width - margin * 2) / map.cellsX, (height - margin * 2) / map.cellsY);
  const boardW = cell * map.cellsX;
  const boardH = cell * map.cellsY;
  return {
    cell,
    boardW,
    boardH,
    originX: (width - boardW) / 2,
    originY: (height - boardH) / 2,
  };
}

/**
 * screen = center + zoom * (layout - center) + pan
 * Board must keep at least `minVisible` px overlapping the viewport.
 */
export function clampPan(
  pan: { x: number; y: number },
  width: number,
  height: number,
  boardW: number,
  boardH: number,
  zoom: number,
  minVisible = 48,
): { x: number; y: number } {
  const halfZW = (zoom * boardW) / 2;
  const halfZH = (zoom * boardH) / 2;
  // Board AABB: [w/2+pan.x±halfZW] × [h/2+pan.y±halfZH]
  const minX = -width / 2 - halfZW + minVisible;
  const maxX = width / 2 + halfZW - minVisible;
  const minY = -height / 2 - halfZH + minVisible;
  const maxY = height / 2 + halfZH - minVisible;
  return {
    x: Math.min(maxX, Math.max(minX, pan.x)),
    y: Math.min(maxY, Math.max(minY, pan.y)),
  };
}

/** Pan after zoom so the layout point under (mx,my) stays fixed on screen. */
export function panAfterZoomAt(
  mx: number,
  my: number,
  zoomFrom: number,
  zoomTo: number,
  pan: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  const cx = width / 2;
  const cy = height / 2;
  const k = zoomTo / zoomFrom;
  return {
    x: mx - cx - k * (mx - cx - pan.x),
    y: my - cy - k * (my - cy - pan.y),
  };
}

export interface DrawMapArgs {
  width: number;
  height: number;
  map: MapConfig;
  pan: { x: number; y: number };
  zoom: number;
  terrain?: TerrainMap | null;
  /** Selected grid intersection (Go-style point). */
  selection?: { gx: number; gy: number } | null;
  buildings?: readonly PlacedBuilding[] | null;
  liaisons?: readonly PlacedLiaison[] | null;
  /** In-progress liaison drag preview. */
  liaisonPreview?: { kind: LiaisonKind; nodes: readonly GridNode[] } | null;
  /** Highlighted liaison (e.g. demolish pick). */
  selectedLiaisonId?: string | null;
  /** Revealed resource reserves after first mining. */
  resourceSight?: readonly ResourceSightCell[] | null;
  /** Local player id — non-matching owners render orange enemy icons. */
  myPlayerId?: string | null;
  /** Own buildings with active capital comms link. */
  connectedBuildingIds?: readonly string[] | null;
  /** While picking a capital, ring other capitals at R=10. */
  showCapitalExclusion?: boolean;
  /** Open inspect HUD: stroke-only work-range circles (own, plus linked nearby radars). */
  workRanges?: readonly { gx: number; gy: number; radiusDu: number }[] | null;
  units?: readonly UnitGroup[] | null;
  /** Selected unit group id — draws remaining march path when present. */
  selectedUnitId?: string | null;
  /**
   * Building/unit inspect HUD open: dim the board, then redraw this entity's
   * icon at full brightness (focus highlight).
   */
  inspectFocus?: { kind: "building" | "unit"; id: string } | null;
  /** Checked mobilize rows: light-cyan rings. Cleared when unchecked. */
  focusMarks?: readonly { gx: number; gy: number }[] | null;
  /** Mobilize / train dry-run march polylines (same stroke as selected-unit path). */
  pathPreviews?: readonly (readonly { gx: number; gy: number }[])[] | null;
  /** Nuclear pollution zones — red circles. */
  pollutionZones?: readonly PollutionZone[] | null;
  /**
   * Overlay known (snapshot-visible) enemy building + unit vision
   * circles as beige semi-transparent fills.
   */
  showEnemyVision?: boolean;
  /**
   * Overlay own communication status: online/offline building icons,
   * linked-liaison colors, and connected radio work-range strokes.
   */
  showCommStatus?: boolean;
  /** Launcher fire-aim: draw cancel affordance at this building node. */
  fireAimAt?: { gx: number; gy: number } | null;
  /** Server tick — used for launcher/AA fire-cooldown pie sectors. */
  tick?: number;
}

/** Fixed screen-pixel cancel control while aiming a launcher. */
export const FIRE_AIM_CANCEL_R = 13;
/** Offset below building center (screen px). */
export const FIRE_AIM_CANCEL_DY = 20;

export function fireAimCancelScreenPos(
  buildingScreenX: number,
  buildingScreenY: number,
): { x: number; y: number } {
  return { x: buildingScreenX, y: buildingScreenY + FIRE_AIM_CANCEL_DY };
}

export function hitFireAimCancel(
  sx: number,
  sy: number,
  buildingScreenX: number,
  buildingScreenY: number,
): boolean {
  const c = fireAimCancelScreenPos(buildingScreenX, buildingScreenY);
  return Math.hypot(sx - c.x, sy - c.y) <= FIRE_AIM_CANCEL_R + 4;
}

/** Screen-space cancel chip: soft disc + × (zoom-independent). */
function drawFireAimCancelScreen(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
): void {
  const { x, y } = fireAimCancelScreenPos(screenX, screenY);
  const r = FIRE_AIM_CANCEL_R;
  ctx.save();
  ctx.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0);

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(28, 28, 30, 0.82)";
  ctx.fill();
  ctx.strokeStyle = "rgba(232, 228, 220, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const arm = r * 0.42;
  ctx.beginPath();
  ctx.moveTo(x - arm, y - arm);
  ctx.lineTo(x + arm, y + arm);
  ctx.moveTo(x + arm, y - arm);
  ctx.lineTo(x - arm, y + arm);
  ctx.strokeStyle = "rgba(232, 228, 220, 0.95)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

/** Screen → layout (zoom=1 board space). */
export function screenToLayout(
  sx: number,
  sy: number,
  width: number,
  height: number,
  pan: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  const cx = width / 2;
  const cy = height / 2;
  return {
    x: cx + (sx - cx - pan.x) / zoom,
    y: cy + (sy - cy - pan.y) / zoom,
  };
}

/** Layout → screen. */
export function layoutToScreen(
  lx: number,
  ly: number,
  width: number,
  height: number,
  pan: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  const cx = width / 2;
  const cy = height / 2;
  return {
    x: cx + zoom * (lx - cx) + pan.x,
    y: cy + zoom * (ly - cy) + pan.y,
  };
}

/** Nearest point in Du, snapped to 0.1; null if outside board. */
export function pickGridPoint(
  sx: number,
  sy: number,
  width: number,
  height: number,
  map: MapConfig,
  pan: { x: number; y: number },
  zoom: number,
): { gx: number; gy: number } | null {
  const { cell, originX, originY } = getBoardLayout(width, height, map);
  const layout = screenToLayout(sx, sy, width, height, pan, zoom);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const gx = round1((layout.x - originX) / cell);
  const gy = round1((layout.y - originY) / cell);
  const maxX = map.linesX - 1;
  const maxY = map.linesY - 1;
  if (gx < 0 || gy < 0 || gx > maxX || gy > maxY) return null;
  return { gx, gy };
}

/** Continuous grid coords (no snap); used for diagonal-biased liaison drawing. */
export function pickGridCoord(
  sx: number,
  sy: number,
  width: number,
  height: number,
  map: MapConfig,
  pan: { x: number; y: number },
  zoom: number,
): { gx: number; gy: number } | null {
  const { cell, originX, originY } = getBoardLayout(width, height, map);
  const layout = screenToLayout(sx, sy, width, height, pan, zoom);
  const gx = (layout.x - originX) / cell;
  const gy = (layout.y - originY) / cell;
  const maxX = map.linesX - 1;
  const maxY = map.linesY - 1;
  if (gx < -0.5 || gy < -0.5 || gx > maxX + 0.5 || gy > maxY + 0.5) return null;
  return {
    gx: Math.min(maxX, Math.max(0, gx)),
    gy: Math.min(maxY, Math.max(0, gy)),
  };
}

/** Fixed screen-pixel sizes (independent of map zoom). */
export const SEL_RING_OUTER = 44;
export const SEL_RING_INNER = 28;
const SEL_FONT_PX = 13;
const SEL_LABEL_GAP = 6;

/** Draw selection in screen space so size stays constant across zoom. */
function drawSelectionMarkerScreen(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  gx: number,
  gy: number,
): void {
  ctx.save();
  ctx.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0);

  ctx.beginPath();
  ctx.arc(screenX, screenY, SEL_RING_OUTER, -Math.PI / 2, Math.PI / 2, false);
  ctx.arc(screenX, screenY, SEL_RING_INNER, Math.PI / 2, -Math.PI / 2, true);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  ctx.fill();

  const label = `(${gx.toFixed(1)}, ${gy.toFixed(1)})`;
  ctx.font = `600 ${SEL_FONT_PX}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(232, 228, 220, 0.95)";
  ctx.fillText(label, screenX - SEL_LABEL_GAP, screenY + SEL_LABEL_GAP);
  ctx.restore();
}

/**
 * Dark-gray board + gray grid. Buildings sit on intersections (Go-style).
 * screen = center + zoom*(layout - center) + pan
 */
/** Small reserve ring at cell center — white translucent annulus (like selection menu). */
function drawResourceReserveRings(
  ctx: CanvasRenderingContext2D,
  sight: readonly ResourceSightCell[],
  originX: number,
  originY: number,
  cell: number,
): void {
  const rOuter = cell * 0.26;
  const rInner = cell * 0.16;

  for (const s of sight) {
    const { gx, gy } = resourceSightSamplePoint(s);
    const cx = originX + gx * cell;
    const cy = originY + gy * cell;
    const ratio =
      s.reserveMax > 0 ? Math.max(0, Math.min(1, s.reserve / s.reserveMax)) : 0;

    // Track (full ring)
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2, false);
    ctx.arc(cx, cy, rInner, Math.PI * 2, 0, true);
    ctx.closePath();
    ctx.fillStyle = RESERVE_RING_TRACK;
    ctx.fill();

    // Remaining reserve (white translucent sector)
    if (ratio > 0) {
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * ratio;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, a0, a1, false);
      ctx.arc(cx, cy, rInner, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = RESERVE_RING_FILL;
      ctx.fill();
    }
  }
}

/** Icon size relative to cell (was 0.7); keep findUnitNear ~0.35 Du for clicks. */
const UNIT_ICON_CELL = 0.38;
const UNIT_PATH_STROKE = "rgba(232, 228, 220, 0.85)";
const UNIT_PATH_GLOW = "rgba(150, 206, 255, 0.35)";

/** Remaining march polyline: current position + waypoints from pathIndex onward. */
function remainingUnitPath(unit: UnitGroup): Array<{ gx: number; gy: number }> {
  const path = unit.path;
  if (!path || path.length < 2 || !isMovingState(unit.state)) return [];
  const idx = Math.max(1, Math.min(unit.pathIndex ?? 1, path.length - 1));
  const rest = path.slice(idx);
  if (rest.length === 0) return [];
  return [{ gx: unit.gx, gy: unit.gy }, ...rest];
}

/**
 * Canvas rotation so icon default (facing up / -Y) aims along travel.
 * Stationary or no usable direction → 0 (up).
 */
function unitFacingAngle(unit: UnitGroup): number {
  if (!isMovingState(unit.state) || !unit.path || unit.path.length < 2) return 0;
  const path = unit.path;
  let idx = Math.max(1, Math.min(unit.pathIndex ?? 1, path.length - 1));
  let dx = 0;
  let dy = 0;
  for (let i = idx; i < path.length; i++) {
    const p = path[i]!;
    dx = p.gx - unit.gx;
    dy = p.gy - unit.gy;
    if (Math.hypot(dx, dy) > 1e-4) break;
  }
  if (Math.hypot(dx, dy) <= 1e-4 && idx > 0) {
    const prev = path[idx - 1]!;
    const cur = path[idx]!;
    dx = cur.gx - prev.gx;
    dy = cur.gy - prev.gy;
  }
  if (Math.hypot(dx, dy) <= 1e-4) return 0;
  return Math.atan2(dx, -dy);
}

function drawUnitPathPreview(
  ctx: CanvasRenderingContext2D,
  nodes: readonly { gx: number; gy: number }[],
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
): void {
  if (nodes.length < 2) return;
  const strokePath = () => {
    ctx.beginPath();
    ctx.moveTo(originX + nodes[0]!.gx * cell, originY + nodes[0]!.gy * cell);
    for (let i = 1; i < nodes.length; i++) {
      ctx.lineTo(originX + nodes[i]!.gx * cell, originY + nodes[i]!.gy * cell);
    }
    ctx.stroke();
  };

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([cell * 0.22, cell * 0.14]);

  ctx.strokeStyle = UNIT_PATH_GLOW;
  ctx.lineWidth = 4.2 / zoom;
  strokePath();

  ctx.strokeStyle = UNIT_PATH_STROKE;
  ctx.lineWidth = 1.8 / zoom;
  strokePath();

  // Destination tick
  const last = nodes[nodes.length - 1]!;
  const lx = originX + last.gx * cell;
  const ly = originY + last.gy * cell;
  const r = Math.max(2.5 / zoom, cell * 0.06);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(lx, ly, r, 0, Math.PI * 2);
  ctx.strokeStyle = UNIT_PATH_STROKE;
  ctx.lineWidth = 1.5 / zoom;
  ctx.stroke();
  ctx.restore();
}

function drawUnitIconAt(
  ctx: CanvasRenderingContext2D,
  u: UnitGroup,
  originX: number,
  originY: number,
  cell: number,
  myPlayerId: string | null,
): void {
  const x = originX + u.gx * cell;
  const y = originY + u.gy * cell;
  const size = cell * UNIT_ICON_CELL;
  const half = size / 2;
  const mine = myPlayerId != null && u.ownerId === myPlayerId;
  const img = getUnitIcon(u.kind, u.state, !mine);
  const angle = unitFacingAngle(u);
  ctx.save();
  ctx.translate(x, y);
  if (angle !== 0) ctx.rotate(angle);
  if (img) {
    ctx.drawImage(img, -half, -half, size, size);
  } else {
    ctx.fillStyle = mine ? "#ffffff" : "#eb6040";
    ctx.beginPath();
    ctx.arc(0, 0, half * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawUnits(
  ctx: CanvasRenderingContext2D,
  units: readonly UnitGroup[],
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
  myPlayerId: string | null,
  selectedUnitId: string | null,
): void {
  if (selectedUnitId) {
    const selected = units.find((u) => u.id === selectedUnitId);
    if (selected && (myPlayerId == null || selected.ownerId === myPlayerId)) {
      const rem = remainingUnitPath(selected);
      if (rem.length >= 2) {
        drawUnitPathPreview(ctx, rem, originX, originY, cell, zoom);
      }
    }
  }

  for (const u of units) {
    drawUnitIconAt(ctx, u, originX, originY, cell, myPlayerId);
  }
}

/** Icon-only redraw used after inspect dim overlay (no HP / cooldown chrome). */
function drawBuildingIconAt(
  ctx: CanvasRenderingContext2D,
  b: PlacedBuilding,
  originX: number,
  originY: number,
  cell: number,
  myPlayerId: string | null,
  connectedIds: ReadonlySet<string> | null,
  showCommStatus: boolean,
): void {
  const x = originX + b.gx * cell;
  const y = originY + b.gy * cell;
  const size = cell * 0.85;
  const half = size / 2;
  const mine = myPlayerId != null && b.ownerId === myPlayerId;
  const incomplete = b.buildTicksRemaining > 0;
  const linked = !!connectedIds && isBuildingCommsLinked(b.id, connectedIds);
  let iconVariant: "own" | "enemy" | "online" | "offline" = mine ? "own" : "enemy";
  if (showCommStatus && mine && !incomplete) {
    iconVariant = linked ? "online" : "offline";
  }
  const img = getBuildingIcon(b.buildingId, iconVariant);
  ctx.save();
  if (img) {
    ctx.drawImage(img, x - half, y - half, size, size);
  } else {
    const fallback =
      showCommStatus && mine && !incomplete
        ? linked
          ? COMM_STATUS_LINKED
          : COMM_STATUS_UNLINKED
        : mine
          ? "#8a8a8a"
          : "#eb6040";
    ctx.fillStyle = fallback;
    ctx.beginPath();
    ctx.arc(x, y, half * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Dim the whole board, then redraw the inspected building/unit icon so it
 * stays at normal brightness while everything else reads as background.
 */
function drawInspectFocusHighlight(
  ctx: CanvasRenderingContext2D,
  focus: { kind: "building" | "unit"; id: string },
  originX: number,
  originY: number,
  boardW: number,
  boardH: number,
  cell: number,
  buildings: readonly PlacedBuilding[] | null | undefined,
  units: readonly UnitGroup[] | null | undefined,
  myPlayerId: string | null,
  connectedIds: ReadonlySet<string> | null,
  showCommStatus: boolean,
): void {
  ctx.save();
  ctx.fillStyle = INSPECT_FOCUS_DIM;
  ctx.fillRect(originX, originY, boardW, boardH);
  ctx.restore();

  if (focus.kind === "building") {
    const b = buildings?.find((x) => x.id === focus.id);
    if (b) {
      drawBuildingIconAt(
        ctx,
        b,
        originX,
        originY,
        cell,
        myPlayerId,
        connectedIds,
        showCommStatus,
      );
    }
    return;
  }

  const u = units?.find((x) => x.id === focus.id);
  if (u) drawUnitIconAt(ctx, u, originX, originY, cell, myPlayerId);
}

/** Gray fill for remaining launch-cooldown pie sector. */
const LAUNCH_CD_FILL = "rgba(90, 90, 90, 0.55)";

/**
 * Remaining cooldown as a filled pie sector centered on the building.
 * Full circle = full cooldown remaining; sector shrinks as ticks elapse.
 */
function drawLaunchCooldownSector(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  remainingFrac: number,
): void {
  if (!(remainingFrac > 0) || !(radius > 0)) return;
  const sweep = Math.min(1, remainingFrac) * Math.PI * 2;
  if (sweep <= 0) return;
  // Start at 12 o'clock; sweep clockwise (canvas arcs are clockwise with +angle).
  const start = -Math.PI / 2;
  const end = start + sweep;
  ctx.save();
  ctx.fillStyle = LAUNCH_CD_FILL;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, radius, start, end);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBuildings(
  ctx: CanvasRenderingContext2D,
  buildings: readonly PlacedBuilding[],
  originX: number,
  originY: number,
  cell: number,
  _zoom: number,
  myPlayerId: string | null,
  connectedIds?: ReadonlySet<string> | null,
  showCommStatus = false,
  tick = 0,
): void {
  const sig = buildings
    .map((b) => `${b.id}:${b.buildingId}@${b.gx},${b.gy}:own=${b.ownerId === myPlayerId}`)
    .join("|");
  if (sig !== lastDrawnBuildingSig) {
    lastDrawnBuildingSig = sig;
    log.info("draw", "buildings changed", buildings.length, sig || "(none)");
  }
  for (const b of buildings) {
    const x = originX + b.gx * cell;
    const y = originY + b.gy * cell;
    const size = cell * 0.85;
    const half = size / 2;
    const mine = myPlayerId != null && b.ownerId === myPlayerId;
    const incomplete = b.buildTicksRemaining > 0;
    const linked =
      !!connectedIds && isBuildingCommsLinked(b.id, connectedIds);
    // Comm advanced view: teal online / red offline icons for own buildings.
    // Incomplete keeps own (white) icon — no gray status ring.
    let iconVariant: "own" | "enemy" | "online" | "offline" = mine
      ? "own"
      : "enemy";
    if (showCommStatus && mine && !incomplete) {
      iconVariant = linked ? "online" : "offline";
    }
    const img = getBuildingIcon(b.buildingId, iconVariant);
    let alpha = incomplete
      ? 0.55 + 0.45 * (1 - b.buildTicksRemaining / Math.max(1, b.buildTicksTotal))
      : 1;
    if (incomplete && b.buildPaused) {
      alpha *= 0.55;
    }
    // Own buildings without comms link render dimmer (normal view only;
    // advanced view already uses red offline icons).
    if (
      !showCommStatus &&
      mine &&
      connectedIds &&
      !connectedIds.has(b.id) &&
      b.buildingId !== "capital"
    ) {
      alpha *= 0.45;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    if (img) {
      ctx.drawImage(img, x - half, y - half, size, size);
    } else {
      const fallback =
        showCommStatus && mine && !incomplete
          ? linked
            ? COMM_STATUS_LINKED
            : COMM_STATUS_UNLINKED
          : mine
            ? "#8a8a8a"
            : "#eb6040";
      ctx.fillStyle = fallback;
      ctx.beginPath();
      ctx.arc(x, y, half * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Launch / AA cooldown: gray pie over the icon (remaining fraction of period).
    const reloadE = BUILDING_BY_ID[b.buildingId]?.reloadE ?? 0;
    if (reloadE > 0 && isLaunchCoolingDown(b, tick)) {
      const total = launchCooldownTicks(reloadE);
      const remaining = (b.fireCooldownUntilTick ?? 0) - tick;
      if (total > 0 && remaining > 0) {
        drawLaunchCooldownSector(
          ctx,
          x,
          y,
          half * 0.72,
          Math.min(1, remaining / total),
        );
      }
    }

    // 线性升级建筑：左下角罗马数字等级（己方可见）
    if (mine && supportsLinearUpgrade(b.buildingId)) {
      const lvl = buildingLevel(b);
      const roman = romanLevelLabel(lvl);
      // Keep well under icon body; avoid Unicode numeral fallbacks that look stroked.
      const fontPx = Math.max(2, cell * 0.028);
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      ctx.lineWidth = 0;
      ctx.font = `${fontPx}px SimSun, "Songti SC", "Noto Serif CJK SC", "宋体", serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#ffffff";
      const tx = x - half + cell * 0.012;
      const ty = y + half - cell * 0.006;
      ctx.fillText(roman, tx, ty);
      ctx.restore();
    }

    // HP only for own or direct vision; U / other data only for own (§4.5).
    const showHp = mine || (b.visionLevel === "direct" && b.hpMax > 0);
    const showU = mine;
    if (!showHp && !showU) continue;

    const def = BUILDING_BY_ID[b.buildingId];
    const isTrainingGround = b.buildingId === "training_ground";
    const hpRatio = b.hpMax > 0 ? Math.max(0, Math.min(1, b.hp / b.hpMax)) : 0;
    const storeEMax = showU ? (def?.storeEMax ?? 0) : 0;
    const ammoMax = showU ? (def?.ammoMax ?? 0) : 0;
    const uMax =
      showU && storeEMax <= 0 && ammoMax <= 0 ? effectiveUmax(b) : 0;
    const storeECur =
      storeEMax <= 0 ? 0 : Math.max(0, Math.min(storeEMax, b.storeE ?? 0));
    const storeERatio =
      storeEMax > 0 ? Math.max(0, Math.min(1, storeECur / storeEMax)) : 0;
    const ammoCur =
      ammoMax <= 0 ? 0 : Math.max(0, Math.min(ammoMax, b.ammo ?? 0));
    const ammoRatio =
      ammoMax > 0 ? Math.max(0, Math.min(1, ammoCur / ammoMax)) : 0;
    const uCur =
      uMax <= 0 ? 0 : Math.max(0, Math.min(uMax, b.u ?? 0));
    const uAway =
      uMax <= 0 ? 0 : Math.max(0, Math.min(uMax - uCur, awayOccupiedU(b)));
    const uPresentRatio = uMax > 0 ? Math.max(0, Math.min(1, uCur / uMax)) : 0;
    const uAwayRatio = uMax > 0 ? Math.max(0, Math.min(1, uAway / uMax)) : 0;
    const trainProgress = isTrainingGround ? trainingHeadProgress(b) : 0;
    const trainActive =
      isTrainingGround && (b.trainingQueue?.length ?? 0) > 0;

    const barW = size * 0.9;
    const barH = Math.max(0.5, cell * 0.015);
    const gap = Math.max(0.5, cell * 0.008);
    const barX = x - barW / 2;
    const hpY = y + half * 0.85;
    const uY = hpY + barH + gap;

    if (showHp && b.hpMax > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(barX, hpY, barW, barH);
      ctx.fillStyle = "#c45c5c";
      ctx.fillRect(barX, hpY, barW * hpRatio, barH);
    }

    if (storeEMax > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(barX, uY, barW, barH);
      ctx.fillStyle = "#5cb85c";
      ctx.fillRect(barX, uY, barW * storeERatio, barH);
    } else if (ammoMax > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(barX, uY, barW, barH);
      ctx.fillStyle = "#4a90d9";
      ctx.fillRect(barX, uY, barW * ammoRatio, barH);
    } else if (uMax > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(barX, uY, barW, barH);
      ctx.fillStyle = "#c9a227";
      ctx.fillRect(barX, uY, barW * uPresentRatio, barH);
      if (uAway > 0) {
        ctx.fillStyle = "#7a6a1a";
        ctx.fillRect(barX + barW * uPresentRatio, uY, barW * uAwayRatio, barH);
      }
    } else if (showU && isTrainingGround) {
      // Same size as garrison bars; content matches BuildingInspectHud training bar.
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(barX, uY, barW, barH);
      ctx.fillStyle = "#c9a227";
      ctx.fillRect(barX, uY, barW * trainProgress, barH);
      if (trainActive) {
        const periodMs = 1400;
        const t = (performance.now() % periodMs) / periodMs;
        const runnerW = Math.max(1, barH);
        const runnerX = barX + t * Math.max(0, barW - runnerW);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(runnerX, uY, runnerW, barH);
      }
    }
  }
}

function liaisonLineStyle(
  kind: LiaisonKind,
  cell: number,
  zoom: number,
): { lineWidth: number; dash: number[]; lineCap: CanvasLineCap } {
  // Dash lengths are in layout space (divided by zoom via lineWidth convention:
  // setLineDash uses the same units as lineWidth under the current transform).
  switch (kind) {
    case "fiber":
      // 点状虚线：圆点 + 间隔（偏密）
      return {
        lineWidth: 2.4 / zoom,
        dash: [0.01, cell * 0.2],
        lineCap: "round",
      };
    case "road":
      // 白色实线
      return {
        lineWidth: 2.6 / zoom,
        dash: [],
        lineCap: "round",
      };
    case "railway":
      // 长条虚线
      return {
        lineWidth: 3.0 / zoom,
        dash: [cell * 0.85, cell * 0.32],
        lineCap: "butt",
      };
  }
}

function drawLiaisonPolyline(
  ctx: CanvasRenderingContext2D,
  nodes: readonly GridNode[],
  kind: LiaisonKind,
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
  opts?: {
    incomplete?: boolean;
    preview?: boolean;
    selected?: boolean;
    /** Own (white) vs enemy (orange #eb6040). Default own. */
    mine?: boolean;
    /** Override stroke when showing comm status (own lines only). */
    strokeColor?: string;
    /**
     * Comm-status: color each grid edge separately.
     * Return undefined to fall back to `strokeColor` / default.
     */
    segmentColor?: (ax: number, ay: number, bx: number, by: number) => string | undefined;
  },
): void {
  if (nodes.length < 2) return;
  const incomplete = opts?.incomplete ?? false;
  const preview = opts?.preview ?? false;
  const selected = opts?.selected ?? false;
  const mine = opts?.mine ?? true;
  const defaultColor = opts?.strokeColor ?? (mine ? LIAISON_OWN : LIAISON_ENEMY);
  const style = liaisonLineStyle(kind, cell, zoom);
  const segmentColor = opts?.segmentColor;

  const strokeFullPath = () => {
    ctx.beginPath();
    ctx.moveTo(originX + nodes[0].gx * cell, originY + nodes[0].gy * cell);
    for (let i = 1; i < nodes.length; i++) {
      ctx.lineTo(originX + nodes[i].gx * cell, originY + nodes[i].gy * cell);
    }
    ctx.stroke();
  };

  const strokeSegments = (colorFor: (ax: number, ay: number, bx: number, by: number) => string) => {
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      ctx.strokeStyle = colorFor(a.gx, a.gy, b.gx, b.gy);
      ctx.beginPath();
      ctx.moveTo(originX + a.gx * cell, originY + a.gy * cell);
      ctx.lineTo(originX + b.gx * cell, originY + b.gy * cell);
      ctx.stroke();
    }
  };

  ctx.save();
  ctx.lineJoin = "round";

  if (selected) {
    ctx.strokeStyle = mine ? "rgba(255,255,255,0.35)" : "rgba(235,96,64,0.45)";
    ctx.lineWidth = style.lineWidth + 2.4 / zoom;
    ctx.lineCap = style.lineCap;
    ctx.setLineDash(style.dash);
    ctx.globalAlpha = 1;
    strokeFullPath();
  }

  ctx.lineWidth = style.lineWidth;
  ctx.lineCap = style.lineCap;
  ctx.globalAlpha = preview ? 0.7 : incomplete ? 0.4 : 0.95;
  // Kind dash pattern; incomplete/preview slightly denser dash overlay only for solid road
  if (style.dash.length > 0) {
    ctx.setLineDash(style.dash);
  } else if (preview || incomplete) {
    ctx.setLineDash([cell * 0.4, cell * 0.25]);
  } else {
    ctx.setLineDash([]);
  }
  if (segmentColor) {
    strokeSegments((ax, ay, bx, by) => segmentColor(ax, ay, bx, by) ?? defaultColor);
  } else {
    ctx.strokeStyle = defaultColor;
    strokeFullPath();
  }
  ctx.restore();
}

function resolveCommUsedEdges(
  myPlayerId: string,
  buildings: readonly PlacedBuilding[],
  liaisons: readonly PlacedLiaison[],
  connectedIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const sig =
    `${myPlayerId}|${connectedIds.size}|` +
    buildings
      .filter((b) => b.ownerId === myPlayerId)
      .map(
        (b) =>
          `${b.id}:${b.buildingId}@${b.gx},${b.gy}:p=${b.polluted ? 1 : 0}:t=${b.buildTicksRemaining}`,
      )
      .join(";") +
    "|" +
    liaisons
      .filter((l) => l.ownerId === myPlayerId)
      .map(
        (l) =>
          `${l.id}:${l.kind}:${l.buildTicksRemaining}:` +
          l.nodes.map((n) => `${n.gx},${n.gy}`).join("-"),
      )
      .join(";");
  if (sig === cachedCommUsedEdgesSig) return cachedCommUsedEdges;
  cachedCommUsedEdgesSig = sig;
  cachedCommUsedEdges = collectCommUsedEdges(
    myPlayerId,
    buildings,
    liaisons,
    connectedIds,
  );
  return cachedCommUsedEdges;
}

function drawLiaisons(
  ctx: CanvasRenderingContext2D,
  lines: readonly PlacedLiaison[],
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
  myPlayerId: string | null,
  selectedId?: string | null,
  buildings?: readonly PlacedBuilding[] | null,
  connectedIds?: ReadonlySet<string> | null,
  showCommStatus = false,
): void {
  const usedEdges =
    showCommStatus &&
    myPlayerId != null &&
    connectedIds &&
    buildings
      ? resolveCommUsedEdges(myPlayerId, buildings, lines, connectedIds)
      : null;

  for (const line of lines) {
    const mine = myPlayerId == null || line.ownerId === myPlayerId;
    let segmentColor:
      | ((ax: number, ay: number, bx: number, by: number) => string | undefined)
      | undefined;
    if (showCommStatus && mine && usedEdges) {
      segmentColor = (ax, ay, bx, by) =>
        usedEdges.has(undirectedCommEdgeKey(ax, ay, bx, by))
          ? COMM_STATUS_LINKED
          : COMM_STATUS_LIAISON_IDLE;
    }
    drawLiaisonPolyline(ctx, line.nodes, line.kind, originX, originY, cell, zoom, {
      incomplete: line.buildTicksRemaining > 0,
      selected: selectedId != null && line.id === selectedId,
      mine,
      segmentColor,
    });
  }
}

/** Reused offscreen buffer so overlapping vision circles union (not XOR). */
let fogCanvas: HTMLCanvasElement | null = null;
let fogCtx: CanvasRenderingContext2D | null = null;

function ensureFogCanvas(w: number, h: number): CanvasRenderingContext2D {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (!fogCanvas || !fogCtx || fogCanvas.width !== cw || fogCanvas.height !== ch) {
    fogCanvas = document.createElement("canvas");
    fogCanvas.width = cw;
    fogCanvas.height = ch;
    fogCtx = fogCanvas.getContext("2d");
    if (!fogCtx) throw new Error("fog canvas 2d unavailable");
  }
  return fogCtx;
}

/**
 * Dim the board outside direct-vision circles (satellite-only fog).
 * Circles are punched with destination-out so overlaps stay clear (union).
 */
function drawSatelliteFog(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  boardW: number,
  boardH: number,
  cell: number,
  sources: readonly VisionSource[],
): void {
  const fctx = ensureFogCanvas(boardW, boardH);
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.clearRect(0, 0, fogCanvas!.width, fogCanvas!.height);
  fctx.globalCompositeOperation = "source-over";
  fctx.fillStyle = SATELLITE_FOG;
  fctx.fillRect(0, 0, boardW, boardH);

  if (sources.length > 0) {
    fctx.globalCompositeOperation = "destination-out";
    fctx.fillStyle = "#000";
    for (const s of sources) {
      const x = s.gx * cell;
      const y = s.gy * cell;
      const r = Math.max(0, s.radiusDu) * cell;
      if (r <= 0) continue;
      fctx.beginPath();
      fctx.arc(x, y, r, 0, Math.PI * 2);
      fctx.fill();
    }
    fctx.globalCompositeOperation = "source-over";
  }

  ctx.drawImage(fogCanvas!, 0, 0, boardW, boardH, originX, originY, boardW, boardH);
}

function drawCapitalExclusionRings(
  ctx: CanvasRenderingContext2D,
  buildings: readonly PlacedBuilding[],
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
  myPlayerId: string | null,
): void {
  const radius = CAPITAL_EXCLUSION_R_DU * cell;
  ctx.save();
  ctx.lineWidth = 2 / zoom;
  ctx.strokeStyle = "#ff3b30";
  ctx.fillStyle = "rgba(255, 48, 40, 0.18)";
  for (const b of buildings) {
    if (b.buildingId !== "capital") continue;
    if (myPlayerId && b.ownerId === myPlayerId) continue;
    const x = originX + b.gx * cell;
    const y = originY + b.gy * cell;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Nuclear pollution: persistent red circles (R = NUKE_POLLUTION_R_DU). */
function drawPollutionZones(
  ctx: CanvasRenderingContext2D,
  zones: readonly PollutionZone[],
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
): void {
  if (zones.length === 0) return;
  ctx.save();
  ctx.lineWidth = 2.25 / zoom;
  ctx.strokeStyle = "rgba(220, 32, 28, 0.95)";
  ctx.fillStyle = "rgba(210, 28, 24, 0.22)";
  for (const z of zones) {
    const rDu = z.radiusDu > 0 ? z.radiusDu : NUKE_POLLUTION_R_DU;
    const radius = rDu * cell;
    if (radius <= 0) continue;
    const x = originX + z.gx * cell;
    const y = originY + z.gy * cell;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawWorkRangeRing(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  radiusDu: number,
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
  strokeStyle = "rgba(150, 206, 255, 0.92)",
): void {
  const radius = radiusDu * cell;
  if (radius <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(originX + gx * cell, originY + gy * cell, radius, 0, Math.PI * 2);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 1.75 / zoom;
  ctx.stroke();
  ctx.restore();
}

/** Stroke-only work ranges for own connected radios (incl. radar merge). */
function drawConnectedRadioRanges(
  ctx: CanvasRenderingContext2D,
  buildings: readonly PlacedBuilding[],
  myPlayerId: string,
  connectedIds: ReadonlySet<string> | readonly string[],
  originX: number,
  originY: number,
  cell: number,
  zoom: number,
): void {
  for (const b of buildings) {
    if (b.ownerId !== myPlayerId) continue;
    if (b.buildingId !== RADIO_BUILDING_ID) continue;
    if (!isBuildingComplete(b)) continue;
    if (b.polluted) continue;
    if (!isBuildingCommsLinked(b.id, connectedIds)) continue;
    for (const ring of workRangeCircles(b, buildings, connectedIds)) {
      drawWorkRangeRing(
        ctx,
        ring.gx,
        ring.gy,
        ring.radiusDu,
        originX,
        originY,
        cell,
        zoom,
        COMM_STATUS_LINKED,
      );
    }
  }
}

/**
 * Known enemy vision from the viewer-filtered snapshot:
 * all known enemy buildings (incl. small already in our vision; radius via
 * directVisionRadiusForBuilding) and all enemy units (kind R).
 */
function collectKnownEnemyVisionSources(
  buildings: readonly PlacedBuilding[],
  units: readonly UnitGroup[],
  myPlayerId: string,
): VisionSource[] {
  const out: VisionSource[] = [];
  for (const b of buildings) {
    if (b.ownerId === myPlayerId) continue;
    out.push({
      gx: b.gx,
      gy: b.gy,
      radiusDu: directVisionRadiusForBuilding(b.buildingId),
    });
  }
  for (const u of units) {
    if (u.ownerId === myPlayerId) continue;
    let radiusDu: number;
    if (u.kind === "infantry") radiusDu = DIRECT_VISION_R_INFANTRY;
    else if (u.kind === "air") radiusDu = DIRECT_VISION_R_AIR;
    else radiusDu = DIRECT_VISION_R_ARMOR_NAVY;
    out.push({ gx: u.gx, gy: u.gy, radiusDu });
  }
  return out;
}

/**
 * Draw known enemy vision as one union path so overlapping circles keep a
 * single uniform alpha (no per-circle compositing stack).
 */
function drawEnemyVisionRanges(
  ctx: CanvasRenderingContext2D,
  sources: readonly VisionSource[],
  originX: number,
  originY: number,
  cell: number,
): void {
  if (sources.length === 0) return;
  const path = new Path2D();
  let any = false;
  for (const s of sources) {
    const radius = Math.max(0, s.radiusDu) * cell;
    if (radius <= 0) continue;
    const x = originX + s.gx * cell;
    const y = originY + s.gy * cell;
    // Separate subpaths so arcs do not connect with chords.
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, Math.PI * 2);
    any = true;
  }
  if (!any) return;
  ctx.save();
  ctx.fillStyle = ENEMY_VISION_FILL;
  ctx.fill(path, "nonzero");
  ctx.restore();
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  {
    width,
    height,
    map,
    pan,
    zoom,
    terrain,
    selection,
    buildings,
    liaisons,
    liaisonPreview,
    selectedLiaisonId,
    resourceSight,
    myPlayerId,
    connectedBuildingIds,
    showCapitalExclusion,
    workRanges,
    units,
    selectedUnitId,
    inspectFocus,
    pollutionZones,
    showEnemyVision,
    showCommStatus,
    focusMarks,
    pathPreviews,
    fireAimAt,
    tick = 0,
  }: DrawMapArgs,
): void {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  const { cell, boardW, boardH, originX, originY } = getBoardLayout(width, height, map);
  const cx = width / 2;
  const cy = height / 2;

  ctx.save();
  ctx.translate(cx + pan.x, cy + pan.y);
  ctx.scale(zoom, zoom);
  ctx.translate(-cx, -cy);

  if (terrain) {
    fillTerrainCells(ctx, terrain, originX, originY, cell, zoom);
  }

  // Grid stroke is in layout space under scale(zoom): screenPx = lineWidth * zoom.
  // Base thickness tracks viewport via `cell`; zoom-in thins the on-screen stroke.
  const gridScreenPx = Math.max(1.5, Math.min(2, cell * 0.18) / zoom);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = gridScreenPx / zoom;
  ctx.beginPath();

  for (let i = 0; i < map.linesX; i++) {
    const x = originX + i * cell;
    ctx.moveTo(x, originY);
    ctx.lineTo(x, originY + boardH);
  }
  for (let j = 0; j < map.linesY; j++) {
    const y = originY + j * cell;
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + boardW, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#5c5c5c";
  const step = cell >= 10 ? 1 : 2;
  // Dot radius tracks cell size and thins with zoom (same rule as grid lines).
  const r = Math.max(0.35, (cell * 0.04) / zoom) / zoom;
  for (let i = 0; i < map.linesX; i += step) {
    for (let j = 0; j < map.linesY; j += step) {
      ctx.beginPath();
      ctx.arc(originX + i * cell, originY + j * cell, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const linked =
    connectedBuildingIds != null ? new Set(connectedBuildingIds) : null;

  if (liaisons && liaisons.length > 0) {
    drawLiaisons(
      ctx,
      liaisons,
      originX,
      originY,
      cell,
      zoom,
      myPlayerId ?? null,
      selectedLiaisonId,
      buildings,
      linked,
      !!showCommStatus,
    );
  }

  if (liaisonPreview && liaisonPreview.nodes.length >= 2) {
    drawLiaisonPolyline(
      ctx,
      liaisonPreview.nodes,
      liaisonPreview.kind,
      originX,
      originY,
      cell,
      zoom,
      { preview: true, mine: true },
    );
  }

  if (pollutionZones && pollutionZones.length > 0) {
    drawPollutionZones(ctx, pollutionZones, originX, originY, cell, zoom);
  }

  if (buildings && buildings.length > 0) {
    drawBuildings(
      ctx,
      buildings,
      originX,
      originY,
      cell,
      zoom,
      myPlayerId ?? null,
      linked,
      !!showCommStatus,
      tick,
    );
  }

  if (units && units.length > 0) {
    drawUnits(
      ctx,
      units,
      originX,
      originY,
      cell,
      zoom,
      myPlayerId ?? null,
      selectedUnitId ?? null,
    );
  }

  if (pathPreviews && pathPreviews.length > 0) {
    for (const nodes of pathPreviews) {
      if (nodes.length >= 2) {
        drawUnitPathPreview(ctx, nodes, originX, originY, cell, zoom);
      }
    }
  }

  if (focusMarks && focusMarks.length > 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(168, 240, 236, 0.95)";
    ctx.lineWidth = 2 / zoom;
    for (const m of focusMarks) {
      ctx.beginPath();
      ctx.arc(
        originX + m.gx * cell,
        originY + m.gy * cell,
        cell * 0.62,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  // Satellite-only regions: dim everything outside direct vision
  // (buildings + ground units; air-only circles do not clear ground fog).
  const fogSources = myPlayerId
    ? collectAllDirectVisionSources(
        buildings ?? [],
        units ?? [],
        myPlayerId,
        connectedBuildingIds ?? [],
      ).filter((s) => !s.airOnly)
    : [];
  if (myPlayerId) {
    drawSatelliteFog(ctx, originX, originY, boardW, boardH, cell, fogSources);
  }

  // Reserve rings after fog, re-filtered to direct vision only (same sources as fog).
  if (resourceSight && resourceSight.length > 0 && myPlayerId) {
    const visibleSight = filterResourceSightForViewer(
      resourceSight,
      myPlayerId,
      buildings ?? [],
      units ?? [],
      connectedBuildingIds ?? [],
    );
    if (visibleSight.length > 0) {
      drawResourceReserveRings(ctx, visibleSight, originX, originY, cell);
    }
  } else if (resourceSight && resourceSight.length > 0 && !myPlayerId) {
    // Spectator / no viewer: show all revealed reserves (no fog).
    drawResourceReserveRings(ctx, resourceSight, originX, originY, cell);
  }

  if (showEnemyVision && myPlayerId) {
    drawEnemyVisionRanges(
      ctx,
      collectKnownEnemyVisionSources(buildings ?? [], units ?? [], myPlayerId),
      originX,
      originY,
      cell,
    );
  }

  // Inspect HUD: dim map/entities, keep selected icon bright (before work-range UI).
  if (inspectFocus) {
    drawInspectFocusHighlight(
      ctx,
      inspectFocus,
      originX,
      originY,
      boardW,
      boardH,
      cell,
      buildings,
      units,
      myPlayerId ?? null,
      linked,
      !!showCommStatus,
    );
  }

  if (showCapitalExclusion && buildings && buildings.length > 0) {
    drawCapitalExclusionRings(
      ctx,
      buildings,
      originX,
      originY,
      cell,
      zoom,
      myPlayerId ?? null,
    );
  }

  if (workRanges) {
    for (const ring of workRanges) {
      drawWorkRangeRing(ctx, ring.gx, ring.gy, ring.radiusDu, originX, originY, cell, zoom);
    }
  }

  if (showCommStatus && myPlayerId && buildings && buildings.length > 0) {
    drawConnectedRadioRanges(
      ctx,
      buildings,
      myPlayerId,
      connectedBuildingIds ?? [],
      originX,
      originY,
      cell,
      zoom,
    );
  }

  ctx.restore();

  if (selection) {
    const lx = originX + selection.gx * cell;
    const ly = originY + selection.gy * cell;
    const screen = layoutToScreen(lx, ly, width, height, pan, zoom);
    drawSelectionMarkerScreen(ctx, screen.x, screen.y, selection.gx, selection.gy);
  }

  if (fireAimAt) {
    const lx = originX + fireAimAt.gx * cell;
    const ly = originY + fireAimAt.gy * cell;
    const screen = layoutToScreen(lx, ly, width, height, pan, zoom);
    drawFireAimCancelScreen(ctx, screen.x, screen.y);
  }
}
