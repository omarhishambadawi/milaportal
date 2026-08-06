// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { VitePWA } from "vite-plugin-pwa";
import { sep } from "node:path";
import { loadEnv, type Plugin } from "vite";

// Workaround for an upstream Windows-only bug in @lovable.dev/mcp-js (present in
// every version from 0.20.0 through 0.24.0, the current latest).
//
// Its `configResolved` hook takes `config.root` — which Vite always normalizes to
// forward slashes — and compares it against `path.resolve()` output, which uses
// native separators. The containment guard is
// `child.startsWith(parent + path.sep)`, so on Windows it compares
// "C:\...\src\routes" against "C:/.../msdailylog\" and can never hold; the plugin
// throws and neither `vite dev` nor `vite build` can start. On POSIX `sep` is "/"
// and the mismatch does not exist, which is why CI and the Lovable sandbox pass.
//
// Handing that one hook a root with native separators is behaviour-neutral: the
// plugin only feeds the value to path.resolve()/path.relative(), both of which
// accept either form and produce identical output. No-op off Windows.
function withNativeSepRoot(plugin: Plugin): Plugin {
  const original = plugin.configResolved;
  if (sep === "/" || typeof original !== "function") return plugin;
  // Mutate in place rather than spreading: the plugin exposes `api.mcpEntry` as a
  // getter that is finalized during configResolved, and a spread would snapshot it.
  plugin.configResolved = function (config, ...rest) {
    const nativeRoot = new Proxy(config, {
      // Receiver is the target, not the proxy, so any getters on the resolved
      // config still see their real `this`.
      get: (target, prop) =>
        prop === "root"
          ? String(target.root).split("/").join(sep)
          : Reflect.get(target, prop, target),
    });
    return (original as (...a: unknown[]) => unknown).call(this, nativeRoot, ...rest);
  } as Plugin["configResolved"];
  return plugin;
}

// Last-resort fallbacks for the three PUBLIC Supabase values, used only when the
// build environment supplies neither the VITE_-prefixed nor the unprefixed name.
//
// Why they can live in the repo: the URL, project ref, and anon/publishable key
// are browser-safe by design — the published bundle already ships them to every
// visitor, and RLS is the security boundary (see .env.example). The service role
// key is NOT here and must never be: it bypasses RLS.
//
// Why they exist at all: the Lovable preview sandbox periodically loses its .env
// (see commits b21a573, 093dbad — both "fixed" it sandbox-side only, so it kept
// regressing). When that happens the client bundle inlines `undefined` for
// import.meta.env.VITE_SUPABASE_* and the app dies on load with "Missing
// Supabase environment variable(s)". These fallbacks make any build of this repo
// self-sufficient; a real value in the environment always wins.
const PUBLIC_SUPABASE_FALLBACKS: Record<string, string> = {
  SUPABASE_PROJECT_ID: "gwnxlpophyvgafctrbkx",
  SUPABASE_URL: "https://gwnxlpophyvgafctrbkx.supabase.co",
  SUPABASE_PUBLISHABLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3bnhscG9waHl2Z2FmY3RyYmt4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NjI4NTIsImV4cCI6MjA5NzUzODg1Mn0.lQLEeZtmf9IQrINg2kWNiBu1MUjIaV7s40i5hGQUKa0",
};

function supabasePublicEnvFallback(): Plugin {
  return {
    name: "supabase-public-env-fallback",
    // `config` (not configResolved) so the returned `define` entries merge before
    // Vite finalizes env replacement. User/ambient env still wins: a define is
    // emitted only when neither the process env nor any .env file has the key.
    config(_config, { mode }) {
      const fileEnv = loadEnv(mode, process.cwd(), "");
      // Server-only vars (e.g. SUPABASE_SERVICE_ROLE_KEY) must reach process.env for
      // server routes such as the email queue/auth webhook. Never added to `define`.
      for (const [key, value] of Object.entries(fileEnv)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      const has = (key: string) => Boolean(process.env[key] || fileEnv[key]);

      const define: Record<string, string> = {};

      for (const [key, fallback] of Object.entries(PUBLIC_SUPABASE_FALLBACKS)) {
        const viteKey = `VITE_${key}`;
        // Prefer whichever real value exists under either name before falling back.
        const resolved =
          process.env[viteKey] || fileEnv[viteKey] || process.env[key] || fileEnv[key] || fallback;

        // Client + SSR bundles: inline only when Vite's own env pipeline would
        // otherwise inline undefined.
        if (!has(viteKey)) define[`import.meta.env.${viteKey}`] = JSON.stringify(resolved);

        // Same-process server readers (vite dev SSR): fill process.env gaps so
        // auth-middleware & friends see the values. The built Worker is covered
        // separately by hydrateServerEnv() in src/server.ts.
        if (!process.env[key]) process.env[key] = resolved;
        if (!process.env[viteKey]) process.env[viteKey] = resolved;
      }

      return Object.keys(define).length > 0 ? { define } : undefined;
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    resolve: {
      alias: {
        // React Email's htmlparser2 path needs entities v4.5.0 (v5+ dropped
        // ./lib/decode.js). Pin every import to the hoisted v4.5.0 copy.
        "entities/lib/decode.js": resolve(__dirname, "node_modules/entities/lib/decode.js"),
        "entities/lib/encode.js": resolve(__dirname, "node_modules/entities/lib/encode.js"),
        entities: resolve(__dirname, "node_modules/entities"),
      },
    },
    plugins: [

      supabasePublicEnvFallback(),
      withNativeSepRoot(mcpPlugin()),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: null,
        strategies: "generateSW",
        filename: "sw.js",
        manifest: false, // we ship our own /manifest.webmanifest
        devOptions: { enabled: false },
        workbox: {
          navigateFallback: null,
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,woff2}"],
          navigateFallbackDenylist: [
            /^\/~oauth/,
            /^\/_serverFn/,
            /^\/api\//,
            /^\/\.mcp\//,
            /^\/\.well-known\//,
          ],
          runtimeCaching: [
            {
              urlPattern: ({ request, url }) =>
                request.mode === "navigate" &&
                !url.pathname.startsWith("/~oauth") &&
                !url.pathname.startsWith("/_serverFn") &&
                !url.pathname.startsWith("/api/"),
              handler: "NetworkFirst",
              options: {
                cacheName: "html-navigations",
                networkTimeoutSeconds: 4,
                expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 },
              },
            },
            {
              urlPattern: ({ request, sameOrigin }) =>
                sameOrigin &&
                (request.destination === "script" ||
                  request.destination === "style" ||
                  request.destination === "font"),
              handler: "CacheFirst",
              options: {
                cacheName: "static-assets",
                expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              urlPattern: ({ request, sameOrigin }) =>
                sameOrigin && request.destination === "image",
              handler: "CacheFirst",
              options: {
                cacheName: "images",
                expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
