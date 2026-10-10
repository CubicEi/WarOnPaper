import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TICK_MS } from "@wop/shared";
import { CORE_GAME_ROOM_MODULE } from "./paths.js";
import type { MapSizeId } from "./protocol.js";

/** Matches `@wop/shared` `TICK_MS` (`TICK_HZ` from `time.ts`). */
export const GAME_TICK_MS = TICK_MS;

export interface GameRoomCreateOptions {
  roomId: string;
  maxPlayers: number;
  allowRespawn: boolean;
  mapSize: MapSizeId;
  seed?: number | string;
  idleMs?: number;
  teams?: Record<string, string>;
  teamMode?: boolean;
  /** Plain SaveDocument from decrypted .wopsave */
  restore?: unknown;
  holderPlayerId?: string;
  gameVersion?: string;
}

export type RoomSend = (msg: unknown) => void;

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

export type JoinRoomResult =
  | { ok: true; playerId: string; state: unknown }
  | { ok: false; code: string; message: string };

/**
 * Contract mirrored from `@wop/server` (`core/server/dist/room.js`).
 * Manager drives tick + listens for lifecycle events.
 */
export interface GameRoomHandle {
  readonly roomId: string;
  readonly maxPlayers: number;
  readonly allowRespawn: boolean;
  readonly idleMs: number;
  readonly lastInteractionAt: number;
  readonly closed: boolean;
  readonly winnerId: string | null;
  readonly winnerName: string | null;
  join(opts: {
    playerId: string;
    name: string;
    send: RoomSend;
  }): JoinRoomResult;
  setSend(playerId: string, send: RoomSend): boolean;
  leave(playerId: string): void;
  dispatch(playerId: string, msg: unknown): void;
  tick(): void;
  snapshot(playerId: string): unknown | null;
  destroy(reason?: "idle" | "game_over" | "destroyed"): void;
  isIdle(now?: number): boolean;
  on(listener: (event: GameRoomEvent) => void): () => void;
  getPlayerIds(): string[];
  getSpectatorIds(): string[];
  playerCount(): number;
  /** Authoritative plaintext save dump; manager encrypts. */
  exportPlainSave?(requesterId: string): unknown | null;
}

export type GameRoomFactory = (opts: GameRoomCreateOptions) => GameRoomHandle;

type CoreRoomModule = {
  createRoom?: GameRoomFactory;
  GameRoomHandle?: new (opts: GameRoomCreateOptions) => { api: GameRoomHandle };
};

let cachedFactory: GameRoomFactory | null = null;
let loadAttempted = false;

/**
 * Load `createRoom` from core/server/dist/room.js (package main of `@wop/server`).
 * Does NOT import dist/index.js (that starts a debug listener).
 */
export async function resolveGameRoomFactory(): Promise<GameRoomFactory> {
  if (cachedFactory) return cachedFactory;
  if (loadAttempted) {
    throw new Error(
      `[manager] GameRoom factory unavailable (see prior load error for ${CORE_GAME_ROOM_MODULE})`,
    );
  }
  loadAttempted = true;

  if (!existsSync(CORE_GAME_ROOM_MODULE)) {
    throw new Error(
      `[manager] GameRoom module missing: ${CORE_GAME_ROOM_MODULE} — build core first`,
    );
  }

  const mod = (await import(
    pathToFileURL(CORE_GAME_ROOM_MODULE).href
  )) as CoreRoomModule;

  if (typeof mod.createRoom === "function") {
    cachedFactory = mod.createRoom;
    console.log("[manager] GameRoom createRoom loaded from core/server/dist/room.js");
    return cachedFactory;
  }

  if (typeof mod.GameRoomHandle === "function") {
    const Ctor = mod.GameRoomHandle;
    cachedFactory = (opts) => new Ctor(opts).api;
    console.log("[manager] GameRoomHandle class loaded from core/server/dist/room.js");
    return cachedFactory;
  }

  throw new Error(
    "[manager] room.js loaded but exports neither createRoom nor GameRoomHandle",
  );
}

export async function createGameRoom(
  opts: GameRoomCreateOptions,
): Promise<GameRoomHandle> {
  const factory = await resolveGameRoomFactory();
  return factory(opts);
}

/** True after a successful load of the real core factory. */
export function isRealGameRoomAvailable(): boolean {
  return cachedFactory != null;
}
