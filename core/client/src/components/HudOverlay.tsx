import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { PlayerHudState } from "@wop/shared";
import { CapitalHpRing } from "./CapitalHpRing";

interface Props {
  hud: PlayerHudState;
  /** Uncapped target from rules: max(window)/16. */
  windowHudSize: number;
}

interface CapSize {
  w: number;
  h: number;
}

export function HudOverlay({ hud, windowHudSize }: Props) {
  // hud.energy / hud.organization are server-authoritative (from GameStateSnapshot.you).
  const resourcesRef = useRef<HTMLDivElement>(null);
  /** Natural size of energy/org block at scale 1 — permanent cap. */
  const [cap, setCap] = useState<CapSize | null>(null);

  // Measure once at scale 1, before paint when possible.
  useLayoutEffect(() => {
    if (cap) return;
    const el = resourcesRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w > 0 && h > 0) setCap({ w, h });
  }, [cap, hud.energy, hud.organization]);

  const hudSize =
    cap && cap.h > 0 ? Math.min(windowHudSize, cap.h) : windowHudSize;
  const scale = cap && cap.h > 0 ? hudSize / cap.h : 1;

  const orgRatio = Math.min(1, hud.organization / hud.organizationMax);
  const hudStyle = {
    "--ring-d": `${hudSize}px`,
    "--hud-scale": String(scale),
  } as CSSProperties;

  const slotStyle: CSSProperties | undefined = cap
    ? {
        width: cap.w * scale,
        height: hudSize,
      }
    : undefined;

  const resourcesStyle: CSSProperties = {
    transform: `scale(${scale})`,
    transformOrigin: "left top",
  };

  return (
    <div className="hud" style={hudStyle}>
      <CapitalHpRing
        diameter={hudSize}
        hp={hud.capitalHp}
        hpMax={hud.capitalHpMax}
      />
      <div className="hud-resources-slot" style={slotStyle}>
        <div className="hud-resources" ref={resourcesRef} style={resourcesStyle}>
          <div className="resource-row energy">
            <img className="resource-icon" src="/ui/energy.png" alt="" />
            <span className="resource-label">能源</span>
            <span className="resource-value">{Math.floor(hud.energy)}</span>
          </div>
          <div className="resource-row organization">
            <img className="resource-icon" src="/ui/organization_point.png" alt="" />
            <span className="resource-label">组织</span>
            <span className="resource-value">{Math.floor(hud.organization)}</span>
          </div>
          <div className="org-bar" title={`组织点槽 ${hud.organization}/${hud.organizationMax}`}>
            <div className="org-bar-fill" style={{ width: `${orgRatio * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
