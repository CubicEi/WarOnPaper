import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  createGameRoom,
  GAME_TICK_MS,
  type GameRoomHandle,
  type RoomSend,
} from "./gameBridge.js";
import type { MapSizeId } from "./protocol.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface RoomMeta {
  roomId: string;
  maxPlayers: number;
  allowRespawn: boolean;
  mapSize: MapSizeId;
  seed?: number | string;
  /** playerId → connection currently bound to this room */
  occupants: Map<string, WebSocket>;
  game: GameRoomHandle;
  createdAt: number;
  /** Unsubscribe from GameRoom events. */
  unsub: () => void;
}

export type RoomLifecycleHooks = {
  onRoomClosed: (roomId: string, reason: string, playerIds: string[]) => void;
};

function generateRoomCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length]!;
  }
  return out;
}

export function normalizeRoomId(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Build RoomSend that JSON-encodes to an open WebSocket. */
export function wsRoomSend(ws: WebSocket): RoomSend {
  return (msg) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };
}

const noopSend: RoomSend = () => {};

/**
 * Active GameRoom registry: create / join / destroy / tick / lifecycle.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, RoomMeta>();
  /** playerId → roomId while seated (survives brief disconnect for rejoin). */
  private readonly playerRoom = new Map<string, string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private hooks: RoomLifecycleHooks | null = null;
  /** Rooms currently tearing down (avoid re-entrant destroy). */
  private readonly destroying = new Set<string>();

  setHooks(hooks: RoomLifecycleHooks): void {
    this.hooks = hooks;
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tickAll(), GAME_TICK_MS);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  get(roomId: string): RoomMeta | undefined {
    return this.rooms.get(normalizeRoomId(roomId));
  }

  /** Room the player is still assigned to (for welcome.activeRoomId / rejoin). */
  activeRoomIdFor(playerId: string): string | null {
    const rid = this.playerRoom.get(playerId);
    if (!rid) return null;
    if (!this.rooms.has(rid)) {
      this.playerRoom.delete(playerId);
      return null;
    }
    return rid;
  }

  listRoomIds(): string[] {
    return [...this.rooms.keys()];
  }

  async createRoom(opts: {
    maxPlayers: number;
    allowRespawn: boolean;
    mapSize: MapSizeId;
    seed?: number | string;
    preferredId?: string;
  }): Promise<RoomMeta> {
    const maxPlayers = clampInt(opts.maxPlayers, 2, 10);
    let roomId = opts.preferredId
      ? normalizeRoomId(opts.preferredId)
      : generateRoomCode();
    let attempts = 0;
    while (this.rooms.has(roomId) && attempts < 32) {
      roomId = generateRoomCode();
      attempts++;
    }
    if (this.rooms.has(roomId)) {
      throw new Error("ROOM_CODE_EXHAUSTED");
    }

    const game = await createGameRoom({
      roomId,
      maxPlayers,
      allowRespawn: opts.allowRespawn,
      mapSize: opts.mapSize,
      seed: opts.seed,
    });

    const meta: RoomMeta = {
      roomId,
      maxPlayers,
      allowRespawn: opts.allowRespawn,
      mapSize: opts.mapSize,
      seed: opts.seed,
      occupants: new Map(),
      game,
      createdAt: Date.now(),
      unsub: () => {},
    };

    meta.unsub = game.on((ev) => {
      if (ev.type === "game_over") {
        // Core notifies players; manager tears the room down.
        void this.destroyRoom(roomId, "game_over");
      } else if (ev.type === "room_closed") {
        // Idle (self-destroy from tick) or after destroyRoom — finalize registry.
        this.finalizeClosed(roomId, ev.reason);
      }
    });

    this.rooms.set(roomId, meta);
    console.log(
      `[manager] room created ${roomId} max=${maxPlayers} map=${opts.mapSize} respawn=${opts.allowRespawn}`,
    );
    return meta;
  }

  /**
   * Bind connection into room. Rejoin uses GameRoom.join / setSend.
   */
  join(
    roomId: string,
    ws: WebSocket,
    playerId: string,
    name: string,
  ): { ok: true; meta: RoomMeta } | { ok: false; code: string; message: string } {
    const id = normalizeRoomId(roomId);
    const meta = this.rooms.get(id);
    if (!meta) {
      return { ok: false, code: "ROOM_NOT_FOUND", message: "房间不存在" };
    }
    if (meta.game.closed) {
      return { ok: false, code: "ROOM_CLOSED", message: "房间已关闭" };
    }

    const prev = this.playerRoom.get(playerId);
    if (prev && prev !== id) {
      this.detachPlayer(prev, playerId, true);
    }

    const alreadySeated = meta.game.getPlayerIds().includes(playerId);
    if (!alreadySeated && meta.game.playerCount() >= meta.maxPlayers) {
      return { ok: false, code: "ROOM_FULL", message: "房间已满" };
    }

    const result = meta.game.join({
      playerId,
      name,
      send: wsRoomSend(ws),
    });
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }

    meta.occupants.set(playerId, ws);
    this.playerRoom.set(playerId, id);
    return { ok: true, meta };
  }

  /** Leave room (return to lobby). Removes seat from GameRoom. */
  leave(roomId: string, playerId: string): void {
    this.detachPlayer(normalizeRoomId(roomId), playerId, true);
  }

  /**
   * Connection dropped — keep seat for rejoin; clear outbound send.
   * Does not call GameRoom.leave.
   */
  onDisconnect(playerId: string, ws: WebSocket): void {
    const rid = this.playerRoom.get(playerId);
    if (!rid) return;
    const meta = this.rooms.get(rid);
    if (!meta) {
      this.playerRoom.delete(playerId);
      return;
    }
    const cur = meta.occupants.get(playerId);
    if (cur === ws) {
      meta.occupants.delete(playerId);
      meta.game.setSend(playerId, noopSend);
    }
  }

  dispatch(playerId: string, msg: unknown): boolean {
    const rid = this.playerRoom.get(playerId);
    if (!rid) return false;
    const meta = this.rooms.get(rid);
    if (!meta || meta.game.closed) return false;
    meta.game.dispatch(playerId, msg);
    return true;
  }

  async destroyRoom(roomId: string, reason: string): Promise<void> {
    const id = normalizeRoomId(roomId);
    const meta = this.rooms.get(id);
    if (!meta) return;
    if (this.destroying.has(id)) return;
    this.destroying.add(id);

    try {
      if (!meta.game.closed) {
        const r =
          reason === "idle" || reason === "game_over" || reason === "destroyed"
            ? reason
            : "destroyed";
        // destroy emits room_closed → finalizeClosed via listener
        meta.game.destroy(r);
      }
    } catch (err) {
      console.warn(`[manager] room ${id} destroy error`, err);
    }

    // If destroy was a no-op (already closed) or emit missed, still unregister.
    if (this.rooms.has(id)) {
      this.finalizeClosed(id, reason);
    } else {
      this.destroying.delete(id);
    }
  }

  private finalizeClosed(roomId: string, reason: string): void {
    const id = normalizeRoomId(roomId);
    const meta = this.rooms.get(id);
    if (!meta) {
      this.destroying.delete(id);
      return;
    }

    const playerIds = [
      ...new Set([...meta.occupants.keys(), ...this.playersInRoom(id)]),
    ];

    try {
      meta.unsub();
    } catch {
      /* ignore */
    }
    this.rooms.delete(id);

    for (const pid of playerIds) {
      if (this.playerRoom.get(pid) === id) this.playerRoom.delete(pid);
    }

    this.destroying.delete(id);
    console.log(`[manager] room closed ${id} reason=${reason}`);
    this.hooks?.onRoomClosed(id, reason, playerIds);
  }

  private playersInRoom(roomId: string): string[] {
    const out: string[] = [];
    for (const [pid, rid] of this.playerRoom) {
      if (rid === roomId) out.push(pid);
    }
    return out;
  }

  private detachPlayer(
    roomId: string,
    playerId: string,
    clearAssignment: boolean,
  ): void {
    const meta = this.rooms.get(roomId);
    if (meta) {
      meta.occupants.delete(playerId);
      meta.game.leave(playerId);
    }
    if (clearAssignment && this.playerRoom.get(playerId) === roomId) {
      this.playerRoom.delete(playerId);
    }
  }

  private tickAll(): void {
    for (const meta of this.rooms.values()) {
      if (meta.game.closed) continue;
      try {
        meta.game.tick();
      } catch (err) {
        console.warn(`[manager] tick error room=${meta.roomId}`, err);
      }
    }
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
