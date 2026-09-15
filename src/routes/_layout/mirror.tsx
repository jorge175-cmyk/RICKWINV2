import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AssetSelector } from "@/components/trading/AssetSelector";
import { TimeframeSelector } from "@/components/trading/TimeframeSelector";
import { MirrorMatchCard } from "@/components/trading/MirrorMatchCard";
import { getOtcAssets } from "@/lib/iqoption/candles.functions";
import { findMirrorMatches, type MirrorSearchResult } from "@/lib/analysis/mirror.functions";
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
          "Descubra se o mercado OTC ao vivo está repetindo um trecho de gráfico antigo, de outro ativo ou espelhado, e veja a próxima vela dessa sequência.",
      },
      { property: "og:title", content: "Espelho OTC — detector de gráficos repetidos" },
      {
        property: "og:description",
        content:
          "Varredura de histórico com IA para identificar repetições de gráfico no OTC e projetar a próxima vela.",
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
  const [asset, setAsset] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState("M1");
  const [windowSize, setWindowSize] = useState(24);
  const [result, setResult] = useState<MirrorSearchResult | null>(null);
  const [verdict, setVerdict] = useState<MirrorVerdict | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);

  const { data: otcAssets = [] } = useQuery({
    queryKey: ["otcAssets"],
    queryFn: () => getOtcAssets(),
    staleTime: 30 * 60 * 1000,
  });

  const assetOptions = useMemo(() => {
    const merged = new Map<string, { symbol: string; name: string | null; category: string }>();
    for (const symbol of FALLBACK_ASSETS) {
      merged.set(symbol.toUpperCase(), { symbol, name: null, category: "MERCADO REAL" });
    }
    for (const a of otcAssets) {
      const key = a.symbol.toUpperCase();
      if (merged.has(key)) continue;
      merged.set(key, { symbol: a.symbol, name: a.name, category: a.category });
    }
    return [...merged.values()].sort((a, b) =>
      a.category === b.category
        ? a.symbol.localeCompare(b.symbol)
        : a.category === "OTC"
          ? -1
          : 1,
    );
  }, [otcAssets]);

  const activeAsset =
    asset ??
    assetOptions.find((a) => /^EUR\/?USD-?OTC$/i.test(a.symbol.trim()))?.symbol ??
    assetOptions[0]?.symbol ??
    null;

  /** Candidatos: o próprio ativo mais os ativos mais próximos da mesma categoria. */
  const candidates = useMemo(() => {
    if (!activeAsset) return [];
    const same = assetOptions.filter((a) => a.symbol !== activeAsset);
    return same.slice(0, 11).map((a) => a.symbol);
  }, [assetOptions, activeAsset]);

  const search = useMutation({
    mutationFn: async () => {
      if (!activeAsset) throw new Error("Selecione um ativo.");
      return findMirrorMatches({
        data: {
          asset: activeAsset,
          timeframe: timeframe as "M1" | "M5" | "M15",
          windowSize,
          assets: candidates,
          historyBlocks: 6,
          minCorrelation: 0.93,
        },
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setVerdict(null);
      setVerdictError(null);
      if (data.error) toast.error(data.error);
      else if (data.matches.length === 0) toast.info("Nenhuma repetição relevante encontrada.");
      else toast.success(`${data.matches.length} coincidência(s) encontrada(s).`);
    },
    onError: () => toast.error("Falha ao executar a varredura."),
  });

  const askAi = useMutation({
    mutationFn: async () => {
      if (!result || !activeAsset) throw new Error("Rode a varredura primeiro.");
      return mirrorVerdict({
        data: {
          asset: activeAsset,
          timeframe,
          liveWindow: result.liveWindow,
          matches: result.matches.map((m) => ({
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
          consensus: result.consensus,
        },
      });
    },
    onSuccess: (data) => {
      setVerdict(data.verdict);
      setVerdictError(data.error ?? null);
      if (data.error) toast.error(data.error);
    },
    onError: () => toast.error("Falha ao consultar a IA."),
  });

  const consensus = result?.consensus;

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
            Compara o trecho atual do ativo com todo o histórico disponível — do mesmo ativo em outra data, de
            outros ativos, e também lido de trás pra frente ou invertido de cima pra baixo. Quando encontra uma
            repetição, mostra qual seria a próxima vela dessa sequência.
          </p>
        </div>

        <Card className="border-border/50 glass-panel">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Ativo ao vivo</label>
              {activeAsset && (
                <AssetSelector
                  assets={assetOptions}
                  value={activeAsset}
                  onChange={setAsset}
                  className="sm:w-full"
                />
              )}
            </div>
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
            <Button
              className="gap-2"
              onClick={() => search.mutate()}
              disabled={search.isPending || !activeAsset}
            >
              {search.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {search.isPending ? "Procurando…" : "Procurar repetição"}
            </Button>
          </CardContent>
        </Card>

        {search.isPending && (
          <p className="text-sm text-muted-foreground">
            Baixando histórico de {candidates.length + 1} ativos em {timeframe} e comparando as quatro leituras.
            Isso pode levar alguns segundos.
          </p>
        )}

        {result && !search.isPending && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <Badge variant="secondary">{result.scannedAssets} ativos varridos</Badge>
              <Badge variant="secondary">{result.scannedCandles.toLocaleString("pt-BR")} velas comparadas</Badge>
              {consensus?.direction && result.matches.length > 0 && (
                <Badge variant="outline" className={consensus.direction === "CALL" ? "text-call" : "text-put"}>
                  Consenso: {consensus.direction === "CALL" ? "COMPRA" : "VENDA"} ({consensus.agreement}%)
                </Badge>
              )}
              {result.skippedAssets.length > 0 && (
                <span>{result.skippedAssets.length} ativo(s) sem histórico suficiente</span>
              )}
            </div>

            {result.matches.length === 0 ? (
              <Card className="border-border/50 bg-surface/40">
                <CardContent className="space-y-2 p-6 text-center">
                  <p className="font-display text-sm font-semibold">Nenhuma repetição relevante encontrada</p>
                  <p className="text-xs text-muted-foreground">
                    {result.error ??
                      "O trecho atual não coincide com o histórico varrido. Tente outro timeframe, menos velas comparadas ou repita em instantes."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="grid gap-4">
                  {result.matches.map((match) => (
                    <MirrorMatchCard
                      key={`${match.asset}-${match.transform}-${match.startTime}`}
                      match={match}
                      liveWindow={result.liveWindow}
                    />
                  ))}
                </div>

                <Card className="border-border/50 glass-panel">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <Sparkles className="h-4 w-4" /> Veredito final — IA
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {!verdict && (
                      <Button
                        variant="outline"
                        className="gap-2"
                        onClick={() => askAi.mutate()}
                        disabled={askAi.isPending}
                      >
                        {askAi.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        {askAi.isPending ? "Analisando…" : "Validar com IA"}
                      </Button>
                    )}
                    {verdictError && <p className="text-xs text-destructive">{verdictError}</p>}
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
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
