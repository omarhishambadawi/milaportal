import { Crown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { isOwnerRole } from "@/lib/auth";
import { roleLabel, roleTone } from "@/lib/roles";
import { cn } from "@/lib/utils";

/**
 * The single way a role is displayed anywhere in the app.
 *
 * Owner is deliberately set apart — a filled badge with a crown, rather than the
 * outline treatment every other role gets — so the account with unrestricted
 * access is recognisable at a glance and cannot be mistaken for an ordinary
 * admin. Before this component the Users page had its own styled badge while the
 * profile page rendered a generic grey `secondary` badge, so the Owner looked
 * like everyone else on their own profile.
 *
 * Unknown or retired role values fall through to `roleLabel`'s em dash rather
 * than rendering a raw enum value.
 */
export function RoleBadge({
  role,
  className,
  showIcon = true,
}: {
  role: string | null | undefined;
  className?: string;
  showIcon?: boolean;
}) {
  const owner = isOwnerRole(role);
  return (
    <Badge
      variant="outline"
      className={cn(
        "capitalize font-medium",
        roleTone(role),
        // Owner: solid ring + slightly stronger weight so it reads as a tier
        // above the other badges, not merely a different colour.
        owner && "border-primary/50 bg-primary/15 font-semibold shadow-sm",
        className,
      )}
    >
      {owner && showIcon && <Crown className="mr-1 h-3 w-3 shrink-0" aria-hidden />}
      {roleLabel(role)}
    </Badge>
  );
}
