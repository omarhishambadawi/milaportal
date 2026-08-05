import { useMemo, useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

export type Preset = "today" | "yesterday" | "7d" | "month" | "lastMonth";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
];

export function buildRange(kind: Preset): DateRange {
  const t = new Date();
  if (kind === "today") return { from: t, to: t };
  if (kind === "yesterday") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return { from: y, to: y };
  }
  if (kind === "7d") {
    const f = new Date();
    f.setDate(f.getDate() - 6);
    return { from: f, to: t };
  }
  if (kind === "lastMonth") {
    // Day 0 of the current month is the last day of the previous month, so this
    // stays correct across a January boundary.
    return {
      from: new Date(t.getFullYear(), t.getMonth() - 1, 1),
      to: new Date(t.getFullYear(), t.getMonth(), 0),
    };
  }
  return {
    from: new Date(t.getFullYear(), t.getMonth(), 1),
    to: new Date(t.getFullYear(), t.getMonth() + 1, 0),
  };
}

export function DateRangePicker({
  range,
  onChange,
  disabled,
  align = "start",
  size = "default",
}: {
  range: DateRange | undefined;
  onChange: (r: DateRange | undefined) => void;
  disabled?: boolean;
  align?: "start" | "end";
  size?: "default" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const label = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size}
          disabled={disabled}
          className={cn(
            "font-normal justify-start",
            size === "default" && "h-10 min-w-[200px]",
            !range?.from && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto max-w-[calc(100vw-1.5rem)] p-0 pointer-events-auto overflow-hidden"
        align={align}
        sideOffset={8}
        collisionPadding={12}
      >
        <div className="flex flex-col sm:flex-row max-h-[min(80vh,560px)]">
          <div className="flex sm:flex-col gap-1 border-b sm:border-b-0 sm:border-r p-2 sm:w-[124px] shrink-0 bg-muted/30 overflow-x-auto sm:overflow-visible">
            <div className="hidden sm:block text-[10px] uppercase tracking-wider text-muted-foreground px-2 pt-1 pb-1 font-semibold">
              Presets
            </div>
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant="ghost"
                className="justify-start font-normal h-8 whitespace-nowrap shrink-0"
                onClick={() => onChange(buildRange(p.key))}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            selected={range}
            onSelect={onChange}
            numberOfMonths={1}
            defaultMonth={range?.from}
            className="pointer-events-auto [--cell-size:2rem] sm:[--cell-size:2.25rem]"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
