import { useCallback, useEffect, useMemo, useState } from "react";
import { LobbySocket, type MapSizeId, type ServerMsg } from "../net";
import {
  loadCachedIdentity,
  loadLastRoomId,
  randomDefaultName,
  saveIdentity,
  saveLastRoomId,
} from "../storage";

type ConnState = "connecting" | "open" | "closed";

export function TitleScreen() {
  const cached = useMemo(() => loadCachedIdentity(), []);
  const [name, setName] = useState(
    () => cached.name ?? randomDefaultName(),
  );
  const [playerId, setPlayerId] = useState<string | null>(
    cached.playerId ?? null,
  );
  const [conn, setConn] = useState<ConnState>("connecting");
  const [status, setStatus] = useState("Connecting…");
  const [statusKind, setStatusKind] = useState<"ok" | "error" | "">("");
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [lastRoomId, setLastRoomId] = useState<string | null>(() =>
    loadLastRoomId(),
  );

  const [matchCount, setMatchCount] = useState(2);
  const [queuing, setQueuing] = useState(false);
  const [queueInfo, setQueueInfo] = useState("");

  const [createMax, setCreateMax] = useState(4);
  const [createMap, setCreateMap] = useState<MapSizeId>("89x59");
  const [createSeed, setCreateSeed] = useState("");
  const [allowRespawn, setAllowRespawn] = useState(true);

  const [joinCode, setJoinCode] = useState("");

  const goPlay = useCallback((roomId: string) => {
    saveLastRoomId(roomId);
    setLastRoomId(roomId);
    // Core play client served by manager at /play/
    const q = new URLSearchParams({ roomId });
    window.location.href = `/play/?${q.toString()}`;
  }, []);

  const onMessage = useCallback(
    (msg: ServerMsg) => {
      switch (msg.type) {
        case "welcome": {
          const id = String(msg.playerId ?? "");
          const n = String(msg.name ?? name);
          setPlayerId(id);
          setName(n);
          saveIdentity(id, n);
          const active =
            typeof msg.activeRoomId === "string" && msg.activeRoomId
              ? msg.activeRoomId
              : null;
          setActiveRoomId(active);
          if (active) {
            saveLastRoomId(active);
            setLastRoomId(active);
          }
          setStatus(`Signed in as ${n}`);
          setStatusKind("ok");
          break;
        }
        case "queued":
          setQueuing(true);
          setStatus(`Queued for ${msg.playerCount}-player match`);
          setStatusKind("ok");
          break;
        case "match_status":
          setQueueInfo(
            `Queue ${msg.queued}/${msg.needed} for ${msg.playerCount} players`,
          );
          break;
        case "queue_cancelled":
          setQueuing(false);
          setQueueInfo("");
          setStatus("Matchmaking cancelled");
          setStatusKind("");
          break;
        case "room_ready": {
          const roomId = String(msg.roomId ?? "");
          setQueuing(false);
          setQueueInfo("");
          setActiveRoomId(roomId);
          setStatus(`Entering room ${roomId}…`);
          setStatusKind("ok");
          goPlay(roomId);
          break;
        }
        case "room_closed":
          setActiveRoomId(null);
          if (lastRoomId === msg.roomId) {
            saveLastRoomId(null);
            setLastRoomId(null);
          }
          setStatus(`Room closed (${String(msg.reason ?? "unknown")})`);
          setStatusKind("");
          break;
        case "error":
          setStatus(String(msg.message ?? msg.code ?? "Error"));
          setStatusKind("error");
          break;
        default:
          break;
      }
    },
    [goPlay, lastRoomId, name],
  );

  const [socket] = useState(() => new LobbySocket());

  useEffect(() => {
    socket.setHandlers({
      onOpen: () => {
        setConn("open");
        setStatus("Connected");
        setStatusKind("");
      },
      onClose: () => {
        setConn("closed");
        setQueuing(false);
        setStatus("Disconnected — reconnecting…");
        setStatusKind("error");
      },
      onMessage,
    });
  }, [socket, onMessage]);

  useEffect(() => {
    socket.connect();
    return () => socket.close();
  }, [socket]);

  useEffect(() => {
    if (conn !== "open") return;
    const cachedId = loadCachedIdentity().playerId;
    socket.send({
      type: "hello",
      playerId: cachedId ?? playerId ?? undefined,
      name: name.trim() || randomDefaultName(),
    });
    // Hello once per successful open; name edits use rename().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, socket]);

  const rename = () => {
    const n = name.trim() || randomDefaultName();
    setName(n);
    socket.send({
      type: "hello",
      playerId: playerId ?? undefined,
      name: n,
    });
  };

  const startMatch = () => {
    rename();
    socket.send({ type: "queue_match", playerCount: matchCount });
  };

  const cancelMatch = () => {
    socket.send({ type: "cancel_queue" });
  };

  const createRoom = () => {
    rename();
    const seed = createSeed.trim();
    socket.send({
      type: "create_room",
      mapSize: createMap,
      allowRespawn,
      maxPlayers: createMax,
      ...(seed ? { seed } : {}),
    });
  };

  const joinRoom = (code: string) => {
    const roomId = code.trim().toUpperCase();
    if (!roomId) {
      setStatus("Enter a room code");
      setStatusKind("error");
      return;
    }
    rename();
    socket.send({ type: "join_room", roomId });
  };

  const rejoinId = activeRoomId ?? lastRoomId;

  return (
    <div className="app-shell">
      <main className="title-screen">
        <div className="conn">
          <span>
            <span className={`dot ${conn === "open" ? "live" : ""}`} />
            {conn === "open"
              ? "Online"
              : conn === "connecting"
                ? "Connecting"
                : "Offline"}
          </span>
          <span>{playerId ? playerId.slice(0, 8) : "—"}</span>
        </div>

        <h1 className="brand">纸上谈兵</h1>
        <p className="tagline">Title lobby · match · rooms on :4358</p>

        <div className="field">
          <label htmlFor="username">Commander name</label>
          <div className="row">
            <input
              id="username"
              className="grow"
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
            />
            <button type="button" className="btn btn-ghost" onClick={rename}>
              Save
            </button>
          </div>
        </div>

        <section className="section">
          <h2>Matchmaking</h2>
          <div className="row">
            <div className="field grow" style={{ marginBottom: 0 }}>
              <label htmlFor="matchCount">Players (2–5)</label>
              <select
                id="matchCount"
                value={matchCount}
                disabled={queuing}
                onChange={(e) => setMatchCount(Number(e.target.value))}
              >
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} players · {n <= 3 ? "89×59" : "119×79"}
                  </option>
                ))}
              </select>
            </div>
            {!queuing ? (
              <button
                type="button"
                className="btn btn-accent"
                disabled={conn !== "open"}
                onClick={startMatch}
              >
                Queue
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={cancelMatch}>
                Cancel
              </button>
            )}
          </div>
          {queueInfo ? <p className="status ok">{queueInfo}</p> : null}
        </section>

        <section className="section">
          <h2>Create room</h2>
          <div className="row">
            <div className="field grow" style={{ marginBottom: 0 }}>
              <label htmlFor="maxPlayers">Max players (2–10)</label>
              <input
                id="maxPlayers"
                type="number"
                min={2}
                max={10}
                value={createMax}
                onChange={(e) => setCreateMax(Number(e.target.value))}
              />
            </div>
            <div className="field grow" style={{ marginBottom: 0 }}>
              <label htmlFor="mapSize">Map</label>
              <select
                id="mapSize"
                value={createMap}
                onChange={(e) => setCreateMap(e.target.value as MapSizeId)}
              >
                <option value="89x59">Small 89×59</option>
                <option value="119x79">Large 119×79</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="seed">Seed (optional)</label>
            <input
              id="seed"
              value={createSeed}
              placeholder="random if empty"
              onChange={(e) => setCreateSeed(e.target.value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={allowRespawn}
              onChange={(e) => setAllowRespawn(e.target.checked)}
            />
            Allow respawn after capital falls
          </label>
          <div className="row" style={{ marginTop: "0.85rem" }}>
            <button
              type="button"
              className="btn"
              disabled={conn !== "open"}
              onClick={createRoom}
            >
              Create & enter
            </button>
          </div>
        </section>

        <section className="section">
          <h2>Join by code</h2>
          <div className="row">
            <input
              className="grow"
              value={joinCode}
              placeholder="ROOM CODE"
              maxLength={8}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") joinRoom(joinCode);
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={conn !== "open"}
              onClick={() => joinRoom(joinCode)}
            >
              Join
            </button>
          </div>
        </section>

        {rejoinId ? (
          <section className="section">
            <h2>Rejoin</h2>
            <div className="row">
              <span className="grow" style={{ color: "var(--ink-muted)" }}>
                Last room <strong>{rejoinId}</strong>
              </span>
              <button
                type="button"
                className="btn btn-accent"
                disabled={conn !== "open"}
                onClick={() => joinRoom(rejoinId)}
              >
                Re-enter
              </button>
            </div>
          </section>
        ) : null}

        <p className={`status ${statusKind}`}>{status}</p>
      </main>
    </div>
  );
}
