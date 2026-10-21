/**
 * Vision rules §4.5: satellite (map-wide) + direct (per building / unit R).
 * Building/liaison satellite visibility also follows §建造 tables.
 */

import {
  BUILDING_BY_ID,
  type BuildingSize,
} from "../buildings/catalog.js";
import {
  isBuildingComplete,
  type PlacedBuilding,
} from "../buildings/actions.js";
import {
  nodeKey,
  type LiaisonKind,
  type PlacedLiaison,
} from "../buildings/liaison.js";
import { isFriendly, type TeamRoster } from "../teams.js";

/** Direct vision radius by building size (Du). */
export const DIRECT_VISION_R_BY_SIZE: Record<BuildingSize, number> = {
  small: 3,
  medium: 5,
  large: 8,
};

/** Radar overrides size-based R (§4.5.2). */
export const DIRECT_VISION_R_RADAR = 4;
/** Capital overrides size-based R (§4.5.2). */
export const DIRECT_VISION_R_CAPITAL = 10;

/** Unit direct vision radii (§4.5.2). */
export const DIRECT_VISION_R_INFANTRY = 2;
export const DIRECT_VISION_R_ARMOR_NAVY = 4;
/** Air: only sees other air units and flying missiles. */
export const DIRECT_VISION_R_AIR = 8;

export type VisionLevel = "none" | "satellite" | "direct";

export interface VisionSource {
  gx: number;
  gy: number;
  radiusDu: number;
  /**
   * Air-unit vision: reveals other air (and flying missiles when they exist),
   * but not buildings or land/navy units.
   */
  airOnly?: boolean;
}

/** Euclidean Du distance between grid nodes. */
export function visionDistDu(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  return Math.hypot(ax - bx, ay - by);
}

export function directVisionRadiusForBuilding(buildingId: string): number {
  if (buildingId === "capital") return DIRECT_VISION_R_CAPITAL;
  if (buildingId === "radar") return DIRECT_VISION_R_RADAR;
  const size = BUILDING_BY_ID[buildingId]?.size;
  if (size) return DIRECT_VISION_R_BY_SIZE[size];
  return DIRECT_VISION_R_BY_SIZE.small;
}

/** Completed, comms-linked friendly buildings that emit direct vision. */
export function collectDirectVisionSources(
  buildings: readonly PlacedBuilding[],
  viewerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): VisionSource[] {
  const linked = connectedIds instanceof Set ? connectedIds : new Set(connectedIds);
  const out: VisionSource[] = [];
  for (const b of buildings) {
    if (!isFriendly(teams, b.ownerId, viewerId)) continue;
    if (!linked.has(b.id)) continue;
    if (b.polluted) continue;
    if (b.buildingId !== "capital" && !isBuildingComplete(b)) continue;
    out.push({
      gx: b.gx,
      gy: b.gy,
      radiusDu: directVisionRadiusForBuilding(b.buildingId),
    });
  }
  return out;
}

/**
 * Friendly fielded units that emit direct vision (§4.5.2).
 * Air sources are `airOnly` (see other air / flying missiles only).
 */
export function collectUnitVisionSources(
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[],
  viewerId: string,
  teams?: TeamRoster | null,
): VisionSource[] {
  const out: VisionSource[] = [];
  for (const u of units) {
    if (!isFriendly(teams, u.ownerId, viewerId)) continue;
    let radiusDu: number;
    let airOnly = false;
    if (u.kind === "infantry") radiusDu = DIRECT_VISION_R_INFANTRY;
    else if (u.kind === "air") {
      radiusDu = DIRECT_VISION_R_AIR;
      airOnly = true;
    } else {
      // armor / navy / navy_carrier
      radiusDu = DIRECT_VISION_R_ARMOR_NAVY;
    }
    out.push({ gx: u.gx, gy: u.gy, radiusDu, airOnly: airOnly || undefined });
  }
  return out;
}

export function collectAllDirectVisionSources(
  buildings: readonly PlacedBuilding[],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[],
  viewerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): VisionSource[] {
  return [
    ...collectDirectVisionSources(buildings, viewerId, connectedIds, teams),
    ...collectUnitVisionSources(units, viewerId, teams),
  ];
}

/**
 * Point covered by a non-airOnly source (buildings / land-navy vision).
 * Air-only circles do not reveal buildings or ground units.
 */
export function isInDirectVision(
  gx: number,
  gy: number,
  sources: readonly VisionSource[],
): boolean {
  for (const s of sources) {
    if (s.airOnly) continue;
    if (visionDistDu(gx, gy, s.gx, s.gy) <= s.radiusDu + 1e-9) return true;
  }
  return false;
}

/**
 * Unit visibility under combined building + unit vision.
 * - Covered by any general source → visible (any kind).
 * - Covered only by airOnly sources → visible iff target is air
 *   (TODO: also flying missiles when those entities exist).
 */
export function unitInDirectVision(
  unit: { gx: number; gy: number; kind: string },
  sources: readonly VisionSource[],
): boolean {
  let byGeneral = false;
  let byAir = false;
  for (const s of sources) {
    if (visionDistDu(unit.gx, unit.gy, s.gx, s.gy) > s.radiusDu + 1e-9) continue;
    if (s.airOnly) byAir = true;
    else byGeneral = true;
  }
  if (byGeneral) return true;
  if (byAir && unit.kind === "air") return true;
  return false;
}

/**
 * Satellite visibility for enemy buildings (§建造).
 * Uses facade id when upgrading small/medium (satellite shows pre-upgrade).
 */
export function satelliteSeesBuilding(b: PlacedBuilding): boolean {
  const facadeId = b.satelliteBuildingId ?? b.buildingId;
  const def = BUILDING_BY_ID[facadeId];
  const size = def?.size ?? "small";
  if (size === "small") return false;
  if (size === "large") return true;
  // medium: visible only after complete (facade complete ⇒ no build ticks on facade;
  // during upgrade we keep old facade id which was complete).
  if (b.satelliteBuildingId) return true;
  return isBuildingComplete(b);
}

/** Satellite visibility for enemy liaisons (§建造). */
export function satelliteSeesLiaison(line: PlacedLiaison): boolean {
  if (line.kind === "fiber") return false;
  if (line.kind === "railway") return true;
  // road: after complete
  return line.buildTicksRemaining <= 0;
}

export function buildingVisionLevel(
  b: PlacedBuilding,
  viewerId: string,
  sources: readonly VisionSource[],
  teams?: TeamRoster | null,
): VisionLevel {
  if (isFriendly(teams, b.ownerId, viewerId)) return "direct";
  if (isInDirectVision(b.gx, b.gy, sources)) return "direct";
  if (satelliteSeesBuilding(b)) return "satellite";
  return "none";
}

/** Any node of the polyline in direct vision counts. */
export function liaisonVisionLevel(
  line: PlacedLiaison,
  viewerId: string,
  sources: readonly VisionSource[],
  teams?: TeamRoster | null,
): VisionLevel {
  if (isFriendly(teams, line.ownerId, viewerId)) return "direct";
  for (const n of line.nodes) {
    if (isInDirectVision(n.gx, n.gy, sources)) return "direct";
  }
  if (satelliteSeesLiaison(line)) return "satellite";
  return "none";
}

/**
 * Snapshot strip for a viewer.
 * - Own: full copy (+ buildPaused when construction cannot advance)
 * - Enemy direct: type + hp; strip repair/invested detail noise
 * - Enemy satellite: facade type, no hp / build progress
 */
export function filterBuildingForViewer(
  b: PlacedBuilding,
  viewerId: string,
  sources: readonly VisionSource[],
  liaisons: readonly PlacedLiaison[] = [],
  allBuildings: readonly PlacedBuilding[] = [],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[] = [],
  teams?: TeamRoster | null,
): PlacedBuilding | null {
  const level = buildingVisionLevel(b, viewerId, sources, teams);
  if (level === "none") return null;

  if (isFriendly(teams, b.ownerId, viewerId)) {
    const copy: PlacedBuilding = { ...b };
    if (b.buildTicksRemaining > 0) {
      copy.buildPaused =
        !!b.constructionHalted ||
        !isConstructionAllowedAt(
          b.gx,
          b.gy,
          allBuildings.length > 0 ? allBuildings : [b],
          liaisons,
          viewerId,
          connectedIds,
          units,
          teams,
        );
    }
    return copy;
  }

  if (level === "direct") {
    return {
      id: b.id,
      buildingId: b.buildingId,
      ownerId: b.ownerId,
      gx: b.gx,
      gy: b.gy,
      hp: b.hp,
      hpMax: b.hpMax,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: b.buildTicksRemaining > 0 ? b.buildTicksRemaining : 0,
      buildTicksTotal: b.buildTicksTotal,
      visionLevel: "direct",
    };
  }

  // satellite: no HP / construction progress; show facade during small/medium upgrade
  const facadeId = b.satelliteBuildingId ?? b.buildingId;
  return {
    id: b.id,
    buildingId: facadeId,
    ownerId: b.ownerId,
    gx: b.gx,
    gy: b.gy,
    hp: 0,
    hpMax: 0,
    u: 0,
    storeE: 0,
    ammo: 0,
    investedE: 0,
    buildTicksRemaining: 0,
    buildTicksTotal: 0,
    visionLevel: "satellite",
  };
}

/**
 * Enemy-facing build ticks: keep only "under construction" (`1/1`) vs complete
 * (`0/0`). Constant while building, so enemy lines produce no per-tick delta.
 */
export function maskedLiaisonBuildTicks(
  line: PlacedLiaison,
): Pick<PlacedLiaison, "buildTicksRemaining" | "buildTicksTotal"> {
  const building = line.buildTicksRemaining > 0;
  return {
    buildTicksRemaining: building ? 1 : 0,
    buildTicksTotal: building ? 1 : 0,
  };
}

export function filterLiaisonForViewer(
  line: PlacedLiaison,
  viewerId: string,
  sources: readonly VisionSource[],
  teams?: TeamRoster | null,
): PlacedLiaison | null {
  const level = liaisonVisionLevel(line, viewerId, sources, teams);
  if (level === "none") return null;

  if (isFriendly(teams, line.ownerId, viewerId)) {
    return {
      ...line,
      nodes: line.nodes.map((n) => ({ ...n })),
      visionLevel: "direct",
    };
  }

  if (level === "direct") {
    return {
      id: line.id,
      kind: line.kind,
      ownerId: line.ownerId,
      nodes: line.nodes.map((n) => ({ ...n })),
      investedE: 0,
      ...maskedLiaisonBuildTicks(line),
      visionLevel: "direct",
    };
  }

  // satellite: road only seen once complete; railway seen while building (masked).
  return {
    id: line.id,
    kind: line.kind as LiaisonKind,
    ownerId: line.ownerId,
    nodes: line.nodes.map((n) => ({ ...n })),
    investedE: 0,
    ...maskedLiaisonBuildTicks(line),
    visionLevel: "satellite",
  };
}

export function filterBuildingsForViewer(
  buildings: readonly PlacedBuilding[],
  viewerId: string,
  liaisons: readonly PlacedLiaison[] = [],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[] = [],
  teams?: TeamRoster | null,
): PlacedBuilding[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    units,
    viewerId,
    connectedIds,
    teams,
  );
  const out: PlacedBuilding[] = [];
  for (const b of buildings) {
    const filtered = filterBuildingForViewer(
      b,
      viewerId,
      sources,
      liaisons,
      buildings,
      connectedIds,
      units,
      teams,
    );
    if (filtered) out.push(filtered);
  }
  return out;
}

export function filterLiaisonsForViewer(
  liaisons: readonly PlacedLiaison[],
  buildings: readonly PlacedBuilding[],
  viewerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[] = [],
  teams?: TeamRoster | null,
): PlacedLiaison[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    units,
    viewerId,
    connectedIds,
    teams,
  );
  const out: PlacedLiaison[] = [];
  for (const line of liaisons) {
    const filtered = filterLiaisonForViewer(line, viewerId, sources, teams);
    if (filtered) out.push(filtered);
  }
  return out;
}

/** True when upgrade target is small/medium — satellite keeps pre-upgrade facade. */
export function shouldMaskUpgradeOnSatellite(toBuildingId: string): boolean {
  const toSize = BUILDING_BY_ID[toBuildingId]?.size;
  return toSize === "small" || toSize === "medium";
}

/**
 * Undirected graph of nodes on completed owned road / railway lines.
 */
export function buildRoadRailAdjacency(
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
  teams?: TeamRoster | null,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
  };
  for (const line of liaisons) {
    if (!isFriendly(teams, line.ownerId, ownerId)) continue;
    if (line.buildTicksRemaining > 0) continue;
    if (line.kind !== "road" && line.kind !== "railway") continue;
    if (line.nodes.length < 2) continue;
    for (let i = 1; i < line.nodes.length; i++) {
      const a = line.nodes[i - 1]!;
      const b = line.nodes[i]!;
      const ka = nodeKey(a);
      const kb = nodeKey(b);
      link(ka, kb);
      link(kb, ka);
    }
  }
  return adj;
}

/**
 * Construction may run when the site is in direct vision (owned buildings or
 * non-air units), or when it sits on a completed road/railway that reaches a
 * node inside that direct vision.
 */
export function isConstructionAllowedAt(
  gx: number,
  gy: number,
  buildings: readonly PlacedBuilding[],
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[] = [],
  teams?: TeamRoster | null,
): boolean {
  const sources = collectAllDirectVisionSources(
    buildings,
    units,
    ownerId,
    connectedIds,
    teams,
  );
  if (isInDirectVision(gx, gy, sources)) return true;

  const adj = buildRoadRailAdjacency(liaisons, ownerId, teams);
  const site = nodeKey({ gx, gy });
  if (!adj.has(site)) return false;

  const seeds: string[] = [];
  for (const k of adj.keys()) {
    const parts = k.split(",");
    const sx = Number(parts[0]);
    const sy = Number(parts[1]);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    if (isInDirectVision(sx, sy, sources)) seeds.push(k);
  }
  if (seeds.length === 0) return false;

  const seen = new Set<string>(seeds);
  const queue = seeds.slice();
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === site) return true;
    for (const n of adj.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return false;
}

export function constructionRejectReason(
  gx: number,
  gy: number,
  buildings: readonly PlacedBuilding[],
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[] = [],
  teams?: TeamRoster | null,
): string | null {
  if (
    isConstructionAllowedAt(
      gx,
      gy,
      buildings,
      liaisons,
      ownerId,
      connectedIds,
      units,
      teams,
    )
  ) {
    return null;
  }
  return "须在直接视野内，或经公路/铁路连入视野后才能建造";
}

/**
 * Sample point for a resource-sight cell in board Du.
 * Integer cells → cell center (x+0.5, y+0.5); fractional deposit centroids → (x, y) as-is.
 */
export function resourceSightSamplePoint(c: {
  x: number;
  y: number;
}): { gx: number; gy: number } {
  if (Number.isInteger(c.x) && Number.isInteger(c.y)) {
    return { gx: c.x + 0.5, gy: c.y + 0.5 };
  }
  return { gx: c.x, gy: c.y };
}

/**
 * 储量环仅在直接视野内可见（卫星视野 / 迷雾外不显示）。
 * 整数格用中心 (x+0.5, y+0.5)；小数质心直接用 (x, y)。
 */
export function filterResourceSightForViewer(
  cells: readonly import("../terrain/types.js").ResourceSightCell[],
  viewerId: string,
  buildings: readonly PlacedBuilding[],
  units: readonly {
    ownerId: string;
    gx: number;
    gy: number;
    kind: string;
  }[] = [],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): import("../terrain/types.js").ResourceSightCell[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    units,
    viewerId,
    connectedIds,
    teams,
  ).filter((s) => !s.airOnly);
  return cells.filter((c) => {
    const { gx, gy } = resourceSightSamplePoint(c);
    return isInDirectVision(gx, gy, sources);
  });
}

/** Live + save ids for seated downloaders (inherit identity), excluding the holder. */
export function collectRestoreDownloaderOwnerIds(
  liveToSave: ReadonlyMap<string, string> | Iterable<[string, string]>,
  holderPlayerId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const [live, save] of liveToSave) {
    if (live === holderPlayerId) continue;
    ids.add(live);
    ids.add(save);
  }
  return ids;
}

/** Read档大厅 · 持有者对某下载者资产：卫星门面展示建筑（含小型）。 */
export function restoreHolderOverviewBuilding(
  b: PlacedBuilding,
): PlacedBuilding {
  const facadeId = b.satelliteBuildingId ?? b.buildingId;
  return {
    id: b.id,
    buildingId: facadeId,
    ownerId: b.ownerId,
    gx: b.gx,
    gy: b.gy,
    hp: 0,
    hpMax: 0,
    u: 0,
    storeE: 0,
    ammo: 0,
    investedE: 0,
    buildTicksRemaining: 0,
    buildTicksTotal: 0,
    visionLevel: "satellite" as const,
  };
}

/**
 * Read档大厅 · 存档持有者全图预览（§5.3）：卫星门面展示全部建筑（含小型）。
 */
export function restoreHolderOverviewBuildings(
  buildings: readonly PlacedBuilding[],
): PlacedBuilding[] {
  return buildings.map((b) => restoreHolderOverviewBuilding(b));
}

/** Read档大厅 · 持有者对某下载者资产：联络线（含线缆），卫星门面。 */
export function restoreHolderOverviewLiaison(
  line: PlacedLiaison,
): PlacedLiaison {
  return {
    id: line.id,
    kind: line.kind,
    ownerId: line.ownerId,
    nodes: line.nodes.map((n) => ({ ...n })),
    investedE: 0,
    ...(line.kind === "railway"
      ? maskedLiaisonBuildTicks(line)
      : { buildTicksRemaining: 0, buildTicksTotal: 0 }),
    visionLevel: "satellite" as const,
  };
}

/** Read档大厅 · 持有者全图预览：全部联络线（含线缆），卫星门面。 */
export function restoreHolderOverviewLiaisons(
  liaisons: readonly PlacedLiaison[],
): PlacedLiaison[] {
  return liaisons.map((line) => restoreHolderOverviewLiaison(line));
}

/**
 * Read档大厅 · 持有者：仅对已入座下载者全量卫星门面；其余座位仍走普通卫星规则。
 */
export function filterBuildingsForRestoreHolderViewer(
  buildings: readonly PlacedBuilding[],
  holderId: string,
  downloaderOwnerIds: ReadonlySet<string>,
  liaisons: readonly PlacedLiaison[] = [],
  teams?: TeamRoster | null,
): PlacedBuilding[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    [],
    holderId,
    [],
    teams,
  );
  const out: PlacedBuilding[] = [];
  for (const b of buildings) {
    if (
      !isFriendly(teams, b.ownerId, holderId) &&
      downloaderOwnerIds.has(b.ownerId)
    ) {
      out.push(restoreHolderOverviewBuilding(b));
      continue;
    }
    const filtered = filterBuildingForViewer(
      b,
      holderId,
      sources,
      liaisons,
      buildings,
      [],
      [],
      teams,
    );
    if (filtered) out.push(filtered);
  }
  return out;
}

/** Restore lobby holder: downloader liaisons fully visible; others satellite-only. */
export function filterLiaisonsForRestoreHolderViewer(
  liaisons: readonly PlacedLiaison[],
  buildings: readonly PlacedBuilding[],
  holderId: string,
  downloaderOwnerIds: ReadonlySet<string>,
  teams?: TeamRoster | null,
): PlacedLiaison[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    [],
    holderId,
    [],
    teams,
  );
  const out: PlacedLiaison[] = [];
  for (const line of liaisons) {
    if (
      !isFriendly(teams, line.ownerId, holderId) &&
      downloaderOwnerIds.has(line.ownerId)
    ) {
      out.push(restoreHolderOverviewLiaison(line));
      continue;
    }
    const filtered = filterLiaisonForViewer(
      line,
      holderId,
      sources,
      teams,
    );
    if (filtered) out.push(filtered);
  }
  return out;
}

/** Restore lobby non-holder: satellite rules only (no direct vision until playing). */
export function filterBuildingsForRestoreLobbyViewer(
  buildings: readonly PlacedBuilding[],
  viewerId: string,
  liaisons: readonly PlacedLiaison[] = [],
  teams?: TeamRoster | null,
): PlacedBuilding[] {
  return filterBuildingsForViewer(
    buildings,
    viewerId,
    liaisons,
    [],
    [],
    teams,
  );
}

export function filterLiaisonsForRestoreLobbyViewer(
  liaisons: readonly PlacedLiaison[],
  buildings: readonly PlacedBuilding[],
  viewerId: string,
  teams?: TeamRoster | null,
): PlacedLiaison[] {
  return filterLiaisonsForViewer(liaisons, buildings, viewerId, [], [], teams);
}

export function filterResourceSightForRestoreLobbyViewer(
  cells: readonly import("../terrain/types.js").ResourceSightCell[],
  viewerId: string,
  buildings: readonly PlacedBuilding[],
  teams?: TeamRoster | null,
): import("../terrain/types.js").ResourceSightCell[] {
  return filterResourceSightForViewer(
    cells,
    viewerId,
    buildings,
    [],
    [],
    teams,
  );
}
