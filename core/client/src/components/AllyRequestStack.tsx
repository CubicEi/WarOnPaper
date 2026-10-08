import { useState } from "react";
import type { AllyGarrisonRequest } from "@wop/shared";
import { UNIT_BY_KIND } from "@wop/shared";

interface Props {
  requests: readonly AllyGarrisonRequest[];
  playerNames: readonly { id: string; name: string }[];
  buildingLabels: ReadonlyMap<string, string>;
  width: number;
  onAccept: (requestId: string) => void;
  onReject: (requestId: string) => void;
}

/** Chips above ChatPanel for pending ally garrison approvals. */
export function AllyRequestStack({
  requests,
  playerNames,
  buildingLabels,
  width,
  onAccept,
  onReject,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (requests.length === 0) return null;

  const open = openId ? requests.find((r) => r.id === openId) : null;

  return (
    <div className="ally-req-stack" style={{ width }} aria-label="友方进驻申请">
      {requests.map((r) => (
        <button
          key={r.id}
          type="button"
          className={`ally-req-chip${openId === r.id ? " is-open" : ""}`}
          onClick={() => setOpenId(openId === r.id ? null : r.id)}
        >
          进驻申请
        </button>
      ))}
      {open ? (
        <div className="ally-req-detail">
          <div className="ally-req-row">
            <span>申请人</span>
            <strong>
              {playerNames.find((p) => p.id === open.fromPlayerId)?.name ??
                open.fromPlayerId.slice(0, 8)}
            </strong>
          </div>
          <div className="ally-req-row">
            <span>单位</span>
            <strong>
              {(UNIT_BY_KIND as Record<string, { name?: string }>)[open.unitKind]
                ?.name ?? open.unitKind}{" "}
              · {open.unitU} U
            </strong>
          </div>
          <div className="ally-req-row">
            <span>目标</span>
            <strong>
              {buildingLabels.get(open.buildingId) ?? open.buildingId.slice(0, 8)}
            </strong>
          </div>
          <div className="ally-req-actions">
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => {
                onAccept(open.id);
                setOpenId(null);
              }}
            >
              接受
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onReject(open.id);
                setOpenId(null);
              }}
            >
              拒绝
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
