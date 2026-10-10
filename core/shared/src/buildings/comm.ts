/**
 * Communication / signal propagation from capital (§4.8).
 *
 * Signal budget is normalized to [0, 1]. Traveling distance `d` on a medium
 * with max range `M` consumes `d / M`. Switching mediums keeps the same
 * normalized remainder (比例衰减：剩余比例 × 新介质最大长度 = 新介质剩余 Du).
 * Passing through a building that actually receives the link resets budget to 1.
 *
 * Railways carry signal as a backbone. Arriving via railway links railway
 * stations only (沿线其他建筑不可通信); those stations reset and relay.
 * Fiber / road arrivals link any building. A building reached with
 * remaining budget exactly 0 still connects and relays.
 * A 电台 only links other 电台 inside its work range (own circle, plus
 * circles of radars already sharing that range). It does not link other
 * buildings by radio. Those stations then restart diffusion at full budget.
 */

import { isBuildingComplete, type PlacedBuilding } from "./actions.js";
import { isInsideWorkRange } from "./workRange.js";
import {
  LIAISON_BY_ID,
  RAILWAY_STATION_BUILDING_ID,
  nodeKey,
  pathLengthDu,
  segmentLengthDu,
  type GridNode,
  type LiaisonKind,
  type PlacedLiaison,
} from "./liaison.js";
import { isFriendly, type TeamRoster } from "../teams.js";
export { COMM_WAVE_INTERVAL_TICKS } from "../time.js";

/** Queue expansions processed per tick (wave may span multiple ticks). */
export const COMM_STEPS_PER_TICK = 48;

const EPS = 1e-9;

/** How the signal arrived. Railway links stations only. */
export type CommArrival = "comms" | "railway";

export interface CommEdge {
  toGx: number;
  toGy: number;
  /** Segment length in Du. */
  lengthDu: number;
  /** Medium max range (liaison maxLength or radio R). */
  maxRangeDu: number;
  kind: "fiber" | "road" | "railway" | "radio";
}

/** Undirected grid-edge key for liaison segments that carried signal. */
export function undirectedCommEdgeKey(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): string {
  if (ax < bx || (ax === bx && ay <= by)) return `${ax},${ay}|${bx},${by}`;
  return `${bx},${by}|${ax},${ay}`;
}

export interface CommWaveState {
  ownerId: string;
  /** Max-remaining priority queue (unsorted; we pick best each step). */
  queue: Array<{ gx: number; gy: number; rem: number; via: CommArrival }>;
  /** Best normalized remaining seen at node per arrival channel. */
  bestRem: Map<string, number>;
  /** Building instance ids reached this wave. */
  connected: Set<string>;
  /**
   * Undirected liaison grid edges traversed with rem after attenuation ≥ 0
   * (strictly positive remainder, or exactly decayed to 0 on that segment).
   */
  usedEdges: Set<string>;
  /** Adjacency built at wave start. */
  adj: Map<string, CommEdge[]>;
  /** Building lookup by node key (may be multiple). */
  buildingsAt: Map<string, PlacedBuilding[]>;
  allOwned: PlacedBuilding[];
  /**
   * Comms links published before this wave. Radar work-range sharing uses this
   * frozen set, not discoveries made during the wave.
   */
  publishedConnected: ReadonlySet<string>;
  done: boolean;
}

function maxRangeForKind(kind: LiaisonKind): number {
  return LIAISON_BY_ID[kind].maxLengthDu;
}

function visitKey(gx: number, gy: number, via: CommArrival): string {
  return `${gx},${gy}|${via}`;
}

function addEdge(
  adj: Map<string, CommEdge[]>,
  from: GridNode,
  to: GridNode,
  lengthDu: number,
  maxRangeDu: number,
  kind: CommEdge["kind"],
): void {
  const k = nodeKey(from);
  const list = adj.get(k) ?? [];
  list.push({
    toGx: to.gx,
    toGy: to.gy,
    lengthDu,
    maxRangeDu,
    kind,
  });
  adj.set(k, list);
}

/**
 * Build undirected segment graph from complete owned liaisons.
 * Includes railway so fiber/road can tap the rail network for long-haul signal.
 */
export function buildLiaisonAdjacency(
  liaisons: readonly PlacedLiaison[],
  ownerId: string,
  teams?: TeamRoster | null,
): Map<string, CommEdge[]> {
  const adj = new Map<string, CommEdge[]>();
  for (const line of liaisons) {
    if (!isFriendly(teams, line.ownerId, ownerId)) continue;
    if (line.buildTicksRemaining > 0) continue;
    if (line.nodes.length < 2) continue;
    const maxRangeDu = maxRangeForKind(line.kind);
    for (let i = 1; i < line.nodes.length; i++) {
      const a = line.nodes[i - 1];
      const b = line.nodes[i];
      const len = segmentLengthDu(a, b);
      if (len <= 0) continue;
      addEdge(adj, a, b, len, maxRangeDu, line.kind);
      addEdge(adj, b, a, len, maxRangeDu, line.kind);
    }
  }
  return adj;
}

function indexBuildingsByNode(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  teams?: TeamRoster | null,
): Map<string, PlacedBuilding[]> {
  const map = new Map<string, PlacedBuilding[]>();
  for (const b of buildings) {
    if (!isFriendly(teams, b.ownerId, ownerId)) continue;
    const k = nodeKey({ gx: b.gx, gy: b.gy });
    const list = map.get(k) ?? [];
    list.push(b);
    map.set(k, list);
  }
  return map;
}

function pushBetter(
  wave: CommWaveState,
  gx: number,
  gy: number,
  rem: number,
  via: CommArrival,
): void {
  // Negative budget never arrives. Exactly 0 still arrives (衰减到 0 可接入).
  if (rem < -EPS) return;
  const arrived = rem <= EPS ? 0 : rem;
  const k = visitKey(gx, gy, via);
  const prev = wave.bestRem.get(k);
  if (prev != null && arrived <= prev + EPS) return;
  wave.bestRem.set(k, arrived);
  wave.queue.push({ gx, gy, rem: arrived, via });
}

function discoverBuildingsAt(
  wave: CommWaveState,
  gx: number,
  gy: number,
  via: CommArrival,
): boolean {
  const list = wave.buildingsAt.get(nodeKey({ gx, gy }));
  if (!list) return false;
  let linked = false;
  for (const b of list) {
    if (b.polluted) continue;
    if (via === "railway" && b.buildingId !== RAILWAY_STATION_BUILDING_ID) continue;
    wave.connected.add(b.id);
    linked = true;
  }
  return linked;
}

const BOARDCAST_BUILDING_ID = "boardcast";

/**
 * 信号到达一座电台后：其工作范围（自身圆，并上已满足共享条件的雷达圆）
 * 内的其他电台视为收到信号，并以满预算从那些电台继续扩散。
 */
function relayBoardcastsInWorkRange(wave: CommWaveState, origin: PlacedBuilding): void {
  if (origin.buildingId !== BOARDCAST_BUILDING_ID) return;
  if (origin.polluted) return;
  // 刚到达的电台算已接入；雷达是否共享仍看扩散前已发布的通信。
  const linked = new Set(wave.publishedConnected);
  linked.add(origin.id);
  for (const other of wave.allOwned) {
    if (other.id === origin.id) continue;
    if (other.buildingId !== BOARDCAST_BUILDING_ID) continue;
    if (other.polluted) continue;
    if (
      !isInsideWorkRange(
        other.gx,
        other.gy,
        origin,
        wave.allOwned,
        linked,
      )
    ) {
      continue;
    }
    wave.connected.add(other.id);
    pushBetter(wave, other.gx, other.gy, 1, "comms");
  }
}

/**
 * 广播站接入后，连接所有已建成电台，并从那些电台继续扩散。
 * 电台本身不在这里向其他建筑辐射；电台之间只走工作范围跳转。
 */
function radiateFromNode(wave: CommWaveState, gx: number, gy: number, rem: number): void {
  const here = wave.buildingsAt.get(nodeKey({ gx, gy })) ?? [];
  let isStation = false;
  for (const b of here) {
    if (b.polluted) continue;
    if (!isBuildingComplete(b) && b.buildingId !== "capital") continue;
    if (b.buildingId === "boardcast_station") isStation = true;
  }
  if (!isStation) return;

  for (const b of wave.allOwned) {
    if (b.buildingId !== "boardcast") continue;
    if (b.polluted) continue;
    if (!isBuildingComplete(b)) continue;
    wave.connected.add(b.id);
    pushBetter(wave, b.gx, b.gy, rem, "comms");
  }
}

/** Start a new wave from team capitals (remaining = 1); graph includes allies. */
export function startCommWave(
  ownerId: string,
  buildings: readonly PlacedBuilding[],
  liaisons: readonly PlacedLiaison[],
  publishedConnected: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): CommWaveState | null {
  const capitals = buildings.filter(
    (b) =>
      b.buildingId === "capital" && isFriendly(teams, b.ownerId, ownerId),
  );
  if (capitals.length === 0) return null;

  const wave: CommWaveState = {
    ownerId,
    queue: [],
    bestRem: new Map(),
    connected: new Set(),
    usedEdges: new Set(),
    adj: buildLiaisonAdjacency(liaisons, ownerId, teams),
    buildingsAt: indexBuildingsByNode(buildings, ownerId, teams),
    allOwned: buildings.filter((b) => isFriendly(teams, b.ownerId, ownerId)),
    publishedConnected:
      publishedConnected instanceof Set ? publishedConnected : new Set(publishedConnected),
    done: false,
  };

  for (const capital of capitals) {
    wave.connected.add(capital.id);
    // 污染首都：通信停用，不向外扩散
    if (!capital.polluted) {
      pushBetter(wave, capital.gx, capital.gy, 1, "comms");
    }
  }
  return wave;
}

function popBest(
  wave: CommWaveState,
): { gx: number; gy: number; rem: number; via: CommArrival } | null {
  if (wave.queue.length === 0) return null;
  let bestI = 0;
  for (let i = 1; i < wave.queue.length; i++) {
    if (wave.queue[i].rem > wave.queue[bestI].rem) bestI = i;
  }
  const [item] = wave.queue.splice(bestI, 1);
  return item;
}

/**
 * Process up to `maxSteps` Dijkstra expansions.
 * Returns true when the wave has finished.
 */
export function stepCommWave(wave: CommWaveState, maxSteps = COMM_STEPS_PER_TICK): boolean {
  if (wave.done) return true;
  let steps = 0;
  while (steps < maxSteps) {
    const cur = popBest(wave);
    if (!cur) {
      wave.done = true;
      return true;
    }
    const k = visitKey(cur.gx, cur.gy, cur.via);
    const best = wave.bestRem.get(k) ?? 0;
    if (cur.rem < best - EPS) continue;
    steps += 1;

    let remOut = cur.rem;
    const linked = discoverBuildingsAt(wave, cur.gx, cur.gy, cur.via);
    // 接入的建筑（含衰减刚好到 0）重置并中继。铁路只在车站接入时重置。
    if (linked) remOut = 1;
    if (remOut > best + EPS) {
      wave.bestRem.set(k, remOut);
    }
    if (cur.via === "comms") {
      radiateFromNode(wave, cur.gx, cur.gy, remOut);
      const here = wave.buildingsAt.get(nodeKey({ gx: cur.gx, gy: cur.gy })) ?? [];
      for (const b of here) {
        if (!wave.connected.has(b.id)) continue;
        relayBoardcastsInWorkRange(wave, b);
      }
    }

    const edges = wave.adj.get(nodeKey({ gx: cur.gx, gy: cur.gy }));
    if (!edges) continue;
    for (const e of edges) {
      const cost = e.lengthDu / e.maxRangeDu;
      const nextRem = remOut - cost;
      // Segment participates when remainder after attenuation is >0 or exactly 0.
      if (nextRem >= -EPS) {
        wave.usedEdges.add(
          undirectedCommEdgeKey(cur.gx, cur.gy, e.toGx, e.toGy),
        );
      }
      const nextVia: CommArrival = e.kind === "railway" ? "railway" : "comms";
      pushBetter(wave, e.toGx, e.toGy, nextRem, nextVia);
    }
  }
  return false;
}

/**
 * Run a full diffusion wave and return undirected liaison edges that carried
 * signal (remainder > 0 or exactly 0 after the segment).
 */
export function collectCommUsedEdges(
  ownerId: string,
  buildings: readonly PlacedBuilding[],
  liaisons: readonly PlacedLiaison[],
  publishedConnected: ReadonlySet<string> | readonly string[] = [],
): Set<string> {
  const wave = startCommWave(ownerId, buildings, liaisons, publishedConnected);
  if (!wave) return new Set();
  while (!stepCommWave(wave, 10_000)) {
    /* drain */
  }
  return wave.usedEdges;
}

/** Consume remaining budget as Du on a given medium (for UI/debug). */
export function remainingDuOnMedium(remNorm: number, kind: LiaisonKind): number {
  return remNorm * maxRangeForKind(kind);
}

/** Total polyline length helper re-export convenience. */
export function liaisonPathLength(nodes: readonly GridNode[]): number {
  return pathLengthDu(nodes);
}

export function isBuildingCommsLinked(
  buildingId: string,
  connectedIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (connectedIds instanceof Set) return connectedIds.has(buildingId);
  return (connectedIds as readonly string[]).includes(buildingId);
}
