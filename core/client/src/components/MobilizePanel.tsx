import {
  BUILDING_BY_ID,
  UNIT_BY_KIND,
  UNIT_MOVE_O_COST,
  UNIT_BLOCKADE_O_COST,
  UNIT_BLOCKADE_ENTER_E_PER_U,
  UNIT_SUPPLY_O_COST,
  UNIT_HOLD_O_COST,
  UNIT_HOLD_ENTER_E_PER_U,
  UNIT_ATTACK_LAND_O_COST,
  UNIT_ATTACK_AIR_NAVY_O_COST,
  isMovingState,
  unitKindFromBuilding,
  usesCarriedSupply,
  garrisonLockedInBuilding,
  attackOrganizationCost,
} from "@wop/shared";
import type { PlacedBuilding, UnitGroup } from "@wop/shared";

export type MobilizeMode = "move" | "blockade" | "supply" | "attack" | "hold" | "assign";

interface Props {
  mode?: MobilizeMode;
  destGx: number;
  destGy: number;
  buildings: readonly PlacedBuilding[];
  units: readonly UnitGroup[];
  myPlayerId: string | null;
  organization: number;
  energy: number;
  sources: Record<string, number>;
  unitIds: string[];
  onToggleSource: (buildingId: string, u: number) => void;
  onToggleUnit: (id: string) => void;
  onGo: () => void;
  onEndBlockade?: () => void;
  onEndHold?: () => void;
  onClose: () => void;
  /** Building that fielded groups will be reassigned to (mode === "assign"). */
  assignBuildingId?: string;
  /** Path / room error from a dry-run of the current selection. */
  planError?: string | null;
}

function distTo(
  gx: number,
  gy: number,
  destGx: number,
  destGy: number,
): number {
  return Math.hypot(gx - destGx, gy - destGy);
}

export function MobilizePanel({
  mode = "move",
  destGx,
  destGy,
  buildings,
  units,
  myPlayerId,
  organization,
  energy,
  sources,
  unitIds,
  onToggleSource,
  onToggleUnit,
  onGo,
  onEndBlockade,
  onEndHold,
  onClose,
  assignBuildingId,
  planError,
}: Props) {
  const isBlockade = mode === "blockade";
  const isSupply = mode === "supply";
  const isAttack = mode === "attack";
  const isHold = mode === "hold";
  const isAssign = mode === "assign";
  const assignBuilding = isAssign
    ? buildings.find((b) => b.id === assignBuildingId)
    : undefined;
  const assignKind = assignBuilding
    ? unitKindFromBuilding(assignBuilding.buildingId)
    : null;
  const garrison = (
    isAssign
      ? []
      : buildings.filter((b) => {
          if (myPlayerId == null || b.ownerId !== myPlayerId) return false;
          if ((b.u ?? 0) < 1) return false;
          const kind = unitKindFromBuilding(b.buildingId);
          if (!kind) return false;
          if (isSupply && !usesCarriedSupply(kind)) return false;
          if (b.buildTicksRemaining > 0) return false;
          if (garrisonLockedInBuilding(b.buildingId)) return false;
          return true;
        })
  )
    .slice()
    .sort(
      (a, b) =>
        distTo(a.gx, a.gy, destGx, destGy) - distTo(b.gx, b.gy, destGx, destGy),
    );
  const fielded = units
    .filter((u) => {
      if (myPlayerId == null || u.ownerId !== myPlayerId) return false;
      if (isSupply && !usesCarriedSupply(u.kind)) return false;
      if (isAssign) {
        if (!assignKind || u.kind !== assignKind) return false;
        if (u.state === "training" || u.retreating) return false;
      }
      return true;
    })
    .slice()
    .sort(
      (a, b) =>
        distTo(a.gx, a.gy, destGx, destGy) - distTo(b.gx, b.gy, destGx, destGy),
    );
  const blockadingSelected = fielded.filter(
    (u) => unitIds.includes(u.id) && u.state === "blockading",
  );
  const holdingSelected = fielded.filter(
    (u) => unitIds.includes(u.id) && u.state === "holding",
  );
  const selectedU =
    Object.entries(sources).reduce((sum, [id, u]) => {
      const b = buildings.find((x) => x.id === id);
      return sum + (b ? Math.min(u, b.u ?? 0) : 0);
    }, 0) +
    unitIds.reduce((sum, id) => {
      const u = units.find((x) => x.id === id);
      return sum + (u?.u ?? 0);
    }, 0);
  const groupCount = Object.keys(sources).length + unitIds.length;
  const selected = groupCount > 0;
  const kinds = [
    ...Object.keys(sources).map((id) => {
      const b = buildings.find((x) => x.id === id);
      return b ? unitKindFromBuilding(b.buildingId) : null;
    }),
    ...unitIds.map((id) => units.find((u) => u.id === id)?.kind ?? null),
  ].filter((k): k is NonNullable<typeof k> => k != null);
  const orgCost = isSupply
    ? UNIT_SUPPLY_O_COST
    : isHold
      ? UNIT_HOLD_O_COST
      : isAttack
        ? kinds.length > 0
          ? attackOrganizationCost(kinds)
          : UNIT_ATTACK_LAND_O_COST
        : isBlockade
          ? UNIT_BLOCKADE_O_COST
          : UNIT_MOVE_O_COST * Math.max(1, groupCount);
  const enterE = isBlockade
    ? UNIT_BLOCKADE_ENTER_E_PER_U * selectedU
    : isHold
      ? UNIT_HOLD_ENTER_E_PER_U * selectedU
      : 0;
  const canGo =
    selected &&
    !planError &&
    organization >= orgCost &&
    (isBlockade || isHold ? energy >= enterE : true);
  const canEndBlockade = isBlockade && blockadingSelected.length > 0;
  const canEndHold = isHold && holdingSelected.length > 0;

  const title = isAssign
    ? "部署归属"
    : isSupply
      ? "补给"
      : isHold
        ? "驻守"
        : isAttack
          ? "进攻"
          : isBlockade
            ? "封锁"
            : "调动";
  const goLabel = isAssign
    ? "归属"
    : isSupply
      ? "补给"
      : isHold
        ? "驻守"
        : isAttack
          ? "进攻"
          : isBlockade
            ? "封锁"
            : "出发";
  const emptyLabel = isAssign
    ? "没有外出的同类型单位"
    : isSupply
      ? "没有可补给的陆海军单位"
      : isHold
        ? "没有可驻守的单位"
        : isAttack
          ? "没有可进攻的单位"
          : isBlockade
            ? "没有可封锁的单位"
            : "没有可调动的单位";
  const costLabel = isAssign
    ? selected
      ? `归属 ${orgCost} O（${groupCount} 组，无视电台）`
      : `归属 ${UNIT_MOVE_O_COST} O/组`
    : isSupply
      ? `${orgCost} O（到达后从站内补携行）`
      : isHold
        ? `进入 ${orgCost} O + ${enterE} E`
        : isAttack
          ? `进攻 ${orgCost} O（陆/火箭 ${UNIT_ATTACK_LAND_O_COST} · 空/海 ${UNIT_ATTACK_AIR_NAVY_O_COST}）`
          : isBlockade
            ? `进入 ${orgCost} O + ${enterE} E`
            : selected
              ? `出发 ${orgCost} O（${groupCount} 组）`
              : `出发 ${UNIT_MOVE_O_COST} O/组`;

  const empty = garrison.length === 0 && fielded.length === 0;

  return (
    <div className="mobilize-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mobilize-head">
        <span>
          {title} → {destGx.toFixed(1)}, {destGy.toFixed(1)}
        </span>
        <button type="button" className="mobilize-close" onClick={onClose}>
          关闭
        </button>
      </div>
      <ul className="mobilize-list">
        {fielded.length > 0 && (
          <li className="mobilize-section" aria-hidden>
            野外单位
          </li>
        )}
        {fielded.map((u) => {
          const on = unitIds.includes(u.id);
          const stateLabel =
            u.state === "fighting"
              ? " · 交战中"
              : u.state === "blockading"
                ? " · 封锁中"
                : u.state === "holding"
                  ? " · 驻守中"
                  : isMovingState(u.state)
                    ? " · 移动中"
                    : "";
          return (
            <li key={u.id}>
              <label>
                <input type="checkbox" checked={on} onChange={() => onToggleUnit(u.id)} />
                已派出 {UNIT_BY_KIND[u.kind].name} {u.u}U
                {stateLabel}
              </label>
            </li>
          );
        })}
        {garrison.length > 0 && (
          <li className="mobilize-section" aria-hidden>
            建筑驻军
          </li>
        )}
        {garrison.map((b) => {
          const name = BUILDING_BY_ID[b.buildingId]?.name ?? b.buildingId;
          const kind = unitKindFromBuilding(b.buildingId);
          const kindName = kind ? UNIT_BY_KIND[kind].name : "";
          const on = sources[b.id] != null;
          return (
            <li key={b.id}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggleSource(b.id, b.u)}
                />
                {name} · {kindName} {b.u}U
              </label>
            </li>
          );
        })}
        {empty && <li>{emptyLabel}</li>}
      </ul>
      <div className="mobilize-foot">
        <span>{costLabel}</span>
        {planError ? <span className="mobilize-error">{planError}</span> : null}
        <button type="button" disabled={!canGo} onClick={onGo}>
          {goLabel}
        </button>
        {isBlockade ? (
          <button type="button" disabled={!canEndBlockade} onClick={onEndBlockade}>
            结束封锁
          </button>
        ) : null}
        {isHold ? (
          <button type="button" disabled={!canEndHold} onClick={onEndHold}>
            结束驻守
          </button>
        ) : null}
      </div>
    </div>
  );
}
