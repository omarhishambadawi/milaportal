import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function CopyableOrderNo({
  value,
  alwaysShowIcon = false,
}: {
  value: string;
  alwaysShowIcon?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="font-mono font-semibold text-[13px] tracking-tight whitespace-nowrap text-foreground">
        {value}
      </span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy order number"}
        className={cn(
          "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-opacity",
          alwaysShowIcon ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
          copied && "opacity-100 text-[var(--positive-alt)]",
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
