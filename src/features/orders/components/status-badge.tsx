import { STATUS_STYLES } from "@/lib/branches";

export function StatusBadge({ s }: { s: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[s] ?? "bg-muted"}`}
    >
      {s}
    </span>
  );
}
