import type { TeamInvitePending, TeamRoster } from "@wop/shared";
import { sameTeam, teamIdOf } from "@wop/shared";

const TEAM_ICON = "/ui/team.png";

export interface TeamPanelPlayer {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  myPlayerId: string;
  players: readonly TeamPanelPlayer[];
  teams: TeamRoster;
  invites: readonly TeamInvitePending[];
  frozen: boolean;
  onInvite: (toPlayerId: string) => void;
  onAccept: (fromPlayerId: string) => void;
  onReject: (fromPlayerId: string) => void;
  onLeave: () => void;
}

/** Centered custom-room team invite panel (pick_capital, ≥3 players). */
export function TeamPanel({
  open,
  onClose,
  myPlayerId,
  players,
  teams,
  invites,
  frozen,
  onInvite,
  onAccept,
  onReject,
  onLeave,
}: Props) {
  if (!open) return null;

  const myTeam = teamIdOf(teams, myPlayerId);
  const incoming = invites.filter((i) => i.toPlayerId === myPlayerId);
  const outgoing = invites.filter((i) => i.fromPlayerId === myPlayerId);
  const inTeam = players.some(
    (p) => p.id !== myPlayerId && sameTeam(teams, p.id, myPlayerId),
  );

  return (
    <div className="team-panel-backdrop" role="dialog" aria-label="组队">
      <div className="team-panel">
        <header className="team-panel-head">
          <img src={TEAM_ICON} alt="" width={28} height={28} />
          <h2>组队</h2>
          <button type="button" className="team-panel-close" onClick={onClose}>
            ×
          </button>
        </header>
        {frozen ? (
          <p className="team-panel-note">已有首都放置，队伍已锁定</p>
        ) : (
          <p className="team-panel-note">邀请队友；接受后加入对方队伍</p>
        )}
        <ul className="team-panel-list">
          {players.map((p) => {
            const tid = teamIdOf(teams, p.id);
            const isMe = p.id === myPlayerId;
            const teammate = !isMe && sameTeam(teams, p.id, myPlayerId);
            const pendingOut = outgoing.some((i) => i.toPlayerId === p.id);
            return (
              <li key={p.id} className={teammate ? "is-ally" : ""}>
                <span className="team-panel-name">
                  {p.name}
                  {isMe ? "（你）" : ""}
                </span>
                <span className="team-panel-tid" title="队伍">
                  {tid === p.id ? "独行" : tid}
                </span>
                {!frozen && !isMe && !teammate ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={pendingOut}
                    onClick={() => onInvite(p.id)}
                  >
                    {pendingOut ? "已邀请" : "邀请"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {incoming.length > 0 ? (
          <div className="team-panel-incoming">
            <h3>待处理邀请</h3>
            {incoming.map((inv) => {
              const from = players.find((p) => p.id === inv.fromPlayerId);
              return (
                <div key={`${inv.fromPlayerId}-${inv.toPlayerId}`} className="team-panel-inv">
                  <span>{from?.name ?? inv.fromPlayerId.slice(0, 8)}</span>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={frozen}
                    onClick={() => onAccept(inv.fromPlayerId)}
                  >
                    接受
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onReject(inv.fromPlayerId)}
                  >
                    拒绝
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {inTeam && !frozen ? (
          <button type="button" className="btn btn-ghost team-panel-leave" onClick={onLeave}>
            退出队伍（{myTeam}）
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function TeamPanelButton({
  onClick,
  visible,
}: {
  onClick: () => void;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      className="team-panel-fab"
      onClick={onClick}
      title="组队"
      aria-label="组队"
    >
      <img src={TEAM_ICON} alt="" width={32} height={32} />
    </button>
  );
}
