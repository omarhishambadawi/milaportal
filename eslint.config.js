import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      ".nitro",
      ".vercel",
      ".wrangler",

      // Generated sources. Each is rewritten verbatim by its generator, so a
      // formatted copy survives only until the next run and then reappears
      // unformatted — turning `npm run lint` red for a change nobody made.
      // Kept in step with .prettierignore; see the rationale there.
      //
      // Written without brackets because `[.mcp]` is a character class in these
      // glob patterns, not a directory name.
      "src/routeTree.gen.ts",
      "src/integrations/supabase/**",
      "src/routes/mcp.ts",
      "src/routes/**/list-tools.ts",
      "src/routes/**/invoke-tool/**",
      "src/routes/**/oauth-protected-resource.ts",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",

      // `catch {}` with an explanatory comment is a deliberate idiom here: the
      // localStorage and theme reads are best-effort and must never break a
      // render if the browser refuses them. An empty block anywhere ELSE is
      // still an error.
      "no-empty": ["error", { allowEmptyCatch: true }],

      /**
       * Downgraded from error to warning, deliberately, as part of making lint a
       * CI gate.
       *
       * There are ~310 `any`s in the tree, nearly all of them casts on Supabase
       * query builders written before the generated `types.ts` covered those
       * tables. They are real technical debt and worth removing — but removing
       * them means editing every data-access module in the app, which is a
       * refactor, not a verification sprint, and it would bury the change that
       * actually matters here.
       *
       * As a warning the count stays visible in every lint run and in CI output
       * without blocking the pipeline, so the debt is tracked rather than either
       * hidden (`off`) or used as an excuse to never turn lint on (`error`).
       * Raise it back to `error` once the count reaches zero.
       */
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Test files may reach for `any` when feeding deliberately hostile values
    // into a function whose whole contract is that it refuses them.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  eslintPluginPrettier,
);
