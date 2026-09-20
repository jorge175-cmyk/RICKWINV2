import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MiniCandles } from "./MiniCandles";
import { TRANSFORM_LABELS, type MirrorMatch } from "@/lib/analysis/mirror";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export interface MirrorMatchCardProps {
  match: MirrorMatch;
  liveWindow: MirrorMatch["window"];
}

function formatRange(start: number, end: number) {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${fmt.format(new Date(start * 1000))} → ${fmt.format(new Date(end * 1000))}`;
}

export function MirrorMatchCard({ match, liveWindow }: MirrorMatchCardProps) {
  const isCall = match.direction === "CALL";
  const movePct = (match.predictedReturn * 100).toFixed(3);
  const reverseTime = match.transform === "TIME_REVERSED" || match.transform === "BOTH";
  const invertPrice = match.transform === "PRICE_INVERTED" || match.transform === "BOTH";

  return (
    <Card className="border-border/50 bg-surface/40">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="font-display text-sm font-semibold text-foreground">{match.asset}</p>
            <p className="text-xs text-muted-foreground">{formatRange(match.startTime, match.endTime)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {TRANSFORM_LABELS[match.transform]}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {match.similarity.toFixed(1)}% semelhante
            </Badge>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 rounded-lg border border-border/40 bg-background/40 p-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Ao vivo</p>
            <MiniCandles candles={liveWindow} />
          </div>
          <div className="space-y-1 rounded-lg border border-border/40 bg-background/40 p-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Trecho histórico + próxima vela
            </p>
            <MiniCandles
              candles={match.window}
              reverseTime={reverseTime}
              invertPrice={invertPrice}
              nextCandle={match.nextCandle}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
          <div className={`flex items-center gap-2 ${isCall ? "text-call" : "text-put"}`}>
            {isCall ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
            <span className="font-display text-sm font-bold">
              Próxima vela: {isCall ? "COMPRA" : "VENDA"}
            </span>
            <span className="text-xs text-muted-foreground">({movePct}%)</span>
          </div>
          <span className="text-xs text-muted-foreground">
            Volatilidade {match.volatilityRatio}× · alvo {match.projectedClose.toFixed(5)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
