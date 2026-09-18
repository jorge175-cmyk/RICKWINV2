import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MirrorMatchCard } from "@/components/trading/MirrorMatchCard";
import type { MirrorAssetGroup } from "@/lib/analysis/mirror.functions";
import type { MirrorVerdict } from "@/lib/analysis/mirrorVerdict.functions";
import { Loader2, Sparkles } from "lucide-react";

const VERDICT_LABEL: Record<MirrorVerdict["verdict"], string> = {
  REPETICAO_CONFIRMADA: "Repetição confirmada",
  PROVAVEL_COINCIDENCIA: "Provável coincidência",
  SEM_REPETICAO: "Sem repetição",
};

/** Horário local do usuário: é nele que a operação será aberta. */
const CLOCK_FMT = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

export interface ReplayGroupCardProps {
  group: MirrorAssetGroup;
  timeframe: string;
  verdict: MirrorVerdict | undefined;
  loading: boolean;
  onAskAi: () => void;
}

/**
 * Um ativo com repetição encontrada: plano de entrada, coincidências e o
 * veredito da IA. Usado tanto pela seção de detecção automática quanto pela
 * varredura manual — o mesmo card, duas fontes de dados diferentes.
 */
export function ReplayGroupCard({
  group,
  timeframe,
  verdict,
  loading,
  onAskAi,
}: ReplayGroupCardProps) {
  const perfectMatch = group.matches.find((m) => m.exact);
  const hasPerfect = perfectMatch != null;
  /** O plano de operações segue a repetição idêntica quando existe. */
  const planMatch = perfectMatch ?? group.matches[0];
  const plan = planMatch?.projection ?? [];

  return (
    <section className="space-y-3">
      <div
        className={`space-y-3 rounded-xl border p-4 ${
          hasPerfect
            ? "border-2 border-primary bg-primary/10 shadow-lg shadow-primary/20"
            : "border-border/50 bg-surface/40"
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Entrar neste ativo
            </p>
            <h2 className="font-display text-2xl font-bold text-foreground">{group.liveAsset}</h2>
          </div>
          {hasPerfect && (
            <Badge className="bg-primary text-primary-foreground">Repetição 100% idêntica</Badge>
          )}
          <Badge variant="secondary">{group.matches.length} coincidência(s)</Badge>
          <Badge variant="secondary">{timeframe}</Badge>
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

        {plan.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Plano das próximas {plan.length} velas · {group.liveAsset}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
              {plan.map((step) => {
                const up = step.direction === "CALL";
                const past = step.time * 1000 < Date.now();
                return (
                  <div
                    key={step.step}
                    className={`rounded-lg border p-2 text-center ${
                      past
                        ? "border-border/40 bg-background/20 opacity-50"
                        : up
                          ? "border-call/40 bg-call/10"
                          : "border-put/40 bg-put/10"
                    }`}
                  >
                    <p className="font-display text-base font-bold tabular-nums text-foreground">
                      {CLOCK_FMT.format(new Date(step.time * 1000))}
                    </p>
                    <p
                      className={`font-display text-sm font-bold ${up ? "text-call" : "text-put"}`}
                    >
                      {up ? "COMPRA" : "VENDA"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {past ? "vela já passou" : `vela ${step.step}`}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {group.liveAsset}:{" "}
              {plan
                .map(
                  (step) =>
                    `${step.direction === "CALL" ? "compra" : "venda"} ${CLOCK_FMT.format(new Date(step.time * 1000))}`,
                )
                .join(" · ")}
            </p>
          </div>
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
            <Button variant="outline" className="gap-2" onClick={onAskAi} disabled={loading}>
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
}
