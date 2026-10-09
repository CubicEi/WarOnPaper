/**
 * Helpers for applying SaveDocument identity remaps inside GameRoom.
 */

import type {
  PlacedBuilding,
  PlacedLiaison,
  PollutionZone,
  SaveDocument,
  SavePlayerSnapshot,
  TeamRoster,
  UnitGroup,
} from "@wop/shared";

export function cloneSaveWorld(doc: SaveDocument): {
  buildings: PlacedBuilding[];
  liaisons: PlacedLiaison[];
  units: UnitGroup[];
  pollutionZones: PollutionZone[];
  connectedByOwner: Map<string, Set<string>>;
  knownCapitalOwners: Set<string>;
  spectatorIds: Set<string>;
  teams: TeamRoster;
  players: SavePlayerSnapshot[];
} {
  return {
    buildings: structuredClone(doc.buildings),
    liaisons: structuredClone(doc.liaisons),
    units: structuredClone(doc.units),
    pollutionZones: structuredClone(doc.pollutionZones),
    connectedByOwner: new Map(
      Object.entries(doc.connectedByOwner).map(([k, ids]) => [
        k,
        new Set(ids),
      ]),
    ),
    knownCapitalOwners: new Set(doc.knownCapitalOwners),
    spectatorIds: new Set(doc.spectatorIds),
    teams: { ...doc.teams },
    players: structuredClone(doc.players),
  };
}

/** Rewrite every ownerId / map key from `fromId` → `toId`. */
export function remapOwnerId(
  fromId: string,
  toId: string,
  world: {
    buildings: PlacedBuilding[];
    liaisons: PlacedLiaison[];
    units: UnitGroup[];
    connectedByOwner: Map<string, Set<string>>;
    knownCapitalOwners: Set<string>;
    spectatorIds: Set<string>;
    teams: TeamRoster;
  },
): void {
  if (fromId === toId) return;
  for (const b of world.buildings) {
    if (b.ownerId === fromId) b.ownerId = toId;
  }
  for (const l of world.liaisons) {
    if (l.ownerId === fromId) l.ownerId = toId;
  }
  for (const u of world.units) {
    if (u.ownerId === fromId) u.ownerId = toId;
  }
  const linked = world.connectedByOwner.get(fromId);
  if (linked) {
    world.connectedByOwner.delete(fromId);
    const existing = world.connectedByOwner.get(toId) ?? new Set<string>();
    for (const id of linked) existing.add(id);
    world.connectedByOwner.set(toId, existing);
  }
  if (world.knownCapitalOwners.delete(fromId)) {
    world.knownCapitalOwners.add(toId);
  }
  if (world.spectatorIds.delete(fromId)) {
    world.spectatorIds.add(toId);
  }
  if (world.teams[fromId] != null) {
    world.teams[toId] = world.teams[fromId]!;
    delete world.teams[fromId];
  }
}

/**
 * Recompute liveId → saveId after a join.
 * Holder is locked to saver. Others: UUID match, then single-remainder elimination.
 */
export function recomputeIdMap(opts: {
  holderPlayerId: string;
  saverPlayerId: string;
  liveIds: readonly string[];
  savePlayerIds: readonly string[];
  /** Existing manual inherits (live → save) that must be preserved. */
  manual: ReadonlyMap<string, string>;
}): Map<string, string> {
  const {
    holderPlayerId,
    saverPlayerId,
    liveIds,
    savePlayerIds,
    manual,
  } = opts;
  const map = new Map<string, string>();
  const usedSaves = new Set<string>();

  // 1. Holder → saver
  if (liveIds.includes(holderPlayerId)) {
    map.set(holderPlayerId, saverPlayerId);
    usedSaves.add(saverPlayerId);
  }

  // 2. Preserve manual inherits
  for (const [live, save] of manual) {
    if (!liveIds.includes(live)) continue;
    if (map.has(live)) continue;
    if (usedSaves.has(save)) continue;
    if (!savePlayerIds.includes(save)) continue;
    map.set(live, save);
    usedSaves.add(save);
  }

  // 3. UUID match
  for (const live of liveIds) {
    if (map.has(live)) continue;
    if (!savePlayerIds.includes(live)) continue;
    if (usedSaves.has(live)) continue;
    map.set(live, live);
    usedSaves.add(live);
  }

  // 4. Elimination: one live left + one save left
  const unmappedLive = liveIds.filter((id) => !map.has(id));
  const unmappedSave = savePlayerIds.filter((id) => !usedSaves.has(id));
  if (unmappedLive.length === 1 && unmappedSave.length === 1) {
    map.set(unmappedLive[0]!, unmappedSave[0]!);
  }

  return map;
}
