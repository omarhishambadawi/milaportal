export function SectionTitle({ title }: { title: string }) {
  return (
    <div className="mb-3 mt-2 flex items-end gap-3">
      <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}
