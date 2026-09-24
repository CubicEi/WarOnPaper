import fs from "node:fs";

const path = new URL("../src/room.ts", import.meta.url);
let src = fs.readFileSync(path, "utf8");

// --- imports ---
src = src.replace(
  'import { WebSocketServer, type WebSocket } from "ws";',
  'import type { WebSocket } from "ws";',
);
src = src.replace(
  "  type ServerToClient,\n  type TerrainMap,",
  "  ROOM_IDLE_MS,\n  type ServerToClient,\n  type SnapshotRole,\n  type TerrainMap,",
);

const headerEnd = src.indexOf("interface PlayerSession");
if (headerEnd < 0) throw new Error("PlayerSession not found");
const importsAndHeader = src.slice(0, headerEnd);

const wssIdx = src.indexOf("const wss = new WebSocketServer");
if (wssIdx < 0) throw new Error("wss block not found");
const body = src.slice(headerEnd, wssIdx);

const apiPreamble = `
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
`;

// Transform PlayerSession to include role tracking via spectator set (keep ws)
let transformed = body;

// Replace PORT / MAP init / phase need_init
transformed = transformed.replace(
  `const PORT = Number(process.env.PORT ?? 8787);
/** Active map; replaced on init when client sends mapSize. */
let MAP: MapConfig = MAP_SIZES[DEFAULT_MAP_SIZE_ID];
`,
  `/** Active map; set at room creation. */
let MAP: MapConfig = MAP_SIZES[options.mapSize && isMapSizeId(options.mapSize) ? options.mapSize : DEFAULT_MAP_SIZE_ID];
`,
);

transformed = transformed.replace(
  `let phase: GamePhase = "need_init";
let terrain: TerrainMap | null = null;`,
  `let phase: GamePhase = "pick_capital";
let terrain: TerrainMap | null = null;`,
);

// phaseFor with spectating / ended
transformed = transformed.replace(
  `/** Per player: no terrain → init; terrain but no capital → pick; otherwise playing. */
function phaseFor(session: PlayerSession): GamePhase {
  if (!terrain) return "need_init";
  if (!findPlayerCapital(session.id)) return "pick_capital";
  return "playing";
}`,
  `/** Per player phase; spectators / ended override pick/play. */
function phaseFor(session: PlayerSession): GamePhase {
  if (closed || winnerId) return "ended";
  if (spectatorIds.has(session.id)) return "spectating";
  if (!terrain) return "need_init";
  if (!findPlayerCapital(session.id)) return "pick_capital";
  return "playing";
}`,
);

transformed = transformed.replace(
  `function rejectIfNotPlaying(session: PlayerSession): boolean {
  if (phaseFor(session) === "playing") return false;
  sendError(
    session.ws,
    "not_playing",
    terrain ? "请先选定首都" : "请先完成初始化并选定首都",
  );
  return true;
}`,
  `function rejectIfNotPlaying(session: PlayerSession): boolean {
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
}`,
);

// snapshotFor: room fields + full world for spectators
transformed = transformed.replace(
  `function snapshotFor(player: PlayerSession): GameStateSnapshot {
  syncCapitalHud(player);
  const linked = [...publishedLinks(player.id)];
  return {
    tick,
    map: MAP,
    you: { ...player.hud },
    buildings: filterBuildingsForViewer(buildings, player.id, liaisons, linked, units),
    liaisons: filterLiaisonsForViewer(liaisons, buildings, player.id, linked, units),
    units: filterUnitsForViewer(units, player.id, buildings, linked),
    connectedBuildingIds: linked,
    pollutionZones: pollutionZones.map((z) => ({ ...z })),
    phase: phaseFor(player),
    terrainSeed: terrain?.seed ?? null,
    resourceSight: terrain ? collectResourceSight(terrain) : [],
    resourceTerrain: terrain
      ? collectResourceTerrainSync(terrain, clearedResourceCells)
      : { cleared: [], deposits: [] },
  };
}`,
  `function snapshotFor(player: PlayerSession): GameStateSnapshot {
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
}`,
);

// handleInit: reject public FFA init; keep as debugReinit internal
transformed = transformed.replace(
  `function handleInit(
  session: PlayerSession,
  mapSize?: MapSizeId,
  seedRaw?: number | string,
): void {
  if (mapSize !== undefined && !isMapSizeId(mapSize)) {
    sendError(session.ws, "bad_map_size", "未知地图尺寸");
    return;
  }
  buildings.length = 0;
  liaisons.length = 0;
  units.length = 0;
  pollutionZones.length = 0;
  connectedByOwner.clear();
  commWaves.clear();
  clearedResourceCells.clear();
  MAP = MAP_SIZES[mapSize ?? DEFAULT_MAP_SIZE_ID];
  const seed = parseTerrainSeed(seedRaw);
  terrain = generateTerrain({ map: MAP, seed });
  phase = "pick_capital";
  tick = 0;
  slog("init", "ok", {
    seed: terrain.seed,
    map: MAP.id,
    player: session.id.slice(0, 8),
    deposits: terrain.deposits.length,
  });
  broadcastState();
}`,
  `function handleInit(session: PlayerSession): void {
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
}`,
);

// dispatch init
transformed = transformed.replace(
  `  if (msg.type === "init") {
    slog("msg", "init", session.id.slice(0, 8), msg.mapSize, msg.seed);
    handleInit(session, msg.mapSize, msg.seed);
    return;
  }`,
  `  if (msg.type === "init") {
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
  }`,
);

// After place capital: touch interaction; track multiple capitals
transformed = transformed.replace(
  `  if (phase !== "playing") tick = 0;
  phase = "playing";
  beginCommWaves();
  advanceCommWaves();

  slog("capital", "placed", {`,
  `  if (phase !== "playing") tick = 0;
  phase = "playing";
  spectatorIds.delete(session.id);
  beginCommWaves();
  advanceCommWaves();
  touchInteraction();
  noteCapitalCounts();

  slog("capital", "placed", {`,
);

// Insert capital-fall helpers before dispatchPlayerMessage
const capitalHelpers = `
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
  const ownersWithCapital = new Set(
    buildings.filter((b) => b.buildingId === "capital").map((b) => b.ownerId),
  );
  // Destroy 0-hp capitals
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i]!;
    if (b.buildingId !== "capital") continue;
    if (b.hp > 0) continue;
    const ownerId = b.ownerId;
    buildings.splice(i, 1);
    onCapitalFallen(ownerId);
  }
  // Owners who had been playing but lost capital building entirely
  for (const p of players.values()) {
    if (spectatorIds.has(p.id)) continue;
    if (phaseFor(p) === "ended") continue;
    // Only treat as fall if they previously had capital (playing) and now missing
    // Heuristic: if sawMultipleCapitals or they have non-empty hud capital tracking
    if (ownersWithCapital.has(p.id)) continue;
    // If player still in pick_capital (never placed), skip
    // Detect via: no capital, but they have units/buildings OR were playing
    const hadStuff =
      buildings.some((b) => b.ownerId === p.id) ||
      units.some((u) => u.ownerId === p.id) ||
      liaisons.some((l) => l.ownerId === p.id);
    // Capital already cleared by onCapitalFallen; avoid double
    if (!hadStuff && p.hud.capitalHp === CAPITAL_HP_MAX && p.hud.energy === STARTING_ENERGY) {
      continue;
    }
  }
  noteCapitalCounts();
}

`;

transformed = transformed.replace(
  "function dispatchPlayerMessage(session: PlayerSession, msg: ClientToServer): void {",
  capitalHelpers +
    "function dispatchPlayerMessage(session: PlayerSession, msg: ClientToServer): void {",
);

// After fire destroys capital-like, reconcile — patch fire destroy block
transformed = transformed.replace(
  `  // 火箭军最后一击 / 建造·修复中 HP0：直接摧毁建筑（不可占领）
  if (target.hp <= 0) {
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
  }`,
  `  // 火箭军最后一击 / 建造·修复中 HP0：直接摧毁建筑（不可占领）
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
  }`,
);

const apiTail = `
  // Room-driven map generation at create time.
  generateRoomTerrain(options.seed);
  touchInteraction();

  function assertOpen(): boolean {
    if (!closed) return true;
    return false;
  }

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
    advanceUnitAntiAir({
      map: MAP,
      terrain,
      buildings,
      liaisons,
      units,
      connectedByOwner,
    });
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
        const state = snapshotFor(existing);
        send(existing.ws, {
          type: "welcome",
          playerId: existing.id,
          name: existing.name,
          activeRoomId: roomId,
          state,
        });
        return { ok: true, playerId: existing.id, state };
      }
      if (players.size >= maxPlayers) {
        return { ok: false, code: "room_full", message: "房间已满" };
      }
      const session: PlayerSession = {
        id: opts.playerId,
        name: (opts.name || \`Player-\${opts.playerId.slice(0, 4)}\`).slice(0, 24),
        hud: createHud(),
        ws: makeSocket(opts.send),
      };
      players.set(session.id, session);
      touchInteraction();
      const state = snapshotFor(session);
      send(session.ws, {
        type: "welcome",
        playerId: session.id,
        name: session.name,
        activeRoomId: roomId,
        state,
      });
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
`;

// Fix unused assertOpen if we left it - remove assertOpen from apiTail
const cleanTail = apiTail.replace(
  `  function assertOpen(): boolean {
    if (!closed) return true;
    return false;
  }

  function tickRoom(): void {`,
  `  function tickRoom(): void {`,
);

const out = importsAndHeader + apiPreamble + transformed + cleanTail;
fs.writeFileSync(path, out);
console.log("Wrote room.ts", out.length, "bytes");
