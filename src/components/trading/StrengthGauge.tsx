import { useId } from "react";

interface Props {
  /** -100..100 when signed, 0..100 otherwise */
  value: number;
  label: string;
  caption?: string;
  /** signed gauges color CALL/PUT, absolute ones use the primary ramp */
  signed?: boolean;
  suffix?: string;
  size?: number;
  display?: string;
}

const START = -220;
const END = 40;
const SWEEP = END - START;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

/** Speedometer-style strength marker used across the signals dashboard. */
export function StrengthGauge({
  value,
  label,
  caption,
  signed = false,
  suffix = "%",
  size = 128,
  display,
}: Props) {
  const id = useId().replace(/:/g, "");
  const clamped = Math.max(signed ? -100 : 0, Math.min(100, Number.isFinite(value) ? value : 0));
  const ratio = signed ? (clamped + 100) / 200 : clamped / 100;
  const cx = 50;
  const cy = 50;
  const r = 38;
  const angle = START + SWEEP * ratio;
  const needle = polar(cx, cy, r - 7, angle);
  const tone = signed
    ? clamped > 4
      ? "var(--call)"
      : clamped < -4
        ? "var(--put)"
        : "var(--muted-foreground)"
    : clamped >= 66
      ? "var(--accent)"
      : clamped >= 33
        ? "var(--primary)"
        : "var(--muted-foreground)";

  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 100 78" width={size} height={size * 0.78} role="img" aria-label={`${label}: ${display ?? `${clamped}${suffix}`}`}>
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor={signed ? "var(--put)" : "var(--primary)"} />
            <stop offset="50%" stopColor="var(--primary)" />
            <stop offset="100%" stopColor={signed ? "var(--call)" : "var(--accent)"} />
          </linearGradient>
          <filter id={`f-${id}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <path d={arc(cx, cy, r, START, END)} fill="none" stroke="var(--border)" strokeWidth="9" strokeLinecap="round" opacity="0.55" />
        <path
          d={arc(cx, cy, r, START, Math.max(START + 0.6, angle))}
          fill="none"
          stroke={`url(#g-${id})`}
          strokeWidth="9"
          strokeLinecap="round"
          filter={`url(#f-${id})`}
          style={{ transition: "d 300ms ease" }}
        />

        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const a = START + SWEEP * t;
          const p1 = polar(cx, cy, r - 13, a);
          const p2 = polar(cx, cy, r - 17, a);
          return <line key={t} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--muted-foreground)" strokeWidth="1.2" opacity="0.5" />;
        })}

        <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={tone} strokeWidth="2.6" strokeLinecap="round" style={{ transition: "all 300ms ease" }} />
        <circle cx={cx} cy={cy} r="3.6" fill={tone} />

        <text x={cx} y={70} textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--foreground)" style={{ fontFamily: "var(--font-mono)" }}>
          {display ?? `${Math.round(clamped)}${suffix}`}
        </text>
      </svg>
      <p className="text-center text-[11px] font-medium text-muted-foreground">{label}</p>
      {caption && <p className="text-center text-[10px] text-muted-foreground/70">{caption}</p>}
    </div>
  );
}
