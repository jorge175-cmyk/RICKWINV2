import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface BinollaAssetOption {
  symbol: string;
  name: string;
  category: string;
}

/** Catálogo de ativos ativos da Binolla, para popular o seletor de ativos. */
export const getBinollaAssets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<BinollaAssetOption[]> => {
    const { getAssetCatalog } = await import("./binolla.server");
    try {
      const list = await getAssetCatalog();
      return list
        .filter((a) => a.active)
        .map((a) => ({ symbol: a.symbol, name: a.name, category: a.category || "OUTROS" }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    } catch (error) {
      console.error("[binolla] asset list failed", error);
      return [];
    }
  });
