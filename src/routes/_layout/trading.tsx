import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getCurrencyPairs, getUserProfile, getWinRate } from "@/lib/trading.functions";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { AssetSelector } from "@/components/trading/AssetSelector";
import { TimeframeSelector } from "@/components/trading/TimeframeSelector";
import { AnalysisPanel } from "@/components/trading/AnalysisPanel";
import cardTexture from "@/assets/card-texture.jpg";
import cardFlow from "@/assets/card-flow.jpg";
import { getIqOptionName } from "@/lib/iqoption/mapping";
import { getOtcAssets } from "@/lib/iqoption/candles.functions";
import { Clock, TrendingUp, Zap, Star, LogOut, User } from "lucide-react";

/** Pares principais sempre disponíveis, para o painel abrir sem esperar a corretora. */
const FALLBACK_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CHF", "USD/CAD"];

export const Route = createFileRoute("/_layout/trading")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData({
        queryKey: ["pairs"],
        queryFn: getCurrencyPairs,
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

function TradingSignalsPage() {
  const { user } = useAuth();

  const { data: pairs = [] } = useSuspenseQuery({
    queryKey: ["pairs"],
    queryFn: getCurrencyPairs,
  });
  const { data: profile } = useSuspenseQuery({
    queryKey: ["profile"],
    queryFn: getUserProfile,
  });
  const { data: winRate } = useSuspenseQuery({
    queryKey: ["winRate"],
    queryFn: getWinRate,
  });
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState("M1");

  const { data: otcAssets = [] } = useQuery({
    queryKey: ["otcAssets"],
    queryFn: () => getOtcAssets(),
    staleTime: 30 * 60 * 1000,
  });

  const isOtc = (symbol: string) => /-?OTC$/i.test(symbol.trim());
  const streamablePairs = pairs.filter((p) => getIqOptionName(p.symbol));
  const merged = new Map<string, { symbol: string; name: string | null; category: string }>();
  // Base garantida: pares principais aparecem imediatamente, sem esperar a corretora.
  for (const symbol of FALLBACK_PAIRS) {
    merged.set(symbol.toUpperCase(), { symbol, name: null, category: "MERCADO REAL" });
  }
  for (const p of streamablePairs) {
    merged.set(p.symbol.toUpperCase(), {
      symbol: p.symbol,
      name: (p as any).name ?? null,
      category: isOtc(p.symbol) ? "OTC" : "MERCADO REAL",
    });
  }
  for (const a of otcAssets) {
    const key = a.symbol.toUpperCase();
    if (merged.has(key)) continue;
    merged.set(key, {
      symbol: a.symbol,
      name: a.name,
      category: isOtc(a.symbol) ? "OTC" : "MERCADO REAL",
    });
  }

  const assetOptions = [...merged.values()].sort((a, b) =>
    a.category === b.category
      ? a.symbol.localeCompare(b.symbol)
      : a.category === "MERCADO REAL"
        ? -1
        : 1,
  );

  // Padrão: EUR/USD quando disponível (evita abrir em ações/índices).
  const defaultAsset =
    assetOptions.find((a) => /^EUR\/?USD$/i.test(a.symbol.trim())) ??
    assetOptions.find((a) => /^[A-Z]{3}\/[A-Z]{3}$/.test(a.symbol.trim().toUpperCase())) ??
    assetOptions[0];

  const activeSymbol = selectedSymbol ?? defaultAsset?.symbol ?? null;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out successfully");
  };


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
              label: "Pares monitorados",
              value: String(assetOptions.length),
              caption: `${assetOptions.filter((a) => a.category === "MERCADO REAL").length} mercado real · ${assetOptions.filter((a) => a.category === "OTC").length} OTC`,
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
                  assets={assetOptions}
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
            <AnalysisPanel symbol={activeSymbol} timeframe={timeframe} />
          </div>
        )}
      </main>
    </div>
  );
}

