/**
 * Lobby / identity messages handled by manager.
 * Mirror of planned core/shared types — keep in sync when sibling lands protocol.
 * Game-play messages are opaque and forwarded to GameRoom.
 */

import type { TeamFormat } from "./teams.js";
import { isTeamFormat } from "./teams.js";

export type MapSizeId = "89x59" | "119x79";

export type LobbyClientMessage =
  | { type: "hello"; playerId?: string; name?: string }
  | { type: "ping"; t: number }
  | {
      type: "create_room";
      mapSize: MapSizeId;
      seed?: number | string;
      allowRespawn: boolean;
      maxPlayers: number;
      /** Base64 encrypted `.wopsave` (restore-only create). */
      saveBlob?: string;
    }
  | { type: "export_save" }
  | { type: "join_room"; roomId: string }
  | {
      type: "queue_match";
      /** FFA seat count 2–5; ignored when teamFormat set. */
      playerCount?: number;
      teamFormat?: TeamFormat;
    }
  | { type: "cancel_queue" }
  | { type: "leave_room" };

export type LobbyServerMessage =
  | {
      type: "welcome";
      playerId: string;
      name: string;
      activeRoomId?: string | null;
    }
  | { type: "pong"; t: number }
  | { type: "error"; code: string; message: string }
  | {
      type: "save_export";
      blob: string;
      filename?: string;
    }
  | { type: "room_ready"; roomId: string }
  | {
      type: "match_status";
      playerCount: number;
      queued: number;
      needed: number;
      teamFormat?: TeamFormat;
    }
  | {
      type: "room_status";
      roomId: string;
      players: number;
      maxPlayers: number;
      mapSize: MapSizeId;
      allowRespawn: boolean;
      teamMode?: boolean;
    }
  | { type: "room_closed"; roomId: string; reason: string }
  | { type: "queued"; playerCount: number; teamFormat?: TeamFormat }
  | { type: "queue_cancelled" };

export function isLobbyClientMessage(msg: unknown): msg is LobbyClientMessage {
  if (!msg || typeof msg !== "object") return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === "hello" ||
    t === "ping" ||
    t === "create_room" ||
    t === "export_save" ||
    t === "join_room" ||
    t === "queue_match" ||
    t === "cancel_queue" ||
    t === "leave_room"
  );
}

/** Minimal SaveDocument shape check (mirrors @wop/shared isSaveDocument). */
export function looksLikeSaveDocument(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.formatVersion === "number" &&
    typeof d.saverPlayerId === "string" &&
    (d.mapSize === "89x59" || d.mapSize === "119x79") &&
    typeof d.terrainSeed === "number" &&
    Array.isArray(d.buildings) &&
    Array.isArray(d.players)
  );
}

export function isMapSizeId(value: unknown): value is MapSizeId {
  return value === "89x59" || value === "119x79";
}

export { isTeamFormat };
export type { TeamFormat };
