import { PhoneOff } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * "This window had no calls" — announced once, at the top, and nowhere else.
 *
 * ---------------------------------------------------------------------------
 * Why this replaced hiding the page
 * ---------------------------------------------------------------------------
 * Both dashboards used to answer a zero-call window by rendering a single
 * centred card *instead of* everything below the KPI grids. That conflated
 * three different situations a viewer needs to tell apart — the data has not
 * arrived, the data could not be fetched, and the data arrived and says nobody
 * called — and made the third look like one of the first two. It also meant a
 * supervisor checking a quiet Friday saw the charts, the agent table and the
 * queue roster vanish, which reads as a broken page rather than a quiet day.
 *
 * A zero-call window is a complete and valid answer. So the sections stay on
 * screen showing their own zeros and their own per-widget empty states, and
 * this notice explains the zeros once. Nothing here is conditional on the
 * fetch: it renders only when the query SUCCEEDED and reported no calls.
 */
export function EmptyWindowNotice({
  from,
  to,
  /** Overrides the default sentence when a page needs to say something else. */
  children,
}: {
  from: string;
  to: string;
  children?: React.ReactNode;
}) {
  const oneDay = from === to;
  return (
    <Card className="border-dashed">
      <CardContent className="flex items-start gap-3 p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted">
          <PhoneOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">No calls in {oneDay ? "this day" : "this window"}</p>
          <p className="text-xs leading-snug text-muted-foreground">
            {children ?? (
              <>
                The window {oneDay ? from : `${from} → ${to}`} resolved successfully and contains no
                calls, so every figure below is a real zero rather than missing data. Widen the date
                range or clear a filter to see more.
              </>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
