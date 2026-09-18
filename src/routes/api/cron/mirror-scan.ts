// Detecção de replay em segundo plano: em vez do usuário clicar em "Varrer" e
// esperar minutos, um job agendado (ver Cloud > Jobs / pg_cron) chama este
// endpoint com frequência, processando um pouco do catálogo por vez e
// salvando os achados em mirror_replay_matches. A tela do Espelho OTC lê essa
// tabela direto (getReplayResults), então o resultado já está pronto quando
// o usuário abre a página.
//
// O tamanho do "pouco de cada vez" é o MESMO usado pela varredura manual
// (LIVE_CHUNK/HAYSTACK_CHUNK) — ver mirror.tsx para a matemática de por que
// esse tamanho não estoura o limite de CPU do Cloudflare Workers. Continuar
// sozinho entre chamadas é o que faz isso funcionar como monitoramento
// contínuo: quando termina de passar pelo catálogo inteiro, recomeça do
// zero, sempre com velas frescas (loadHistory/ingest-candles mantêm o banco
// em dia por fora).
import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

const LIVE_CHUNK = 5;
const HAYSTACK_CHUNK = 10;
const WINDOW_SIZE = 40;
const MIN_CORRELATION = 0.93;
/** Fatias processadas por chamada — mais de uma reduz quantas vezes o cron precisa disparar. */
const SLICES_PER_RUN = 2;

export const Route = createFileRoute("/api/cron/mirror-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;

        const url = new URL(request.url);
        const rawTimeframe = url.searchParams.get("timeframe");
        const timeframe: "M1" | "M5" | "M15" =
          rawTimeframe === "M5" ? "M5" : rawTimeframe === "M15" ? "M15" : "M1";

        const { fetchCandles, getActiveIdMap, IqOptionBackoffError } =
          await import("@/lib/iqoption/iqoption.server");
        const { buildOtcAssetList } = await import("@/lib/iqoption/candles.functions");
        const { buildCatalog, runMatchSlice } = await import("@/lib/analysis/mirror.functions");
        const { getScanCursor, saveScanCursor, clearReplayMatches, insertReplayMatches } =
          await import("@/lib/analysis/replayStore.server");

        let slicesRun = 0;
        let matchesFound = 0;
        try {
          const activeIdMap = await getActiveIdMap();
          const catalog = buildCatalog(buildOtcAssetList(activeIdMap).map((a) => a.symbol));
          if (catalog.length === 0) {
            return Response.json({ ok: true, timeframe, slicesRun: 0, matchesFound: 0 });
          }

          let cursor = await getScanCursor(timeframe);

          for (let i = 0; i < SLICES_PER_RUN; i++) {
            let liveOffset = cursor.liveOffset;
            if (liveOffset >= catalog.length) {
              liveOffset = 0;
              cursor = { liveOffset: 0, haystackOffset: 0, liveWindows: {} };
            }
            const batch = catalog.slice(liveOffset, liveOffset + LIVE_CHUNK);
            if (batch.length === 0) break;

            // Começando uma passada nova para este lote (fatia 0 do
            // palheiro): limpa os replays antigos deles antes de acumular os
            // novos, para nunca misturar duas passadas nem deixar achado
            // velho preso na tela.
            if (cursor.haystackOffset === 0) {
              await clearReplayMatches(
                timeframe,
                batch.map((b) => b.label),
              );
            }

            const result = await runMatchSlice({
              fetchCandles,
              isBackoffError: (error) => error instanceof IqOptionBackoffError,
              timeframe,
              windowSize: WINDOW_SIZE,
              minCorrelation: MIN_CORRELATION,
              catalog,
              batch,
              haystackOffset: cursor.haystackOffset,
              haystackLimit: HAYSTACK_CHUNK,
              liveWindowsIn: cursor.liveWindows,
            });

            for (const partial of result.partialGroups) {
              matchesFound += partial.matches.length;
              await insertReplayMatches(
                timeframe,
                partial.liveAsset,
                partial.liveWindow,
                partial.matches.map((m) => ({
                  histAsset: m.asset,
                  transform: m.transform,
                  correlation: m.correlation,
                  similarity: m.similarity,
                  maxDeviation: m.maxDeviation,
                  exact: m.exact,
                  startTime: m.startTime,
                  endTime: m.endTime,
                  volatilityRatio: m.volatilityRatio,
                  predictedReturn: m.predictedReturn,
                  direction: m.direction,
                  projectedClose: m.projectedClose,
                  window: m.window,
                  nextCandle: m.nextCandle,
                  projection: m.projection,
                })),
              );
            }

            const nextLiveOffset =
              result.haystackNextOffset == null
                ? liveOffset + batch.length < catalog.length
                  ? liveOffset + batch.length
                  : 0
                : liveOffset;

            cursor = {
              liveOffset: nextLiveOffset,
              haystackOffset: result.haystackNextOffset ?? 0,
              liveWindows: result.haystackNextOffset != null ? result.liveWindows : {},
            };
            await saveScanCursor(timeframe, cursor);
            slicesRun++;
          }
        } catch (error) {
          console.error("[mirror-scan] falhou", error);
          const message =
            error instanceof IqOptionBackoffError
              ? "Corretora em recuperação (limite de acessos)."
              : String(error);
          return Response.json(
            { ok: false, timeframe, slicesRun, matchesFound, error: message },
            { status: 500 },
          );
        }

        return Response.json({ ok: true, timeframe, slicesRun, matchesFound });
      },
    },
  },
});
