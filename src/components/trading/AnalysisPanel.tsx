import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Gauge,
  Layers,
  Minus,
  RefreshCw,
  Sparkles,
  Timer,
  Waves,
} from "lucide-react";
import chartTexture from "@/assets/card-texture.jpg";
import flowTexture from "@/assets/card-flow.jpg";
import { StrengthGauge } from "@/components/trading/StrengthGauge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { analyzeAsset } from "@/lib/analysis/analysis.functions";
import { deepseekVerdict } from "@/lib/analysis/deepseek.functions";
import { fuseDominanceWithIndicators } from "@/lib/analysis/candleDominance";
import { secondsToNextCandle } from "@/lib/analysis/tick";
import { getIqOptionName, timeframeSeconds } from "@/lib/iqoption/mapping";
import { useIqOptionStream } from "@/lib/iqoption/useIqOptionStream";


interface Props {
  symbol: string | null;
  timeframe: string;
}

const trendLabel = (t: string) => (t === "up" ? "Alta" : t === "down" ? "Baixa" : "Lateral");

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function ageLabel(updatedAt: number | undefined, now: number) {
  if (!updatedAt) return "aguardando quotes";
  const age = Math.max(0, now - updatedAt);
  if (age < 1_000) return "agora";
  return `há ${Math.floor(age / 1_000)}s`;
}

export function AnalysisPanel({ symbol, timeframe }: Props) {
  const asset = getIqOptionName(symbol);
  const run = useServerFn(analyzeAsset);
  const { tickAnalysis, liveDominance, closedDominance, isLive, status } = useIqOptionStream(symbol, timeframe);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["analysis", asset, timeframe],
    queryFn: () => {
      if (!asset) return Promise.resolve({ result: null, error: "Selecione um ativo disponível." });
      return run({ data: { asset, timeframe: timeframe as "M1" | "M5" | "M15" } });
    },
    enabled: !!asset,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const result = data?.result ?? null;
  const message = data?.error ?? (error ? "Análise indisponível." : null);
  const direction = result?.direction;
  const fused = useMemo(
    () =>
      closedDominance
        ? fuseDominanceWithIndicators(closedDominance, {
            direction: result?.direction,
            confidence: result?.confidence,
            trend: result?.metrics.trend,
            higherTrend: result?.metrics.higherTrend,
            rsi: result?.metrics.rsi,
          })
        : null,
    [closedDominance, result],
  );
  const tickDirection = fused?.direction ?? tickAnalysis?.bias;
  const tickConfidence = fused?.confidence ?? tickAnalysis?.confidence;
  const countdown = secondsToNextCandle(now, timeframeSeconds(timeframe));
  const tickStrength = tickAnalysis?.windows[0]?.strength ?? 0;

  const dom = closedDominance ?? liveDominance;
  const domSigned = dom ? (dom.dominant === "PUT" ? -dom.dominancePct : dom.dominant === "CALL" ? dom.dominancePct : 0) : 0;
  const tickRate = tickAnalysis?.hft.tickRate ?? 0;

  // ---- DeepSeek final verdict: only for entries above 80% ----
  const finalDirection = (fused?.direction ?? result?.direction) as "CALL" | "PUT" | null | undefined;
  const finalConfidence = Math.max(fused?.confidence ?? 0, result?.confidence ?? 0);
  const qualifies = !!asset && !!finalDirection && finalConfidence >= 80;
  const verdictKey = closedDominance?.candleTime ?? result?.generatedAt ?? "n/a";

  const askDeepseek = useServerFn(deepseekVerdict);
  const { data: aiData, isFetching: aiLoading } = useQuery({
    queryKey: ["deepseek", asset, timeframe, finalDirection, verdictKey],
    queryFn: () =>
      askDeepseek({
        data: {
          asset: asset!,
          timeframe,
          direction: finalDirection as "CALL" | "PUT",
          confidence: finalConfidence,
          indicators: {
            tendencia: result?.metrics.trend,
            tendencia_superior: result?.metrics.higherTrend,
            timeframe_superior: result?.higherTimeframe,
            rsi: result?.metrics.rsi,
            atr: result?.metrics.atr,
            padroes: result?.metrics.patterns,
            preco_entrada: result?.entryPrice,
            expiracao_min: result?.expirationMinutes,
            confluencia_local: result?.confidence,
            razoes: result?.reasons,
            avisos: result?.warnings,
            hft: tickAnalysis?.hft,
            janelas_pressao: tickAnalysis?.windows,
            poc: tickAnalysis?.poc,
            ticks: tickAnalysis?.tickCount,
            dominancia_vela: closedDominance ?? liveDominance,
            fusao: fused,
          },
        },
      }),
    enabled: qualifies,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const ai = aiData?.verdict ?? null;
  const aiError = aiData?.error ?? null;



  return (
    <Card className="relative overflow-hidden border-border/50 glass-panel">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-[0.16]"
        style={{ backgroundImage: `url(${flowTexture})` }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/15 via-transparent to-accent/10" />
      <CardHeader className="relative flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Sparkles className="h-4 w-4 text-accent" /> Análise para a próxima vela — {symbol ?? "—"} · {timeframe}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching || !asset} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Atualizar</span>
        </Button>
      </CardHeader>
      <CardContent className="relative space-y-4">
        {!asset && <p className="text-sm text-muted-foreground">Selecione um ativo disponível para análise.</p>}

        {asset && (
          <section
            className="relative overflow-hidden rounded-xl border border-primary/25 p-4 shadow-card"
            aria-label="Análise de tick para a próxima vela"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-[0.12]"
              style={{ backgroundImage: `url(${chartTexture})` }}
            />
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-primary/20 via-surface/40 to-accent/10" />
            <div className="relative space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Activity className="h-4 w-4 text-primary" /> Fluxo em tempo real
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Entrada avaliada para a próxima vela de {timeframe}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="gap-1 font-mono">
                  <Timer className="h-3 w-3" /> {formatCountdown(countdown)}
                </Badge>
                <Badge variant={isLive ? "default" : "secondary"} className="gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "bg-primary-foreground animate-pulse-glow" : "bg-muted-foreground"}`} />
                  {isLive ? "ticks ao vivo" : status === "connecting" ? "conectando" : "aguardando dados"}
                </Badge>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,260px)_1fr] lg:items-center">
              <div className="space-y-3 rounded-xl border border-border/50 bg-surface/60 p-4 backdrop-blur-sm">
                <div
                  className={`flex items-center justify-center gap-2 rounded-lg px-4 py-3 font-display text-xl font-bold ${
                    tickDirection === "CALL"
                      ? "bg-call/15 text-call"
                      : tickDirection === "PUT"
                        ? "bg-put/15 text-put"
                        : "bg-surface-elevated text-muted-foreground"
                  }`}
                >
                  {tickDirection === "CALL" ? <ArrowUp className="h-5 w-5" /> : tickDirection === "PUT" ? <ArrowDown className="h-5 w-5" /> : <Minus className="h-5 w-5" />}
                  {tickDirection ?? "AGUARDAR"}
                </div>
                <StrengthGauge
                  value={tickConfidence ?? 0}
                  label="Confiança da entrada"
                  caption={ageLabel(tickAnalysis?.updatedAt, now)}
                  size={168}
                />
                <div className="grid grid-cols-2 gap-2 text-center text-[11px]">
                  <div className="rounded-md bg-surface/70 px-2 py-1.5">
                    <p className="text-muted-foreground">Ticks</p>
                    <p className="font-mono font-bold text-foreground">{tickAnalysis?.tickCount ?? "—"}</p>
                  </div>
                  <div className="rounded-md bg-surface/70 px-2 py-1.5">
                    <p className="text-muted-foreground">Vol. micro</p>
                    <p className="font-mono font-bold text-foreground">{tickAnalysis ? `${tickAnalysis.hft.microVolBps.toFixed(2)} bps` : "—"}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/50 bg-surface/40 p-3 backdrop-blur-sm sm:grid-cols-3 xl:grid-cols-5">
                <StrengthGauge signed value={tickAnalysis?.windows[0]?.strength ?? 0} label="Pressão 3s" caption="micro fluxo" size={112} />
                <StrengthGauge signed value={tickAnalysis?.windows[1]?.strength ?? 0} label="Pressão 15s" caption="curto prazo" size={112} />
                <StrengthGauge signed value={tickAnalysis?.windows[2]?.strength ?? 0} label="Pressão 60s" caption="tempo maior" size={112} />
                <StrengthGauge
                  value={Math.min(100, (tickRate / 8) * 100)}
                  label="Velocidade HFT"
                  caption={`${tickAnalysis?.hft.acceleration.toFixed(1) ?? "0.0"}× ritmo`}
                  display={`${tickRate.toFixed(1)}/s`}
                  size={112}
                />
                <StrengthGauge
                  signed
                  value={domSigned}
                  label={closedDominance ? "Dominância fechada" : "Dominância viva"}
                  caption={`${dom?.callSamples ?? 0} CALL · ${dom?.putSamples ?? 0} PUT`}
                  size={112}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border/50 bg-surface/60 p-3 text-xs backdrop-blur-sm">
                <p className="flex items-center gap-1 font-medium text-muted-foreground"><Gauge className="h-3.5 w-3.5" /> HFT / microestrutura</p>
                <p className="mt-1.5 font-mono text-foreground">{tickRate.toFixed(1)} ticks/s · {tickAnalysis?.hft.acceleration.toFixed(1) ?? "—"}× ritmo</p>
                <p className="text-muted-foreground">Streak {tickAnalysis && tickAnalysis.hft.streak > 0 ? "+" : ""}{tickAnalysis?.hft.streak ?? 0} · agressão {tickAnalysis?.hft.aggression ?? 0}%</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-surface/60 p-3 text-xs backdrop-blur-sm">
                <p className="flex items-center gap-1 font-medium text-muted-foreground"><Waves className="h-3.5 w-3.5" /> Dominância da vela</p>
                <p className="mt-1.5 font-mono text-foreground">{dom?.dominant ?? "AGUARDAR"} · {dom?.dominancePct ?? 0}%</p>
                <p className="text-muted-foreground">média {dom?.avgTickRate ?? 0} t/s · pico {dom?.peakTickRate ?? 0} · força {dom?.netStrength ?? 0}%</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-surface/60 p-3 text-xs backdrop-blur-sm">
                <p className="flex items-center gap-1 font-medium text-muted-foreground"><Layers className="h-3.5 w-3.5" /> POC / valor</p>
                <p className="mt-1.5 font-mono text-foreground">POC {tickAnalysis?.poc.poc?.toFixed(5) ?? "—"}</p>
                <p className="text-muted-foreground">{tickAnalysis?.poc.insideValueArea ? "Dentro" : "Fora"} da área · {tickAnalysis?.poc.distanceBps.toFixed(1) ?? "—"} bps</p>
              </div>
            </div>

            {closedDominance && (
              <p className="text-xs text-muted-foreground">
                {fused?.agreement === "confluente" ? "HFT e indicadores confirmados" : fused?.agreement === "divergente" ? "HFT divergiu dos indicadores" : "Confluência parcial"} · entrada definida para a próxima vela.
              </p>
            )}


            {fused && (
              <div className="space-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground">
                {fused.reasons.slice(0, 2).map((reason) => <p key={reason}>{reason}</p>)}
                {fused.warnings.slice(0, 2).map((warning) => <p key={warning}>{warning}</p>)}
              </div>
            )}
            {!fused && tickAnalysis && tickAnalysis.warnings.length > 0 && (
              <p className="text-xs text-muted-foreground">{tickAnalysis.warnings[0]}</p>
            )}
            </div>
          </section>
        )}

        {asset && message && <p className="text-sm text-muted-foreground">{message}</p>}
        {asset && !message && !result && (
          <p className="text-sm text-muted-foreground">Calculando tendência, RSI, padrões de candle e confirmação multi-timeframe…</p>
        )}

        {result && (
          <section className="space-y-4 border-t border-border/50 pt-4" aria-label="Análise técnica de candles">
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
                {direction === "CALL" ? <ArrowUp className="h-5 w-5" /> : direction === "PUT" ? <ArrowDown className="h-5 w-5" /> : <Minus className="h-5 w-5" />}
                {direction ?? "AGUARDAR"}
              </div>
              <div>
                <p className="font-mono text-2xl font-bold text-foreground">{result.confidence}%</p>
                <p className="text-xs text-muted-foreground">confiança da confluência</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary" className="font-mono">RSI {result.metrics.rsi?.toFixed(1) ?? "—"}</Badge>
                <Badge variant="secondary">{timeframe}: {trendLabel(result.metrics.trend)}</Badge>
                <Badge variant="secondary" className="gap-1"><Layers className="h-3 w-3" />{result.higherTimeframe}: {trendLabel(result.metrics.higherTrend)}</Badge>
                {result.entryPrice != null && <Badge variant="secondary" className="font-mono">Preço {result.entryPrice.toFixed(5)}</Badge>}
                {direction && <Badge variant="secondary">Expiração {result.expirationMinutes} min</Badge>}
              </div>
            </div>

            <p className="text-sm text-foreground">{result.summary}</p>

            {result.reasons.length > 0 && (
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                {result.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />{reason}</li>
                ))}
              </ul>
            )}

            {result.warnings.length > 0 && (
              <ul className="space-y-1.5 text-xs text-muted-foreground/80">
                {result.warnings.map((warning) => (
                  <li key={warning} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />{warning}</li>
                ))}
              </ul>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
