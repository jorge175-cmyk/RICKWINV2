import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const inputSchema = z.object({
  asset: z.string().min(2),
  timeframe: z.string().min(2),
  direction: z.enum(["CALL", "PUT"]),
  confidence: z.number(),
  indicators: z.record(z.string(), z.unknown()),
  candles: z
    .array(
      z.object({
        time: z.number(),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
        volume: z.number().optional(),
      }),
    )
    .max(200)
    .optional(),
  structure: z.record(z.string(), z.unknown()).optional(),
  priceAction: z.record(z.string(), z.unknown()).optional(),
});

export interface DeepseekVerdict {
  verdict: "CONFIRMAR" | "AGUARDAR" | "INVERTER";
  direction: "CALL" | "PUT" | null;
  confidence: number;
  reasoning: string;
  risks: string[];
}

const SYSTEM_PROMPT = `Você é um analista quantitativo sênior de opções binárias.
Recebe um pacote completo: indicadores técnicos (tendência EMA9/EMA21, RSI, ATR, padrões de candle, confirmação multi-timeframe),
price action (estrutura HH/HL vs LH/LL, rompimento de estrutura BOS, mudança de caráter CHoCH, força de corpo, inside bar, pullback, rejeição),
microestrutura HFT (pressão por janelas, tick rate, aceleração, streak, agressão, absorção, bursts, POC/área de valor e dominância consolidada da vela),
as velas mais recentes do timeframe em OHLC (mínimo 50), zonas de suporte e resistência já calculadas,
linhas de tendência LTA (suporte ascendente) e LTB (resistência descendente) com inclinação, toques, projeção para a próxima vela e rompimento,
e indícios de manipulação do gráfico (caças de stop, rompimentos falsos, spikes de amplitude anormal, sequências de doji, preço dentro de zona).

Faça uma ANÁLISE PROFUNDA, passo a passo, antes de decidir:
1. Reconstrua a estrutura de mercado pelas velas (topos/fundos, tendência dominante, range vs tendência).
2. Valide as zonas de suporte/resistência recebidas contra as velas e verifique se o preço tem espaço livre até a próxima zona na direção do sinal.
3. Avalie LTA/LTB: o preço está apoiado, testando, ou rompendo a linha? Rompimento sem confirmação é armadilha.
4. Marque regiões de reversão (confluência entre zona, linha de tendência, RSI extremo e rejeição por pavio).
5. Cheque manipulação e liquidez: caça de stops e falso rompimento invalidam a entrada.
6. Confronte HFT/dominância da vela fechada com os indicadores e o price action.
7. Só então decida a entrada para a PRÓXIMA vela.

Regras: nunca confirme entrada contra a estrutura dominante sem rompimento válido; se o fluxo levar o preço direto para uma zona forte
ou para uma LTA/LTB não rompida, use AGUARDAR; se houver rejeição evidente na zona, use INVERTER;
em divergência relevante entre HFT e indicadores, use AGUARDAR. Seja conservador — assertividade importa mais que quantidade de sinais.
O campo "direction" é OBRIGATÓRIO em toda resposta: mesmo quando o veredito for AGUARDAR, indique a direção mais provável
(CALL ou PUT) para a próxima vela com base no conjunto dos dados. Nunca retorne direction nula.

Responda SOMENTE com JSON válido no formato:
{"verdict":"CONFIRMAR|AGUARDAR|INVERTER","direction":"CALL|PUT","confidence":0-100,"reasoning":"2-4 frases em português citando zonas, LTA/LTB e fluxo","risks":["risco 1","risco 2"]}`;

/** Final verdict via IA — only called for signals above 80% confidence. */
export const deepseekVerdict = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<{ verdict: DeepseekVerdict | null; error?: string }> => {
    const apiKey = process.env['DEEPSEEK_API_KEY'];
    if (!apiKey) {
      return { verdict: null, error: "Chave da API não configurada." };
    }

    const payload = {
      ativo: data.asset,
      timeframe: data.timeframe,
      sinal_local: { direcao: data.direction, confianca: data.confidence },
      indicadores: data.indicators,
      velas_recentes: data.candles ?? [],
      estrutura_suporte_resistencia: data.structure ?? null,
      linhas_de_tendencia: (data.structure as { trendLines?: unknown } | undefined)?.trendLines ?? null,
      total_velas_enviadas: data.candles?.length ?? 0,
      price_action: data.priceAction ?? null,
    };

    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.15,
          max_tokens: 1200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(payload) },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error("[deepseek] error", response.status, body.slice(0, 400));
        if (response.status === 401) return { verdict: null, error: "Chave de API inválida." };
        if (response.status === 402) return { verdict: null, error: "Saldo insuficiente na conta de API." };
        if (response.status === 429) return { verdict: null, error: "Limite de requisições atingido." };
        return { verdict: null, error: "Serviço de IA indisponível no momento." };
      }

      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return { verdict: null, error: "Resposta vazia do serviço de IA." };

      const parsed = JSON.parse(content) as Partial<DeepseekVerdict>;
      const verdict: DeepseekVerdict = {
        verdict:
          parsed.verdict === "CONFIRMAR" || parsed.verdict === "INVERTER" ? parsed.verdict : "AGUARDAR",
        // Sempre expor uma direção: usa a do DeepSeek ou, na falta, a direção do sinal local.
        direction:
          parsed.direction === "CALL" || parsed.direction === "PUT" ? parsed.direction : data.direction,
        confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        risks: Array.isArray(parsed.risks) ? parsed.risks.filter((r): r is string => typeof r === "string").slice(0, 4) : [],
      };
      return { verdict };
    } catch (error) {
      console.error("[deepseek] failed", error);
      return { verdict: null, error: "Falha ao consultar o serviço de IA." };
    }
  });
