import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ALL_PERMISSIONS, PERMISSION_GROUPS } from "@/lib/permissions";

/**
 * The per-user permission grid.
 *
 * Two states, and the distinction is the point: a user either *tracks their
 * role's defaults* (stored as an empty set, so they pick up future changes to
 * the role) or holds a *pinned custom set*. Toggling anything moves them to
 * custom — the badge and the footer line say so, because silently pinning a
 * user's permissions the first time someone flicks a switch is how accounts end
 * up frozen on a permission set nobody chose.
 */
export function PermissionEditor({
  permissions,
  usingDefaults,
  onToggle,
  onResetToDefaults,
}: {
  permissions: string[];
  usingDefaults: boolean;
  onToggle: (key: string, on: boolean) => void;
  onResetToDefaults: () => void;
}) {
  const selected = new Set(permissions);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label>Permissions</Label>
          <Badge variant={usingDefaults ? "secondary" : "outline"} className="text-[10px]">
            {usingDefaults ? "Using role defaults" : "Custom"}
          </Badge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onResetToDefaults}
          disabled={usingDefaults}
        >
          Reset to defaults
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PERMISSION_GROUPS.map((group) => {
          const perms = ALL_PERMISSIONS.filter((p) => p.group === group);
          if (perms.length === 0) return null;
          return (
            <div key={group} className="space-y-2 rounded-lg border bg-card/40 p-3">
              <div className="border-b pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </div>
              <div className="space-y-1">
                {perms.map((p) => (
                  <label
                    key={p.key}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 text-sm transition-colors duration-150 hover:bg-accent/40"
                  >
                    <span className="min-w-0 flex-1 truncate">{p.label}</span>
                    <Switch
                      checked={selected.has(p.key)}
                      onCheckedChange={(v) => onToggle(p.key, !!v)}
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {usingDefaults
          ? "This user auto-tracks role defaults. Any change pins an exact custom set."
          : "Custom permission set. Use “Reset to defaults” to return to auto-updating defaults."}
      </p>
    </div>
  );
}
