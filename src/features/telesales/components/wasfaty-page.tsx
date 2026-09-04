import { Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { ShieldAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { DOMAIN_LEAD_TYPES } from "@/lib/telesales/types";
import { LeadQueue } from "@/features/telesales/components/lead-queue";
import {
  encodeQueueContext,
  queueStateFromSearch,
  searchFromQueueState,
  type QueueSearch,
  type QueueState,
} from "@/features/telesales/queue-search";
import { WASFATY_VIEWS, wasfatyView, type WasfatyViewId } from "@/features/telesales/wasfaty-views";

/** The Wasfaty domain, in the shape the queue's scope clause wants. */
export const WASFATY_DOMAIN = DOMAIN_LEAD_TYPES.wasfaty.join(",");

/**
 * The Wasfaty desk.
 *
 * One component behind three routes, because the three views differ by two
 * values — a predicate and a pair of defaults — and everything else about them
 * is identical. Three copies of this page would be three places to fix the next
 * time the date filter changes.
 *
 * Wasfaty carries no product catalogue, no cross-sell and no retention cycle,
 * so none of that appears here. What it does carry that Cash does not is the
 * prescription pair (Patient ID, Prescription No), which the row already
 * renders, and a phone number that is frequently absent by design.
 */
export function WasfatyPage({
  view: viewId,
  search,
  onSearchChange,
}: {
  view: WasfatyViewId;
  search: QueueSearch;
  /** The route writes it to the address bar; this component only decides what
   *  the next search should be. Keeps the router's types at the route. */
  onSearchChange: (next: QueueSearch, replace: boolean) => void;
}) {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canView = hasPerm(role, perms, "view_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const view = wasfatyView(viewId);
  const state = useMemo(() => queueStateFromSearch(search, view.defaults), [search, view.defaults]);

  const put = useCallback(
    (next: Partial<QueueState>, replace = false) => {
      onSearchChange(searchFromQueueState({ ...state, ...next }, view.defaults), replace);
    },
    [onSearchChange, state, view.defaults],
  );

  const queueContext = useMemo(() => encodeQueueContext(search), [search]);

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Wasfaty is restricted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          You do not have access to the Wasfaty desk.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Wasfaty — {view.label}</h1>
          <p className="text-sm text-muted-foreground">{view.description}</p>
        </div>
        {canManage ? (
          <Button asChild size="sm">
            <Link to="/telesales/import">
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Link>
          </Button>
        ) : null}
      </div>

      {/*
       * The three views, as links rather than as a filter.
       *
       * Each is a real URL a supervisor can send, and each keeps its own
       * filters — switching from Generated to Worked is a different question,
       * not the same question with one box changed, so carrying the search
       * across would apply a Generated-shaped filter to a retrospective list.
       */}
      <nav
        aria-label="Wasfaty views"
        className="flex flex-wrap items-center gap-1 border-b border-border"
      >
        {WASFATY_VIEWS.map((v) => (
          <Link
            key={v.id}
            to={v.to}
            aria-current={v.id === view.id ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              v.id === view.id
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </Link>
        ))}
      </nav>

      <LeadQueue
        domain={WASFATY_DOMAIN}
        worked={view.worked}
        state={state}
        put={put}
        queueContext={queueContext}
        emptyTitle={
          view.id === "worked" ? "Nothing has been worked yet" : "No Wasfaty leads right now"
        }
        emptyHint={
          view.id === "generated"
            ? "The daily run raises leads for prescriptions due today and tomorrow."
            : undefined
        }
      />
    </div>
  );
}
