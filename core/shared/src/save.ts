/**
 * Authoritative save document (plaintext). Encrypted to `.wopsave` on manager only.
 */

import { isMapSizeId, type MapSizeId } from "./map.js";
import type { PlacedBuilding } from "./buildings/actions.js";
import type {
  ActiveRocketResearch,
  RocketResearchProgressMap,
} from "./buildings/research.js";
import type { PlacedLiaison } from "./buildings/liaison.js";
import type { PollutionZone } from "./buildings/pollution.js";
import type { ResourceTerrainSync } from "./terrain/types.js";
import type { TeamRoster } from "./teams.js";
import type { UnitGroup } from "./units/types.js";

/** Current plaintext schema version. */
export const SAVE_FORMAT_VERSION = 1;

/** Binary container magic ASCII "WOPS". */
export const WOPSAVE_MAGIC = "WOPS";

/** AES-GCM IV length in bytes. */
export const WOPSAVE_IV_BYTES = 12;

/** AES-GCM auth tag length in bytes. */
export const WOPSAVE_TAG_BYTES = 16;

/** Mirrors `PlayerHudState` (avoid circular import with index). */
export interface SavePlayerHud {
  capitalHp: number;
  capitalHpMax: number;
  energy: number;
  organization: number;
  organizationMax: number;
  /** Rocket research progress (optional on older saves). */
  research?: RocketResearchProgressMap;
  /** Timed research in progress (optional on older saves). */
  activeResearch?: ActiveRocketResearch | null;
}

export interface SavePlayerSnapshot {
  playerId: string;
  name: string;
  hud: SavePlayerHud;
  /** True when this player was spectating at save time. */
  spectator: boolean;
  /**
   * Rocket research progress (preferred over `hud.research` when both present).
   * Older saves may only carry these under `hud`.
   */
  research?: RocketResearchProgressMap;
  /** Timed research in progress at save time. */
  activeResearch?: ActiveRocketResearch | null;
}

/**
 * Full authoritative room dump (no vision filter).
 * Produced by GameRoom; manager encrypts / decrypts only.
 */
export interface SaveDocument {
  formatVersion: number;
  gameVersion: string;
  savedAt: number;
  saverPlayerId: string;
  saverName: string;
  roomId: string;
  mapSize: MapSizeId;
  maxPlayers: number;
  terrainSeed: number;
  tick: number;
  allowRespawn: boolean;
  teamMode: boolean;
  teams: TeamRoster;
  buildings: PlacedBuilding[];
  liaisons: PlacedLiaison[];
  units: UnitGroup[];
  pollutionZones: PollutionZone[];
  resourceTerrain: ResourceTerrainSync;
  /** ownerId → connected building instance ids */
  connectedByOwner: Record<string, string[]>;
  knownCapitalOwners: string[];
  spectatorIds: string[];
  players: SavePlayerSnapshot[];
}

/** Snapshot fields for restore-lobby identity pick UI. */
export interface RestoreIdentityOption {
  savePlayerId: string;
  name: string;
  /** True when this save identity still owns a capital in the restored world. */
  hasCapital: boolean;
  /** True when some live player already mapped to this save id. */
  claimed: boolean;
}

export function isSaveDocument(value: unknown): value is SaveDocument {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.formatVersion === "number" &&
    typeof d.gameVersion === "string" &&
    typeof d.savedAt === "number" &&
    typeof d.saverPlayerId === "string" &&
    typeof d.saverName === "string" &&
    typeof d.roomId === "string" &&
    isMapSizeId(d.mapSize) &&
    typeof d.maxPlayers === "number" &&
    typeof d.terrainSeed === "number" &&
    typeof d.tick === "number" &&
    typeof d.allowRespawn === "boolean" &&
    typeof d.teamMode === "boolean" &&
    d.teams != null &&
    typeof d.teams === "object" &&
    Array.isArray(d.buildings) &&
    Array.isArray(d.liaisons) &&
    Array.isArray(d.units) &&
    Array.isArray(d.pollutionZones) &&
    d.resourceTerrain != null &&
    typeof d.resourceTerrain === "object" &&
    d.connectedByOwner != null &&
    typeof d.connectedByOwner === "object" &&
    Array.isArray(d.knownCapitalOwners) &&
    Array.isArray(d.spectatorIds) &&
    Array.isArray(d.players)
  );
}
