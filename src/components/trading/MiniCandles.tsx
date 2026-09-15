import { cn } from "@/lib/utils";
import type { MirrorCandle } from "@/lib/analysis/mirror";

export interface MiniCandlesProps {
  candles: MirrorCandle[];
  /** Lê o trecho de trás pra frente (espelho de tempo). */
  reverseTime?: boolean;
  /** Inverte o desenho de cima pra baixo (inversão de preço). */
  invertPrice?: boolean;
  /** Destaca as velas de continuação, se enviadas. */
  nextCandles?: MirrorCandle[];
  className?: string;
  height?: number;
}

/** Miniatura de velas em SVG, sem dependências de gráfico. */
export function MiniCandles({
  candles,
  reverseTime = false,
  invertPrice = false,
  nextCandles = [],
  className,
  height = 72,
}: MiniCandlesProps) {
  const ordered = reverseTime ? [...candles].reverse() : [...candles];
  const series = [...ordered, ...nextCandles];
  if (series.length < 2) return null;

  const firstNextIndex = ordered.length;
  const highs = series.map((c) => c.high);
  const lows = series.map((c) => c.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || 1;
  const width = 300;
  const step = width / series.length;
  const bodyWidth = Math.max(1.6, step * 0.55);

  const y = (value: number) => {
    const ratio = (value - min) / span;
    const normalized = invertPrice ? ratio : 1 - ratio;
    return normalized * (height - 6) + 3;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-[72px] w-full", className)}
      preserveAspectRatio="none"
      role="img"
      aria-label="Miniatura do trecho de velas"
    >
      {series.map((candle, index) => {
        const isNext = index >= firstNextIndex;
        const rising = invertPrice ? candle.close < candle.open : candle.close >= candle.open;
        const cx = index * step + step / 2;
        const top = Math.min(y(candle.open), y(candle.close));
        const bottom = Math.max(y(candle.open), y(candle.close));
        return (
          <g
            key={`${candle.time}-${index}`}
            className={rising ? "text-call" : "text-put"}
            opacity={isNext ? 1 : 0.7}
          >
            <line
              x1={cx}
              x2={cx}
              y1={y(candle.high)}
              y2={y(candle.low)}
              stroke="currentColor"
              strokeWidth={isNext ? 1.6 : 1}
            />
            <rect
              x={cx - bodyWidth / 2}
              y={top}
              width={bodyWidth}
              height={Math.max(1, bottom - top)}
              fill="currentColor"
              stroke={isNext ? "currentColor" : "none"}
              strokeWidth={isNext ? 1.4 : 0}
            />
          </g>
        );
      })}
      {nextCandles.length > 0 && (
        <line
          x1={firstNextIndex * step}
          x2={firstNextIndex * step}
          y1={0}
          y2={height}
          stroke="currentColor"
          strokeDasharray="3 3"
          className="text-muted-foreground"
          strokeWidth={1}
        />
      )}
    </svg>
  );
}
