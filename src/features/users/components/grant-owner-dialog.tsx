import { useEffect, useState } from "react";
import { Crown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/password-input";

import type { AdminUserRow } from "../types";

/**
 * Grant the Owner role — password-confirmed.
 *
 * This ADDS an Owner; it is not a transfer. The acting Owner keeps their role,
 * and any number of Owners may coexist with identical privileges and
 * protections. It is nonetheless irreversible in practice — an Owner cannot
 * afterwards be demoted, deactivated or deleted — which is why it is the one
 * role change that asks for a password. The confirmation is verified on the
 * server (`adminSetRole`), so a caller that skips this dialog is refused rather
 * than quietly succeeding.
 */
export function GrantOwnerDialog({
  user,
  open,
  onOpenChange,
  onConfirm,
}: {
  user: AdminUserRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setPassword("");
  }, [open, user?.id]);

  const confirm = async () => {
    if (!password || busy) return;
    setBusy(true);
    const ok = await onConfirm(password);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="h-4 w-4 text-primary" aria-hidden />
            Grant Owner role
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{user?.full_name}</span> will gain
            unrestricted access to every feature, with the same privileges and protections as every
            other Owner. You keep your own Owner role — this adds an Owner rather than handing yours
            over.
          </p>
          <p className="text-sm text-muted-foreground">
            An Owner cannot afterwards be demoted, deactivated or deleted.
          </p>
          <div className="space-y-2">
            <Label htmlFor="grant-owner-confirm">Confirm your password to continue</Label>
            <PasswordInput
              id="grant-owner-confirm"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!password || busy}>
            {busy ? "Confirming…" : "Grant Owner role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
