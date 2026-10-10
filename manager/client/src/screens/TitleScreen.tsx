import { useCallback, useEffect, useMemo, useState } from "react";
import { LobbySocket, type MapSizeId, type ServerMsg } from "../net";
import {
  loadCachedIdentity,
  loadLastRoomId,
  randomDefaultName,
  saveIdentity,
  saveLastRoomId,
} from "../storage";
import configJson from "@config.json";
import { ErrorToast, type ToastVariant } from "../components/ErrorToast";
import { TitleMapBackdrop } from "./TitleMapBackdrop";

type ConnState = "connecting" | "open" | "closed";
type ModalId = "match" | "custom" | null;

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
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [lastRoomId, setLastRoomId] = useState<string | null>(() =>
    loadLastRoomId(),
  );

  const [modal, setModal] = useState<ModalId>(null);

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
  const [saveFileName, setSaveFileName] = useState<string | null>(null);
  const [saveBlobB64, setSaveBlobB64] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState("");

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastKey, setToastKey] = useState(0);
  const [toastVariant, setToastVariant] = useState<ToastVariant>("error");

  const showToast = useCallback(
    (message: string, variant: ToastVariant = "error") => {
      setToastVariant(variant);
      setToastMessage(message);
      setToastKey((k) => k + 1);
    },
    [],
  );

  const dismissToast = useCallback(() => setToastMessage(null), []);

  const goPlay = useCallback((roomId: string) => {
    saveLastRoomId(roomId);
    setLastRoomId(roomId);
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
          break;
        }
        case "queued":
          setQueuing(true);
          setQueueInfo(
            msg.teamFormat
              ? `已加入 ${msg.teamFormat} 组队匹配`
              : `已加入 ${msg.playerCount} 人匹配队列`,
          );
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
          break;
        case "room_ready": {
          const roomId = String(msg.roomId ?? "");
          setQueuing(false);
          setQueueInfo("");
          setActiveRoomId(roomId);
          goPlay(roomId);
          break;
        }
        case "room_closed":
          setActiveRoomId(null);
          if (lastRoomId === msg.roomId) {
            saveLastRoomId(null);
            setLastRoomId(null);
          }
          showToast(`房间已关闭（${roomClosedReason(msg.reason)}）`, "warn");
          break;
        case "error": {
          const code = String(msg.code ?? "");
          if (code === "BAD_QUEUE" || code === "ALREADY_IN_ROOM") {
            setQueuing(false);
            setQueueInfo("");
          }
          showToast(String(msg.message ?? msg.code ?? "错误"), "error");
          break;
        }
        default:
          break;
      }
    },
    [goPlay, lastRoomId, name, showToast],
  );

  const [socket] = useState(() => new LobbySocket());

  useEffect(() => {
    socket.setHandlers({
      onOpen: () => {
        setConn("open");
      },
      onClose: () => {
        setConn("closed");
        setQueuing(false);
        showToast("已断开，正在重连…", "error");
      },
      onMessage,
    });
  }, [socket, onMessage, showToast]);

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

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

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

  const onSaveFile = (file: File | null) => {
    if (!file) {
      setSaveFileName(null);
      setSaveBlobB64(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".wopsave")) {
      showToast("请选择 .wopsave 存档文件", "error");
      setSaveFileName(null);
      setSaveBlobB64(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result;
      if (!(buf instanceof ArrayBuffer)) {
        showToast("无法读取存档文件", "error");
        return;
      }
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      setSaveBlobB64(btoa(binary));
      setSaveFileName(file.name);
    };
    reader.onerror = () => {
      showToast("读取存档失败", "error");
    };
    reader.readAsArrayBuffer(file);
  };

  const createRoom = () => {
    rename();
    const seed = createSeed.trim();
    socket.send({
      type: "create_room",
      mapSize: createMap,
      allowRespawn,
      maxPlayers: createMax,
      ...(seed && !saveBlobB64 ? { seed } : {}),
      ...(saveBlobB64 ? { saveBlob: saveBlobB64 } : {}),
    });
  };

  const joinRoom = (code: string) => {
    const roomId = code.trim().toUpperCase();
    if (!roomId) {
      showToast("请输入房间码", "error");
      return;
    }
    rename();
    socket.send({ type: "join_room", roomId });
  };

  const rejoinId = activeRoomId ?? lastRoomId;

  return (
    <>
      <TitleMapBackdrop />
      <div className="app-shell">
        <ErrorToast
          message={toastMessage}
          toastKey={toastKey}
          variant={toastVariant}
          onDismiss={dismissToast}
        />

        <main className="title-hero">
          <h1 className="brand">纸上谈兵</h1>
          <div className="title-cta-cluster">
            <div className="field title-name-field">
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
                <button
                  type="button"
                  className="btn btn-ghost title-name-save"
                  onClick={rename}
                >
                  保存
                </button>
              </div>
            </div>
            <div className="title-cta-row">
              <button
                type="button"
                className="btn btn-hero btn-accent"
                onClick={() => setModal("match")}
              >
                匹配大厅
              </button>
              <button
                type="button"
                className="btn btn-hero"
                onClick={() => setModal("custom")}
              >
                自定义开始
              </button>
            </div>
            {queuing && queueInfo ? (
              <p className="title-queue-hint">{queueInfo}</p>
            ) : null}
          </div>
        </main>

        <div className="title-corner-meta">
          <span>
            <span className={`dot ${conn === "open" ? "live" : ""}`} />
            {conn === "open"
              ? "在线"
              : conn === "connecting"
                ? "连接中"
                : "离线"}
          </span>
          <span className="build-version" title="版本">
            {configJson.version}
          </span>
        </div>

        {modal ? (
          <div
            className="title-modal-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setModal(null);
            }}
          >
            <div
              className="title-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="title-modal-heading"
            >
              <div className="title-modal-head">
                <h2 id="title-modal-heading">
                  {modal === "match" ? "匹配大厅" : "自定义开始"}
                </h2>
                <button
                  type="button"
                  className="btn btn-ghost title-modal-close"
                  onClick={() => setModal(null)}
                  aria-label="关闭"
                >
                  关闭
                </button>
              </div>

              <div className="title-modal-body">
                {modal === "match" ? (
                  <section className="section">
                    <h3>匹配</h3>
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
                          <div
                            style={{ paddingTop: "0.35rem", opacity: 0.85 }}
                          >
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
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={cancelMatch}
                        >
                          取消
                        </button>
                      )}
                    </div>
                    {queueInfo ? (
                      <p className="status ok">{queueInfo}</p>
                    ) : null}
                  </section>
                ) : (
                  <>
                    <section className="section">
                      <h3>创建房间</h3>
                      <div className="row">
                        <div
                          className="field grow"
                          style={{ marginBottom: 0 }}
                        >
                          <label htmlFor="maxPlayers">人数上限（2–10）</label>
                          <input
                            id="maxPlayers"
                            type="number"
                            min={2}
                            max={10}
                            value={createMax}
                            disabled={!!saveBlobB64}
                            onChange={(e) =>
                              setCreateMax(Number(e.target.value))
                            }
                          />
                        </div>
                        <div
                          className="field grow"
                          style={{ marginBottom: 0 }}
                        >
                          <label htmlFor="mapSize">地图</label>
                          <select
                            id="mapSize"
                            value={createMap}
                            disabled={!!saveBlobB64}
                            onChange={(e) =>
                              setCreateMap(e.target.value as MapSizeId)
                            }
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
                          disabled={!!saveBlobB64}
                          onChange={(e) => setCreateSeed(e.target.value)}
                        />
                      </div>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={allowRespawn}
                          disabled={!!saveBlobB64}
                          onChange={(e) => setAllowRespawn(e.target.checked)}
                        />
                        首都沦陷后允许重生
                        {saveBlobB64 ? "（读档时沿用存档）" : ""}
                      </label>
                      <div className="field">
                        <label htmlFor="saveFile">
                          读档（可选 · .wopsave）
                        </label>
                        <div className="row">
                          <input
                            id="saveFile"
                            type="file"
                            accept=".wopsave,application/octet-stream"
                            onChange={(e) =>
                              onSaveFile(e.target.files?.[0] ?? null)
                            }
                          />
                          {saveFileName ? (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => {
                                setSaveFileName(null);
                                setSaveBlobB64(null);
                                const input = document.getElementById(
                                  "saveFile",
                                ) as HTMLInputElement | null;
                                if (input) input.value = "";
                              }}
                            >
                              清除
                            </button>
                          ) : null}
                        </div>
                        {saveFileName ? (
                          <p
                            className="status ok"
                            style={{ marginTop: "0.35rem" }}
                          >
                            将以此存档恢复：{saveFileName}
                          </p>
                        ) : (
                          <p className="hint-muted">
                            仅创建房间时可上传；对局中不可读档
                          </p>
                        )}
                      </div>
                      <div className="row" style={{ marginTop: "0.85rem" }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={conn !== "open"}
                          onClick={createRoom}
                        >
                          {saveBlobB64 ? "读档创建并进入" : "创建并进入"}
                        </button>
                      </div>
                    </section>

                    <section className="section">
                      <h3>输入房间码</h3>
                      <div className="row">
                        <input
                          className="grow"
                          value={joinCode}
                          placeholder="房间码"
                          maxLength={8}
                          onChange={(e) =>
                            setJoinCode(e.target.value.toUpperCase())
                          }
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
                        <h3>重新加入</h3>
                        <div className="row">
                          <span className="grow rejoin-label">
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
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
