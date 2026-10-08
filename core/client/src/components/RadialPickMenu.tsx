import { useState } from "react";

export type RadialPickItemKind = "coord" | "building" | "unit";

export interface RadialPickItem {
  id: string;
  kind: RadialPickItemKind;
  label: string;
  /** Optional icon src; coord may omit and show a glyph. */
  icon?: string;
}

interface Props {
  screenX: number;
  screenY: number;
  /** Distance from center to button icon centers. */
  arcRadius: number;
  items: readonly RadialPickItem[];
  onPick: (item: RadialPickItem) => void;
}

/** Max items drawn on the ring; overflow uses「更多」+ scroll list. */
export const RADIAL_PICK_RING_MAX = 6;

/**
 * Side-only ring slots (deg, +X = 0°, clockwise positive via sin/cos).
 * Right column first (−45 / 0 / 45), then left (135 / 180 / 225).
 * Top (−90°) and bottom (90°) stay empty for the coord / more row.
 */
export const RADIAL_PICK_SIDE_ANGLES: readonly number[] = [
  -45, 0, 45, 135, 180, 225,
];

/**
 * Place up to 6 ring buttons on left/right only, right side first.
 * Does not stretch to fill the circle; unused side slots stay empty.
 */
export function radialRingAngles(count: number): number[] {
  if (count <= 0) return [];
  const n = Math.min(count, RADIAL_PICK_SIDE_ANGLES.length);
  return RADIAL_PICK_SIDE_ANGLES.slice(0, n);
}

function isLeftAngle(angleDeg: number): boolean {
  const a = ((angleDeg % 360) + 360) % 360;
  return a > 90 && a < 270;
}

export function RadialPickMenu({ screenX, screenY, arcRadius, items, onPick }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const coordItem = items.find((it) => it.kind === "coord") ?? null;
  const ringCandidates = items.filter((it) => it.kind !== "coord");
  const overflow = ringCandidates.length > RADIAL_PICK_RING_MAX;
  const ringItems = overflow
    ? ringCandidates.slice(0, RADIAL_PICK_RING_MAX)
    : ringCandidates;
  const angles = radialRingAngles(ringItems.length);

  const belowY = screenY + arcRadius + 18;
  const moreY = belowY + (coordItem ? 30 : 0);
  const listY = moreY + 28;

  return (
    <div className="radial-pick-menu" aria-label="点选菜单">
      {ringItems.map((item, i) => {
        const angleDeg = angles[i] ?? 0;
        const rad = (angleDeg * Math.PI) / 180;
        const left = screenX + Math.cos(rad) * arcRadius;
        const top = screenY + Math.sin(rad) * arcRadius;
        const onLeft = isLeftAngle(angleDeg);
        return (
          <button
            key={item.id}
            type="button"
            className={`point-action-btn radial-pick-btn${onLeft ? " is-left" : ""}`}
            title={item.label}
            aria-label={item.label}
            style={{ left, top }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onPick(item);
            }}
          >
            <span className="point-action-icon" aria-hidden>
              {item.icon ? (
                <img src={item.icon} alt="" draggable={false} />
              ) : (
                <span className="radial-pick-glyph">⊕</span>
              )}
            </span>
            <span className="point-action-label">{item.label}</span>
          </button>
        );
      })}
      {coordItem && (
        <button
          type="button"
          className="radial-pick-coord"
          title={coordItem.label}
          aria-label={coordItem.label}
          style={{ left: screenX, top: belowY }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPick(coordItem);
          }}
        >
          {coordItem.label}
        </button>
      )}
      {overflow && (
        <button
          type="button"
          className="radial-pick-more"
          style={{ left: screenX, top: moreY }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setMoreOpen((v) => !v);
          }}
        >
          更多
        </button>
      )}
      {moreOpen && (
        <div
          className="radial-pick-list"
          style={{ left: screenX, top: listY }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ul>
            {items.map((item) => (
              <li key={`list-${item.id}`}>
                <button
                  type="button"
                  className="radial-pick-list-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(item);
                  }}
                >
                  <span className="point-action-icon" aria-hidden>
                    {item.icon ? (
                      <img src={item.icon} alt="" draggable={false} />
                    ) : (
                      <span className="radial-pick-glyph">⊕</span>
                    )}
                  </span>
                  <span className="point-action-label">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
