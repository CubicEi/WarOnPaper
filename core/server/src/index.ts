/**
 * Optional local debug entry: single GameRoom + WebSocket listen.
 * Library consumers must import from `./room.js` (or package root → room), not this file.
 *
 *   npm run start -w server
 *   PORT=8787 node dist/index.js
 */
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { TICK_MS, type ClientToServer, type ServerToClient } from "@wop/shared";
import { createRoom, type GameRoom } from "./room.js";

const PORT = Number(process.env.PORT ?? 8787);

function attachDebugServer(room: GameRoom, port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const playerByWs = new WeakMap<WebSocket, string>();

  wss.on("connection", (ws) => {
    const send = (msg: ServerToClient) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    let playerId: string | null = null;

    ws.on("message", (raw) => {
      let msg: ClientToServer;
      try {
        msg = JSON.parse(String(raw)) as ClientToServer;
      } catch {
        return;
      }

      if (playerId == null) {
        const id =
          msg.type === "hello" && typeof msg.playerId === "string" && msg.playerId
            ? msg.playerId
            : randomUUID();
        const name =
          msg.type === "hello" && msg.name
            ? msg.name
            : `Player-${id.slice(0, 4)}`;
        const joined = room.join({ playerId: id, name, send });
        if (!joined.ok) {
          send({ type: "error", code: joined.code, message: joined.message });
          ws.close();
          return;
        }
        playerId = joined.playerId;
        playerByWs.set(ws, playerId);
        if (msg.type !== "hello" && msg.type !== "ping") {
          room.dispatch(playerId, msg);
        }
        return;
      }

      room.dispatch(playerId, msg);
    });

    ws.on("close", () => {
      const id = playerByWs.get(ws);
      if (id) room.leave(id);
    });
  });

  const tickTimer = setInterval(() => room.tick(), TICK_MS);
  wss.on("close", () => clearInterval(tickTimer));

  room.on((ev) => {
    if (ev.type === "room_closed" || ev.type === "game_over") {
      console.log(`[wop-server:debug]`, ev);
    }
  });

  console.log(
    `[wop-server] debug WebSocket on ws://localhost:${port} room=${room.roomId}`,
  );
  return wss;
}

const room = createRoom({
  roomId: process.env.WOP_DEBUG_ROOM_ID ?? "DEBUG1",
  maxPlayers: 10,
  allowRespawn: true,
  mapSize: "89x59",
});
attachDebugServer(room, PORT);
