import type { WebSocket } from "ws";
import type { MapSizeId } from "./protocol.js";
import type { RoomRegistry } from "./rooms.js";

export type MatchPlayerCount = 2 | 3 | 4 | 5;

export interface QueuedPlayer {
  playerId: string;
  name: string;
  ws: WebSocket;
  playerCount: MatchPlayerCount;
  enqueuedAt: number;
}

export function isMatchPlayerCount(n: unknown): n is MatchPlayerCount {
  return n === 2 || n === 3 || n === 4 || n === 5;
}

/** Matchmaking: 2–3 → small map, 4–5 → large; allowRespawn=false. */
export function mapSizeForMatch(playerCount: MatchPlayerCount): MapSizeId {
  return playerCount <= 3 ? "89x59" : "119x79";
}

export type MatchLobbyHooks = {
  send: (ws: WebSocket, msg: unknown) => void;
  onMatchFormed: (info: {
    roomId: string;
    playerCount: MatchPlayerCount;
    players: QueuedPlayer[];
  }) => void;
};

/**
 * Separate FIFO queues keyed by target party size (2 / 3 / 4 / 5).
 */
export class MatchQueues {
  private readonly queues = new Map<MatchPlayerCount, QueuedPlayer[]>([
    [2, []],
    [3, []],
    [4, []],
    [5, []],
  ]);
  private hooks: MatchLobbyHooks | null = null;
  private rooms: RoomRegistry | null = null;

  bind(rooms: RoomRegistry, hooks: MatchLobbyHooks): void {
    this.rooms = rooms;
    this.hooks = hooks;
  }

  enqueue(player: QueuedPlayer): void {
    this.remove(player.playerId);
    const q = this.queues.get(player.playerCount)!;
    q.push(player);
    this.broadcastStatus(player.playerCount);
    void this.tryForm(player.playerCount);
  }

  cancel(playerId: string): boolean {
    const found = this.find(playerId);
    if (!found) return false;
    this.remove(playerId);
    this.broadcastStatus(found.playerCount);
    return true;
  }

  /** Drop from any queue (disconnect / enter room). */
  remove(playerId: string): void {
    for (const [count, q] of this.queues) {
      const idx = q.findIndex((p) => p.playerId === playerId);
      if (idx >= 0) {
        q.splice(idx, 1);
        this.broadcastStatus(count);
        return;
      }
    }
  }

  isQueued(playerId: string): boolean {
    return this.find(playerId) != null;
  }

  status(playerCount: MatchPlayerCount): { queued: number; needed: number } {
    const queued = this.queues.get(playerCount)?.length ?? 0;
    return { queued, needed: playerCount };
  }

  private find(
    playerId: string,
  ): { playerCount: MatchPlayerCount; entry: QueuedPlayer } | null {
    for (const [count, q] of this.queues) {
      const entry = q.find((p) => p.playerId === playerId);
      if (entry) return { playerCount: count, entry };
    }
    return null;
  }

  private broadcastStatus(playerCount: MatchPlayerCount): void {
    const q = this.queues.get(playerCount) ?? [];
    const payload = {
      type: "match_status" as const,
      playerCount,
      queued: q.length,
      needed: playerCount,
    };
    for (const p of q) {
      this.hooks?.send(p.ws, payload);
    }
  }

  private async tryForm(playerCount: MatchPlayerCount): Promise<void> {
    const rooms = this.rooms;
    const hooks = this.hooks;
    if (!rooms || !hooks) return;

    const q = this.queues.get(playerCount)!;
    while (q.length >= playerCount) {
      const batch = q.splice(0, playerCount);
      try {
        const meta = await rooms.createRoom({
          maxPlayers: playerCount,
          allowRespawn: false,
          mapSize: mapSizeForMatch(playerCount),
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
          });
        }
        hooks.onMatchFormed({
          roomId: meta.roomId,
          playerCount,
          players: batch,
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
      this.broadcastStatus(playerCount);
    }
  }
}
