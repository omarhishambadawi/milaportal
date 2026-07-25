import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoleBadge } from "@/components/role-badge";
import { UserAvatar } from "@/components/user-avatar";
import { defaultPermsForRole } from "@/lib/permissions";
import { ASSIGNABLE_ROLES, ROLE_OPTION_LABEL, roleHasAgentCode, type AppRole } from "@/lib/roles";

import type { UserDraft } from "../types";
import { PermissionEditor } from "./permission-editor";

/**
 * Edit one user: identity fields, role, and permissions.
 *
 * The draft lives here and is handed back whole on save, so nothing is written
 * until the user commits — closing the dialog discards every change, including
 * permission toggles, which is what people expect from a dialog with a Save
 * button and did not previously happen for the role select.
 */
export function EditUserDialog({
  draft: initialDraft,
  open,
  onOpenChange,
  onSave,
}: {
  draft: UserDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: UserDraft) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<UserDraft | null>(initialDraft);
  const [seed, setSeed] = useState<UserDraft | null>(initialDraft);
  const [busy, setBusy] = useState(false);

  // Re-seed whenever the page hands over a different draft object — including a
  // second edit of the *same* user, which produces a fresh object and so must
  // discard whatever was typed and abandoned last time. Adjusting state during
  // render (rather than in an effect) means the dialog never paints one frame of
  // the previous user's data.
  if (seed !== initialDraft) {
    setSeed(initialDraft);
    setDraft(initialDraft);
  }

  if (!draft) return null;

  const roleKey = (draft.role ?? "customer_care") as AppRole;

  const save = async () => {
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  const togglePerm = (key: string, on: boolean) => {
    const current = draft.permissions ?? [];
    setDraft({
      ...draft,
      permissions: on ? Array.from(new Set([...current, key])) : current.filter((p) => p !== key),
      // Any manual toggle pins the set — see PermissionEditor.
      _usingDefaults: false,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit user &amp; permissions</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-center gap-3 border-b border-border pb-3">
            <UserAvatar name={draft.full_name} url={draft.avatar_url} size="md" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{draft.full_name}</div>
              <div className="truncate text-xs text-muted-foreground">{draft.email}</div>
            </div>
            <RoleBadge role={draft.role} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className={roleHasAgentCode(draft.role) ? "space-y-2 sm:col-span-2" : "space-y-2 sm:col-span-3"}>
              <Label htmlFor="edit-name">Full name</Label>
              <Input
                id="edit-name"
                value={draft.full_name}
                onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
              />
            </div>

            {/* Agent roles only — Owner, Admin, Supervisor and Auditor take no
                orders, so the field is hidden rather than shown and ignored. */}
            {roleHasAgentCode(draft.role) && (
              <div className="space-y-2">
                <Label htmlFor="edit-code">Agent code</Label>
                <Input
                  id="edit-code"
                  value={draft.agent_code ?? ""}
                  onChange={(e) => setDraft({ ...draft, agent_code: e.target.value })}
                />
              </div>
            )}

            <div className="space-y-2 sm:col-span-3">
              <Label htmlFor="edit-ext">Yeastar extension</Label>
              <Input
                id="edit-ext"
                placeholder="e.g. 1001"
                value={draft.yeastar_ext ?? ""}
                onChange={(e) => setDraft({ ...draft, yeastar_ext: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                PBX extension number used to attribute calls to this agent.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-3">
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={roleKey}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    role: v,
                    _roleChange: true,
                    // A user tracking defaults keeps tracking them across a role
                    // change; a pinned custom set is left exactly as pinned.
                    permissions: draft._usingDefaults ? defaultPermsForRole(v as AppRole) : draft.permissions,
                  })
                }
              >
                <SelectTrigger id="edit-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_OPTION_LABEL[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <PermissionEditor
            permissions={draft.permissions ?? []}
            usingDefaults={draft._usingDefaults}
            onToggle={togglePerm}
            onResetToDefaults={() =>
              setDraft({ ...draft, permissions: defaultPermsForRole(roleKey), _usingDefaults: true })
            }
          />

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button onClick={save} disabled={busy || !draft.full_name.trim()}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
