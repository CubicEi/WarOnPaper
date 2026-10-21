import {
  BUILDING_BY_ID,
  CARRIER_AIR_CAPACITY,
  CARRIER_DEPLOY_O_COST,
  UNIT_BY_KIND,
  UNIT_MOVE_O_COST,
  UNIT_BLOCKADE_O_COST,
  UNIT_BLOCKADE_ENTER_E_PER_U,
  UNIT_SUPPLY_O_COST,
  UNIT_HOLD_O_COST,
  UNIT_HOLD_ENTER_E_PER_U,
  UNIT_ATTACK_LAND_O_COST,
  UNIT_ATTACK_AIR_NAVY_O_COST,
  carrierAirRoom,
  isMovingState,
  unitKindFromBuilding,
  usesCarriedSupply,
  garrisonLockedInBuilding,
  attackOrganizationCost,
} from "@wop/shared";
import type { PlacedBuilding, UnitGroup } from "@wop/shared";
import {
  embarkMobilizeId,
  embarkedUForRow,
  embarkMobilizeRowKey,
  parseEmbarkMobilizeId,
} from "./mobilizeEmbark.js";

export type MobilizeMode =
  | "move"
  | "blockade"
  | "supply"
  | "attack"
  | "hold"
  | "assign"
  | "carrier_deploy";

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
  /** Carrier receiving airport air (mode === "carrier_deploy"). */
  carrierId?: string;
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

type EmbarkedAirRow = {
  key: string;
  carrierId: string;
  gx: number;
  gy: number;
  homeBuildingId: string;
  u: number;
};

function embarkedAirRows(
  units: readonly UnitGroup[],
  myPlayerId: string | null,
): EmbarkedAirRow[] {
  if (myPlayerId == null) return [];
  const rows: EmbarkedAirRow[] = [];
  for (const carrier of units) {
    if (carrier.ownerId !== myPlayerId) continue;
    if (carrier.kind !== "navy_carrier" || carrier.u <= 0) continue;
    const manifest = carrier.embarkedAirByHome?.filter(
      (entry) => entry.homeBuildingId && Number.isFinite(entry.u) && entry.u > 0,
    );
    if (manifest?.length) {
      for (const entry of manifest) {
        rows.push({
          key: embarkMobilizeRowKey(carrier.id, entry.homeBuildingId),
          carrierId: carrier.id,
          gx: carrier.gx,
          gy: carrier.gy,
          homeBuildingId: entry.homeBuildingId,
          u: entry.u,
        });
      }
      continue;
    }
    const u = carrier.embarkedAirU ?? 0;
    const homeBuildingId = carrier.embarkedAirHomeBuildingId;
    if (u > 0 && homeBuildingId) {
      rows.push({
        key: embarkMobilizeRowKey(carrier.id, homeBuildingId),
        carrierId: carrier.id,
        gx: carrier.gx,
        gy: carrier.gy,
        homeBuildingId,
        u,
      });
    }
  }
  return rows;
}

function carrierAirSortieStateLabel(unit: UnitGroup): string {
  if (unit.carrierSortieState === "boarding") return " · 上舰中";
  if (unit.carrierSortieState === "outbound") return " · 出击中";
  if (unit.carrierSortieState === "returning_carrier") return " · 返航中";
  if (unit.state === "fighting") return " · 交战中";
  if (isMovingState(unit.state)) return " · 移动中";
  return "";
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
  carrierId,
  planError,
}: Props) {
  const isBlockade = mode === "blockade";
  const isSupply = mode === "supply";
  const isAttack = mode === "attack";
  const isHold = mode === "hold";
  const isAssign = mode === "assign";
  const isCarrierDeploy = mode === "carrier_deploy";
  const assignBuilding = isAssign
    ? buildings.find((b) => b.id === assignBuildingId)
    : undefined;
  const assignKind = assignBuilding
    ? unitKindFromBuilding(assignBuilding.buildingId)
    : null;
  const carrier = isCarrierDeploy
    ? units.find((u) => u.id === carrierId)
    : undefined;
  const hangarRoom = carrier ? carrierAirRoom(carrier, units) : 0;
  const deployCap = Math.min(CARRIER_AIR_CAPACITY, hangarRoom);
  const garrison = (
    isAssign
      ? []
      : buildings.filter((b) => {
          if (myPlayerId == null || b.ownerId !== myPlayerId) return false;
          if ((b.u ?? 0) < 1) return false;
          if (isCarrierDeploy) {
            return b.buildingId === "airport" && b.buildTicksRemaining <= 0;
          }
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
  const fieldedAll = (
    isCarrierDeploy
      ? []
      : units.filter((u) => {
          if (myPlayerId == null || u.ownerId !== myPlayerId) return false;
          if (isSupply && !usesCarriedSupply(u.kind)) return false;
          if (isAssign) {
            if (!assignKind || u.kind !== assignKind) return false;
            if (u.state === "training" || u.retreating) return false;
          }
          return true;
        })
  )
    .slice()
    .sort(
      (a, b) =>
        distTo(a.gx, a.gy, destGx, destGy) - distTo(b.gx, b.gy, destGx, destGy),
    );
  const carrierAirFielded = isCarrierDeploy || isAssign
    ? []
    : fieldedAll.filter((u) => u.kind === "air" && u.carrierId);
  const embarked =
    isCarrierDeploy || isAssign
      ? []
      : embarkedAirRows(units, myPlayerId)
          .slice()
          .sort(
            (a, b) =>
              distTo(a.gx, a.gy, destGx, destGy) -
              distTo(b.gx, b.gy, destGx, destGy),
          );
  const fielded = fieldedAll.filter((u) => !(u.kind === "air" && u.carrierId));
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
      const embark = parseEmbarkMobilizeId(id);
      if (embark) {
        return (
          sum + embarkedUForRow(units, embark.carrierId, embark.homeBuildingId)
        );
      }
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
  const orgCost = isCarrierDeploy
    ? CARRIER_DEPLOY_O_COST
    : isSupply
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
  const overDeployCap = isCarrierDeploy && selectedU > deployCap;
  const canGo =
    selected &&
    !planError &&
    !overDeployCap &&
    organization >= orgCost &&
    (isBlockade || isHold ? energy >= enterE : true) &&
    (!isCarrierDeploy || deployCap > 0);
  const canEndBlockade = isBlockade && blockadingSelected.length > 0;
  const canEndHold = isHold && holdingSelected.length > 0;

  const title = isCarrierDeploy
    ? "母舰部署"
    : isAssign
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
  const goLabel = isCarrierDeploy
    ? "上舰"
    : isAssign
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
  const emptyLabel = isCarrierDeploy
    ? "没有机场驻军空军（不含已派出）"
    : isAssign
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
  const costLabel = isCarrierDeploy
    ? selected
      ? overDeployCap
        ? `超出机库空位（最多 ${deployCap}U）`
        : `部署 ${orgCost} O · 已选 ${selectedU}U / ${deployCap}U`
      : `部署 ${CARRIER_DEPLOY_O_COST} O · 最多 ${deployCap}U`
    : isAssign
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

  const showCarrierAir =
    embarked.length > 0 || carrierAirFielded.length > 0;
  const empty =
    garrison.length === 0 &&
    fielded.length === 0 &&
    !showCarrierAir;

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
        {showCarrierAir && (
          <li className="mobilize-section" aria-hidden>
            舰载机
          </li>
        )}
        {embarked.map((row) => {
          const home = buildings.find((b) => b.id === row.homeBuildingId);
          const homeName =
            home != null
              ? (BUILDING_BY_ID[home.buildingId]?.name ?? home.buildingId)
              : row.homeBuildingId;
          const selId = embarkMobilizeId(row.key);
          const on = unitIds.includes(selId);
          const disabled =
            isCarrierDeploy ||
            isAssign ||
            row.u < 1 ||
            (isSupply && !usesCarriedSupply("air"));
          return (
            <li key={row.key}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() => onToggleUnit(selId)}
                />
                母舰 · {UNIT_BY_KIND.air.name} {row.u}U · 机库（{homeName}）
              </label>
            </li>
          );
        })}
        {carrierAirFielded.map((u) => {
          const on = unitIds.includes(u.id);
          const carrier = units.find((c) => c.id === u.carrierId);
          const carrierLabel =
            carrier?.kind === "navy_carrier" ? "母舰" : "航母";
          return (
            <li key={u.id}>
              <label>
                <input type="checkbox" checked={on} onChange={() => onToggleUnit(u.id)} />
                {carrierLabel} · 已派出 {UNIT_BY_KIND[u.kind].name} {u.u}U
                {carrierAirSortieStateLabel(u)}
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
          const selectedElsewhere = Object.entries(sources).reduce(
            (sum, [id, u]) => (id === b.id ? sum : sum + u),
            0,
          );
          const take = isCarrierDeploy
            ? Math.min(b.u, Math.max(0, deployCap - selectedElsewhere))
            : b.u;
          return (
            <li key={b.id}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={isCarrierDeploy && !on && take < 1}
                  onChange={() => onToggleSource(b.id, take > 0 ? take : b.u)}
                />
                {name} · {kindName} {b.u}U
                {isCarrierDeploy && on ? ` → 上舰 ${sources[b.id]}U` : ""}
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
