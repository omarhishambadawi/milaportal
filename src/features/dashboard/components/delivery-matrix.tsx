import type { LucideIcon } from "lucide-react";
import { fmtSAR } from "@/lib/branches";
import { AnalyticsCard } from "./analytics-card";
import { AnalyticsTable, EmptyRow, Tbody, Td, Th, Thead } from "./analytics-table";

/** Location × delivery-method crosstab (top 10 by total). */
export function DeliveryMatrix({
  title,
  icon,
  matrix,
  methods,
}: {
  title: string;
  icon?: LucideIcon;
  matrix: Record<string, Record<string, number>>;
  methods: string[];
}) {
  const rows = Object.entries(matrix)
    .map(([k, v]) => ({ k, v, total: Object.values(v).reduce((s, n) => s + n, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return (
    <AnalyticsCard title={title} icon={icon} flush>
      {/* Columns size themselves to their content (`fit`), so the label column
          absorbs the slack instead of every money column being padded out to a
          fixed 140px. The min width is only a floor for genuinely narrow
          viewports — ~96px per numeric column fits "123,456 SAR" at this
          density — so a desktop card shows the whole crosstab without scroll. */}
      <AnalyticsTable fit dense minWidth={150 + (methods.length + 1) * 96}>
        <Thead>
          <tr>
            <Th>Key</Th>
            {methods.map((m) => (
              <Th key={m} align="right">
                {m}
              </Th>
            ))}
            <Th align="right" className="bg-muted/70 text-foreground">
              Total
            </Th>
          </tr>
        </Thead>
        <Tbody>
          {rows.length === 0 && <EmptyRow colSpan={methods.length + 2} />}
          {rows.map((r) => (
            <tr key={r.k}>
              <Td className="whitespace-nowrap font-medium">{r.k}</Td>
              {methods.map((m) => (
                <Td key={m} numeric className={r.v[m] ? undefined : "text-muted-foreground"}>
                  {r.v[m] ? fmtSAR(r.v[m]) : "—"}
                </Td>
              ))}
              <Td numeric className="bg-muted/30 font-semibold text-foreground">
                {fmtSAR(r.total)}
              </Td>
            </tr>
          ))}
        </Tbody>
      </AnalyticsTable>
    </AnalyticsCard>
  );
}
