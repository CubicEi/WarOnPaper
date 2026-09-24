import { BUILDING_BY_ID, type BuildingSize } from "./catalog.js";
import type { PlacedBuilding } from "./actions.js";
import { cellsTouchingNode } from "../terrain/capitalSite.js";
import { cellAt, type ResourceKind, type ResourceSightCell, type TerrainMap } from "../terrain/types.js";

/** 规则 §4.6：建筑功耗（每 10 秒） */
export const POWER_DRAIN_PER_10S: Record<BuildingSize, number> = {
  small: 1,
  medium: 2,
  large: 4,
};

const THERMAL_REFINERY_ID = "thermal_factory";
const URANIUM_REFINERY_ID = "uranium_factory";
const URANIUM_MINER_ID = "uranium_miner";

function asIdSet(
  ids: ReadonlySet<string> | readonly string[] | null | undefined,
): ReadonlySet<string> {
  if (!ids) return new Set();
  return ids instanceof Set ? ids : new Set(ids);
}

function isActive(b: PlacedBuilding): boolean {
  // 污染区内建筑失效：不参与产电 / 炼化 / 功耗 / 组织度
  return b.buildTicksRemaining <= 0 && !b.polluted;
}

function ownedActive(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
): PlacedBuilding[] {
  return buildings.filter((b) => b.ownerId === ownerId && isActive(b));
}

/** Find a cell with matching resource (reserve > 0) under a grid node. */
export function findResourceUnderBuilding(
  terrain: TerrainMap,
  gx: number,
  gy: number,
  kind: ResourceKind,
): { x: number; y: number; reserve: number; depositId?: number } | null {
  for (const { x, y } of cellsTouchingNode(terrain, gx, gy)) {
    const cell = cellAt(terrain, x, y);
    const r = cell?.resource;
    if (r && r.kind === kind && r.reserve > 0) {
      return { x, y, reserve: r.reserve, depositId: r.depositId };
    }
  }
  return null;
}

/**
 * Mark resource cells as revealed when an active miner sits on them
 * (储量仅在首次开采后可见).
 */
export function revealResourcesUnderMiners(
  terrain: TerrainMap,
  buildings: readonly PlacedBuilding[],
): boolean {
  let changed = false;
  for (const b of buildings) {
    if (!isActive(b)) continue;
    const def = BUILDING_BY_ID[b.buildingId];
    if (!def?.rawP || !def.requiresResource) continue;
    const hit = findResourceUnderBuilding(
      terrain,
      b.gx,
      b.gy,
      def.requiresResource,
    );
    if (!hit) continue;

    if (hit.depositId != null) {
      const dep = terrain.deposits.find((d) => d.id === hit.depositId);
      if (!dep) continue;
      for (const c of dep.cells) {
        const cell = cellAt(terrain, c.x, c.y);
        if (cell?.resource && !cell.resource.revealed) {
          cell.resource.revealed = true;
          changed = true;
        }
      }
    } else {
      const cell = cellAt(terrain, hit.x, hit.y);
      if (cell?.resource && !cell.resource.revealed) {
        cell.resource.revealed = true;
        changed = true;
      }
    }
  }
  return changed;
}

/** Snapshot of revealed reserves for client rings.
 *  Forest: one ring per cell; oil/uranium deposits: one ring at deposit center. */
export function collectResourceSight(terrain: TerrainMap): ResourceSightCell[] {
  const out: ResourceSightCell[] = [];
  const seenDeposits = new Set<number>();

  for (const dep of terrain.deposits) {
    if (seenDeposits.has(dep.id)) continue;
    if (dep.reserve <= 0) continue;
    const anyRevealed = dep.cells.some((c) => {
      const r = cellAt(terrain, c.x, c.y)?.resource;
      return r?.depositId === dep.id && r.revealed;
    });
    if (!anyRevealed) continue;
    seenDeposits.add(dep.id);
    let sx = 0;
    let sy = 0;
    for (const c of dep.cells) {
      sx += c.x;
      sy += c.y;
    }
    const n = dep.cells.length;
    const sample = cellAt(terrain, dep.cells[0].x, dep.cells[0].y)?.resource;
    // Fractional centroid at average of cell centers (already Du sample point).
    out.push({
      x: sx / n + 0.5,
      y: sy / n + 0.5,
      kind: dep.kind,
      reserve: Math.max(0, dep.reserve),
      reserveMax: Math.max(1, dep.reserveMax || sample?.reserveMax || dep.reserve),
    });
  }

  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const r = cellAt(terrain, x, y)?.resource;
      if (!r || !r.revealed || r.depositId != null || r.reserve <= 0) continue;
      out.push({
        x,
        y,
        kind: r.kind,
        reserve: Math.max(0, r.reserve),
        reserveMax: Math.max(1, r.reserveMax || r.reserve),
      });
    }
  }
  return out;
}

/**
 * 规则：正在开采的资源每 30 秒储量 −1。
 * 枯竭时：森林格 resource = null（变平原）；油田/铀矿抹除该矿块所有格的 resource。
 * `clearedOut` 收集本次新枯竭的格子，供客户端地形同步。
 */
export function depleteResourcesForMiners(
  terrain: TerrainMap,
  buildings: readonly PlacedBuilding[],
  clearedOut?: Set<string>,
): boolean {
  let changed = false;
  const depletedDeposits = new Set<number>();
  const markCleared = (x: number, y: number) => {
    clearedOut?.add(`${x},${y}`);
  };

  for (const b of buildings) {
    if (!isActive(b)) continue;
    const def = BUILDING_BY_ID[b.buildingId];
    if (!def?.rawP || !def.requiresResource) continue;
    const hit = findResourceUnderBuilding(
      terrain,
      b.gx,
      b.gy,
      def.requiresResource,
    );
    if (!hit) continue;

    if (hit.depositId != null) {
      if (depletedDeposits.has(hit.depositId)) continue;
      depletedDeposits.add(hit.depositId);
      const dep = terrain.deposits.find((d) => d.id === hit.depositId);
      if (!dep || dep.reserve <= 0) continue;
      dep.reserve -= 1;
      for (const c of dep.cells) {
        const cell = cellAt(terrain, c.x, c.y);
        if (!cell?.resource || cell.resource.depositId !== hit.depositId) continue;
        if (dep.reserve <= 0) {
          cell.resource = null;
          markCleared(c.x, c.y);
        } else {
          cell.resource.reserve = dep.reserve;
        }
      }
      changed = true;
    } else {
      // Forest (per-cell): deplete → plains (resource cleared, ground stays land)
      const cell = cellAt(terrain, hit.x, hit.y);
      if (!cell?.resource || cell.resource.reserve <= 0) continue;
      cell.resource.reserve -= 1;
      if (cell.resource.reserve <= 0) {
        cell.resource = null;
        markCleared(hit.x, hit.y);
      }
      changed = true;
    }
  }
  return changed;
}

/** Snapshot cleared cells + deposit reserves for client terrain re-render. */
export function collectResourceTerrainSync(
  terrain: TerrainMap,
  clearedCells: ReadonlySet<string>,
): import("../terrain/types.js").ResourceTerrainSync {
  const cleared: Array<{ x: number; y: number }> = [];
  for (const key of clearedCells) {
    const [xs, ys] = key.split(",");
    cleared.push({ x: Number(xs), y: Number(ys) });
  }
  // Also include fully depleted deposits (in case set was empty after reconnect mid-game
  // — deposits with reserve 0 still need borders wiped).
  for (const dep of terrain.deposits) {
    if (dep.reserve > 0) continue;
    for (const c of dep.cells) {
      const key = `${c.x},${c.y}`;
      if (!clearedCells.has(key)) cleared.push({ x: c.x, y: c.y });
    }
  }
  return {
    cleared,
    deposits: terrain.deposits.map((d) => ({ id: d.id, reserve: d.reserve })),
  };
}

/** Apply server resource sync onto a client terrain copy (mutates + returns same map). */
export function applyResourceTerrainSync(
  terrain: TerrainMap,
  sync: import("../terrain/types.js").ResourceTerrainSync | null | undefined,
): boolean {
  if (!sync) return false;
  let changed = false;

  for (const { x, y } of sync.cleared) {
    const cell = cellAt(terrain, x, y);
    if (cell && cell.resource != null) {
      cell.resource = null;
      changed = true;
    }
  }

  for (const d of sync.deposits) {
    const dep = terrain.deposits.find((x) => x.id === d.id);
    if (!dep) continue;
    if (dep.reserve !== d.reserve) {
      dep.reserve = d.reserve;
      changed = true;
    }
    for (const c of dep.cells) {
      const cell = cellAt(terrain, c.x, c.y);
      if (!cell) continue;
      if (d.reserve <= 0) {
        if (cell.resource != null) {
          cell.resource = null;
          changed = true;
        }
      } else if (cell.resource?.depositId === d.id && cell.resource.reserve !== d.reserve) {
        cell.resource.reserve = d.reserve;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Direct P income per second (首都 P+4 等).
 * Only buildings in `connectedIds` (comms-linked) contribute when provided.
 */
export function sumPowerProduction(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  connectedIds?: ReadonlySet<string> | null,
): number {
  let p = 0;
  for (const b of ownedActive(buildings, ownerId)) {
    if (connectedIds && !connectedIds.has(b.id)) continue;
    p += BUILDING_BY_ID[b.buildingId]?.p ?? 0;
  }
  return p;
}

/**
 * Raw-P converted to E per second when matching refinery exists
 * and miner sits on a living resource deposit.
 * Refinery and miner must both be comms-linked when `connectedIds` is set.
 */
export function sumRefinedRawIncome(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  terrain: TerrainMap | null,
  connectedIds?: ReadonlySet<string> | null,
): number {
  const active = ownedActive(buildings, ownerId).filter(
    (b) => !connectedIds || connectedIds.has(b.id),
  );
  const hasThermal = active.some((b) => b.buildingId === THERMAL_REFINERY_ID);
  const hasUranium = active.some((b) => b.buildingId === URANIUM_REFINERY_ID);
  let raw = 0;
  for (const b of active) {
    const def = BUILDING_BY_ID[b.buildingId];
    if (!def?.rawP) continue;
    if (def.refineVia === "thermal" && !hasThermal) continue;
    if (def.refineVia === "uranium" && !hasUranium) continue;
    if (def.requiresResource) {
      if (!terrain) continue;
      if (!findResourceUnderBuilding(terrain, b.gx, b.gy, def.requiresResource)) {
        continue;
      }
    }
    raw += def.rawP;
  }
  return raw;
}

/**
 * 核导弹装填前置。与产电 tick 同一套判定，不另做通信扩散：
 * - 接入通信：建筑 id 在 `connectedIds`（通信波已提交的连通集）
 * - 正在开采 / 正在工作：已建成且未污染（`isActive`）；铀矿机还须脚下铀矿储量 > 0
 *   （与 `sumRefinedRawIncome` / `depleteResourcesForMiners` 相同）
 * 铀矿机与铀工厂须同时满足，缺一返回拒绝文案。
 */
export function nukeReloadRejectReason(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  terrain: TerrainMap | null,
  connectedIds?: ReadonlySet<string> | readonly string[] | null,
): string | null {
  const linked = asIdSet(connectedIds);
  let mining = false;
  let miningLinked = false;
  let refining = false;
  let refiningLinked = false;

  for (const b of buildings) {
    if (b.ownerId !== ownerId || !isActive(b)) continue;
    if (b.buildingId === URANIUM_MINER_ID) {
      if (!terrain) continue;
      if (!findResourceUnderBuilding(terrain, b.gx, b.gy, "uranium")) continue;
      mining = true;
      if (linked.has(b.id)) miningLinked = true;
    } else if (b.buildingId === URANIUM_REFINERY_ID) {
      refining = true;
      if (linked.has(b.id)) refiningLinked = true;
    }
  }

  const minerReason = miningLinked
    ? null
    : mining
      ? "铀矿机未接入通信，无法装填核导弹"
      : "没有正在开采的铀矿机，无法装填核导弹";
  const factoryReason = refiningLinked
    ? null
    : refining
      ? "铀工厂未接入通信，无法装填核导弹"
      : "没有正在工作的铀工厂，无法装填核导弹";
  if (minerReason && factoryReason) {
    return "装填核导弹需要已接入通信且正在开采的铀矿机，以及已接入通信且正在工作的铀工厂";
  }
  return minerReason ?? factoryReason;
}

/** E gained each second from P + refined Raw-P. */
export function energyIncomePerSecond(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  terrain: TerrainMap | null = null,
  connectedIds?: ReadonlySet<string> | null,
): number {
  return (
    sumPowerProduction(buildings, ownerId, connectedIds) +
    sumRefinedRawIncome(buildings, ownerId, terrain, connectedIds)
  );
}

/** Power drain every 10 seconds by building size (linked buildings only when set). */
export function powerDrainPer10s(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  connectedIds?: ReadonlySet<string> | null,
): number {
  let drain = 0;
  for (const b of ownedActive(buildings, ownerId)) {
    if (connectedIds && !connectedIds.has(b.id)) continue;
    const def = BUILDING_BY_ID[b.buildingId];
    if (!def || def.flags?.noPowerDrain || def.flags?.lineBuild) continue;
    if (!def.size) continue;
    drain += POWER_DRAIN_PER_10S[def.size];
  }
  return drain;
}

/** Organization bonus every 30 seconds. */
export function orgBonusPer30s(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  connectedIds?: ReadonlySet<string> | null,
): number {
  let o = 0;
  for (const b of ownedActive(buildings, ownerId)) {
    if (connectedIds && !connectedIds.has(b.id)) continue;
    o += BUILDING_BY_ID[b.buildingId]?.orgBonus ?? 0;
  }
  return o;
}
