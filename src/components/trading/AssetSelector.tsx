import { useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface AssetOption {
  symbol: string;
  name?: string | null;
  category?: string | null;
}

interface AssetSelectorProps {
  assets: AssetOption[];
  value: string | null;
  onChange: (symbol: string) => void;
  className?: string;
}

export function AssetSelector({ assets, value, onChange, className }: AssetSelectorProps) {
  const [open, setOpen] = useState(false);

  const groups = assets.reduce<Record<string, AssetOption[]>>((acc, asset) => {
    const key = asset.category?.toUpperCase() || "MERCADOS";
    (acc[key] ||= []).push(asset);
    return acc;
  }, {});

  const selected = assets.find((a) => a.symbol === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Selecionar ativo"
          className={cn(
            "w-full justify-between border-border/60 bg-surface font-mono text-sm sm:w-64",
            className,
          )}
        >
          <span className="flex items-center gap-2 truncate">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {selected ? selected.symbol : "Selecionar ativo"}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar ativo…" className="font-mono text-sm" />
          <CommandList>
            <CommandEmpty>Nenhum ativo encontrado.</CommandEmpty>
            {Object.entries(groups).map(([group, items]) => (
              <CommandGroup key={group} heading={group}>
                {items.map((asset) => (
                  <CommandItem
                    key={asset.symbol}
                    value={`${asset.symbol} ${asset.name ?? ""}`}
                    onSelect={() => {
                      onChange(asset.symbol);
                      setOpen(false);
                    }}
                    className="font-mono text-sm"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        asset.symbol === value ? "opacity-100 text-primary" : "opacity-0",
                      )}
                    />
                    <span className="flex-1">{asset.symbol}</span>
                    {asset.name && (
                      <span className="ml-2 truncate font-sans text-xs text-muted-foreground">
                        {asset.name}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
