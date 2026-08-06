/**
 * Legacy route. Kept so existing links and bookmarks resolve.
 *
 * It used to point at the Analytics Center, which has been removed — the
 * remaining developer tooling for the calls module lives on /calls/diagnostics,
 * which is where a bookmark from here was looking for it.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/yeastar-diagnostics")({
  beforeLoad: () => {
    throw redirect({ to: "/calls/diagnostics", replace: true });
  },
});
