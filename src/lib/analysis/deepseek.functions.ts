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
    .max(50)
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
Recebe um pacote com indicadores técnicos (tendência, RSI, ATR, padrões de candle, confirmação multi-timeframe)
leitura de price action (estrutura de mercado HH/HL vs LH/LL, rompimento de estrutura, mudança de caráter, força de corpo, inside bar, pullback e rejeição)
e microestrutura HFT (pressão por janelas, tick rate, aceleração, streak, agressão, absorção, bursts, POC/área de valor
e dominância consolidada da vela). Você também recebe as 50 velas mais recentes do timeframe (OHLC),
zonas de suporte e resistência já calculadas e indícios de manipulação do gráfico
(caças de stop com pavios longos, rompimentos falsos, spikes de amplitude anormal, sequências de doji e preço dentro de zona).
Sua tarefa é dar o veredito FINAL para uma entrada na PRÓXIMA vela.
Considere o price action como filtro principal: nunca confirme entrada contra a estrutura de mercado dominante sem rompimento válido.
Analise as velas para confirmar suporte/resistência, evitar entradas contra zonas de reversão e detectar manipulação:
se o fluxo levar o preço direto para uma zona forte, ou houver sinais claros de manipulação/armadilha de liquidez,
use AGUARDAR (ou INVERTER quando a rejeição na zona for evidente).
Responda SOMENTE com JSON válido no formato:
{"verdict":"CONFIRMAR|AGUARDAR|INVERTER","direction":"CALL|PUT|null","confidence":0-100,"reasoning":"1-3 frases em português","risks":["risco 1","risco 2"]}
Seja conservador: se houver divergência relevante entre HFT e indicadores, use AGUARDAR.`;

/** Final verdict via DeepSeek — only called for signals above 80% confidence. */
export const deepseekVerdict = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<{ verdict: DeepseekVerdict | null; error?: string }> => {
    const apiKey = process.env['DEEPSEEK_API_KEY'];
    if (!apiKey) {
      return { verdict: null, error: "Chave da API DeepSeek não configurada." };
    }

    const payload = {
      ativo: data.asset,
      timeframe: data.timeframe,
      sinal_local: { direcao: data.direction, confianca: data.confidence },
      indicadores: data.indicators,
      velas_recentes: data.candles ?? [],
      estrutura_suporte_resistencia: data.structure ?? null,
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
          temperature: 0.2,
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
        if (response.status === 401) return { verdict: null, error: "Chave DeepSeek inválida." };
        if (response.status === 402) return { verdict: null, error: "Saldo insuficiente na conta DeepSeek." };
        if (response.status === 429) return { verdict: null, error: "Limite de requisições DeepSeek atingido." };
        return { verdict: null, error: "DeepSeek indisponível no momento." };
      }

      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return { verdict: null, error: "Resposta vazia do DeepSeek." };

      const parsed = JSON.parse(content) as Partial<DeepseekVerdict>;
      const verdict: DeepseekVerdict = {
        verdict:
          parsed.verdict === "CONFIRMAR" || parsed.verdict === "INVERTER" ? parsed.verdict : "AGUARDAR",
        direction: parsed.direction === "CALL" || parsed.direction === "PUT" ? parsed.direction : null,
        confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        risks: Array.isArray(parsed.risks) ? parsed.risks.filter((r): r is string => typeof r === "string").slice(0, 4) : [],
      };
      return { verdict };
    } catch (error) {
      console.error("[deepseek] failed", error);
      return { verdict: null, error: "Falha ao consultar o DeepSeek." };
    }
  });
