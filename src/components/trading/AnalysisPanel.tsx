import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowUp, Layers, Minus, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { analyzeAsset } from "@/lib/analysis/analysis.functions";
import { getIqOptionName } from "@/lib/iqoption/mapping";

interface Props {
  symbol: string | null;
  timeframe: string;
}

const trendLabel = (t: string) => (t === "up" ? "Alta" : t === "down" ? "Baixa" : "Lateral");

export function AnalysisPanel({ symbol, timeframe }: Props) {
  const asset = getIqOptionName(symbol);
  const run = useServerFn(analyzeAsset);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["analysis", asset, timeframe],
    queryFn: () => run({ data: { asset: asset!, timeframe: timeframe as "M1" | "M5" | "M15" } }),
    enabled: !!asset,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const result = data?.result ?? null;
  const message = data?.error ?? (error ? "Análise indisponível." : null);
  const direction = result?.direction;

  return (
    <Card className="glass-panel border-border/50">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Sparkles className="h-4 w-4" /> Análise técnica — {symbol ?? "—"} · {timeframe}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching || !asset} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Atualizar</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!asset && <p className="text-sm text-muted-foreground">Selecione um ativo disponível para análise.</p>}
        {asset && message && <p className="text-sm text-muted-foreground">{message}</p>}
        {asset && !message && !result && (
          <p className="text-sm text-muted-foreground">Calculando confluência de tendência, RSI e padrões…</p>
        )}

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <div
                className={`flex items-center gap-2 rounded-xl px-4 py-2 font-display text-lg font-bold ${
                  direction === "CALL"
                    ? "bg-call/15 text-call"
                    : direction === "PUT"
                      ? "bg-put/15 text-put"
                      : "bg-surface text-muted-foreground"
                }`}
              >
                {direction === "CALL" ? (
                  <ArrowUp className="h-5 w-5" />
                ) : direction === "PUT" ? (
                  <ArrowDown className="h-5 w-5" />
                ) : (
                  <Minus className="h-5 w-5" />
                )}
                {direction ?? "AGUARDAR"}
              </div>
              <div>
                <p className="font-mono text-2xl font-bold text-foreground">{result.confidence}%</p>
                <p className="text-xs text-muted-foreground">confiança da confluência</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary" className="font-mono">
                  RSI {result.metrics.rsi?.toFixed(1) ?? "—"}
                </Badge>
                <Badge variant="secondary">
                  {timeframe}: {trendLabel(result.metrics.trend)}
                </Badge>
                <Badge variant="secondary" className="gap-1">
                  <Layers className="h-3 w-3" />
                  {result.higherTimeframe}: {trendLabel(result.metrics.higherTrend)}
                </Badge>
                {result.entryPrice != null && (
                  <Badge variant="secondary" className="font-mono">
                    Preço {result.entryPrice.toFixed(5)}
                  </Badge>
                )}
                {direction && (
                  <Badge variant="secondary">Expiração {result.expirationMinutes} min</Badge>
                )}
              </div>
            </div>

            <p className="text-sm text-foreground">{result.summary}</p>

            {result.reasons.length > 0 && (
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                {result.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    {reason}
                  </li>
                ))}
              </ul>
            )}

            {result.warnings.length > 0 && (
              <ul className="space-y-1.5 text-xs text-muted-foreground/80">
                {result.warnings.map((warning) => (
                  <li key={warning} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                    {warning}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
