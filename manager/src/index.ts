import { createServer } from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { IdentityStore } from "./identity.js";
import {
  MatchQueues,
  ffaQueueKey,
  formatSeatCount,
  isMatchPlayerCount,
  isTeamFormat,
  teamQueueKey,
} from "./lobby.js";
import {
  isLobbyClientMessage,
  isMapSizeId,
  looksLikeSaveDocument,
  type LobbyServerMessage,
  type MapSizeId,
} from "./protocol.js";
import { RoomRegistry, normalizeRoomId } from "./rooms.js";
import { handleStatic } from "./httpStatic.js";
import { resolveGameRoomFactory } from "./gameBridge.js";
import {
  SaveDecryptError,
  SaveKeyMissingError,
  decryptSaveBlobBase64,
  encryptSaveDocumentBase64,
  hasSaveKey,
  readGameVersion,
} from "./saveCrypto.js";

const PORT = Number(process.env.PORT ?? "4358");

interface ConnSession {
  ws: WebSocket;
  playerId: string | null;
  name: string | null;
  /** Bound room while in-game; null in lobby. */
  roomId: string | null;
}

function send(ws: WebSocket, msg: LobbyServerMessage | Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

async function main(): Promise<void> {
  const identity = new IdentityStore();
  await identity.load();
  identity.start();

  const rooms = new RoomRegistry();
  const matchQueues = new MatchQueues();

  const sessions = new Map<WebSocket, ConnSession>();
  /** playerId → live session (latest socket). */
  const byPlayer = new Map<string, ConnSession>();

  rooms.setHooks({
    onRoomClosed(roomId, reason, playerIds) {
      for (const pid of playerIds) {
        const sess = byPlayer.get(pid);
        if (sess && sess.roomId === roomId) {
          sess.roomId = null;
          send(sess.ws, { type: "room_closed", roomId, reason });
        }
      }
    },
  });

  matchQueues.bind(rooms, {
    send: (ws, msg) => send(ws, msg as LobbyServerMessage),
    onMatchFormed({ roomId, players }) {
      for (const p of players) {
        const sess = sessions.get(p.ws);
        if (sess) sess.roomId = roomId;
      }
      console.log(`[manager] match formed room=${roomId} n=${players.length}`);
    },
  });

  rooms.start();

  // Warm GameRoom seam — must load real createRoom (no stub).
  await resolveGameRoomFactory();

  const server = createServer((req, res) => {
    handleStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    const session: ConnSession = {
      ws,
      playerId: null,
      name: null,
      roomId: null,
    };
    sessions.set(ws, session);

    ws.on("message", (data) => {
      void handleMessage(session, data);
    });

    ws.on("close", () => {
      cleanupSession(session);
    });

    ws.on("error", () => {
      cleanupSession(session);
    });
  });

  function cleanupSession(session: ConnSession): void {
    if (!sessions.has(session.ws)) return;
    sessions.delete(session.ws);
    const { playerId } = session;
    if (!playerId) return;

    matchQueues.remove(playerId);
    rooms.onDisconnect(playerId, session.ws);

    if (byPlayer.get(playerId) === session) {
      byPlayer.delete(playerId);
      identity.markDisconnected(playerId);
    }
  }

  async function handleMessage(
    session: ConnSession,
    data: RawData,
  ): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      sendError(session.ws, "BAD_JSON", "Invalid JSON");
      return;
    }

    if (!msg || typeof msg !== "object" || !("type" in msg)) {
      sendError(session.ws, "BAD_MESSAGE", "Missing type");
      return;
    }

    const type = (msg as { type: string }).type;

    // Lobby-only messages
    if (isLobbyClientMessage(msg)) {
      switch (msg.type) {
        case "hello": {
          const rec = identity.hello(msg.playerId, msg.name);
          session.playerId = rec.playerId;
          session.name = rec.name;
          byPlayer.set(rec.playerId, session);
          let activeRoomId = rooms.activeRoomIdFor(rec.playerId);

          // Rebind seat after title→/play/ navigation (or refresh): GameRoom.join
          // sends welcome+state on the new socket.
          if (activeRoomId) {
            const joined = rooms.join(
              activeRoomId,
              session.ws,
              rec.playerId,
              rec.name,
            );
            if (joined.ok) {
              session.roomId = activeRoomId;
              // GameRoom already emitted welcome+state; skip empty lobby welcome.
              return;
            }
            activeRoomId = null;
          }

          send(session.ws, {
            type: "welcome",
            playerId: rec.playerId,
            name: rec.name,
            activeRoomId,
          });
          return;
        }
        case "ping": {
          send(session.ws, { type: "pong", t: msg.t });
          return;
        }
        case "create_room": {
          if (!requireIdentity(session)) return;
          if (session.roomId) {
            sendError(session.ws, "ALREADY_IN_ROOM", "请先离开当前房间");
            return;
          }
          const saveBlob =
            typeof (msg as { saveBlob?: unknown }).saveBlob === "string"
              ? (msg as { saveBlob: string }).saveBlob.trim()
              : "";
          let restoreDoc: Record<string, unknown> | null = null;
          if (saveBlob) {
            if (!hasSaveKey()) {
              sendError(
                session.ws,
                "SAVE_KEY_MISSING",
                "服务器未配置 config.json saveKey，无法读档建房",
              );
              return;
            }
            try {
              const plain = decryptSaveBlobBase64(saveBlob);
              if (!looksLikeSaveDocument(plain)) {
                sendError(session.ws, "BAD_SAVE", "存档内容无效");
                return;
              }
              restoreDoc = plain as Record<string, unknown>;
            } catch (err) {
              if (err instanceof SaveKeyMissingError) {
                sendError(
                  session.ws,
                  "SAVE_KEY_MISSING",
                  "服务器未配置 config.json saveKey，无法读档建房",
                );
              } else if (err instanceof SaveDecryptError) {
                sendError(session.ws, "BAD_SAVE", err.message);
              } else {
                console.error("[manager] save decrypt failed", err);
                sendError(session.ws, "BAD_SAVE", "存档解密失败");
              }
              return;
            }
          }
          const mapSize: MapSizeId = restoreDoc
            ? isMapSizeId(restoreDoc.mapSize)
              ? restoreDoc.mapSize
              : "89x59"
            : msg.mapSize;
          if (!isMapSizeId(mapSize)) {
            sendError(session.ws, "BAD_MAP", "地图尺寸须为 89x59、119x79 或 179x119");
            return;
          }
          const maxPlayers = restoreDoc
            ? Number(restoreDoc.maxPlayers) || Number(msg.maxPlayers)
            : Number(msg.maxPlayers);
          if (!Number.isFinite(maxPlayers) || maxPlayers < 2 || maxPlayers > 10) {
            sendError(session.ws, "BAD_MAX", "人数上限须为 2–10");
            return;
          }
          const allowRespawn = restoreDoc
            ? Boolean(restoreDoc.allowRespawn)
            : Boolean(msg.allowRespawn);
          matchQueues.remove(session.playerId!);
          try {
            const meta = await rooms.createRoom({
              maxPlayers,
              allowRespawn,
              mapSize,
              seed: restoreDoc
                ? (restoreDoc.terrainSeed as number)
                : msg.seed,
              restore: restoreDoc ?? undefined,
              holderPlayerId: restoreDoc ? session.playerId! : undefined,
              gameVersion: readGameVersion(),
              teamMode: restoreDoc ? Boolean(restoreDoc.teamMode) : undefined,
              teams: restoreDoc
                ? (restoreDoc.teams as Record<string, string>)
                : undefined,
            });
            const joined = rooms.join(
              meta.roomId,
              session.ws,
              session.playerId!,
              session.name!,
            );
            if (!joined.ok) {
              await rooms.destroyRoom(meta.roomId, "join_failed");
              sendError(session.ws, joined.code, joined.message);
              return;
            }
            session.roomId = meta.roomId;
            send(session.ws, { type: "room_ready", roomId: meta.roomId });
            send(session.ws, {
              type: "room_status",
              roomId: meta.roomId,
              players: meta.occupants.size,
              maxPlayers: meta.maxPlayers,
              mapSize: meta.mapSize,
              allowRespawn: meta.allowRespawn,
            });
          } catch (err) {
            console.error("[manager] create_room failed", err);
            sendError(session.ws, "CREATE_FAILED", "无法创建房间");
          }
          return;
        }
        case "export_save": {
          if (!requireIdentity(session)) return;
          if (!session.roomId) {
            sendError(session.ws, "NOT_IN_ROOM", "当前不在房间内");
            return;
          }
          if (!hasSaveKey()) {
            sendError(
              session.ws,
              "SAVE_KEY_MISSING",
              "服务器未配置 config.json saveKey，无法导出存档",
            );
            return;
          }
          const meta = rooms.metaForPlayer(session.playerId!);
          if (!meta || meta.game.closed) {
            sendError(session.ws, "NOT_IN_ROOM", "当前不在房间内");
            return;
          }
          const exportFn = meta.game.exportPlainSave;
          if (typeof exportFn !== "function") {
            sendError(session.ws, "EXPORT_UNSUPPORTED", "当前房间不支持存档导出");
            return;
          }
          try {
            const plain = exportFn.call(meta.game, session.playerId!);
            if (!plain || typeof plain !== "object") {
              sendError(session.ws, "EXPORT_FAILED", "无法生成存档");
              return;
            }
            const doc = plain as {
              roomId?: string;
              tick?: number;
              gameVersion?: string;
            };
            doc.gameVersion = readGameVersion();
            const blob = encryptSaveDocumentBase64(doc);
            const filename = `wop-${doc.roomId ?? meta.roomId}-t${doc.tick ?? 0}.wopsave`;
            send(session.ws, { type: "save_export", blob, filename });
          } catch (err) {
            if (err instanceof SaveKeyMissingError) {
              sendError(
                session.ws,
                "SAVE_KEY_MISSING",
                "服务器未配置 config.json saveKey，无法导出存档",
              );
            } else {
              console.error("[manager] export_save failed", err);
              sendError(session.ws, "EXPORT_FAILED", "存档加密失败");
            }
          }
          return;
        }
        case "join_room": {
          if (!requireIdentity(session)) return;
          const roomId = normalizeRoomId(msg.roomId ?? "");
          if (!/^[A-Z0-9]{4,8}$/.test(roomId)) {
            sendError(session.ws, "BAD_ROOM_ID", "房间码无效");
            return;
          }
          if (session.roomId && session.roomId !== roomId) {
            rooms.leave(session.roomId, session.playerId!);
            session.roomId = null;
          }
          matchQueues.remove(session.playerId!);
          const joined = rooms.join(
            roomId,
            session.ws,
            session.playerId!,
            session.name!,
          );
          if (!joined.ok) {
            sendError(session.ws, joined.code, joined.message);
            return;
          }
          session.roomId = joined.meta.roomId;
          send(session.ws, { type: "room_ready", roomId: joined.meta.roomId });
          send(session.ws, {
            type: "room_status",
            roomId: joined.meta.roomId,
            players: joined.meta.occupants.size,
            maxPlayers: joined.meta.maxPlayers,
            mapSize: joined.meta.mapSize,
            allowRespawn: joined.meta.allowRespawn,
          });
          return;
        }
        case "queue_match": {
          if (!requireIdentity(session)) return;
          if (session.roomId) {
            sendError(session.ws, "ALREADY_IN_ROOM", "请先离开当前房间");
            return;
          }
          const teamFormat = isTeamFormat(msg.teamFormat)
            ? msg.teamFormat
            : undefined;
          if (teamFormat) {
            const needed = formatSeatCount(teamFormat);
            const queueKey = teamQueueKey(teamFormat);
            matchQueues.enqueue({
              playerId: session.playerId!,
              name: session.name!,
              ws: session.ws,
              queueKey,
              needed,
              teamFormat,
              enqueuedAt: Date.now(),
            });
            send(session.ws, {
              type: "queued",
              playerCount: needed,
              teamFormat,
            });
            const st = matchQueues.status(queueKey);
            send(session.ws, {
              type: "match_status",
              playerCount: needed,
              queued: st.queued,
              needed: st.needed,
              teamFormat,
            });
            return;
          }
          if (!isMatchPlayerCount(msg.playerCount)) {
            sendError(session.ws, "BAD_QUEUE", "匹配人数须为 2–5，或选择组队队形");
            return;
          }
          const queueKey = ffaQueueKey(msg.playerCount);
          matchQueues.enqueue({
            playerId: session.playerId!,
            name: session.name!,
            ws: session.ws,
            queueKey,
            needed: msg.playerCount,
            enqueuedAt: Date.now(),
          });
          send(session.ws, { type: "queued", playerCount: msg.playerCount });
          const st = matchQueues.status(queueKey);
          send(session.ws, {
            type: "match_status",
            playerCount: msg.playerCount,
            queued: st.queued,
            needed: st.needed,
          });
          return;
        }
        case "cancel_queue": {
          if (!requireIdentity(session)) return;
          const cancelled = matchQueues.cancel(session.playerId!);
          if (cancelled) send(session.ws, { type: "queue_cancelled" });
          return;
        }
        case "leave_room": {
          if (!requireIdentity(session)) return;
          if (session.roomId) {
            rooms.leave(session.roomId, session.playerId!);
            session.roomId = null;
          }
          return;
        }
      }
    }

    // In-room gameplay → GameRoom
    if (session.playerId && session.roomId) {
      const forwarded = rooms.dispatch(session.playerId, msg);
      if (!forwarded) {
        sendError(session.ws, "NOT_IN_ROOM", "当前不在房间内");
      }
      return;
    }

    sendError(
      session.ws,
      "UNKNOWN_MESSAGE",
      `未处理的消息类型：${type}`,
    );
  }

  function requireIdentity(session: ConnSession): boolean {
    if (!session.playerId || !session.name) {
      sendError(session.ws, "NOT_HELLO", "请先发送 hello");
      return false;
    }
    return true;
  }

  server.listen(PORT, () => {
    console.log(`[wop-manager] HTTP+WS listening on http://localhost:${PORT}`);
    console.log(`[wop-manager] WebSocket path: /ws`);
  });

  const shutdown = async () => {
    console.log("[wop-manager] shutting down…");
    rooms.stop();
    identity.stop();
    await identity.flush();
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[wop-manager] fatal", err);
  process.exit(1);
});
