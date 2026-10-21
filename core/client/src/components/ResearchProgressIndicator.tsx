import { useEffect, useRef, useState } from "react";
import {
  BUILDING_BY_ID,
  getRocketResearchStages,
  isRocketResearchTarget,
  rocketResearchDurationTicks,
  type ActiveRocketResearch,
  type RocketResearchId,
} from "@wop/shared";
import { buildingUiIcon } from "../ui/buildingUiIcon";

const COMPLETE_FLASH_MS = 5000;

interface Props {
  tick: number;
  activeResearch: ActiveRocketResearch | null | undefined;
}

/**
 * Top-right research ring below the 返回 button.
 * Progress while researching; breathe-flash 5s after completion, then hide.
 */
export function ResearchProgressIndicator({ tick, activeResearch }: Props) {
  const [flash, setFlash] = useState<{
    buildingId: RocketResearchId;
    until: number;
  } | null>(null);
  const prevActiveRef = useRef<ActiveRocketResearch | null | undefined>(
    activeResearch,
  );

  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeResearch;
    if (prev && !activeResearch) {
      setFlash({
        buildingId: prev.buildingId,
        until: Date.now() + COMPLETE_FLASH_MS,
      });
    }
  }, [activeResearch]);

  useEffect(() => {
    if (!flash) return;
    const left = flash.until - Date.now();
    if (left <= 0) {
      setFlash(null);
      return;
    }
    const id = window.setTimeout(() => setFlash(null), left);
    return () => window.clearTimeout(id);
  }, [flash]);

  const showActive = !!activeResearch;
  const showFlash = !showActive && !!flash;
  if (!showActive && !showFlash) return null;

  const buildingId = (activeResearch?.buildingId ?? flash?.buildingId)!;
  if (!isRocketResearchTarget(buildingId)) return null;

  const def = BUILDING_BY_ID[buildingId];
  const icon = buildingUiIcon(
    def?.icon ?? `/icons/buildings/military/${buildingId}.svg`,
  );

  let progress = 1;
  if (activeResearch) {
    const stages = getRocketResearchStages(buildingId);
    const stage = stages[activeResearch.stage];
    const total = stage
      ? rocketResearchDurationTicks(stage.energy)
      : 1;
    const remaining = Math.max(0, activeResearch.endsAtTick - tick);
    progress = total <= 0 ? 1 : Math.max(0, Math.min(1, 1 - remaining / total));
  }

  const size = 52;
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * progress;

  return (
    <div
      className={`research-ring${showFlash ? " is-complete" : ""}`}
      aria-hidden
      title={def?.name ?? buildingId}
    >
      <svg
        className="research-ring-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle
          className="research-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="research-ring-progress"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="research-ring-icon">
        <img src={icon} alt="" draggable={false} />
      </span>
    </div>
  );
}
