import type { ComponentType, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "bad" | "idle";

const toneRing: Record<StatusTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  idle: "text-muted-foreground",
};

const toneBadge: Record<StatusTone, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default",
  warn: "secondary",
  bad: "destructive",
  idle: "outline",
};

/**
 * A status card: state first, action second.
 *
 * The developer pages this replaces led with a row of identical "Probe"
 * buttons, which told an operator nothing until they pressed one. A card states
 * what it knows up front and keeps the action as a secondary affordance, so the
 * page reads as a status board rather than a console.
 */
export function StatusCard({
  label,
  value,
  detail,
  tone = "idle",
  icon: Icon,
  loading,
  actionLabel,
  onAction,
  actionPending,
  children,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: StatusTone;
  icon?: ComponentType<{ className?: string }>;
  loading?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  actionPending?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {Icon && <Icon className={cn("h-3.5 w-3.5", toneRing[tone])} />}
              <span className="truncate">{label}</span>
            </div>
            {loading ? (
              <Skeleton className="mt-1.5 h-6 w-24" />
            ) : (
              <div className="mt-0.5 text-lg font-semibold tabular-nums truncate">{value}</div>
            )}
          </div>
          {!loading && tone !== "idle" && (
            <Badge variant={toneBadge[tone]} className="font-normal shrink-0">
              {tone === "ok" ? "OK" : tone === "warn" ? "Check" : "Error"}
            </Badge>
          )}
        </div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
        {children}
        {actionLabel && onAction && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 -ml-2 text-xs"
            onClick={onAction}
            disabled={actionPending}
          >
            {actionPending ? "Working…" : actionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
