import type { WebSocket } from "ws";
import type { MapSizeId } from "./protocol.js";
import type { RoomRegistry } from "./rooms.js";
import {
  assignRandomTeams,
  formatSeatCount,
  isTeamFormat,
  type TeamFormat,
  type TeamRoster,
} from "./teams.js";

export type MatchPlayerCount = 2 | 3 | 4 | 5;

/** Queue key: FFA by seat count or team format. */
export type MatchQueueKey =
  | `ffa:${MatchPlayerCount}`
  | `team:${TeamFormat}`;

export interface QueuedPlayer {
  playerId: string;
  name: string;
  ws: WebSocket;
  queueKey: MatchQueueKey;
  /** Seat count needed to form. */
  needed: number;
  teamFormat?: TeamFormat;
  enqueuedAt: number;
}

export function isMatchPlayerCount(n: unknown): n is MatchPlayerCount {
  return n === 2 || n === 3 || n === 4 || n === 5;
}

export function ffaQueueKey(count: MatchPlayerCount): MatchQueueKey {
  return `ffa:${count}`;
}

export function teamQueueKey(format: TeamFormat): MatchQueueKey {
  return `team:${format}`;
}

/** Matchmaking: 2–3 → small map, ≥4 → large; allowRespawn=false. */
export function mapSizeForMatch(playerCount: number): MapSizeId {
  return playerCount <= 3 ? "89x59" : "119x79";
}

export type MatchLobbyHooks = {
  send: (ws: WebSocket, msg: unknown) => void;
  onMatchFormed: (info: {
    roomId: string;
    playerCount: number;
    players: QueuedPlayer[];
    teams?: TeamRoster;
    teamMode: boolean;
  }) => void;
};

/**
 * Separate FIFO queues keyed by `ffa:{2|3|4|5}` or `team:{format}`.
 */
export class MatchQueues {
  private readonly queues = new Map<MatchQueueKey, QueuedPlayer[]>();
  private hooks: MatchLobbyHooks | null = null;
  private rooms: RoomRegistry | null = null;

  bind(rooms: RoomRegistry, hooks: MatchLobbyHooks): void {
    this.rooms = rooms;
    this.hooks = hooks;
  }

  enqueue(player: QueuedPlayer): void {
    this.remove(player.playerId);
    const q = this.queues.get(player.queueKey) ?? [];
    q.push(player);
    this.queues.set(player.queueKey, q);
    this.broadcastStatus(player.queueKey);
    void this.tryForm(player.queueKey);
  }

  cancel(playerId: string): boolean {
    const found = this.find(playerId);
    if (!found) return false;
    this.remove(playerId);
    this.broadcastStatus(found.queueKey);
    return true;
  }

  /** Drop from any queue (disconnect / enter room). */
  remove(playerId: string): void {
    for (const [key, q] of this.queues) {
      const idx = q.findIndex((p) => p.playerId === playerId);
      if (idx >= 0) {
        q.splice(idx, 1);
        this.broadcastStatus(key);
        return;
      }
    }
  }

  isQueued(playerId: string): boolean {
    return this.find(playerId) != null;
  }

  status(queueKey: MatchQueueKey): { queued: number; needed: number } {
    const q = this.queues.get(queueKey) ?? [];
    const needed = q[0]?.needed ?? parseNeeded(queueKey);
    return { queued: q.length, needed };
  }

  private find(
    playerId: string,
  ): { queueKey: MatchQueueKey; entry: QueuedPlayer } | null {
    for (const [queueKey, q] of this.queues) {
      const entry = q.find((p) => p.playerId === playerId);
      if (entry) return { queueKey, entry };
    }
    return null;
  }

  private broadcastStatus(queueKey: MatchQueueKey): void {
    const q = this.queues.get(queueKey) ?? [];
    const needed = q[0]?.needed ?? parseNeeded(queueKey);
    const payload = {
      type: "match_status" as const,
      playerCount: needed,
      queued: q.length,
      needed,
      teamFormat: q[0]?.teamFormat,
    };
    for (const p of q) {
      this.hooks?.send(p.ws, payload);
    }
  }

  private async tryForm(queueKey: MatchQueueKey): Promise<void> {
    const rooms = this.rooms;
    const hooks = this.hooks;
    if (!rooms || !hooks) return;

    const q = this.queues.get(queueKey);
    if (!q) return;
    const needed = q[0]?.needed ?? parseNeeded(queueKey);
    const teamFormat = q[0]?.teamFormat;

    while (q.length >= needed) {
      const batch = q.splice(0, needed);
      try {
        let teams: TeamRoster | undefined;
        const teamMode = !!teamFormat;
        if (teamFormat) {
          teams = assignRandomTeams(
            batch.map((p) => p.playerId),
            teamFormat,
          );
        }
        const meta = await rooms.createRoom({
          maxPlayers: needed,
          allowRespawn: false,
          mapSize: mapSizeForMatch(needed),
          teams,
          teamMode,
        });
        for (const p of batch) {
          const result = rooms.join(meta.roomId, p.ws, p.playerId, p.name);
          if (!result.ok) {
            console.warn(
              `[manager] match join failed ${p.playerId}: ${result.message}`,
            );
            hooks.send(p.ws, {
              type: "error",
              code: result.code,
              message: result.message,
            });
            continue;
          }
          hooks.send(p.ws, { type: "room_ready", roomId: meta.roomId });
          hooks.send(p.ws, {
            type: "room_status",
            roomId: meta.roomId,
            players: meta.occupants.size,
            maxPlayers: meta.maxPlayers,
            mapSize: meta.mapSize,
            allowRespawn: meta.allowRespawn,
            teamMode: meta.teamMode,
          });
        }
        hooks.onMatchFormed({
          roomId: meta.roomId,
          playerCount: needed,
          players: batch,
          teams,
          teamMode,
        });
      } catch (err) {
        console.error("[manager] match form failed", err);
        for (const p of batch) {
          hooks.send(p.ws, {
            type: "error",
            code: "MATCH_FAILED",
            message: "匹配房间创建失败",
          });
        }
      }
      this.broadcastStatus(queueKey);
    }
  }
}

function parseNeeded(key: MatchQueueKey): number {
  if (key.startsWith("ffa:")) {
    return Number(key.slice(4)) || 2;
  }
  const format = key.slice(5);
  if (isTeamFormat(format)) return formatSeatCount(format);
  return 2;
}

export { isTeamFormat, formatSeatCount };
