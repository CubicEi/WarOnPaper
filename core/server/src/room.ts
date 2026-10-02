import { randomUUID } from "node:crypto";
import {
  BUILDING_BY_ID,
  CAPITAL_HP_MAX,
  DEFAULT_MAP_SIZE_ID,
  MAP_SIZES,
  isMapSizeId,
  parseTerrainSeed,
  ORGANIZATION_BAR_MAX,
  STARTING_ENERGY,
  STARTING_ORGANIZATION,
  TICK_HZ,
  TICK_MS,
  DEMOLISH_O_COST,
  HOLD_ACTION_O_COST,
  RELOCATE_CAPITAL_O_COST,
  canPlaceBuildingDef,
  capitalSiteRejectMessage,
  capitalSiteRejectReason,
  capitalExclusionRejectReason,
  constructionHp,
  depleteResourcesForMiners,
  demolishEnergyRefund,
  clearMutualDefensePair,
  energyIncomePerSecond,
  nukeReloadRejectReason,
  findBuildingAt,
  findResourceUnderBuilding,
  generateTerrain,
  investedEForBuilding,
  initialBuildingGarrisonU,
  buildingStartsEmptyGarrison,
  isBuildingAncestor,
  isBuildingComplete,
  isBuildingCommsLinked,
  isInsideWorkRange,
  isDemolishLockedByRepair,
  isRepairing,
  needsContinueBuild,
  applyBuildingHpDamage,
  applyCapitalRelocateInPlace,
  isValidCapitalSite,
  isValidPortSite,
  orgBonusPer30s,
  powerDrainPer10s,
  previewBuildCost,
  previewRepairCost,
  previewContinueBuildCost,
  previewLinearUpgrade,
  applyLinearUpgrade,
  supportsLinearUpgrade,
  buildingLevel,
  effectiveHpMax,
  effectiveUmax,
  LINEAR_UPGRADE_MIN_LEVEL,
  repairHp,
  revealResourcesUnderMiners,
  collectResourceSight,
  collectResourceTerrainSync,
  snapToBuildNode,
  snapToIntegerNode,
  isValidLiaisonPath,
  pathLengthDu,
  previewLiaisonCostForLength,
  withLiaisonTerrainSurcharge,
  resolveLiaisonBuildOverlap,
  demolishLiaisonRefundE,
  railwayEndpointRejectReason,
  anchorRailwayEndpoints,
  roadRailTerrainSurchargeE,
  filterBuildingsForViewer,
  filterLiaisonsForViewer,
  filterUnitsForViewer,
  filterResourceSightForViewer,
  shouldMaskUpgradeOnSatellite,
  isConstructionAllowedAt,
  startCommWave,
  stepCommWave,
  COMM_WAVE_INTERVAL_TICKS,
  COMM_STEPS_PER_TICK,
  LIAISON_BY_ID,
  NUKE_MISSILE_BUILDING_ID,
  NUKE_POLLUTION_R_DU,
  POLLUTION_CAPITAL_HP_INTERVAL_SEC,
  POLLUTION_CAPITAL_HP_DAMAGE,
  isPointInPollution,
  createNukePollutionZone,
  tryInterceptFlyingMissile,
  isLaunchCoolingDown,
  withLaunchCooldown,
  unitHp,
  releaseAwayForUnitDiff,
  type AntiAirAmmoEvent,
  type ClientToServer,
  type CommWaveState,
  type GamePhase,
  type GameStateSnapshot,
  type GroundContext,
  type GridNode,
  type LiaisonKind,
  type MapConfig,
  type MapSizeId,
  type PlacedBuilding,
  type PlacedLiaison,
  type PollutionZone,
  type UnitGroup,
  type PlayerHudState,
  ROOM_IDLE_MS,
  type ServerToClient,
  type SnapshotRole,
  type TerrainMap,
  shouldLogClientAction,
  summarizeClientAction,
  formatCostDelta,
} from "@wop/shared";
import type { WebSocket } from "ws";
import {
  advanceUnitMovement,
  advanceUnitBlockades,
  advanceUnitCombat,
  advanceUnitTraining,
  advanceUnitAntiAir,
  handleMoveUnits,
  handleAssignHome,
  handleStopUnits,
  handleTrainUnits,
  handleBlockadeUnits,
  handleEndBlockade,
  handleSupplyUnits,
  handleAttackUnits,
  handleHoldUnits,
  handleEndHold,
  handleMutualDefense,
  handleEndMutualDefense,
  handleBuildCarrier,
  handleEmbarkAir,
  handleDisembarkAir,
} from "./units.js";


export const DEFAULT_ROOM_IDLE_MS = ROOM_IDLE_MS;

export interface CreateRoomOptions {
  roomId: string;
  maxPlayers: number;
  allowRespawn: boolean;
  mapSize?: MapSizeId;
  seed?: number | string;
  /** Override idle timeout; default ROOM_IDLE_MS (5 min). */
  idleMs?: number;
}

export type RoomSend = (msg: ServerToClient) => void;

export type GameRoomEvent =
  | {
      type: "game_over";
      roomId: string;
      winnerId: string;
      winnerName: string;
    }
  | {
      type: "room_closed";
      roomId: string;
      reason: "idle" | "game_over" | "destroyed";
    }
  | {
      type: "player_left";
      roomId: string;
      playerId: string;
    };

export type GameRoomListener = (event: GameRoomEvent) => void;

export interface JoinRoomOptions {
  playerId: string;
  name: string;
  send: RoomSend;
}

export type JoinRoomResult =
  | { ok: true; playerId: string; state: GameStateSnapshot }
  | { ok: false; code: string; message: string };

export interface GameRoom {
  readonly roomId: string;
  readonly maxPlayers: number;
  readonly allowRespawn: boolean;
  readonly idleMs: number;
  /** Unix ms of last non-ping interaction (create/join/place_capital/actions). */
  readonly lastInteractionAt: number;
  readonly closed: boolean;
  readonly winnerId: string | null;
  readonly winnerName: string | null;
  join(opts: JoinRoomOptions): JoinRoomResult;
  /** Rebind outbound send after reconnect (same playerId). */
  setSend(playerId: string, send: RoomSend): boolean;
  leave(playerId: string): void;
  dispatch(playerId: string, msg: ClientToServer): void;
  tick(): void;
  /** Snapshot for a joined player; null if unknown. */
  snapshot(playerId: string): GameStateSnapshot | null;
  destroy(reason?: "idle" | "game_over" | "destroyed"): void;
  /** True when idle past idleMs (manager may destroy). Also called from tick. */
  isIdle(now?: number): boolean;
  on(listener: GameRoomListener): () => void;
  getPlayerIds(): string[];
  getSpectatorIds(): string[];
  playerCount(): number;
}

/** Create an isolated match room. Terrain is generated immediately (room-driven init). */
export function createRoom(options: CreateRoomOptions): GameRoom {
  const roomId = options.roomId;
  const maxPlayers = Math.max(2, Math.min(10, Math.floor(options.maxPlayers) || 2));
  const allowRespawn = !!options.allowRespawn;
  const idleMs = options.idleMs ?? ROOM_IDLE_MS;
  const listeners = new Set<GameRoomListener>();

  let closed = false;
  let winnerId: string | null = null;
  let winnerName: string | null = null;
  let lastInteractionAt = Date.now();
  /** Players who lost their capital (spectating when !allowRespawn). */
  const spectatorIds = new Set<string>();
  /** Players who currently (or until fall handled) own a capital. */
  const knownCapitalOwners = new Set<string>();
  /** Capitals seen >1 at some point — enables last-capital win check. */
  let sawMultipleCapitals = false;

  function emit(event: GameRoomEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        slog("event", "listener error", err);
      }
    }
  }

  function touchInteraction(): void {
    lastInteractionAt = Date.now();
  }

  function makeSocket(sendFn: RoomSend): WebSocket {
    const sock = {
      readyState: 1,
      OPEN: 1,
      send(data: string) {
        try {
          sendFn(JSON.parse(data) as ServerToClient);
        } catch (err) {
          slog("send", "adapter parse fail", err);
        }
      },
    };
    return sock as unknown as WebSocket;
  }
interface PlayerSession {
  id: string;
  name: string;
  hud: PlayerHudState;
  ws: WebSocket;
}

/** Active map; set at room creation. */
let MAP: MapConfig = MAP_SIZES[options.mapSize && isMapSizeId(options.mapSize) ? options.mapSize : DEFAULT_MAP_SIZE_ID];
const TICKS_PER_SEC = TICK_HZ;
const TICKS_PER_10S = TICKS_PER_SEC * 10;
const TICKS_PER_30S = TICKS_PER_SEC * 30;
const TICKS_PER_POLLUTION_CAPITAL =
  TICKS_PER_SEC * POLLUTION_CAPITAL_HP_INTERVAL_SEC;

const players = new Map<string, PlayerSession>();
const buildings: PlacedBuilding[] = [];
const liaisons: PlacedLiaison[] = [];
const units: UnitGroup[] = [];
/** Persistent nuclear pollution zones (server-authoritative). */
const pollutionZones: PollutionZone[] = [];
/** Live comms-linked building ids per owner (updated as waves discover nodes). */
const connectedByOwner = new Map<string, Set<string>>();
/** In-progress diffusion waves (may span ticks). */
const commWaves = new Map<string, CommWaveState>();
let tick = 0;
let phase: GamePhase = "pick_capital";
let terrain: TerrainMap | null = null;
/** Cells whose resource was depleted (forest→plains / oil·uranium wiped). */
const clearedResourceCells = new Set<string>();

function syncPollutionFlags(): void {
  for (const b of buildings) {
    b.polluted = isPointInPollution(b.gx, b.gy, pollutionZones);
  }
}

function slog(scope: string, ...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}][wop-server:${scope}]`, ...args);
}

function createHud(): PlayerHudState {
  return {
    capitalHp: CAPITAL_HP_MAX,
    capitalHpMax: CAPITAL_HP_MAX,
    energy: STARTING_ENERGY,
    organization: STARTING_ORGANIZATION,
    organizationMax: ORGANIZATION_BAR_MAX,
  };
}

function findPlayerCapital(ownerId: string): PlacedBuilding | undefined {
  return buildings.find((b) => b.ownerId === ownerId && b.buildingId === "capital");
}

/** Per player phase; spectators / ended override pick/play. */
function phaseFor(session: PlayerSession): GamePhase {
  if (closed || winnerId) return "ended";
  if (spectatorIds.has(session.id)) return "spectating";
  if (!terrain) return "need_init";
  if (!findPlayerCapital(session.id)) return "pick_capital";
  return "playing";
}

function rejectIfNotPlaying(session: PlayerSession): boolean {
  const p = phaseFor(session);
  if (p === "playing") return false;
  if (p === "spectating") {
    sendError(session.ws, "spectating", "观战中无法操作");
    return true;
  }
  if (p === "ended") {
    sendError(session.ws, "ended", "对局已结束");
    return true;
  }
  sendError(
    session.ws,
    "not_playing",
    terrain ? "请先选定首都" : "请先完成初始化并选定首都",
  );
  return true;
}

/** HUD capital HP mirrors the placed capital building (single source of truth). */
function syncCapitalHud(player: PlayerSession): void {
  const cap = findPlayerCapital(player.id);
  if (!cap) return;
  player.hud.capitalHp = cap.hp;
  player.hud.capitalHpMax = cap.hpMax > 0 ? cap.hpMax : CAPITAL_HP_MAX;
}

function snapshotFor(player: PlayerSession): GameStateSnapshot {
  syncCapitalHud(player);
  const linked = [...publishedLinks(player.id)];
  const role: SnapshotRole = spectatorIds.has(player.id) ? "spectator" : "player";
  const fullVision = role === "spectator" || phaseFor(player) === "ended";
  const allSight = terrain ? collectResourceSight(terrain) : [];
  const resourceSight = fullVision
    ? allSight
    : filterResourceSightForViewer(
        allSight,
        player.id,
        buildings,
        units,
        linked,
      );
  return {
    tick,
    map: MAP,
    you: { ...player.hud },
    buildings: fullVision
      ? buildings.map((b) => ({ ...b }))
      : filterBuildingsForViewer(buildings, player.id, liaisons, linked, units),
    liaisons: fullVision
      ? liaisons.map((l) => ({ ...l, nodes: l.nodes.map((n) => ({ ...n })) }))
      : filterLiaisonsForViewer(liaisons, buildings, player.id, linked, units),
    units: fullVision
      ? units.map((u) => ({ ...u }))
      : filterUnitsForViewer(units, player.id, buildings, linked),
    connectedBuildingIds: linked,
    pollutionZones: pollutionZones.map((z) => ({ ...z })),
    phase: phaseFor(player),
    terrainSeed: terrain?.seed ?? null,
    resourceSight,
    resourceTerrain: terrain
      ? collectResourceTerrainSync(terrain, clearedResourceCells)
      : { cleared: [], deposits: [] },
    players: [...players.values()].map((p) => ({ id: p.id, name: p.name })),
    roomId,
    allowRespawn,
    role,
    winnerId,
    winnerName,
  };
}

function send(ws: WebSocket, msg: ServerToClient): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    slog("send", "skip, readyState=", ws.readyState, msg.type);
  }
}

/**
 * Full authoritative snapshot for one player (includes you.energy / you.organization).
 * E/O are never sent as deltas — always the current absolute balances.
 */
function sendPlayerState(player: PlayerSession, state = snapshotFor(player)): void {
  send(player.ws, { type: "state", state });
}

function broadcastState(): void {
  for (const player of players.values()) {
    sendPlayerState(player);
  }
}

/** Join / rejoin: push current E/O immediately (do not wait for the next 1s economy tick). */
function syncPlayerOnJoin(player: PlayerSession): GameStateSnapshot {
  const state = snapshotFor(player);
  send(player.ws, {
    type: "welcome",
    playerId: player.id,
    name: player.name,
    activeRoomId: roomId,
    state,
  });
  // Also emit a normal `state` so play clients that key off that path get E/O now.
  sendPlayerState(player, state);
  return state;
}

function broadcastChat(msg: Extract<ServerToClient, { type: "chat" }>): void {
  for (const player of players.values()) {
    send(player.ws, msg);
  }
}

let lastActionReject: { code: string; message: string } | null = null;

function sendError(ws: WebSocket, code: string, message: string): void {
  lastActionReject = { code, message };
  slog("error", code, message);
  send(ws, { type: "error", code, message });
}

function sendTip(ws: WebSocket, message: string): void {
  send(ws, { type: "tip", message });
}

function notifyAaAmmoEvents(events: readonly AntiAirAmmoEvent[]): void {
  for (const ev of events) {
    const owner = players.get(ev.ownerId);
    if (!owner) continue;
    const verb =
      ev.reason === "intercept" ? "拦截导弹，消耗" : "接敌交战，消耗";
    if (ev.ammoRemaining <= 0) {
      sendTip(owner.ws, `防空炮${verb}${ev.consumed}发弹药，弹药已耗尽`);
    } else {
      sendTip(owner.ws, `防空炮${verb}${ev.consumed}发弹药`);
    }
  }
}

function emitActionResult(
  session: PlayerSession,
  msg: ClientToServer,
  energyBefore: number,
  orgBefore: number,
): void {
  if (!shouldLogClientAction(msg.type)) return;
  const reject = lastActionReject;
  lastActionReject = null;
  const summarized = summarizeClientAction(msg);
  const cost = formatCostDelta(
    session.hud.energy - energyBefore,
    session.hud.organization - orgBefore,
  );
  const summary =
    !reject && cost ? `${summarized.summary}（${cost}）` : summarized.summary;
  const detailParts = [
    summarized.detail,
    reject ? `code=${reject.code}` : undefined,
  ].filter((x): x is string => Boolean(x));
  send(session.ws, {
    type: "action_result",
    action: msg.type,
    category: summarized.category,
    ok: !reject,
    tick,
    playerId: session.id,
    summary,
    reason: reject?.message,
    detail: detailParts.length ? detailParts.join(" · ") : undefined,
  });
}

function advanceConstruction(): void {
  for (const b of buildings) {
    if (b.buildTicksRemaining <= 0) continue;
    if (b.constructionHalted) continue; // 受击中断：须「继续建造」，勿用建造公式覆盖 HP
    if (b.polluted || isPointInPollution(b.gx, b.gy, pollutionZones)) {
      continue; // 污染区：暂停建造
    }
    if (
      !isConstructionAllowedAt(
        b.gx,
        b.gy,
        buildings,
        liaisons,
        b.ownerId,
        publishedLinks(b.ownerId),
        units,
      )
    ) {
      continue; // 出直接视野（建筑/单位）且未由公路/铁路连入视野 → 暂停建造
    }
    b.buildTicksRemaining -= 1;
    const def = BUILDING_BY_ID[b.buildingId];
    if (supportsLinearUpgrade(b.buildingId) && b.level == null) {
      b.level = LINEAR_UPGRADE_MIN_LEVEL;
    }
    const hpMax = supportsLinearUpgrade(b.buildingId)
      ? effectiveHpMax(b)
      : (def?.hp ?? b.hpMax);
    b.hpMax = hpMax;
    if (b.buildTicksRemaining <= 0) {
      finishConstructionInPlace(b, hpMax);
    } else {
      b.hp = constructionHp(hpMax, b.buildTicksRemaining, b.buildTicksTotal);
    }
  }
  for (const line of liaisons) {
    if (line.buildTicksRemaining <= 0) continue;
    line.buildTicksRemaining -= 1;
    if (line.buildTicksRemaining < 0) line.buildTicksRemaining = 0;
  }
}

/** 建成：满 HP、清卫星伪装、按兵种规则填充驻军。 */
function finishConstructionInPlace(b: (typeof buildings)[number], hpMax: number): void {
  b.buildTicksRemaining = 0;
  b.constructionHalted = undefined;
  b.hp = hpMax;
  b.satelliteBuildingId = null;
  if (buildingStartsEmptyGarrison(b.buildingId)) {
    if (b.u == null) b.u = 0;
  } else {
    const uMax = supportsLinearUpgrade(b.buildingId)
      ? effectiveUmax(b)
      : (BUILDING_BY_ID[b.buildingId]?.u ?? 0);
    if (uMax > 0) b.u = uMax;
  }
}

/** §⑨ 修复：HP 线性回升至 hpMax；完成时记录 repairedAtTick（锁定拆除 60s）。续建亦走此路径。 */
function advanceRepair(): void {
  for (const b of buildings) {
    const remaining = b.repairTicksRemaining ?? 0;
    if (remaining <= 0) continue;
    b.repairTicksRemaining = Math.max(0, remaining - 1);
    if (b.repairTicksRemaining <= 0) {
      const continuing = needsContinueBuild(b) || b.buildTicksRemaining > 0;
      b.repairedAtTick = tick;
      b.repairTicksRemaining = 0;
      b.repairTicksTotal = 0;
      b.repairHpBefore = undefined;
      b.repairHpRestore = undefined;
      if (continuing) {
        const def = BUILDING_BY_ID[b.buildingId];
        const hpMax = supportsLinearUpgrade(b.buildingId)
          ? effectiveHpMax(b)
          : (def?.hp ?? b.hpMax);
        b.hpMax = hpMax;
        finishConstructionInPlace(b, hpMax);
      } else {
        b.hp = b.hpMax;
      }
    } else {
      b.hp = repairHp(
        b.repairHpBefore ?? 0,
        b.repairHpRestore ?? 0,
        b.hpMax,
        b.repairTicksRemaining,
        b.repairTicksTotal ?? 0,
      );
    }
  }
}

/**
 * §3.1 / §4.6：每秒产 E；每 10 秒功耗；每 30 秒 O；E 为负则扣首都 HP；每 30 秒开采耗储量.
 * Mutates server hud only — clients learn absolute E/O via the next broadcastState
 * (tickRoom always broadcasts; 1Hz economy mutations are included in that full snapshot).
 */
function simulateEconomy(): void {
  const atSecond = tick % TICKS_PER_SEC === 0;
  const at10s = tick % TICKS_PER_10S === 0;
  const at30s = tick % TICKS_PER_30S === 0;

  if (at30s && terrain) {
    depleteResourcesForMiners(terrain, buildings, clearedResourceCells);
  }
  if (atSecond && terrain) {
    revealResourcesUnderMiners(terrain, buildings);
  }

  for (const player of players.values()) {
    const { hud } = player;
    const linked = connectedByOwner.get(player.id) ?? null;
    if (atSecond) {
      const income = energyIncomePerSecond(buildings, player.id, terrain, linked);
      if (income !== 0) hud.energy += income;
    }
    if (at10s) {
      const drain = powerDrainPer10s(buildings, player.id, linked);
      if (drain > 0) hud.energy -= drain;
    }
    if (at30s) {
      const orgGain = orgBonusPer30s(buildings, player.id, linked);
      if (orgGain > 0) {
        hud.organization = Math.min(
          hud.organizationMax,
          hud.organization + orgGain,
        );
      }
    }
    if (hud.energy < 0) {
      const dmg = Math.abs(hud.energy);
      hud.energy = 0;
      const cap = findPlayerCapital(player.id);
      if (cap) {
        const next = applyBuildingHpDamage(cap, dmg);
        Object.assign(cap, next);
        syncCapitalHud(player);
      } else {
        hud.capitalHp = Math.max(0, hud.capitalHp - dmg);
      }
      slog("economy", "energy deficit → capital HP", {
        player: player.id.slice(0, 8),
        dmg,
        capitalHp: hud.capitalHp,
      });
    } else {
      syncCapitalHud(player);
    }
  }
}

/** 首都位于污染区内：每 POLLUTION_CAPITAL_HP_INTERVAL_SEC 秒扣 POLLUTION_CAPITAL_HP_DAMAGE HP。 */
function advancePollutionCapitalDamage(): void {
  if (tick % TICKS_PER_POLLUTION_CAPITAL !== 0) return;
  for (const b of buildings) {
    if (b.buildingId !== "capital") continue;
    if (!b.polluted && !isPointInPollution(b.gx, b.gy, pollutionZones)) continue;
    const next = applyBuildingHpDamage(b, POLLUTION_CAPITAL_HP_DAMAGE);
    Object.assign(b, next);
    const owner = players.get(b.ownerId);
    if (owner) syncCapitalHud(owner);
    slog("pollution", "capital HP", {
      player: b.ownerId.slice(0, 8),
      hp: b.hp,
      dmg: POLLUTION_CAPITAL_HP_DAMAGE,
    });
  }
}

/** 初始化：清空建筑 → 生成地形 → 进入选都 */
function publishedLinks(ownerId: string): ReadonlySet<string> {
  return connectedByOwner.get(ownerId) ?? new Set();
}

/** Commands other than demolish require the building to be in the published comms set. */
function rejectIfNotLinked(session: PlayerSession, buildingId: string): boolean {
  if (isBuildingCommsLinked(buildingId, publishedLinks(session.id))) return false;
  sendError(session.ws, "not_linked", "建筑未接入通信，无法执行该命令");
  return true;
}

/** Polluted buildings may only be demolished. */
function rejectIfPolluted(
  session: PlayerSession,
  building: PlacedBuilding,
): boolean {
  if (!building.polluted && !isPointInPollution(building.gx, building.gy, pollutionZones)) {
    return false;
  }
  sendError(session.ws, "polluted", "污染区内建筑已失效，只能拆除");
  return true;
}

/** Every COMM_WAVE_INTERVAL_TICKS: restart diffusion from each capital.
 *  Published comms state is left untouched until the wave finishes.
 */
function beginCommWaves(): void {
  const owners = new Set<string>();
  for (const b of buildings) {
    if (b.buildingId === "capital") owners.add(b.ownerId);
  }
  for (const ownerId of owners) {
    const existing = commWaves.get(ownerId);
    if (existing && !existing.done) continue;
    const wave = startCommWave(ownerId, buildings, liaisons, publishedLinks(ownerId));
    if (!wave) {
      connectedByOwner.set(ownerId, new Set());
      commWaves.delete(ownerId);
      continue;
    }
    commWaves.set(ownerId, wave);
  }
}

/** Advance in-progress waves (cross-tick). Commit links only when a wave finishes. */
function advanceCommWaves(): void {
  for (const [ownerId, wave] of commWaves) {
    if (wave.done) continue;
    const finished = stepCommWave(wave, COMM_STEPS_PER_TICK);
    if (!finished) continue;
    connectedByOwner.set(ownerId, new Set(wave.connected));
    slog("comm", "wave done", ownerId.slice(0, 8), "linked=", wave.connected.size);
  }
}

function handleInit(session: PlayerSession): void {
  sendError(
    session.ws,
    "init_disabled",
    "地图由房间创建时生成，无法手动初始化",
  );
}

function generateRoomTerrain(seedRaw?: number | string): void {
  buildings.length = 0;
  liaisons.length = 0;
  units.length = 0;
  pollutionZones.length = 0;
  connectedByOwner.clear();
  commWaves.clear();
  clearedResourceCells.clear();
  spectatorIds.clear();
  knownCapitalOwners.clear();
  winnerId = null;
  winnerName = null;
  sawMultipleCapitals = false;
  const seed = parseTerrainSeed(seedRaw);
  terrain = generateTerrain({ map: MAP, seed });
  phase = "pick_capital";
  tick = 0;
  slog("init", "room terrain", {
    roomId,
    seed: terrain.seed,
    map: MAP.id,
    deposits: terrain.deposits.length,
  });
}

function tryBuildLiaison(
  session: PlayerSession,
  kind: LiaisonKind,
  rawNodes: GridNode[],
): void {
  if (rejectIfNotPlaying(session)) return;
  if (!(kind in LIAISON_BY_ID)) {
    sendError(session.ws, "bad_liaison", "未知联络线类型");
    return;
  }
  if (!Array.isArray(rawNodes) || rawNodes.length < 2) {
    sendError(session.ws, "bad_liaison_path", "请拖出至少一段联络线");
    return;
  }

  const nodes: GridNode[] = [];
  for (const n of rawNodes) {
    if (typeof n?.gx !== "number" || typeof n?.gy !== "number") {
      sendError(session.ws, "bad_liaison_path", "节点坐标无效");
      return;
    }
    nodes.push(snapToIntegerNode(n.gx, n.gy, MAP));
  }

  // Collapse consecutive duplicates after snap
  const deduped: GridNode[] = [];
  for (const n of nodes) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.gx === n.gx && prev.gy === n.gy) continue;
    deduped.push(n);
  }

  if (deduped.length < 2) {
    sendError(session.ws, "bad_liaison_path", "请拖出至少一段联络线");
    return;
  }
  for (let i = 1; i < deduped.length; i++) {
    const a = deduped[i - 1];
    const b = deduped[i];
    const dx = Math.abs(a.gx - b.gx);
    const dy = Math.abs(a.gy - b.gy);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      sendError(session.ws, "bad_liaison_path", "路径节点必须相邻（边或对角线）");
      return;
    }
  }
  if (pathLengthDu(deduped) >= LIAISON_BY_ID[kind].maxLengthDu) {
    sendError(
      session.ws,
      "bad_liaison_path",
      `路径超过最大长度（< ${LIAISON_BY_ID[kind].maxLengthDu} Du）`,
    );
    return;
  }

  let path = deduped;
  if (kind === "railway") {
    path = anchorRailwayEndpoints(
      deduped,
      buildings,
      session.id,
      connectedByOwner.get(session.id) ?? [],
    );
  }

  const railReject = railwayEndpointRejectReason(
    kind,
    path,
    buildings,
    session.id,
    connectedByOwner.get(session.id) ?? [],
  );
  if (railReject) {
    sendError(session.ws, "railway_need_stations", railReject);
    return;
  }

  if (kind === "road" || kind === "railway") {
    if (!terrain) {
      sendError(session.ws, "no_terrain", "尚未生成地形");
      return;
    }
  }

  const resolved = resolveLiaisonBuildOverlap(kind, path, liaisons, session.id);
  if (resolved.error) {
    sendError(session.ws, resolved.error.code, resolved.error.message);
    return;
  }

  // Validate remaining place fragments
  for (const frag of resolved.placeFragments) {
    if (!isValidLiaisonPath(kind, frag)) {
      sendError(session.ws, "bad_liaison_path", "建造路段无效");
      return;
    }
  }

  const baseCost = previewLiaisonCostForLength(kind, resolved.billableLengthDu);
  let terrainSurchargeE = 0;
  if ((kind === "road" || kind === "railway") && terrain) {
    for (const frag of resolved.placeFragments) {
      terrainSurchargeE += roadRailTerrainSurchargeE(terrain, frag, kind);
    }
  }
  const cost = withLiaisonTerrainSurcharge(baseCost, terrainSurchargeE);
  const hasPlacement = resolved.placeFragments.length > 0 && cost.energy > 0;
  const hasTrim =
    resolved.removeIds.length > 0 ||
    resolved.replace.length > 0 ||
    resolved.refundE > 0;

  if (!hasPlacement && !hasTrim) {
    sendError(session.ws, "liaison_noop", "无可建造路段（与已有线完全重叠）");
    return;
  }

  // Apply refunds first so upgrades over own lines are affordable
  if (resolved.refundE > 0) {
    session.hud.energy += resolved.refundE;
  }
  if (hasPlacement && session.hud.energy < cost.energy) {
    session.hud.energy -= resolved.refundE;
    sendError(session.ws, "no_energy", `能源不足（需要 ${cost.energy} E）`);
    return;
  }

  // Trim / remove overlapped lower-tier segments
  for (const id of resolved.removeIds) {
    const idx = liaisons.findIndex((l) => l.id === id);
    if (idx >= 0) liaisons.splice(idx, 1);
  }
  for (const rep of resolved.replace) {
    const idx = liaisons.findIndex((l) => l.id === rep.id);
    if (idx < 0) continue;
    const old = liaisons[idx];
    liaisons.splice(idx, 1);
    for (let i = 0; i < rep.fragments.length; i++) {
      const frag = rep.fragments[i];
      liaisons.push({
        id: randomUUID(),
        kind: old.kind,
        ownerId: old.ownerId,
        nodes: frag,
        investedE: rep.investedEEach[i] ?? 0,
        buildTicksRemaining: old.buildTicksRemaining,
        buildTicksTotal: old.buildTicksTotal,
      });
    }
  }

  if (hasPlacement) {
    session.hud.energy -= cost.energy;
    const totalLen = Math.max(resolved.billableLengthDu, 1e-9);
    for (const frag of resolved.placeFragments) {
      const fragLen = pathLengthDu(frag);
      const fragSurcharge =
        (kind === "road" || kind === "railway") && terrain
          ? roadRailTerrainSurchargeE(terrain, frag, kind)
          : 0;
      const fragCost = withLiaisonTerrainSurcharge(
        previewLiaisonCostForLength(kind, fragLen),
        fragSurcharge,
      );
      const fragE = Math.floor(cost.energy * (fragLen / totalLen));
      liaisons.push({
        id: randomUUID(),
        kind,
        ownerId: session.id,
        nodes: frag,
        investedE: fragE > 0 ? fragE : fragCost.energy,
        buildTicksRemaining: fragCost.durationTicks,
        buildTicksTotal: fragCost.durationTicks,
      });
    }
  }

  slog("build_liaison", "ok", {
    kind,
    fragments: resolved.placeFragments.length,
    lengthDu: resolved.billableLengthDu,
    E: hasPlacement ? cost.energy : 0,
    refundE: resolved.refundE,
    removed: resolved.removeIds.length,
    replaced: resolved.replace.length,
    world: liaisons.length,
  });
  broadcastState();
}

function handleDemolishLiaison(session: PlayerSession, lineId: string): void {
  if (rejectIfNotPlaying(session)) return;
  const idx = liaisons.findIndex((l) => l.id === lineId);
  if (idx < 0) {
    sendError(session.ws, "not_found", "联络线不存在");
    return;
  }
  const target = liaisons[idx];
  if (target.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法拆除他人联络线");
    return;
  }
  const refund = demolishLiaisonRefundE(target.investedE);
  session.hud.energy += refund;
  liaisons.splice(idx, 1);
  slog("demolish_liaison", "ok", {
    id: lineId.slice(0, 8),
    kind: target.kind,
    refund,
    E: session.hud.energy,
  });
  broadcastState();
}

/** 定为首都：未建首都的玩家（含中途加入）可选址；须远离其他首都。 */
function handlePlaceCapital(session: PlayerSession, gx: number, gy: number): void {
  if (!terrain) {
    sendError(session.ws, "no_terrain", "请先初始化");
    return;
  }
  if (findPlayerCapital(session.id)) {
    sendError(session.ws, "already_capital", "已经选定首都");
    return;
  }

  const node = snapToBuildNode(gx, gy, MAP);
  const reason = capitalSiteRejectReason(terrain, node.gx, node.gy);
  if (reason) {
    sendError(session.ws, "invalid_capital_site", capitalSiteRejectMessage(reason));
    return;
  }
  if (!isValidCapitalSite(terrain, node.gx, node.gy)) {
    sendError(session.ws, "invalid_capital_site", "此处不能定为首都");
    return;
  }
  const tooClose = capitalExclusionRejectReason(node.gx, node.gy, buildings, session.id);
  if (tooClose) {
    sendError(session.ws, "capital_too_close", capitalSiteRejectMessage(tooClose));
    return;
  }

  const occupied = findBuildingAt(buildings, node.gx, node.gy);
  if (occupied) {
    sendError(session.ws, "occupied", "该节点已有建筑");
    return;
  }

  // One capital per player for now: remove prior capital of this owner
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (buildings[i].ownerId === session.id && buildings[i].buildingId === "capital") {
      buildings.splice(i, 1);
    }
  }

  const def = BUILDING_BY_ID.capital;
  const hpMax = def?.hp ?? CAPITAL_HP_MAX;
  const capital = {
    id: randomUUID(),
    buildingId: "capital",
    ownerId: session.id,
    gx: node.gx,
    gy: node.gy,
    hp: hpMax,
    hpMax,
    u: initialBuildingGarrisonU("capital", true),
    storeE: 0,
    ammo: 0,
    investedE: 0,
    buildTicksRemaining: 0,
    buildTicksTotal: 0,
  };
  buildings.push(capital);
  connectedByOwner.set(session.id, new Set([capital.id]));

  session.hud.energy = STARTING_ENERGY;
  session.hud.organization = STARTING_ORGANIZATION;
  syncCapitalHud(session);
  if (phase !== "playing") tick = 0;
  phase = "playing";
  spectatorIds.delete(session.id);
  knownCapitalOwners.add(session.id);
  beginCommWaves();
  advanceCommWaves();
  touchInteraction();
  noteCapitalCounts();

  slog("capital", "placed", {
    player: session.id.slice(0, 8),
    node,
    E: session.hud.energy,
    O: session.hud.organization,
  });
  broadcastState();
}

function handleDemolish(session: PlayerSession, buildingInstanceId: string): void {
  if (rejectIfNotPlaying(session)) return;

  const idx = buildings.findIndex((b) => b.id === buildingInstanceId);
  if (idx < 0) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  const target = buildings[idx];
  if (target.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法拆除他人建筑");
    return;
  }
  if (target.buildingId === "capital") {
    sendError(session.ws, "cannot_demolish_capital", "首都不可拆除");
    return;
  }
  if (isDemolishLockedByRepair(target, tick)) {
    sendError(session.ws, "demolish_locked", "刚完成修复的建筑 60 秒内不可拆除");
    return;
  }
  if (session.hud.organization < DEMOLISH_O_COST) {
    sendError(session.ws, "not_enough_org", `组织度不足（需要 ${DEMOLISH_O_COST} O）`);
    return;
  }

  const refund = demolishEnergyRefund(target);
  session.hud.organization -= DEMOLISH_O_COST;
  session.hud.energy += refund;
  const partnerId = target.mutualDefensePartnerId;
  buildings.splice(idx, 1);
  if (partnerId) {
    clearMutualDefensePair(buildings, target.id, partnerId);
  }

  slog("demolish", "ok", {
    player: session.id.slice(0, 8),
    buildingId: target.buildingId,
    node: { gx: target.gx, gy: target.gy },
    refund,
    O: session.hud.organization,
    E: session.hud.energy,
  });
  broadcastState();
}

/** §⑨ 修复：消耗 E（首都 ×5），用时 E/10（首都 E/25）；< 1 秒立即完成；HP 线性回升。
 * 建造受击中断后「继续建造」：费用同修复，用时 ×2，完成时建成。 */
function handleRepair(session: PlayerSession, buildingInstanceId: string): void {
  if (rejectIfNotPlaying(session)) return;

  const target = buildings.find((b) => b.id === buildingInstanceId);
  if (!target) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  if (target.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法修复他人建筑");
    return;
  }
  // 占领后修复可跳过通讯连通（刚占下未必已联网）
  if (!target.capturePending && rejectIfNotLinked(session, target.id)) return;
  if (rejectIfPolluted(session, target)) return;

  const continuing = needsContinueBuild(target);
  if (!isBuildingComplete(target) && !continuing) {
    sendError(session.ws, "still_constructing", "建筑建造中，无法修复");
    return;
  }
  if (isRepairing(target)) {
    sendError(session.ws, "already_repairing", continuing ? "该建筑正在继续建造中" : "该建筑正在修复中");
    return;
  }
  if (target.hp >= target.hpMax) {
    if (continuing) {
      const def = BUILDING_BY_ID[target.buildingId];
      const hpMax = supportsLinearUpgrade(target.buildingId)
        ? effectiveHpMax(target)
        : (def?.hp ?? target.hpMax);
      target.hpMax = hpMax;
      finishConstructionInPlace(target, hpMax);
      if (target.buildingId === "capital") syncCapitalHud(session);
      slog("continue_build", "ok immediate full-hp", {
        player: session.id.slice(0, 8),
        buildingId: target.buildingId,
      });
      broadcastState();
      return;
    }
    sendError(session.ws, "hp_full", "建筑 HP 已满，无需修复");
    return;
  }

  const cost = continuing ? previewContinueBuildCost(target) : previewRepairCost(target);
  if (session.hud.energy < cost.energy) {
    sendError(session.ws, "not_enough_energy", `能源不足（需要 ${Math.ceil(cost.energy)} E）`);
    return;
  }

  session.hud.energy -= cost.energy;
  target.capturePending = undefined;
  target.repairHpBefore = target.hp;
  target.repairHpRestore = cost.hpRestore;
  target.repairTicksTotal = cost.durationTicks;
  target.repairTicksRemaining = cost.durationTicks;

  if (cost.durationTicks <= 0) {
    target.repairTicksRemaining = 0;
    target.repairedAtTick = tick;
    target.repairTicksTotal = 0;
    target.repairHpBefore = undefined;
    target.repairHpRestore = undefined;
    if (continuing) {
      const def = BUILDING_BY_ID[target.buildingId];
      const hpMax = supportsLinearUpgrade(target.buildingId)
        ? effectiveHpMax(target)
        : (def?.hp ?? target.hpMax);
      target.hpMax = hpMax;
      finishConstructionInPlace(target, hpMax);
    } else {
      target.hp = target.hpMax;
    }
  } else {
    target.hp = repairHp(
      target.repairHpBefore ?? 0,
      target.repairHpRestore ?? 0,
      target.hpMax,
      target.repairTicksRemaining ?? 0,
      target.repairTicksTotal ?? 0,
    );
  }

  if (target.buildingId === "capital") syncCapitalHud(session);

  slog(continuing ? "continue_build" : "repair", "ok", {
    player: session.id.slice(0, 8),
    buildingId: target.buildingId,
    node: { gx: target.gx, gy: target.gy },
    eCost: cost.energy,
    hpRestore: cost.hpRestore,
    durationTicks: cost.durationTicks,
    E: session.hud.energy,
  });
  broadcastState();
}

/** 雷达/港口/兵营/装甲营/机场：线性等级升级，费用 (L+1)³ E，立即生效。 */
function handleLevelUpgrade(session: PlayerSession, buildingInstanceId: string): void {
  if (rejectIfNotPlaying(session)) return;

  const idx = buildings.findIndex((b) => b.id === buildingInstanceId);
  if (idx < 0) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  const target = buildings[idx]!;
  if (target.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法升级他人建筑");
    return;
  }
  if (rejectIfNotLinked(session, target.id)) return;
  if (rejectIfPolluted(session, target)) return;
  if (!supportsLinearUpgrade(target.buildingId)) {
    sendError(session.ws, "no_level_upgrade", "该建筑不可线性升级");
    return;
  }
  if (!isBuildingComplete(target)) {
    sendError(session.ws, "still_constructing", "建筑建造中，无法升级");
    return;
  }
  if (isRepairing(target)) {
    sendError(session.ws, "repairing", "修复中，无法升级");
    return;
  }
  if (target.hp < target.hpMax) {
    sendError(session.ws, "need_repair", "须先修复再升级");
    return;
  }

  const preview = previewLinearUpgrade(target);
  if (!preview || !preview.canUpgrade) {
    sendError(session.ws, "max_level", preview?.reason ?? "已满级");
    return;
  }
  if (session.hud.energy < preview.energy) {
    sendError(session.ws, "not_enough_energy", `能源不足（需要 ${preview.energy} E）`);
    return;
  }

  const next = applyLinearUpgrade(target);
  if (!next) {
    sendError(session.ws, "max_level", "已满级");
    return;
  }

  session.hud.energy -= preview.energy;
  buildings[idx] = next;

  slog("level_upgrade", "ok", {
    player: session.id.slice(0, 8),
    buildingId: next.buildingId,
    level: buildingLevel(next),
    eCost: preview.energy,
    hpMax: next.hpMax,
    E: session.hud.energy,
  });
  broadcastState();
}

/** 首府迁都：−50 O；首府格变首都（HP 取首府当前），原首都格变首府（HP = min(100, 原首都 HP)）。 */
function handleRelocateCapital(session: PlayerSession, metropolisInstanceId: string): void {
  if (rejectIfNotPlaying(session)) return;

  const metro = buildings.find((b) => b.id === metropolisInstanceId);
  if (!metro) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  if (metro.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法在他人首府迁都");
    return;
  }
  if (metro.buildingId !== "metropolis") {
    sendError(session.ws, "not_metropolis", "只能从首府迁都");
    return;
  }
  if (rejectIfNotLinked(session, metro.id)) return;
  if (rejectIfPolluted(session, metro)) return;
  if (!isBuildingComplete(metro)) {
    sendError(session.ws, "still_constructing", "建筑建造中，无法迁都");
    return;
  }
  if (isRepairing(metro)) {
    sendError(session.ws, "repairing", "修复中，无法迁都");
    return;
  }
  if (metro.hp < metro.hpMax) {
    sendError(session.ws, "need_repair", "须先修复再迁都");
    return;
  }

  const capital = findPlayerCapital(session.id);
  if (!capital) {
    sendError(session.ws, "no_capital", "没有首都，无法迁都");
    return;
  }
  if (capital.id === metro.id) {
    sendError(session.ws, "already_capital", "已是首都");
    return;
  }
  if (isRepairing(capital)) {
    sendError(session.ws, "capital_repairing", "首都修复中，无法迁都");
    return;
  }

  if (session.hud.organization < RELOCATE_CAPITAL_O_COST) {
    sendError(
      session.ws,
      "not_enough_org",
      `组织度不足（需要 ${RELOCATE_CAPITAL_O_COST} O）`,
    );
    return;
  }

  const fromNode = { gx: capital.gx, gy: capital.gy };
  const toNode = { gx: metro.gx, gy: metro.gy };
  const capitalHpBefore = capital.hp;
  const metroHpBefore = metro.hp;

  session.hud.organization -= RELOCATE_CAPITAL_O_COST;
  applyCapitalRelocateInPlace(metro, capital);
  syncCapitalHud(session);

  // Restart comms from the new capital; keep prior published links until wave commits.
  commWaves.delete(session.id);
  const linked = new Set(publishedLinks(session.id));
  linked.add(metro.id);
  linked.add(capital.id);
  connectedByOwner.set(session.id, linked);
  beginCommWaves();

  slog("relocate_capital", "ok", {
    player: session.id.slice(0, 8),
    from: fromNode,
    to: toNode,
    capitalHp: metro.hp,
    capitalHpBefore: capitalHpBefore,
    metroHp: capital.hp,
    metroHpBefore,
    O: session.hud.organization,
  });
  broadcastState();
}

/** 臼炮系装填：按建筑表扣除 count×E，弹药 +count，不超过上限。 */
function handleReload(
  session: PlayerSession,
  buildingInstanceId: string,
  rawCount: number,
): void {
  if (rejectIfNotPlaying(session)) return;

  const target = buildings.find((b) => b.id === buildingInstanceId);
  if (!target) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  if (target.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法装填他人建筑");
    return;
  }
  if (rejectIfNotLinked(session, target.id)) return;
  if (rejectIfPolluted(session, target)) return;
  if (!isBuildingComplete(target)) {
    sendError(session.ws, "still_constructing", "建筑建造中，无法装填");
    return;
  }

  const def = BUILDING_BY_ID[target.buildingId];
  const unitCost = def?.reloadE;
  const ammoMax = def?.ammoMax ?? 0;
  if (unitCost == null || unitCost <= 0 || ammoMax <= 0) {
    sendError(session.ws, "cannot_reload", "该建筑无法装填");
    return;
  }

  if (target.buildingId === NUKE_MISSILE_BUILDING_ID) {
    const reason = nukeReloadRejectReason(
      buildings,
      session.id,
      terrain,
      publishedLinks(session.id),
    );
    if (reason) {
      sendError(session.ws, "nuke_reload_prereq", reason);
      return;
    }
  }

  const room = Math.max(0, ammoMax - (target.ammo ?? 0));
  if (room <= 0) {
    sendError(session.ws, "ammo_full", "弹药已满");
    return;
  }

  const afford = Math.floor(session.hud.energy / unitCost);
  if (afford < 1) {
    sendError(session.ws, "not_enough_energy", `能源不足（需要 ${unitCost} E）`);
    return;
  }
  if (session.hud.organization < HOLD_ACTION_O_COST) {
    sendError(
      session.ws,
      "not_enough_org",
      `组织度不足（需要 ${HOLD_ACTION_O_COST} O）`,
    );
    return;
  }

  const wanted = Math.floor(rawCount);
  if (!Number.isFinite(wanted) || wanted < 1) {
    sendError(session.ws, "bad_count", "装填数量无效");
    return;
  }

  const count = Math.min(wanted, room, afford);
  const cost = count * unitCost;
  session.hud.energy -= cost;
  session.hud.organization -= HOLD_ACTION_O_COST;
  target.ammo = (target.ammo ?? 0) + count;

  slog("reload", "ok", {
    player: session.id.slice(0, 8),
    buildingId: target.buildingId,
    count,
    ammo: target.ammo,
    ammoMax,
    eCost: cost,
    oCost: HOLD_ACTION_O_COST,
    E: session.hud.energy,
    O: session.hud.organization,
  });
  broadcastState();
}

/** 补给站部署：按步长存入 E，每次操作扣除 1 O。 */
function handleDeploy(
  session: PlayerSession,
  buildingInstanceId: string,
  rawCount: number,
): void {
  if (rejectIfNotPlaying(session)) return;

  const target = buildings.find((b) => b.id === buildingInstanceId);
  if (!target) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  if (target.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法部署他人建筑");
    return;
  }
  if (rejectIfNotLinked(session, target.id)) return;
  if (rejectIfPolluted(session, target)) return;
  if (!isBuildingComplete(target)) {
    sendError(session.ws, "still_constructing", "建筑建造中，无法部署");
    return;
  }

  const def = BUILDING_BY_ID[target.buildingId];
  const step = def?.deployStepE;
  const storeMax = def?.storeEMax ?? 0;
  if (step == null || step <= 0 || storeMax <= 0) {
    sendError(session.ws, "cannot_deploy", "该建筑无法部署");
    return;
  }

  const roomSteps = Math.floor(Math.max(0, storeMax - (target.storeE ?? 0)) / step);
  if (roomSteps <= 0) {
    sendError(session.ws, "store_full", "储能已满");
    return;
  }

  const afford = Math.floor(session.hud.energy / step);
  if (afford < 1) {
    sendError(session.ws, "not_enough_energy", `能源不足（需要 ${step} E）`);
    return;
  }
  if (session.hud.organization < HOLD_ACTION_O_COST) {
    sendError(
      session.ws,
      "not_enough_org",
      `组织度不足（需要 ${HOLD_ACTION_O_COST} O）`,
    );
    return;
  }

  const wanted = Math.floor(rawCount);
  if (!Number.isFinite(wanted) || wanted < 1) {
    sendError(session.ws, "bad_count", "部署数量无效");
    return;
  }

  const count = Math.min(wanted, roomSteps, afford);
  const cost = count * step;
  session.hud.energy -= cost;
  session.hud.organization -= HOLD_ACTION_O_COST;
  target.storeE = (target.storeE ?? 0) + cost;

  slog("deploy", "ok", {
    player: session.id.slice(0, 8),
    buildingId: target.buildingId,
    count,
    storeE: target.storeE,
    storeMax,
    eCost: cost,
    oCost: HOLD_ACTION_O_COST,
    E: session.hud.energy,
    O: session.hud.organization,
  });
  broadcastState();
}

/** 臼炮系发射：射程内敌方建筑受 H 伤害；仅臼炮可打单位（unitH）。消耗 1 发弹药。 */
function handleFire(
  session: PlayerSession,
  buildingInstanceId: string,
  targetId: string | undefined,
  targetUnitId: string | undefined,
): void {
  if (rejectIfNotPlaying(session)) return;

  const source = buildings.find((b) => b.id === buildingInstanceId);
  if (!source) {
    sendError(session.ws, "not_found", "建筑不存在");
    return;
  }
  if (source.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "无法操作他人建筑");
    return;
  }
  if (rejectIfNotLinked(session, source.id)) return;
  if (rejectIfPolluted(session, source)) return;
  if (!isBuildingComplete(source)) {
    sendError(session.ws, "still_constructing", "建筑建造中，无法发射");
    return;
  }

  if (targetUnitId) {
    handleFireAtUnit(session, source, targetUnitId);
    return;
  }
  if (!targetId) {
    sendError(session.ws, "no_target", "未指定目标");
    return;
  }
  handleFireAtBuilding(session, source, targetId);
}

function handleFireAtUnit(
  session: PlayerSession,
  source: PlacedBuilding,
  targetUnitId: string,
): void {
  const def = BUILDING_BY_ID[source.buildingId];
  const unitDamage = def?.unitH;
  if (unitDamage == null || !(unitDamage > 0) || source.buildingId !== "gun") {
    sendError(session.ws, "cannot_fire_unit", "该建筑无法攻击单位");
    return;
  }
  if ((source.ammo ?? 0) < 1) {
    sendError(session.ws, "no_ammo", "弹药不足");
    return;
  }
  if (isLaunchCoolingDown(source, tick)) {
    sendError(session.ws, "on_cooldown", "发射冷却中");
    return;
  }

  const target = units.find((u) => u.id === targetUnitId);
  if (!target || target.u <= 0) {
    sendError(session.ws, "not_found", "目标不存在");
    return;
  }
  if (target.ownerId === session.id) {
    sendError(session.ws, "not_enemy", "只能攻击敌方单位");
    return;
  }
  if (
    !isInsideWorkRange(
      target.gx,
      target.gy,
      source,
      buildings,
      publishedLinks(session.id),
    )
  ) {
    sendError(session.ws, "out_of_range", "目标不在工作范围内");
    return;
  }

  source.ammo = (source.ammo ?? 0) - 1;
  Object.assign(source, withLaunchCooldown(source, tick));

  const beforeUnits = units.map((u) => ({ ...u }));
  const hp = unitHp(target.kind);
  const beforeU = target.u;
  const nextU = Math.max(0, Math.floor((beforeU * hp - unitDamage) / hp));
  if (nextU <= 0) {
    const idx = units.findIndex((u) => u.id === target.id);
    if (idx >= 0) units.splice(idx, 1);
  } else {
    target.u = nextU;
  }
  const nextBuildings = releaseAwayForUnitDiff(buildings, beforeUnits, units);
  for (let i = 0; i < buildings.length; i++) {
    const next = nextBuildings.find((b) => b.id === buildings[i]!.id);
    if (next) buildings[i]!.awayOccupiedU = next.awayOccupiedU;
  }

  slog("fire", "unit", {
    player: session.id.slice(0, 8),
    buildingId: source.buildingId,
    target: target.id.slice(0, 8),
    kind: target.kind,
    damage: unitDamage,
    uBefore: beforeU,
    uAfter: nextU,
    ammo: source.ammo,
  });
  broadcastState();
}

function handleFireAtBuilding(
  session: PlayerSession,
  source: PlacedBuilding,
  targetId: string,
): void {
  const def = BUILDING_BY_ID[source.buildingId];
  const damage = def?.h;
  if (damage == null || !(damage > 0)) {
    sendError(session.ws, "cannot_fire", "该建筑无法攻击建筑");
    return;
  }
  if ((source.ammo ?? 0) < 1) {
    sendError(session.ws, "no_ammo", "弹药不足");
    return;
  }
  if (isLaunchCoolingDown(source, tick)) {
    sendError(session.ws, "on_cooldown", "发射冷却中");
    return;
  }

  const target = buildings.find((b) => b.id === targetId);
  if (!target) {
    sendError(session.ws, "not_found", "目标不存在");
    return;
  }
  if (target.ownerId === session.id) {
    sendError(session.ws, "not_enemy", "只能攻击敌方建筑");
    return;
  }
  if (target.buildingId === "artificial_island") {
    sendError(session.ws, "not_a_target", "不能攻击人工岛");
    return;
  }
  if (target.hp <= 0) {
    sendError(session.ws, "already_down", "目标已被摧毁");
    return;
  }
  if (
    !isInsideWorkRange(
      target.gx,
      target.gy,
      source,
      buildings,
      publishedLinks(session.id),
    )
  ) {
    sendError(session.ws, "out_of_range", "目标不在工作范围内");
    return;
  }

  const impactGx = target.gx;
  const impactGy = target.gy;
  const isNuke = source.buildingId === NUKE_MISSILE_BUILDING_ID;

  // 防空炮按工作范围并集（含雷达协同）拦截火箭军弹道；臼炮不拦截。
  const shot = tryInterceptFlyingMissile(
    buildings,
    {
      id: `shot-${source.id}-${target.id}`,
      ownerId: session.id,
      fromGx: source.gx,
      fromGy: source.gy,
      gx: impactGx,
      gy: impactGy,
      sourceBuildingId: source.buildingId,
    },
    connectedByOwner,
    { tick },
  );

  source.ammo = (source.ammo ?? 0) - 1;
  Object.assign(source, withLaunchCooldown(source, tick));
  if (shot.intercepted) {
    for (const next of shot.buildings) {
      if (next.id === source.id) continue;
      const live = buildings.find((b) => b.id === next.id);
      if (live) {
        live.ammo = next.ammo ?? 0;
        live.fireCooldownUntilTick = next.fireCooldownUntilTick;
      }
    }
    if (shot.ammoEvent) notifyAaAmmoEvents([shot.ammoEvent]);
    slog("fire", "intercepted", {
      player: session.id.slice(0, 8),
      buildingId: source.buildingId,
      target: target.buildingId,
    });
    broadcastState();
    return;
  }

  const before = target.hp;
  const wasConstructing = target.buildTicksRemaining > 0;
  const wasRepairing = isRepairing(target);
  Object.assign(target, applyBuildingHpDamage(target, damage ?? Infinity));
  const owner = players.get(target.ownerId);
  if (owner) syncCapitalHud(owner);

  // 火箭军最后一击 / 建造·修复中 HP0：直接摧毁建筑（不可占领）
  if (target.hp <= 0) {
    const wasCapital = target.buildingId === "capital";
    const fallenOwner = target.ownerId;
    const idx = buildings.findIndex((b) => b.id === target.id);
    if (idx >= 0) {
      buildings.splice(idx, 1);
      slog("fire", "destroyed", {
        player: session.id.slice(0, 8),
        buildingId: source.buildingId,
        target: target.buildingId,
        damage: before,
        interrupted: wasConstructing || wasRepairing,
      });
    }
    if (wasCapital) onCapitalFallen(fallenOwner);
  }

  if (isNuke) {
    pollutionZones.push(
      createNukePollutionZone(randomUUID(), impactGx, impactGy),
    );
    syncPollutionFlags();
    slog("fire", "nuke pollution", {
      player: session.id.slice(0, 8),
      gx: impactGx,
      gy: impactGy,
      radiusDu: NUKE_POLLUTION_R_DU,
      zones: pollutionZones.length,
    });
  }

  if (target.hp <= 0) {
    broadcastState();
    return;
  }

  slog("fire", "ok", {
    player: session.id.slice(0, 8),
    buildingId: source.buildingId,
    target: target.buildingId,
    damage: before - target.hp,
    hp: target.hp,
    ammo: source.ammo,
  });
  broadcastState();
}

function tryBuild(
  session: PlayerSession,
  buildingId: string,
  gx: number,
  gy: number,
  ground: GroundContext,
): void {
  if (rejectIfNotPlaying(session)) return;

  slog("build", "request", {
    player: session.id.slice(0, 8),
    buildingId,
    gx,
    gy,
    ground,
    E: session.hud.energy,
    O: session.hud.organization,
  });

  const def = BUILDING_BY_ID[buildingId];
  if (!def) {
    sendError(session.ws, "unknown_building", "未知建筑");
    return;
  }

  const node = snapToBuildNode(gx, gy, MAP);
  let existing = findBuildingAt(buildings, node.gx, node.gy);

  if (existing && !isBuildingComplete(existing)) {
    sendError(session.ws, "building_in_progress", "该节点正在建造中");
    return;
  }

  // Artificial island: replace with a small/medium land building. The island sits
  // on open sea, so bypass the normal ground check below.
  // Do NOT remove the island until cost checks pass — otherwise a failed build
  // would leave the tile empty.
  let islandToReplace: PlacedBuilding | null = null;
  if (existing?.buildingId === "artificial_island") {
    if (existing.ownerId !== session.id) {
      sendError(session.ws, "not_owner", "无法在他人人工岛上建造");
      return;
    }
    if (rejectIfNotLinked(session, existing.id)) return;
    if (def.flags?.seaOnly) {
      sendError(session.ws, "invalid_on_island", "人工岛上不能建造海上建筑");
      return;
    }
    const size = def.size ?? "small";
    if (size === "large") {
      sendError(session.ws, "too_large_for_island", "人工岛上只能建造中型及以下建筑");
      return;
    }
    islandToReplace = existing;
    existing = undefined;
  }

  if (!islandToReplace && !canPlaceBuildingDef(def, ground)) {
    sendError(session.ws, "invalid_ground", "地形不符，无法建造");
    return;
  }

  if (buildingId === "port") {
    if (!terrain) {
      sendError(session.ws, "no_terrain", "尚未生成地形");
      return;
    }
    if (!isValidPortSite(terrain, node.gx, node.gy)) {
      sendError(session.ws, "port_need_coast", "港口只能建在海岸线上");
      return;
    }
  }

  if (isPointInPollution(node.gx, node.gy, pollutionZones)) {
    sendError(session.ws, "polluted_zone", "污染区内禁止建造");
    return;
  }

  if (def.requiresResource) {
    if (!terrain) {
      sendError(session.ws, "no_terrain", "尚未生成地形");
      return;
    }
    if (!findResourceUnderBuilding(terrain, node.gx, node.gy, def.requiresResource)) {
      const label =
        def.requiresResource === "forest"
          ? "林地"
          : def.requiresResource === "oil"
            ? "油田"
            : "铀矿";
      sendError(session.ws, "bad_resource_site", `${def.name}须建在${label}上`);
      return;
    }
  }

  let fromBuildingId: string | null = null;
  if (existing) {
    if (existing.ownerId !== session.id) {
      sendError(session.ws, "not_owner", "无法升级他人建筑");
      return;
    }
    if (rejectIfNotLinked(session, existing.id)) return;
    if (existing.buildingId === buildingId) {
      sendError(session.ws, "already_built", "已是该建筑");
      return;
    }
    if (!isBuildingAncestor(existing.buildingId, buildingId)) {
      sendError(session.ws, "invalid_upgrade", "无法升级到该建筑");
      return;
    }
    if (existing.hp < existing.hpMax) {
      sendError(session.ws, "need_repair", "须先修复再升级");
      return;
    }
    fromBuildingId = existing.buildingId;
  }

  const cost = previewBuildCost(def, fromBuildingId);
  slog("build", "cost", {
    from: fromBuildingId,
    to: buildingId,
    node,
    ...cost,
  });

  if (session.hud.energy < cost.energy) {
    sendError(session.ws, "not_enough_energy", `能源不足（需要 ${cost.energy} E）`);
    return;
  }
  if (session.hud.organization < cost.organization) {
    sendError(session.ws, "not_enough_org", `组织度不足（需要 ${cost.organization} O）`);
    return;
  }

  session.hud.energy -= cost.energy;
  session.hud.organization -= cost.organization;

  const hpMax = supportsLinearUpgrade(buildingId)
    ? effectiveHpMax({ buildingId, level: LINEAR_UPGRADE_MIN_LEVEL, hpMax: def.hp ?? 1 })
    : (def.hp ?? 1);
  const allowed = isConstructionAllowedAt(
    node.gx,
    node.gy,
    buildings,
    liaisons,
    session.id,
    publishedLinks(session.id),
    units,
  );
  // 视野外可规划：立即完成的建筑也先挂起，连入视野后再完工。
  const ticks = !allowed && cost.durationTicks <= 0 ? 1 : cost.durationTicks;
  const investedE = investedEForBuilding(buildingId);
  const level = supportsLinearUpgrade(buildingId) ? LINEAR_UPGRADE_MIN_LEVEL : undefined;

  if (islandToReplace) {
    const idx = buildings.indexOf(islandToReplace);
    if (idx >= 0) buildings.splice(idx, 1);
  }

  if (existing) {
    if (fromBuildingId && shouldMaskUpgradeOnSatellite(buildingId)) {
      existing.satelliteBuildingId = fromBuildingId;
    } else {
      existing.satelliteBuildingId = null;
    }
    existing.buildingId = buildingId;
    existing.hpMax = hpMax;
    existing.investedE = investedE;
    existing.buildTicksTotal = ticks;
    existing.buildTicksRemaining = ticks;
    existing.hp = ticks <= 0 ? hpMax : constructionHp(hpMax, ticks, ticks);
    existing.u = initialBuildingGarrisonU(buildingId, ticks <= 0);
    existing.storeE = 0;
    existing.ammo = 0;
    existing.level = level;
    if (ticks <= 0) existing.satelliteBuildingId = null;
  } else {
    buildings.push({
      id: randomUUID(),
      buildingId,
      ownerId: session.id,
      gx: node.gx,
      gy: node.gy,
      hp: ticks <= 0 ? hpMax : 0,
      hpMax,
      u: initialBuildingGarrisonU(buildingId, ticks <= 0),
      storeE: 0,
      ammo: 0,
      investedE,
      buildTicksRemaining: ticks,
      buildTicksTotal: ticks,
      ...(level != null ? { level } : {}),
    });
  }

  slog("build", "ok", {
    buildingId,
    node,
    E: session.hud.energy,
    O: session.hud.organization,
    worldBuildings: buildings.length,
    ticks,
  });

  broadcastState();
}


function countLivingCapitals(): PlacedBuilding[] {
  return buildings.filter((b) => b.buildingId === "capital" && b.hp > 0);
}

function noteCapitalCounts(): void {
  const caps = countLivingCapitals();
  const owners = new Set(caps.map((c) => c.ownerId));
  if (owners.size >= 2) sawMultipleCapitals = true;
}

function clearPlayerWorld(ownerId: string): void {
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (buildings[i]!.ownerId === ownerId) buildings.splice(i, 1);
  }
  for (let i = liaisons.length - 1; i >= 0; i--) {
    if (liaisons[i]!.ownerId === ownerId) liaisons.splice(i, 1);
  }
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i]!.ownerId === ownerId) units.splice(i, 1);
  }
  connectedByOwner.delete(ownerId);
  commWaves.delete(ownerId);
}

function onCapitalFallen(ownerId: string): void {
  if (!knownCapitalOwners.has(ownerId)) return;
  knownCapitalOwners.delete(ownerId);
  const owner = players.get(ownerId);
  slog("capital", "fallen", {
    roomId,
    player: ownerId.slice(0, 8),
    allowRespawn,
  });
  clearPlayerWorld(ownerId);
  if (allowRespawn) {
    spectatorIds.delete(ownerId);
    if (owner) {
      owner.hud = createHud();
    }
  } else {
    spectatorIds.add(ownerId);
    if (owner) {
      owner.hud.capitalHp = 0;
    }
  }
  noteCapitalCounts();
  maybeDeclareWinner();
}

function maybeDeclareWinner(): void {
  if (closed || winnerId) return;
  if (!sawMultipleCapitals) return;
  const caps = countLivingCapitals();
  const owners = [...new Set(caps.map((c) => c.ownerId))];
  if (owners.length !== 1) return;
  const id = owners[0]!;
  const winner = players.get(id);
  winnerId = id;
  winnerName = winner?.name ?? id.slice(0, 8);
  phase = "ended";
  slog("game_over", roomId, winnerId, winnerName);
  const payload = {
    type: "game_over" as const,
    roomId,
    winnerId,
    winnerName,
  };
  for (const p of players.values()) {
    send(p.ws, payload);
  }
  emit(payload);
  broadcastState();
}

/** Detect capitals removed or at 0 HP after combat/economy. */
function reconcileCapitals(): void {
  // Destroy 0-hp capitals still present
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i]!;
    if (b.buildingId !== "capital") continue;
    if (b.hp > 0) continue;
    const ownerId = b.ownerId;
    buildings.splice(i, 1);
    onCapitalFallen(ownerId);
  }
  // Owners tracked as having a capital that combat removed entirely
  for (const ownerId of [...knownCapitalOwners]) {
    const alive = buildings.some(
      (b) => b.buildingId === "capital" && b.ownerId === ownerId && b.hp > 0,
    );
    if (!alive) onCapitalFallen(ownerId);
  }
  noteCapitalCounts();
}

function dispatchPlayerMessage(session: PlayerSession, msg: ClientToServer): void {
  if (msg.type === "init") {
    slog("msg", "init rejected", session.id.slice(0, 8));
    handleInit(session);
    return;
  }

  if (
    msg.type === "create_room" ||
    msg.type === "join_room" ||
    msg.type === "queue_match" ||
    msg.type === "cancel_queue" ||
    msg.type === "leave_room"
  ) {
    sendError(session.ws, "lobby_only", "请在大厅处理该消息");
    return;
  }

  if (msg.type === "place_capital") {
    slog("msg", "place_capital", msg);
    handlePlaceCapital(session, msg.gx, msg.gy);
    return;
  }

  if (msg.type === "build") {
    slog("msg", "build raw", msg);
    const ground: GroundContext =
      msg.ground === "ocean" || msg.ground === "land" || msg.ground === "any"
        ? msg.ground
        : "land";
    tryBuild(session, msg.buildingId, msg.gx, msg.gy, ground);
    return;
  }

  if (msg.type === "build_liaison") {
    slog("msg", "build_liaison", msg.kind, "nodes=", msg.nodes?.length);
    tryBuildLiaison(session, msg.kind, msg.nodes);
    return;
  }

  if (msg.type === "demolish_liaison") {
    slog("msg", "demolish_liaison", msg.id);
    handleDemolishLiaison(session, msg.id);
    return;
  }

  if (msg.type === "demolish") {
    slog("msg", "demolish", msg);
    handleDemolish(session, msg.id);
    return;
  }

  if (msg.type === "repair") {
    slog("msg", "repair", msg);
    handleRepair(session, msg.id);
    return;
  }

  if (msg.type === "level_upgrade") {
    slog("msg", "level_upgrade", msg);
    handleLevelUpgrade(session, msg.id);
    return;
  }

  if (msg.type === "relocate_capital") {
    slog("msg", "relocate_capital", msg);
    handleRelocateCapital(session, msg.id);
    return;
  }

  if (msg.type === "reload") {
    slog("msg", "reload", msg);
    handleReload(session, msg.id, msg.count);
    return;
  }

  if (msg.type === "deploy") {
    slog("msg", "deploy", msg);
    handleDeploy(session, msg.id, msg.count);
    return;
  }

  if (msg.type === "train") {
    slog("msg", "train", msg);
    const source = buildings.find((b) => b.id === msg.id);
    if (source && rejectIfPolluted(session, source)) return;
    handleTrainUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.id,
      msg.kind,
      msg.u,
      msg.targetIds,
      msg.targetId,
      phaseFor(session) === "playing",
      source != null && isBuildingCommsLinked(source.id, publishedLinks(session.id)),
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "fire") {
    slog("msg", "fire", msg);
    handleFire(session, msg.id, msg.targetId, msg.targetUnitId);
    return;
  }

  if (msg.type === "move_units") {
    slog("msg", "move_units", msg);
    handleMoveUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.gx,
      msg.gy,
      msg.sources,
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "assign_home") {
    slog("msg", "assign_home", msg);
    handleAssignHome(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.buildingId,
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "stop_units") {
    slog("msg", "stop_units", msg);
    handleStopUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
      !!msg.retreat,
    );
    return;
  }

  if (msg.type === "blockade_units") {
    slog("msg", "blockade_units", msg);
    handleBlockadeUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.gx,
      msg.gy,
      msg.sources,
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "end_blockade") {
    slog("msg", "end_blockade", msg);
    handleEndBlockade(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "supply_units") {
    slog("msg", "supply_units", msg);
    handleSupplyUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.supplyBuildingId,
      msg.gx,
      msg.gy,
      msg.sources,
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "attack_units") {
    slog("msg", "attack_units", msg);
    if (msg.targetLiaisonId && (msg.liaisonAx == null || msg.liaisonAy == null || msg.liaisonBx == null || msg.liaisonBy == null)) {
      sendError(session.ws, "bad_liaison_target", "进攻联络线缺少段落");
      return;
    }
    handleAttackUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.sources,
      msg.unitIds,
      msg.targetUnitId,
      msg.targetBuildingId,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
      msg.targetLiaisonId != null &&
        msg.liaisonAx != null &&
        msg.liaisonAy != null &&
        msg.liaisonBx != null &&
        msg.liaisonBy != null
        ? {
            id: msg.targetLiaisonId,
            ax: msg.liaisonAx,
            ay: msg.liaisonAy,
            bx: msg.liaisonBx,
            by: msg.liaisonBy,
          }
        : undefined,
    );
    return;
  }

  if (msg.type === "hold_units") {
    slog("msg", "hold_units", msg);
    handleHoldUnits(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.holdBuildingId,
      msg.sources,
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "end_hold") {
    slog("msg", "end_hold", msg);
    handleEndHold(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.unitIds,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "mutual_defense") {
    slog("msg", "mutual_defense", msg);
    const a = buildings.find((b) => b.id === msg.buildingId);
    const b = buildings.find((x) => x.id === msg.partnerBuildingId);
    if (a && rejectIfPolluted(session, a)) return;
    if (b && rejectIfPolluted(session, b)) return;
    handleMutualDefense(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.buildingId,
      msg.partnerBuildingId,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "end_mutual_defense") {
    slog("msg", "end_mutual_defense", msg);
    const target = buildings.find((b) => b.id === msg.buildingId);
    if (target && rejectIfPolluted(session, target)) return;
    handleEndMutualDefense(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.buildingId,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "build_carrier") {
    slog("msg", "build_carrier", msg);
    const port = buildings.find((b) => b.id === msg.id);
    if (port && rejectIfPolluted(session, port)) return;
    handleBuildCarrier(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.id,
      phaseFor(session) === "playing",
      publishedLinks(session.id).has(msg.id),
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "embark_air") {
    slog("msg", "embark_air", msg);
    handleEmbarkAir(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.carrierId,
      msg.airUnitId,
      msg.u,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "disembark_air") {
    slog("msg", "disembark_air", msg);
    handleDisembarkAir(
      session,
      { map: MAP, terrain, buildings, liaisons, units, connectedByOwner },
      msg.carrierId,
      msg.u,
      phaseFor(session) === "playing",
      sendError,
      broadcastState,
      slog,
    );
    return;
  }

  if (msg.type === "chat") {
    const text = String(msg.text ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (!text) {
      sendError(session.ws, "empty_chat", "消息为空");
      return;
    }
    slog("msg", "chat", session.name, text.slice(0, 40));
    broadcastChat({
      type: "chat",
      playerId: session.id,
      name: session.name,
      text,
      t: Date.now(),
    });
    return;
  }

  slog("msg", "unknown", (msg as { type?: string }).type, msg);
  sendError(session.ws, "unknown_action", "未知操作");
}


  // Room-driven map generation at create time.
  generateRoomTerrain(options.seed);
  touchInteraction();

  function tickRoom(): void {
    if (closed) return;
    if (winnerId) {
      broadcastState();
      return;
    }
    // Global phase gate: run sim once anyone is playing (or always after terrain)
    const anyPlaying = [...players.values()].some((p) => phaseFor(p) === "playing");
    if (!anyPlaying) {
      broadcastState();
      if (isIdleNow()) {
        destroyRoom("idle");
      }
      return;
    }
    tick += 1;
    syncPollutionFlags();
    advanceConstruction();
    advanceRepair();
    advancePollutionCapitalDamage();
    if (tick % COMM_WAVE_INTERVAL_TICKS === 0) {
      beginCommWaves();
    }
    advanceCommWaves();
    simulateEconomy();
    advanceUnitTraining({
      map: MAP,
      terrain,
      buildings,
      liaisons,
      units,
      connectedByOwner,
    });
    advanceUnitMovement({
      map: MAP,
      terrain,
      buildings,
      liaisons,
      units,
      connectedByOwner,
    });
    {
      const aaEvents = advanceUnitAntiAir(
        {
          map: MAP,
          terrain,
          buildings,
          liaisons,
          units,
          connectedByOwner,
        },
        tick,
      );
      if (aaEvents.length > 0) notifyAaAmmoEvents(aaEvents);
    }
    {
      const energyAvail = new Map<string, number>();
      for (const [pid, p] of players) {
        energyAvail.set(pid, p.hud.energy);
      }
      const world = { map: MAP, terrain, buildings, liaisons, units, connectedByOwner };
      const blockadeDrains = advanceUnitBlockades(world, energyAvail);
      for (const [pid, cost] of blockadeDrains) {
        energyAvail.set(pid, Math.max(0, (energyAvail.get(pid) ?? 0) - cost));
        const p = players.get(pid);
        if (p) p.hud.energy = Math.max(0, p.hud.energy - cost);
      }
      const combatDrains = advanceUnitCombat(world, energyAvail);
      for (const [pid, cost] of combatDrains) {
        const p = players.get(pid);
        if (p) p.hud.energy = Math.max(0, p.hud.energy - cost);
      }
    }
    reconcileCapitals();
    // Full snapshot each tick (15 Hz) includes absolute you.energy / you.organization.
    // Economy mutates those at 1 Hz (and 10s/30s); this broadcast is the client source of truth.
    broadcastState();
    if (isIdleNow()) {
      destroyRoom("idle");
    }
  }

  function isIdleNow(now = Date.now()): boolean {
    return !closed && now - lastInteractionAt >= idleMs;
  }

  function destroyRoom(reason: "idle" | "game_over" | "destroyed" = "destroyed"): void {
    if (closed) return;
    closed = true;
    phase = "ended";
    const payload = { type: "room_closed" as const, roomId, reason };
    for (const p of players.values()) {
      send(p.ws, payload);
    }
    emit(payload);
    players.clear();
    slog("room", "destroyed", roomId, reason);
  }

  const api: GameRoom = {
    get roomId() {
      return roomId;
    },
    get maxPlayers() {
      return maxPlayers;
    },
    get allowRespawn() {
      return allowRespawn;
    },
    get idleMs() {
      return idleMs;
    },
    get lastInteractionAt() {
      return lastInteractionAt;
    },
    get closed() {
      return closed;
    },
    get winnerId() {
      return winnerId;
    },
    get winnerName() {
      return winnerName;
    },
    join(opts: JoinRoomOptions): JoinRoomResult {
      if (closed) {
        return { ok: false, code: "room_closed", message: "房间已关闭" };
      }
      const existing = players.get(opts.playerId);
      if (existing) {
        existing.name = opts.name.slice(0, 24) || existing.name;
        existing.ws = makeSocket(opts.send);
        touchInteraction();
        const state = syncPlayerOnJoin(existing);
        return { ok: true, playerId: existing.id, state };
      }
      if (players.size >= maxPlayers) {
        return { ok: false, code: "room_full", message: "房间已满" };
      }
      const session: PlayerSession = {
        id: opts.playerId,
        name: (opts.name || `Player-${opts.playerId.slice(0, 4)}`).slice(0, 24),
        hud: createHud(),
        ws: makeSocket(opts.send),
      };
      players.set(session.id, session);
      touchInteraction();
      const state = syncPlayerOnJoin(session);
      slog("conn", "join", roomId, session.id.slice(0, 8), "players=", players.size);
      return { ok: true, playerId: session.id, state };
    },
    setSend(playerId: string, sendFn: RoomSend): boolean {
      const session = players.get(playerId);
      if (!session || closed) return false;
      session.ws = makeSocket(sendFn);
      return true;
    },
    leave(playerId: string): void {
      if (!players.has(playerId)) return;
      players.delete(playerId);
      slog("conn", "leave", roomId, playerId.slice(0, 8), "players=", players.size);
      emit({ type: "player_left", roomId, playerId });
    },
    dispatch(playerId: string, msg: ClientToServer): void {
      if (closed) return;
      const session = players.get(playerId);
      if (!session) return;
      if (msg.type === "ping") {
        send(session.ws, { type: "pong", t: msg.t });
        return;
      }
      if (msg.type === "hello") {
        if (msg.name) session.name = msg.name.slice(0, 24);
        return;
      }
      touchInteraction();
      lastActionReject = null;
      const energyBefore = session.hud.energy;
      const orgBefore = session.hud.organization;
      try {
        dispatchPlayerMessage(session, msg);
      } finally {
        emitActionResult(session, msg, energyBefore, orgBefore);
      }
    },
    tick: tickRoom,
    snapshot(playerId: string): GameStateSnapshot | null {
      const session = players.get(playerId);
      if (!session) return null;
      return snapshotFor(session);
    },
    destroy: destroyRoom,
    isIdle: isIdleNow,
    on(listener: GameRoomListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPlayerIds(): string[] {
      return [...players.keys()];
    },
    getSpectatorIds(): string[] {
      return [...spectatorIds];
    },
    playerCount(): number {
      return players.size;
    },
  };

  return api;
}

export class GameRoomHandle {
  private readonly room: GameRoom;
  constructor(options: CreateRoomOptions) {
    this.room = createRoom(options);
  }
  get api(): GameRoom {
    return this.room;
  }
}
