import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

interface FetchProgressProps {
  /** True while a fetch is in flight. */
  fetching: boolean;
  /** True once the page has numbers on screen, from any window. */
  hasData: boolean;
  progress: { percent: number; message: string } | null;
}

/**
 * Fetch feedback, sized to what the user can already see.
 *
 * The first load has nothing on screen, so it gets the full card: the sweep can
 * page through a lot of CDR and silence would read as a broken page.
 *
 * A refetch is different. `keepPreviousData` means the previous window's
 * numbers are still displayed and still meaningful, so replacing a chunk of the
 * layout with a progress panel pushes the content the user is reading down the
 * page on every filter change. That gets a slim bar instead — same information,
 * no reflow.
 */
export function FetchProgress({ fetching, hasData, progress }: FetchProgressProps) {
  if (!fetching) return null;

  if (hasData) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 print:hidden"
        role="status"
        aria-live="polite"
      >
        <Progress value={progress?.percent ?? 60} className="h-1 flex-1" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {progress?.message ?? "Refreshing…"}
        </span>
      </div>
    );
  }

  return (
    <Card className="border-primary/30 bg-primary/5 print:hidden">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-foreground" role="status" aria-live="polite">
            {progress?.message ?? "Loading call records…"}
          </span>
          <span className="tabular-nums text-muted-foreground">{progress?.percent ?? 0}%</span>
        </div>
        <Progress value={progress?.percent ?? 5} />
      </CardContent>
    </Card>
  );
}
