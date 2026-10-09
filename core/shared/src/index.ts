/** Server-authoritative broadcast rate (10–20 Hz). */
export const TICK_HZ = 15;
export const TICK_MS = 1000 / TICK_HZ;

export type { MapConfig, MapSizeId } from "./map.js";
export {
  MAP_SIZES,
  MAP_SIZE_OPTIONS,
  DEFAULT_MAP_SIZE_ID,
  isMapSizeId,
} from "./map.js";

export const ORGANIZATION_BAR_MAX = 50;
export const CAPITAL_HP_MAX = 60;

/** 规则开局：O = 10，E = 500 */
export const STARTING_ENERGY = 500;
export const STARTING_ORGANIZATION = 10;

export type GamePhase =
  | "need_init"
  | "pick_capital"
  | "ready_lobby"
  | "restore_lobby"
  | "playing"
  | "spectating"
  | "ended";

export type {
  SaveDocument,
  SavePlayerSnapshot,
  SavePlayerHud,
  RestoreIdentityOption,
} from "./save.js";
export {
  SAVE_FORMAT_VERSION,
  WOPSAVE_MAGIC,
  WOPSAVE_IV_BYTES,
  WOPSAVE_TAG_BYTES,
  isSaveDocument,
} from "./save.js";

export type SnapshotRole = "player" | "spectator";

export type {
  TeamFormat,
  TeamRoster,
  AllyGarrisonRequest,
  TeamInvitePending,
} from "./teams.js";
export {
  TEAM_FORMATS,
  isTeamFormat,
  formatTeamSizes,
  formatSeatCount,
  teamIdOf,
  sameTeam,
  isFriendly,
  alliesOf,
  teamMemberSet,
  hasMultiPlayerTeam,
  assignRandomTeams,
} from "./teams.js";

/**
 * Per-player HUD in `GameStateSnapshot.you`.
 * `energy` / `organization` are server-authoritative balances — clients must
 * display them only (affordance costs OK) and never simulate or invent values.
 */
export interface PlayerHudState {
  capitalHp: number;
  capitalHpMax: number;
  energy: number;
  organization: number;
  organizationMax: number;
}

/** Idle room destroy threshold (manager + GameRoom hooks). */
export const ROOM_IDLE_MS = 5 * 60 * 1000;

export type { PlacedBuilding, BuildCostPreview, RepairCostPreview } from "./buildings/actions.js";
export {
  BUILD_O_COST,
  DEMOLISH_O_COST,
  HOLD_ACTION_O_COST,
  RELOCATE_CAPITAL_O_COST,
  DEMOLISH_E_REFUND_RATE,
  DEMOLISH_CONSTRUCTION_E_REFUND_RATE,
  DEMOLISH_LOCK_AFTER_REPAIR_SEC,
  REPAIR_E_PER_HP,
  REPAIR_CAPITAL_E_MULTIPLIER,
  REPAIR_DURATION_DIVISOR,
  REPAIR_CAPITAL_DURATION_DIVISOR,
  CONTINUE_BUILD_DURATION_MULTIPLIER,
  snapToBuildNode,
  nodeKey,
  findBuildingAt,
  findBuildingNear,
  findBuildingsInRadius,
  isBuildingComplete,
  buildingStartsEmptyGarrison,
  initialBuildingGarrisonU,
  isRepairing,
  needsContinueBuild,
  interruptBuildOrRepairOnDamage,
  applyBuildingHpDamage,
  buildingHpZeroShouldDestroy,
  constructionHp,
  repairHp,
  previewRepairCost,
  previewContinueBuildCost,
  durationSecToTicks,
  isBuildingAncestor,
  canPlaceBuildingDef,
  previewBuildCost,
  investedEForBuilding,
  demolishEnergyRefund,
  demolishLockTicksAfterRepair,
  isDemolishLockedByRepair,
  applyCapitalRelocateInPlace,
  clearMutualDefensePair,
  reconcileMutualDefensePartners,
} from "./buildings/actions.js";

/**
 * Incremental list patch for wire snapshots (buildings / liaisons).
 * `upserts` replace-or-insert by `id`; `removes` drop by id (incl. left FOV).
 */
export interface SnapshotListDelta<T extends { id: string }> {
  upserts: T[];
  removes: string[];
}

/** Apply a list delta onto the client's cached entity array (stable-ish order). */
export function applySnapshotListDelta<T extends { id: string }>(
  prev: readonly T[] | undefined,
  delta: SnapshotListDelta<T>,
): T[] {
  const remove = new Set(delta.removes);
  const pending = new Map(delta.upserts.map((e) => [e.id, e]));
  const out: T[] = [];
  for (const e of prev ?? []) {
    if (remove.has(e.id)) continue;
    const next = pending.get(e.id);
    if (next) {
      out.push(next);
      pending.delete(e.id);
    } else {
      out.push(e);
    }
  }
  for (const e of delta.upserts) {
    if (pending.has(e.id)) out.push(e);
  }
  return out;
}

export interface GameStateSnapshot {
  tick: number;
  /**
   * Map size for this match. Wire: only on join / re-enter (bootstrap);
   * omitted on regular ticks — client must cache from the last bootstrap.
   */
  map?: import("./map.js").MapConfig;
  you: PlayerHudState;
  /**
   * Visible buildings (viewer-filtered). Wire: full array on bootstrap and
   * every ~10s (150 ticks) baseline refresh; omitted when `buildingsDelta`
   * is used (or when unchanged with an empty delta).
   */
  buildings?: import("./buildings/actions.js").PlacedBuilding[];
  /**
   * Incremental building patch vs last sent filtered set on this connection.
   * Wire-only; cleared by `mergeGameStateSnapshot` into `buildings`.
   */
  buildingsDelta?: SnapshotListDelta<
    import("./buildings/actions.js").PlacedBuilding
  >;
  /**
   * Visible liaisons. Same full / delta cadence as `buildings`.
   */
  liaisons?: import("./buildings/liaison.js").PlacedLiaison[];
  /**
   * Incremental liaison patch. Wire-only; merged into `liaisons` on the client.
   */
  liaisonsDelta?: SnapshotListDelta<
    import("./buildings/liaison.js").PlacedLiaison
  >;
  units: import("./units/types.js").UnitGroup[];
  /** Building instance ids with live comms link to capital (this player). */
  connectedBuildingIds: string[];
  /**
   * Persistent nuclear pollution zones (server-authoritative).
   * Wire: full list on bootstrap / re-enter and when the list changes vs last
   * send on this connection; omitted on unchanged regular ticks (client caches).
   */
  pollutionZones?: import("./buildings/pollution.js").PollutionZone[];
  phase: GamePhase;
  /**
   * Shared terrain seed; client regenerates locally with the same seed.
   * Wire: only on join / re-enter; omitted on regular ticks (client caches).
   * `null` means no terrain yet (`need_init`).
   */
  terrainSeed?: number | null;
  /** Revealed resource reserves (after first mining). */
  resourceSight: import("./terrain/types.js").ResourceSightCell[];
  /**
   * Cleared / depleted resource cells (`cleared`) + deposit reserves
   * (`deposits`) for terrain re-render.
   * Wire: full sync on bootstrap / re-enter and when changed vs last send on
   * this connection; omitted on unchanged regular ticks (client caches).
   */
  resourceTerrain?: import("./terrain/types.js").ResourceTerrainSync;
  /** Roster for owner-name display in inspect HUD. */
  players?: Array<{ id: string; name: string }>;
  /** Room id when in a managed match (omit for legacy single-room debug). */
  roomId?: string;
  /**
   * Match rule: capital fall → respawn (pick capital) vs spectate.
   * Wire: only on join / re-enter; omitted on regular ticks (client caches).
   */
  allowRespawn?: boolean;
  /**
   * Viewer role for this snapshot. Spectators get unfiltered world.
   * Wire: always on bootstrap / re-enter; on regular ticks omit when
   * unchanged vs last value sent on this connection (client keeps previous).
   */
  role?: SnapshotRole;
  /**
   * End-of-match winner. Wire: always on bootstrap / re-enter; on regular
   * ticks omit when unchanged vs last send on this connection (client keeps
   * previous). Include when a winner is first set (or cleared).
   * `null` = no winner yet.
   */
  winnerId?: string | null;
  winnerName?: string | null;
  /** Winning team (team mode); wire like winnerId. */
  winnerTeamId?: string | null;
  /** All winning player ids (team mode). */
  winnerPlayerIds?: string[] | null;
  /** Display names matching winnerPlayerIds. */
  winnerNames?: string[] | null;
  /**
   * playerId → teamId. Wire: bootstrap + when changed; omit when unchanged
   * (client caches). Empty / omit = FFA solos.
   */
  teams?: import("./teams.js").TeamRoster;
  /**
   * Match uses team win / no capital re-pick. Wire: bootstrap + when changed.
   */
  teamMode?: boolean;
  /** Pending team invites visible to this viewer (custom room). */
  teamInvites?: import("./teams.js").TeamInvitePending[];
  /**
   * Ally garrison requests targeting buildings owned by this viewer.
   * Wire: full list when changed; omit when unchanged (client caches).
   */
  allyGarrisonRequests?: import("./teams.js").AllyGarrisonRequest[];
  /**
   * Pregame ready lobby (new game ready_lobby or restore_lobby): viewer ready.
   * Wire when changed / bootstrap.
   */
  ready?: boolean;
  /** All player ids currently ready (pregame / restore lobby). */
  readyPlayerIds?: string[];
  /** True while room is in restore_lobby (before all-ready → playing). */
  restoreMode?: boolean;
  /** This viewer is the save-file holder (inherits saver; never picks capital). */
  restoreHolder?: boolean;
  /** Save identity this live player is mapped to (if any). */
  mappedSaveId?: string | null;
  /** Unmapped / abandoned: may place or inherit a capital. */
  canPickCapital?: boolean;
  /** Has capital in pregame/restore lobby: may abandon and re-pick. */
  canAbandonCapital?: boolean;
  /** Available save identities for inherit_identity. */
  restoreIdentities?: import("./save.js").RestoreIdentityOption[];
}

function mergeEntityListField<T extends { id: string }>(
  prev: readonly T[] | undefined,
  full: T[] | undefined,
  delta: SnapshotListDelta<T> | undefined,
): T[] {
  if (full !== undefined) return full;
  if (delta !== undefined) return applySnapshotListDelta(prev, delta);
  return prev ? [...prev] : [];
}

/**
 * Merge an incoming wire snapshot into the client's last applied state.
 * Bootstrap-only fields (`map` / `terrainSeed` / `allowRespawn`) and
 * change-only fields (`role` / `winnerId` / `winnerName` / `pollutionZones` /
 * `resourceTerrain`) are retained from `prev` when omitted on `next`.
 * Buildings / liaisons: full array replaces; `*Delta` applies upserts/removes;
 * omit keeps previous list.
 */
export function mergeGameStateSnapshot(
  prev: GameStateSnapshot | null,
  next: GameStateSnapshot,
): GameStateSnapshot {
  const {
    buildingsDelta: _bd,
    liaisonsDelta: _ld,
    ...rest
  } = next;
  return {
    ...rest,
    buildings: mergeEntityListField(
      prev?.buildings,
      next.buildings,
      next.buildingsDelta,
    ),
    liaisons: mergeEntityListField(
      prev?.liaisons,
      next.liaisons,
      next.liaisonsDelta,
    ),
    map: next.map ?? prev?.map,
    terrainSeed:
      next.terrainSeed !== undefined ? next.terrainSeed : prev?.terrainSeed,
    allowRespawn:
      next.allowRespawn !== undefined ? next.allowRespawn : prev?.allowRespawn,
    role: next.role !== undefined ? next.role : prev?.role,
    winnerId: next.winnerId !== undefined ? next.winnerId : prev?.winnerId,
    winnerName:
      next.winnerName !== undefined ? next.winnerName : prev?.winnerName,
    winnerTeamId:
      next.winnerTeamId !== undefined ? next.winnerTeamId : prev?.winnerTeamId,
    winnerPlayerIds:
      next.winnerPlayerIds !== undefined
        ? next.winnerPlayerIds
        : prev?.winnerPlayerIds,
    winnerNames:
      next.winnerNames !== undefined ? next.winnerNames : prev?.winnerNames,
    teams: next.teams !== undefined ? next.teams : prev?.teams,
    teamMode: next.teamMode !== undefined ? next.teamMode : prev?.teamMode,
    teamInvites:
      next.teamInvites !== undefined ? next.teamInvites : prev?.teamInvites,
    allyGarrisonRequests:
      next.allyGarrisonRequests !== undefined
        ? next.allyGarrisonRequests
        : prev?.allyGarrisonRequests,
    ready: next.ready !== undefined ? next.ready : prev?.ready,
    readyPlayerIds:
      next.readyPlayerIds !== undefined
        ? next.readyPlayerIds
        : prev?.readyPlayerIds,
    restoreMode:
      next.restoreMode !== undefined ? next.restoreMode : prev?.restoreMode,
    restoreHolder:
      next.restoreHolder !== undefined
        ? next.restoreHolder
        : prev?.restoreHolder,
    mappedSaveId:
      next.mappedSaveId !== undefined ? next.mappedSaveId : prev?.mappedSaveId,
    canPickCapital:
      next.canPickCapital !== undefined
        ? next.canPickCapital
        : prev?.canPickCapital,
    canAbandonCapital:
      next.canAbandonCapital !== undefined
        ? next.canAbandonCapital
        : prev?.canAbandonCapital,
    restoreIdentities:
      next.restoreIdentities !== undefined
        ? next.restoreIdentities
        : prev?.restoreIdentities,
    pollutionZones:
      next.pollutionZones !== undefined
        ? next.pollutionZones
        : prev?.pollutionZones,
    resourceTerrain:
      next.resourceTerrain !== undefined
        ? next.resourceTerrain
        : prev?.resourceTerrain,
  };
}

export type ClientToServer =
  | {
      type: "hello";
      /** Browser-cached identity UUID; server may mint if omitted. */
      playerId?: string;
      name?: string;
    }
  | { type: "ping"; t: number }
  | {
      type: "create_room";
      mapSize: import("./map.js").MapSizeId;
      seed?: number | string;
      allowRespawn: boolean;
      /** 2–10 */
      maxPlayers: number;
      /**
       * Base64 encrypted `.wopsave` blob (manager decrypts).
       * Restore only at custom room create — never mid-game.
       */
      saveBlob?: string;
    }
  | {
      /** Request encrypted save download (manager packs AES-GCM). */
      type: "export_save";
    }
  | {
      /** Pregame / restore lobby ready toggle. */
      type: "set_ready";
      ready: boolean;
    }
  | {
      /** Claim an unmapped save identity (and its world assets). */
      type: "inherit_identity";
      savePlayerId: string;
    }
  | {
      /** Abandon current capital in pregame/restore lobby to re-pick / inherit. */
      type: "abandon_capital";
    }
  | { type: "join_room"; roomId: string }
  | {
      type: "queue_match";
      /** Target lobby size 2–5 (FFA); ignored when teamFormat set. */
      playerCount?: number;
      /** Team matchmaking format; implies seat count and random teams. */
      teamFormat?: import("./teams.js").TeamFormat;
    }
  | { type: "cancel_queue" }
  | { type: "leave_room" }
  | { type: "team_invite"; toPlayerId: string }
  | { type: "team_invite_accept"; fromPlayerId: string }
  | { type: "team_invite_reject"; fromPlayerId: string }
  | { type: "team_leave" }
  | {
      type: "ally_garrison_request";
      unitId: string;
      buildingId: string;
    }
  | { type: "ally_garrison_accept"; requestId: string }
  | { type: "ally_garrison_reject"; requestId: string }
  | {
      type: "init";
      mapSize?: import("./map.js").MapSizeId;
      /** Terrain seed; omit/empty → server random. Number or string (hashed if non-numeric). */
      seed?: number | string;
    }
  | {
      type: "place_capital";
      gx: number;
      gy: number;
    }
  | {
      type: "build";
      buildingId: string;
      gx: number;
      gy: number;
      /** Client terrain under the node until server owns terrain. */
      ground: import("./buildings/catalog.js").GroundContext;
    }
  | {
      type: "build_liaison";
      kind: import("./buildings/liaison.js").LiaisonKind;
      nodes: import("./buildings/liaison.js").GridNode[];
    }
  | {
      type: "demolish_liaison";
      /** Placed liaison instance id. */
      id: string;
    }
  | {
      type: "demolish";
      /** Placed building instance id. */
      id: string;
    }
  | {
      type: "repair";
      /** Placed building instance id. */
      id: string;
    }
  | {
      type: "level_upgrade";
      /** Placed building instance id (雷达/港口/兵营/装甲营/机场线性升级). */
      id: string;
    }
  | {
      type: "relocate_capital";
      /** Metropolis (首府) instance id to become the new capital. */
      id: string;
    }
  | {
      type: "reload";
      /** Placed building instance id. */
      id: string;
      /** Rounds to load (≥ 1). */
      count: number;
    }
  | {
      type: "deploy";
      /** Placed building instance id. */
      id: string;
      /** Deploy steps (≥ 1). Each step stores catalog.deployStepE. */
      count: number;
    }
  | {
      type: "train";
      /** Training ground instance id. */
      id: string;
      kind: import("./units/train.js").TrainableKind;
      /** U to train (≥ 1); split across targets by available room. */
      u: number;
      /** Destination building instance ids (≥ 1). Prefer over `targetId`. */
      targetIds?: string[];
      /** @deprecated Single target; still accepted when `targetIds` omitted. */
      targetId?: string;
    }
  | {
      type: "fire";
      /** Firing building instance id. */
      id: string;
      /** Enemy building instance id (omit when targeting a unit). */
      targetId?: string;
      /** Enemy unit group id; gun only. */
      targetUnitId?: string;
    }
  | {
      type: "move_units";
      gx: number;
      gy: number;
      /** Deploy U from these buildings (same building = one group). */
      sources?: Array<{ buildingId: string; u: number }>;
      /** Already fielded unit group ids. */
      unitIds?: string[];
    }
  | {
      type: "assign_home";
      /** Building that should become the groups' home. */
      buildingId: string;
      unitIds: string[];
    }
  | {
      type: "stop_units";
      unitIds: string[];
      /** true = 撤退（空军飞回所属建筑）；false/omit = 停止（封锁则原地结束封锁） */
      retreat?: boolean;
    }
  | {
      type: "blockade_units";
      gx: number;
      gy: number;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }
  | {
      type: "end_blockade";
      unitIds: string[];
    }
  | {
      type: "supply_units";
      /** Supply station instance id. */
      supplyBuildingId: string;
      gx: number;
      gy: number;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }
  | {
      type: "attack_units";
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
      targetUnitId?: string;
      targetBuildingId?: string;
      /** 敌方联络线 instance id。与单位/建筑目标互斥。 */
      targetLiaisonId?: string;
      /** 被进攻的那一段两端（1 Du 或对角 √2）。 */
      liaisonAx?: number;
      liaisonAy?: number;
      liaisonBx?: number;
      liaisonBy?: number;
    }
  | {
      type: "hold_units";
      holdBuildingId: string;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }
  | {
      type: "end_hold";
      unitIds: string[];
    }
  | {
      type: "mutual_defense";
      buildingId: string;
      partnerBuildingId: string;
    }
  | {
      type: "end_mutual_defense";
      buildingId: string;
    }
  | {
      type: "build_carrier";
      /** Port building instance id. */
      id: string;
    }
  | {
      type: "embark_air";
      carrierId: string;
      airUnitId: string;
      /** U to embark; omit = all that fit. */
      u?: number;
    }
  | {
      type: "disembark_air";
      carrierId: string;
      /** U to launch; omit = all embarked. */
      u?: number;
    }
  | {
      type: "chat";
      /** Plain text; server truncates. */
      text: string;
    };

export type ServerToClient =
  | {
      type: "welcome";
      playerId: string;
      name: string;
      /** If the player still belongs to a live room. */
      activeRoomId?: string | null;
      /** Present when already in a room (or legacy single-room debug). */
      state?: GameStateSnapshot;
    }
  | { type: "state"; state: GameStateSnapshot }
  | { type: "pong"; t: number }
  | { type: "error"; code: string; message: string }
  | { type: "tip"; message: string }
  | {
      /**
       * Encrypted `.wopsave` as base64 (manager). Client downloads as file.
       */
      type: "save_export";
      blob: string;
      /** Suggested filename, e.g. `room-tick.wopsave`. */
      filename?: string;
    }
  | { type: "room_ready"; roomId: string }
  | {
      type: "match_status";
      playerCount: number;
      queued: number;
      /** Waiting | matched (room_ready follows) */
      status: "waiting" | "matched" | "cancelled";
    }
  | {
      type: "room_status";
      roomId: string;
      players: number;
      maxPlayers: number;
      allowRespawn: boolean;
      mapSize: import("./map.js").MapSizeId;
    }
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
      type: "team_invite_pending";
      fromPlayerId: string;
      fromName: string;
      toPlayerId: string;
    }
  | {
      type: "room_closed";
      roomId: string;
      reason: "idle" | "game_over" | "destroyed";
    }
  | {
      type: "chat";
      playerId: string;
      name: string;
      text: string;
      /** Unix ms. */
      t: number;
    }
  | import("./debug/actionLog.js").PlayerActionResultMsg;

export type {
  PlayerActionCategory,
  PlayerActionStatus,
  PlayerActionSource,
  PlayerActionLogEntry,
  PlayerActionLogPush,
  PlayerActionResultMsg,
} from "./debug/actionLog.js";
export {
  PLAYER_ACTION_CATEGORY_LABEL,
  PLAYER_ACTION_STATUS_LABEL,
  PlayerActionLog,
  shouldLogClientAction,
  categoryForAction,
  summarizeClientAction,
  formatActionStamp,
  formatCostDelta,
} from "./debug/actionLog.js";

export type {
  GroundKind,
  ResourceKind,
  TerrainResource,
  TerrainCell,
  TerrainDeposit,
  TerrainMap,
  ResourceSightCell,
  ResourceTerrainSync,
} from "./terrain/types.js";
export { cellAt } from "./terrain/types.js";
export {
  generateTerrain,
  parseTerrainSeed,
  hashStringToSeed,
} from "./terrain/generateTerrain.js";
export type { GenerateTerrainOptions } from "./terrain/generateTerrain.js";
export {
  cellsTouchingNode,
  cellsTouchingUnitCoord,
  isFoothillNode,
  isCoastlineNode,
  isForestInteriorNode,
  isValidCapitalCell,
  isValidCapitalSite,
  capitalSiteRejectReason,
  capitalSiteRejectMessage,
  capitalExclusionRejectReason,
  CAPITAL_EXCLUSION_R_DU,
} from "./terrain/capitalSite.js";
export type { CapitalSiteRejectReason } from "./terrain/capitalSite.js";

export {
  isValidPortSite,
  cellsTouchedBySegment,
  isValidRoadRailNode,
  isValidRoadRailSegment,
  roadRailPathRejectReason,
  clampRoadRailPath,
  classifyRoadRailSegment,
  isForestInteriorSegment,
  roadRailTerrainDu,
  roadRailTerrainRateEPerDu,
  roadRailTerrainSurchargeE,
  ROAD_RAIL_FOREST_E_PER_DU,
  ROAD_RAIL_TERRAIN_E_PER_DU,
} from "./terrain/placement.js";
export type {
  RoadRailSegmentTerrain,
  RoadRailLineKind,
} from "./terrain/placement.js";

export type {
  BuildingCategory,
  BuildingSize,
  BuildingDef,
  BuildTreeNode,
  BuildTreeOptions,
  GroundContext,
  SettlementSpineSeg,
  SettlementSpine,
} from "./buildings/catalog.js";
export {
  BUILDINGS,
  BUILDING_BY_ID,
  SIZE_LABEL,
  SIZE_NAME,
  CATEGORY_LABEL,
  BUILD_E_PER_LEVEL,
  getInvestedLevels,
  getBuildEnergyCost,
  getBuildDurationSec,
  formatBuildDuration,
  getUpgradeTargets,
  getBuildTree,
  isSettlementMainline,
  extractSettlementSpine,
  launchCooldownSec,
  launchCooldownTicks,
  isLaunchCoolingDown,
  withLaunchCooldown,
} from "./buildings/catalog.js";

export {
  RADAR_WORK_BOOST_DIST_DU,
  RADAR_BUILDING_ID,
  workRangeCircles,
  isInsideWorkRange,
} from "./buildings/workRange.js";
export type { WorkRangeCircle } from "./buildings/workRange.js";

export {
  NUKE_MISSILE_BUILDING_ID,
  NUKE_POLLUTION_R_DU,
  POLLUTION_CAPITAL_HP_INTERVAL_SEC,
  POLLUTION_CAPITAL_HP_DAMAGE,
  isPointInPollution,
  isBuildingInPollution,
  createNukePollutionZone,
} from "./buildings/pollution.js";
export type { PollutionZone } from "./buildings/pollution.js";

export {
  LINEAR_UPGRADE_BUILDING_IDS,
  LINEAR_UPGRADE_MIN_LEVEL,
  LINEAR_UPGRADE_MAX_LEVEL,
  LINEAR_UPGRADE_MAX_STAT_MULT,
  ROMAN_LEVEL,
  supportsLinearUpgrade,
  buildingLevel,
  linearUpgradeCostE,
  linearStatMultiplier,
  scaleStatLinear,
  scaleIntStatLinear,
  effectiveHpMax,
  effectiveUmax,
  effectiveWorkR,
  romanLevelLabel,
  previewLinearUpgrade,
  applyLinearUpgrade,
} from "./buildings/levelUpgrade.js";
export type {
  LinearUpgradeBuildingId,
  LinearUpgradePreview,
} from "./buildings/levelUpgrade.js";

export {
  POWER_DRAIN_PER_10S,
  findResourceUnderBuilding,
  revealResourcesUnderMiners,
  collectResourceSight,
  depleteResourcesForMiners,
  collectResourceTerrainSync,
  applyResourceTerrainSync,
  sumPowerProduction,
  sumRefinedRawIncome,
  nukeReloadRejectReason,
  energyIncomePerSecond,
  powerDrainPer10s,
  orgBonusPer30s,
} from "./buildings/economy.js";

export type {
  LiaisonKind,
  GridNode,
  LiaisonLineDef,
  PlacedLiaison,
  LiaisonCostPreview,
} from "./buildings/liaison.js";
export {
  LIAISON_BY_ID,
  LIAISON_LINES,
  LIAISON_RANK,
  LIAISON_OVERLAP_REFUND_RATE,
  RAILWAY_STATION_BUILDING_ID,
  nodeKey as liaisonNodeKey,
  sameNode,
  isAdjacentGridNode,
  segmentLengthDu,
  pathLengthDu,
  segmentKey,
  pathSegmentKeys,
  pathsShareSegment,
  lengthOfSegments,
  splitPathRemovingSegments,
  dedupeSelfOverlappingPath,
  stitchSegments,
  findOverlappingLiaisons,
  demolishLiaisonRefundE,
  demolishLiaisonSegmentRefundE,
  distancePointToSegment,
  findLiaisonNear,
  findLiaisonSegmentNear,
  snapToIntegerNode,
  previewLiaisonCost,
  previewLiaisonCostForLength,
  withLiaisonTerrainSurcharge,
  pickNextLiaisonStep,
  bluntLiaisonPath,
  extendLiaisonPath,
  isValidLiaisonPath,
  hasOwnedRailwayStationAt,
  hasRailwayOriginStationAt,
  findOwnedRailwayStationNear,
  anchorRailwayEndpoints,
  railwayEndpointRejectReason,
  resolveLiaisonBuildOverlap,
} from "./buildings/liaison.js";
export type { LiaisonOverlapResolution, StationLikeBuilding } from "./buildings/liaison.js";

export type { CommEdge, CommWaveState } from "./buildings/comm.js";
export {
  COMM_WAVE_INTERVAL_TICKS,
  COMM_STEPS_PER_TICK,
  buildLiaisonAdjacency,
  startCommWave,
  stepCommWave,
  remainingDuOnMedium,
  isBuildingCommsLinked,
  undirectedCommEdgeKey,
  collectCommUsedEdges,
} from "./buildings/comm.js";

export type { UnitKind, UnitKindDef, UnitState } from "./units/catalog.js";
export {
  UNIT_BY_KIND,
  UNIT_COORD_STEP,
  UNIT_MOVE_O_COST,
  UNIT_STOP_E_COST,
  UNIT_STOP_O_COST,
  UNIT_BLOCKADE_O_COST,
  UNIT_BLOCKADE_ENTER_E_PER_U,
  UNIT_BLOCKADE_UPKEEP_E_PER_U,
  UNIT_BLOCKADE_INTERVAL_SEC,
  UNIT_BLOCKADE_RADIUS,
  UNIT_COMBAT_ROUND_INTERVAL_SEC,
  UNIT_SUPPLY_O_COST,
  UNIT_SIEGE_INTERVAL_SEC,
  UNIT_ATTACK_LAND_O_COST,
  UNIT_ATTACK_AIR_NAVY_O_COST,
  UNIT_HOLD_O_COST,
  UNIT_HOLD_ENTER_E_PER_U,
  UNIT_HOLD_UPKEEP_E_PER_U,
  UNIT_HOLD_INTERVAL_SEC,
  UNIT_MUTUAL_DEFENSE_O_COST,
  UNIT_OCCUPY_DEMOLISH_REFUND_RATE,
  CARRIER_BUILD_E,
  CARRIER_AIR_CAPACITY,
  CARRIER_HULL_U,
  ROAD_MOVE_SPEED,
  RAIL_MOVE_SPEED,
  unitKindFromBuilding,
  garrisonLockedInBuilding,
  isCarrierKind,
} from "./units/catalog.js";
export type { UnitGroup, UnitMoveRequest, UnitMoveSource } from "./units/types.js";
export {
  snapToUnitCoord,
  unitCoordKey,
  findUnitNear,
  findUnitsInRadius,
  deployFromBuilding,
  returnToBuilding,
  defaultCarriedE,
  createUnitGroup,
  presentU,
  awayOccupiedU,
  occupiedGarrisonU,
  releaseAwayOccupation,
  releaseAwayForUnitDiff,
  shouldReleaseAwayOnDeposit,
} from "./units/garrison.js";
export {
  collectRadioCoverage,
  collectAirportCoverage,
  collectPortNavyCoverage,
  collectMovingUnitCoverage,
  collectUnitActivityCoverage,
  isInsideRadioCoverage,
  isInsideAirportCoverage,
  isInsideAnyCircle,
} from "./units/radio.js";
export {
  transportAt,
  isMountainTerrain,
  isFoothillTerrain,
  isPureMountainTerrain,
  isOceanTerrain,
  isLandTerrain,
  terrainAllowsKind,
  speedAt,
  planAirPath,
  planLandOrNavyPath,
  estimatePathTimeSec,
  findFreeUnitCoord,
} from "./units/pathfind.js";
export type { PathPlanResult, TransportKind, TerrainAllowOpts } from "./units/pathfind.js";
export {
  filterUnitForViewer,
  filterUnitsForViewer,
  unitHp,
  isMovingState,
} from "./units/filter.js";
export {
  isUnitDocked,
  canUnitStop,
  canUnitRetreat,
  occupiedUnitKeys,
  buildingCenterKeys,
  resolveFreeUnitCoord,
  blocksUnitCell,
} from "./units/occupy.js";
export type { OccupyPlacer, UnitDockContext } from "./units/occupy.js";
export {
  applyUnitMove,
  applyUnitStop,
  applyUnitBlockade,
  applyUnitSupply,
  applyUnitAttack,
  applyUnitHold,
  applyMutualDefense,
  applyEndMutualDefense,
  applyEndHold,
  applyEndBlockade,
  applyAssignHome,
  applyAllyGarrisonDeposit,
  previewUnitMove,
  previewTrainingDeliveryPath,
  isAirKind,
} from "./units/orders.js";
export type {
  MoveContext,
  MoveApplyResult,
  StopApplyResult,
  EndBlockadeResult,
  MutualDefenseResult,
  EndHoldResult,
} from "./units/orders.js";
export { advanceUnits } from "./units/tick.js";
export type { TickMoveResult } from "./units/tick.js";
export {
  resolveCombatRound,
  cannotDamageAir,
  siegeDamageFromUnits,
  siegeDamageFromBuilding,
  attackOrganizationCost,
} from "./units/combat.js";
export {
  advanceHolds,
  advanceFightsAndSieges,
  applyAirHitAndRunStrike,
  findHoldCoordOutside,
  isBuildingHeld,
  occupyDemolishRefund,
} from "./units/fight.js";
export type { FightTickResult, FightMoveContext } from "./units/fight.js";
export { advanceBlockades } from "./units/blockade.js";
export type { BlockadeTickResult } from "./units/blockade.js";
export {
  pathLengthDu as unitPathLengthDu,
  usesCarriedSupply,
  carriedECostPerU,
  maxTravelDuFromCarried,
  consumeCarriedForStep,
  resupplyUnitFromStation,
  findSupplyStationAt,
  isNearUnitCoord,
  unitGridChebyshev,
} from "./units/supply.js";
export type { ResupplyResult } from "./units/supply.js";
export {
  applyBuildCarrier,
  applyEmbarkAir,
  applyDisembarkAir,
  carrierAirRoom,
  carrierCapacityLabel,
  carrierMoveSpeedDuPerS,
} from "./units/carrier.js";
export type {
  BuildCarrierResult,
  EmbarkAirResult,
  DisembarkAirResult,
} from "./units/carrier.js";
export {
  ANTI_AIR_BUILDING_ID,
  ANTI_AIR_AMMO_PER_ENGAGEMENT,
  ANTI_AIR_AMMO_PER_INTERCEPT,
  ANTI_AIR_DRAIN_RATE_OF_ENTRY,
  ANTI_AIR_FLOOR_RATIO,
  GUN_BUILDING_ID,
  ROCKET_FORCE_BUILDING_IDS,
  isRocketForceWeapon,
  advanceAntiAir,
  tryInterceptFlyingMissile,
  tryInterceptFlyingMissiles,
} from "./units/antiAir.js";
export type {
  AntiAirTickResult,
  AntiAirConnectedByOwner,
  AntiAirAmmoEvent,
  AntiAirOpts,
  FlyingMissileStub,
  RocketForceBuildingId,
} from "./units/antiAir.js";
export {
  applyLiaisonAttack,
  advanceLiaisonCuts,
  removeLiaisonSegment,
} from "./units/liaisonAttack.js";
export type { LiaisonSegmentTarget, LiaisonCutTickResult } from "./units/liaisonAttack.js";
export type {
  TrainableKind,
  TrainingJob,
  CompletedTraining,
  TrainingAllocation,
} from "./units/train.js";
export {
  TRAIN_E_PER_U,
  TRAIN_DURATION_E_PER_SEC,
  TRAINABLE_KINDS,
  isTrainableKind,
  trainEnergyCost,
  trainDurationSec,
  trainDurationTicks,
  buildingAcceptsUnitKind,
  garrisonCap,
  garrisonRoom,
  pendingInboundU,
  availableTrainingRoom,
  isTrainingGround,
  trainingQueueKind,
  trainingHeadProgress,
  allocateTrainingDeliveries,
  enqueueTraining,
  advanceTrainingQueues,
} from "./units/train.js";

export type { VisionLevel, VisionSource } from "./vision/vision.js";
export {
  DIRECT_VISION_R_BY_SIZE,
  DIRECT_VISION_R_RADAR,
  DIRECT_VISION_R_CAPITAL,
  DIRECT_VISION_R_INFANTRY,
  DIRECT_VISION_R_ARMOR_NAVY,
  DIRECT_VISION_R_AIR,
  visionDistDu,
  directVisionRadiusForBuilding,
  collectDirectVisionSources,
  collectUnitVisionSources,
  collectAllDirectVisionSources,
  isInDirectVision,
  unitInDirectVision,
  satelliteSeesBuilding,
  satelliteSeesLiaison,
  buildingVisionLevel,
  liaisonVisionLevel,
  filterBuildingForViewer,
  filterLiaisonForViewer,
  filterBuildingsForViewer,
  filterLiaisonsForViewer,
  filterResourceSightForViewer,
  resourceSightSamplePoint,
  shouldMaskUpgradeOnSatellite,
  buildRoadRailAdjacency,
  isConstructionAllowedAt,
  constructionRejectReason,
} from "./vision/vision.js";
