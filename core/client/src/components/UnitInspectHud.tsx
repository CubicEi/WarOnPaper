import {
  CARRIER_AIR_CAPACITY,
  CARRIER_DEPLOY_O_COST,
  UNIT_BY_KIND,
  UNIT_SIEGE_STOP_E_COST,
  UNIT_SIEGE_STOP_O_COST,
  UNIT_STOP_E_COST,
  UNIT_STOP_O_COST,
  canUnitRetreat,
  canUnitStop,
  isSiegeBuildingHpPhase,
  carrierAirRoom,
  estimatePathTimeSec,
  isCarrierKind,
  isMovingState,
  departureMaxHp,
  totalUnitHp,
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
  | "deploy_air"
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
  onAction?: (action: UnitInspectAction, unit: UnitGroup) => void;
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
  docked: "停港",
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
 * info + move ETA + retreat / stop (+ carrier deploy).
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
  const fieldHpTotal = totalUnitHp(unit);
  const fieldHpMax = departureMaxHp(unit);
  const carrierHullMax = UNIT_BY_KIND.navy_carrier.hp;
  const carrierHullHp = unit.hullHp ?? carrierHullMax;
  const embarkedU = unit.embarkedAirU ?? 0;
  const moving = isMovingState(unit.state);
  const blockading = unit.state === "blockading";
  const holding = unit.state === "holding";
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

  const siegeHpStop = isSiegeBuildingHpPhase(unit, buildings, units);
  const stopCostsResources = moving || siegeHpStop;
  const stopOCost = siegeHpStop ? UNIT_SIEGE_STOP_O_COST : UNIT_STOP_O_COST;
  const stopECost = siegeHpStop ? UNIT_SIEGE_STOP_E_COST : UNIT_STOP_E_COST;
  const canAffordStop =
    !stopCostsResources ||
    (organization >= stopOCost && energy >= stopECost);
  const fighting = unit.state === "fighting";
  const dock = { buildings, units };
  const stopOk = canUnitStop(unit, dock);
  const retreatOk = canUnitRetreat(unit, dock);
  const docked = unit.state === "docked";

  const stopTitle =
    fighting && !siegeHpStop
      ? "交战中无法停止"
      : unit.retreating
        ? "撤退途中无法停止"
        : !stopOk
          ? docked
            ? "停港中无法停止"
            : "仅驻守、封锁或移动中可停止"
          : stopCostsResources && !canAffordStop
            ? stopECost > 0
              ? `需要 ${stopECost} E · ${stopOCost} O`
              : `需要 ${stopOCost} O`
            : siegeHpStop
              ? unit.pendingSiegeStop
                ? "已下令停止 · 再打一节拍后停留"
                : stopECost > 0
                  ? `停止攻城 · ${stopECost} E · ${stopOCost} O（再打一节拍）`
                  : `停止攻城 · ${stopOCost} O（再打一节拍）`
              : blockading
                ? "结束封锁并停在原地（不耗 O/E）"
                : holding
                  ? "结束驻守（不耗 O/E）"
                  : moving
                    ? `停止行军 · ${UNIT_STOP_E_COST} E · ${UNIT_STOP_O_COST} O`
                    : "无法停止";
  const retreatTitle = unit.retreating
    ? "正在撤回所属建筑"
    : isCarrierKind(unit.kind)
      ? "撤回所属港口旁并停港（不耗 O/E）"
      : "撤回所属建筑并入库（不耗 O/E，不检电台、地形与携行）";

  const stopDisabled = !mine || !stopOk || !canAffordStop;
  const retreatDisabled = !mine || !retreatOk;

  const hangarRoom = isCarrierKind(unit.kind) ? carrierAirRoom(unit, units) : 0;
  const canDeploy =
    mine &&
    isCarrierKind(unit.kind) &&
    hangarRoom > 0 &&
    !unit.retreating &&
    organization >= CARRIER_DEPLOY_O_COST;
  const deployTitle = !isCarrierKind(unit.kind)
    ? "部署"
    : hangarRoom <= 0
      ? "机库已满"
      : organization < CARRIER_DEPLOY_O_COST
        ? `需要 ${CARRIER_DEPLOY_O_COST} O`
        : unit.retreating
          ? "撤退中不能部署"
          : `从机场选择空军上舰 · ${CARRIER_DEPLOY_O_COST} O · 最多 ${Math.min(5, hangarRoom)}U`;

  const extras: string[] = [name, STATE_LABEL[unit.state]];
  if (isAlly) extras.push("友军");
  if (owned || isAlly) {
    if (def.carryEMax != null) {
      extras.push(`携行 ${unit.carriedE}/${def.carryEMax} E`);
    }
  } else {
    extras.push(unit.visionLevel === "satellite" ? "卫星视野" : "直接视野");
  }

  const fire = (action: UnitInspectAction) => {
    onAction?.(action, unit);
  };

  return (
    <div className="unit-inspect" aria-label={`${name} 信息`}>
      <div
        className="unit-inspect-row"
        style={{ left: screenX + offset, top: screenY }}
      >
        <div className="unit-inspect-panel">
          {owned && isCarrierKind(unit.kind) && (
            <div className="building-inspect-box is-hp">
              <div className="building-inspect-box-label">
                舰体 HP {carrierHullHp}/{carrierHullMax}
              </div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-hp"
                  style={{
                    width: `${Math.max(0, Math.min(100, (carrierHullHp / carrierHullMax) * 100))}%`,
                  }}
                />
              </div>
            </div>
          )}

          {showStrength && !isCarrierKind(unit.kind) && (
            <div className="building-inspect-box is-hp">
              <div className="building-inspect-box-label">
                编制 HP {fieldHpTotal}/{fieldHpMax}
              </div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-hp"
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(
                        100,
                        fieldHpMax > 0 ? (fieldHpTotal / fieldHpMax) * 100 : 0,
                      ),
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          {showStrength && (
            <div className="building-inspect-box is-u">
              <div className="building-inspect-box-label">
                {isCarrierKind(unit.kind)
                  ? `舰载机编制 ${embarkedU}/${CARRIER_AIR_CAPACITY} U`
                  : `编制 ${unit.u} U · ${hpPerU} HP/U`}
              </div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-u"
                  style={{
                    width: isCarrierKind(unit.kind)
                      ? `${Math.max(0, Math.min(100, (embarkedU / CARRIER_AIR_CAPACITY) * 100))}%`
                      : `${Math.max(
                          0,
                          Math.min(
                            100,
                            fieldHpMax > 0 ? (fieldHpTotal / fieldHpMax) * 100 : 100,
                          ),
                        )}%`,
                  }}
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
            ) : holding ? (
              <div className="building-inspect-note-line">驻守中 · 可停止/撤退</div>
            ) : fighting && siegeHpStop ? (
              <div className="building-inspect-note-line">
                {unit.pendingSiegeStop
                  ? "拆城防中 · 下一节拍后停留"
                  : "拆城防中 · 可停止（再打一节拍）"}
              </div>
            ) : fighting ? (
              <div className="building-inspect-note-line">交战中 · 可撤退，不可停止</div>
            ) : docked ? (
              <div className="building-inspect-note-line">停港中 · 每 2 秒修 1 舰体 HP</div>
            ) : unit.retreating ? (
              <div className="building-inspect-note-line">正在撤回所属建筑</div>
            ) : stopOk ? (
              <div className="building-inspect-note-line">可停止/撤退</div>
            ) : (
              <div className="building-inspect-note-line">可撤退</div>
            )}
          </div>
        </div>

        {mine && (
          <div className="unit-inspect-controls">
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
                <UnitOpButton
                  label="部署"
                  icon="/icons/symbol/operation/mobilize.png"
                  disabled={!canDeploy}
                  title={deployTitle}
                  onFire={() => fire("deploy_air")}
                />
              )}
            </div>
          </div>
        )}
        {!mine && !isAlly && myPlayerId != null && (
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
