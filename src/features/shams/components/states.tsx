/**
 * Shared presentation pieces for the Shams MIS page.
 *
 * Components only — the cell classes and the failure copy live in
 * `../constants.ts`, so this file stays Fast-Refresh friendly.
 */

import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { failureMessage } from "@/features/shams/constants";

/** A dashed panel used for both "nothing yet" and "nothing found". */
export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
        {icon ?? <Search className="h-8 w-8 opacity-40" aria-hidden="true" />}
        <p>{children}</p>
      </CardContent>
    </Card>
  );
}

/**
 * A failure, with a way out of it.
 *
 * `onRetry` is wired to React Query's `refetch`, so retrying re-runs the exact
 * query that failed rather than resetting the user's input.
 */
export function ErrorState({ kind, onRetry }: { kind?: string | null; onRetry?: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{failureMessage(kind)}</p>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="h-8">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Retry
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Shown while the MIS connection is absent — not an error, just unconfigured. */
export function NotConfiguredState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        Shams MIS is not configured for this deployment.
      </CardContent>
    </Card>
  );
}

/** Row-shaped skeleton for a loading table. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/** Block-shaped skeleton for a loading detail panel. */
export function DetailSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
