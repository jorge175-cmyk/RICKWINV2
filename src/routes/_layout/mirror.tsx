import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { TimeframeSelector } from "@/components/trading/TimeframeSelector";
import { MirrorMatchCard } from "@/components/trading/MirrorMatchCard";
import { getOtcAssets } from "@/lib/iqoption/candles.functions";
import { mirrorScanChunk, type MirrorAssetGroup } from "@/lib/analysis/mirror.functions";
import { mirrorVerdict, type MirrorVerdict } from "@/lib/analysis/mirrorVerdict.functions";
import { useIqOptionConnection } from "@/lib/iqoption/useIqOptionStream";
import { PREVIEW_STREAM_MESSAGE, isPreviewRuntime } from "@/lib/iqoption/iqOptionClient";

import { toast } from "sonner";
import { ArrowLeft, Copy, Loader2, Search, Sparkles, StopCircle, Wifi, WifiOff } from "lucide-react";

const FALLBACK_ASSETS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CHF", "USD/CAD"];
/** Lotes pequenos: os contadores da tela atualizam a cada poucos segundos. */
const CHUNK = 4;

export const Route = createFileRoute("/_layout/mirror")({
  component: MirrorPage,
  head: () => ({
    title: "Espelho OTC — detector de gráficos repetidos | BinaryPulse",
    meta: [
      {
        name: "description",
        content:
          "Varre todos os ativos OTC e de mercado real da corretora de uma vez para descobrir se algum gráfico ao vivo está repetindo um trecho antigo, de outro ativo ou espelhado.",
      },
      { property: "og:title", content: "Espelho OTC — detector de gráficos repetidos" },
      {
        property: "og:description",
        content:
          "Varredura global de histórico com IA para identificar repetições de gráfico e projetar a próxima vela.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

const VERDICT_LABEL: Record<MirrorVerdict["verdict"], string> = {
  REPETICAO_CONFIRMADA: "Repetição confirmada",
  PROVAVEL_COINCIDENCIA: "Provável coincidência",
  SEM_REPETICAO: "Sem repetição",
};

type Phase = "idle" | "collect" | "match" | "done";

function MirrorPage() {
  const [timeframe, setTimeframe] = useState("M1");
  const [windowSize, setWindowSize] = useState(24);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** `null` = o primeiro lote de histórico ainda não voltou do servidor. */
  const [stored, setStored] = useState<{ assets: number; candles: number } | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [groups, setGroups] = useState<MirrorAssetGroup[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, MirrorVerdict>>({});
  const [pendingVerdict, setPendingVerdict] = useState<string | null>(null);
  const cancelRef = useRef(false);
  /** O canal ao vivo só abre quando a varredura começa. */
  const [streamOn, setStreamOn] = useState(false);
  const { status: connectionStatus, error: connectionError } = useIqOptionConnection(streamOn);

  const { data: otcAssets = [] } = useQuery({
    queryKey: ["otcAssets"],
    queryFn: () => getOtcAssets(),
    staleTime: 30 * 60 * 1000,
  });

  /** Catálogo completo da corretora: OTC primeiro, onde a repetição é comum. */
  const allAssets = useMemo(() => {
    const merged = new Map<string, { symbol: string; category: string }>();
    for (const a of otcAssets) {
      merged.set(a.symbol.toUpperCase(), { symbol: a.symbol, category: a.category });
    }
    for (const symbol of FALLBACK_ASSETS) {
      const key = symbol.toUpperCase();
      if (!merged.has(key)) merged.set(key, { symbol, category: "MERCADO REAL" });
    }
    return [...merged.values()]
      .sort((a, b) =>
        a.category === b.category ? a.symbol.localeCompare(b.symbol) : a.category === "OTC" ? -1 : 1,
      )
      .map((a) => a.symbol);
  }, [otcAssets]);

  const running = phase === "collect" || phase === "match";

  /** Varre o catálogo inteiro: coleta o histórico de todos e cruza todos contra todos. */
  const runFullScan = async () => {
    if (allAssets.length === 0) {
      toast.error("Catálogo de ativos ainda carregando.");
      return;
    }
    cancelRef.current = false;
    setStreamOn(true);
    setGroups([]);
    setVerdicts({});
    setSkipped(0);
    let skippedTotal = 0;

    for (const stage of ["collect", "match"] as const) {
      setPhase(stage);
      let offset = 0;
      let total = allAssets.length;
      setProgress({ done: 0, total });
      while (!cancelRef.current) {
        const chunk = await mirrorScanChunk({
          data: {
            timeframe: timeframe as "M1" | "M5" | "M15",
            windowSize,
            assets: allAssets.slice(0, 600),
            offset,
            limit: CHUNK,
            historyBlocks: 2,
            minCorrelation: 0.93,
            phase: stage,
          },
        });

        total = chunk.totalAssets;
        setStored({ assets: chunk.storedAssets, candles: chunk.storedCandles });
        if (stage === "collect") {
          skippedTotal += chunk.skippedAssets.length;
          setSkipped(skippedTotal);
        }
        if (chunk.groups.length > 0) {
          setGroups((prev) =>
            [...prev, ...chunk.groups].sort(
              (a, b) => (b.matches[0]?.correlation ?? 0) - (a.matches[0]?.correlation ?? 0),
            ),
          );
        }
        if (chunk.error) toast.error(chunk.error);

        const next = chunk.nextOffset;
        setProgress({ done: next ?? total, total });
        if (next == null) break;
        offset = next;
      }
      if (cancelRef.current) break;
    }

    setPhase(cancelRef.current ? "idle" : "done");
    if (!cancelRef.current) toast.success("Varredura concluída.");
  };

  const askAi = async (group: MirrorAssetGroup) => {
    setPendingVerdict(group.liveAsset);
    try {
      const data = await mirrorVerdict({
        data: {
          asset: group.liveAsset,
          timeframe,
          liveWindow: group.liveWindow,
          matches: group.matches.map((m) => ({
            asset: m.asset,
            transform: m.transform,
            similarity: m.similarity,
            startTime: m.startTime,
            endTime: m.endTime,
            volatilityRatio: m.volatilityRatio,
            predictedReturn: m.predictedReturn,
            direction: m.direction,
            window: m.window,
            nextCandle: m.nextCandle,
            projection: m.projection.map((s) => ({
              step: s.step,
              time: s.time,
              ret: s.ret,
              direction: s.direction,
              close: s.close,
            })),
          })),
          consensus: group.consensus,
        },
      });
      if (data.verdict) setVerdicts((prev) => ({ ...prev, [group.liveAsset]: data.verdict! }));
      if (data.error) toast.error(data.error);
    } catch {
      toast.error("Falha ao consultar a IA.");
    } finally {
      setPendingVerdict(null);
    }
  };

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/20">
              <Copy className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight">Espelho OTC</span>
          </div>
          <div className="flex items-center gap-3">
            {connectionStatus === "live" ? (
              <Badge
                variant="outline"
                className="gap-1.5 border-call/40 bg-call/10 text-call"
                title="Recebendo dados ao vivo da corretora"
              >
                <Wifi className="h-3.5 w-3.5" />
                Conectado
              </Badge>
            ) : !streamOn ? (
              <Badge
                variant="outline"
                className="gap-1.5 border-border/60 bg-muted/30 text-muted-foreground"
                title="A conexão é aberta somente ao iniciar a varredura"
              >
                <WifiOff className="h-3.5 w-3.5" />
                Aguardando varredura
              </Badge>
            ) : connectionStatus === "polling" && isPreviewRuntime() ? (
              <Badge
                variant="outline"
                className="gap-1.5 border-amber-400/40 bg-amber-400/10 text-amber-300"
                title={PREVIEW_STREAM_MESSAGE}
              >
                <WifiOff className="h-3.5 w-3.5" />
                Preview — histórico
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1.5 border-put/40 bg-put/10 text-put"
                title={connectionError ?? "Sem canal ao vivo com a corretora"}
              >
                <WifiOff className="h-3.5 w-3.5" />
                {connectionStatus === "connecting"
                  ? "Conectando…"
                  : connectionStatus === "polling"
                    ? "Sem streaming"
                    : "Desconectado"}
              </Badge>
            )}

            <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
              <Link to="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Início</span>
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold">Detector de gráficos repetidos</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Varre os {allAssets.length || "—"} ativos da corretora de uma vez: baixa o histórico de cada um e
            cruza o trecho atual de todos contra o passado de todos — mesmo ativo em outra data, outro ativo,
            lido de trás pra frente ou invertido de cima pra baixo. Onde encontra repetição, mostra qual seria
            a próxima vela.
          </p>
        </div>

        <Card className="border-border/50 glass-panel">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Timeframe</label>
              <TimeframeSelector value={timeframe} onChange={setTimeframe} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Velas comparadas</label>
              <div className="flex gap-1.5">
                {[16, 24, 40].map((size) => (
                  <Button
                    key={size}
                    variant={windowSize === size ? "default" : "outline"}
                    size="sm"
                    disabled={running}
                    onClick={() => setWindowSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-1 flex-wrap items-end justify-end gap-2">
              <Button className="gap-2" onClick={() => void runFullScan()} disabled={running || allAssets.length === 0}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {running ? "Varrendo…" : `Varrer todos os ${allAssets.length || ""} ativos`}
              </Button>
              {running && (
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                >
                  <StopCircle className="h-4 w-4" /> Parar
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {(running || phase === "done") && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <Badge variant="secondary">
                {phase === "collect"
                  ? "Etapa 1 de 2 — baixando histórico"
                  : phase === "match"
                    ? "Etapa 2 de 2 — cruzando todos contra todos"
                    : "Varredura concluída"}
              </Badge>
              <span>
                {progress.done} de {progress.total} ativos
              </span>
              <Badge variant="secondary">{stored.assets} ativos com histórico</Badge>
              <Badge variant="secondary">{stored.candles.toLocaleString("pt-BR")} velas na memória</Badge>
              {skipped > 0 && <span>{skipped} ativo(s) sem histórico suficiente</span>}
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )}

        {phase === "done" && groups.length === 0 && (
          <Card className="border-border/50 bg-surface/40">
            <CardContent className="space-y-2 p-6 text-center">
              <p className="font-display text-sm font-semibold">Nenhuma repetição encontrada</p>
              <p className="text-xs text-muted-foreground">
                Nenhum ativo está repetindo um trecho conhecido agora. Tente outro timeframe ou menos velas
                comparadas, e repita em instantes.
              </p>
            </CardContent>
          </Card>
        )}

        {groups.map((group) => {
          const verdict = verdicts[group.liveAsset];
          const loading = pendingVerdict === group.liveAsset;
          return (
            <section key={group.liveAsset} className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-display text-lg font-bold">{group.liveAsset}</h2>
                <Badge variant="secondary">{group.matches.length} coincidência(s)</Badge>
                {group.consensus.direction && (
                  <Badge
                    variant="outline"
                    className={group.consensus.direction === "CALL" ? "text-call" : "text-put"}
                  >
                    Consenso: {group.consensus.direction === "CALL" ? "COMPRA" : "VENDA"} (
                    {group.consensus.agreement}%)
                  </Badge>
                )}
              </div>

              <div className="grid gap-4">
                {group.matches.map((match) => (
                  <MirrorMatchCard
                    key={`${group.liveAsset}-${match.asset}-${match.transform}-${match.startTime}`}
                    match={match}
                    liveWindow={group.liveWindow}
                  />
                ))}
              </div>

              <Card className="border-border/50 glass-panel">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Sparkles className="h-4 w-4" /> Veredito final — IA · {group.liveAsset}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!verdict && (
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => void askAi(group)}
                      disabled={pendingVerdict != null}
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      {loading ? "Analisando…" : "Validar com IA"}
                    </Button>
                  )}
                  {verdict && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge variant="secondary">{VERDICT_LABEL[verdict.verdict]}</Badge>
                        {verdict.direction && (
                          <span
                            className={`font-display text-lg font-bold ${verdict.direction === "CALL" ? "text-call" : "text-put"}`}
                          >
                            {verdict.direction === "CALL" ? "COMPRA" : "VENDA"} · {verdict.confidence}%
                          </span>
                        )}
                      </div>
                      {verdict.reasoning && <p className="text-sm text-muted-foreground">{verdict.reasoning}</p>}
                      {verdict.risks.length > 0 && (
                        <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                          {verdict.risks.map((risk) => (
                            <li key={risk}>{risk}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          );
        })}
      </main>
    </div>
  );
}
