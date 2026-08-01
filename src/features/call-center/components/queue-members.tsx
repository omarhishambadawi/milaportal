import { Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

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
 */
export function QueueMembers({
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
    <div className="grid gap-3 md:grid-cols-2">
      {queues.map((q) => (
        <Card key={q.number} className="h-full">
          <CardContent className="p-3.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{q.name}</span>
              <span className="font-mono text-xs text-muted-foreground">#{q.number}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {q.members.length}
              </span>
            </div>

            {q.members.length === 0 ? (
              <p className="mt-2.5 text-xs text-muted-foreground">No members assigned.</p>
            ) : (
              <ul className="mt-2.5 flex flex-wrap gap-1.5">
                {q.members.map((m) => {
                  const body = (
                    <>
                      <span className="font-mono text-[11px] text-muted-foreground">{m.ext}</span>
                      <span className="truncate text-xs">{m.name}</span>
                    </>
                  );
                  return (
                    <li key={m.ext} className="min-w-0">
                      {onSelectMember ? (
                        <button
                          type="button"
                          onClick={() => onSelectMember(m.ext)}
                          title={`Jump to ${m.name} in Agent performance`}
                          className="flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 transition-colors hover:border-primary/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {body}
                        </button>
                      ) : (
                        <span className="flex max-w-full items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1">
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
}
