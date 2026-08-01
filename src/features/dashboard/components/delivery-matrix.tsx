import { fmtSAR } from "@/lib/branches";
import { AnalyticsCard } from "./analytics-card";
import { AnalyticsTable, EmptyRow, Tbody, Td, Th, Thead } from "./analytics-table";

/** Location × delivery-method crosstab (top 10 by total). */
export function DeliveryMatrix({
  title,
  matrix,
  methods,
}: {
  title: string;
  matrix: Record<string, Record<string, number>>;
  methods: string[];
}) {
  const rows = Object.entries(matrix)
    .map(([k, v]) => ({ k, v, total: Object.values(v).reduce((s, n) => s + n, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return (
    <AnalyticsCard title={title} flush>
      {/* A crosstab grows a column per method, so the min width has to grow with
          it — otherwise five methods squeeze into a phone and every figure
          wraps. Each money column needs room for "123,456 SAR" on one line, so
          the per-method budget is 140px rather than 110. */}
      <AnalyticsTable minWidth={240 + (methods.length + 1) * 140}>
        <Thead>
          <tr>
            <Th className="min-w-[10rem]">Key</Th>
            {methods.map((m) => (
              <Th key={m} align="right" className="min-w-[8.5rem]">
                {m}
              </Th>
            ))}
            <Th align="right" className="min-w-[9rem] bg-muted/70 text-foreground">
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
              <Td numeric className="border-l border-border/60 bg-muted/25 font-semibold">
                {fmtSAR(r.total)}
              </Td>
            </tr>
          ))}
        </Tbody>
      </AnalyticsTable>
    </AnalyticsCard>
  );
}
