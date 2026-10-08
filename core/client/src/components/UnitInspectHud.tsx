import {
  CARRIER_AIR_CAPACITY,
  UNIT_BY_KIND,
  UNIT_STOP_E_COST,
  UNIT_STOP_O_COST,
  canUnitRetreat,
  canUnitStop,
  carrierAirRoom,
  carrierCapacityLabel,
  estimatePathTimeSec,
  isCarrierKind,
  isMovingState,
  unitCoordKey,
  unitHp,
  type PlacedBuilding,
  type PlacedLiaison,
  type TerrainMap,
  type UnitGroup,
  type UnitState,
} from "@wop/shared";

export type UnitInspectAction =
  | "retreat"
  | "stop"
  | "embark_air"
  | "disembark_air"
  | "attack";

interface Props {
  unit: UnitGroup;
  screenX: number;
  screenY: number;
  /** Distance from unit center to the right panel. */
  offset?: number;
  myPlayerId?: string | null;
  energy?: number;
  organization?: number;
  terrain?: TerrainMap | null;
  liaisons?: readonly PlacedLiaison[];
  /** All visible units (for finding colocated air / carrier / dock). */
  units?: readonly UnitGroup[];
  /** Friendly ports used to detect berthed units. */
  buildings?: readonly PlacedBuilding[];
  onAction?: (action: UnitInspectAction, unit: UnitGroup, detail?: { airUnitId?: string }) => void;
  /** Teammate unit: full info, no ops. */
  isAlly?: boolean;
  readOnly?: boolean;
}

const STATE_LABEL: Record<UnitState, string> = {
  idle: "停留",
  moving: "移动中",
  holding: "驻守",
  blockading: "封锁",
  fighting: "交战",
  training: "训练途中",
};

function remainingPath(unit: UnitGroup): Array<{ gx: number; gy: number }> {
  const path = unit.path;
  if (!path || path.length < 2 || !isMovingState(unit.state)) return [];
  const idx = Math.max(1, unit.pathIndex ?? 1);
  const rest = path.slice(idx);
  if (rest.length === 0) return [];
  return [{ gx: unit.gx, gy: unit.gy }, ...rest];
}

function formatSec(sec: number): string {
  if (sec < 0.05) return "0 秒";
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m} 分 ${s} 秒`;
}

/**
 * Inspect HUD to the right of a selected unit:
 * info + move ETA + retreat / stop (+ carrier embark/disembark).
 * Enemy direct vision: kind + state only (no u / HP).
 */
export function UnitInspectHud({
  unit,
  screenX,
  screenY,
  offset = 44,
  myPlayerId = null,
  energy = 0,
  organization = 0,
  terrain = null,
  liaisons = [],
  units = [],
  buildings = [],
  onAction,
  isAlly = false,
  readOnly = false,
}: Props) {
  const owned = myPlayerId != null && unit.ownerId === myPlayerId;
  const mine = !readOnly && !isAlly && owned;
  const def = UNIT_BY_KIND[unit.kind];
  const name = def.name;
  const showStrength = (owned || isAlly) && !unit.strengthHidden;
  const hpPerU = unitHp(unit.kind);
  const moving = isMovingState(unit.state);
  const blockading = unit.state === "blockading";
  const rem = remainingPath(unit);
  const dest = rem.length >= 2 ? rem[rem.length - 1]! : null;
  const remDu =
    rem.length < 2
      ? 0
      : rem.slice(1).reduce((acc, p, i) => {
          const a = rem[i]!;
          return acc + Math.hypot(p.gx - a.gx, p.gy - a.gy);
        }, 0);
  const etaSec =
    rem.length >= 2
      ? estimatePathTimeSec(unit.kind, rem, terrain, liaisons, unit.ownerId)
      : 0;

  const canAffordStop =
    organization >= UNIT_STOP_O_COST && energy >= UNIT_STOP_E_COST;
  const fighting = unit.state === "fighting";
  const dock = { buildings, units };
  const stopOk = canUnitStop(unit, dock);
  const retreatOk = canUnitRetreat(unit, dock);
  const docked = !fighting && !stopOk;

  const stopTitle = fighting
    ? "交战中无法停止"
    : !stopOk
      ? "停泊中无法停止"
      : !canAffordStop
        ? `需要 ${UNIT_STOP_E_COST} E · ${UNIT_STOP_O_COST} O`
        : blockading
          ? `结束封锁并停在原地 · ${UNIT_STOP_E_COST} E · ${UNIT_STOP_O_COST} O`
          : unit.state === "holding"
            ? `结束驻守 · ${UNIT_STOP_E_COST} E · ${UNIT_STOP_O_COST} O`
            : moving
              ? `停止行军 · ${UNIT_STOP_E_COST} E · ${UNIT_STOP_O_COST} O`
              : `停止并结束当前行为 · ${UNIT_STOP_E_COST} E · ${UNIT_STOP_O_COST} O`;
  const retreatTitle = unit.retreating
    ? "正在撤回所属建筑"
    : "撤回所属建筑并入库（不耗 O/E，不检电台、地形与携行）";

  const stopDisabled = !mine || !stopOk || !canAffordStop;
  const retreatDisabled = !mine || !retreatOk;

  const colocatedAir =
    mine && isCarrierKind(unit.kind)
      ? units.find(
          (u) =>
            u.id !== unit.id &&
            u.ownerId === unit.ownerId &&
            u.kind === "air" &&
            u.u > 0 &&
            !isMovingState(u.state) &&
            u.state !== "fighting" &&
            unitCoordKey(u.gx, u.gy) === unitCoordKey(unit.gx, unit.gy),
        )
      : undefined;
  const canEmbark =
    !!colocatedAir && isCarrierKind(unit.kind) && carrierAirRoom(unit) > 0;
  const canDisembark =
    mine && isCarrierKind(unit.kind) && (unit.embarkedAirU ?? 0) > 0;

  const extras: string[] = [name, STATE_LABEL[unit.state]];
  if (!mine) {
    extras.push(unit.visionLevel === "satellite" ? "卫星视野" : "直接视野");
  } else if (def.carryEMax != null) {
    extras.push(`携行 ${unit.carriedE}/${def.carryEMax} E`);
  }
  if (mine && isCarrierKind(unit.kind)) {
    extras.push(carrierCapacityLabel(unit));
  }

  const fire = (action: UnitInspectAction, detail?: { airUnitId?: string }) => {
    onAction?.(action, unit, detail);
  };

  return (
    <div className="unit-inspect" aria-label={`${name} 信息`}>
      <div
        className="unit-inspect-row"
        style={{ left: screenX + offset, top: screenY }}
      >
        <div className="unit-inspect-panel">
          {showStrength && (
            <div className="building-inspect-box is-u">
              <div className="building-inspect-box-label">
                编制 {unit.u} U · HP {hpPerU}/U
              </div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-u"
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          )}

          <div className="building-inspect-box is-meta">
            {extras.map((line) => (
              <div key={line} className="building-inspect-note-line">
                {line}
              </div>
            ))}
          </div>

          <div className="building-inspect-box is-meta">
            <div className="building-inspect-box-label">移动</div>
            {moving && dest ? (
              <>
                <div className="building-inspect-note-line">
                  → {dest.gx.toFixed(1)}, {dest.gy.toFixed(1)}
                </div>
                <div className="building-inspect-note-line">
                  剩余 {remDu.toFixed(1)} Du
                </div>
                <div className="building-inspect-note-line">
                  预计 {formatSec(etaSec)}
                </div>
              </>
            ) : blockading ? (
              <div className="building-inspect-note-line">封锁中 · 可停止/撤退</div>
            ) : unit.state === "holding" ? (
              <div className="building-inspect-note-line">驻守中 · 可停止/撤退</div>
            ) : fighting ? (
              <div className="building-inspect-note-line">交战中 · 可撤退，不可停止</div>
            ) : docked ? (
              <div className="building-inspect-note-line">停泊中 · 可撤退，不可停止</div>
            ) : unit.retreating ? (
              <div className="building-inspect-note-line">正在撤回所属建筑</div>
            ) : (
              <div className="building-inspect-note-line">可停止/撤退</div>
            )}
          </div>
        </div>

        {mine && (
          <div className="unit-inspect-ops">
            <UnitOpButton
              label="撤退"
              icon="/icons/symbol/operation/back.png"
              disabled={retreatDisabled}
              title={retreatTitle}
              onFire={() => fire("retreat")}
            />
            <UnitOpButton
              label="停止"
              icon="/icons/symbol/operation/stop.png"
              disabled={stopDisabled}
              title={stopTitle}
              onFire={() => fire("stop")}
            />
            {isCarrierKind(unit.kind) && (
              <>
                <UnitOpButton
                  label="上舰"
                  disabled={!canEmbark}
                  title={
                    canEmbark
                      ? `搭载同格空军（机库 ${unit.embarkedAirU ?? 0}/${CARRIER_AIR_CAPACITY}）`
                      : carrierAirRoom(unit) <= 0
                        ? "机库已满"
                        : "同格无可搭载空军"
                  }
                  onFire={() =>
                    fire("embark_air", { airUnitId: colocatedAir?.id })
                  }
                />
                <UnitOpButton
                  label="放飞"
                  disabled={!canDisembark}
                  title={
                    canDisembark
                      ? `放出机库空军 ${unit.embarkedAirU}U`
                      : "机库无空军"
                  }
                  onFire={() => fire("disembark_air")}
                />
              </>
            )}
          </div>
        )}
        {!mine && myPlayerId != null && (
          <div className="unit-inspect-ops">
            <UnitOpButton
              label="进攻"
              title="选择己方单位进攻此敌军"
              onFire={() => fire("attack")}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function UnitOpButton({
  label,
  icon,
  disabled,
  title,
  onFire,
}: {
  label: string;
  icon?: string;
  disabled?: boolean;
  title?: string;
  onFire: () => void;
}) {
  return (
    <button
      type="button"
      className="building-inspect-op"
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onFire();
      }}
    >
      <span
        className={`point-action-icon${icon ? "" : " unit-inspect-icon-placeholder"}`}
        aria-hidden
      >
        {icon ? <img src={icon} alt="" draggable={false} /> : null}
      </span>
      <span className="point-action-label">{label}</span>
    </button>
  );
}
