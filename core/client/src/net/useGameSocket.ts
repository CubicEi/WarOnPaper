import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientToServer, GameStateSnapshot, ServerToClient } from "@wop/shared";
import { log } from "./log";
import type { ChatMessage } from "../components/ChatPanel";
import { applyServerActionResult, logOutgoingAction } from "../debug/playerActionLog";

export type SocketStatus = "connecting" | "connected" | "disconnected";

function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Dev: game server is on 8787 of the machine that served the page.
  // Use that host so a LAN client reaches this PC, not its own localhost.
  if (import.meta.env.DEV) {
    const name = location.hostname;
    const host = name.includes(":") ? `[${name}]` : name;
    return `${proto}//${host}:8787`;
  }
  return `${proto}//${location.host}/ws`;
}

/** Friendly message for UI; `raw` keeps `code: message` for debug overlay. */
export type GameError = { message: string; raw: string };

export function useGameSocket(onState: (state: GameStateSnapshot) => void): {
  status: SocketStatus;
  send: (msg: ClientToServer) => boolean;
  lastError: GameError | null;
  clearError: () => void;
  playerId: string | null;
  chatMessages: ChatMessage[];
} {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [lastError, setLastError] = useState<GameError | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const onStateRef = useRef(onState);
  const playerIdRef = useRef<string | null>(null);
  const chatIdRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  onStateRef.current = onState;
  playerIdRef.current = playerId;

  const clearError = useCallback(() => setLastError(null), []);

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

  useEffect(() => {
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
        const hello: ClientToServer = { type: "hello", name: "commander" };
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
        if (msg.type === "welcome" || msg.type === "state") {
          if (msg.type === "welcome") {
            setPlayerId(msg.playerId);
            log.info("net", "← welcome", {
              playerId: msg.playerId,
              E: msg.state.you.energy,
              O: msg.state.you.organization,
              buildings: msg.state.buildings?.length ?? "(missing)",
            });
          } else {
            // Avoid flooding: only log when buildings/HUD change meaningfully via debug
            log.debug("net", "← state", {
              tick: msg.state.tick,
              E: msg.state.you.energy,
              O: msg.state.you.organization,
              buildings: msg.state.buildings?.length ?? 0,
            });
          }
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
        } else if (msg.type === "error") {
          log.warn("net", "← error", msg.code, msg.message);
          setLastError({
            message: msg.message,
            raw: `${msg.code}: ${msg.message}`,
          });
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
  }, []);

  return { status, send, lastError, clearError, playerId, chatMessages };
}
