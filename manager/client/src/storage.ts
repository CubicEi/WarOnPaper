const PREFIX = "wop:";

export const LS = {
  playerId: `${PREFIX}playerId`,
  playerName: `${PREFIX}playerName`,
  lastRoomId: `${PREFIX}lastRoomId`,
} as const;

export function loadCachedIdentity(): { playerId?: string; name?: string } {
  try {
    const playerId = localStorage.getItem(LS.playerId) ?? undefined;
    const name = localStorage.getItem(LS.playerName) ?? undefined;
    return { playerId: playerId || undefined, name: name || undefined };
  } catch {
    return {};
  }
}

export function saveIdentity(playerId: string, name: string): void {
  try {
    localStorage.setItem(LS.playerId, playerId);
    localStorage.setItem(LS.playerName, name);
  } catch {
    /* ignore */
  }
}

export function loadLastRoomId(): string | null {
  try {
    return localStorage.getItem(LS.lastRoomId);
  } catch {
    return null;
  }
}

export function saveLastRoomId(roomId: string | null): void {
  try {
    if (roomId) localStorage.setItem(LS.lastRoomId, roomId);
    else localStorage.removeItem(LS.lastRoomId);
  } catch {
    /* ignore */
  }
}

export function randomDefaultName(): string {
  return `Commander-${Math.floor(Math.random() * 9000 + 1000)}`;
}
