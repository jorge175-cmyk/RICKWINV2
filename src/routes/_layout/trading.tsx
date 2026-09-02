import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getTradingSignals, getCurrencyPairs, getUserProfile, getWinRate } from "@/lib/trading.functions";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { ChartDisplay } from "@/components/trading/ChartDisplay";
import { AssetSelector } from "@/components/trading/AssetSelector";
import { TimeframeSelector } from "@/components/trading/TimeframeSelector";
import { AnalysisPanel } from "@/components/trading/AnalysisPanel";
import cardTexture from "@/assets/card-texture.jpg";
import cardFlow from "@/assets/card-flow.jpg";
import { getIqOptionName } from "@/lib/iqoption/mapping";
import { useKeepWarm } from "@/lib/iqoption/useIqOptionStream";
import { ArrowUp, ArrowDown, Clock, TrendingUp, Zap, Star, LogOut, User } from "lucide-react";

export const Route = createFileRoute("/_layout/trading")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData({
        queryKey: ["pairs"],
        queryFn: getCurrencyPairs,
      }),
      queryClient.ensureQueryData({
        queryKey: ["signals"],
        queryFn: getTradingSignals,
      }),
      queryClient.ensureQueryData({
        queryKey: ["profile"],
        queryFn: getUserProfile,
      }),
      queryClient.ensureQueryData({
        queryKey: ["winRate"],
        queryFn: getWinRate,
      }),
    ]);
  },
  component: TradingSignalsPage,
  head: () => ({
    title: "Trading Signals — BinaryPulse",
    meta: [
      {
        name: "description",
        content: "Real-time binary options trading signals, market analysis, and volatility heatmap for BinaryPulse members.",
      },
    ],
  }),
});

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? time : `${date.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${time}`;
}

function relativeTime(value: string | null | undefined) {
  if (!value) return null;
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return null;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

function expiryTime(createdAt: string | null | undefined, minutes: number | null | undefined) {
  if (!createdAt || !minutes) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function isExpired(createdAt: string | null | undefined, minutes: number | null | undefined) {
  const expiry = expiryTime(createdAt, minutes);
  return expiry ? new Date(expiry).getTime() < Date.now() : false;
}


function TradingSignalsPage() {
  const { user } = useAuth();
  const { data: pairs = [] } = useSuspenseQuery({
    queryKey: ["pairs"],
    queryFn: getCurrencyPairs,
  });
  const { data: signals = [] } = useSuspenseQuery({
    queryKey: ["signals"],
    queryFn: getTradingSignals,
  });
  const { data: profile } = useSuspenseQuery({
    queryKey: ["profile"],
    queryFn: getUserProfile,
  });
  const { data: winRate } = useSuspenseQuery({
    queryKey: ["winRate"],
    queryFn: getWinRate,
  });
  const [filter, setFilter] = useState<"all" | "CALL" | "PUT">("all");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState("M5");

  const streamablePairs = pairs.filter((p) => getIqOptionName(p.symbol));
  const activeSymbol = selectedSymbol ?? streamablePairs[0]?.symbol ?? null;
  useKeepWarm(
    streamablePairs.slice(0, 4).map((p) => p.symbol),
    timeframe,
  );

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out successfully");
  };

  const filteredSignals =
    filter === "all" ? signals : signals.filter((s) => s.direction === filter);

  const pairById = (id: string | null) => pairs.find((p) => p.id === id);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/20">
              <Zap className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight">BinaryPulse</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-border/60 bg-surface px-3 py-1.5 sm:flex">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground">
                {profile?.full_name || user?.email || "Trader"}
              </span>
              {profile?.plan && (
                <Badge variant="secondary" className="text-[10px]">
                  {profile.plan}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={handleSignOut}
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-8 grid gap-6 md:grid-cols-3">
          {[
            {
              icon: TrendingUp,
              label: "Active Signals",
              value: String(signals.filter((s) => s.status === "active").length),
              caption: `${signals.length} sinais no histórico recente`,
              image: cardTexture,
              tone: "from-primary/25 via-primary/5 to-transparent",
            },
            {
              icon: Star,
              label: "Win Rate",
              value: winRate?.winRate != null ? `${winRate.winRate}%` : "—",
              caption: winRate?.total ? `${winRate.total} trades verificados (30d)` : "Sem trades verificados",
              image: cardFlow,
              tone: "from-call/20 via-accent/10 to-transparent",
              accent: "text-call",
            },
            {
              icon: Clock,
              label: "Markets Open",
              value: "24/7",
              caption: "Forex, cripto e OTC monitorados",
              image: cardFlow,
              tone: "from-accent/25 via-primary/10 to-transparent",
            },
          ].map((stat) => (
            <Card key={stat.label} className="relative overflow-hidden border-border/50 glass-panel">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-[0.14]"
                style={{ backgroundImage: `url(${stat.image})` }}
              />
              <div aria-hidden className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${stat.tone}`} />
              <CardHeader className="relative pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <stat.icon className="h-4 w-4" /> {stat.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="relative">
                <p className={`font-display text-3xl font-bold ${stat.accent ?? "text-foreground"}`}>{stat.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{stat.caption}</p>
              </CardContent>
            </Card>
          ))}
        </div>


        {activeSymbol && (
          <div className="mb-8 space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border/50 bg-surface/40 p-4 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Ativo</label>
                <AssetSelector
                  assets={streamablePairs.map((p) => ({
                    symbol: p.symbol,
                    name: (p as any).name ?? null,
                    category: (p as any).category ?? null,
                  }))}
                  value={activeSymbol}
                  onChange={setSelectedSymbol}
                  className="sm:w-full"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Timeframe</label>
                <TimeframeSelector value={timeframe} onChange={setTimeframe} />
              </div>
            </div>
            <ChartDisplay symbol={activeSymbol} timeframe={timeframe} />
            <AnalysisPanel symbol={activeSymbol} timeframe={timeframe} />
          </div>
        )}

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="font-display text-2xl font-bold tracking-tight">Live Signals</h1>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as any)} className="w-full sm:w-auto">
            <TabsList className="bg-surface">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="CALL" className="data-[state=active]:bg-call/20 data-[state=active]:text-call">
                CALL
              </TabsTrigger>
              <TabsTrigger value="PUT" className="data-[state=active]:bg-put/20 data-[state=active]:text-put">
                PUT
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-4">
          {filteredSignals.length === 0 && (
            <Card className="glass-panel border-border/50">
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">No signals available right now.</p>
              </CardContent>
            </Card>
          )}
          {filteredSignals.map((signal) => {
            const pair = pairById(signal.pair_id);
            const isCall = signal.direction === "CALL";
            const expired = signal.status === "active" && isExpired(signal.created_at, signal.expiration_minutes);
            const shownStatus = expired ? "expired" : signal.status;
            return (
              <Card
                key={signal.id}
                className="glass-panel border-border/50 transition-all hover:border-primary/30 hover:shadow-glow"
              >
                <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-4">
                    <div
                      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                        isCall ? "bg-call/15 text-call" : "bg-put/15 text-put"
                      }`}
                    >
                      {isCall ? <ArrowUp className="h-6 w-6" /> : <ArrowDown className="h-6 w-6" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-display text-lg font-semibold text-foreground">
                          {pair?.symbol || "—"}
                        </h3>
                        <Badge
                          variant={shownStatus === "active" ? "default" : "secondary"}
                          className={`text-[10px] uppercase ${
                            shownStatus === "active" ? "bg-primary/20 text-primary hover:bg-primary/30" : ""
                          }`}
                          suppressHydrationWarning
                        >
                          {shownStatus}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {signal.analysis_summary || "Technical analysis signal ready for execution."}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                        <span className="rounded-md bg-surface px-2 py-1 font-mono" suppressHydrationWarning>
                          Entrada {formatTime(signal.created_at)}
                          {relativeTime(signal.created_at) ? ` · ${relativeTime(signal.created_at)}` : ""}
                        </span>
                        <span className="rounded-md bg-surface px-2 py-1 font-mono" suppressHydrationWarning>
                          Expira {formatTime(expiryTime(signal.created_at, signal.expiration_minutes))}
                        </span>

                        <span className="rounded-md bg-surface px-2 py-1 font-mono">
                          Entry {signal.entry_price?.toFixed(5) || "—"}
                        </span>
                        <span className="rounded-md bg-surface px-2 py-1">
                          Confidence {signal.confidence ? `${signal.confidence}%` : "—"}
                        </span>
                        <span className="rounded-md bg-surface px-2 py-1">
                          Expires in {signal.expiration_minutes || "—"} min
                        </span>
                        <span className="rounded-md bg-surface px-2 py-1 font-mono">
                          {signal.timeframe || "M5"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                    <span className={`font-display text-xl font-bold ${isCall ? "text-call" : "text-put"}`}>
                      {isCall ? "CALL" : "PUT"}
                    </span>
                    <Button
                      size="sm"
                      className={`gap-1 ${
                        isCall
                          ? "bg-call/20 text-call hover:bg-call/30"
                          : "bg-put/20 text-put hover:bg-put/30"
                      }`}
                      variant="outline"
                      onClick={() => toast.success(`Signal ${pair?.symbol} copied to watchlist`)}
                    >
                      <Star className="h-3.5 w-3.5" /> Watch
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>
    </div>
  );
}
