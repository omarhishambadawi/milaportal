import { memo } from "react";
import { Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface QueueRoster {
  number: string;
  name: string;
  members: Array<{ ext: string; name: string }>;
}

/**
 * Who is signed into each queue, as chips.
 *
 * Clicking a member is pure navigation: it scrolls their row in Agent
 * Performance into view and flags it for a few seconds. It changes no filter,
 * no search term and no query — the analytics context a supervisor is reading
 * stays exactly as they left it, which is the whole point. Anything that
 * narrowed the page to one person would silently rewrite every other KPI on it.
 *
 * ---------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------------
 * The grid was fixed at two columns, so the common case — one queue, because
 * the queue filter is set or the PBX only has one — drew a half-width card with
 * a page-width hole beside it. The column count follows the number of queues
 * instead: one queue takes the full width and lays its members out across it,
 * two or more share the row. The card is the same either way; only how much of
 * the page it is allowed to use changes.
 */
export const QueueMembers = memo(function QueueMembers({
  queues,
  onSelectMember,
}: {
  queues: QueueRoster[];
  /**
   * Called with the member's extension. Expected to scroll to that agent's row
   * and highlight it — never to filter. Omit to render the chips inert.
   */
  onSelectMember?: (ext: string) => void;
}) {
  if (queues.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Queue membership is unavailable — the PBX roster could not be read.
        </CardContent>
      </Card>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-3",
        queues.length === 1
          ? "grid-cols-1"
          : queues.length === 2
            ? "md:grid-cols-2"
            : "md:grid-cols-2 xl:grid-cols-3",
      )}
    >
      {queues.map((q) => (
        <Card key={q.number} className="h-full">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border/60 pb-2.5">
              <span className="text-sm font-semibold tracking-tight">{q.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                #{q.number}
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                {q.members.length} member{q.members.length === 1 ? "" : "s"}
              </span>
            </div>

            {q.members.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">No members assigned.</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {q.members.map((m) => {
                  const body = (
                    <>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                        {m.ext}
                      </span>
                      <span className="truncate text-xs font-medium">{m.name}</span>
                    </>
                  );
                  return (
                    <li key={m.ext} className="min-w-0">
                      {onSelectMember ? (
                        <button
                          type="button"
                          onClick={() => onSelectMember(m.ext)}
                          title={`Jump to ${m.name} in Agent performance`}
                          className="flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-background py-1 pl-1.5 pr-3 transition-colors hover:border-primary/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {body}
                        </button>
                      ) : (
                        <span className="flex max-w-full items-center gap-2 rounded-full border border-border/60 py-1 pl-1.5 pr-3">
                          {body}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
});
