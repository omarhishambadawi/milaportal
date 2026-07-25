import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, LogOut, Mail } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { expireTemporaryPassword } from "@/lib/profile.functions";

/**
 * The dead end an expired temporary password leads to.
 *
 * Reaching this screen does two things. It refuses access, and — via
 * `expireTemporaryPassword` — it retires the credential that got here, replacing
 * it with a random value. That call is what makes the deadline meaningful rather
 * than decorative: after it, the password on the sticky note opens nothing.
 *
 * The way out is a recovery email the user sends themselves. Requiring an
 * administrator instead would be a support ticket for a situation the platform
 * created on purpose, and the emailed link proves control of the mailbox just as
 * well here as it does on the sign-in page.
 */
export function TemporaryPasswordExpired({
  email,
  onSignOut,
}: {
  email?: string | null;
  onSignOut: () => void;
}) {
  const expireFn = useServerFn(expireTemporaryPassword);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const retired = useRef(false);

  // Once per mount. The server call is idempotent — it no-ops when the credential
  // has already been rotated — but there is no reason to make it repeatedly.
  useEffect(() => {
    if (retired.current) return;
    retired.current = true;
    expireFn().catch(() => {
      // Nothing useful to say to the user: they are already blocked, and the
      // rotation retries on the next visit.
    });
  }, [expireFn]);

  const sendLink = async () => {
    if (!email) return;
    setSending(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSending(false);
    if (error) { toast.error(error.message); return; }
    setSent(true);
    toast.success("Check your inbox for the reset link");
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-amber-500/10">
              <Clock className="h-4 w-4 text-[var(--badge-amber)]" aria-hidden />
            </span>
            <CardTitle className="text-lg">Temporary password expired</CardTitle>
          </div>
          <CardDescription>
            The password an administrator issued for this account has passed its deadline and no
            longer works. Send yourself a reset link to set a new one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {email ? (
            <>
              <Button className="w-full" onClick={sendLink} disabled={sending || sent}>
                <Mail className="mr-2 h-4 w-4" aria-hidden />
                {sending ? "Sending…" : sent ? "Link sent" : `Email a reset link to ${email}`}
              </Button>
              {sent && (
                <p className="text-center text-xs text-muted-foreground">
                  The link expires shortly. If it does not arrive, check your spam folder or ask an
                  administrator to issue a new password.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              This account has no email address on file. Ask an administrator to issue a new
              password.
            </p>
          )}

          <div className="flex justify-center border-t border-border pt-4">
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden />
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
