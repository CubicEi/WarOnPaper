import {
  BUILDING_BY_ID,
  TRAINABLE_KINDS,
  TRAIN_E_PER_U,
  UNIT_BY_KIND,
  allocateTrainingDeliveries,
  availableTrainingRoom,
  buildingAcceptsUnitKind,
  isBuildingComplete,
  trainDurationSec,
  trainEnergyCost,
  trainingQueueKind,
  type PlacedBuilding,
  type TrainableKind,
  type UnitGroup,
} from "@wop/shared";

interface Props {
  source: PlacedBuilding;
  buildings: readonly PlacedBuilding[];
  units: readonly UnitGroup[];
  myPlayerId: string | null;
  energy: number;
  kind: TrainableKind;
  u: number;
  /** Multi-select destination buildings; U is split by each target's free room in list order. */
  targetIds: string[];
  onKind: (kind: TrainableKind) => void;
  onU: (u: number) => void;
  onToggleTarget: (id: string) => void;
  onGo: (amount: number) => void;
  onClose: () => void;
}

export function TrainPanel({
  source,
  buildings,
  units,
  myPlayerId,
  energy,
  kind,
  u,
  targetIds,
  onKind,
  onU,
  onToggleTarget,
  onGo,
  onClose,
}: Props) {
  const lockedKind = trainingQueueKind(source);
  const targets = buildings.filter((b) => {
    if (myPlayerId == null || b.ownerId !== myPlayerId) return false;
    if (b.id === source.id) return false;
    if (!isBuildingComplete(b) && b.buildingId !== "capital") return false;
    if (!buildingAcceptsUnitKind(b.buildingId, kind)) return false;
    return availableTrainingRoom(b, buildings, units) >= 1;
  });

  const maxU =
    myPlayerId == null || targetIds.length === 0
      ? 0
      : targetIds.reduce((sum, id) => {
          const b = buildings.find((x) => x.id === id);
          if (!b) return sum;
          return sum + availableTrainingRoom(b, buildings, units);
        }, 0);

  const amount = maxU < 1 ? Math.max(1, u) : Math.min(Math.max(1, u), maxU);
  const cost = trainEnergyCost(kind, amount);
  const secs = trainDurationSec(kind, amount);
  const kindBlocked = lockedKind != null && lockedKind !== kind;

  const preview =
    myPlayerId != null && targetIds.length > 0
      ? allocateTrainingDeliveries(
          amount,
          targetIds,
          kind,
          myPlayerId,
          buildings,
          units,
        )
      : null;
  const allocHint =
    preview && preview.ok
      ? preview.allocations
          .map((a) => {
            const b = buildings.find((x) => x.id === a.targetBuildingId);
            const name = b
              ? (BUILDING_BY_ID[b.buildingId]?.name ?? b.buildingId)
              : a.targetBuildingId.slice(0, 6);
            return `${name} ${a.u}U`;
          })
          .join(" · ")
      : preview && !preview.ok
        ? preview.error
        : null;

  const canGo =
    targetIds.length >= 1 &&
    maxU >= 1 &&
    amount >= 1 &&
    amount <= maxU &&
    energy >= cost &&
    !kindBlocked &&
    preview != null &&
    preview.ok;

  return (
    <div className="mobilize-panel train-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mobilize-head">
        <span>训练 · 送达目标</span>
        <button type="button" className="mobilize-close" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="train-kinds">
        {TRAINABLE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`train-kind-btn${kind === k ? " is-on" : ""}`}
            disabled={lockedKind != null && lockedKind !== k}
            title={
              lockedKind != null && lockedKind !== k
                ? `训练场正在训练${UNIT_BY_KIND[lockedKind].name}`
                : undefined
            }
            onClick={() => onKind(k)}
          >
            {UNIT_BY_KIND[k].name}
            <span className="train-kind-cost">{TRAIN_E_PER_U[k]}E</span>
          </button>
        ))}
      </div>
      {kindBlocked && (
        <div className="train-kind-lock">
          本场只能继续训练{UNIT_BY_KIND[lockedKind!].name}
        </div>
      )}
      <p className="train-multi-hint">
        可多选目标：按勾选顺序用各建筑空位分配本次 U；超出合计空位会拒绝并提示，不会静默截断。
      </p>
      <label className="train-amount">
        数量
        <input
          type="number"
          min={1}
          max={Math.max(1, maxU)}
          value={amount}
          disabled={maxU < 1}
          onChange={(e) => onU(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
        <span className="train-amount-hint">合计空位 {maxU}</span>
      </label>
      <ul className="mobilize-list">
        {targets.length === 0 && <li className="train-empty">无可用目标建筑</li>}
        {targets.map((b) => {
          const name = BUILDING_BY_ID[b.buildingId]?.name ?? b.buildingId;
          const r = availableTrainingRoom(b, buildings, units);
          const on = targetIds.includes(b.id);
          return (
            <li key={b.id}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    onToggleTarget(b.id);
                  }}
                />
                {name} · 空 {r}U · ({b.gx},{b.gy})
              </label>
            </li>
          );
        })}
      </ul>
      {allocHint && (
        <div className={`train-alloc-preview${preview && !preview.ok ? " is-err" : ""}`}>
          {preview && preview.ok ? `分配：${allocHint}` : allocHint}
        </div>
      )}
      <div className="mobilize-foot">
        <span>
          {cost}E · {secs < 1 ? "<1" : secs.toFixed(1)}s
        </span>
        <button type="button" disabled={!canGo} onClick={() => onGo(amount)}>
          开始训练
        </button>
      </div>
    </div>
  );
}
