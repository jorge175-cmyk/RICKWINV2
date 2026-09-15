import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeframeSelector } from "@/components/trading/TimeframeSelector";
import { MirrorMatchCard } from "@/components/trading/MirrorMatchCard";
import { getOtcAssets } from "@/lib/iqoption/candles.functions";
import { scanAllMirrors, type MirrorAssetGroup, type MirrorScanResult } from "@/lib/analysis/mirror.functions";
import { mirrorVerdict, type MirrorVerdict } from "@/lib/analysis/mirrorVerdict.functions";
import { toast } from "sonner";
import { ArrowLeft, Copy, Loader2, Search, Sparkles } from "lucide-react";

const FALLBACK_ASSETS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CHF", "USD/CAD"];

export const Route = createFileRoute("/_layout/mirror")({
  component: MirrorPage,
  head: () => ({
    title: "Espelho OTC — detector de gráficos repetidos | BinaryPulse",
    meta: [
      {
        name: "description",
        content:
          "Varre todos os ativos OTC e de mercado real da corretora para descobrir se algum gráfico ao vivo está repetindo um trecho antigo, de outro ativo ou espelhado.",
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

function MirrorPage() {
  const [timeframe, setTimeframe] = useState("M1");
  const [windowSize, setWindowSize] = useState(24);
  const [batchSize, setBatchSize] = useState(14);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<MirrorScanResult | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, MirrorVerdict>>({});
  const [pendingVerdict, setPendingVerdict] = useState<string | null>(null);

  const { data: otcAssets = [] } = useQuery({
    queryKey: ["otcAssets"],
    queryFn: () => getOtcAssets(),
    staleTime: 30 * 60 * 1000,
  });

  /** Catálogo completo: OTC primeiro (onde a repetição é mais comum). */
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

  const scan = useMutation({
    mutationFn: async (startAt: number) => {
      if (allAssets.length === 0) throw new Error("Catálogo de ativos ainda carregando.");
      return scanAllMirrors({
        data: {
          timeframe: timeframe as "M1" | "M5" | "M15",
          windowSize,
          assets: allAssets.slice(0, 400),
          maxAssets: batchSize,
          offset: startAt,
          historyBlocks: 4,
          minCorrelation: 0.93,
        },
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setVerdicts({});
      setOffset(data.nextOffset ?? 0);
      if (data.error) toast.error(data.error);
      else if (data.groups.length === 0) toast.info("Nenhuma repetição encontrada neste lote de ativos.");
      else toast.success(`${data.groups.length} ativo(s) com repetição encontrada.`);
    },
    onError: () => toast.error("Falha ao executar a varredura."),
  });

  const askAi = useMutation({
    mutationFn: async (group: MirrorAssetGroup) => {
      setPendingVerdict(group.liveAsset);
      return mirrorVerdict({
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
          })),
          consensus: group.consensus,
        },
      });
    },
    onSuccess: (data, group) => {
      setPendingVerdict(null);
      if (data.verdict) setVerdicts((prev) => ({ ...prev, [group.liveAsset]: data.verdict! }));
      if (data.error) toast.error(data.error);
    },
    onError: () => {
      setPendingVerdict(null);
      toast.error("Falha ao consultar a IA.");
    },
  });

  const scannedRange = result
    ? `${Math.max(result.nextOffset ?? result.totalAssets, 0)} de ${result.totalAssets}`
    : null;

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
          <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <Link to="/trading">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Análises</span>
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold">Detector de gráficos repetidos</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Varre todos os ativos da corretora sem precisar escolher um: baixa o histórico de cada um e cruza o
            trecho atual de todos contra todos — mesmo ativo em outra data, outro ativo, lido de trás pra frente
            ou invertido de cima pra baixo. Onde encontra repetição, mostra qual seria a próxima vela.
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
                    onClick={() => setWindowSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Ativos por rodada</label>
              <div className="flex gap-1.5">
                {[8, 14, 24].map((size) => (
                  <Button
                    key={size}
                    variant={batchSize === size ? "default" : "outline"}
                    size="sm"
                    onClick={() => setBatchSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-1 flex-wrap items-end justify-end gap-2">
              <Button
                className="gap-2"
                onClick={() => {
                  setOffset(0);
                  scan.mutate(0);
                }}
                disabled={scan.isPending || allAssets.length === 0}
              >
                {scan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {scan.isPending ? "Varrendo…" : "Varrer todos os ativos"}
              </Button>
              {result?.nextOffset != null && !scan.isPending && (
                <Button variant="outline" onClick={() => scan.mutate(offset)}>
                  Continuar do ativo {offset + 1}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {scan.isPending && (
          <p className="text-sm text-muted-foreground">
            Baixando histórico de {batchSize} ativos em {timeframe} e cruzando todos contra todos nas quatro
            leituras. Isso pode levar cerca de um minuto.
          </p>
        )}

        {result && !scan.isPending && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <Badge variant="secondary">{result.scannedAssets} ativos varridos</Badge>
              <Badge variant="secondary">{result.scannedCandles.toLocaleString("pt-BR")} velas comparadas</Badge>
              {scannedRange && <Badge variant="outline">Catálogo: {scannedRange}</Badge>}
              {result.skippedAssets.length > 0 && (
                <span>{result.skippedAssets.length} ativo(s) sem histórico suficiente</span>
              )}
            </div>

            {result.groups.length === 0 ? (
              <Card className="border-border/50 bg-surface/40">
                <CardContent className="space-y-2 p-6 text-center">
                  <p className="font-display text-sm font-semibold">Nenhuma repetição encontrada neste lote</p>
                  <p className="text-xs text-muted-foreground">
                    {result.error ??
                      "Nenhum ativo deste lote está repetindo um trecho conhecido. Continue a varredura no resto do catálogo ou tente outro timeframe."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              result.groups.map((group) => {
                const verdict = verdicts[group.liveAsset];
                const loading = askAi.isPending && pendingVerdict === group.liveAsset;
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
                            onClick={() => askAi.mutate(group)}
                            disabled={askAi.isPending}
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
                            {verdict.reasoning && (
                              <p className="text-sm text-muted-foreground">{verdict.reasoning}</p>
                            )}
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
              })
            )}
          </div>
        )}
      </main>
    </div>
  );
}
