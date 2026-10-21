export type PointActionId = "mobilize" | "lockdown" | "build" | "set_capital";

export interface PointActionDef {
  id: PointActionId;
  label: string;
  /** Degrees from +X (right); negative = up. */
  angleDeg: number;
  icon: string;
}

/** 调动 / 封锁 / 建造 — icons under assets/icons/symbol/operation */
export const POINT_ACTIONS: PointActionDef[] = [
  {
    id: "mobilize",
    label: "调动",
    angleDeg: -32,
    icon: "/icons/symbol/operation/mobilize.png",
  },
  {
    id: "lockdown",
    label: "封锁",
    angleDeg: 0,
    icon: "/icons/symbol/operation/lockdown.png",
  },
  {
    id: "build",
    label: "建造",
    angleDeg: 32,
    icon: "/icons/symbol/operation/build.png",
  },
];

/** 选都阶段：半圆菜单仅「定为首都」— 使用黑色首都图标 */
export const CAPITAL_PICK_ACTIONS: PointActionDef[] = [
  {
    id: "set_capital",
    label: "定为首都",
    angleDeg: 0,
    icon: "/icons/buildings - black/settlement/capital.svg",
  },
];

interface Props {
  /** Selection anchor in screen pixels (canvas local). */
  screenX: number;
  screenY: number;
  /** Distance from point center to button centers. */
  arcRadius: number;
  actions?: readonly PointActionDef[];
  onAction?: (id: PointActionId) => void;
}

export function PointActionMenu({
  screenX,
  screenY,
  arcRadius,
  actions = POINT_ACTIONS,
  onAction,
}: Props) {
  return (
    <div className="point-action-menu" aria-label="点位指令">
      {actions.map((action) => {
        const rad = (action.angleDeg * Math.PI) / 180;
        const left = screenX + Math.cos(rad) * arcRadius;
        const top = screenY + Math.sin(rad) * arcRadius;
        return (
          <button
            key={action.id}
            type="button"
            className="point-action-btn"
            title={action.label}
            aria-label={action.label}
            style={{ left, top }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onAction?.(action.id);
            }}
          >
            <span className="point-action-icon">
              <img src={action.icon} alt="" draggable={false} />
            </span>
            <span className="point-action-label">{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
