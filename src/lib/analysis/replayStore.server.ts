// Persistência do job de detecção de replay em segundo plano (ver
// src/routes/api/cron/mirror-scan.ts): onde o job parou (mirror_scan_cursor)
// e os replays já encontrados (mirror_replay_matches), prontos para a tela
// ler na hora, sem precisar rodar a varredura na frente do usuário.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MirrorCandle, MirrorMatch } from "./mirror";

// mirror_scan_cursor e mirror_replay_matches só entram no types.ts gerado
// depois que a migração roda no banco de verdade e o Lovable regenera os
// tipos — até lá, usa o cliente sem o genérico só para essas duas tabelas
// novas (perde a checagem de nome de coluna em tempo de compilação, só para
// elas, até o próximo regenerate).
const db = supabaseAdmin as unknown as SupabaseClient;

export interface ScanCursor {
  liveOffset: number;
  haystackOffset: number;
  liveWindows: Record<string, MirrorCandle[]>;
}

/**
 * Tenta reivindicar o cursor deste timeframe com exclusividade pelos
 * próximos `leaseSeconds` — o agendamento pode disparar de poucos em poucos
 * segundos (Supabase Cron aceita até 1 em 1 segundo), então sem isso duas
 * chamadas em cima da hora poderiam ler o mesmo progresso e uma sobrescrever
 * o avanço da outra. Devolve null se outra chamada já reivindicou e ainda
 * está dentro do prazo — quem receber null deve só pular esta vez, nunca
 * insistir. Mesmo padrão de trava por tempo já usado para coordenar o login
 * da IQ Option (ver claim_iqoption_login).
 */
export async function claimScanCursor(
  timeframe: string,
  leaseSeconds: number,
): Promise<ScanCursor | null> {
  // Garante que a linha existe, sem mexer numa já existente.
  await db
    .from("mirror_scan_cursor")
    .upsert(
      { timeframe, live_offset: 0, haystack_offset: 0, live_windows: {} },
      { onConflict: "timeframe", ignoreDuplicates: true },
    );

  const now = new Date();
  const claimedUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("mirror_scan_cursor")
    .update({ claimed_until: claimedUntil })
    .eq("timeframe", timeframe)
    .or(`claimed_until.is.null,claimed_until.lt.${now.toISOString()}`)
    .select("live_offset, haystack_offset, live_windows")
    .maybeSingle();
  if (error) throw new Error(`Unable to claim scan cursor: ${error.message}`);
  if (!data) return null;
  return {
    liveOffset: data.live_offset,
    haystackOffset: data.haystack_offset,
    liveWindows: (data.live_windows ?? {}) as Record<string, MirrorCandle[]>,
  };
}

/** Grava onde o job parou e libera a reivindicação, para o próximo tick poder retomar dali. */
export async function saveScanCursor(timeframe: string, cursor: ScanCursor): Promise<void> {
  const { error } = await db.from("mirror_scan_cursor").upsert(
    {
      timeframe,
      live_offset: cursor.liveOffset,
      haystack_offset: cursor.haystackOffset,
      live_windows: cursor.liveWindows,
      claimed_until: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "timeframe" },
  );
  if (error) throw new Error(`Unable to save scan cursor: ${error.message}`);
}

export interface ReplayMatchRow {
  histAsset: string;
  transform: string;
  correlation: number;
  similarity: number;
  maxDeviation: number;
  exact: boolean;
  startTime: number;
  endTime: number;
  volatilityRatio: number;
  predictedReturn: number;
  direction: "CALL" | "PUT";
  projectedClose: number;
  window: MirrorCandle[];
  nextCandle: MirrorCandle | null;
  projection: MirrorMatch["projection"];
}

/**
 * Apaga os replays salvos destes ativos ao vivo. Chamado sempre que o job
 * COMEÇA uma passada nova para eles (haystackOffset volta a 0) — mesmo que a
 * passada não ache nada, assim um replay antigo nunca fica preso na tela
 * depois de deixar de existir. As fatias seguintes da MESMA passada só
 * inserem (ver insertReplayMatches), nunca apagam de novo.
 */
export async function clearReplayMatches(timeframe: string, liveAssets: string[]): Promise<void> {
  if (liveAssets.length === 0) return;
  const { error } = await db
    .from("mirror_replay_matches")
    .delete()
    .eq("timeframe", timeframe)
    .in("live_asset", liveAssets);
  if (error) throw new Error(`Unable to clear old replay matches: ${error.message}`);
}

/** Acrescenta os achados desta fatia do palheiro — não apaga nada existente. */
export async function insertReplayMatches(
  timeframe: string,
  liveAsset: string,
  liveWindow: MirrorCandle[],
  matches: ReplayMatchRow[],
): Promise<void> {
  if (matches.length === 0) return;
  const rows = matches.map((m) => ({
    timeframe,
    live_asset: liveAsset,
    live_window: liveWindow,
    hist_asset: m.histAsset,
    transform: m.transform,
    correlation: m.correlation,
    similarity: m.similarity,
    max_deviation: m.maxDeviation,
    is_exact: m.exact,
    start_time: m.startTime,
    end_time: m.endTime,
    volatility_ratio: m.volatilityRatio,
    predicted_return: m.predictedReturn,
    direction: m.direction,
    projected_close: m.projectedClose,
    window: m.window,
    next_candle: m.nextCandle,
    projection: m.projection,
  }));
  const { error: insertError } = await db.from("mirror_replay_matches").insert(rows);
  if (insertError) throw new Error(`Unable to save replay matches: ${insertError.message}`);
}

export interface StoredReplayGroup {
  liveAsset: string;
  liveWindow: MirrorCandle[];
  matches: MirrorMatch[];
  foundAt: string;
}

/** Todos os replays salvos para este timeframe, agrupados por ativo ao vivo. */
export async function getReplayGroups(timeframe: string): Promise<StoredReplayGroup[]> {
  const { data, error } = await db
    .from("mirror_replay_matches")
    .select(
      "live_asset, live_window, hist_asset, transform, correlation, similarity, max_deviation, is_exact, start_time, end_time, volatility_ratio, predicted_return, direction, projected_close, window, next_candle, projection, found_at",
    )
    .eq("timeframe", timeframe)
    .order("correlation", { ascending: false });
  if (error) throw new Error(`Unable to read replay matches: ${error.message}`);

  const byAsset = new Map<string, StoredReplayGroup>();
  for (const row of data ?? []) {
    let group = byAsset.get(row.live_asset);
    if (!group) {
      group = {
        liveAsset: row.live_asset,
        liveWindow: row.live_window as MirrorCandle[],
        matches: [],
        foundAt: row.found_at,
      };
      byAsset.set(row.live_asset, group);
    }
    group.matches.push({
      asset: row.hist_asset,
      timeframe,
      transform: row.transform as MirrorMatch["transform"],
      correlation: row.correlation,
      similarity: row.similarity,
      maxDeviation: row.max_deviation,
      exact: row.is_exact,
      startTime: row.start_time,
      endTime: row.end_time,
      volatilityRatio: row.volatility_ratio,
      predictedReturn: row.predicted_return,
      direction: row.direction as "CALL" | "PUT",
      projectedClose: row.projected_close,
      window: row.window as MirrorCandle[],
      nextCandle: row.next_candle as MirrorCandle | null,
      projection: row.projection as MirrorMatch["projection"],
    });
  }
  return [...byAsset.values()];
}
