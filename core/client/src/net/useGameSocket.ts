import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientToServer, GameStateSnapshot, ServerToClient } from "@wop/shared";
import { log } from "./log";
import type { ChatMessage } from "../components/ChatPanel";
import { applyServerActionResult, logOutgoingAction } from "../debug/playerActionLog";

export type SocketStatus = "connecting" | "connected" | "disconnected";

const LS_PLAYER_ID = "wop:playerId";
const LS_PLAYER_NAME = "wop:playerName";
const LS_LAST_ROOM = "wop:lastRoomId";

/** Prefer same-host `/ws` (manager). VITE_WS_URL overrides. Dev without proxy can still hit /ws via Vite. */
function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function readCachedIdentity(): { playerId?: string; name: string } {
  try {
    const playerId = localStorage.getItem(LS_PLAYER_ID) ?? undefined;
    const name = localStorage.getItem(LS_PLAYER_NAME) ?? "commander";
    return { playerId: playerId || undefined, name };
  } catch {
    return { name: "commander" };
  }
}

function cacheIdentity(playerId: string, name: string): void {
  try {
    localStorage.setItem(LS_PLAYER_ID, playerId);
    localStorage.setItem(LS_PLAYER_NAME, name);
  } catch {
    /* ignore quota */
  }
}

export function cacheLastRoomId(roomId: string | null | undefined): void {
  try {
    if (!roomId) localStorage.removeItem(LS_LAST_ROOM);
    else localStorage.setItem(LS_LAST_ROOM, roomId);
  } catch {
    /* ignore */
  }
}

export function readLastRoomId(): string | null {
  try {
    return localStorage.getItem(LS_LAST_ROOM);
  } catch {
    return null;
  }
}

/** Friendly message for UI; `raw` keeps `code: message` for debug overlay. */
export type GameError = { message: string; raw: string };

export type RoomLifecycleEvent =
  | {
      type: "game_over";
      roomId: string;
      winnerId: string;
      winnerName: string;
      winnerTeamId?: string;
      winnerPlayerIds?: string[];
      winnerNames?: string[];
    }
  | { type: "room_closed"; roomId: string; reason: "idle" | "game_over" | "destroyed" };

export function useGameSocket(
  onState: (state: GameStateSnapshot) => void,
  options?: {
    /** Fired on game_over / room_closed — wire return-to-menu in host UI. */
    onRoomLifecycle?: (ev: RoomLifecycleEvent) => void;
    /** When false, skip auto-connect (manager title screen owns the socket). Default true. */
    autoConnect?: boolean;
  },
): {
  status: SocketStatus;
  send: (msg: ClientToServer) => boolean;
  lastError: GameError | null;
  clearError: () => void;
  lastTip: string | null;
  clearTip: () => void;
  playerId: string | null;
  playerName: string | null;
  chatMessages: ChatMessage[];
  /** Send leave_room and clear last-room cache (host should navigate to title). */
  leaveRoom: () => boolean;
} {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [lastError, setLastError] = useState<GameError | null>(null);
  const [lastTip, setLastTip] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const onStateRef = useRef(onState);
  const onLifeRef = useRef(options?.onRoomLifecycle);
  const playerIdRef = useRef<string | null>(null);
  const chatIdRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  onStateRef.current = onState;
  onLifeRef.current = options?.onRoomLifecycle;
  playerIdRef.current = playerId;

  const clearError = useCallback(() => setLastError(null), []);
  const clearTip = useCallback(() => setLastTip(null), []);

  const send = useCallback((msg: ClientToServer): boolean => {
    const ws = wsRef.current;
    const ready = ws?.readyState;
    if (!ws || ready !== WebSocket.OPEN) {
      const detail = `ws not open (readyState=${ready ?? "null"})`;
      log.error("net", "send failed", msg.type, detail, msg);
      const message = `发送失败：${detail}`;
      setLastError({ message, raw: message });
      logOutgoingAction(msg, playerIdRef.current, false);
      return false;
    }
    const payload = JSON.stringify(msg);
    log.info("net", "→", msg.type, msg);
    ws.send(payload);
    logOutgoingAction(msg, playerIdRef.current, true);
    return true;
  }, []);

  const leaveRoom = useCallback((): boolean => {
    cacheLastRoomId(null);
    return send({ type: "leave_room" });
  }, [send]);

  const autoConnect = options?.autoConnect !== false;

  useEffect(() => {
    if (!autoConnect) {
      setStatus("disconnected");
      return;
    }

    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer = 0;
    let pingTimer = 0;
    const url = wsUrl();
    log.info("net", "connecting", url);

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        log.info("net", "open", url);
        setStatus("connected");
        setLastError(null);
        const id = readCachedIdentity();
        const hello: ClientToServer = {
          type: "hello",
          playerId: id.playerId,
          name: id.name,
        };
        ws?.send(JSON.stringify(hello));
        pingTimer = window.setInterval(() => {
          const ping: ClientToServer = { type: "ping", t: Date.now() };
          ws?.send(JSON.stringify(ping));
        }, 5000);
      };

      ws.onmessage = (ev) => {
        let msg: ServerToClient;
        try {
          msg = JSON.parse(String(ev.data)) as ServerToClient;
        } catch (err) {
          log.error("net", "bad json", err, ev.data);
          return;
        }
        if (msg.type === "welcome") {
          setPlayerId(msg.playerId);
          setPlayerName(msg.name);
          cacheIdentity(msg.playerId, msg.name);
          if (msg.activeRoomId) cacheLastRoomId(msg.activeRoomId);
          log.info("net", "← welcome", {
            playerId: msg.playerId,
            name: msg.name,
            activeRoomId: msg.activeRoomId,
            hasState: !!msg.state,
            E: msg.state?.you.energy,
            O: msg.state?.you.organization,
          });
          if (msg.state) {
            // Server-authoritative E/O (and world) — apply immediately on join/rejoin.
            onStateRef.current(msg.state);
          } else {
            // Fallback: /play/?roomId=… or cached room when manager did not rebind
            const urlRoom = new URLSearchParams(location.search).get("roomId");
            const roomId =
              msg.activeRoomId || urlRoom || readLastRoomId();
            if (roomId && location.pathname.includes("play")) {
              log.info("net", "→ join_room (play fallback)", roomId);
              ws?.send(JSON.stringify({ type: "join_room", roomId }));
            }
          }
        } else if (msg.type === "state") {
          if (msg.state.roomId) cacheLastRoomId(msg.state.roomId);
          log.debug("net", "← state", {
            tick: msg.state.tick,
            phase: msg.state.phase,
            role: msg.state.role,
            E: msg.state.you.energy,
            O: msg.state.you.organization,
            buildings: msg.state.buildings?.length,
            buildingsDelta: msg.state.buildingsDelta
              ? {
                  upserts: msg.state.buildingsDelta.upserts.length,
                  removes: msg.state.buildingsDelta.removes.length,
                }
              : undefined,
            liaisons: msg.state.liaisons?.length,
            liaisonsDelta: msg.state.liaisonsDelta
              ? {
                  upserts: msg.state.liaisonsDelta.upserts.length,
                  removes: msg.state.liaisonsDelta.removes.length,
                }
              : undefined,
          });
          // Apply wire snapshot; App merges bootstrap / change-only / entity deltas.
          // HUD E/O always absolute from server — never invent local balances.
          onStateRef.current(msg.state);
        } else if (msg.type === "chat") {
          chatIdRef.current += 1;
          const id = chatIdRef.current;
          setChatMessages((prev) =>
            [
              ...prev,
              {
                id,
                playerId: msg.playerId,
                name: msg.name,
                text: msg.text,
                t: msg.t,
                mine: msg.playerId === playerIdRef.current,
              },
            ].slice(-100),
          );
        } else if (msg.type === "action_result") {
          applyServerActionResult(msg);
        } else if (msg.type === "game_over") {
          log.info("net", "← game_over", msg);
          onLifeRef.current?.({
            type: "game_over",
            roomId: msg.roomId,
            winnerId: msg.winnerId,
            winnerName: msg.winnerName,
            winnerTeamId: msg.winnerTeamId,
            winnerPlayerIds: msg.winnerPlayerIds,
            winnerNames: msg.winnerNames,
          });
        } else if (msg.type === "room_closed") {
          log.info("net", "← room_closed", msg);
          cacheLastRoomId(null);
          onLifeRef.current?.({
            type: "room_closed",
            roomId: msg.roomId,
            reason: msg.reason,
          });
        } else if (msg.type === "error") {
          log.warn("net", "← error", msg.code, msg.message);
          setLastError({
            message: msg.message,
            raw: `${msg.code}: ${msg.message}`,
          });
        } else if (msg.type === "tip") {
          log.info("net", "← tip", msg.message);
          setLastTip(msg.message);
        } else if (msg.type === "pong") {
          // quiet
        } else {
          log.debug("net", "←", msg);
        }
      };

      ws.onclose = (ev) => {
        log.warn("net", "close", ev.code, ev.reason || "(no reason)");
        setStatus("disconnected");
        if (wsRef.current === ws) wsRef.current = null;
        window.clearInterval(pingTimer);
        if (!closed) {
          retryTimer = window.setTimeout(connect, 1200);
        }
      };

      ws.onerror = () => {
        log.error("net", "socket error", url);
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      log.info("net", "cleanup close");
      ws?.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [autoConnect]);

  return {
    status,
    send,
    lastError,
    clearError,
    lastTip,
    clearTip,
    playerId,
    playerName,
    chatMessages,
    leaveRoom,
  };
}
