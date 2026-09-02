import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TIMEFRAME_LIST } from "@/lib/iqoption/mapping";
import { useIqOptionStream } from "@/lib/iqoption/useIqOptionStream";
import { Activity, Radio } from "lucide-react";

interface ChartDisplayProps {
  symbol: string;
  timeframe: string;
  onTimeframeChange: (timeframe: string) => void;
}

export function ChartDisplay({ symbol, timeframe, onTimeframeChange }: ChartDisplayProps) {
  const { data, currentPrice, isLive, status, error } = useIqOptionStream(symbol, timeframe);

  const chartData = useMemo(
    () =>
      data.slice(-120).map((candle) => ({
        label: new Date(candle.time * 1000).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        close: candle.close,
        high: candle.high,
        low: candle.low,
      })),
    [data],
  );

  const first = chartData[0]?.close ?? 0;
  const last = chartData[chartData.length - 1]?.close ?? 0;
  const rising = last >= first;

  return (
    <Card className="glass-panel border-border/50">
      <CardHeader className="flex flex-col gap-4 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 font-display text-lg">
            {symbol}
            {isLive ? (
              <Badge className="gap-1 bg-call/20 text-call hover:bg-call/30">
                <Radio className="h-3 w-3" /> LIVE
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <Activity className="h-3 w-3" />
                {status === "connecting" ? "conectando" : "sync"}
              </Badge>
            )}
          </CardTitle>
          <p className="mt-1 font-mono text-2xl font-bold text-foreground">
            {currentPrice != null ? currentPrice.toFixed(5) : "—"}
          </p>
        </div>
        <Tabs value={timeframe} onValueChange={onTimeframeChange}>
          <TabsList className="bg-surface">
            {TIMEFRAME_LIST.map((tf) => (
              <TabsTrigger key={tf} value={tf} className="font-mono text-xs">
                {tf}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-2 text-xs text-muted-foreground">{error}</p>}
        <div className="h-72 w-full">
          {chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Carregando velas em tempo real…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="candleFill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={rising ? "var(--call)" : "var(--put)"}
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      stopColor={rising ? "var(--call)" : "var(--put)"}
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  width={70}
                  tickFormatter={(value: number) => value.toFixed(5)}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(value: number) => value.toFixed(5)}
                />
                <Area
                  type="monotone"
                  dataKey="close"
                  stroke={rising ? "var(--call)" : "var(--put)"}
                  strokeWidth={2}
                  fill="url(#candleFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
