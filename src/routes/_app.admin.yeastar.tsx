/**
 * Legacy route. The developer tooling moved to /calls/diagnostics when the
 * Calls module was reorganised — the PBX vendor is an implementation detail and
 * no longer names a page. Kept so existing links resolve instead of 404ing.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/yeastar")({
  beforeLoad: () => {
    throw redirect({ to: "/calls/diagnostics", replace: true });
  },
});
