/**
 * Legacy route. KPI validation moved to the Analytics Center at
 * /calls/analytics. Kept so existing links and bookmarks resolve.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/yeastar-diagnostics")({
  beforeLoad: () => {
    throw redirect({ to: "/calls/analytics", replace: true });
  },
});
