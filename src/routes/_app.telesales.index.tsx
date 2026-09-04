import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { Lightbulb, Link2, ShieldAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { DOMAIN_LEAD_TYPES } from "@/lib/telesales/types";
import { LeadQueue } from "@/features/telesales/components/lead-queue";
import {
  encodeQueueContext,
  queueStateFromSearch,
  searchFromQueueState,
  validateQueueSearch,
  type QueueState,
} from "@/features/telesales/queue-search";

/** The pipelines this page owns, in the shape the queue's scope clause wants. */
const CASH_DOMAIN = DOMAIN_LEAD_TYPES.cash.join(",");

export const Route = createFileRoute("/_app/telesales/")({
  head: () => ({ meta: [{ title: "Cash CRM — MilaServ Portal" }] }),
  /*
   * The filters live in the address bar.
   *
   * They were component state, which meant opening a lead and coming back
   * landed the agent on an unfiltered first page — as did a refresh, and as did
   * browser Back. In the URL all three restore what was on screen, and a
   * filtered queue becomes something a supervisor can send as a link.
   *
   * Validated rather than trusted: `validateQueueSearch` collapses anything
   * unexpected to the default, so a hand-edited URL cannot reach the database
   * with a filter the queue has no rendering for.
   */
  validateSearch: validateQueueSearch,
  /*
   * `/telesales?type=wasfaty` is somebody's old bookmark, and it now names a
   * pipeline this page does not carry.
   *
   * Redirected rather than ignored. Silently clamping it to "all" would answer
   * a question nobody asked — the link meant "the Wasfaty leads", and those
   * still exist, one route along. Every other filter on the URL travels with
   * it, so a saved "overdue Wasfaty, page 3" lands as exactly that.
   */
  beforeLoad: ({ search }) => {
    if (search.type === "wasfaty") {
      const { type: _type, ...rest } = search;
      throw redirect({ to: "/telesales/wasfaty", search: rest });
    }
  },
  component: CashCrmPage,
});

/**
 * The Cash CRM.
 *
 * Cash and Retention, and nothing else. They are one desk's work by
 * construction — a Retention lead is the next cycle of a Cash conversion this
 * system recorded — so they share a queue, a catalogue and a vocabulary.
 *
 * Wasfaty used to be a third chip on this row. It was never a third pipeline in
 * the same sense: different identifiers, a different daily window, a different
 * set of recorded actions, and a portal the Cash agents do not have. It has its
 * own pages now, and the scope clause in the queue's read means this one cannot
 * be talked into showing its leads.
 */
function CashCrmPage() {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;

  const canView = hasPerm(role, perms, "view_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queueState = useMemo(() => queueStateFromSearch(search), [search]);

  /**
   * Write part of the queue state back to the URL.
   *
   * `replace` for typing, so a search term does not leave one history entry per
   * keystroke — Back from a lead would otherwise step backwards through the
   * word the agent typed. Everything else pushes, because a filter change is a
   * navigation the agent may well want to undo.
   */
  const put = useCallback(
    (next: Partial<QueueState>, replace = false) => {
      void navigate({ search: () => searchFromQueueState({ ...queueState, ...next }), replace });
    },
    [navigate, queueState],
  );

  /*
   * The filters, packed for a lead to carry.
   *
   * Browser Back already returns here, because the filters are in the URL it
   * came from. This is for the lead's own Queue button, which is a Link and
   * navigates forward to wherever it is told. Undefined on the default queue,
   * so an unfiltered view adds nothing to the address bar.
   */
  const queueContext = useMemo(() => encodeQueueContext(search), [search]);

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">The CRM is restricted</p>
        <p className="mt-1 text-sm text-muted-foreground">You do not have access to the CRM.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Cash CRM</h1>
          <p className="text-sm text-muted-foreground">
            Cash and Retention leads. Wasfaty has its own pages.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Recommended is an agent view, so it sits outside the manage-only
              block — the whole point is the person making the calls. */}
          <Button asChild variant="outline" size="sm">
            <Link to="/telesales/recommended">
              <Lightbulb className="mr-2 h-4 w-4" />
              Recommended
            </Link>
          </Button>
          {canManage ? (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to="/telesales/management">Management</Link>
              </Button>
              {/*
               * One button where there were two.
               *
               * "Cross-sell" and "Product identity" were separate screens that
               * a supervisor had to visit in the right order — you cannot
               * configure a companion for a product the catalogue does not
               * carry — and neither said so. They are one page now, and the
               * catalogue is the first thing on it.
               */}
              <Button asChild variant="outline" size="sm">
                <Link to="/telesales/catalog">
                  <Link2 className="mr-2 h-4 w-4" />
                  Cross &amp; Up-sell
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/telesales/import">
                  <Upload className="mr-2 h-4 w-4" />
                  Import
                </Link>
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <LeadQueue
        domain={CASH_DOMAIN}
        typeChips={DOMAIN_LEAD_TYPES.cash}
        state={queueState}
        put={put}
        queueContext={queueContext}
      />
    </div>
  );
}
