import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { loading, session, role, profile } = useAuth();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  if (!session) return <Navigate to="/auth" replace />;
  if (hasPerm(role, profile?.permissions, "view_dashboard"))
    return <Navigate to="/dashboard" replace />;
  if (hasPerm(role, profile?.permissions, "view_orders")) return <Navigate to="/orders" replace />;
  if (hasPerm(role, profile?.permissions, "view_complaints"))
    return <Navigate to="/complaints" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center text-muted-foreground">
      No permissions assigned.
    </div>
  );
}
