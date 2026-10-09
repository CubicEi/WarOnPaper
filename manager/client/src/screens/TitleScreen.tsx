import { useCallback, useEffect, useMemo, useState } from "react";
import { LobbySocket, type MapSizeId, type ServerMsg } from "../net";
import {
  loadCachedIdentity,
  loadLastRoomId,
  randomDefaultName,
  saveIdentity,
  saveLastRoomId,
} from "../storage";
import versionJson from "@version.json";

type ConnState = "connecting" | "open" | "closed";

function roomClosedReason(raw: unknown): string {
  const key = String(raw ?? "unknown");
  const map: Record<string, string> = {
    idle: "空闲超时",
    game_over: "对局结束",
    destroyed: "已解散",
    join_failed: "加入失败",
    unknown: "未知",
  };
  return map[key] ?? key;
}

export function TitleScreen() {
  const cached = useMemo(() => loadCachedIdentity(), []);
  const [name, setName] = useState(
    () => cached.name ?? randomDefaultName(),
  );
  const [playerId, setPlayerId] = useState<string | null>(
    cached.playerId ?? null,
  );
  const [conn, setConn] = useState<ConnState>("connecting");
  const [status, setStatus] = useState("连接中…");
  const [statusKind, setStatusKind] = useState<"ok" | "error" | "">("");
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [lastRoomId, setLastRoomId] = useState<string | null>(() =>
    loadLastRoomId(),
  );

  const [matchCount, setMatchCount] = useState(2);
  const [teamFormat, setTeamFormat] = useState<
    "" | "2v2" | "3v3" | "4v4" | "2v2v2" | "3v3v3" | "2v2v2v2"
  >("");
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
          setStatus(`已登录：${n}`);
          setStatusKind("ok");
          break;
        }
        case "queued":
          setQueuing(true);
          setStatus(
            msg.teamFormat
              ? `已加入 ${msg.teamFormat} 组队匹配`
              : `已加入 ${msg.playerCount} 人匹配队列`,
          );
          setStatusKind("ok");
          break;
        case "match_status":
          setQueuing(true);
          setQueueInfo(
            msg.teamFormat
              ? `匹配中 ${msg.queued}/${msg.needed}（${msg.teamFormat}）`
              : `匹配中 ${msg.queued}/${msg.needed}（${msg.playerCount} 人局）`,
          );
          break;
        case "queue_cancelled":
          setQueuing(false);
          setQueueInfo("");
          setStatus("已取消匹配");
          setStatusKind("");
          break;
        case "room_ready": {
          const roomId = String(msg.roomId ?? "");
          setQueuing(false);
          setQueueInfo("");
          setActiveRoomId(roomId);
          setStatus(`正在进入房间 ${roomId}…`);
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
          setStatus(`房间已关闭（${roomClosedReason(msg.reason)}）`);
          setStatusKind("");
          break;
        case "error": {
          const code = String(msg.code ?? "");
          if (code === "BAD_QUEUE" || code === "ALREADY_IN_ROOM") {
            setQueuing(false);
            setQueueInfo("");
          }
          setStatus(String(msg.message ?? msg.code ?? "错误"));
          setStatusKind("error");
          break;
        }
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
        setStatus("已连接");
        setStatusKind("");
      },
      onClose: () => {
        setConn("closed");
        setQueuing(false);
        setStatus("已断开，正在重连…");
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
    setQueuing(true);
    if (teamFormat) {
      socket.send({ type: "queue_match", teamFormat });
    } else {
      socket.send({ type: "queue_match", playerCount: matchCount });
    }
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
      setStatus("请输入房间码");
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
              ? "在线"
              : conn === "connecting"
                ? "连接中"
                : "离线"}
          </span>
          <span className="build-version" title="版本">
            {versionJson.version}
          </span>
        </div>

        <h1 className="brand">纸上谈兵</h1>
        <p className="tagline">标题大厅 · 匹配 · 房间</p>

        <div className="field">
          <label htmlFor="username">指挥官名称</label>
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
              保存
            </button>
          </div>
        </div>

        <section className="section">
          <h2>匹配</h2>
          <div className="row">
            <div className="field grow" style={{ marginBottom: 0 }}>
              <label htmlFor="teamFormat">组队</label>
              <select
                id="teamFormat"
                value={teamFormat}
                disabled={queuing}
                onChange={(e) => {
                  if (queuing) return;
                  setTeamFormat(
                    e.target.value as
                      | ""
                      | "2v2"
                      | "3v3"
                      | "4v4"
                      | "2v2v2"
                      | "3v3v3"
                      | "2v2v2v2",
                  );
                }}
              >
                <option value="">无（自由混战）</option>
                <option value="2v2">2v2 · 4 人</option>
                <option value="3v3">3v3 · 6 人</option>
                <option value="4v4">4v4 · 8 人</option>
                <option value="2v2v2">2v2v2 · 6 人</option>
                <option value="3v3v3">3v3v3 · 9 人</option>
                <option value="2v2v2v2">2v2v2v2 · 8 人</option>
              </select>
            </div>
            {!teamFormat ? (
              <div className="field grow" style={{ marginBottom: 0 }}>
                <label htmlFor="matchCount">人数（2–5）</label>
                <select
                  id="matchCount"
                  value={matchCount}
                  disabled={queuing}
                  onChange={(e) => {
                    if (queuing) return;
                    setMatchCount(Number(e.target.value));
                  }}
                >
                  {[2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} 人 · {n <= 3 ? "89×59" : "119×79"}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field grow" style={{ marginBottom: 0 }}>
                <label>地图</label>
                <div style={{ paddingTop: "0.35rem", opacity: 0.85 }}>
                  119×79（组队局）
                </div>
              </div>
            )}
            {!queuing ? (
              <button
                type="button"
                className="btn btn-accent"
                disabled={conn !== "open"}
                onClick={startMatch}
              >
                开始匹配
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={cancelMatch}>
                取消
              </button>
            )}
          </div>
          {queueInfo ? <p className="status ok">{queueInfo}</p> : null}
        </section>

        <section className="section">
          <h2>创建房间</h2>
          <div className="row">
            <div className="field grow" style={{ marginBottom: 0 }}>
              <label htmlFor="maxPlayers">人数上限（2–10）</label>
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
              <label htmlFor="mapSize">地图</label>
              <select
                id="mapSize"
                value={createMap}
                onChange={(e) => setCreateMap(e.target.value as MapSizeId)}
              >
                <option value="89x59">小型 89×59</option>
                <option value="119x79">大型 119×79</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="seed">种子（可选）</label>
            <input
              id="seed"
              value={createSeed}
              placeholder="留空则随机"
              onChange={(e) => setCreateSeed(e.target.value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={allowRespawn}
              onChange={(e) => setAllowRespawn(e.target.checked)}
            />
            首都沦陷后允许重生
          </label>
          <div className="row" style={{ marginTop: "0.85rem" }}>
            <button
              type="button"
              className="btn"
              disabled={conn !== "open"}
              onClick={createRoom}
            >
              创建并进入
            </button>
          </div>
        </section>

        <section className="section">
          <h2>输入房间码</h2>
          <div className="row">
            <input
              className="grow"
              value={joinCode}
              placeholder="房间码"
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
              加入
            </button>
          </div>
        </section>

        {rejoinId ? (
          <section className="section">
            <h2>重新加入</h2>
            <div className="row">
              <span className="grow" style={{ color: "var(--ink-muted)" }}>
                上次房间 <strong>{rejoinId}</strong>
              </span>
              <button
                type="button"
                className="btn btn-accent"
                disabled={conn !== "open"}
                onClick={() => joinRoom(rejoinId)}
              >
                重新进入
              </button>
            </div>
          </section>
        ) : null}

        <p className={`status ${statusKind}`}>{status}</p>
      </main>
    </div>
  );
}
