import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Displays one or many invoice numbers with a copy affordance that mirrors
 * `CopyableOrderNo`. Multiple invoices are split on comma/newline and copied
 * as newline-separated values so the paste target (Excel, WhatsApp, notes)
 * receives one per line.
 */
export function InvoiceCell({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);

  if (!value) return <span className="text-muted-foreground font-sans">—</span>;
  const parts = String(value)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return <span className="text-muted-foreground font-sans">—</span>;

  const [first, ...rest] = parts;
  const hasMany = rest.length > 0;
  const copyPayload = parts.join("\n");

  const onCopy = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(copyPayload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="truncate">{first}</span>
      {hasMany && (
        <span
          className="shrink-0 inline-flex items-center rounded-full bg-primary/10 text-primary text-[10px] font-sans font-semibold px-1.5 py-0.5 leading-none"
          title={parts.join("\n")}
        >
          +{rest.length}
        </span>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label={
          copied
            ? "Copied"
            : hasMany
              ? `Copy ${parts.length} invoice numbers`
              : "Copy invoice number"
        }
        title={hasMany ? `Copy all ${parts.length} invoices (one per line)` : "Copy invoice"}
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-opacity",
          "opacity-0 group-hover:opacity-100 focus:opacity-100",
          copied && "opacity-100 text-[var(--positive-alt)]",
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
