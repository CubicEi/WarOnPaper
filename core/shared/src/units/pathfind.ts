/**
 * Unit pathfinding: minimum travel time, borrowing road/railway when helpful.
 * Land/navy use 0.2 grid A*; air is point-to-point straight line.
 */

import type { MapConfig } from "../map.js";
import type { TerrainMap } from "../terrain/types.js";
import { cellAt } from "../terrain/types.js";
import { cellsTouchingUnitCoord } from "../terrain/capitalSite.js";
import {
  distancePointToSegment,
  type PlacedLiaison,
} from "../buildings/liaison.js";
import type { WorkRangeCircle } from "../buildings/workRange.js";
import {
  ROAD_MOVE_SPEED,
  RAIL_MOVE_SPEED,
  UNIT_BY_KIND,
  UNIT_COORD_STEP,
  type UnitKind,
} from "./catalog.js";
import { snapToUnitCoord, unitCoordKey } from "./garrison.js";
import { isInsideAnyCircle } from "./radio.js";

const ON_TRANSPORT_EPS = 0.12;
const NEIGHBOR_DIRS: Array<[number, number]> = [
  [UNIT_COORD_STEP, 0],
  [-UNIT_COORD_STEP, 0],
  [0, UNIT_COORD_STEP],
  [0, -UNIT_COORD_STEP],
  [UNIT_COORD_STEP, UNIT_COORD_STEP],
  [UNIT_COORD_STEP, -UNIT_COORD_STEP],
  [-UNIT_COORD_STEP, UNIT_COORD_STEP],
  [-UNIT_COORD_STEP, -UNIT_COORD_STEP],
];

export type TransportKind = "road" | "railway" | null;

export function transportAt(
  gx: number,
  gy: number,
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
): TransportKind {
  let best: TransportKind = null;
  let bestD = ON_TRANSPORT_EPS;
  for (const line of liaisons) {
    if (line.ownerId !== ownerId) continue;
    if (line.buildTicksRemaining > 0) continue;
    if (line.kind !== "road" && line.kind !== "railway") continue;
    if (line.nodes.length < 2) continue;
    for (let i = 1; i < line.nodes.length; i++) {
      const d = distancePointToSegment(gx, gy, line.nodes[i - 1]!, line.nodes[i]!);
      if (d <= bestD) {
        bestD = d;
        best = line.kind;
        if (line.kind === "railway") return "railway";
      }
    }
  }
  return best;
}

function touchesGround(
  map: TerrainMap,
  gx: number,
  gy: number,
  ground: "ocean" | "land" | "mountain",
): boolean {
  return cellsTouchingUnitCoord(map, gx, gy).some(({ x, y }) => {
    return cellAt(map, x, y)?.ground === ground;
  });
}

/** Mountain for move rules: any touching mountain cell (incl. foothill). */
export function isMountainTerrain(map: TerrainMap, gx: number, gy: number): boolean {
  return touchesGround(map, gx, gy, "mountain");
}

/**
 * 山脚：同时触及山地与陆地（与公路山区半价分类一致）。
 * 装甲禁止进入的是「山区」，不是山脚。
 */
export function isFoothillTerrain(map: TerrainMap, gx: number, gy: number): boolean {
  const cells = cellsTouchingUnitCoord(map, gx, gy);
  if (cells.length === 0) return false;
  let hasMountain = false;
  let hasLand = false;
  for (const { x, y } of cells) {
    const g = cellAt(map, x, y)?.ground;
    if (g === "mountain") hasMountain = true;
    if (g === "land") hasLand = true;
  }
  return hasMountain && hasLand;
}

/** Pure mountain (山区): touches mountain and is not foothill. */
export function isPureMountainTerrain(map: TerrainMap, gx: number, gy: number): boolean {
  return isMountainTerrain(map, gx, gy) && !isFoothillTerrain(map, gx, gy);
}

export function isOceanTerrain(map: TerrainMap, gx: number, gy: number): boolean {
  const cells = cellsTouchingUnitCoord(map, gx, gy);
  if (cells.length === 0) return false;
  return cells.every(({ x, y }) => cellAt(map, x, y)?.ground === "ocean");
}

export function isLandTerrain(map: TerrainMap, gx: number, gy: number): boolean {
  const cells = cellsTouchingUnitCoord(map, gx, gy);
  if (cells.length === 0) return false;
  return cells.every(({ x, y }) => cellAt(map, x, y)?.ground === "land");
}

function isLandKind(kind: UnitKind): boolean {
  return kind === "infantry" || kind === "armor";
}

export interface TerrainAllowOpts {
  liaisons?: readonly PlacedLiaison[];
  ownerId?: string;
}

/**
 * Walkability for a unit kind at a point.
 * Land may enter pure ocean only when standing on own completed road/railway.
 * Navy requires pure ocean (port coastline cells use allowImpassableStart/Goal).
 */
export function terrainAllowsKind(
  kind: UnitKind,
  map: TerrainMap,
  gx: number,
  gy: number,
  opts?: TerrainAllowOpts,
): boolean {
  if (kind === "air") return true;
  const def = UNIT_BY_KIND[kind];
  // Armor blocks 山区 only; foothill (山脚) remains passable for deploy/move.
  if (def.mountainBlocked && isPureMountainTerrain(map, gx, gy)) return false;
  if (kind === "navy" || kind === "navy_carrier") {
    return isOceanTerrain(map, gx, gy);
  }
  if (isOceanTerrain(map, gx, gy)) {
    const liaisons = opts?.liaisons;
    const ownerId = opts?.ownerId;
    if (!liaisons || ownerId == null) return false;
    return transportAt(gx, gy, liaisons, ownerId) != null;
  }
  return true;
}

const LAND_WATER_ERROR = "陆军无法穿越水域，需借道公路或铁路";

/**
 * Effective move speed at a point. Road/rail override base; mountain halves infantry.
 */
export function speedAt(
  kind: UnitKind,
  map: TerrainMap | null,
  gx: number,
  gy: number,
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
): number {
  const def = UNIT_BY_KIND[kind];
  if (kind === "air") return def.speedDuPerS;

  const transport = transportAt(gx, gy, liaisons, ownerId);
  if (transport === "railway") return RAIL_MOVE_SPEED;
  if (transport === "road") return ROAD_MOVE_SPEED;

  let speed = def.speedDuPerS;
  if (map && isMountainTerrain(map, gx, gy)) {
    speed *= def.mountainSpeedFactor;
  }
  return speed;
}

/** Straight-line air path; destination must lie in airport coverage (unless `ignoreCoverage`). */
export function planAirPath(
  fromGx: number,
  fromGy: number,
  toGx: number,
  toGy: number,
  coverage: readonly WorkRangeCircle[],
  opts?: { ignoreCoverage?: boolean },
): { path: Array<{ gx: number; gy: number }>; error?: string } {
  const start = snapToUnitCoord(fromGx, fromGy);
  const end = snapToUnitCoord(toGx, toGy);
  if (!opts?.ignoreCoverage) {
    if (coverage.length === 0) {
      return { path: [], error: "所属机场工作范围不可用" };
    }
    if (!isInsideAnyCircle(start.gx, start.gy, coverage)) {
      return { path: [], error: "起点不在所属机场工作范围内" };
    }
    if (!isInsideAnyCircle(end.gx, end.gy, coverage)) {
      return { path: [], error: "目标不在所属机场工作范围内（含关联雷达）" };
    }
  }
  if (unitCoordKey(start.gx, start.gy) === unitCoordKey(end.gx, end.gy)) {
    return { path: [start] };
  }
  return { path: [start, end] };
}

interface HeapNode {
  key: string;
  f: number;
  g: number;
  gx: number;
  gy: number;
}

/** Simple binary min-heap on f. */
class MinHeap {
  private data: HeapNode[] = [];

  get size(): number {
    return this.data.length;
  }

  push(n: HeapNode): void {
    this.data.push(n);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[i]!.f >= this.data[p]!.f) break;
      [this.data[i], this.data[p]] = [this.data[p]!, this.data[i]!];
      i = p;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.data.length;
    for (;;) {
      let best = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < n && this.data[l]!.f < this.data[best]!.f) best = l;
      if (r < n && this.data[r]!.f < this.data[best]!.f) best = r;
      if (best === i) break;
      [this.data[i], this.data[best]] = [this.data[best]!, this.data[i]!];
      i = best;
    }
  }
}

function heuristicTime(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  maxSpeed: number,
): number {
  return Math.hypot(ax - bx, ay - by) / Math.max(1e-6, maxSpeed);
}

export interface PathPlanResult {
  path: Array<{ gx: number; gy: number }>;
  travelTimeSec: number;
  error?: string;
}

export type ActivityRangeLabel = "radio" | "port";

/**
 * Minimum-time path on the 0.2 grid.
 * `ignoreCoverage` skips radio/port range checks (training delivery, retreat, reassignment).
 * `ignoreTerrain` skips walkability (retreat). Navy training embarks onto ocean then paths normally.
 * `allowImpassableStart` / `allowImpassableGoal` let navy use a coastline port cell.
 * Goals outside an active range are rejected (not clamped).
 */
export function planLandOrNavyPath(args: {
  kind: UnitKind;
  fromGx: number;
  fromGy: number;
  toGx: number;
  toGy: number;
  map: MapConfig;
  terrain: TerrainMap;
  liaisons: readonly PlacedLiaison[];
  ownerId: string;
  coverage: readonly WorkRangeCircle[];
  /** Training delivery / retreat: skip radio or port range checks. */
  ignoreCoverage?: boolean;
  /** Retreat: path across any terrain. */
  ignoreTerrain?: boolean;
  /** Port cell is a legal navy departure even when it is not pure ocean. */
  allowImpassableStart?: boolean;
  /** Port cell is a legal navy arrival (dock) even when it is not pure ocean. */
  allowImpassableGoal?: boolean;
  /** Wording for range errors. Port navy uses the port work range, not radio. */
  rangeLabel?: ActivityRangeLabel;
}): PathPlanResult {
  const { kind, terrain, liaisons, ownerId, map: mapCfg } = args;
  const ignoreCoverage = !!args.ignoreCoverage;
  const ignoreTerrain = !!args.ignoreTerrain;
  const allowImpassableStart = !!args.allowImpassableStart || ignoreTerrain;
  const allowImpassableGoal = !!args.allowImpassableGoal || ignoreTerrain;
  const coverage = ignoreCoverage ? [] : args.coverage;
  const start = snapToUnitCoord(args.fromGx, args.fromGy);
  const goal = snapToUnitCoord(args.toGx, args.toGy);
  const portRange = args.rangeLabel === "port";
  const startRangeError = portRange ? "起点不在港口工作范围内" : "起点不在电台通信范围内";
  const goalRangeError = portRange ? "目标超出港口工作范围" : "目标超出电台通信范围";
  const unreachableError = portRange
    ? "无法到达目标（地形或港口工作范围）"
    : isLandKind(kind)
      ? "无法到达目标（地形、水域或通信范围）"
      : "无法到达目标（地形或通信范围）";
  const terrainOpts: TerrainAllowOpts = { liaisons, ownerId };

  if (coverage.length > 0 && !isInsideAnyCircle(start.gx, start.gy, coverage)) {
    return { path: [], travelTimeSec: 0, error: startRangeError };
  }
  if (coverage.length === 0 && !ignoreCoverage) {
    return { path: [], travelTimeSec: 0, error: startRangeError };
  }
  if (coverage.length > 0 && !isInsideAnyCircle(goal.gx, goal.gy, coverage)) {
    return { path: [], travelTimeSec: 0, error: goalRangeError };
  }

  const sameCell = unitCoordKey(start.gx, start.gy) === unitCoordKey(goal.gx, goal.gy);
  // #region agent log
  if (kind === "armor") {
    const cells = cellsTouchingUnitCoord(terrain, start.gx, start.gy).map(
      ({ x, y }) => ({
        x,
        y,
        g: cellAt(terrain, x, y)?.ground ?? null,
      }),
    );
    const anyMtn = isMountainTerrain(terrain, start.gx, start.gy);
    const foothill = isFoothillTerrain(terrain, start.gx, start.gy);
    const pureMtn = isPureMountainTerrain(terrain, start.gx, start.gy);
    const allows = terrainAllowsKind(
      kind,
      terrain,
      start.gx,
      start.gy,
      terrainOpts,
    );
    fetch("http://127.0.0.1:7277/ingest/6741dc77-72e2-46ba-9a2a-c7dd9d84b7e9", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "676d95",
      },
      body: JSON.stringify({
        sessionId: "676d95",
        runId: "pre-fix",
        hypothesisId: "A_B_C",
        location: "pathfind.ts:planLandOrNavyPath:armorStart",
        message: "armor path start classify",
        data: {
          start,
          goal,
          anyMtn,
          foothill,
          pureMtn,
          allows,
          oldWouldBlock: anyMtn,
          hasLand: cells.some((c) => c.g === "land"),
          hasOcean: cells.some((c) => c.g === "ocean"),
          cells,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion
  const startOk =
    ignoreTerrain ||
    allowImpassableStart ||
    terrainAllowsKind(kind, terrain, start.gx, start.gy, terrainOpts);
  if (!startOk) {
    const err =
      isLandKind(kind) && isOceanTerrain(terrain, start.gx, start.gy)
        ? LAND_WATER_ERROR
        : "起点地形不可通行";
    // #region agent log
    {
      const cells = cellsTouchingUnitCoord(terrain, start.gx, start.gy).map(
        ({ x, y }) => ({
          x,
          y,
          g: cellAt(terrain, x, y)?.ground ?? null,
        }),
      );
      fetch("http://127.0.0.1:7277/ingest/6741dc77-72e2-46ba-9a2a-c7dd9d84b7e9", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "676d95",
        },
        body: JSON.stringify({
          sessionId: "676d95",
          runId: "pre-fix",
          hypothesisId: "D_E",
          location: "pathfind.ts:planLandOrNavyPath:reject",
          message: "start terrain rejected",
          data: {
            kind,
            start,
            goal,
            err,
            ignoreTerrain,
            allowImpassableStart,
            anyMtn: isMountainTerrain(terrain, start.gx, start.gy),
            foothill: isFoothillTerrain(terrain, start.gx, start.gy),
            pureMtn: isPureMountainTerrain(terrain, start.gx, start.gy),
            ocean: isOceanTerrain(terrain, start.gx, start.gy),
            cells,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    }
    // #endregion
    return { path: [], travelTimeSec: 0, error: err };
  }
  const goalOk =
    ignoreTerrain ||
    sameCell ||
    allowImpassableGoal ||
    terrainAllowsKind(kind, terrain, goal.gx, goal.gy, terrainOpts);
  if (!goalOk) {
    const err =
      isLandKind(kind) && isOceanTerrain(terrain, goal.gx, goal.gy)
        ? LAND_WATER_ERROR
        : "目标地形不可通行";
    return { path: [], travelTimeSec: 0, error: err };
  }

  if (unitCoordKey(start.gx, start.gy) === unitCoordKey(goal.gx, goal.gy)) {
    return { path: [start], travelTimeSec: 0 };
  }

  const maxX = mapCfg.linesX - 1;
  const maxY = mapCfg.linesY - 1;
  const maxSpeed = Math.max(
    UNIT_BY_KIND[kind].speedDuPerS,
    ROAD_MOVE_SPEED,
    RAIL_MOVE_SPEED,
  );

  const startKey = unitCoordKey(start.gx, start.gy);
  const goalKey = unitCoordKey(goal.gx, goal.gy);
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();
  const open = new MinHeap();
  gScore.set(startKey, 0);
  open.push({
    key: startKey,
    gx: start.gx,
    gy: start.gy,
    g: 0,
    f: heuristicTime(start.gx, start.gy, goal.gx, goal.gy, maxSpeed),
  });

  const inBounds = (x: number, y: number) =>
    x >= 0 && y >= 0 && x <= maxX + 1e-9 && y <= maxY + 1e-9;

  const walkable = (nx: number, ny: number): boolean => {
    if (ignoreTerrain) return true;
    if (terrainAllowsKind(kind, terrain, nx, ny, terrainOpts)) return true;
    const key = unitCoordKey(nx, ny);
    if (allowImpassableStart && key === startKey) return true;
    if (allowImpassableGoal && key === goalKey) return true;
    return false;
  };

  let found = false;
  let guard = 0;
  const GUARD_MAX = 250_000;

  while (open.size > 0 && guard++ < GUARD_MAX) {
    const cur = open.pop()!;
    if (cur.key === goalKey) {
      found = true;
      break;
    }
    const knownG = gScore.get(cur.key);
    if (knownG != null && cur.g > knownG + 1e-12) continue;

    for (const [dx, dy] of NEIGHBOR_DIRS) {
      const nx = Math.round((cur.gx + dx) * 1000) / 1000;
      const ny = Math.round((cur.gy + dy) * 1000) / 1000;
      if (!inBounds(nx, ny)) continue;
      if (coverage.length > 0 && !isInsideAnyCircle(nx, ny, coverage)) continue;
      if (!walkable(nx, ny)) continue;

      const dist = Math.hypot(dx, dy);
      // Use destination speed (entering cell / transport).
      const spd = speedAt(kind, terrain, nx, ny, liaisons, ownerId);
      const stepTime = dist / Math.max(1e-6, spd);
      const ng = cur.g + stepTime;
      const nk = unitCoordKey(nx, ny);
      const prev = gScore.get(nk);
      if (prev != null && ng >= prev - 1e-12) continue;
      gScore.set(nk, ng);
      cameFrom.set(nk, cur.key);
      open.push({
        key: nk,
        gx: nx,
        gy: ny,
        g: ng,
        f: ng + heuristicTime(nx, ny, goal.gx, goal.gy, maxSpeed),
      });
    }
  }

  if (!found) {
    return { path: [], travelTimeSec: 0, error: unreachableError };
  }

  const rev: Array<{ gx: number; gy: number }> = [];
  let walk: string | undefined = goalKey;
  while (walk) {
    const [xs, ys] = walk.split(",");
    rev.push({ gx: Number(xs), gy: Number(ys) });
    if (walk === startKey) break;
    walk = cameFrom.get(walk);
  }
  rev.reverse();
  return {
    path: rev,
    travelTimeSec: gScore.get(goalKey) ?? 0,
  };
}

export function estimatePathTimeSec(
  kind: UnitKind,
  path: readonly { gx: number; gy: number }[],
  terrain: TerrainMap | null,
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
): number {
  if (path.length < 2) return 0;
  let t = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dist = Math.hypot(b.gx - a.gx, b.gy - a.gy);
    const spd = speedAt(kind, terrain, b.gx, b.gy, liaisons, ownerId);
    t += dist / Math.max(1e-6, spd);
  }
  return t;
}

/**
 * If `gx,gy` is occupied, find a nearby free 0.2 cell (spiral).
 */
export function findFreeUnitCoord(
  gx: number,
  gy: number,
  occupied: ReadonlySet<string>,
  maxRadius = 2,
  allow?: (gx: number, gy: number) => boolean,
): { gx: number; gy: number } {
  const start = snapToUnitCoord(gx, gy);
  const ok = (p: { gx: number; gy: number }) =>
    !occupied.has(unitCoordKey(p.gx, p.gy)) && (allow ? allow(p.gx, p.gy) : true);
  if (ok(start)) return start;

  const step = UNIT_COORD_STEP;
  for (let ring = 1; ring <= Math.ceil(maxRadius / step); ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = snapToUnitCoord(start.gx + dx * step, start.gy + dy * step);
        if (ok(p)) return p;
      }
    }
  }
  return start;
}

/**
 * Nearest 0.2-grid cell where `terrainAllowsKind` (optional extra allow) holds.
 * Used to embark training navy from an inland training ground onto ocean.
 */
export function findNearestAllowedCoord(
  kind: UnitKind,
  mapCfg: MapConfig,
  terrain: TerrainMap,
  fromGx: number,
  fromGy: number,
  opts?: TerrainAllowOpts & {
    maxRadiusDu?: number;
    allowExtra?: (gx: number, gy: number) => boolean;
  },
): { gx: number; gy: number } | null {
  const start = snapToUnitCoord(fromGx, fromGy);
  const maxR = opts?.maxRadiusDu ?? Math.max(mapCfg.linesX, mapCfg.linesY) + 1;
  const step = UNIT_COORD_STEP;
  const maxX = mapCfg.linesX - 1;
  const maxY = mapCfg.linesY - 1;
  const ok = (gx: number, gy: number) =>
    terrainAllowsKind(kind, terrain, gx, gy, opts) ||
    !!opts?.allowExtra?.(gx, gy);
  if (ok(start.gx, start.gy)) return start;

  const maxRing = Math.ceil(maxR / step);
  for (let ring = 1; ring <= maxRing; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = snapToUnitCoord(start.gx + dx * step, start.gy + dy * step);
        if (p.gx < -1e-9 || p.gy < -1e-9 || p.gx > maxX + 1e-9 || p.gy > maxY + 1e-9) {
          continue;
        }
        if (ok(p.gx, p.gy)) return p;
      }
    }
  }
  return null;
}
