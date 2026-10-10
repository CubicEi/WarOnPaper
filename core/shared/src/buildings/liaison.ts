/** Liaison lines (线缆 / 公路 / 铁路) — rules §7.4 / 建造联络线. */

import { isFriendly, type TeamRoster } from "../teams.js";
import { durationSecToTicks } from "../time.js";

export type LiaisonKind = "fiber" | "road" | "railway";

export interface GridNode {
  gx: number;
  gy: number;
}

export interface LiaisonLineDef {
  id: LiaisonKind;
  name: string;
  /** 造价系数：E = ⌊长度⌋ × costPerDu × 10 */
  costPerDu: number;
  /** 整条线最大长度（不含等于）. */
  maxLengthDu: number;
  moveSpeedDuPerS: number | null;
  prereq: LiaisonKind | null;
}

/** Higher = better tier. 铁路 > 公路 > 线缆. */
export const LIAISON_RANK: Record<LiaisonKind, number> = {
  fiber: 1,
  road: 2,
  railway: 3,
};

export const LIAISON_BY_ID: Record<LiaisonKind, LiaisonLineDef> = {
  fiber: {
    id: "fiber",
    name: "线缆",
    costPerDu: 0.5,
    maxLengthDu: 10,
    moveSpeedDuPerS: null,
    prereq: null,
  },
  road: {
    id: "road",
    name: "公路",
    costPerDu: 1,
    maxLengthDu: 20,
    moveSpeedDuPerS: 0.8,
    prereq: "fiber",
  },
  railway: {
    id: "railway",
    name: "铁路",
    costPerDu: 3,
    maxLengthDu: 30,
    moveSpeedDuPerS: 2,
    prereq: "fiber",
  },
};

export const LIAISON_LINES: readonly LiaisonLineDef[] = [
  LIAISON_BY_ID.fiber,
  LIAISON_BY_ID.road,
  LIAISON_BY_ID.railway,
];

/** 铁路起终点建筑 ID（规则 §7.4 车站）. */
export const RAILWAY_STATION_BUILDING_ID = "railway_station";

export interface PlacedLiaison {
  id: string;
  kind: LiaisonKind;
  ownerId: string;
  /** Integer grid nodes along the polyline (≥ 2). */
  nodes: GridNode[];
  investedE: number;
  buildTicksRemaining: number;
  buildTicksTotal: number;
  /** Present on viewer-filtered snapshots. */
  visionLevel?: "satellite" | "direct";
}

const BUILD_E_PER_LEVEL = 10;
/**
 * Distance score multiplier for diagonal candidates.
 * Lower = stronger slant preference when scoring 8-neighbors.
 */
const DIAGONAL_SCORE_FACTOR = 0.42;
/** Extra ortho penalty when cursor is clearly off both axes. */
const ORTHO_OFF_AXIS_PENALTY = 1.85;
/** Overlap demolish refund rate (same spirit as building §⑦ 80%). */
export const LIAISON_OVERLAP_REFUND_RATE = 0.8;

export function nodeKey(n: GridNode): string {
  return `${n.gx},${n.gy}`;
}

export function sameNode(a: GridNode, b: GridNode): boolean {
  return a.gx === b.gx && a.gy === b.gy;
}

/** Edge or diagonal of one cell (8-adjacent, not self). */
export function isAdjacentGridNode(a: GridNode, b: GridNode): boolean {
  const dx = Math.abs(a.gx - b.gx);
  const dy = Math.abs(a.gy - b.gy);
  return dx <= 1 && dy <= 1 && (dx > 0 || dy > 0);
}

/** Orthogonal = 1, diagonal = √2. */
export function segmentLengthDu(a: GridNode, b: GridNode): number {
  const dx = Math.abs(a.gx - b.gx);
  const dy = Math.abs(a.gy - b.gy);
  if (dx === 0 && dy === 0) return 0;
  if (dx + dy === 1) return 1;
  if (dx === 1 && dy === 1) return Math.SQRT2;
  return Math.hypot(dx, dy);
}

export function pathLengthDu(nodes: readonly GridNode[]): number {
  let len = 0;
  for (let i = 1; i < nodes.length; i++) {
    len += segmentLengthDu(nodes[i - 1], nodes[i]);
  }
  return len;
}

/** Undirected segment key for overlap checks. */
export function segmentKey(a: GridNode, b: GridNode): string {
  if (a.gx < b.gx || (a.gx === b.gx && a.gy <= b.gy)) {
    return `${a.gx},${a.gy}-${b.gx},${b.gy}`;
  }
  return `${b.gx},${b.gy}-${a.gx},${a.gy}`;
}

export function pathSegmentKeys(nodes: readonly GridNode[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 1; i < nodes.length; i++) {
    keys.add(segmentKey(nodes[i - 1], nodes[i]));
  }
  return keys;
}

export function pathsShareSegment(
  a: readonly GridNode[],
  b: readonly GridNode[],
): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const keys = pathSegmentKeys(a);
  for (let i = 1; i < b.length; i++) {
    if (keys.has(segmentKey(b[i - 1], b[i]))) return true;
  }
  return false;
}

/** Length of segments whose keys are in `keys`. */
export function lengthOfSegments(
  nodes: readonly GridNode[],
  keys: ReadonlySet<string>,
): number {
  let len = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (keys.has(segmentKey(nodes[i - 1], nodes[i]))) {
      len += segmentLengthDu(nodes[i - 1], nodes[i]);
    }
  }
  return len;
}

/**
 * Drop segments whose keys are in `removeKeys`, splitting into contiguous polylines.
 * Also used to strip self-duplicates / non-billable overlaps from a new stroke.
 */
export function splitPathRemovingSegments(
  nodes: readonly GridNode[],
  removeKeys: ReadonlySet<string>,
): GridNode[][] {
  if (nodes.length < 2) return [];
  const fragments: GridNode[][] = [];
  let current: GridNode[] = [{ ...nodes[0] }];

  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const key = segmentKey(a, b);
    if (removeKeys.has(key)) {
      if (current.length >= 2) fragments.push(current);
      current = [{ ...b }];
      continue;
    }
    const last = current[current.length - 1];
    if (!sameNode(last, a)) {
      // Gap after a removal already started a new chain at b; attach if adjacent
      if (current.length >= 2) fragments.push(current);
      current = [{ ...a }, { ...b }];
    } else {
      current.push({ ...b });
    }
  }
  if (current.length >= 2) fragments.push(current);
  return fragments;
}

/**
 * First-occurrence segment walk: skip any segment already seen in this stroke
 * (self-overlap). Returns contiguous fragments ready to place.
 */
export function dedupeSelfOverlappingPath(nodes: readonly GridNode[]): GridNode[][] {
  if (nodes.length < 2) return [];
  const seen = new Set<string>();
  const remove = new Set<string>();
  for (let i = 1; i < nodes.length; i++) {
    const key = segmentKey(nodes[i - 1], nodes[i]);
    if (seen.has(key)) remove.add(key);
    else seen.add(key);
  }
  if (remove.size === 0) return [nodes.map((n) => ({ ...n }))];
  // Keep first occurrence: remove only later duplicates by splitting on duplicate keys
  // while preserving the first pass. Rebuild from ordered unique segments.
  const segs: Array<[GridNode, GridNode]> = [];
  const used = new Set<string>();
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const key = segmentKey(a, b);
    if (used.has(key)) continue;
    used.add(key);
    segs.push([{ ...a }, { ...b }]);
  }
  return stitchSegments(segs);
}

/** Stitch ordered undirected segments into contiguous polylines. */
export function stitchSegments(
  segs: ReadonlyArray<readonly [GridNode, GridNode]>,
): GridNode[][] {
  if (segs.length === 0) return [];
  const fragments: GridNode[][] = [];
  let current: GridNode[] = [{ ...segs[0][0] }, { ...segs[0][1] }];

  for (let i = 1; i < segs.length; i++) {
    const [a, b] = segs[i];
    const last = current[current.length - 1];
    if (sameNode(last, a) && isAdjacentGridNode(a, b)) {
      current.push({ ...b });
    } else if (sameNode(last, b) && isAdjacentGridNode(b, a)) {
      current.push({ ...a });
    } else {
      if (current.length >= 2) fragments.push(current);
      current = [{ ...a }, { ...b }];
    }
  }
  if (current.length >= 2) fragments.push(current);
  return fragments;
}

/** Lines that share at least one edge/diagonal segment with `nodes`. */
export function findOverlappingLiaisons(
  existing: readonly PlacedLiaison[],
  nodes: readonly GridNode[],
): PlacedLiaison[] {
  return existing.filter((line) => pathsShareSegment(line.nodes, nodes));
}

export function demolishLiaisonRefundE(investedE: number): number {
  return Math.floor(investedE * LIAISON_OVERLAP_REFUND_RATE);
}

/** Distance from point to segment AB in Du. */
export function distancePointToSegment(
  px: number,
  py: number,
  a: GridNode,
  b: GridNode,
): number {
  const abx = b.gx - a.gx;
  const aby = b.gy - a.gy;
  const apx = px - a.gx;
  const apy = py - a.gy;
  const ab2 = abx * abx + aby * aby;
  if (ab2 <= 1e-12) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.gx + t * abx), py - (a.gy + t * aby));
}

/** Nearest liaison polyline within `radius` Du of (gx, gy). */
/** Own > ally > enemy; used when several lines share the same edge distance. */
function liaisonPickPriority(
  ownerId: string,
  viewerId: string | null | undefined,
  teams?: TeamRoster | null,
): number {
  if (viewerId == null) return 0;
  if (ownerId === viewerId) return 2;
  if (isFriendly(teams, ownerId, viewerId)) return 1;
  return 0;
}

export function findLiaisonNear(
  lines: readonly PlacedLiaison[],
  gx: number,
  gy: number,
  radius = 0.35,
  viewerId?: string | null,
  teams?: TeamRoster | null,
): PlacedLiaison | undefined {
  let best: PlacedLiaison | undefined;
  let bestD = radius;
  let bestPri = -1;
  for (const line of lines) {
    const pri = liaisonPickPriority(line.ownerId, viewerId, teams);
    for (let i = 1; i < line.nodes.length; i++) {
      const d = distancePointToSegment(gx, gy, line.nodes[i - 1], line.nodes[i]);
      if (d < bestD - 1e-9 || (d <= bestD + 1e-9 && pri > bestPri)) {
        bestD = d;
        best = line;
        bestPri = pri;
      }
    }
  }
  return best;
}

/** Nearest single edge of a liaison within `radius` Du of (gx, gy). */
export function findLiaisonSegmentNear(
  lines: readonly PlacedLiaison[],
  gx: number,
  gy: number,
  radius = 0.35,
  viewerId?: string | null,
  teams?: TeamRoster | null,
): { line: PlacedLiaison; segmentIndex: number; dist: number } | undefined {
  let best: { line: PlacedLiaison; segmentIndex: number; dist: number } | undefined;
  let bestD = radius;
  let bestPri = -1;
  for (const line of lines) {
    const pri = liaisonPickPriority(line.ownerId, viewerId, teams);
    for (let i = 1; i < line.nodes.length; i++) {
      const d = distancePointToSegment(gx, gy, line.nodes[i - 1]!, line.nodes[i]!);
      if (d < bestD - 1e-9 || (d <= bestD + 1e-9 && pri > bestPri)) {
        bestD = d;
        best = { line, segmentIndex: i - 1, dist: d };
        bestPri = pri;
      }
    }
  }
  return best;
}

/** Proportional 80% refund for removed length share of a line. */
export function demolishLiaisonSegmentRefundE(
  investedE: number,
  removedLengthDu: number,
  totalLengthDu: number,
): number {
  if (investedE <= 0 || totalLengthDu <= 0 || removedLengthDu <= 0) return 0;
  const share = Math.min(1, removedLengthDu / totalLengthDu);
  return Math.floor(investedE * share * LIAISON_OVERLAP_REFUND_RATE);
}

export function snapToIntegerNode(
  gx: number,
  gy: number,
  map: { linesX: number; linesY: number },
): GridNode {
  return {
    gx: Math.min(map.linesX - 1, Math.max(0, Math.round(gx))),
    gy: Math.min(map.linesY - 1, Math.max(0, Math.round(gy))),
  };
}

export interface LiaisonCostPreview {
  energy: number;
  lengthDu: number;
  durationSec: number;
  durationTicks: number;
  /** Extra E from mountain/ocean (road/railway only). */
  terrainSurchargeE?: number;
}

function liaisonDurationFromEnergy(energy: number): {
  durationSec: number;
  durationTicks: number;
} {
  const durationSec = energy / 10;
  const durationTicks = durationSec < 1 ? 0 : durationSecToTicks(durationSec);
  return { durationSec, durationTicks };
}

/** E = ⌊长度⌋ × costPerDu × 10；耗时 E/10，&lt;1s 立即完成. */
export function previewLiaisonCost(
  kind: LiaisonKind,
  nodes: readonly GridNode[],
): LiaisonCostPreview {
  const def = LIAISON_BY_ID[kind];
  const lengthDu = pathLengthDu(nodes);
  const energy = Math.floor(lengthDu) * def.costPerDu * BUILD_E_PER_LEVEL;
  const { durationSec, durationTicks } = liaisonDurationFromEnergy(energy);
  return { energy, lengthDu, durationSec, durationTicks };
}

export function previewLiaisonCostForLength(
  kind: LiaisonKind,
  lengthDu: number,
): LiaisonCostPreview {
  const def = LIAISON_BY_ID[kind];
  const energy = Math.floor(lengthDu) * def.costPerDu * BUILD_E_PER_LEVEL;
  const { durationSec, durationTicks } = liaisonDurationFromEnergy(energy);
  return { energy, lengthDu, durationSec, durationTicks };
}

/** Add mountain/ocean surcharge into energy and rebuild duration. */
export function withLiaisonTerrainSurcharge(
  base: LiaisonCostPreview,
  terrainSurchargeE: number,
): LiaisonCostPreview {
  const surcharge = Math.max(0, Math.floor(terrainSurchargeE));
  if (surcharge === 0) return { ...base, terrainSurchargeE: 0 };
  const energy = base.energy + surcharge;
  const { durationSec, durationTicks } = liaisonDurationFromEnergy(energy);
  return {
    ...base,
    energy,
    durationSec,
    durationTicks,
    terrainSurchargeE: surcharge,
  };
}

function inMapBounds(
  n: GridNode,
  map: { linesX: number; linesY: number },
): boolean {
  return n.gx >= 0 && n.gy >= 0 && n.gx < map.linesX && n.gy < map.linesY;
}

/**
 * Pick next integer node from `last` toward fractional cursor.
 * Strongly prefers diagonal steps when the cursor is off-axis.
 * `blunt` (0–1) raises cost of sharp / right-angle turns relative to `prev`.
 */
export function pickNextLiaisonStep(
  last: GridNode,
  cursorGx: number,
  cursorGy: number,
  map: { linesX: number; linesY: number },
  opts?: { prev?: GridNode | null; blunt?: number },
): GridNode | null {
  const curDist = Math.hypot(cursorGx - last.gx, cursorGy - last.gy);
  if (curDist < 0.28) return null;

  const ax = Math.abs(cursorGx - last.gx);
  const ay = Math.abs(cursorGy - last.gy);
  const offAxis = ax > 0.18 && ay > 0.18;
  const blunt = Math.max(0, Math.min(1, opts?.blunt ?? 0));
  const prev = opts?.prev ?? null;

  let best: GridNode | null = null;
  let bestScore = Infinity;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const next = { gx: last.gx + dx, gy: last.gy + dy };
      if (!inMapBounds(next, map)) continue;
      const dist = Math.hypot(cursorGx - next.gx, cursorGy - next.gy);
      if (dist >= curDist - 1e-9) continue;
      const diagonal = dx !== 0 && dy !== 0;
      let score = dist;
      if (diagonal) score *= DIAGONAL_SCORE_FACTOR;
      else if (offAxis) score *= ORTHO_OFF_AXIS_PENALTY;
      if (
        diagonal &&
        Math.sign(dx) === Math.sign(cursorGx - last.gx) &&
        Math.sign(dy) === Math.sign(cursorGy - last.gy)
      ) {
        score *= 0.85;
      }

      if (blunt > 0 && prev) {
        const ix = last.gx - prev.gx;
        const iy = last.gy - prev.gy;
        const ox = dx;
        const oy = dy;
        const dot = ix * ox + iy * oy;
        const cross = Math.abs(ix * oy - iy * ox);
        if (dot < 0) score *= 1 + 4 * blunt;
        else if (dot === 0 && cross > 0) score *= 1 + 3.2 * blunt;
        else if (ox === ix && oy === iy) score *= 1 - 0.35 * blunt;
        if (blunt > 0.35 && !diagonal) score *= 1 + 1.2 * blunt;
      }

      if (score < bestScore) {
        bestScore = score;
        best = next;
      }
    }
  }
  return best;
}

/**
 * Cut corners: if A–B–C has a sharp/right turn and A is adjacent to C,
 * drop B (replace two legs with one diagonal/edge).
 */
export function bluntLiaisonPath(
  nodes: readonly GridNode[],
  strength = 1,
): GridNode[] {
  if (nodes.length < 3 || strength <= 0) return nodes.map((n) => ({ ...n }));
  const out = nodes.map((n) => ({ ...n }));
  const maxPasses = Math.max(1, Math.ceil(2 + strength * 4));
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (let i = 1; i < out.length - 1; ) {
      const a = out[i - 1];
      const b = out[i];
      const c = out[i + 1];
      const ix = b.gx - a.gx;
      const iy = b.gy - a.gy;
      const ox = c.gx - b.gx;
      const oy = c.gy - b.gy;
      const dot = ix * ox + iy * oy;
      const cross = Math.abs(ix * oy - iy * ox);
      const isRight = dot === 0 && cross > 0;
      const isSharp = dot < 0;
      const mild = strength > 0.55 && dot > 0 && cross > 0;
      if ((isRight || isSharp || mild) && isAdjacentGridNode(a, c)) {
        out.splice(i, 1);
        changed = true;
        continue;
      }
      i += 1;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Extend path toward fractional cursor by edge/diagonal steps.
 * Prefers diagonal steps; moving back toward the previous node pops.
 * `blunt` (0–1) from pointer speed reduces sharp / right-angle turns.
 */
export function extendLiaisonPath(
  path: GridNode[],
  cursor: { gx: number; gy: number },
  maxLengthDu: number,
  map: { linesX: number; linesY: number },
  blunt = 0,
): GridNode[] {
  if (path.length === 0) {
    return [snapToIntegerNode(cursor.gx, cursor.gy, map)];
  }
  const out = path.map((n) => ({ ...n }));
  let guard = 0;
  while (guard++ < 10_000) {
    const last = out[out.length - 1];

    if (out.length >= 2) {
      const prev = out[out.length - 2];
      const dLast = Math.hypot(cursor.gx - last.gx, cursor.gy - last.gy);
      const dPrev = Math.hypot(cursor.gx - prev.gx, cursor.gy - prev.gy);
      if (dPrev + 0.15 < dLast) {
        out.pop();
        continue;
      }
    }

    const prev = out.length >= 2 ? out[out.length - 2] : null;
    const next = pickNextLiaisonStep(last, cursor.gx, cursor.gy, map, {
      prev,
      blunt,
    });
    if (!next) break;
    if (out.length >= 2 && sameNode(next, out[out.length - 2])) {
      out.pop();
      continue;
    }

    const trial = [...out, next];
    if (pathLengthDu(trial) >= maxLengthDu) break;
    out.push(next);

    if (blunt > 0.25 && out.length >= 3) {
      const cut = bluntLiaisonPath(out, blunt * 0.85);
      if (cut.length < out.length && pathLengthDu(cut) < maxLengthDu) {
        out.length = 0;
        out.push(...cut);
      }
    }
  }
  return out;
}

export function isValidLiaisonPath(
  kind: LiaisonKind,
  nodes: readonly GridNode[],
): boolean {
  if (nodes.length < 2) return false;
  const def = LIAISON_BY_ID[kind];
  for (let i = 1; i < nodes.length; i++) {
    if (!isAdjacentGridNode(nodes[i - 1], nodes[i])) return false;
  }
  return pathLengthDu(nodes) < def.maxLengthDu;
}

export interface StationLikeBuilding {
  id?: string;
  buildingId: string;
  ownerId: string;
  gx: number;
  gy: number;
  buildTicksRemaining?: number;
}

const RAILWAY_STATION_SNAP_DU = 0.55;

function stationNodeDist(b: StationLikeBuilding, node: GridNode): number {
  return Math.hypot(b.gx - node.gx, b.gy - node.gy);
}

/** Nearest owned station within snap range. Planned stations included unless `completedOnly`. */
export function findOwnedRailwayStationNear(
  buildings: readonly StationLikeBuilding[],
  ownerId: string,
  node: GridNode,
  opts?: { completedOnly?: boolean; maxDistDu?: number },
): StationLikeBuilding | undefined {
  const maxDist = opts?.maxDistDu ?? RAILWAY_STATION_SNAP_DU;
  let best: StationLikeBuilding | undefined;
  let bestD = maxDist;
  for (const b of buildings) {
    if (b.ownerId !== ownerId) continue;
    // 建造中的车站 buildingId 已是 railway_station，不能用完工条件排除。
    if (b.buildingId !== RAILWAY_STATION_BUILDING_ID) continue;
    if (opts?.completedOnly && (b.buildTicksRemaining ?? 0) > 0) continue;
    const d = stationNodeDist(b, node);
    if (d <= bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Owned railway station on `node`, including one still under construction (规划中). */
export function hasOwnedRailwayStationAt(
  buildings: readonly StationLikeBuilding[],
  ownerId: string,
  node: GridNode,
): boolean {
  return findOwnedRailwayStationNear(buildings, ownerId, node, { maxDistDu: 0 }) != null;
}

function isCommsLinked(
  station: StationLikeBuilding,
  connectedIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (station.id == null) return false;
  const linked = connectedIds instanceof Set ? connectedIds : new Set(connectedIds);
  return linked.has(station.id);
}

/** Completed owned station that is already on the capital comms link. */
export function hasRailwayOriginStationAt(
  buildings: readonly StationLikeBuilding[],
  ownerId: string,
  node: GridNode,
  connectedIds: ReadonlySet<string> | readonly string[],
): boolean {
  const station = findOwnedRailwayStationNear(buildings, ownerId, node, {
    completedOnly: true,
  });
  return station != null && isCommsLinked(station, connectedIds);
}

/**
 * Snap railway ends onto stations before validation.
 * Destination first (planned allowed), then origin (completed + comms only).
 * If `cursor` sits on a station and the path is adjacent, the end is extended onto it.
 */
export function anchorRailwayEndpoints(
  nodes: readonly GridNode[],
  buildings: readonly StationLikeBuilding[],
  ownerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  cursor?: GridNode,
): GridNode[] {
  if (nodes.length === 0) return [];
  const out = nodes.map((n) => ({ ...n }));

  const end = out[out.length - 1]!;
  let endStation = findOwnedRailwayStationNear(buildings, ownerId, end);
  if (!endStation && cursor) {
    const underCursor = findOwnedRailwayStationNear(buildings, ownerId, cursor);
    if (
      underCursor &&
      isAdjacentGridNode(end, { gx: underCursor.gx, gy: underCursor.gy })
    ) {
      endStation = underCursor;
      out.push({ gx: underCursor.gx, gy: underCursor.gy });
    }
  }
  if (endStation && out.length > 0) {
    const last = out[out.length - 1]!;
    last.gx = endStation.gx;
    last.gy = endStation.gy;
  }

  if (out.length >= 2) {
    const start = out[0]!;
    const startStation = findOwnedRailwayStationNear(buildings, ownerId, start, {
      completedOnly: true,
    });
    if (startStation && isCommsLinked(startStation, connectedIds)) {
      start.gx = startStation.gx;
      start.gy = startStation.gy;
    }
  }

  const deduped: GridNode[] = [];
  for (const n of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.gx === n.gx && prev.gy === n.gy) continue;
    deduped.push(n);
  }
  return deduped;
}

/**
 * Railways start at a completed, comms-linked station and may end at a planned station.
 * Destination is resolved before the origin's complete/comms checks, so a planned
 * end station is not rejected by the start rule.
 */
export function railwayEndpointRejectReason(
  kind: LiaisonKind,
  nodes: readonly GridNode[],
  buildings: readonly StationLikeBuilding[],
  ownerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
): string | null {
  if (kind !== "railway") return null;
  if (nodes.length < 2) return "请拖出至少一段铁路";
  const start = nodes[0]!;
  const end = nodes[nodes.length - 1]!;
  if (sameNode(start, end)) return "铁路起终点须为两座不同的车站";

  const endStation = findOwnedRailwayStationNear(buildings, ownerId, end);
  if (!endStation) return "铁路终点必须是车站，建造中的车站也算";

  const startStation = findOwnedRailwayStationNear(buildings, ownerId, start, {
    maxDistDu: 0,
  });
  if (!startStation || (startStation.buildTicksRemaining ?? 0) > 0) {
    return "铁路只能从已建成的车站开始绘制";
  }
  if (!isCommsLinked(startStation, connectedIds)) {
    return "铁路只能从已接入通信的车站开始绘制";
  }
  return null;
}

export interface LiaisonOverlapResolution {
  /** Fragments to place for the new stroke (self-overlap & same/higher stripped). */
  placeFragments: GridNode[][];
  /** Total billable length of placeFragments. */
  billableLengthDu: number;
  /** Old lines to remove entirely (fully consumed). */
  removeIds: string[];
  /** Replacement fragments for partially trimmed old lines. */
  replace: Array<{ id: string; fragments: GridNode[][]; investedEEach: number[] }>;
  /** Total E refunded from trimmed/removed old segments. */
  refundE: number;
  /** Reserved for future validation failures. */
  error?: { code: string; message: string };
}

/**
 * Resolve a new stroke against existing lines:
 * - Self-overlapping segments in the stroke are dropped (not drawn / not billed).
 * - Overlap with own equal-or-higher line: drop those segments from the new stroke.
 * - Overlap with own lower-tier line: remove only overlapping segments from the old line
 *   (split remainder), refund 80% of the removed share of invested E.
 * - Overlap with another owner's line: allowed (multiple owners may share the same edge).
 */
export function resolveLiaisonBuildOverlap(
  kind: LiaisonKind,
  rawNodes: readonly GridNode[],
  existing: readonly PlacedLiaison[],
  ownerId: string,
): LiaisonOverlapResolution {
  const empty: LiaisonOverlapResolution = {
    placeFragments: [],
    billableLengthDu: 0,
    removeIds: [],
    replace: [],
    refundE: 0,
  };

  // 1) Drop self-overlapping segments (first occurrence kept)
  const dedupedFrags = dedupeSelfOverlappingPath(rawNodes);
  if (dedupedFrags.length === 0) return empty;

  // Merge into one walk for overlap analysis (keys only), then re-fragment at end
  const strokeKeys = new Set<string>();
  for (const frag of dedupedFrags) {
    for (const k of pathSegmentKeys(frag)) strokeKeys.add(k);
  }

  const stripFromNew = new Set<string>();
  const removeIds: string[] = [];
  const replace: LiaisonOverlapResolution["replace"] = [];
  let refundE = 0;

  for (const old of existing) {
    // Other owners may share the same grid edge; only own lines upgrade/strip.
    if (old.ownerId !== ownerId) continue;

    const oldKeys = pathSegmentKeys(old.nodes);
    const overlap = new Set<string>();
    for (const k of strokeKeys) {
      if (oldKeys.has(k)) overlap.add(k);
    }
    if (overlap.size === 0) continue;

    if (LIAISON_RANK[kind] <= LIAISON_RANK[old.kind]) {
      // Equal or lower than existing → don't redraw / don't charge those segments
      for (const k of overlap) stripFromNew.add(k);
      continue;
    }

    // New is strictly higher → trim only overlapping segments from the old line
    const totalLen = pathLengthDu(old.nodes);
    const removedLen = lengthOfSegments(old.nodes, overlap);
    refundE += demolishLiaisonSegmentRefundE(old.investedE, removedLen, totalLen);

    const remain = splitPathRemovingSegments(old.nodes, overlap);
    if (remain.length === 0) {
      removeIds.push(old.id);
    } else {
      const remainLen = remain.reduce((s, f) => s + pathLengthDu(f), 0);
      const keepE = Math.max(0, old.investedE - Math.floor(old.investedE * (removedLen / Math.max(totalLen, 1e-9))));
      // Distribute remaining invested E by fragment length
      const investedEEach = remain.map((f) => {
        if (remainLen <= 0) return 0;
        return Math.floor(keepE * (pathLengthDu(f) / remainLen));
      });
      replace.push({ id: old.id, fragments: remain, investedEEach });
    }
  }

  // 2) Strip non-billable segments from deduped stroke
  const placeFragments: GridNode[][] = [];
  for (const frag of dedupedFrags) {
    if (stripFromNew.size === 0) {
      placeFragments.push(frag);
      continue;
    }
    placeFragments.push(...splitPathRemovingSegments(frag, stripFromNew));
  }

  const billableLengthDu = placeFragments.reduce((s, f) => s + pathLengthDu(f), 0);

  return {
    placeFragments,
    billableLengthDu,
    removeIds,
    replace,
    refundE,
  };
}
