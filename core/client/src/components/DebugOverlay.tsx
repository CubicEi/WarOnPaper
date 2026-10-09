import type { SocketStatus } from "../net/useGameSocket";
import { usePlayerActionLog } from "../debug/playerActionLog";
import {
  PLAYER_ACTION_CATEGORY_LABEL,
  PLAYER_ACTION_STATUS_LABEL,
  formatActionStamp,
} from "@wop/shared";
import configJson from "@config.json";

export interface DebugErrorEntry {
  id: number;
  /** Full line as shown in the old corner chip (may include code). */
  text: string;
}

interface Props {
  open: boolean;
  status: SocketStatus;
  statusLine: string;
  phaseHint: string | null;
  errors: DebugErrorEntry[];
}

/** Shown at the top of the F2 panel; sourced from repo-root config.json. */
export const DEBUG_BUILD_VERSION = configJson.version;

function shortPlayer(id: string | null): string {
  if (!id) return "";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** F2 overlay: status, error history, and player-action log. */
export function DebugOverlay({ open, status, statusLine, phaseHint, errors }: Props) {
  const actions = usePlayerActionLog();
  if (!open) return null;

  return (
    <div className="debug-overlay" aria-label="调试信息">
      <div className="debug-overlay-panel">
        <div className="debug-overlay-version">{DEBUG_BUILD_VERSION}</div>
        <div className="debug-overlay-title">调试 (F2)</div>
        <div className="status-chip" data-status={status}>
          {statusLine}
        </div>
        {phaseHint && (
          <div className="status-chip" data-status="connecting">
            {phaseHint}
          </div>
        )}
        <div className="debug-section-label">报错</div>
        <div className="debug-error-list">
          {errors.length === 0 ? (
            <div className="debug-error-empty">暂无报错</div>
          ) : (
            errors.map((e) => (
              <div key={e.id} className="status-chip" data-status="disconnected">
                {e.text}
              </div>
            ))
          )}
        </div>
        <div className="debug-section-label">
          玩家操作日志
          <span className="debug-section-hint">最近 {actions.length} 条 · 新→旧</span>
        </div>
        <div className="debug-action-log" role="log">
          {actions.length === 0 ? (
            <div className="debug-action-empty">尚无操作记录</div>
          ) : (
            actions.map((a) => (
              <div key={a.id} className="debug-action-row" data-ok={a.ok}>
                <span className="debug-action-meta">{formatActionStamp(a.t, a.tick)}</span>
                <span className="debug-action-cat">
                  {PLAYER_ACTION_CATEGORY_LABEL[a.category]}
                </span>
                <span className="debug-action-status">{PLAYER_ACTION_STATUS_LABEL[a.ok]}</span>
                <div className="debug-action-body">
                  <div className="debug-action-summary">{a.summary}</div>
                  {a.detail && <div className="debug-action-detail">{a.detail}</div>}
                  {a.reason && <div className="debug-action-reason">{a.reason}</div>}
                  {a.playerId && (
                    <div className="debug-action-pid">
                      {a.source === "server" ? "服务器" : "本地"} · {shortPlayer(a.playerId)}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
