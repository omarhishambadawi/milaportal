// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { VitePWA } from "vite-plugin-pwa";
import { sep, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

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

// The PUBLIC Supabase values every build must be given, under either the
// VITE_-prefixed or the unprefixed name. Both are browser-safe by design — the
// published bundle already ships them to every visitor, and RLS is the security
// boundary (see .env.example). The service role key is NOT here and must never
// be: it bypasses RLS.
//
// There is deliberately no default. Hard-coded fallback values used to live here
// so a Lovable preview sandbox that had lost its .env would still boot (see
// commits b21a573, 093dbad). The cost of that safety net was that a build
// supplying neither name still succeeded, silently wired to whichever project
// the fallback named — and a working-looking application reading the wrong
// database is a far worse outcome than a build that stops.
const REQUIRED_PUBLIC_SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"] as const;

/**
 * Prefix for the self-hosted cutover values.
 *
 * Lovable's secret store refuses both spellings this build would otherwise want:
 * `VITE_*` because it treats those as build-time browser values belonging in a
 * `.env`, and `SUPABASE_*` because that prefix is reserved for its own managed
 * secrets. Neither restriction can be argued with from here, so the cutover
 * values arrive under names the platform has no opinion about, and this plugin
 * maps them onto the names the application already reads. Nothing downstream
 * changes — `client.ts` still reads `import.meta.env.VITE_SUPABASE_URL`.
 *
 * Precedence is deliberate: when a `MILAPORTAL_` value is present it **wins**,
 * including over a `VITE_SUPABASE_URL` that Lovable Cloud injected into the
 * sandbox `.env`. Without that, the server would move to self-hosted while the
 * browser bundle stayed on Cloud — a split that no single variable reveals.
 */
const SELF_HOSTED_PREFIX = "MILAPORTAL_";

function supabasePublicEnv(): Plugin {
  return {
    name: "supabase-public-env",
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
      const missing: string[] = [];
      const selfHosted: string[] = [];

      const selfHostedValue = (key: string) =>
        process.env[`${SELF_HOSTED_PREFIX}${key}`] || fileEnv[`${SELF_HOSTED_PREFIX}${key}`];

      // All or nothing. A build with the URL pointed at self-hosted but the key
      // still Cloud's (or the reverse) authenticates against one project with
      // another's credential, which surfaces as a confusing 401 rather than as
      // the configuration mistake it is.
      const overridden = REQUIRED_PUBLIC_SUPABASE_KEYS.filter((key) => selfHostedValue(key));
      if (overridden.length > 0 && overridden.length !== REQUIRED_PUBLIC_SUPABASE_KEYS.length) {
        const absent = REQUIRED_PUBLIC_SUPABASE_KEYS.filter((key) => !selfHostedValue(key));
        throw new Error(
          `Partial self-hosted Supabase configuration. Set ` +
            `${absent.map((k) => SELF_HOSTED_PREFIX + k).join(", ")} as well, or unset ` +
            `${overridden.map((k) => SELF_HOSTED_PREFIX + k).join(", ")} to stay on the ` +
            `Lovable-managed configuration. A half-applied override is never intended.`,
        );
      }

      for (const key of REQUIRED_PUBLIC_SUPABASE_KEYS) {
        const viteKey = `VITE_${key}`;
        const override = selfHostedValue(key);
        // Either name satisfies the requirement; the other is filled in from it.
        // A `MILAPORTAL_` value outranks both, including Lovable Cloud's own
        // injected `VITE_` value — that is the whole point of the prefix.
        const resolved =
          override || process.env[viteKey] || fileEnv[viteKey] || process.env[key] || fileEnv[key];

        if (!resolved) {
          missing.push(`${viteKey} (or ${key}, or ${SELF_HOSTED_PREFIX}${key})`);
          continue;
        }

        // Client + SSR bundles: inline when Vite's own env pipeline would otherwise
        // inline undefined — or, for an override, when it would otherwise inline the
        // Cloud value from the sandbox `.env`.
        if (override || !has(viteKey)) {
          define[`import.meta.env.${viteKey}`] = JSON.stringify(resolved);
        }

        // Same-process server readers (vite dev SSR): fill process.env gaps so
        // auth-middleware & friends see the values. The built Worker is covered
        // separately by hydrateServerEnv() in src/server.ts.
        //
        // An override assigns rather than gap-fills, and must also land on
        // process.env[viteKey]: Vite's own loadEnv() reads process.env ahead of
        // `.env` files, so this is what stops the Cloud value being re-inlined
        // regardless of how `define` merges.
        if (override) {
          process.env[key] = resolved;
          process.env[viteKey] = resolved;
          selfHosted.push(key);
        } else {
          if (!process.env[key]) process.env[key] = resolved;
          if (!process.env[viteKey]) process.env[viteKey] = resolved;
        }
      }

      // Server-only, and deliberately handled outside the loop above so it can
      // never be added to `define`: inlining a service-role key would publish an
      // RLS-bypassing credential to every browser.
      const serviceRoleOverride = selfHostedValue("SUPABASE_SERVICE_ROLE_KEY");
      if (serviceRoleOverride) process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleOverride;

      if (missing.length > 0) {
        throw new Error(
          `Missing Supabase environment variable(s): ${missing.join(", ")}. ` +
            `Set them in the build environment (see .env.example). There is no built-in ` +
            `default on purpose — a build must never be able to silently target a Supabase ` +
            `project nobody chose.`,
        );
      }

      if (selfHosted.length > 0) {
        // Names only. The values are a URL and an anon key, but this line exists to
        // make an override visible in a build log, not to print configuration.
        console.log(
          `[supabase-public-env] self-hosted override active for: ${selfHosted.join(", ")}`,
        );
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
    /*
     * The AlShrouq agent workbook is bundled, not read from disk.
     *
     * The deployment target is `cloudflare-module`, which has no filesystem, so
     * the one-time credential setup cannot `readFileSync` its source. Declaring
     * the extension lets `?inline` turn it into a base64 data URI inside the
     * **server** chunk — it is imported only from `agent-workbook.server.ts`,
     * which nothing in the browser graph reaches, and a build-output scan
     * asserts it never appears in `.output/public`.
     */
    assetsInclude: ["**/*.xlsx"],
    resolve: {
      alias: {
        // React Email's htmlparser2 path needs entities v4.5.0 (v5+ dropped
        // ./lib/decode.js). Pin every import to the hoisted v4.5.0 copy.
        "entities/lib/decode.js": resolve(rootDir, "node_modules/entities/lib/decode.js"),
        "entities/lib/encode.js": resolve(rootDir, "node_modules/entities/lib/encode.js"),
        entities: resolve(rootDir, "node_modules/entities"),
      },
    },
    plugins: [
      supabasePublicEnv(),
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
