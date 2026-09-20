import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { TimeframeSelector } from "@/components/trading/TimeframeSelector";
import { getOtcAssets } from "@/lib/iqoption/candles.functions";
import {
  mirrorScanChunk,
  getReplayResults,
  type MirrorAssetGroup,
  type MirrorChunkResult,
} from "@/lib/analysis/mirror.functions";
import { consensusOf, type MirrorCandle, type MirrorMatch } from "@/lib/analysis/mirror";
import { backfillArchiveChunk } from "@/lib/iqoption/backfill.functions";
import { mirrorVerdict, type MirrorVerdict } from "@/lib/analysis/mirrorVerdict.functions";
import { ReplayGroupCard } from "@/components/trading/ReplayGroupCard";

import { toast } from "sonner";
import { Archive, ArrowLeft, Copy, Loader2, Search, StopCircle, Wifi, WifiOff } from "lucide-react";

const FALLBACK_ASSETS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CHF", "USD/CAD"];
const CHUNK = 10;
/**
 * Ativos ao vivo comparados por chamada na etapa de cruzamento. O custo de
 * CPU dessa etapa é (ativos aqui) × (ativos NESTA FATIA do palheiro) × (velas
 * por ativo) — ver HAYSTACK_CHUNK abaixo: o catálogo inteiro nunca é lido
 * numa chamada só, então esses dois números juntos é que definem o tamanho
 * de cada chamada, não mais o catálogo inteiro de uma vez (o que chegava a
 * bilhões de operações e o Cloudflare Workers matava por "exceeded CPU time
 * limit", travando a varredura em 0%).
 */
const MATCH_CHUNK = 5;
/**
 * Ativos do catálogo (palheiro) lidos por chamada na etapa de cruzamento. O
 * MESMO lote de ativos ao vivo (MATCH_CHUNK) é reprocessado uma vez por
 * fatia até cobrir o catálogo inteiro — assim a profundidade do histórico
 * (MAX_ARCHIVE_CANDLES no servidor) não precisa ser cortada para caber no
 * limite de CPU: só o catálogo fica espalhado por mais chamadas.
 *
 * Conta aproximada por chamada: MATCH_CHUNK × HAYSTACK_CHUNK × velas-por-
 * ativo × 4 leituras (direta/invertida/espelhada/as duas) × velas-comparadas.
 * Com 5 × 10 × 15.000 × 4 × 40 ≈ 120 milhões de operações — bem abaixo da
 * cena que estourava o limite de CPU (~2,9 bilhões, com lote de 40 ativos
 * contra o catálogo inteiro de uma vez).
 */
const HAYSTACK_CHUNK = 10;
/** Máximo de coincidências mantidas por ativo ao vivo, depois de juntar todas as fatias do palheiro. */
const MAX_MATCHES = 8;

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

type Phase = "idle" | "archive" | "collect" | "match" | "done";

/** Horário local do usuário: é nele que a operação será aberta. */
const CLOCK_FMT = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

function MirrorPage() {
  const [timeframe, setTimeframe] = useState("M1");
  const [windowSize, setWindowSize] = useState(5);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** Progresso das fatias do palheiro (catálogo) DENTRO do lote de ativos ao vivo atual. */
  const [haystackProgress, setHaystackProgress] = useState({ done: 0, total: 0 });
  const [stored, setStored] = useState({ assets: 0, candles: 0 });
  const [skipped, setSkipped] = useState(0);
  const [groups, setGroups] = useState<MirrorAssetGroup[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, MirrorVerdict>>({});
  const [pendingVerdict, setPendingVerdict] = useState<string | null>(null);
  /** Progresso do arquivamento do histórico completo no banco. */
  const [archive, setArchive] = useState({ done: 0, total: 0, candles: 0, complete: 0 });
  const cancelRef = useRef(false);
  /**
   * A varredura não usa o canal ao vivo do navegador: o histórico é buscado no
   * servidor. O aviso reflete, portanto, se a corretora está respondendo às
   * buscas de histórico — e não um WebSocket que esta página nunca abre.
   */
  const [feed, setFeed] = useState<"idle" | "ok" | "error">("idle");

  const { data: otcAssets = [] } = useQuery({
    queryKey: ["otcAssets"],
    queryFn: () => getOtcAssets(),
    staleTime: 30 * 60 * 1000,
  });

  /**
   * Replays já encontrados pelo job em segundo plano — instantâneo, sem
   * rodar varredura nenhuma. Repolling periódico é o que faz essa lista
   * atualizar sozinha conforme o job avança pelo catálogo continuamente.
   */
  const { data: autoResults, dataUpdatedAt: autoResultsFetchedAt } = useQuery({
    queryKey: ["replayResults", timeframe],
    queryFn: () => getReplayResults({ data: { timeframe: timeframe as "M1" | "M5" | "M15" } }),
    refetchInterval: 20_000,
  });
  const autoGroups = autoResults?.groups ?? [];

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
        a.category === b.category
          ? a.symbol.localeCompare(b.symbol)
          : a.category === "OTC"
            ? -1
            : 1,
      )
      .map((a) => a.symbol);
  }, [otcAssets]);

  const running = phase === "collect" || phase === "match";
  const archiving = phase === "archive";
  /** Varredura e arquivamento não podem rodar ao mesmo tempo (competem pela mesma corretora). */
  const busy = running || archiving;

  /** Repetições idênticas sempre no topo da lista. */
  const perfectScore = (g: MirrorAssetGroup) => (g.matches.some((m) => m.exact) ? 1 : 0);

  /** Varre o catálogo inteiro: coleta o histórico de todos e cruza todos contra todos. */
  const runFullScan = async () => {
    if (allAssets.length === 0) {
      toast.error("Catálogo de ativos ainda carregando.");
      return;
    }
    cancelRef.current = false;
    setFeed("ok");
    // Cada varredura começa do zero: nada da anterior fica na tela.
    setGroups([]);
    setVerdicts({});
    setPendingVerdict(null);
    setSkipped(0);
    setStored({ assets: 0, candles: 0 });
    setHaystackProgress({ done: 0, total: 0 });
    setProgress({ done: 0, total: allAssets.length });
    const assets = allAssets.slice(0, 600);

    // ---- Etapa 1 de 2: coleta (mantém o banco em dia por ativo) ----
    setPhase("collect");
    {
      let offset = 0;
      let total = assets.length;
      let collectedTotal = 0;
      let skippedTotal = 0;
      setProgress({ done: 0, total });
      while (!cancelRef.current) {
        const chunk = await mirrorScanChunk({
          data: {
            timeframe: timeframe as "M1" | "M5" | "M15",
            windowSize,
            assets,
            offset,
            limit: CHUNK,
            // O histórico profundo vem do arquivo salvo no banco; aqui só se
            // busca na corretora o punhado de velas recentes que falta.
            historyBlocks: 2,
            minCorrelation: 0.93,
            phase: "collect",
          },
        });

        total = chunk.totalAssets;
        // Cada resposta traz só o que foi atualizado NESTA chamada (o
        // servidor não guarda total nenhum entre chamadas) — o navegador
        // acumula pra mostrar o progresso da varredura inteira.
        collectedTotal += chunk.storedAssets;
        setStored({ assets: collectedTotal, candles: 0 });
        skippedTotal += chunk.skippedAssets.length;
        setSkipped(skippedTotal);

        if (chunk.error) {
          setFeed("error");
          toast.error(chunk.error);
        } else if (chunk.processed > 0) {
          setFeed("ok");
        }

        const next = chunk.nextOffset;
        setProgress({ done: next ?? total, total });
        if (next == null) break;
        offset = next;
      }
    }

    // ---- Etapa 2 de 2: cruzamento (um lote de ativos ao vivo por vez,
    // cada um comparado contra o catálogo INTEIRO em fatias) ----
    if (!cancelRef.current) {
      setPhase("match");
      let liveOffset = 0;
      let liveTotal = assets.length;
      setProgress({ done: 0, total: liveTotal });

      while (!cancelRef.current) {
        let haystackOffset = 0;
        let haystackTotal = assets.length;
        let liveWindows: Record<string, MirrorCandle[]> | undefined = undefined;
        let liveBatchNextOffset: number | null = null;
        let archAssets = 0;
        let archCandles = 0;
        let scanErrored = false;
        // Achados de cada fatia do palheiro, por ativo ao vivo — só vira
        // grupo final depois de cobrir o catálogo inteiro para este lote.
        const accumulated = new Map<
          string,
          { liveWindow: MirrorCandle[]; matches: MirrorMatch[] }
        >();

        while (!cancelRef.current) {
          const chunk: MirrorChunkResult = await mirrorScanChunk({
            data: {
              timeframe: timeframe as "M1" | "M5" | "M15",
              windowSize,
              assets,
              offset: liveOffset,
              limit: MATCH_CHUNK,
              historyBlocks: 2,
              minCorrelation: 0.93,
              phase: "match",
              haystackOffset,
              haystackLimit: HAYSTACK_CHUNK,
              liveWindows,
            },
          });

          liveTotal = chunk.totalAssets;
          haystackTotal = chunk.totalAssets;
          liveBatchNextOffset = chunk.nextOffset;
          liveWindows = chunk.liveWindows;
          archAssets += chunk.storedAssets;
          archCandles += chunk.storedCandles;
          setHaystackProgress({
            done: chunk.haystackNextOffset ?? haystackTotal,
            total: haystackTotal,
          });

          for (const partial of chunk.partialGroups) {
            const entry = accumulated.get(partial.liveAsset) ?? {
              liveWindow: partial.liveWindow,
              matches: [],
            };
            entry.matches.push(...partial.matches);
            accumulated.set(partial.liveAsset, entry);
          }

          if (chunk.error) {
            setFeed("error");
            toast.error(chunk.error);
            scanErrored = true;
            break;
          }
          if (chunk.processed > 0) setFeed("ok");

          const nextHaystack = chunk.haystackNextOffset;
          if (nextHaystack == null) break;
          haystackOffset = nextHaystack;
        }
        if (cancelRef.current || scanErrored) break;

        // Lote de ativos ao vivo concluído (cobriu o catálogo inteiro):
        // consolida os achados de todas as fatias num resultado final.
        setStored({ assets: archAssets, candles: archCandles });
        const newGroups: MirrorAssetGroup[] = [];
        for (const [liveAsset, entry] of accumulated) {
          if (entry.matches.length === 0) continue;
          entry.matches.sort((a, b) => b.correlation - a.correlation);
          const matches = entry.matches.slice(0, MAX_MATCHES);
          newGroups.push({
            liveAsset,
            liveWindow: entry.liveWindow,
            matches,
            consensus: consensusOf(matches),
          });
        }
        if (newGroups.length > 0) {
          setGroups((prev) =>
            [...prev, ...newGroups].sort(
              (a, b) =>
                perfectScore(b) - perfectScore(a) ||
                (b.matches[0]?.correlation ?? 0) - (a.matches[0]?.correlation ?? 0),
            ),
          );
        }

        setProgress({ done: liveBatchNextOffset ?? liveTotal, total: liveTotal });
        if (liveBatchNextOffset == null) break;
        liveOffset = liveBatchNextOffset;
      }
    }

    setPhase(cancelRef.current ? "idle" : "done");
    if (!cancelRef.current) toast.success("Varredura concluída.");
  };

  /**
   * Baixa e salva no banco todo o histórico disponível de cada ativo, por ativo
   * e horário. Só precisa rodar uma vez por timeframe: depois cada ativo já
   * arquivado é pulado, e a varredura de replay passa a buscar na corretora
   * apenas as velas recentes que faltam.
   */
  const runArchive = async () => {
    if (allAssets.length === 0) {
      toast.error("Catálogo de ativos ainda carregando.");
      return;
    }
    cancelRef.current = false;
    setPhase("archive");
    setFeed("ok");
    setArchive({ done: 0, total: allAssets.length, candles: 0, complete: 0 });
    let offset = 0;
    let candles = 0;
    let complete = 0;

    while (!cancelRef.current) {
      const chunk = await backfillArchiveChunk({
        data: {
          timeframe: timeframe as "M1" | "M5" | "M15",
          assets: allAssets.slice(0, 600),
          offset,
          limit: 4,
          blocksPerAsset: 8,
        },
      });
      candles += chunk.savedCandles;
      complete += chunk.completed + chunk.skipped;
      const next = chunk.nextOffset;
      setArchive({
        done: next ?? chunk.totalAssets,
        total: chunk.totalAssets,
        candles,
        complete,
      });
      if (chunk.error) {
        setFeed("error");
        toast.error(chunk.error);
        break;
      }
      if (next == null) break;
      offset = next;
    }

    setPhase("idle");
    if (!cancelRef.current) {
      toast.success(`Arquivo atualizado: ${candles.toLocaleString("pt-BR")} velas salvas.`);
    }
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
  const archivePct = archive.total > 0 ? Math.round((archive.done / archive.total) * 100) : 0;
  const haystackPct =
    haystackProgress.total > 0
      ? Math.round((haystackProgress.done / haystackProgress.total) * 100)
      : 0;

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
            {feed === "ok" ? (
              <Badge
                variant="outline"
                className="gap-1.5 border-call/40 bg-call/10 text-call"
                title="A corretora está entregando o histórico usado na varredura"
              >
                <Wifi className="h-3.5 w-3.5" />
                Corretora respondendo
              </Badge>
            ) : feed === "error" ? (
              <Badge
                variant="outline"
                className="gap-1.5 border-put/40 bg-put/10 text-put"
                title="A corretora recusou ou atrasou as buscas de histórico"
              >
                <WifiOff className="h-3.5 w-3.5" />
                Corretora instável
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1.5 border-border/60 bg-muted/30 text-muted-foreground"
                title="O histórico é buscado quando a varredura começa"
              >
                <WifiOff className="h-3.5 w-3.5" />
                Aguardando varredura
              </Badge>
            )}
            <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
              <Link to="/trading">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Análises</span>
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold">Detector de gráficos repetidos</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Varre os {allAssets.length || "—"} ativos da corretora de uma vez: baixa o histórico de
            cada um e cruza o trecho atual de todos contra o passado de todos — mesmo ativo em outra
            data, outro ativo, lido de trás pra frente ou invertido de cima pra baixo. Onde encontra
            repetição, mostra qual seria a próxima vela.
          </p>
        </div>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-display text-lg font-bold">Detecção automática</h2>
            <Badge variant="outline" className="gap-1.5 border-call/40 bg-call/10 text-call">
              <Wifi className="h-3.5 w-3.5" />
              Rodando em segundo plano
            </Badge>
            {autoResults?.updatedAt ? (
              <span className="text-xs text-muted-foreground">
                Achado mais recente:{" "}
                {new Date(autoResults.updatedAt).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : autoResultsFetchedAt ? (
              <span className="text-xs text-muted-foreground">
                Nenhum replay salvo ainda — o job está passando pelo catálogo.
              </span>
            ) : null}
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Um job roda sozinho, continuamente, comparando cada ativo contra o catálogo inteiro com
            profundidade total de histórico. Esta lista atualiza sozinha — não precisa clicar em
            nada.
          </p>

          {autoGroups.length === 0 && (
            <Card className="border-border/50 bg-surface/40">
              <CardContent className="p-6 text-center text-xs text-muted-foreground">
                Nenhuma repetição detectada no momento.
              </CardContent>
            </Card>
          )}

          {autoGroups.map((group) => (
            <ReplayGroupCard
              key={`auto-${group.liveAsset}`}
              group={group}
              timeframe={timeframe}
              verdict={verdicts[group.liveAsset]}
              loading={pendingVerdict === group.liveAsset}
              onAskAi={() => void askAi(group)}
            />
          ))}
        </section>

        <div className="space-y-1">
          <h2 className="font-display text-lg font-bold">Varredura manual</h2>
          <p className="text-sm text-muted-foreground">
            Roda uma vez, na hora, com os ativos e a profundidade que você escolher aqui — útil para
            testar um timeframe diferente sem esperar o job em segundo plano.
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
                {[5, 8, 12, 16].map((size) => (
                  <Button
                    key={size}
                    variant={windowSize === size ? "default" : "outline"}
                    size="sm"
                    disabled={busy}
                    onClick={() => setWindowSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-1 flex-wrap items-end justify-end gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => void runArchive()}
                disabled={busy || allAssets.length === 0}
                title="Baixa todo o histórico disponível de cada ativo de uma vez. Roda uma única vez por timeframe — depois disso, as varreduras ficam consistentemente rápidas."
              >
                {archiving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                {archiving ? "Arquivando…" : "Arquivar histórico completo"}
              </Button>
              <Button
                className="gap-2"
                onClick={() => void runFullScan()}
                disabled={busy || allAssets.length === 0}
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                {running ? "Varrendo…" : `Varrer todos os ${allAssets.length || ""} ativos`}
              </Button>
              {busy && (
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

        {archiving && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <Badge variant="secondary">Arquivando histórico completo</Badge>
              <span>
                {archive.done} de {archive.total} ativos
              </span>
              <Badge variant="secondary">{archive.complete} ativo(s) com arquivo completo</Badge>
              <Badge variant="secondary">
                {archive.candles.toLocaleString("pt-BR")} velas salvas nesta sessão
              </Badge>
            </div>
            <Progress value={archivePct} className="h-1.5" />
          </div>
        )}

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
              <Badge variant="secondary">
                {stored.assets} ativos {phase === "collect" ? "atualizados" : "com arquivo"}
              </Badge>
              {stored.candles > 0 && (
                <Badge variant="secondary">
                  {stored.candles.toLocaleString("pt-BR")} velas no arquivo
                </Badge>
              )}
              {skipped > 0 && <span>{skipped} ativo(s) sem histórico suficiente</span>}
            </div>
            <Progress value={pct} className="h-1.5" />
            {phase === "match" && haystackProgress.total > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  <span>
                    Cruzando este lote contra o catálogo: {haystackProgress.done} de{" "}
                    {haystackProgress.total} ativos do palheiro
                  </span>
                </div>
                <Progress value={haystackPct} className="h-1" />
              </>
            )}
          </div>
        )}

        {phase === "done" && groups.length === 0 && (
          <Card className="border-border/50 bg-surface/40">
            <CardContent className="space-y-2 p-6 text-center">
              <p className="font-display text-sm font-semibold">Nenhuma repetição encontrada</p>
              <p className="text-xs text-muted-foreground">
                Nenhum ativo está repetindo um trecho conhecido agora. Tente outro timeframe ou
                menos velas comparadas, e repita em instantes.
              </p>
            </CardContent>
          </Card>
        )}

        {(() => {
          const perfect = groups.filter((g) => g.matches.some((m) => m.exact));
          if (perfect.length === 0) return null;
          return (
            <Card className="border-2 border-primary bg-primary/10 shadow-lg shadow-primary/20">
              <CardHeader className="pb-2">
                <CardTitle className="font-display text-sm font-bold text-primary">
                  {perfect.length} ativo(s) com repetição 100% idêntica
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {perfect.map((g) => {
                  const m = g.matches.find((x) => x.exact)!;
                  const plan = m.projection;
                  return (
                    <p key={g.liveAsset} className="text-sm">
                      <span className="font-display font-bold text-foreground">{g.liveAsset}</span>{" "}
                      {plan.map((step, i) => (
                        <span key={step.step}>
                          {i > 0 && <span className="text-muted-foreground"> · </span>}
                          <span className={step.direction === "CALL" ? "text-call" : "text-put"}>
                            {step.direction === "CALL" ? "compra" : "venda"}{" "}
                            {CLOCK_FMT.format(new Date(step.time * 1000))}
                          </span>
                        </span>
                      ))}
                    </p>
                  );
                })}
              </CardContent>
            </Card>
          );
        })()}

        {groups.map((group) => (
          <ReplayGroupCard
            key={`manual-${group.liveAsset}`}
            group={group}
            timeframe={timeframe}
            verdict={verdicts[group.liveAsset]}
            loading={pendingVerdict === group.liveAsset}
            onAskAi={() => void askAi(group)}
          />
        ))}
      </main>
    </div>
  );
}
