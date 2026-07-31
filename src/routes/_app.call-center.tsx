/**
 * Legacy combined Call Center page.
 *
 * Customer Care and Telesales are now separate dashboards, because they are
 * separate workflows: Customer Care is queue-driven and Telesales is
 * extension-driven, and computing both from one set of KPIs produced numbers
 * that were wrong for whichever workflow you were actually looking at.
 *
 * The route is kept purely so existing links and bookmarks resolve instead of
 * 404ing. Customer Care is the default landing page because it carries the
 * realtime queue that people watched this page for.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/call-center")({
  beforeLoad: () => {
    throw redirect({ to: "/calls/customer-care", replace: true });
  },
});
