/** Displays one or many invoice numbers. Splits on comma/newline, shows the
 *  first inline with a "+N" chip listing the rest in a tooltip title. */
export function InvoiceCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground font-sans">—</span>;
  const parts = String(value).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return <span className="text-muted-foreground font-sans">—</span>;
  const [first, ...rest] = parts;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="truncate">{first}</span>
      {rest.length > 0 && (
        <span
          className="shrink-0 inline-flex items-center rounded-full bg-primary/10 text-primary text-[10px] font-sans font-semibold px-1.5 py-0.5 leading-none"
          title={parts.join(", ")}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}
