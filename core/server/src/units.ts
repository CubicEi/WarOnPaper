import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  DT_SEC_PER_TICK,
  UNIT_MOVE_O_COST,
  UNIT_BLOCKADE_O_COST,
  UNIT_SUPPLY_O_COST,
  applyUnitMove,
  applyAssignHome,
  applyUnitStop,
  applyUnitBlockade,
  applyUnitSupply,
  applyUnitAttack,
  applyLiaisonAttack,
  applyUnitHold,
  applyMutualDefense,
  applyEndMutualDefense,
  applyEndHold,
  applyEndBlockade,
  applyBuildCarrier,
  applyEmbarkAir,
  applyDisembarkAir,
  advanceUnits,
  advanceBlockades,
  advanceHolds,
  advanceFightsAndSieges,
  advanceLiaisonCuts,
  advanceAntiAir,
  CARRIER_BUILD_E,
  UNIT_HOLD_O_COST,
  UNIT_MUTUAL_DEFENSE_O_COST,
  enqueueTraining,
  advanceTrainingQueues,
  createUnitGroup,
  type MapConfig,
  type PlacedBuilding,
  type PlacedLiaison,
  type PlayerHudState,
  type TerrainMap,
  type UnitGroup,
  type TrainableKind,
} from "@wop/shared";

export interface UnitSession {
  id: string;
  hud: PlayerHudState;
  ws: WebSocket;
}

export interface UnitWorld {
  map: MapConfig;
  terrain: TerrainMap | null;
  buildings: PlacedBuilding[];
  liaisons: PlacedLiaison[];
  units: UnitGroup[];
  connectedByOwner: Map<string, Set<string>>;
  teams?: import("@wop/shared").TeamRoster | null;
}

export function advanceUnitMovement(world: UnitWorld): void {
  if (!world.terrain) return;
  const result = advanceUnits(
    world.units,
    world.buildings,
    world.liaisons,
    world.terrain,
    world.connectedByOwner,
    DT_SEC_PER_TICK,
    world.teams,
  );
  world.units.length = 0;
  world.units.push(...result.units);
  for (let i = 0; i < world.buildings.length; i++) {
    const next = result.buildings.find((b) => b.id === world.buildings[i]!.id);
    if (next) world.buildings[i] = next;
  }
}

/** Tick blockade upkeep + R=2 combat. Mutates world.units/buildings and returns energy drains. */
export function advanceUnitBlockades(
  world: UnitWorld,
  energyByOwner: ReadonlyMap<string, number>,
): Map<string, number> {
  const result = advanceBlockades(
    world.units,
    world.buildings,
    energyByOwner,
    DT_SEC_PER_TICK,
    world.teams,
  );
  world.units.length = 0;
  world.units.push(...result.units);
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  return result.energyByOwner;
}

/** Hold upkeep + fights/sieges. Returns energy drains from hold. */
export function advanceUnitCombat(
  world: UnitWorld,
  energyByOwner: ReadonlyMap<string, number>,
): Map<string, number> {
  const hold = advanceHolds(
    world.units,
    world.buildings,
    energyByOwner,
    DT_SEC_PER_TICK,
  );
  world.units.length = 0;
  world.units.push(...hold.units);
  world.buildings.length = 0;
  world.buildings.push(...hold.buildings);

  const remaining = new Map(energyByOwner);
  for (const [pid, cost] of hold.energyByOwner) {
    remaining.set(pid, Math.max(0, (remaining.get(pid) ?? 0) - cost));
  }

  const fight = advanceFightsAndSieges(
    world.units,
    world.buildings,
    DT_SEC_PER_TICK,
    {
      map: world.map,
      terrain: world.terrain,
      liaisons: world.liaisons,
      connectedByOwner: world.connectedByOwner,
      nextId: () => randomUUID(),
      teams: world.teams,
    },
    world.teams,
  );
  world.units.length = 0;
  world.units.push(...fight.units);
  world.buildings.length = 0;
  world.buildings.push(...fight.buildings);

  const cut = advanceLiaisonCuts(
    world.units,
    world.liaisons,
    DT_SEC_PER_TICK,
    () => randomUUID(),
  );
  world.units.length = 0;
  world.units.push(...cut.units);
  world.liaisons.length = 0;
  world.liaisons.push(...cut.liaisons);

  return hold.energyByOwner;
}

/** Advance training queues and spawn delivery moves for completed jobs. */
export function advanceUnitTraining(world: UnitWorld): void {
  if (!world.terrain) return;
  const { buildings: nextBuildings, completed } = advanceTrainingQueues(world.buildings, 1);
  world.buildings.length = 0;
  world.buildings.push(...nextBuildings);

  for (const done of completed) {
    const unit = createUnitGroup({
      id: randomUUID(),
      ownerId: done.ownerId,
      kind: done.job.kind,
      u: done.job.u,
      gx: done.sourceGx,
      gy: done.sourceGy,
      // Prefer the delivery target as home so leftover / return / retreatå¥åºæ­£ç¡®ã
      homeBuildingId: done.job.targetBuildingId || done.sourceBuildingId,
    });
    const target = world.buildings.find((b) => b.id === done.job.targetBuildingId);
    if (!target) {
      world.units.push(unit);
      continue;
    }
    const moved = applyUnitMove(
      {
        ownerId: done.ownerId,
        gx: target.gx,
        gy: target.gy,
        unitIds: [unit.id],
        asTrainingDelivery: true,
        depositOnArrival: true,
        depositBuildingId: target.id,
      },
      {
        map: world.map,
        terrain: world.terrain,
        buildings: world.buildings,
        liaisons: world.liaisons,
        units: [...world.units, unit],
        connectedIds: world.connectedByOwner.get(done.ownerId) ?? new Set(),
        teams: world.teams,
        nextId: () => randomUUID(),
      },
    );
    if (!moved.ok) {
      world.units.push(unit);
      continue;
    }
    world.buildings.length = 0;
    world.buildings.push(...moved.buildings);
    world.units.length = 0;
    world.units.push(...moved.units);
  }
}

export function handleMoveUnits(
  session: UnitSession,
  world: UnitWorld,
  gx: number,
  gy: number,
  sources: Array<{ buildingId: string; u: number }> | undefined,
  unitIds: string[] | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const result = applyUnitMove(
    { ownerId: session.id, gx, gy, sources, unitIds },
    {
      map: world.map,
      terrain: world.terrain,
      buildings: world.buildings,
      liaisons: world.liaisons,
      units: world.units,
      connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
      teams: world.teams,
      nextId: () => randomUUID(),
    },
  );
  if (!result.ok) {
    sendError(session.ws, "move_rejected", result.error ?? "æ æ³è°å¨");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  session.hud.energy -= result.energyCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("move", "ok", {
    player: session.id.slice(0, 8),
    O: session.hud.organization,
    cost: UNIT_MOVE_O_COST,
    t: Math.round(result.travelTimeSec * 10) / 10,
  });
  broadcast();
}

export function handleAssignHome(
  session: UnitSession,
  world: UnitWorld,
  buildingId: string,
  unitIds: string[],
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const result = applyAssignHome(session.id, buildingId, unitIds, {
    map: world.map,
    terrain: world.terrain,
    buildings: world.buildings,
    liaisons: world.liaisons,
    units: world.units,
    connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
    teams: world.teams,
    nextId: () => randomUUID(),
  });
  if (!result.ok) {
    sendError(session.ws, "assign_rejected", result.error ?? "æ æ³å½å±");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("assign_home", "ok", {
    player: session.id.slice(0, 8),
    building: buildingId.slice(0, 8),
    groups: unitIds.length,
  });
  broadcast();
}

export function handleTrainUnits(
  session: UnitSession,
  world: UnitWorld,
  sourceBuildingId: string,
  kind: TrainableKind,
  u: number,
  targetIds: string[] | undefined,
  targetId: string | undefined,
  playing: boolean,
  commsLinked: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!commsLinked) {
    sendError(session.ws, "not_linked", "è®­ç»åºæªè¿ééè®¯");
    return;
  }
  const ids =
    targetIds && targetIds.length > 0
      ? targetIds
      : targetId
        ? [targetId]
        : [];
  if (ids.length === 0) {
    sendError(session.ws, "train_rejected", "è¯·éæ©è³å°ä¸ä¸ªç®æ å»ºç­");
    return;
  }
  const result = enqueueTraining(
    {
      ownerId: session.id,
      sourceBuildingId,
      kind,
      u,
      targetBuildingIds: ids,
      nextJobId: () => randomUUID(),
    },
    world.buildings,
    world.units,
  );
  if (!result.ok) {
    sendError(session.ws, "train_rejected", result.error ?? "æ æ³è®­ç»");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(
      session.ws,
      "not_enough_org",
      `组织度不足（需要 ${result.organizationCost} O）`,
    );
    return;
  }
  if (session.hud.energy < result.energyCost) {
    sendError(session.ws, "not_enough_energy", `è½æºä¸è¶³ï¼éè¦ ${result.energyCost} Eï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  session.hud.energy -= result.energyCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  log("train", "ok", {
    player: session.id.slice(0, 8),
    kind,
    u,
    targets: result.allocations?.map((a) => ({ id: a.targetBuildingId.slice(0, 8), u: a.u })),
    O: session.hud.organization,
    E: session.hud.energy,
    costO: result.organizationCost,
    costE: result.energyCost,
  });
  broadcast();
}

export function handleBlockadeUnits(
  session: UnitSession,
  world: UnitWorld,
  gx: number,
  gy: number,
  sources: Array<{ buildingId: string; u: number }> | undefined,
  unitIds: string[] | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const result = applyUnitBlockade(
    { ownerId: session.id, gx, gy, sources, unitIds },
    {
      map: world.map,
      terrain: world.terrain,
      buildings: world.buildings,
      liaisons: world.liaisons,
      units: world.units,
      connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
      teams: world.teams,
      nextId: () => randomUUID(),
    },
  );
  if (!result.ok) {
    sendError(session.ws, "blockade_rejected", result.error ?? "æ æ³å°é");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  if (session.hud.energy < result.energyCost) {
    sendError(session.ws, "not_enough_energy", `è½æºä¸è¶³ï¼éè¦ ${result.energyCost} Eï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  session.hud.energy -= result.energyCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("blockade", "ok", {
    player: session.id.slice(0, 8),
    O: session.hud.organization,
    E: session.hud.energy,
    costO: UNIT_BLOCKADE_O_COST,
    costE: result.energyCost,
    t: Math.round(result.travelTimeSec * 10) / 10,
  });
  broadcast();
}

export function handleEndBlockade(
  session: UnitSession,
  world: UnitWorld,
  unitIds: string[],
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  const result = applyEndBlockade(session.id, unitIds, world.units);
  if (!result.ok) {
    sendError(session.ws, "end_blockade_rejected", result.error ?? "æ æ³ç»æå°é");
    return;
  }
  world.units.length = 0;
  world.units.push(...result.units);
  log("end_blockade", "ok", { player: session.id.slice(0, 8), n: unitIds.length });
  broadcast();
}

export function handleSupplyUnits(
  session: UnitSession,
  world: UnitWorld,
  supplyBuildingId: string,
  gx: number,
  gy: number,
  sources: Array<{ buildingId: string; u: number }> | undefined,
  unitIds: string[] | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const result = applyUnitSupply(
    {
      ownerId: session.id,
      gx,
      gy,
      sources,
      unitIds,
      supplyBuildingId,
    },
    {
      map: world.map,
      terrain: world.terrain,
      buildings: world.buildings,
      liaisons: world.liaisons,
      units: world.units,
      connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
      teams: world.teams,
      nextId: () => randomUUID(),
    },
  );
  if (!result.ok) {
    sendError(session.ws, "supply_rejected", result.error ?? "æ æ³è¡¥ç»");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("supply", "ok", {
    player: session.id.slice(0, 8),
    O: session.hud.organization,
    costO: UNIT_SUPPLY_O_COST,
    station: supplyBuildingId.slice(0, 8),
    t: Math.round(result.travelTimeSec * 10) / 10,
  });
  broadcast();
}

export function handleAttackUnits(
  session: UnitSession,
  world: UnitWorld,
  sources: Array<{ buildingId: string; u: number }> | undefined,
  unitIds: string[] | undefined,
  targetUnitId: string | undefined,
  targetBuildingId: string | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
  targetLiaison?: {
    id: string;
    ax: number;
    ay: number;
    bx: number;
    by: number;
  },
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const ctx = {
    map: world.map,
    terrain: world.terrain,
    buildings: world.buildings,
    liaisons: world.liaisons,
    units: world.units,
    connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
    teams: world.teams,
    nextId: () => randomUUID(),
  };
  const attackTarget = targetUnitId
    ? world.units.find((u) => u.id === targetUnitId)
    : targetBuildingId
      ? world.buildings.find((b) => b.id === targetBuildingId)
      : undefined;
  const result = targetLiaison
    ? applyLiaisonAttack(
        {
          ownerId: session.id,
          gx: 0,
          gy: 0,
          sources,
          unitIds,
        },
        ctx,
        {
          liaisonId: targetLiaison.id,
          ax: targetLiaison.ax,
          ay: targetLiaison.ay,
          bx: targetLiaison.bx,
          by: targetLiaison.by,
        },
      )
    : applyUnitAttack(
        {
          ownerId: session.id,
          gx: attackTarget?.gx ?? 0,
          gy: attackTarget?.gy ?? 0,
          sources,
          unitIds,
          attackTargetUnitId: targetUnitId,
          attackTargetBuildingId: targetBuildingId,
        },
        ctx,
      );
  if (!result.ok) {
    sendError(session.ws, "attack_rejected", result.error ?? "æ æ³è¿æ»");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("attack", "ok", {
    player: session.id.slice(0, 8),
    O: session.hud.organization,
    costO: result.organizationCost,
    targetUnitId,
    targetBuildingId,
    targetLiaisonId: targetLiaison?.id,
  });
  broadcast();
}

export function handleHoldUnits(
  session: UnitSession,
  world: UnitWorld,
  holdBuildingId: string,
  sources: Array<{ buildingId: string; u: number }> | undefined,
  unitIds: string[] | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const b = world.buildings.find((x) => x.id === holdBuildingId);
  const result = applyUnitHold(
    {
      ownerId: session.id,
      gx: b?.gx ?? 0,
      gy: b?.gy ?? 0,
      sources,
      unitIds,
      holdBuildingId,
    },
    {
      map: world.map,
      terrain: world.terrain,
      buildings: world.buildings,
      liaisons: world.liaisons,
      units: world.units,
      connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
      teams: world.teams,
      nextId: () => randomUUID(),
    },
  );
  if (!result.ok) {
    sendError(session.ws, "hold_rejected", result.error ?? "æ æ³é©»å®");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  if (session.hud.energy < result.energyCost) {
    sendError(session.ws, "not_enough_energy", `è½æºä¸è¶³ï¼éè¦ ${result.energyCost} Eï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  session.hud.energy -= result.energyCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("hold", "ok", {
    player: session.id.slice(0, 8),
    O: session.hud.organization,
    E: session.hud.energy,
    costO: UNIT_HOLD_O_COST,
    costE: result.energyCost,
    building: holdBuildingId.slice(0, 8),
  });
  broadcast();
}

export function handleEndHold(
  session: UnitSession,
  world: UnitWorld,
  unitIds: string[],
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  const result = applyEndHold(session.id, unitIds, world.units);
  if (!result.ok) {
    sendError(session.ws, "end_hold_rejected", result.error ?? "æ æ³ç»æé©»å®");
    return;
  }
  world.units.length = 0;
  world.units.push(...result.units);
  log("end_hold", "ok", { player: session.id.slice(0, 8), n: unitIds.length });
  broadcast();
}

export function handleMutualDefense(
  session: UnitSession,
  world: UnitWorld,
  buildingId: string,
  partnerBuildingId: string,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  const result = applyMutualDefense(
    session.id,
    buildingId,
    partnerBuildingId,
    world.buildings,
    world.units,
  );
  if (!result.ok) {
    sendError(session.ws, "mutual_defense_rejected", result.error ?? "æ æ³äºé²");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  log("mutual_defense", "ok", {
    player: session.id.slice(0, 8),
    a: buildingId.slice(0, 8),
    b: partnerBuildingId.slice(0, 8),
    costO: UNIT_MUTUAL_DEFENSE_O_COST,
  });
  broadcast();
}

export function handleEndMutualDefense(
  session: UnitSession,
  world: UnitWorld,
  buildingId: string,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  const result = applyEndMutualDefense(session.id, buildingId, world.buildings);
  if (!result.ok) {
    sendError(session.ws, "end_mutual_defense_rejected", result.error ?? "æ æ³è§£é¤äºé²");
    return;
  }
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  log("end_mutual_defense", "ok", {
    player: session.id.slice(0, 8),
    building: buildingId.slice(0, 8),
  });
  broadcast();
}

/** Tick anti-air continuous drain vs enemy air. Returns ammo consume events. */
export function advanceUnitAntiAir(
  world: UnitWorld,
  tick = 0,
): import("@wop/shared").AntiAirAmmoEvent[] {
  const result = advanceAntiAir(
    world.units,
    world.buildings,
    DT_SEC_PER_TICK,
    world.connectedByOwner,
    { tick },
  );
  world.units.length = 0;
  world.units.push(...result.units);
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  return result.ammoEvents;
}

export function handleBuildCarrier(
  session: UnitSession,
  world: UnitWorld,
  portBuildingId: string,
  playing: boolean,
  commsLinked: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!commsLinked) {
    sendError(session.ws, "not_linked", "æ¸¯å£æªè¿ééè®¯");
    return;
  }
  const result = applyBuildCarrier(
    session.id,
    portBuildingId,
    world.buildings,
    world.units,
    () => randomUUID(),
  );
  if (!result.ok) {
    sendError(session.ws, "carrier_rejected", result.error ?? "æ æ³å»ºé èªæ¯");
    return;
  }
  if (session.hud.energy < result.energyCost) {
    sendError(session.ws, "not_enough_energy", `è½æºä¸è¶³ï¼éè¦ ${result.energyCost} Eï¼`);
    return;
  }
  session.hud.energy -= result.energyCost;
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("build_carrier", "ok", {
    player: session.id.slice(0, 8),
    port: portBuildingId.slice(0, 8),
    E: session.hud.energy,
    cost: CARRIER_BUILD_E,
  });
  broadcast();
}

export function handleEmbarkAir(
  session: UnitSession,
  world: UnitWorld,
  carrierId: string,
  airUnitId: string,
  u: number | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  const result = applyEmbarkAir(
    session.id,
    carrierId,
    airUnitId,
    u,
    world.units,
    world.buildings,
  );
  if (!result.ok) {
    sendError(session.ws, "embark_rejected", result.error ?? "æ æ³ä¸è°");
    return;
  }
  world.buildings.length = 0;
  world.buildings.push(...result.buildings);
  world.units.length = 0;
  world.units.push(...result.units);
  log("embark_air", "ok", {
    player: session.id.slice(0, 8),
    carrier: carrierId.slice(0, 8),
    air: airUnitId.slice(0, 8),
  });
  broadcast();
}

export function handleDisembarkAir(
  session: UnitSession,
  world: UnitWorld,
  carrierId: string,
  u: number | undefined,
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  const result = applyDisembarkAir(
    session.id,
    carrierId,
    u,
    world.units,
    world.buildings,
    () => randomUUID(),
  );
  if (!result.ok) {
    sendError(session.ws, "disembark_rejected", result.error ?? "æ æ³æ¾é£");
    return;
  }
  world.units.length = 0;
  world.units.push(...result.units);
  log("disembark_air", "ok", {
    player: session.id.slice(0, 8),
    carrier: carrierId.slice(0, 8),
  });
  broadcast();
}

export function handleStopUnits(
  session: UnitSession,
  world: UnitWorld,
  unitIds: string[],
  playing: boolean,
  sendError: (ws: WebSocket, code: string, message: string) => void,
  broadcast: () => void,
  log: (scope: string, ...args: unknown[]) => void,
  retreat = false,
): void {
  if (!playing) {
    sendError(session.ws, "not_playing", "è¯·åéå®é¦é½");
    return;
  }
  if (!world.terrain) {
    sendError(session.ws, "no_terrain", "å°æªçæå°å½¢");
    return;
  }
  const result = applyUnitStop(
    session.id,
    unitIds,
    world.units,
    {
      map: world.map,
      terrain: world.terrain,
      buildings: world.buildings,
      liaisons: world.liaisons,
      connectedIds: world.connectedByOwner.get(session.id) ?? new Set(),
    },
    { retreat },
  );
  if (!result.ok) {
    sendError(session.ws, "stop_rejected", result.error ?? "æ æ³åæ­¢");
    return;
  }
  if (session.hud.organization < result.organizationCost) {
    sendError(session.ws, "not_enough_org", `ç»ç»åº¦ä¸è¶³ï¼éè¦ ${result.organizationCost} Oï¼`);
    return;
  }
  if (session.hud.energy < result.energyCost) {
    sendError(session.ws, "not_enough_energy", `è½æºä¸è¶³ï¼éè¦ ${result.energyCost} Eï¼`);
    return;
  }
  session.hud.organization -= result.organizationCost;
  session.hud.energy -= result.energyCost;
  if (result.buildings) {
    world.buildings.length = 0;
    world.buildings.push(...result.buildings);
  }
  world.units.length = 0;
  world.units.push(...result.units);
  log("stop", "ok", {
    player: session.id.slice(0, 8),
    n: unitIds.length,
    retreat,
  });
  broadcast();
}
