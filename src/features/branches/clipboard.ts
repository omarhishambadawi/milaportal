import { toast } from "sonner";

/**
 * Copy text, with a fallback for the contexts where the async Clipboard API is
 * unavailable.
 *
 * `navigator.clipboard` requires a secure context. The portal is served over
 * HTTPS in production, but call-floor machines reach staging builds over plain
 * http on the LAN, where the modern API is simply absent — and "Copy Phone" is
 * the single most-used control on this page. The execCommand path is deprecated
 * and still the only thing that works there.
 */
export async function copyText(value: string, label: string): Promise<void> {
  const text = value.trim();
  if (!text) {
    toast.error(`Nothing to copy — this branch has no ${label.toLowerCase()}.`);
    return;
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`, { description: text });
      return;
    }
  } catch {
    // Permission denied or the document is not focused — fall through.
  }

  try {
    const staging = document.createElement("textarea");
    staging.value = text;
    // Off-screen rather than display:none — a hidden element cannot be selected.
    staging.setAttribute("readonly", "");
    staging.style.position = "fixed";
    staging.style.top = "-1000px";
    staging.style.opacity = "0";
    document.body.appendChild(staging);
    staging.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(staging);
    if (!ok) throw new Error("execCommand returned false");
    toast.success(`${label} copied`, { description: text });
  } catch {
    // Both paths refused. Showing the value is the honest fallback: the agent
    // can still select it by hand, which beats a silent failure mid-call.
    toast.error(`Could not copy automatically`, { description: text, duration: 10000 });
  }
}
