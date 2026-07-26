import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Retired: the branch surface moved to `/branches`.
 *
 * This route used to render the two-column branch/city table. That table is now
 * the Branch Directory, and its editing half is the import page — neither of
 * which lives under `/admin`, because the directory is a tool every agent uses
 * rather than an administrative screen.
 *
 * Kept as a redirect rather than deleted: the old path is in people's bookmarks
 * and in the sidebar of any tab left open since before the change, and a 404 on
 * a page that still exists under another name is a support ticket.
 */
export const Route = createFileRoute("/_app/admin/branches")({
  beforeLoad: () => {
    throw redirect({ to: "/branches", replace: true });
  },
});
