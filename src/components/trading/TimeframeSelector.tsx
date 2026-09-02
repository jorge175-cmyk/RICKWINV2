import { Clock } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TIMEFRAME_LIST } from "@/lib/iqoption/mapping";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = {
  M1: "M1 — 1 minuto",
  M5: "M5 — 5 minutos",
  M15: "M15 — 15 minutos",
};

interface TimeframeSelectorProps {
  value: string;
  onChange: (timeframe: string) => void;
  className?: string;
}

export function TimeframeSelector({ value, onChange, className }: TimeframeSelectorProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Selecionar timeframe"
        className={cn("w-full border-border/60 bg-surface font-mono text-sm sm:w-48", className)}
      >
        <span className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue placeholder="Timeframe" />
        </span>
      </SelectTrigger>
      <SelectContent>
        {TIMEFRAME_LIST.map((tf) => (
          <SelectItem key={tf} value={tf} className="font-mono text-sm">
            {LABELS[tf] ?? tf}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
