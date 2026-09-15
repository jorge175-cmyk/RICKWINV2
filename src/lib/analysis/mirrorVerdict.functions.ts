import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const candleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional(),
});

const inputSchema = z.object({
  asset: z.string().min(2),
  timeframe: z.string().min(2),
  liveWindow: z.array(candleSchema).max(80),
  matches: z
    .array(
      z.object({
        asset: z.string(),
        transform: z.string(),
        similarity: z.number(),
        startTime: z.number(),
        endTime: z.number(),
        volatilityRatio: z.number(),
        predictedReturn: z.number(),
        direction: z.enum(["CALL", "PUT"]),
        window: z.array(candleSchema).max(80),
        nextCandle: candleSchema.nullable(),
        projection: z
          .array(
            z.object({
              step: z.number(),
              time: z.number(),
              ret: z.number(),
              direction: z.enum(["CALL", "PUT"]),
              close: z.number(),
            }),
          )
          .max(12)
          .default([]),
      }),
    )
    .max(8),
  consensus: z.object({
    direction: z.enum(["CALL", "PUT"]).nullable(),
    agreement: z.number(),
    averageReturn: z.number(),
    callCount: z.number(),
    putCount: z.number(),
  }),
});

export interface MirrorVerdict {
  verdict: "REPETICAO_CONFIRMADA" | "PROVAVEL_COINCIDENCIA" | "SEM_REPETICAO";
  direction: "CALL" | "PUT" | null;
  confidence: number;
  reasoning: string;
  risks: string[];
}

const SYSTEM_PROMPT = `Você é um analista quantitativo especializado em detectar mercados sintéticos (OTC) que reciclam
séries históricas de preços. Recebe: a janela ao vivo em OHLC de um ativo OTC, e uma lista de trechos históricos
candidatos (do mesmo ativo em outra data, de outro ativo, ou lidos de trás pra frente e/ou invertidos de cima pra baixo),
cada um com grau de semelhança, razão de volatilidade, a vela de continuação e o movimento projetado.

Analise passo a passo:
1. Compare o desenho da janela ao vivo com cada trecho candidato (sequência de corpos, pavios, amplitude relativa).
2. Julgue se a semelhança é estrutural ou apenas ruído com correlação alta (janelas curtas e voláteis produzem falsos positivos).
3. Verifique se vários trechos independentes apontam para a mesma continuação — convergência aumenta a confiança.
4. Penalize trechos cuja razão de volatilidade é muito distante de 1, e trechos com poucas velas de estrutura reconhecível.
5. Decida a próxima vela: alta (CALL) ou baixa (PUT).

Vereditos: REPETICAO_CONFIRMADA quando a repetição é convincente e a continuação é consistente;
PROVAVEL_COINCIDENCIA quando há semelhança mas fraca ou divergente; SEM_REPETICAO quando os candidatos não sustentam nada.
O campo "direction" é OBRIGATÓRIO mesmo em coincidência ou ausência de repetição: indique a direção mais provável
para a próxima vela com base nos dados. Seja conservador na confiança.

Responda SOMENTE com JSON válido:
{"verdict":"REPETICAO_CONFIRMADA|PROVAVEL_COINCIDENCIA|SEM_REPETICAO","direction":"CALL|PUT","confidence":0-100,"reasoning":"2-4 frases em português citando os trechos e o tipo de espelhamento","risks":["risco 1","risco 2"]}`;

/** Veredito da IA sobre a repetição detectada e a próxima vela da sequência. */
export const mirrorVerdict = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<{ verdict: MirrorVerdict | null; error?: string }> => {
    const apiKey = process.env['DEEPSEEK_API_KEY'];
    if (!apiKey) return { verdict: null, error: "Chave da API não configurada." };

    const payload = {
      ativo_ao_vivo: data.asset,
      timeframe: data.timeframe,
      janela_ao_vivo: data.liveWindow,
      trechos_candidatos: data.matches.map((m) => ({
        ativo: m.asset,
        tipo_de_espelhamento: m.transform,
        semelhanca_pct: m.similarity,
        inicio: m.startTime,
        fim: m.endTime,
        razao_volatilidade: m.volatilityRatio,
        movimento_projetado_pct: Number((m.predictedReturn * 100).toFixed(4)),
        direcao_projetada: m.direction,
        velas: m.window,
        vela_de_continuacao: m.nextCandle,
      })),
      consenso: data.consensus,
      total_candidatos: data.matches.length,
    };

    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
        console.error("[mirror-ia] error", response.status, body.slice(0, 400));
        if (response.status === 401) return { verdict: null, error: "Chave de API inválida." };
        if (response.status === 402) return { verdict: null, error: "Saldo insuficiente na conta de API." };
        if (response.status === 429) return { verdict: null, error: "Limite de requisições atingido." };
        return { verdict: null, error: "Serviço de IA indisponível no momento." };
      }

      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return { verdict: null, error: "Resposta vazia do serviço de IA." };

      const parsed = JSON.parse(content) as Partial<MirrorVerdict>;
      const verdict: MirrorVerdict = {
        verdict:
          parsed.verdict === "REPETICAO_CONFIRMADA" || parsed.verdict === "SEM_REPETICAO"
            ? parsed.verdict
            : "PROVAVEL_COINCIDENCIA",
        direction:
          parsed.direction === "CALL" || parsed.direction === "PUT"
            ? parsed.direction
            : data.consensus.direction,
        confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        risks: Array.isArray(parsed.risks)
          ? parsed.risks.filter((r): r is string => typeof r === "string").slice(0, 4)
          : [],
      };
      return { verdict };
    } catch (error) {
      console.error("[mirror-ia] failed", error);
      return { verdict: null, error: "Falha ao consultar o serviço de IA." };
    }
  });
