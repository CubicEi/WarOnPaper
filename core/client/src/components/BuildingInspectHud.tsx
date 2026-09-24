import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUILDING_BY_ID,
  CARRIER_BUILD_E,
  HOLD_ACTION_O_COST,
  SIZE_NAME,
  TICK_HZ,
  UNIT_BY_KIND,
  awayOccupiedU,
  buildingLevel,
  effectiveUmax,
  effectiveWorkR,
  isLaunchCoolingDown,
  isRepairing,
  needsContinueBuild,
  previewLinearUpgrade,
  romanLevelLabel,
  supportsLinearUpgrade,
  trainingHeadProgress,
  trainingQueueKind,
  type PlacedBuilding,
} from "@wop/shared";

export type BuildingInspectAction =
  | "demolish"
  | "upgrade"
  | "level_upgrade"
  | "repair"
  | "deploy"
  | "reload"
  | "train"
  | "build_carrier"
  | "garrison"
  | "mutual_defense"
  | "supply"
  | "fire"
  | "attack";

export type BuildingInspectActionDetail = {
  /** Rounds to load when action === "reload". */
  count?: number;
};

const OP_DEFENSE = "/icons/symbol/operation/defense.png";
const OP_MUTUAL = "/icons/symbol/operation/mutual_defense.png";
const OP_ATTACK = "/icons/symbol/operation/attack.png";
const SUPPLY_ICON = "/icons/buildings%20-%20black/energy/supply_station.png";

/** Fixed slider length (px). Increase zone above origin, cancel below. */
const RELOAD_SLIDER_H = 148;
const RELOAD_CANCEL_H = 40;
const RELOAD_INCREASE_H = RELOAD_SLIDER_H - RELOAD_CANCEL_H;

interface Props {
  building: PlacedBuilding;
  screenX: number;
  screenY: number;
  /** Distance from building center to the right panel. */
  offset?: number;
  myPlayerId?: string | null;
  /** Roster for owner name above HP. */
  playerNames?: readonly { id: string; name: string }[];
  /** Server tick for launch cooldown. */
  tick?: number;
  /** False when this building is not in the published comms set. */
  commsLinked?: boolean;
  /** Current player energy, used to cap reload and deploy amount. */
  energy?: number;
  /** Current organization. Each reload or deploy spends 1 O. */
  organization?: number;
  /**
   * When set, nuclear reload is refused (uranium miner / factory prereq).
   * Other launchers ignore this.
   */
  nukeReloadBlockReason?: string | null;
  onAction?: (
    action: BuildingInspectAction,
    building: PlacedBuilding,
    detail?: BuildingInspectActionDetail,
  ) => void;
  /** Spectator / ended: show info, hide action buttons. */
  readOnly?: boolean;
}

/**
 * Inspect HUD to the right of a selected building:
 * info column (HP / U / meta) + white action buttons (拆除 / 升级|修复 / 部署|装填).
 * Enemy: satellite = type only; direct = type + HP (§4.5).
 */
export function BuildingInspectHud({
  building,
  screenX,
  screenY,
  offset = 44,
  myPlayerId = null,
  playerNames = [],
  tick = 0,
  commsLinked = false,
  energy = 0,
  organization = 0,
  nukeReloadBlockReason = null,
  onAction,
  readOnly = false,
}: Props) {
  const mine = !readOnly && myPlayerId != null && building.ownerId === myPlayerId;
  const polluted = !!building.polluted;
  const vision = building.visionLevel ?? (mine ? "direct" : "satellite");
  const enemySatellite = !mine && vision === "satellite";
  const enemyDirect = !mine && vision === "direct";
  const ownerNick = playerNames.find((p) => p.id === building.ownerId)?.name;
  const ownerName =
    ownerNick && ownerNick.trim()
      ? ownerNick
      : building.ownerId.slice(0, 8);

  const def = BUILDING_BY_ID[building.buildingId];
  const name = def?.name ?? building.buildingId;
  const storeEMax = mine ? (def?.storeEMax ?? 0) : 0;
  const ammoMax = mine ? (def?.ammoMax ?? 0) : 0;
  const uMax =
    mine && storeEMax <= 0 && ammoMax <= 0 ? effectiveUmax(building) : 0;
  const isTrainingGround = building.buildingId === "training_ground";
  const showUBar =
    mine && storeEMax <= 0 && ammoMax <= 0 && (uMax > 0 || isTrainingGround);
  const inProgress = building.buildTicksRemaining > 0;
  const repairing = isRepairing(building);
  const continueBuild = needsContinueBuild(building);
  const hpFull = building.hp >= building.hpMax && building.hpMax > 0;
  const linearPreview = mine ? previewLinearUpgrade(building) : null;
  const useLinearUpgrade = linearPreview != null;
  const midAction: BuildingInspectAction = !hpFull
    ? "repair"
    : useLinearUpgrade
      ? "level_upgrade"
      : "upgrade";
  const levelUpCost = linearPreview?.energy ?? 0;
  const levelUpDisabled =
    useLinearUpgrade &&
    (!linearPreview.canUpgrade || energy < levelUpCost || inProgress);
  const midLabel = !hpFull
    ? repairing
      ? continueBuild
        ? "继续建造中"
        : "修复中"
      : continueBuild
        ? "继续建造"
        : inProgress
          ? "建造中"
          : "修复"
    : useLinearUpgrade
      ? linearPreview.canUpgrade
        ? `升级 ${levelUpCost}E`
        : "已满级"
      : "升级";
  const midTitle = polluted
    ? "污染区内建筑已失效，只能拆除"
    : !commsLinked
    ? "未接入通信"
    : repairing && midAction === "repair"
      ? continueBuild
        ? "继续建造中"
        : "修复中"
      : midAction === "repair" && inProgress && !continueBuild
        ? "建造进行中"
        : midAction === "level_upgrade"
        ? !linearPreview?.canUpgrade
          ? "已满级"
          : inProgress
            ? "建造中"
            : energy < levelUpCost
              ? `能源不足（需要 ${levelUpCost} E）`
              : `升至 ${romanLevelLabel(linearPreview.toLevel)} · ${levelUpCost} E`
        : continueBuild
          ? "按修复费用继续建造，用时为修复公式 ×2"
          : undefined;

  const showHp = mine || (enemyDirect && building.hpMax > 0);
  const hpRatio =
    building.hpMax > 0
      ? Math.max(0, Math.min(1, building.hp / building.hpMax))
      : 0;
  const storeECur =
    storeEMax <= 0 ? 0 : Math.max(0, Math.min(storeEMax, building.storeE ?? 0));
  const storeERatio =
    storeEMax > 0 ? Math.max(0, Math.min(1, storeECur / storeEMax)) : 0;
  const ammoCur =
    ammoMax <= 0 ? 0 : Math.max(0, Math.min(ammoMax, building.ammo ?? 0));
  const ammoRatio = ammoMax > 0 ? Math.max(0, Math.min(1, ammoCur / ammoMax)) : 0;
  const uCur =
    uMax <= 0 ? 0 : Math.max(0, Math.min(uMax, building.u ?? 0));
  const uAway =
    uMax <= 0 ? 0 : Math.max(0, Math.min(uMax - uCur, awayOccupiedU(building)));
  const uPresentRatio = uMax > 0 ? Math.max(0, Math.min(1, uCur / uMax)) : 0;
  const uAwayRatio = uMax > 0 ? Math.max(0, Math.min(1, uAway / uMax)) : 0;
  const trainKind = isTrainingGround ? trainingQueueKind(building) : null;
  const trainProgress =
    isTrainingGround && trainKind ? trainingHeadProgress(building) : 0;
  const trainActive =
    isTrainingGround && (building.trainingQueue?.length ?? 0) > 0;
  const reloadE = def?.reloadE ?? 0;
  const deployStepE = def?.deployStepE ?? 0;
  const canReload = reloadE > 0 && ammoMax > 0;
  const canDeploy = !canReload && deployStepE > 0 && storeEMax > 0;
  const noOrg = organization < HOLD_ACTION_O_COST;
  const ammoRoom = Math.max(0, ammoMax - ammoCur);
  const afford = reloadE > 0 ? Math.floor(energy / reloadE) : 0;
  const maxReload = Math.min(ammoRoom, afford);
  const ammoFull = canReload && ammoRoom <= 0;
  const noEnergy = canReload && !ammoFull && afford < 1;
  const storeRoom = Math.max(0, storeEMax - storeECur);
  const deployRoomSteps =
    deployStepE > 0 ? Math.floor(storeRoom / deployStepE) : 0;
  const deployAfford =
    deployStepE > 0 ? Math.floor(energy / deployStepE) : 0;
  const maxDeploy = Math.min(deployRoomSteps, deployAfford);
  const storeFull = canDeploy && storeECur >= storeEMax;
  const storeShort = canDeploy && !storeFull && deployRoomSteps < 1;
  const deployNoEnergy = canDeploy && !storeFull && !storeShort && deployAfford < 1;
  const isSupply = building.buildingId === "supply_station";
  const isPort = building.buildingId === "port";
  const isAntiAir = building.buildingId === "anti-air_gun";
  const isLauncher = !isAntiAir && reloadE > 0 && ammoMax > 0;
  const nukeBlock =
    building.buildingId === "nuke_missile" ? nukeReloadBlockReason : null;
  const canBuildCarrier = isPort && !inProgress;
  const carrierAfford = energy >= CARRIER_BUILD_E;
  const launchDamage = def?.h;
  const canDamageBuildings = launchDamage != null && launchDamage > 0;
  const onCooldown = isLaunchCoolingDown(building, tick);
  const cooldownRemSec = onCooldown
    ? Math.max(
        1,
        Math.ceil(
          ((building.fireCooldownUntilTick ?? 0) - tick) / TICK_HZ,
        ),
      )
    : 0;
  const cooldownLabel = onCooldown
    ? `发射冷却中 ${cooldownRemSec}s`
    : null;
  const launchDisabled =
    polluted ||
    !commsLinked ||
    inProgress ||
    ammoCur < 1 ||
    !canDamageBuildings ||
    onCooldown;
  const launchTitle = polluted
    ? "污染区内建筑已失效"
    : !commsLinked
    ? "未接入通信"
    : inProgress
      ? "建造中"
      : !canDamageBuildings
        ? "无法攻击建筑"
        : ammoCur < 1
          ? "弹药不足"
          : onCooldown
            ? cooldownLabel ?? "发射冷却中"
            : "选择工作范围内的敌方建筑";
  const thirdAction: BuildingInspectAction = canReload
    ? "reload"
    : canDeploy
      ? "deploy"
      : isTrainingGround
        ? "train"
        : canBuildCarrier
          ? "build_carrier"
          : "deploy";
  const thirdLabel = canReload
    ? "装填"
    : canDeploy
      ? "部署"
      : isTrainingGround
        ? "训练"
        : canBuildCarrier
          ? "造航母"
          : "部署";
  const holdDisabled = polluted
    ? true
    : canReload
    ? !commsLinked || inProgress || !!nukeBlock || noOrg || maxReload <= 0
    : canDeploy
      ? !commsLinked || noOrg || inProgress || maxDeploy <= 0
      : isTrainingGround
        ? !commsLinked || inProgress
        : canBuildCarrier
          ? !commsLinked || inProgress || !carrierAfford
          : !commsLinked;
  const holdTitle = polluted
    ? "污染区内建筑已失效，只能拆除"
    : !commsLinked
    ? "未接入通信"
    : (canReload || canDeploy || isTrainingGround || canBuildCarrier) && inProgress
      ? "建造中"
      : nukeBlock
        ? nukeBlock
        : (canReload || canDeploy) && noOrg
        ? `组织度不足（需要 ${HOLD_ACTION_O_COST} O）`
        : ammoFull || storeFull
          ? canReload
            ? "弹药已满"
            : "储能已满"
          : storeShort
            ? `剩余不足 ${deployStepE} E`
            : noEnergy
              ? `能源不足（需要 ${reloadE} E）`
              : deployNoEnergy
                ? `能源不足（需要 ${deployStepE} E）`
                : canBuildCarrier && !carrierAfford
                  ? `能源不足（需要 ${CARRIER_BUILD_E} E）`
                  : canReload
                    ? `按住装填 · 上滑加发 · ${reloadE} E/发 · ${HOLD_ACTION_O_COST} O`
                    : canDeploy
                      ? `按住部署 · 上滑增加 · ${deployStepE} E/步 · ${HOLD_ACTION_O_COST} O`
                      : isTrainingGround
                        ? "选择兵种、数量与目标建筑"
                        : canBuildCarrier
                          ? `建造航母 · ${CARRIER_BUILD_E} E · 容纳 3U 空军 · 移速 0.4`
                          : undefined;

  const hpLabel = !showHp
    ? "HP —"
    : polluted
      ? `HP ${Math.floor(building.hp)}/${building.hpMax}（污染失效）`
    : inProgress && (building.buildPaused || continueBuild)
      ? `HP ${Math.floor(building.hp)}/${building.hpMax}（施工暂停）`
      : inProgress
      ? `HP ${Math.floor(building.hp)}/${building.hpMax}（建造中）`
      : repairing
        ? `HP ${Math.floor(building.hp)}/${building.hpMax}（修复中）`
        : `HP ${Math.floor(building.hp)}/${building.hpMax}`;

  const extras: string[] = [name];
  if (mine) {
    if (polluted) extras.push("污染区内 · 仅可拆除");
    if (supportsLinearUpgrade(building.buildingId)) {
      extras.push(`等级 ${romanLevelLabel(buildingLevel(building))}`);
      const r = effectiveWorkR(building);
      if (r != null && r > 0) extras.push(`R ${Number(r.toFixed(2))}`);
    }
    if (def?.size != null) extras.push(SIZE_NAME[def.size]);
    if (def?.p) extras.push(`P +${def.p}`);
    if (def?.orgBonus) extras.push(`O +${def.orgBonus}`);
    if (def?.rawP) extras.push(`Raw-P ${def.rawP}`);
    if (def?.notes) extras.push(def.notes);
  } else if (enemySatellite) {
    extras.push("卫星视野");
  } else if (enemyDirect) {
    extras.push("直接视野");
  }
  if (mine && inProgress && continueBuild) {
    extras.push("受击中断 · 接入通信后可继续建造");
  } else if (mine && inProgress && building.buildPaused) {
    extras.push("须在直接视野内或经公路/铁路连入视野");
  }
  if (mine && isTrainingGround) {
    const q = building.trainingQueue ?? [];
    if (q.length > 0) {
      const head = q[0]!;
      const remSec = Math.ceil(head.ticksRemaining / 15);
      const kindName = UNIT_BY_KIND[head.kind]?.name ?? head.kind;
      extras.push(
        `训练 ${kindName} ${head.u}U · 约 ${remSec}s` +
          (q.length > 1 ? ` · 队列 ${q.length}` : ""),
      );
    } else {
      extras.push("训练空闲");
    }
  }
  if (mine && cooldownLabel && (isLauncher || isAntiAir)) {
    extras.push(cooldownLabel);
  }

  const fire = (
    action: BuildingInspectAction,
    detail?: BuildingInspectActionDetail,
  ) => {
    onAction?.(action, building, detail);
  };

  const showLaunchOp = mine && (isLauncher || isAntiAir);

  return (
    <div className="building-inspect" aria-label={`${name} 信息`}>
      {/* Launch / AA control sits on the upper half of the building icon so it
          does not cover the HP / ammo bars drawn on the lower half. */}
      {showLaunchOp && (
        <div
          className="building-inspect-launch"
          style={{ left: screenX, top: screenY }}
        >
          {isLauncher ? (
            <OpButton
              label={onCooldown ? `冷却 ${cooldownRemSec}s` : "发射"}
              icon={def?.icon ?? OP_MUTUAL}
              disabled={launchDisabled}
              title={launchTitle}
              onFire={() => fire("fire")}
            />
          ) : (
            <OpButton
              label={onCooldown ? `冷却 ${cooldownRemSec}s` : "防空"}
              icon={def?.icon ?? OP_MUTUAL}
              disabled
              title={
                onCooldown
                  ? cooldownLabel ?? "发射冷却中"
                  : "自动拦截导弹 / 接敌交战"
              }
              onFire={() => {}}
            />
          )}
        </div>
      )}
      <div
        className="building-inspect-row"
        style={{ left: screenX + offset, top: screenY }}
      >
        <div className="building-inspect-panel">
          <div className="building-inspect-owner">{ownerName}</div>
          {showHp && (
            <div className="building-inspect-box is-hp">
              <div className="building-inspect-box-label">{hpLabel}</div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-hp"
                  style={{ width: `${hpRatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {mine && storeEMax > 0 && (
            <div className="building-inspect-box is-energy">
              <div className="building-inspect-box-label">
                能源 {storeECur}/{storeEMax}
              </div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-energy"
                  style={{ width: `${storeERatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {mine && ammoMax > 0 && (
            <div className="building-inspect-box is-ammo">
              <div className="building-inspect-box-label">
                弹药 {ammoCur}/{ammoMax}
              </div>
              <div className="building-inspect-bar-track">
                <div
                  className="building-inspect-bar-fill is-ammo"
                  style={{ width: `${ammoRatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {showUBar && (
            <div className="building-inspect-box is-u">
              <div className="building-inspect-box-label">
                {isTrainingGround
                  ? trainActive
                    ? `训练 ${Math.round(trainProgress * 100)}%`
                    : "训练 —"
                  : uMax > 0
                    ? uAway > 0
                      ? `驻军 ${uCur}/${uMax}（外出 ${uAway}）`
                      : `驻军 ${uCur}/${uMax}`
                    : "驻军 —"}
              </div>
              <div
                className={`building-inspect-bar-track${trainActive ? " is-training" : ""}`}
              >
                {isTrainingGround ? (
                  <>
                    <div
                      className="building-inspect-bar-fill is-u is-train-progress"
                      style={{ width: `${trainProgress * 100}%` }}
                    />
                    {trainActive && (
                      <div className="building-inspect-bar-runner" aria-hidden />
                    )}
                  </>
                ) : (
                  <>
                    <div
                      className="building-inspect-bar-fill is-u"
                      style={{ width: `${uPresentRatio * 100}%` }}
                    />
                    {uAway > 0 && (
                      <div
                        className="building-inspect-bar-fill is-u-away"
                        style={{
                          left: `${uPresentRatio * 100}%`,
                          width: `${uAwayRatio * 100}%`,
                        }}
                      />
                    )}
                  </>
                )}
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
        </div>

        {mine && (
          <div className="building-inspect-actions">
            <button
              type="button"
              className="building-inspect-action-btn"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                fire("demolish");
              }}
            >
              拆除
            </button>
            <button
              type="button"
              className="building-inspect-action-btn"
              disabled={
                polluted ||
                !commsLinked ||
                (repairing && midAction === "repair") ||
                (midAction === "repair" && inProgress && !continueBuild) ||
                (midAction === "level_upgrade" && levelUpDisabled)
              }
              title={midTitle}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (polluted || !commsLinked) return;
                if (midAction === "level_upgrade" && levelUpDisabled) return;
                fire(midAction);
              }}
            >
              {midLabel}
            </button>
            {canReload || canDeploy ? (
              <HoldSliderButton
                label={thirdLabel}
                kind={canReload ? "ammo" : "energy"}
                disabled={holdDisabled}
                title={holdTitle}
                maxCount={canReload ? maxReload : maxDeploy}
                stepE={canReload ? reloadE : deployStepE}
                orgCost={HOLD_ACTION_O_COST}
                onCommit={(count) => fire(thirdAction, { count })}
              />
            ) : (
              <button
                type="button"
                className="building-inspect-action-btn"
                disabled={holdDisabled}
                title={holdTitle}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (holdDisabled) return;
                  fire(thirdAction);
                }}
              >
                {thirdLabel}
              </button>
            )}
          </div>
        )}

        <div className="building-inspect-ops">
          {mine ? (
            <>
              <OpButton
                label="驻守"
                icon={OP_DEFENSE}
                disabled={polluted || !commsLinked}
                title={polluted ? "污染区内建筑已失效" : undefined}
                onFire={() => fire("garrison")}
              />
              {isSupply ? (
                <OpButton
                  label="补给"
                  icon={SUPPLY_ICON}
                  disabled={polluted || !commsLinked}
                  title={polluted ? "污染区内建筑已失效" : undefined}
                  onFire={() => fire("supply")}
                />
              ) : !showLaunchOp ? (
                <OpButton
                  label="互防"
                  icon={OP_MUTUAL}
                  disabled={polluted || !commsLinked}
                  title={polluted ? "污染区内建筑已失效" : undefined}
                  onFire={() => fire("mutual_defense")}
                />
              ) : null}
            </>
          ) : (
            <OpButton label="进攻" icon={OP_ATTACK} onFire={() => fire("attack")} />
          )}
        </div>
      </div>
    </div>
  );
}

function countFromPointerY(
  clientY: number,
  originY: number,
  maxCount: number,
): number {
  const dy = clientY - originY;
  if (dy > 0) return 0; // cancel zone below origin
  if (maxCount <= 1) return 1;
  const t = Math.max(0, Math.min(1, -dy / RELOAD_INCREASE_H));
  return 1 + Math.round(t * (maxCount - 1));
}

function HoldSliderButton({
  label,
  kind,
  disabled,
  title,
  maxCount,
  stepE,
  orgCost,
  onCommit,
}: {
  label: string;
  kind: "ammo" | "energy";
  disabled: boolean;
  title?: string;
  maxCount: number;
  stepE: number;
  orgCost: number;
  onCommit: (count: number) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const originYRef = useRef(0);
  const maxCountRef = useRef(maxCount);
  const dragRef = useRef<{ count: number } | null>(null);
  const [drag, setDrag] = useState<{ count: number } | null>(null);

  maxCountRef.current = maxCount;

  const endDrag = useCallback(
    (clientY: number | null) => {
      if (!dragRef.current) return;
      const count =
        clientY == null
          ? dragRef.current.count
          : countFromPointerY(clientY, originYRef.current, maxCountRef.current);
      dragRef.current = null;
      setDrag(null);
      if (count >= 1) onCommit(count);
    },
    [onCommit],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const count = countFromPointerY(
        e.clientY,
        originYRef.current,
        maxCountRef.current,
      );
      dragRef.current = { count };
      setDrag({ count });
    };
    const onUp = (e: PointerEvent) => {
      endDrag(e.clientY);
    };
    const onCancel = () => {
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag, endDrag]);

  const cancelled = drag != null && drag.count < 1;
  const activeCount = drag?.count ?? 1;
  const thumbTopPct = (() => {
    if (!drag) return (RELOAD_INCREASE_H / RELOAD_SLIDER_H) * 100;
    if (cancelled) {
      // Park thumb in the middle of the cancel zone.
      return ((RELOAD_INCREASE_H + RELOAD_CANCEL_H * 0.55) / RELOAD_SLIDER_H) * 100;
    }
    if (maxCount <= 1) return (RELOAD_INCREASE_H / RELOAD_SLIDER_H) * 100;
    const t = (activeCount - 1) / (maxCount - 1);
    return ((1 - t) * RELOAD_INCREASE_H) / RELOAD_SLIDER_H * 100;
  })();
  const fillTopPct = cancelled
    ? (RELOAD_INCREASE_H / RELOAD_SLIDER_H) * 100
    : Math.min(thumbTopPct, (RELOAD_INCREASE_H / RELOAD_SLIDER_H) * 100);

  return (
    <div className="building-inspect-reload-wrap">
      {drag && (
        <div
          className={`building-inspect-reload-slider${cancelled ? " is-cancel" : ""}${kind === "energy" ? " is-energy" : ""}`}
          style={{
            height: RELOAD_SLIDER_H,
            // Origin (1发) aligns with the button center.
            transform: `translateY(-${RELOAD_INCREASE_H}px)`,
          }}
          aria-hidden
        >
          <div className="building-inspect-reload-track">
            <div
              className="building-inspect-reload-fill"
              style={{
                top: `${fillTopPct}%`,
                bottom: `${(RELOAD_CANCEL_H / RELOAD_SLIDER_H) * 100}%`,
              }}
            />
            <div
              className="building-inspect-reload-origin"
              style={{ top: `${(RELOAD_INCREASE_H / RELOAD_SLIDER_H) * 100}%` }}
            />
            <div
              className="building-inspect-reload-thumb"
              style={{ top: `${thumbTopPct}%` }}
            />
          </div>
          <div className="building-inspect-reload-readout">
            {cancelled ? (
              <span>取消</span>
            ) : kind === "ammo" ? (
              <>
                <span>{activeCount} 发</span>
                <span className="building-inspect-reload-cost">
                  {activeCount * stepE} E
                </span>
                <span className="building-inspect-reload-cost">{orgCost} O</span>
              </>
            ) : (
              <>
                <span>{activeCount * stepE} E</span>
                <span className="building-inspect-reload-cost">{orgCost} O</span>
              </>
            )}
          </div>
        </div>
      )}
      <button
        ref={btnRef}
        type="button"
        className={`building-inspect-action-btn${drag ? " is-reload-holding" : ""}`}
        disabled={disabled}
        title={title}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (disabled || maxCount < 1) return;
          if (e.button !== 0) return;
          const rect = btnRef.current?.getBoundingClientRect();
          originYRef.current = rect
            ? rect.top + rect.height / 2
            : e.clientY;
          try {
            btnRef.current?.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
          const next = { count: 1 };
          dragRef.current = next;
          setDrag(next);
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        {label}
      </button>
    </div>
  );
}

function OpButton({
  label,
  icon,
  disabled,
  title,
  onFire,
}: {
  label: string;
  icon: string;
  disabled?: boolean;
  title?: string;
  onFire: () => void;
}) {
  return (
    <button
      type="button"
      className="building-inspect-op"
      title={title ?? (disabled ? "未接入通信" : label)}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onFire();
      }}
    >
      <span className="point-action-icon">
        <img src={icon} alt="" draggable={false} />
      </span>
      <span className="point-action-label">{label}</span>
    </button>
  );
}
