/**
 * Guarded service worker registration.
 * Follows the built-in PWA skill: never register in dev, iframe, Lovable
 * preview hosts, or when the page URL carries ?sw=off. In those refused
 * contexts, unregister any stale /sw.js so old workers don't linger.
 */
export async function registerPwa(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  const isProd = import.meta.env.PROD;
  const inIframe = window.top !== window.self;
  const host = window.location.hostname;
  const isPreviewHost =
    host.startsWith("id-preview--") ||
    host.startsWith("preview--") ||
    host === "lovableproject.com" ||
    host.endsWith(".lovableproject.com") ||
    host === "lovableproject-dev.com" ||
    host.endsWith(".lovableproject-dev.com") ||
    host === "beta.lovable.dev" ||
    host.endsWith(".beta.lovable.dev");
  const killed = new URL(window.location.href).searchParams.get("sw") === "off";

  const refuse = !isProd || inIframe || isPreviewHost || killed;

  if (refuse) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        const url = r.active?.scriptURL ?? "";
        if (url.endsWith("/sw.js")) await r.unregister();
      }
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({ immediate: true });
  } catch (e) {
    console.warn("[pwa] registration failed", e);
  }
}
