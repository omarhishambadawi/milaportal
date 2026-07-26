import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";

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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2">Key</th>
              {methods.map((m) => (
                <th key={m} className="px-3 py-2 text-right">
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={methods.length + 2} className="text-center text-muted-foreground py-6">
                  No data
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.k} className="border-b last:border-0">
                <td className="px-3 py-2 font-medium">{r.k}</td>
                {methods.map((m) => (
                  <td key={m} className="px-3 py-2 text-right font-mono text-xs">
                    {r.v[m] ? fmtSAR(r.v[m]) : "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                  {fmtSAR(r.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
