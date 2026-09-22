interface Props {
  diameter: number;
  hp: number;
  hpMax: number;
}

/** Capital HP ring: one full lap = full HP. Diameter = max(window)/16. */
export function CapitalHpRing({ diameter, hp, hpMax }: Props) {
  const stroke = Math.max(3, diameter * 0.1);
  const r = (diameter - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = hpMax > 0 ? Math.max(0, Math.min(1, hp / hpMax)) : 0;
  const offset = c * (1 - ratio);

  return (
    <div className="hp-ring" style={{ width: diameter, height: diameter }} title={`首都 HP ${hp}/${hpMax}`}>
      <svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`}>
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={r}
          fill="none"
          stroke="#3d3d3d"
          strokeWidth={stroke}
        />
        <circle
          className="hp-ring-progress"
          cx={diameter / 2}
          cy={diameter / 2}
          r={r}
          fill="none"
          stroke="#ff5555"
          strokeWidth={stroke}
          strokeLinecap="butt"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${diameter / 2} ${diameter / 2})`}
        />
      </svg>
      <span className="hp-ring-label">{Math.round(hp)}</span>
    </div>
  );
}
