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
  TICKS_PER_SEC,
  TICKS_PER_10S,
  TICKS_PER_30S,
  ticksPerSeconds,
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
  type RocketResearchProgressMap,
  ROOM_IDLE_MS,
  type ServerToClient,
  type SnapshotListDelta,
  type SnapshotRole,
  type TerrainMap,
  shouldLogClientAction,
  summarizeClientAction,
  formatCostDelta,
  alliesOf,
  applyAllyGarrisonDeposit,
  hasMultiPlayerTeam,
  sameTeam,
  teamIdOf,
  type AllyGarrisonRequest,
  type TeamInvitePending,
  type TeamRoster,
  type SaveDocument,
  type SavePlayerSnapshot,
  type RestoreIdentityOption,
  SAVE_FORMAT_VERSION,
  applyResourceTerrainSync,
  emptyRocketResearchProgress,
  normalizeRocketResearchProgress,
  normalizeActiveRocketResearch,
  canStartRocketResearch,
  getRocketResearchEntry,
  getRocketResearchStages,
  getNextRocketResearchStage,
  rollRocketResearchSuccess,
  applyRocketResearchOutcome,
  rocketResearchDisplayName,
  isRocketResearchTarget,
  isRocketBuildUnlocked,
  nukeUraniumInfraRejectReason,
  NUKE_RESEARCH_INFRA_CHECK_INTERVAL_TICKS,
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
import { cloneSaveWorld, remapOwnerId, recomputeIdMap } from "./saveRestore.js";


export const DEFAULT_ROOM_IDLE_MS = ROOM_IDLE_MS;

export interface CreateRoomOptions {
  roomId: string;
  maxPlayers: number;
  allowRespawn: boolean;
  mapSize?: MapSizeId;
  seed?: number | string;
  /** Override idle timeout; default ROOM_IDLE_MS (5 min). */
  idleMs?: number;
  teams?: TeamRoster;
  teamMode?: boolean;
  /** Decrypt plaintext from manager — restore-only create path. */
  restore?: SaveDocument;
  /** Live player id of the save-file holder (inherits saver). */
  holderPlayerId?: string;
  /** Stamped into exportPlainSave (`config.json` version). */
  gameVersion?: string;
}

export type RoomSend = (msg: ServerToClient) => void;

export type GameRoomEvent =
  | {
      type: "game_over";
      roomId: string;
      winnerId: string;
      winnerName: string;
      winnerTeamId?: string;
      winnerPlayerIds?: string[];
      winnerNames?: string[];
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
  /**
   * Full authoritative dump for the requester (manager encrypts).
   * Null when room closed / requester not seated.
   */
  exportPlainSave(requesterId: string): SaveDocument | null;
}

/** Create an isolated match room. Terrain is generated immediately (room-driven init). */
export function createRoom(options: CreateRoomOptions): GameRoom {
  const roomId = options.roomId;
  const restoreDoc = options.restore ?? null;
  const restoreMode = restoreDoc != null;
  const holderPlayerId = options.holderPlayerId ?? null;
  const gameVersionStamp = options.gameVersion ?? "unknown";
  const maxPlayers = Math.max(
    2,
    Math.min(
      10,
      Math.floor(
        restoreDoc?.maxPlayers ?? options.maxPlayers ?? 2,
      ) || 2,
    ),
  );
  const allowRespawn = restoreDoc
    ? !!restoreDoc.allowRespawn
    : !!options.allowRespawn;
  const idleMs = options.idleMs ?? ROOM_IDLE_MS;
  const listeners = new Set<GameRoomListener>();

  let closed = false;
  let winnerId: string | null = null;
  let winnerName: string | null = null;
  let winnerTeamId: string | null = null;
  let winnerPlayerIds: string[] | null = null;
  let winnerNames: string[] | null = null;
  let lastInteractionAt = Date.now();
  /** Players who lost their capital (spectating when !allowRespawn). */
  const spectatorIds = new Set<string>();
  /** Players who currently (or until fall handled) own a capital. */
  const knownCapitalOwners = new Set<string>();
  /** Capitals seen >1 at some point — enables last-capital win check. */
  let sawMultipleCapitals = false;

  /** playerId → teamId (custom invites + matchmaking). */
  let teams: TeamRoster = {
    ...(restoreDoc?.teams ?? options.teams ?? {}),
  };
  let teamMode =
    !!options.teamMode ||
    !!(restoreDoc?.teamMode) ||
    hasMultiPlayerTeam(teams);
  const teamInvites: TeamInvitePending[] = [];
  const allyGarrisonRequests: AllyGarrisonRequest[] = [];

  /**
   * Pregame ready gate (new game + restore): true until all ready → playing.
   * Restore-specific satellite / inherit UI uses `inRestoreLobby()`.
   */
  let awaitingReady = true;
  const readyPlayerIds = new Set<string>();

  function inRestoreLobby(): boolean {
    return restoreMode && awaitingReady;
  }
  /** liveId → saveId from auto + manual inherit. */
  let liveToSave = new Map<string, string>();
  /** Manual inherit_identity bindings (preserved across recompute). */
  const manualInherits = new Map<string, string>();
  /** Save roster (immutable ids from document). */
  const savePlayers: SavePlayerSnapshot[] = restoreDoc
    ? structuredClone(restoreDoc.players)
    : [];
  const savePlayerIds = savePlayers.map((p) => p.playerId);
  const saverPlayerId = restoreDoc?.saverPlayerId ?? null;
  /** HUD templates keyed by *current* owner id after remaps. */
  const restoreHudByOwner = new Map<string, PlayerHudState>();
  if (restoreDoc) {
    for (const p of restoreDoc.players) {
      restoreHudByOwner.set(p.playerId, hudFromSavePlayer(p));
    }
  }

  function teamsFrozen(): boolean {
    return buildings.some((b) => b.buildingId === "capital" && b.hp > 0);
  }

  function markTeamMode(): void {
    if (hasMultiPlayerTeam(teams)) teamMode = true;
  }

  /** Union of published comms for viewer + teammates. */
  function teamLinkedIds(viewerId: string): string[] {
    const ids = new Set<string>();
    for (const pid of alliesOf(teams, viewerId)) {
      for (const id of publishedLinks(pid)) ids.add(id);
    }
    return [...ids];
  }

  function unitWorld() {
    return {
      map: MAP,
      terrain,
      buildings,
      liaisons,
      units,
      connectedByOwner,
      teams,
    };
  }

  function purgeAllyRequestsFor(
    opts: { unitId?: string; buildingId?: string; fromPlayerId?: string },
  ): void {
    for (let i = allyGarrisonRequests.length - 1; i >= 0; i--) {
      const r = allyGarrisonRequests[i]!;
      if (opts.unitId && r.unitId === opts.unitId) {
        allyGarrisonRequests.splice(i, 1);
        continue;
      }
      if (opts.buildingId && r.buildingId === opts.buildingId) {
        allyGarrisonRequests.splice(i, 1);
        continue;
      }
      if (opts.fromPlayerId && r.fromPlayerId === opts.fromPlayerId) {
        allyGarrisonRequests.splice(i, 1);
      }
    }
  }

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
/**
 * Per-connection wire baseline: change-only scalars / room layers + last
 * filtered buildings/liaisons (JSON by id) for delta packing.
 */
interface LastSentChangeFields {
  role: SnapshotRole;
  winnerId: string | null;
  winnerName: string | null;
  /** Last pollutionZones payload put on the wire (JSON.stringify). */
  pollutionZonesJson: string;
  /** Last resourceTerrain payload put on the wire (JSON.stringify). */
  resourceTerrainJson: string;
  /** Room tick when buildings+liaisons were last sent as a full array. */
  lastFullEntitiesTick: number;
  /** Last filtered building payloads put on the wire (id → JSON.stringify). */
  buildingsJson: Map<string, string>;
  /** Last filtered liaison payloads put on the wire (id → JSON.stringify). */
  liaisonsJson: Map<string, string>;
}

interface PlayerSession {
  id: string;
  name: string;
  hud: PlayerHudState;
  ws: WebSocket;
  /** Tracks role/winner/entity baseline last put on the wire for this connection. */
  lastSentChange?: LastSentChangeFields;
}

function entityWireJson(entity: { id: string }): string {
  return JSON.stringify(entity);
}

function buildEntityListDelta<T extends { id: string }>(
  current: readonly T[],
  prevJson: Map<string, string> | undefined,
): { delta: SnapshotListDelta<T>; nextJson: Map<string, string> } {
  const nextJson = new Map<string, string>();
  const upserts: T[] = [];
  for (const e of current) {
    const j = entityWireJson(e);
    nextJson.set(e.id, j);
    if (!prevJson || prevJson.get(e.id) !== j) {
      upserts.push(e);
    }
  }
  const removes: string[] = [];
  if (prevJson) {
    for (const id of prevJson.keys()) {
      if (!nextJson.has(id)) removes.push(id);
    }
  }
  return { delta: { upserts, removes }, nextJson };
}

function isEmptyEntityDelta(delta: SnapshotListDelta<{ id: string }>): boolean {
  return delta.upserts.length === 0 && delta.removes.length === 0;
}

/** Active map; set at room creation. */
let MAP: MapConfig = MAP_SIZES[options.mapSize && isMapSizeId(options.mapSize) ? options.mapSize : DEFAULT_MAP_SIZE_ID];
const TICKS_PER_POLLUTION_CAPITAL = ticksPerSeconds(
  POLLUTION_CAPITAL_HP_INTERVAL_SEC,
);

const players = new Map<string, PlayerSession>();
/**
 * Research unlocks/stage progress kept after `leave` so the same playerId can
 * rejoin the room without reseeding an empty research map. Active attempts are
 * cancelled on leave (cannot tick without a seat); unlocks are preserved.
 */
const departedResearchByPlayer = new Map<string, RocketResearchProgressMap>();
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

function createHud(
  research: RocketResearchProgressMap = emptyRocketResearchProgress(),
): PlayerHudState {
  return {
    capitalHp: CAPITAL_HP_MAX,
    capitalHpMax: CAPITAL_HP_MAX,
    energy: STARTING_ENERGY,
    organization: STARTING_ORGANIZATION,
    organizationMax: ORGANIZATION_BAR_MAX,
    research: normalizeRocketResearchProgress(research),
    activeResearch: null,
  };
}

/** Cancel in-flight research without stage++ / refund (same spirit as infra interrupt). */
function cancelActiveResearch(
  player: PlayerSession,
  reason: "leave" | "nuke_uranium_infra",
  detail?: string,
): void {
  const active = player.hud.activeResearch;
  if (!active) return;
  player.hud.activeResearch = null;
  const name = rocketResearchDisplayName(active.buildingId);
  const tip =
    reason === "leave"
      ? `${name}研究失败（离房中断），可重试第 ${active.stage + 1} 阶`
      : `${name}研究失败（铀设施中断），可重试第 ${active.stage + 1} 阶`;
  sendTip(player.ws, tip);
  slog("research", "failed", {
    player: player.id.slice(0, 8),
    buildingId: active.buildingId,
    stage: active.stage,
    reason,
    nextStage: active.stage,
    ...(detail ? { detail } : {}),
  });
}

/** Rebuild HUD (+ research) from a save player row (supports older saves). */
function hudFromSavePlayer(p: SavePlayerSnapshot): PlayerHudState {
  const research = normalizeRocketResearchProgress(
    p.research ?? p.hud.research,
  );
  const activeResearch = normalizeActiveRocketResearch(
    p.activeResearch !== undefined ? p.activeResearch : p.hud.activeResearch,
  );
  return {
    capitalHp: p.hud.capitalHp,
    capitalHpMax: p.hud.capitalHpMax,
    energy: p.hud.energy,
    organization: p.hud.organization,
    organizationMax: p.hud.organizationMax,
    research,
    activeResearch,
  };
}

function packSaveHud(hud: PlayerHudState): SavePlayerSnapshot["hud"] {
  return {
    capitalHp: hud.capitalHp,
    capitalHpMax: hud.capitalHpMax,
    energy: hud.energy,
    organization: hud.organization,
    organizationMax: hud.organizationMax,
    research: { ...hud.research },
    activeResearch: hud.activeResearch ? { ...hud.activeResearch } : null,
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
  if (inRestoreLobby()) return "restore_lobby";
  if (awaitingReady) {
    // New game: pick capital first, then ready_lobby (same ready gate as restore).
    return findPlayerCapital(session.id) ? "ready_lobby" : "pick_capital";
  }
  if (!findPlayerCapital(session.id)) return "pick_capital";
  return "playing";
}

function isRestoreHolder(playerId: string): boolean {
  return (
    inRestoreLobby() &&
    holderPlayerId != null &&
    playerId === holderPlayerId
  );
}

function hasMappedSave(playerId: string): boolean {
  return liveToSave.has(playerId);
}

function canPickCapitalNow(playerId: string): boolean {
  if (!awaitingReady) return !findPlayerCapital(playerId);
  if (inRestoreLobby()) {
    if (isRestoreHolder(playerId)) return false;
    if (spectatorIds.has(playerId)) return false;
  }
  return !findPlayerCapital(playerId);
}

function canAbandonCapitalNow(playerId: string): boolean {
  if (!awaitingReady) return false;
  if (!findPlayerCapital(playerId)) return false;
  if (inRestoreLobby()) {
    // Restore: holder locked; only mapped seats may abandon to re-pick / inherit.
    if (isRestoreHolder(playerId)) return false;
    if (!hasMappedSave(playerId)) return false;
    return true;
  }
  // New-game ready_lobby: abandon + reselect allowed (teamMode only blocks mid-game respawn).
  return true;
}

function buildRestoreIdentities(): RestoreIdentityOption[] {
  if (!inRestoreLobby()) return [];
  const claimed = new Set(liveToSave.values());
  return savePlayers.map((p) => ({
    savePlayerId: p.playerId,
    name: p.name,
    hasCapital: buildings.some(
      (b) => b.ownerId === p.playerId && b.buildingId === "capital" && b.hp > 0,
    ) ||
      // After remap, capital ownerId is live id — check reverse map
      [...liveToSave.entries()].some(
        ([live, save]) =>
          save === p.playerId &&
          buildings.some(
            (b) =>
              b.ownerId === live && b.buildingId === "capital" && b.hp > 0,
          ),
      ),
    claimed: claimed.has(p.playerId),
  }));
}

/** Satellite-only facade for restore_lobby (no direct vision until playing). */
function satelliteFacadeBuildings(): PlacedBuilding[] {
  return buildings
    .filter((b) => {
      // Show all buildings that satellite would see, plus all for restore overview
      return true;
    })
    .map((b) => {
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
    });
}

function satelliteFacadeLiaisons(): PlacedLiaison[] {
  return liaisons.map((line) => ({
    id: line.id,
    kind: line.kind,
    ownerId: line.ownerId,
    nodes: line.nodes.map((n) => ({ ...n })),
    investedE: 0,
    buildTicksRemaining:
      line.kind === "railway" ? line.buildTicksRemaining : 0,
    buildTicksTotal: line.kind === "railway" ? line.buildTicksTotal : 0,
    visionLevel: "satellite" as const,
  }));
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
  if (p === "restore_lobby") {
    sendError(
      session.ws,
      "restore_lobby",
      "读档准备中：仅可选都 / 继承身份 / 准备",
    );
    return true;
  }
  if (p === "ready_lobby") {
    sendError(
      session.ws,
      "ready_lobby",
      "准备中：仅可放弃首都重选 / 准备",
    );
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

/** Full logical snapshot (all fields). Used for room API / packing base. */
function snapshotFor(player: PlayerSession): GameStateSnapshot {
  syncCapitalHud(player);
  const linked = teamLinkedIds(player.id);
  const role: SnapshotRole = spectatorIds.has(player.id) ? "spectator" : "player";
  const restoreLobby = inRestoreLobby();
  const fullVision =
    role === "spectator" || phaseFor(player) === "ended";
  const allSight = terrain ? collectResourceSight(terrain) : [];
  const resourceSight =
    fullVision || restoreLobby
      ? allSight
      : filterResourceSightForViewer(
          allSight,
          player.id,
          buildings,
          units,
          linked,
          teams,
        );
  const myAllyReqs = allyGarrisonRequests.filter((r) => {
    const b = buildings.find((x) => x.id === r.buildingId);
    return b?.ownerId === player.id;
  });
  const myInvites = teamInvites.filter(
    (inv) => inv.toPlayerId === player.id || inv.fromPlayerId === player.id,
  );
  return {
    tick,
    map: MAP,
    you: { ...player.hud },
    buildings: restoreLobby
      ? satelliteFacadeBuildings()
      : fullVision
        ? buildings.map((b) => ({ ...b }))
        : filterBuildingsForViewer(
            buildings,
            player.id,
            liaisons,
            linked,
            units,
            teams,
          ),
    liaisons: restoreLobby
      ? satelliteFacadeLiaisons()
      : fullVision
        ? liaisons.map((l) => ({ ...l, nodes: l.nodes.map((n) => ({ ...n })) }))
        : filterLiaisonsForViewer(
            liaisons,
            buildings,
            player.id,
            linked,
            units,
            teams,
          ),
    units: restoreLobby
      ? [] // satellite lobby: buildings/liaisons only; units reveal after playing
      : fullVision
        ? units.map((u) => ({ ...u }))
        : filterUnitsForViewer(units, player.id, buildings, linked, teams),
    connectedBuildingIds: restoreLobby ? [] : linked,
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
    winnerTeamId,
    winnerPlayerIds,
    winnerNames,
    teams: { ...teams },
    teamMode,
    teamInvites: myInvites.map((i) => ({ ...i })),
    allyGarrisonRequests: myAllyReqs.map((r) => ({ ...r })),
    ready: readyPlayerIds.has(player.id),
    readyPlayerIds: [...readyPlayerIds],
    restoreMode: restoreLobby,
    restoreHolder: isRestoreHolder(player.id),
    mappedSaveId: liveToSave.get(player.id) ?? null,
    canPickCapital: canPickCapitalNow(player.id),
    canAbandonCapital: canAbandonCapitalNow(player.id),
    restoreIdentities: buildRestoreIdentities(),
  };
}

/**
 * Pack a wire `state` payload.
 * - bootstrap (join / re-enter): include map / terrainSeed / allowRespawn +
 *   current role / winner* / pollutionZones / resourceTerrain + full
 *   buildings / liaisons
 * - regular ticks: omit bootstrap fields; role / winner* / pollutionZones /
 *   resourceTerrain only when changed vs lastSentChange; buildings /
 *   liaisons as delta vs last sent filtered set, with a full refresh every
 *   TICKS_PER_10S of simulation since last full
 */
function packWireSnapshot(
  player: PlayerSession,
  opts: { bootstrap: boolean },
): GameStateSnapshot {
  const full = snapshotFor(player);
  const role = full.role ?? "player";
  const winId = full.winnerId ?? null;
  const winName = full.winnerName ?? null;
  const buildings = full.buildings ?? [];
  const liaisons = full.liaisons ?? [];
  const pollutionZones = full.pollutionZones ?? [];
  const resourceTerrain = full.resourceTerrain ?? { cleared: [], deposits: [] };
  const pollutionZonesJson = JSON.stringify(pollutionZones);
  const resourceTerrainJson = JSON.stringify(resourceTerrain);

  const out: GameStateSnapshot = { ...full };

  if (!opts.bootstrap) {
    delete out.map;
    delete out.terrainSeed;
    delete out.allowRespawn;
  }

  const prev = player.lastSentChange;
  const sendRole = opts.bootstrap || !prev || prev.role !== role;
  const sendWinner =
    opts.bootstrap ||
    !prev ||
    prev.winnerId !== winId ||
    prev.winnerName !== winName;
  const sendPollution =
    opts.bootstrap || !prev || prev.pollutionZonesJson !== pollutionZonesJson;
  const sendResourceTerrain =
    opts.bootstrap ||
    !prev ||
    prev.resourceTerrainJson !== resourceTerrainJson;

  if (!sendRole) delete out.role;
  if (!sendWinner) {
    delete out.winnerId;
    delete out.winnerName;
  }
  if (!sendPollution) delete out.pollutionZones;
  else out.pollutionZones = pollutionZones;
  if (!sendResourceTerrain) delete out.resourceTerrain;
  else out.resourceTerrain = resourceTerrain;

  const forceFullEntities =
    opts.bootstrap ||
    !prev ||
    tick - prev.lastFullEntitiesTick >= TICKS_PER_10S;

  let buildingsJson: Map<string, string>;
  let liaisonsJson: Map<string, string>;
  let lastFullEntitiesTick: number;

  if (forceFullEntities) {
    delete out.buildingsDelta;
    delete out.liaisonsDelta;
    out.buildings = buildings;
    out.liaisons = liaisons;
    buildingsJson = new Map(buildings.map((b) => [b.id, entityWireJson(b)]));
    liaisonsJson = new Map(liaisons.map((l) => [l.id, entityWireJson(l)]));
    lastFullEntitiesTick = tick;
  } else {
    delete out.buildings;
    delete out.liaisons;
    const bPack = buildEntityListDelta(buildings, prev.buildingsJson);
    const lPack = buildEntityListDelta(liaisons, prev.liaisonsJson);
    if (isEmptyEntityDelta(bPack.delta)) delete out.buildingsDelta;
    else out.buildingsDelta = bPack.delta;
    if (isEmptyEntityDelta(lPack.delta)) delete out.liaisonsDelta;
    else out.liaisonsDelta = lPack.delta;
    buildingsJson = bPack.nextJson;
    liaisonsJson = lPack.nextJson;
    lastFullEntitiesTick = prev.lastFullEntitiesTick;
  }

  player.lastSentChange = {
    role,
    winnerId: winId,
    winnerName: winName,
    pollutionZonesJson,
    resourceTerrainJson,
    lastFullEntitiesTick,
    buildingsJson,
    liaisonsJson,
  };
  return out;
}

function send(ws: WebSocket, msg: ServerToClient): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    slog("send", "skip, readyState=", ws.readyState, msg.type);
  }
}

/**
 * Authoritative snapshot for one player (includes you.energy / you.organization).
 * E/O are never sent as deltas — always the current absolute balances.
 * Regular ticks omit bootstrap-only / unchanged change-only fields
 * (role / winner* / pollutionZones / resourceTerrain), and pack
 * buildings/liaisons as deltas (full refresh every ~10s).
 */
function sendPlayerState(player: PlayerSession, state?: GameStateSnapshot): void {
  send(player.ws, {
    type: "state",
    state: state ?? packWireSnapshot(player, { bootstrap: false }),
  });
}

function broadcastState(): void {
  for (const player of players.values()) {
    sendPlayerState(player);
  }
}

/** Join / rejoin: push bootstrap fields + current E/O immediately. */
function syncPlayerOnJoin(player: PlayerSession): GameStateSnapshot {
  // Re-enter: always re-send bootstrap + change fields as if first contact.
  player.lastSentChange = undefined;
  const state = packWireSnapshot(player, { bootstrap: true });
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

/** Every COMM_WAVE_INTERVAL_TICKS (~COMM_WAVE_INTERVAL_SEC wall-clock): restart
 *  diffusion from each capital. Published comms state is left untouched until
 *  the wave finishes.
 */
function beginCommWaves(): void {
  const owners = new Set<string>();
  for (const b of buildings) {
    if (b.buildingId === "capital") owners.add(b.ownerId);
  }
  for (const ownerId of owners) {
    const existing = commWaves.get(ownerId);
    if (existing && !existing.done) continue;
    const wave = startCommWave(
      ownerId,
      buildings,
      liaisons,
      publishedLinks(ownerId),
      teams,
    );
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
  winnerTeamId = null;
  winnerPlayerIds = null;
  winnerNames = null;
  allyGarrisonRequests.length = 0;
  teamInvites.length = 0;
  sawMultipleCapitals = false;
  const seed = parseTerrainSeed(seedRaw);
  terrain = generateTerrain({ map: MAP, seed });
  phase = inRestoreLobby() ? "restore_lobby" : "pick_capital";
  tick = 0;
  slog("init", "room terrain", {
    roomId,
    seed: terrain.seed,
    map: MAP.id,
    deposits: terrain.deposits.length,
  });
}

function applyRestoreDocument(doc: SaveDocument): void {
  MAP = MAP_SIZES[isMapSizeId(doc.mapSize) ? doc.mapSize : DEFAULT_MAP_SIZE_ID];
  generateRoomTerrain(doc.terrainSeed);
  const world = cloneSaveWorld(doc);
  buildings.length = 0;
  buildings.push(...world.buildings);
  liaisons.length = 0;
  liaisons.push(...world.liaisons);
  units.length = 0;
  units.push(...world.units);
  pollutionZones.length = 0;
  pollutionZones.push(...world.pollutionZones);
  connectedByOwner.clear();
  for (const [k, v] of world.connectedByOwner) {
    connectedByOwner.set(k, v);
  }
  knownCapitalOwners.clear();
  for (const id of world.knownCapitalOwners) knownCapitalOwners.add(id);
  spectatorIds.clear();
  for (const id of world.spectatorIds) spectatorIds.add(id);
  teams = world.teams;
  teamMode = !!doc.teamMode || hasMultiPlayerTeam(teams);
  tick = doc.tick;
  phase = "restore_lobby";
  awaitingReady = true;
  if (terrain) {
    applyResourceTerrainSync(terrain, doc.resourceTerrain);
    clearedResourceCells.clear();
    for (const c of doc.resourceTerrain.cleared) {
      clearedResourceCells.add(`${c.x},${c.y}`);
    }
  }
  restoreHudByOwner.clear();
  for (const p of doc.players) {
    restoreHudByOwner.set(p.playerId, hudFromSavePlayer(p));
  }
  syncPollutionFlags();
  noteCapitalCounts();
  slog("restore", "applied save", {
    roomId,
    tick,
    buildings: buildings.length,
    players: doc.players.length,
    saver: doc.saverPlayerId.slice(0, 8),
  });
}

/**
 * Apply newly discovered live→save bindings by remapping world owners.
 * Returns save ids that were newly bound this call.
 */
function applyIdMapDelta(next: Map<string, string>): string[] {
  const newly: string[] = [];
  for (const [live, save] of next) {
    const prev = liveToSave.get(live);
    if (prev === save) continue;
    // Remap world from save id (or previous live that held save assets) → live
    const fromId = prev ?? save;
    if (fromId !== live) {
      remapOwnerId(fromId, live, {
        buildings,
        liaisons,
        units,
        connectedByOwner,
        knownCapitalOwners,
        spectatorIds,
        teams,
      });
      const hud = restoreHudByOwner.get(fromId) ?? restoreHudByOwner.get(save);
      if (hud) {
        restoreHudByOwner.delete(fromId);
        restoreHudByOwner.set(live, { ...hud });
      }
    }
    newly.push(save);
  }
  liveToSave = next;
  return newly;
}

function refreshPlayerMapping(): void {
  if (!restoreMode || !saverPlayerId || !holderPlayerId) return;
  const next = recomputeIdMap({
    holderPlayerId,
    saverPlayerId,
    liveIds: [...players.keys()],
    savePlayerIds,
    manual: manualInherits,
  });
  applyIdMapDelta(next);
  // Apply HUD / spectator for mapped seated players
  for (const [live, save] of liveToSave) {
    const session = players.get(live);
    if (!session) continue;
    const hud = restoreHudByOwner.get(live) ?? restoreHudByOwner.get(save);
    if (hud) {
      session.hud = { ...hud };
      syncCapitalHud(session);
    }
    const saveSnap = savePlayers.find((p) => p.playerId === save);
    if (saveSnap?.spectator) {
      spectatorIds.add(live);
    }
  }
}

function tryStartPlayingFromLobby(): void {
  if (!awaitingReady) return;
  // Allow solo custom rooms (1/1 ready). Matchmaking still forms ≥2-seat rooms.
  if (players.size < 1) return;
  for (const p of players.values()) {
    if (!readyPlayerIds.has(p.id)) return;
    if (spectatorIds.has(p.id)) continue;
    if (isRestoreHolder(p.id)) continue;
    if (!findPlayerCapital(p.id)) return;
  }
  awaitingReady = false;
  phase = "playing";
  beginCommWaves();
  advanceCommWaves();
  noteCapitalCounts();
  slog(restoreMode ? "restore" : "ready", "all ready → playing", {
    players: players.size,
    tick,
  });
  broadcastState();
}

function handleSetReady(session: PlayerSession, ready: boolean): void {
  if (!awaitingReady) {
    sendError(session.ws, "not_ready_lobby", "仅开局准备阶段可切换准备状态");
    return;
  }
  if (ready) {
    if (
      !isRestoreHolder(session.id) &&
      !spectatorIds.has(session.id) &&
      !findPlayerCapital(session.id)
    ) {
      sendError(session.ws, "need_capital", "请先选定或继承首都后再准备");
      return;
    }
    readyPlayerIds.add(session.id);
  } else {
    readyPlayerIds.delete(session.id);
  }
  touchInteraction();
  tryStartPlayingFromLobby();
  if (awaitingReady) broadcastState();
}

function handleInheritIdentity(
  session: PlayerSession,
  savePlayerId: string,
): void {
  if (!inRestoreLobby()) {
    sendError(session.ws, "not_restore_lobby", "仅读档准备阶段可继承身份");
    return;
  }
  if (isRestoreHolder(session.id)) {
    sendError(session.ws, "holder_locked", "存档持有者已继承保存人，无法更换");
    return;
  }
  if (!savePlayerIds.includes(savePlayerId)) {
    sendError(session.ws, "bad_identity", "存档中无此玩家");
    return;
  }
  if (savePlayerId === saverPlayerId) {
    sendError(session.ws, "identity_taken", "保存人身份已由持有者占用");
    return;
  }
  if ([...liveToSave.values()].includes(savePlayerId)) {
    sendError(session.ws, "identity_taken", "该存档身份已被占用");
    return;
  }
  if (liveToSave.has(session.id)) {
    sendError(
      session.ws,
      "already_mapped",
      "已继承身份；可先放弃首都后再选其他身份",
    );
    return;
  }
  manualInherits.set(session.id, savePlayerId);
  refreshPlayerMapping();
  readyPlayerIds.delete(session.id);
  touchInteraction();
  broadcastState();
}

function handleAbandonCapital(session: PlayerSession): void {
  if (!canAbandonCapitalNow(session.id)) {
    sendError(session.ws, "cannot_abandon", "当前无法放弃首都");
    return;
  }
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i]!;
    if (b.ownerId === session.id && b.buildingId === "capital") {
      buildings.splice(i, 1);
    }
  }
  knownCapitalOwners.delete(session.id);
  connectedByOwner.delete(session.id);
  // Unbind mapping so they may inherit another identity or place new capital
  const saveId = liveToSave.get(session.id);
  if (saveId) {
    manualInherits.delete(session.id);
    liveToSave.delete(session.id);
    // Return remaining assets ownership to save id for others to claim
    remapOwnerId(session.id, saveId, {
      buildings,
      liaisons,
      units,
      connectedByOwner,
      knownCapitalOwners,
      spectatorIds,
      teams,
    });
    const hud = restoreHudByOwner.get(session.id);
    if (hud) {
      restoreHudByOwner.delete(session.id);
      restoreHudByOwner.set(saveId, hud);
    }
  }
  session.hud = createHud();
  readyPlayerIds.delete(session.id);
  refreshPlayerMapping();
  touchInteraction();
  broadcastState();
}

function buildExportDocument(requesterId: string): SaveDocument | null {
  const session = players.get(requesterId);
  if (!session || closed || !terrain) return null;
  const connected: Record<string, string[]> = {};
  for (const [oid, set] of connectedByOwner) {
    connected[oid] = [...set];
  }
  return {
    formatVersion: SAVE_FORMAT_VERSION,
    gameVersion: gameVersionStamp,
    savedAt: Date.now(),
    saverPlayerId: session.id,
    saverName: session.name,
    roomId,
    mapSize: MAP.id,
    maxPlayers,
    terrainSeed: terrain.seed,
    tick,
    allowRespawn,
    teamMode,
    teams: { ...teams },
    buildings: structuredClone(buildings),
    liaisons: structuredClone(liaisons),
    units: structuredClone(units),
    pollutionZones: structuredClone(pollutionZones),
    resourceTerrain: collectResourceTerrainSync(terrain, clearedResourceCells),
    connectedByOwner: connected,
    knownCapitalOwners: [...knownCapitalOwners],
    spectatorIds: [...spectatorIds],
    players: [...players.values()].map((p) => ({
      playerId: p.id,
      name: p.name,
      hud: packSaveHud(p.hud),
      spectator: spectatorIds.has(p.id),
      research: { ...p.hud.research },
      activeResearch: p.hud.activeResearch
        ? { ...p.hud.activeResearch }
        : null,
    })),
  };
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
  if (spectatorIds.has(session.id)) {
    sendError(
      session.ws,
      "spectating",
      teamMode ? "组队模式首都沦陷后不可重新选都" : "观战中无法重新选都",
    );
    return;
  }
  if (inRestoreLobby() && isRestoreHolder(session.id)) {
    sendError(session.ws, "holder_no_pick", "存档持有者无需选都，请直接准备");
    return;
  }
  if (findPlayerCapital(session.id)) {
    sendError(session.ws, "already_capital", "已经选定首都");
    return;
  }

  const node = snapToBuildNode(gx, gy, MAP);
  const occupiedEarly = findBuildingAt(buildings, node.gx, node.gy);
  // Restore lobby: clicking an unclaimed capital inherits that identity
  if (
    inRestoreLobby() &&
    occupiedEarly &&
    occupiedEarly.buildingId === "capital" &&
    !liveToSave.has(session.id) &&
    !isRestoreHolder(session.id)
  ) {
    const saveId =
      [...liveToSave.entries()].find(
        ([live]) => live === occupiedEarly.ownerId,
      )?.[1] ??
      (savePlayerIds.includes(occupiedEarly.ownerId)
        ? occupiedEarly.ownerId
        : null);
    if (saveId && ![...liveToSave.values()].includes(saveId)) {
      handleInheritIdentity(session, saveId);
      return;
    }
  }

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
  spectatorIds.delete(session.id);
  knownCapitalOwners.add(session.id);
  touchInteraction();
  noteCapitalCounts();

  if (awaitingReady) {
    readyPlayerIds.delete(session.id);
    slog("capital", "placed (ready lobby)", {
      player: session.id.slice(0, 8),
      restore: restoreMode,
      node,
    });
    broadcastState();
    return;
  }

  // Mid-game re-pick (allowRespawn): enter playing immediately for this seat.
  if (phase !== "playing") tick = 0;
  phase = "playing";
  beginCommWaves();
  advanceCommWaves();

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

  if (
    isRocketResearchTarget(buildingId) &&
    !isRocketBuildUnlocked(session.hud.research, buildingId)
  ) {
    sendError(
      session.ws,
      "research_locked",
      `${def.name}尚未研究解锁`,
    );
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

  // Land building already on open sea (ex-island platform): allow upgrades with the
  // same medium-or-smaller / no-sea-only constraints; skip ocean ground reject.
  const seaPlatform =
    !!islandToReplace ||
    (!!existing &&
      ground === "ocean" &&
      !BUILDING_BY_ID[existing.buildingId]?.flags?.seaOnly);

  if (seaPlatform) {
    if (def.flags?.seaOnly) {
      sendError(session.ws, "invalid_on_island", "人工岛上不能建造海上建筑");
      return;
    }
    if ((def.size ?? "small") === "large") {
      sendError(session.ws, "too_large_for_island", "人工岛上只能建造中型及以下建筑");
      return;
    }
  }

  if (!seaPlatform && !canPlaceBuildingDef(def, ground)) {
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

function tryResearchBuilding(session: PlayerSession, buildingId: string): void {
  if (rejectIfNotPlaying(session)) return;

  slog("research", "request", {
    player: session.id.slice(0, 8),
    buildingId,
    E: session.hud.energy,
    O: session.hud.organization,
    research: session.hud.research,
    active: session.hud.activeResearch,
  });

  const check = canStartRocketResearch({
    buildingId,
    progress: session.hud.research,
    activeResearch: session.hud.activeResearch,
    energy: session.hud.energy,
    organization: session.hud.organization,
    buildings,
    ownerId: session.id,
    terrain,
    connectedIds: publishedLinks(session.id),
  });
  if (!check.ok) {
    sendError(session.ws, check.reason, check.message);
    return;
  }

  session.hud.energy -= check.stage.energy;
  session.hud.organization -= check.stage.organization;
  const entry = getRocketResearchEntry(session.hud.research, check.buildingId);
  session.hud.research = {
    ...session.hud.research,
    [check.buildingId]: entry,
  };
  session.hud.activeResearch = {
    buildingId: check.buildingId,
    stage: check.stageIndex,
    endsAtTick: tick + check.durationTicks,
  };

  const name = rocketResearchDisplayName(check.buildingId);
  sendTip(
    session.ws,
    `开始研究${name} · 第 ${check.stageIndex + 1} 阶 · ${check.stage.energy}E ${check.stage.organization}O · ${check.stage.chancePercent}%`,
  );
  slog("research", "started", {
    player: session.id.slice(0, 8),
    buildingId: check.buildingId,
    stage: check.stageIndex,
    endsAtTick: session.hud.activeResearch.endsAtTick,
    durationTicks: check.durationTicks,
  });
  broadcastState();
}

/**
 * Nuke research: re-check uranium infra every 5s (and at completion). Gate fail
 * clears the attempt without stage++ (no E/O refund; same stage retryable).
 * Otherwise resolve timed attempts whose endsAtTick has arrived.
 */
function advanceRocketResearch(): void {
  for (const player of players.values()) {
    const active = player.hud.activeResearch;
    if (!active) continue;

    if (active.buildingId === "nuke_missile") {
      const dueInfraCheck =
        tick >= active.endsAtTick ||
        tick % NUKE_RESEARCH_INFRA_CHECK_INTERVAL_TICKS === 0;
      if (dueInfraCheck) {
        const infraMsg = nukeUraniumInfraRejectReason(
          buildings,
          player.id,
          terrain,
          publishedLinks(player.id),
          "research",
        );
        if (infraMsg) {
          cancelActiveResearch(player, "nuke_uranium_infra", infraMsg);
          continue;
        }
      }
    }

    if (tick < active.endsAtTick) continue;

    player.hud.activeResearch = null;
    const entry = getRocketResearchEntry(player.hud.research, active.buildingId);
    if (entry.unlocked) continue;

    const stageDef = getRocketResearchStages(active.buildingId)[active.stage];
    if (!stageDef) continue;

    const success = rollRocketResearchSuccess(
      stageDef.chancePercent,
      Math.random(),
    );
    const next = applyRocketResearchOutcome(
      active.buildingId,
      { stage: active.stage, unlocked: false },
      success,
    );
    player.hud.research = {
      ...player.hud.research,
      [active.buildingId]: next,
    };

    const name = rocketResearchDisplayName(active.buildingId);
    if (success) {
      sendTip(player.ws, `${name}研究成功，已解锁`);
    } else {
      const nextStage = getNextRocketResearchStage(active.buildingId, next);
      sendTip(
        player.ws,
        nextStage
          ? `${name}研究失败，进入第 ${next.stage + 1} 阶（${nextStage.chancePercent}%）`
          : `${name}研究失败`,
      );
    }
    slog("research", "resolved", {
      player: player.id.slice(0, 8),
      buildingId: active.buildingId,
      stage: active.stage,
      success,
      unlocked: next.unlocked,
      nextStage: next.stage,
    });
  }
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
    teamMode,
  });
  clearPlayerWorld(ownerId);
  purgeAllyRequestsFor({ fromPlayerId: ownerId });
  // Team mode: always spectate (no capital re-pick), ignoring allowRespawn.
  if (!teamMode && allowRespawn) {
    spectatorIds.delete(ownerId);
    if (owner) {
      // Per-match research unlocks persist across capital respawn.
      const research = { ...owner.hud.research };
      owner.hud = createHud();
      owner.hud.research = research;
      owner.hud.activeResearch = null;
    }
  } else {
    spectatorIds.add(ownerId);
    if (owner) {
      owner.hud.capitalHp = 0;
      owner.hud.activeResearch = null;
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
  if (owners.length === 0) return;

  const livingTeams = new Set(owners.map((id) => teamIdOf(teams, id)));
  if (livingTeams.size !== 1) return;

  const winningTeam = [...livingTeams][0]!;
  const winIds = [...players.keys()].filter(
    (id) => teamIdOf(teams, id) === winningTeam,
  );
  // Prefer a living capital owner as primary winnerId for back-compat.
  const primary =
    owners.find((id) => teamIdOf(teams, id) === winningTeam) ?? winIds[0]!;
  const winNames = winIds.map(
    (id) => players.get(id)?.name ?? id.slice(0, 8),
  );
  winnerId = primary;
  winnerName = players.get(primary)?.name ?? primary.slice(0, 8);
  winnerTeamId = winningTeam;
  winnerPlayerIds = winIds;
  winnerNames = winNames;
  phase = "ended";
  slog("game_over", roomId, winnerId, winnerName, "team=", winningTeam);
  const payload = {
    type: "game_over" as const,
    roomId,
    winnerId,
    winnerName,
    winnerTeamId: winningTeam,
    winnerPlayerIds: winIds,
    winnerNames: winNames,
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

function handleTeamInvite(session: PlayerSession, toPlayerId: string): void {
  if (teamsFrozen()) {
    sendError(session.ws, "teams_frozen", "已有首都放置，无法改队");
    return;
  }
  if (players.size < 3) {
    sendError(session.ws, "team_need_3", "房间人数不足 3，无法组队");
    return;
  }
  if (!players.has(toPlayerId) || toPlayerId === session.id) {
    sendError(session.ws, "bad_invite", "邀请目标无效");
    return;
  }
  if (sameTeam(teams, session.id, toPlayerId)) {
    sendError(session.ws, "already_teammates", "已是队友");
    return;
  }
  const exists = teamInvites.some(
    (i) => i.fromPlayerId === session.id && i.toPlayerId === toPlayerId,
  );
  if (exists) {
    sendError(session.ws, "invite_pending", "邀请已发送");
    return;
  }
  teamInvites.push({ fromPlayerId: session.id, toPlayerId });
  const target = players.get(toPlayerId);
  if (target) {
    send(target.ws, {
      type: "team_invite_pending",
      fromPlayerId: session.id,
      fromName: session.name,
      toPlayerId,
    });
  }
  broadcastState();
}

function handleTeamInviteAccept(session: PlayerSession, fromPlayerId: string): void {
  if (teamsFrozen()) {
    sendError(session.ws, "teams_frozen", "已有首都放置，无法改队");
    return;
  }
  const idx = teamInvites.findIndex(
    (i) => i.fromPlayerId === fromPlayerId && i.toPlayerId === session.id,
  );
  if (idx < 0) {
    sendError(session.ws, "no_invite", "没有待处理邀请");
    return;
  }
  teamInvites.splice(idx, 1);
  let tid = teams[fromPlayerId];
  if (!tid) {
    tid = `c-${fromPlayerId.slice(0, 8)}`;
    teams[fromPlayerId] = tid;
  }
  teams[session.id] = tid;
  markTeamMode();
  // Drop other invites involving accepter joining elsewhere
  for (let i = teamInvites.length - 1; i >= 0; i--) {
    const inv = teamInvites[i]!;
    if (inv.toPlayerId === session.id || inv.fromPlayerId === session.id) {
      teamInvites.splice(i, 1);
    }
  }
  slog("team", "accept", session.id.slice(0, 8), "→", tid);
  broadcastState();
}

function handleTeamInviteReject(session: PlayerSession, fromPlayerId: string): void {
  const idx = teamInvites.findIndex(
    (i) => i.fromPlayerId === fromPlayerId && i.toPlayerId === session.id,
  );
  if (idx >= 0) teamInvites.splice(idx, 1);
  broadcastState();
}

function handleTeamLeave(session: PlayerSession): void {
  if (teamsFrozen()) {
    sendError(session.ws, "teams_frozen", "已有首都放置，无法改队");
    return;
  }
  delete teams[session.id];
  for (let i = teamInvites.length - 1; i >= 0; i--) {
    const inv = teamInvites[i]!;
    if (inv.fromPlayerId === session.id || inv.toPlayerId === session.id) {
      teamInvites.splice(i, 1);
    }
  }
  // Keep teamMode sticky once enabled
  broadcastState();
}

function handleAllyGarrisonRequest(
  session: PlayerSession,
  unitId: string,
  buildingId: string,
): void {
  if (rejectIfNotPlaying(session)) return;
  const unit = units.find((u) => u.id === unitId);
  if (!unit || unit.ownerId !== session.id) {
    sendError(session.ws, "bad_unit", "单位不存在或不属于你");
    return;
  }
  const building = buildings.find((b) => b.id === buildingId);
  if (!building) {
    sendError(session.ws, "bad_building", "建筑不存在");
    return;
  }
  if (building.ownerId === session.id) {
    sendError(session.ws, "use_assign_home", "己方建筑请用部署归属");
    return;
  }
  if (!sameTeam(teams, session.id, building.ownerId)) {
    sendError(session.ws, "not_ally", "仅可申请进驻友方建筑");
    return;
  }
  const dup = allyGarrisonRequests.some(
    (r) => r.unitId === unitId && r.buildingId === buildingId,
  );
  if (dup) {
    sendError(session.ws, "request_pending", "已有相同进驻申请");
    return;
  }
  const req: AllyGarrisonRequest = {
    id: randomUUID(),
    fromPlayerId: session.id,
    unitId,
    buildingId,
    unitKind: unit.kind,
    unitU: unit.u,
    createdAt: Date.now(),
  };
  allyGarrisonRequests.push(req);
  slog("ally_garrison", "request", req.id.slice(0, 8), session.id.slice(0, 8));
  broadcastState();
}

function handleAllyGarrisonAccept(
  session: PlayerSession,
  requestId: string,
): void {
  if (rejectIfNotPlaying(session)) return;
  const idx = allyGarrisonRequests.findIndex((r) => r.id === requestId);
  if (idx < 0) {
    sendError(session.ws, "no_request", "申请不存在");
    return;
  }
  const req = allyGarrisonRequests[idx]!;
  const building = buildings.find((b) => b.id === req.buildingId);
  if (!building || building.ownerId !== session.id) {
    allyGarrisonRequests.splice(idx, 1);
    sendError(session.ws, "not_owner", "只能审批己方建筑的进驻申请");
    broadcastState();
    return;
  }
  const result = applyAllyGarrisonDeposit(
    req.fromPlayerId,
    session.id,
    req.unitId,
    req.buildingId,
    buildings,
    units,
    teams,
  );
  allyGarrisonRequests.splice(idx, 1);
  if (!result.ok) {
    sendError(session.ws, "ally_garrison_fail", result.error ?? "进驻失败");
    broadcastState();
    return;
  }
  buildings.length = 0;
  buildings.push(...result.buildings);
  units.length = 0;
  units.push(...result.units);
  purgeAllyRequestsFor({ unitId: req.unitId });
  slog("ally_garrison", "accept", requestId.slice(0, 8));
  broadcastState();
}

function handleAllyGarrisonReject(
  session: PlayerSession,
  requestId: string,
): void {
  const idx = allyGarrisonRequests.findIndex((r) => r.id === requestId);
  if (idx < 0) return;
  const req = allyGarrisonRequests[idx]!;
  const building = buildings.find((b) => b.id === req.buildingId);
  if (!building || building.ownerId !== session.id) {
    sendError(session.ws, "not_owner", "只能审批己方建筑的进驻申请");
    return;
  }
  allyGarrisonRequests.splice(idx, 1);
  broadcastState();
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

  if (msg.type === "team_invite") {
    handleTeamInvite(session, msg.toPlayerId);
    return;
  }
  if (msg.type === "team_invite_accept") {
    handleTeamInviteAccept(session, msg.fromPlayerId);
    return;
  }
  if (msg.type === "team_invite_reject") {
    handleTeamInviteReject(session, msg.fromPlayerId);
    return;
  }
  if (msg.type === "team_leave") {
    handleTeamLeave(session);
    return;
  }
  if (msg.type === "ally_garrison_request") {
    handleAllyGarrisonRequest(session, msg.unitId, msg.buildingId);
    return;
  }
  if (msg.type === "ally_garrison_accept") {
    handleAllyGarrisonAccept(session, msg.requestId);
    return;
  }
  if (msg.type === "ally_garrison_reject") {
    handleAllyGarrisonReject(session, msg.requestId);
    return;
  }

  if (msg.type === "set_ready") {
    handleSetReady(session, !!msg.ready);
    return;
  }
  if (msg.type === "inherit_identity") {
    handleInheritIdentity(session, String(msg.savePlayerId ?? ""));
    return;
  }
  if (msg.type === "abandon_capital") {
    handleAbandonCapital(session);
    return;
  }
  if (msg.type === "export_save") {
    // Manager intercepts export_save for encryption; core ignores if forwarded.
    sendError(session.ws, "export_via_manager", "请通过大厅导出存档");
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

  if (msg.type === "research_building") {
    slog("msg", "research_building", msg.buildingId);
    tryResearchBuilding(session, String(msg.buildingId ?? ""));
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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
      unitWorld(),
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


  // Room-driven map generation at create time (or restore from save).
  if (restoreDoc) {
    applyRestoreDocument(restoreDoc);
  } else {
    generateRoomTerrain(options.seed);
  }
  touchInteraction();

  function tickRoom(): void {
    if (closed) return;
    if (winnerId) {
      broadcastState();
      return;
    }
    // Pregame / restore lobby: no sim ticks until all ready → playing
    if (awaitingReady) {
      broadcastState();
      if (isIdleNow()) {
        destroyRoom("idle");
      }
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
    advanceRocketResearch();
    advancePollutionCapitalDamage();
    if (tick % COMM_WAVE_INTERVAL_TICKS === 0) {
      beginCommWaves();
    }
    advanceCommWaves();
    simulateEconomy();
    advanceUnitTraining(unitWorld());
    advanceUnitMovement(unitWorld());
    {
      const aaEvents = advanceUnitAntiAir(unitWorld(), tick);
      if (aaEvents.length > 0) notifyAaAmmoEvents(aaEvents);
    }
    {
      const energyAvail = new Map<string, number>();
      for (const [pid, p] of players) {
        energyAvail.set(pid, p.hud.energy);
      }
      const world = unitWorld();
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
    // Full snapshot each tick includes absolute you.energy / you.organization.
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
    departedResearchByPlayer.clear();
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
        if (inRestoreLobby()) refreshPlayerMapping();
        const state = syncPlayerOnJoin(existing);
        return { ok: true, playerId: existing.id, state };
      }
      if (players.size >= maxPlayers) {
        return { ok: false, code: "room_full", message: "房间已满" };
      }
      if (!awaitingReady && restoreMode) {
        // After restore match started, reject brand-new seats (rejoin OK above).
        return { ok: false, code: "restore_started", message: "读档对局已开始，无法加入" };
      }
      const stashed = departedResearchByPlayer.get(opts.playerId);
      if (stashed) departedResearchByPlayer.delete(opts.playerId);
      const session: PlayerSession = {
        id: opts.playerId,
        name: (opts.name || `Player-${opts.playerId.slice(0, 4)}`).slice(0, 24),
        // Rejoin after leave: restore unlocks/stage; active attempt stays cleared.
        hud: createHud(stashed),
        ws: makeSocket(opts.send),
      };
      players.set(session.id, session);
      touchInteraction();
      if (awaitingReady) {
        if (inRestoreLobby()) refreshPlayerMapping();
        readyPlayerIds.delete(session.id);
      }
      const state = syncPlayerOnJoin(session);
      if (awaitingReady) broadcastState();
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
      const session = players.get(playerId);
      if (!session) return;
      // World entities stay; research unlocks/stage must survive rejoin too.
      // In-flight attempt cannot advance without a seat → cancel (no stage++).
      cancelActiveResearch(session, "leave");
      departedResearchByPlayer.set(
        playerId,
        normalizeRocketResearchProgress(session.hud.research),
      );
      players.delete(playerId);
      delete teams[playerId];
      readyPlayerIds.delete(playerId);
      manualInherits.delete(playerId);
      liveToSave.delete(playerId);
      purgeAllyRequestsFor({ fromPlayerId: playerId });
      for (let i = teamInvites.length - 1; i >= 0; i--) {
        const inv = teamInvites[i]!;
        if (inv.fromPlayerId === playerId || inv.toPlayerId === playerId) {
          teamInvites.splice(i, 1);
        }
      }
      slog("conn", "leave", roomId, playerId.slice(0, 8), "players=", players.size);
      emit({ type: "player_left", roomId, playerId });
      if (inRestoreLobby()) refreshPlayerMapping();
      if (!closed) broadcastState();
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
    exportPlainSave(requesterId: string): SaveDocument | null {
      return buildExportDocument(requesterId);
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
