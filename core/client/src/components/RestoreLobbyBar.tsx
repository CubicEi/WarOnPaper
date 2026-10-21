import type { RestoreIdentityOption } from "@wop/shared";

interface Props {
  /** restore = satellite restore lobby; ready = new-game post-capital ready. */
  mode?: "restore" | "ready";
  ready: boolean;
  readyCount: number;
  playerCount: number;
  canPickCapital: boolean;
  canAbandonCapital: boolean;
  restoreHolder: boolean;
  identities: RestoreIdentityOption[];
  onSetReady: (ready: boolean) => void;
  onAbandon: () => void;
  onInherit: (savePlayerId: string) => void;
}

/** Bottom-centered ready / identity controls for restore_lobby and ready_lobby. */
export function RestoreLobbyBar({
  mode = "restore",
  ready,
  readyCount,
  playerCount,
  canPickCapital,
  canAbandonCapital,
  restoreHolder,
  identities,
  onSetReady,
  onAbandon,
  onInherit,
}: Props) {
  const available = identities.filter((i) => !i.claimed && i.hasCapital);
  const hint =
    mode === "ready"
      ? canAbandonCapital
        ? "已选定首都 · 可放弃后重选 · 全员准备后开始"
        : "请先选定首都，再点击准备"
      : restoreHolder
        ? "你是存档持有者（继承保存人）· 全图卫星预览 · 全员准备后开始"
        : canPickCapital
          ? "卫星视野 · 请选都、继承未占用身份，或准备"
          : "卫星视野 · 可放弃首都后重选 · 全员准备后开始";

  return (
    <div className="restore-lobby-bar">
      <div className="restore-lobby-hint">
        {hint}
        <span className="restore-lobby-count">
          {" "}
          准备 {readyCount}/{playerCount}
        </span>
      </div>
      <div className="restore-lobby-actions">
        {canAbandonCapital ? (
          <button type="button" className="btn restore-lobby-btn" onClick={onAbandon}>
            {mode === "ready" ? "放弃首都，重新选择" : "放弃首都"}
          </button>
        ) : null}
        {mode === "restore" && canPickCapital && available.length > 0 ? (
          <label className="restore-lobby-inherit">
            继承身份
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) onInherit(v);
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                选择存档玩家…
              </option>
              {available.map((i) => (
                <option key={i.savePlayerId} value={i.savePlayerId}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className={`btn restore-lobby-btn${ready ? " is-ready" : " btn-accent"}`}
          onClick={() => onSetReady(!ready)}
        >
          {ready ? "取消准备" : "准备"}
        </button>
      </div>
    </div>
  );
}
