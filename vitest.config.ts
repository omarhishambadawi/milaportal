import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Test configuration, deliberately standalone.
 *
 * It does NOT extend `vite.config.ts`. That file is built on
 * `@lovable.dev/vite-tanstack-config`, which pulls in the TanStack Start plugin,
 * Nitro, the MCP route generator and the PWA service-worker build — an entire
 * application build pipeline that the unit tests neither need nor should wait
 * for, and which regenerates route files as a side effect of being loaded.
 *
 * The only thing the tests need from Vite is the `@/*` path alias, so that is
 * declared here directly rather than by loading `vite-tsconfig-paths` (one fewer
 * plugin that can fail for reasons unrelated to the tests).
 */
export default defineConfig({
  /*
   * The agent workbook is a bundled asset, not JavaScript.
   *
   * `agent-workbook.server.ts` imports it with `?inline`; without this the test
   * loader tries to parse the spreadsheet as a module. Mirrors the same
   * declaration in `vite.config.ts` — the two configs are deliberately
   * standalone, so the one thing they share has to be stated twice.
   */
  assetsInclude: ["**/*.xlsx"],
  test: {
    // Node, not jsdom: every unit under test is a pure function over roles,
    // permissions and timestamps. Nothing renders, so a DOM would only add
    // startup cost and a dependency (jsdom/happy-dom) with no test to justify it.
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `describe`/`it`/`expect` are imported explicitly in each file rather than
    // injected as globals, so the test files typecheck under the app's own
    // tsconfig without widening its `types` array.
    globals: false,
    clearMocks: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
