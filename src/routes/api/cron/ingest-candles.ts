// Chamado por um cron agendado via pg_cron (SQL puro no Supabase — ver
// supabase/migrations para o cron.schedule), uma vez por timeframe:
// ?timeframe=M1 a cada 1 minuto, ?timeframe=M5 a cada 5 minutos. Cada chamada
// é uma requisição isolada e auto-contida: abre a sessão com a corretora,
// busca a vela mais recente fechada de cada ativo, salva no banco e termina —
// sem tentar reaproveitar a sessão de uma chamada anterior (o Cloudflare
// Workers não permite isso entre requisições diferentes).
//
// Autenticação própria (CRON_INGEST_SECRET) em vez de LOVABLE_CRON_SECRET:
// esse último é gerado e ocultado pelo Lovable para uso exclusivo do painel
// Cloud > Jobs, então não dá para lê-lo e colar num cron.schedule manual.
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual, createHash } from "node:crypto";

function authenticateCronRequest(request: Request): Response | null {
  const secret = process.env["CRON_INGEST_SECRET"];
  if (!secret) return new Response("Server configuration error", { status: 500 });

  const match = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1];
  if (!token) return new Response("Unauthorized", { status: 401 });

  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  if (!timingSafeEqual(digest(token), digest(secret))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/** Roda até `limit` tarefas por vez, sem esperar a lista inteira terminar em série. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++]!;
      await fn(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export const Route = createFileRoute("/api/cron/ingest-candles")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = authenticateCronRequest(request);
        if (authError) return authError;

        const url = new URL(request.url);
        const timeframe = url.searchParams.get("timeframe") === "M5" ? "M5" : "M1";
        const sizeSeconds = timeframe === "M5" ? 300 : 60;

        const { fetchCandles, getActiveIdMap, IqOptionBackoffError } =
          await import("@/lib/iqoption/iqoption.server");
        const { saveCandles } = await import("@/lib/iqoption/candleHistory.server");

        let saved = 0;
        let skipped = 0;
        let assetCount = 0;
        try {
          const catalog = await getActiveIdMap();
          const names = Object.keys(catalog);
          assetCount = names.length;

          await mapWithConcurrency(names, 8, async (name) => {
            try {
              // Só as 2 mais recentes: a última pode ainda estar em formação.
              const recent = await fetchCandles(name, sizeSeconds, 2);
              const closed = recent.slice(0, -1);
              if (closed.length === 0) {
                skipped++;
                return;
              }
              await saveCandles(
                name,
                timeframe,
                closed.map((c) => ({ ...c, volume: c.volume ?? 0 })),
              );
              saved += closed.length;
            } catch (error) {
              if (error instanceof IqOptionBackoffError) throw error;
              skipped++;
            }
          });
        } catch (error) {
          console.error("[ingest-candles] falhou", error);
          return Response.json(
            { ok: false, timeframe, assetCount, saved, skipped, error: String(error) },
            { status: 500 },
          );
        }

        return Response.json({ ok: true, timeframe, assetCount, saved, skipped });
      },
    },
  },
});
