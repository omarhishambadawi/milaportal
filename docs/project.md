# MilaServ Portal — Project Documentation

> Single source of truth for this repository. Everything below was derived from the
> code, migrations and configuration present in the tree; nothing is assumed or
> carried over from external design documents.
>
> Package name: `tanstack_start_ts` · Product name in the UI: **MilaServ Portal**
> · Lovable template `tanstack_start_ts_2026-06-17` (`.lovable/project.json`).

---

## Project Overview

MilaServ Portal is an internal operations portal for a Saudi Arabian pharmacy
chain ("Shams" branch network, SAR pricing, ~145 branches). It unifies five
operational surfaces behind one authenticated application:

| Surface        | What it does                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**  | Sales, delivery, verification and complaint analytics over a date window, computed by server-side Postgres RPCs.                          |
| **Orders**     | The shared order book — create, edit, verify invoices, export.                                                                            |
| **Complaints** | A parallel record with its own status/resolution workflow.                                                                                |
| **Calls**      | Call-centre analytics computed from a Yeastar P-Series PBX (Overview, Customer Care, Telesales, Call Lookup, Diagnostics, Configuration). |
| **Branches**   | An operational branch directory with search, a spatial "nearest branch" locator, and a workbook importer with snapshot rollback.          |
| **Users**      | Role/permission administration with an append-only audit trail.                                                                           |

Cross-cutting characteristics visible in the code:

- **Authorization is per-permission, never by role rank.** `has_permission()` in
  SQL is authoritative; `src/lib/permissions.ts` mirrors it, and CI fails if the
  two drift (`scripts/check-permission-parity.mjs`).
- **Yeastar is the source of truth for call data; Supabase holds a mirror.**
  A background synchronization layer copies CDR rows the PBX has already emitted
  into `cdr_records` so the Calls surfaces read from Postgres instead of waiting
  on a live sweep. The mirror stores rows verbatim and derives nothing — the
  analytics pipeline sees identical input whichever tier answered. (Before that
  layer landed, CDR lived in per-isolate memory only; the OAuth token cache
  `yeastar_token_cache` and fetch-progress rows `cdr_progress` were the only PBX
  data on disk.)
- **Business timezone is centralized** at `Asia/Riyadh` (UTC+3, no DST) in
  `src/lib/timezone.ts`. Rows are stored in UTC.
- **Currency is SAR**, formatted by `fmtSAR` in `src/lib/branches.ts`.

---

## Architecture

```
Browser (React 19 SPA + SSR)
  │  supabase-js (anon key)  ──────────────────────────────►  Supabase PostgREST / Auth / Storage
  │      RLS is the boundary                                    (RLS + SECURITY DEFINER RPCs)
  │
  │  TanStack Start server functions (_serverFn RPC)
  │      Authorization: Bearer <supabase access_token>
  ▼
Nitro server entry  (src/server.ts)
  ├─ hydrateServerEnv(workerEnv)     reconcile VITE_/unprefixed env names
  ├─ TanStack Start server entry     SSR + server functions + server routes
  ├─ normalizeCatastrophicSsrResponse  recover h3-swallowed 500s
  └─ applySecurityHeaders            CSP (enforced + report-only), HSTS, etc.
        │
        ├─ requireSupabaseAuth middleware → { supabase (user-scoped), userId, claims }
        ├─ supabaseAdmin (service_role, RLS bypassed) — dynamic import only
        ├─ Yeastar OpenAPI client (server-only, two-tier token cache)
        │     └─ CDR: memory day cache → Supabase mirror → live PBX sweep
        │            (the sweep writes back to the mirror)
        └─ Google Maps Platform REST (server key, never bundled)
```

### Layering rules the code enforces

1. **`*.server.ts` and `client.server.ts` never reach the browser bundle.**
   `src/integrations/supabase/client.server.ts` is imported with
   `await import(...)` _inside handlers_, because route files and `*.functions.ts`
   ship to the client. Type-only imports of server modules are used where a type
   is needed (`import type { DiagnosticsReport } …`).
2. **Server functions are the only writers of privileged state.** Admin writes
   run under `service_role`, where `auth.uid()` is `NULL`; the actor-level rules
   ("only an Owner may act on an Owner") therefore live in
   `src/lib/admin.functions.ts`, while the _invariants_ live in database triggers.
3. **Every number the Customer Care dashboard renders comes from one engine.**
   `src/lib/yeastar/metrics-engine.ts` is a pure, synchronous module; components
   may format but never derive.
4. **Query keys are hierarchical** (`src/lib/query-keys.ts`) so
   `invalidateQueries({ queryKey: ["orders"] })` actually matches.

### Request flows

- **SSR page load** → `src/server.ts` → TanStack Start → `__root.tsx` shell →
  `AuthProvider` restores the Supabase session client-side.
- **Server function call** → `attachSupabaseAuth` (client middleware in
  `src/start.ts`) attaches the bearer token → `requireSupabaseAuth` verifies it
  with `supabase.auth.getClaims(token)` → handler runs its own permission check.
- **Direct data read** → `supabase.from(...)` / `supabase.rpc(...)` from the
  browser, bounded by RLS.

---

## Folder Structure

```
.
├── .claude/launch.json          dev (:8080) and preview (:4173) launch configs
├── .github/workflows/ci.yml     CI: bun install → typecheck → lint → perms → tests
├── docs/
│   ├── project.md               this file
│   └── yeastar/                 live PBX audit, field mapping, sprint reports, samples
├── public/                      icons, manifests, robots.txt
├── scripts/
│   ├── check-permission-parity.mjs   SQL ↔ TypeScript permission guard
│   └── yeastar-api-probe.mjs         endpoint capability sweep
├── src/
│   ├── assets/                  logo asset descriptors
│   ├── components/              app shell + shared widgets
│   │   └── ui/                  shadcn/ui (new-york style, 46 primitives)
│   ├── features/                feature modules (see below)
│   │   ├── branches/  call-center/  calls/  complaints/  dashboard/
│   │   ├── orders/    profile/      users/  yeastar-diagnostics/
│   ├── hooks/use-mobile.tsx
│   ├── integrations/supabase/   GENERATED: client, client.server, middleware, types
│   ├── lib/                     domain logic, server functions, shared utilities
│   │   ├── geo/  maps/  mcp/  pwa/  yeastar/
│   │   └── *.functions.ts       TanStack server functions
│   ├── routes/                  file-based routes (+ generated routeTree.gen.ts)
│   ├── router.tsx  server.ts  start.ts  styles.css
├── supabase/
│   ├── config.toml              CLI project ref
│   ├── migrations/              91 SQL migrations
│   └── verify/security_verification.sql
├── eslint.config.js  vite.config.ts  vitest.config.ts  vercel.json
└── AGENTS.md                    Lovable-managed block (do not rewrite history)
```

A **feature module** consistently contains: `components/`, `hooks/`,
`constants.ts`, `types.ts`, `utils.ts`, optional `export.ts` (XLSX), and
`__tests__/` for pure logic.

---

## Tech Stack

### Runtime & framework

| Concern         | Choice                                                                              |
| --------------- | ----------------------------------------------------------------------------------- |
| Framework       | TanStack Start `^1.167` + TanStack Router `^1.168` (file-based routing, SSR)        |
| UI              | React `^19.2` + React DOM `^19.2`                                                   |
| Build           | Vite `^8` via `@lovable.dev/vite-tanstack-config` `2.8.5`                           |
| Server runtime  | Nitro `3.0.260603-beta`; default preset `cloudflare-module`                         |
| Language        | TypeScript `^5.8`, `strict: true`, `moduleResolution: "Bundler"`, `@/*` → `./src/*` |
| Package manager | **Bun** (`bun.lock` is committed; `package-lock.json` is not)                       |

### Data & state

- `@supabase/supabase-js` `^2.108` — Auth, PostgREST, Storage, Realtime.
- `@tanstack/react-query` `^5.83` — server state. Defaults in
  `src/lib/query-client.ts`: `staleTime 60s`, `gcTime 10m`, `retry 1`,
  `refetchOnWindowFocus false`, mutations `retry 0`.
- `zod` `^4.4` — input validation at every server-function boundary.
- `react-hook-form` `^7.71` + `@hookform/resolvers` `^5.2`.

### Presentation

- Tailwind CSS `^4.2` via `@tailwindcss/vite`, `tw-animate-css`.
- shadcn/ui (`components.json`: style `new-york`, base colour `slate`, CSS
  variables, Lucide icons), built on ~25 Radix UI primitives.
- `recharts` `^2.15` for charts, `sonner` for toasts, `cmdk`, `vaul`,
  `embla-carousel-react`, `react-day-picker` `^9`, `input-otp`,
  `react-resizable-panels`.
- `date-fns` `^4`, `clsx` + `tailwind-merge` (`cn()` in `src/lib/utils.ts`).
- `xlsx` `^0.18` for report export.

### Platform integrations

- **Yeastar P-Series OpenAPI** (P570, firmware 37.23.x) — server-only client.
- **Google Maps Platform** — Geocoding / Routes, server key only.
- **Nominatim (OpenStreetMap)** — geocoding fallback, `connect-src` only.
- **MCP** — `@lovable.dev/mcp-js` `^0.20`, five tools over OAuth.
- **PWA** — `vite-plugin-pwa` `^1.3` (`generateSW`, `autoUpdate`) +
  `workbox-window`.

### Tooling

ESLint 9 (flat config) + typescript-eslint + prettier plugin + react-hooks +
react-refresh; Prettier (`printWidth 100`, double quotes, trailing commas, LF);
Vitest `^4.1` (node environment, `globals: false`).

---

## Application Flow

### Cold start

1. `src/server.ts` runs `hydrateServerEnv(env)` before anything reads
   `process.env`, filling gaps between `VITE_`-prefixed and unprefixed Supabase
   names (service-role key is deliberately **not** bridged).
2. TanStack Start renders `__root.tsx`. `THEME_INIT_SCRIPT` runs before hydration
   to set `class`/`color-scheme` on `<html>` (hence `suppressHydrationWarning`).
3. `applySecurityHeaders` wraps the response.

### Authentication and bootstrap

4. `AuthProvider` (`src/lib/auth.tsx`) subscribes to
   `supabase.auth.onAuthStateChange` and calls `getSession()`. On a session it
   loads the profile via the `get_my_profile()` SECURITY DEFINER RPC (so
   `permissions` / `yeastar_ext` stay unreadable through plain SELECT) and the
   caller's row from `user_roles`.
5. `/` (`routes/index.tsx`) redirects by permission precedence:
   `view_dashboard` → `/dashboard`, else `view_orders` → `/orders`, else
   `view_complaints` → `/complaints`, else "No permissions assigned."

### The `_app` gate (`src/routes/_app.tsx`)

Rendered in this order, and each is a property of the _account_, so navigating
elsewhere cannot bypass it:

1. `loading || !session` → "Loading…", and an effect redirects to `/auth`.
2. `profile.active === false` → **Account deactivated** screen + sign out.
3. `temporaryPasswordState(profile) === "expired"` → `TemporaryPasswordExpired`
   (rotates the credential away and offers recovery).
4. `temporaryPasswordState(profile) === "active"` → `ForcePasswordChange`.
5. Otherwise: sidebar + header + `<Outlet />`.

The navigation array is built from permissions (`hasPerm`, `canViewCallCenter`)
and from `callsTeamForRole`, so a team agent sees one Calls dashboard and no
module landing page.

### Data flow per page

Routes are thin. Each delegates to feature hooks:
`use*Filters` (URL/local state + permission flags) → `use*Data` /
`use*Metrics` (React Query) → `use*Mutations` (writes + invalidation) →
`export.ts` (XLSX). Dashboard and Orders read Postgres RPCs directly under RLS;
Calls, Users, Branch import and Geo go through server functions.

---

## Routing

File-based, `src/routes/`. `routeTree.gen.ts` is generated — never hand-edited.
Conventions are documented in `src/routes/README.md` (`$id` dynamic, `$` splat,
`{-$x}` optional, `__root.tsx` shell, `_app` pathless layout).

### Public routes

| Path              | File                 | Notes                                                                                                                                                                                    |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | `index.tsx`          | Permission-based redirect hub.                                                                                                                                                           |
| `/auth`           | `auth.tsx`           | Sign-in + "Forgot?". `validateSearch` accepts only a **same-origin relative** `next` (closes an open-redirect: `//evil.com`, `/\evil.com`, absolute URLs and `javascript:` are dropped). |
| `/reset-password` | `reset-password.tsx` | Recovery-link password set; calls `markPasswordChanged` best-effort.                                                                                                                     |

### Application routes (all under `_app`)

| Path                                                | Gate                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `/dashboard`                                        | `view_dashboard` (in-page)                                             |
| `/orders`, `/orders/new`, `/orders/$id`             | `view_orders` / `create_orders` / edit permissions                     |
| `/complaints`, `/complaints/new`, `/complaints/$id` | complaint permissions                                                  |
| `/calls`                                            | `canViewCallCenter`; team agents are redirected to their own dashboard |
| `/calls/overview`                                   | `canViewCallsPage(role, perms, "overview")` — hidden from team agents  |
| `/calls/customer-care`                              | `canViewCallsPage(…, "customer_care")`                                 |
| `/calls/telesales`                                  | `canViewCallsPage(…, "telesales")`                                     |
| `/calls/lookup`                                     | `canViewCallsPage(…, "lookup")` — deliberately unconfined              |
| `/calls/diagnostics`                                | `isAdministrator(role)`                                                |
| `/calls/configuration`                              | `isOwnerRole(role)`                                                    |
| `/branches`, `/branches/import`                     | `view_branches` / `admin_access`                                       |
| `/admin/users`                                      | `manage_users`                                                         |
| `/profile`                                          | any signed-in user                                                     |

### Retired routes kept as redirects

`/admin/branches` → `/branches` · `/admin/yeastar` → `/calls/diagnostics` ·
`/admin/yeastar-diagnostics` → `/calls/diagnostics` · `/call-center` →
`/calls/customer-care`. Each throws `redirect({ …, replace: true })` in
`beforeLoad` so bookmarks resolve instead of 404ing.

`/calls/analytics` (the Analytics Center) was **removed**, not redirected: it was
an administrator-only KPI-validation surface whose figures had to be typed in by
hand, and nothing else in the app linked to it.

### Server routes

| Path                                                                                           | Purpose                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/csp-report`                                                                              | CSP violation sink; parses both `report-uri` and Reporting-API bodies, caps at 64 KB, returns 204. Unauthenticated by design.                                                                                  |
| `/api/public/cdr-progress/$jobId`                                                              | **Not public despite the path.** Requires a Bearer token; job keys are namespaced `${userId}:${jobId}` so a guessed id reveals nothing.                                                                        |
| `/api/cdr-sync`                                                                                | Background CDR sync. `POST` advances one bounded run; `GET` reports state and never triggers. Authorized by `CDR_SYNC_SECRET` (constant-time compare, for a scheduler) **or** an administrator's bearer token. |
| `/mcp`, `/.mcp/list-tools`, `/.mcp/invoke-tool/$tool`, `/.well-known/oauth-protected-resource` | Generated by the `@lovable.dev/mcp-js` Vite plugin.                                                                                                                                                            |
| `/.lovable/oauth/consent`                                                                      | OAuth consent screen (`ssr: false`) for MCP authorization.                                                                                                                                                     |

Router options (`src/router.tsx`): `scrollRestoration: true`,
`defaultPreload: "intent"`, `defaultPreloadStaleTime: 0`.

---

## Authentication

**Provider:** Supabase Auth, email + password. There is no self-service sign-up —
the sign-in page states "Ask an administrator to create one."

**Client session** (`src/integrations/supabase/client.ts`): `localStorage`
storage, `persistSession: true`, `autoRefreshToken: true`. The exported
`supabase` is a lazy `Proxy` so the client is constructed on first property
access rather than at module load.

**Server verification** (`src/integrations/supabase/auth-middleware.ts`):
`requireSupabaseAuth` requires an `Authorization: Bearer <jwt>` header, verifies
it with `supabase.auth.getClaims(token)`, and puts
`{ supabase, userId, claims }` into handler context. The browser side attaches
the token via `attachSupabaseAuth`, registered as a global `functionMiddleware`
in `src/start.ts`.

**Password policy** (`src/lib/password-policy.ts`) — one definition used by both
the live UI checklist and the Zod schema every server function validates with:

- ≥ 8 characters, contains a letter, contains a digit, ≤ **72 bytes** (bcrypt
  truncates beyond that, so longer is rejected rather than silently cut).
- Temporary passwords: 14 characters from an alphabet excluding `O/0` and
  `I/l/1`, generated with `crypto.getRandomValues` and rejection sampling, one
  guaranteed character per group, Fisher–Yates shuffled. Generated in the browser
  because the admin must read it out; it reaches the server the same way a typed
  password does.
- TTL is a closed set: **24 or 48 hours**, default 48. The deadline timestamp is
  always computed server-side.

**Temporary-password state machine** (`temporaryPasswordState`):
`none` · `active` (flag set, deadline in the future) · `expired` (flag set with a
past deadline **or a NULL deadline**, the latter meaning "already rotated away,
recoverable only by email").

**Self-service paths** (`src/lib/profile.functions.ts`):
`changeMyPassword` verifies the current password **server-side** (a browser-only
check would be trivially skipped, which defeats the purpose of the prompt);
`markPasswordChanged` clears the forced-change gate after a recovery reset;
`expireTemporaryPassword` rotates an overdue credential to a random value.

Password verification (`src/lib/password.server.ts`) works by attempting a
sign-in on a throwaway `persistSession: false` client. It deliberately does
**not** call `signOut()` afterwards — supabase-js defaults that to _global_
scope, which would sign the user out of their own browser.

Recovery-email origin is derived from the incoming request
(`x-forwarded-host`/`host`, falling back to `SITE_URL`), never from a
client-supplied value.

---

## Authorization (RBAC)

### Roles (`public.app_role`, mirrored in `src/lib/roles.ts`)

| Role            | Summary                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner`         | Unrestricted. Protected: cannot be deleted, deactivated or demoted. Only an Owner mints an Owner.                                                                                                                  |
| `admin`         | Identical top-level privileges to Owner except anything touching an Owner.                                                                                                                                         |
| `supervisor`    | Near-administrator: holds `manage_users`, `admin_access`, `view_reports`. Withheld: `delete_orders`, `delete_complaints`, deleting a **user**, and all PBX/Yeastar surfaces.                                       |
| `customer_care` | Agent role; owns the complaint workflow.                                                                                                                                                                           |
| `telesales`     | Agent role; orders only, no complaints.                                                                                                                                                                            |
| `auditor`       | Read-only.                                                                                                                                                                                                         |
| `call_center`   | **Retired.** Still present in the enum (Postgres cannot drop an enum value without recreating the type), but no branch in `has_permission()`, rejected by `reject_retired_roles_trg`, and absent from `APP_ROLES`. |

`APP_ROLES` order drives the role filter dropdown only; it implies no hierarchy.
`ASSIGNABLE_ROLES` (UI dropdowns) excludes `owner`. `AGENT_ROLES` /
`AGENT_CODE_ROLES` = `customer_care` + `telesales` — only these carry an Agent
Code.

### Who may administer whom — `ROLE_ASSIGNABLE_BY`

An explicit table rather than numeric ranks, because the rule is deliberately
non-uniform:

```
owner        → owner, admin, supervisor, customer_care, telesales, auditor
admin        →        admin, supervisor, customer_care, telesales, auditor
supervisor   →                           customer_care, telesales, auditor
customer_care/telesales/auditor → (nobody)
```

An admin may administer another admin; a **Supervisor may not administer another
Supervisor**. `canActOnRole` additionally lets anyone who may administer agents
repair a user stranded on an unknown/retired role. `canAssignRole` refuses
retired values for everyone, including the Owner.

### Permissions (`ALL_PERMISSIONS`, 24 keys)

| Group                | Keys                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders               | `view_orders`, `create_orders`, `edit_orders`, `edit_all_orders`, `delete_orders`                                                                     |
| Complaints           | `view_complaints`, `create_complaints`, `edit_complaints`, `edit_all_complaints`, `delete_complaints`, `resolve_complaints`, `resolve_all_complaints` |
| Dashboard            | `view_dashboard`, `view_team_analytics`, `view_all_agents`, `view_call_center`, `export_reports`                                                      |
| Invoice Verification | `verify_own_orders`, `verify_all_orders`, `view_invoice_analytics`                                                                                    |
| Branches             | `view_branches`                                                                                                                                       |
| Administration       | `view_reports`, `manage_users`, `admin_access`                                                                                                        |

`manage_roles` was **removed**: it rendered a checkbox but was enforced nowhere,
and `has_permission()` short-circuits to true for owner/admin anyway, so
unticking it looked like a revocation that changed nothing.

### Evaluation model (identical in SQL and TypeScript)

1. No role → `false`.
2. `owner` / `admin` → `true` (short circuit).
3. Otherwise take the role's `_allowed` ceiling and `_defaults`.
4. If `profiles.permissions` is non-empty: `perm ∈ _allowed AND perm ∈ permissions`.
5. Else: `perm ∈ _defaults`.
6. Unknown/retired role → `false` (deny by default; `hasPerm` guards the lookup
   so an unmapped role returns false instead of throwing).

The ceiling is what makes per-user grants safe: a permission written into
`profiles.permissions` outside the role's `_allowed` list can never evaluate
true.

### Calls-module confinement (`src/lib/calls-access.ts`)

Team agents are pinned to their own team's dashboard. `UNCONFINED_PAGES` contains
exactly one page — **Call Lookup** — because it is a per-number contact history
rather than a dashboard: it aggregates nothing, ranks nobody, exposes no team's
performance. `canViewCallsPage` = `canViewCallCenter` **AND**
`callsPageAllowedForRole`. The module has no imports so the server functions can
apply the same rule (`callerCallsTeam` in `yeastar.functions.ts`).

### Escalation guards in `src/lib/admin.functions.ts`

| Guard                       | Prevents                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `assertCanManageUsers`      | Reaching user administration without `manage_users`. Routed through `has_permission()` so API and DB agree. |
| `assertAdmin`               | Non-administrators reaching destructive ops (`adminDeleteUser`, `adminListActivity`).                       |
| `assertMayActOnTarget`      | A non-Owner acting on an Owner (service_role means the DB cannot see who is acting).                        |
| `assertMayAdministerTarget` | A Supervisor resetting an admin's password, deactivating them, or rewriting their permissions.              |
| `assertMayAssignRole`       | `manage_users` becoming self-promotion.                                                                     |
| `assertPasswordConfirmed`   | Granting Owner without re-entering the acting Owner's password. Verified server-side.                       |

`getRole()` reads roles through `service_role` on purpose: an authorization check
that RLS can starve of the target's role would misjudge it.

Additional refusals: an Owner's role cannot be changed; an Owner cannot be
deactivated or deleted; you cannot delete your own account; you cannot issue
yourself a temporary password; an Agent Code is refused for non-agent roles.

### Auditor: allowed is wider than defaults

Every other role's `_allowed` and `_defaults` differ only where a permission is
grantable but off by default. The auditor's two lists used to be the *same*
array, which made "an administrator may grant this to one auditor" impossible to
express — anything grantable was automatic.

`20260813120000_shams_mis_permission.sql` splits them: `_auditor_safe` is the
ceiling, `_auditor_defaults` is what an auditor holds without an explicit grant.
`view_shams_mis` is the first key in the gap. In TypeScript the same split is
`AUDITOR_SAFE_READ_PERMS` (ceiling) vs `AUDITOR_PERMS` (defaults). Nothing else
about any role changed, and no table or policy was touched — the migration
replaces one function body.

The grant itself uses the existing mechanism: an explicit array on
`profiles.permissions`, edited in the Rules/Permissions UI. There is no list of
user ids anywhere.

### Parity guard

`npm run check:permissions` text-parses the newest migration that redefines
`has_permission()` and `src/lib/permissions.ts`, and asserts the per-role
permission _sets_ are identical for `supervisor`, `customer_care`, `telesales`,
`auditor` — including the auditor's ceiling and defaults as **two** comparisons.
It runs in CI between lint and tests.

---

## Database Schema

PostgreSQL on Supabase, `public` schema, PostGIS 3.3.x enabled. 91 migrations in
`supabase/migrations/`.

### `profiles`

`id` (PK, → `auth.users`), `full_name`, `agent_code`, `active`, `permissions
text[]`, `yeastar_ext`, `avatar_url`, `must_change_password`,
`must_change_password_expires_at`, `created_at`, `updated_at`.

Column grants are the real confidentiality boundary here:

- `authenticated` may `SELECT` only `(id, full_name, agent_code, active, created_at)`.
- `authenticated` may `UPDATE` only `(full_name, avatar_url)`.
- `INSERT`/`DELETE` revoked from `authenticated`.
- Everything else is read through `get_my_profile()` (own row) or `service_role`.

### `user_roles`

`id`, `user_id`, `role app_role`. `UNIQUE(user_id, role)`. `has_permission()`
resolves the role with `LIMIT 1` and no `ORDER BY`, so an account holding two
rows is nondeterministic — migrations that grant Owner delete other role rows
first.

### `orders`

`id`, `display_no` (unique, from `order_display_seq`, rendered `CC-…`/`TS-…`),
`order_date`, `team app_role` (`customer_care`|`telesales`), `agent_id`
(→ `auth.users`, `ON DELETE RESTRICT`), `order_type`, `branch_no`
(→ `branches.branch_no`), `delivery_type`, `invoice_no`, `invoice_value`,
`status`, `customer_name`, `customer_phone`, `notes`, `call_center_verified`,
`created_by` (→ `auth.users`, `DEFAULT auth.uid()` — who *entered* the order, as
opposed to `agent_id`, who owns it), `created_at`, `updated_at`.

Indexes include `orders_team_date_idx (team, order_date) INCLUDE (agent_id,
status, order_type, invoice_value)` and `orders_agent_date_idx (agent_id,
order_date) INCLUDE (…)` — index-only plans for the Calls conversion join.

Plus six `gin_trgm_ops` indexes (`orders_*_trgm_idx`) on the columns
`buildSearchOr()` and `orders_kpi_summary()` both search: `customer_name`,
`customer_phone`, `invoice_no`, `display_no`, `branch_no`, `notes`. A search
deliberately drops the date window, so what is left is a six-way OR of
`ILIKE '%term%'` — unindexable by btree, and therefore a sequential scan for the
page fetch, the KPI RPC and the export alike. All six columns are indexed and
not just the likely ones, because the planner can only turn the OR into a
`BitmapOr` if every branch has an index; one missing column sends the whole
disjunction back to a seq scan. Orders are typed in by hand, so the GIN write
cost is paid tens of times a day against a read that runs on every settled
keystroke.

### `complaints`

`id`, `display_no`, `complaint_date`, `agent_id`, `branch_no`, `category`,
`status`, `resolution`, `description`, `customer_name`, `customer_phone`,
timestamps. The list and export name their columns rather than `select("*")`,
leaving out `description` and `resolution` — the two unbounded text columns,
neither of which the table renders. Search is indexed the same way as `orders`:
six `complaints_*_trgm_idx` GIN indexes over `display_no`, `customer_name`,
`customer_phone`, `branch_no`, `category`, `description`.

### `order_activity` / `complaint_activity`

`id`, `order_id`/`complaint_id` (cascade), `actor_id`, `action`, `details jsonb`,
`created_at`. Written **only** by SECURITY DEFINER triggers; `INSERT` revoked
from `authenticated`, `UPDATE`/`DELETE` revoked from `service_role`
(append-only).

### `admin_activity`

`id`, `actor_id` (nullable — system actions), `target_user_id`, `action`,
`details jsonb`, `created_at`. No FK to `profiles` on purpose: the log must
outlive deleted accounts. Append-only by privilege.

### `branches`

`branch_no` (PK — the natural key operators use, e.g. `P0021`), `city`,
`phone`, `area_manager`, `area_manager_phone`, `email`, `address`, `maps_url`,
`latitude numeric(10,7)`, `longitude numeric(10,7)`,
`location geography(Point,4326)` **GENERATED ALWAYS … STORED**, `scooter bool`,
`scooter_note`, `working_hours`, `friday_hours`, `duty_hours numeric(4,1)`,
`active bool`, timestamps.

Everything added by the directory migration is nullable, because the source
workbook is hand-maintained (3 of 145 rows have no email, 4 rows are facilities
rather than pharmacies). Branches are **never deleted** — `orders.branch_no`
references them — so "remove" means `active = false`. Indexes:
`branches_active_idx`, `branches_city_idx`, and a partial GiST
`branches_location_gix … WHERE location IS NOT NULL`.

### `branch_imports`

`id`, `imported_by` (`ON DELETE SET NULL`), `imported_at`, `actor_role` (the role
**at import time**, denormalized so promotion does not rewrite history), `mode`
(`replace|merge|update|add|rollback`), `file_name`, `rows_total/added/updated/
removed/ignored/failed`, `validation_summary jsonb`, `snapshot jsonb` (full prior
table state), `snapshot_rows`, `reverted_from` (self-FK), `notes`,
`source_file`, `source_file_size`, `source_file_type`.

A snapshot rather than a diff: four import modes each touch a different subset,
and reversing a diff across all of them is far harder than restoring prior state.

### `notifications`

`id`, `user_id`, `kind`, `title`, `body`, `link`, `entity_type`, `entity_id`,
`read_at`, `created_at`. Inserted only by SECURITY DEFINER triggers.

### `order_stars`

`id`, `user_id` → `auth.users` (cascade), `order_id` → `orders` (cascade),
`created_at`. `UNIQUE (user_id, order_id)` — an agent cannot star the same order
twice, and that index is also how "my stars" is read, so there is no second one.

One agent's personal shortlist of orders. Deliberately a join table and not a
`starred` column on `orders`: the flag is per _agent_, and a column would make it
one shared value that the last agent to click won. No UPDATE grant and no UPDATE
policy — a star has no mutable field, so toggling is INSERT/DELETE.

### `satisfaction_surveys`

`id`, `call_id`, `agent_id`, `rating`, `comment`, `submitted_at`, `created_at`.

### `yeastar_extension_map`

`ext_num` (PK), `agent_name`, `agent_code`, `team`, `active`, timestamps.

### `yeastar_token_cache`

Single row (`id = 1`): `access_token`, `refresh_token`, `access_expires_at`,
`refresh_expires_at`, `obtained_at`, `blocked_until`, `block_reason`,
`updated_at`. This is the L2 half of the PBX token cache.

### `cdr_progress`

`job_id` (PK), `status`, `page`, `total_pages`, `records`, `total_reported`,
`message`, `error`, `updated_at`. `GRANT ALL … TO service_role` only — durable
progress across Cloudflare Worker isolates.

### `cdr_records` — the CDR mirror

`row_id` (PK), `call_id`, `ts bigint` (epoch seconds, UTC), `business_day date`,
`call_from_number`, `call_to_number`, `raw jsonb`, `synced_at`.

`raw` is the row exactly as the PBX emitted it, and is the only column anything
downstream reads — the rest exist to be indexed. That is what keeps the KPIs
unchanged: `classifyRecords` receives the same object whether it came from a live
sweep or from here.

`row_id` is the idempotency key. It is the PBX's own `new_id`, which is **row**-
unique on this firmware (`uid` and `call_id` are call-level and would collapse a
multi-leg call to one row), with a deterministic composite fallback for a row
that arrives without one. Every write is an upsert on it, so re-synchronizing an
overlapping window can never duplicate.

Indexes: `business_day`, `ts`, `call_id`, and `(call_from_number, business_day)` /
`(call_to_number, business_day)` — the two composites serve Call Lookup, which
filters one subscriber over a trailing window.

Read through `cdr_window_rows(date[])` and `cdr_rows_by_number(date, date,
text[])`, both service-role only. They exist so a window is one round trip rather
than ~16 pages of PostgREST offset paging — see "Window reads go through an RPC".

### `cdr_sync_days`

`business_day` (PK), `row_count`, `synced_at`. Which days the mirror covers,
**including days with zero calls** — without that a quiet day is
indistinguishable from a gap and would be re-swept forever. `synced_at` is also
the freshness signal: a day that has ended is immutable and serves at any age,
while today serves only inside the live TTL.

### `cdr_sync_state`

Single row (`id = 1`): `last_synced_epoch`, `last_run_at`, `last_status`,
`last_error`, `last_rows`, `last_days`, `lease_until`, `updated_at`.
`lease_until` is a single-writer lease claimed with a conditional UPDATE, so two
isolates racing produce exactly one sweep — overlapping runs would be _safe_
(the upsert makes them so) but would double PBX load, and token issuance is
rate-limited.

### PostGIS

`spatial_ref_sys` table plus the `geography_columns` / `geometry_columns` views
come with the extension.

---

## Supabase Functions

> "Functions" here covers both Postgres RPCs and the TanStack Start server
> functions, since both are part of the Supabase-backed API surface.

### Postgres functions (`public`)

**Authorization predicates** — all `SECURITY DEFINER`, `search_path = public`,
`EXECUTE` revoked from `anon`:

| Function                                | Returns                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `has_permission(_user_id, _permission)` | The authoritative permission oracle (per-role `_allowed`/`_defaults`).        |
| `has_role(_user_id, _role)`             | Exact role match.                                                             |
| `is_administrator(_user_id)`            | `owner` OR `admin`.                                                           |
| `is_owner(_user_id)`                    | `EXISTS` on an owner row.                                                     |
| `is_active(_user_id)`                   | `profiles.active`, default `false`. `SECURITY INVOKER`.                       |
| `get_my_profile()`                      | The caller's own full profile row, including columns no SELECT grant exposes. |

**Analytics RPCs** (`SECURITY INVOKER` — RLS applies), all taking
`_from, _to, _team, _agent, _mine`:
`orders_in_scope`, `orders_kpis`, `orders_kpi_summary` (adds `_status`, `_q`,
`_fulfillment`, `_starred`; returns `json`), `orders_daily`, `orders_status`, `orders_teams`,
`orders_agents`, `orders_locations`, `orders_delivery`,
`orders_delivery_matrix`, `orders_verification`; and for complaints
`complaints_in_scope`, `complaints_kpis`, `complaints_locations`.

#### The two scope functions return only what their callers aggregate

`orders_in_scope` is the single definition of the analytics filter — nine RPCs
select from it, and `complaints_in_scope` serves the other two. Both are
`SECURITY INVOKER`, so RLS on the base table is what decides which rows come
back, and both carry `SET search_path TO 'public'`.

That `SET` clause has a consequence worth knowing about: it makes a
set-returning SQL function **non-inlinable**
(`inline_set_returning_function()` refuses when `pg_proc.proconfig` is
non-null), so each of the eleven RPCs runs its scope function as an opaque
**Function Scan** — every qualifying row materialised into a tuplestore before
the caller aggregates it.

They used to be `RETURNS SETOF public.orders` / `SETOF public.complaints` doing
`SELECT *`, which made that tuplestore as wide as the widest column in the table.
They now return exactly the union of the columns their callers reference — nine
for orders, two for complaints — which leaves out `notes`, `customer_name`,
`invoice_no`, `description`, `resolution` and every other column no aggregation
reads. **The predicate, the security properties and every returned figure are
unchanged**; only the width of the intermediate result is.

Measured on PostgreSQL 18.3 with 120k synthetic orders (not production
hardware — see `20260818140000_narrow_analytics_scope.sql`), summing all nine
`orders_*` RPCs for one window:

| window    | rows in window | exec before | exec after | temp blocks before | temp blocks after |
| --------- | -------------- | ----------- | ---------- | ------------------ | ----------------- |
| 1 month   | 5,084          | 68.8 ms     | 57.3 ms    | 0                  | 0                 |
| 1 quarter | 15,088         | 291.2 ms    | 159.7 ms   | 22,212             | 0                 |
| 1 year    | 59,860         | 1,193.7 ms  | 761.8 ms   | 87,984             | 18,972            |

Shared buffer counts are **identical** before and after, which is the part worth
remembering: Postgres is a row store, so narrowing a projection saves no reads
against the heap. The win is that wide tuples fill `work_mem` sooner, and past
roughly fifteen thousand rows in the window the Function Scan starts spilling to
temp files. Narrowing the scope is what stops the spill.

A covering index over the nine analytic columns was measured and **rejected**:
it cut shared buffers 8.5x (5,451 to 639) but moved execution time about 5%,
because those buffers were already cache hits — for +34% on the table's index
footprint and only while the visibility map is fresh enough for an index-only
scan.

**Spatial:** `branches_nearby(_lat, _lng, _radius_m = 50000, _limit = 10,
_scooter_only = false)` — `SECURITY DEFINER`, granted to `authenticated` only,
`REVOKE ALL … FROM PUBLIC`. Uses `ST_DWithin` for the index-bounded predicate and
`<->` KNN ordering. Returns great-circle **metres**.

**Trigger functions:** `handle_new_user`, `set_order_display_no`,
`set_updated_at`, `log_order_activity`, `log_complaint_activity`,
`notify_on_order_change`, `notify_on_complaint_change`, `notify_users`,
`prevent_order_reassignment`, `prevent_profile_escalation`,
`protect_last_owner`, `protect_owner_profile`, `reject_retired_roles`,
`yeastar_try_claim_auth_lease`, `yeastar_release_auth_lease`.

### Triggers

| Trigger                                                 | Table        | Effect                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `on_auth_user_created`                                  | `auth.users` | Creates the profile row; **ignores client-supplied role metadata** and always writes the default.                                                                                                                                                                        |
| `trg_set_order_display_no`                              | `orders`     | Assigns `#<seq>` on insert.                                                                                                                                                                                                                                              |
| `orders_prevent_reassignment`                           | `orders`     | The real order-update authorization: `edit_all_orders` passes; auditors are refused outright; otherwise `agent_id`/`team` are immutable and the caller needs `edit_orders` on their own row, or a verification-only diff plus `verify_all_orders` / `verify_own_orders`. |
| `trg_prevent_profile_escalation`                        | `profiles`   | Refuses session-based writes to `agent_code`, `active`, `permissions`, `yeastar_ext`, `must_change_password*`, `id`. Only `auth.uid() IS NULL` (service_role) bypasses — the admin bypass was **removed**, not widened.                                                  |
| `trg_protect_last_owner`                                | `user_roles` | At least one Owner must always exist (covers the DELETE-then-INSERT that `adminSetRole` performs).                                                                                                                                                                       |
| `trg_protect_owner_profile`                             | `profiles`   | An Owner cannot be deactivated or deleted.                                                                                                                                                                                                                               |
| `reject_retired_roles_trg`                              | `user_roles` | Refuses `call_center` even from service_role or the SQL console.                                                                                                                                                                                                         |
| `trg_log_order_activity` / `trg_log_complaint_activity` |              | Append timeline rows.                                                                                                                                                                                                                                                    |
| `trg_notify_order` / `trg_notify_complaint`             |              | Fan out notifications.                                                                                                                                                                                                                                                   |
| `*_updated_at`                                          | several      | Maintain `updated_at`.                                                                                                                                                                                                                                                   |

### TanStack Start server functions

All use `.middleware([requireSupabaseAuth])` and a Zod `inputValidator`.

**`src/lib/admin.functions.ts`** — `adminCreateUser`, `adminSetActive`,
`adminSetRole`, `adminUpdateProfile`, `adminSetPassword`,
`adminSendPasswordReset`, `adminDeleteUser`, `adminListActivity`,
`adminListUsers`.
`adminListUsers` runs its three reads concurrently, paginates
`auth.admin.listUsers` (1000/page — a single call silently truncated past the
thousandth account) and mints avatar signed URLs in **one batched**
`createSignedUrls` call.
`adminListActivity` pages by _growing the limit_ rather than by offset or cursor,
because the log is append-only at the head; `ACTIVITY_MAX_ROWS = 500` bounds it.

**`src/lib/profile.functions.ts`** — `updateMyProfile`, `changeMyPassword`,
`markPasswordChanged`, `expireTemporaryPassword`.

**`src/lib/branches.functions.ts`** — `branchImportApply`, `branchUpdate`,
`branchImportHistory`, `branchImportLastFileMeta`, `branchImportLastFile`,
`branchImportRollback`. Import requires `admin_access`; rollback additionally
requires `is_administrator`.

**`src/lib/geo.functions.ts`** — `geoNearestBranches`, `geoGeocode`,
`geoReverseGeocode`. All gated on `view_branches`; they exist so the billable
Google server key never enters a bundle.

**`src/lib/surveys.functions.ts`** — `getSurveyAnalytics`.

**`src/lib/yeastar.functions.ts`** — 16 functions, see the Yeastar section.

### MCP tools (`src/lib/mcp/`)

`defineMcp` with `auth.oauth.issuer({ issuer: https://<projectRef>.supabase.co/auth/v1, acceptedAudiences: "authenticated" })`.
Tools: `whoami`, `list_orders`, `get_order`, `list_complaints`,
`orders_summary`. Each builds a per-request Supabase client with the caller's
bearer token, so **RLS is the boundary** — the tools grant nothing the user does
not already have. Free-text input passes through `normalizeSearchTerm`, which
strips `, % . * ( )` before it reaches a PostgREST `or=(...)` filter.

---

## Row Level Security Policies

RLS is enabled on every application table. Effective policy set (latest
definition wins where a migration replaced an earlier one):

### `orders`

| Command | Policy                                   | Predicate                                                                                                                             |
| ------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SELECT  | Orders visible by permission             | `is_active(uid)` **AND** (`view_orders` OR `view_dashboard` OR `view_reports` OR `view_invoice_analytics`)                            |
| INSERT  | Orders created by permitted active users | `uid = agent_id AND is_active(uid) AND create_orders`                                                                                 |
| UPDATE  | Orders updated by permitted users        | `is_active(uid)` AND (`edit_all_orders` OR own+`edit_orders` OR `verify_all_orders` OR own+`verify_own_orders`), same in `WITH CHECK` |
| DELETE  | Orders deleted by permitted users        | `delete_orders`                                                                                                                       |

### `complaints`

Same shape with `view_complaints` / `create_complaints` /
`edit_all_complaints` · own+`edit_complaints` · `resolve_all_complaints` ·
own+`resolve_complaints` / `delete_complaints`.

### `order_activity` / `complaint_activity`

SELECT only: `is_active(uid)` AND (the parent's view permissions OR an `EXISTS`
on owning the parent row). No INSERT/UPDATE/DELETE policy exists at all.

### `profiles`

One SELECT policy — _"Authenticated can view agent directory"_,
`USING (is_active(auth.uid()))` — carrying a `COMMENT ON POLICY` stating
explicitly that **row-level visibility is intentionally open and the real
boundary is the column grant**. The previously coexisting scoped policy was
dropped because `OR`-ing made it inert.
UPDATE: `"Users can update own profile"` (`auth.uid() = id`), bounded to
`(full_name, avatar_url)` by the column grant and by
`prevent_profile_escalation`.
`"Admins manage profiles"` covers the administrative path.

### `user_roles`

SELECT: `user_id = auth.uid() OR has_permission(uid,'manage_users') OR
has_permission(uid,'view_all_agents')`. ALL: `"Admins manage roles"`.
Consequence: `role` comes back `null` for most callers in
`useAgentDirectory`, and consumers must tolerate that.

### `branches`

SELECT: open to `authenticated`. ALL (write): `has_permission(uid,'admin_access')`.

### `branch_imports`

SELECT and INSERT both `has_permission(uid,'admin_access')` — reading history
means reading `snapshot`, a full copy of the branch table including area
managers' mobile numbers. No UPDATE/DELETE policy: append-only.

### `admin_activity`

SELECT: `is_administrator(auth.uid())`. No write policy;
`GRANT SELECT, INSERT … TO service_role` and `REVOKE UPDATE, DELETE` from both
roles.

### `notifications`

SELECT / UPDATE / DELETE: `auth.uid() = user_id`. **No INSERT policy** —
notifications come from SECURITY DEFINER triggers only.

### `order_stars`

SELECT / INSERT / DELETE: `auth.uid() = user_id` (INSERT as `WITH CHECK`, which
is what stops an agent creating a row owned by someone else). No UPDATE policy.
`REVOKE ALL FROM anon` and from `authenticated` before granting back exactly
SELECT/INSERT/DELETE, so the privilege list matches the policy list rather than
leaning on RLS to deny what a grant still permits.

**No administrator override, on purpose.** Every other per-agent table in this
schema opens up to `is_administrator` or `view_all_agents`; this one does not. A
shortlist is a note-to-self, no role has a reason to read another agent's, and
the isolation the feature promises is only as strong as its weakest policy.

### `satisfaction_surveys`

SELECT: `is_active(uid)` AND (`is_administrator` OR `view_all_agents` OR
`agent_id = uid`). INSERT: administrators.

### `yeastar_extension_map`

SELECT: any `authenticated`. ALL: `is_administrator(auth.uid())`.

### `cdr_progress`, `yeastar_token_cache`, `cdr_records`, `cdr_sync_days`, `cdr_sync_state`

`service_role` only; no `authenticated` grants. RLS is enabled with **no
policies at all**, which is the point for `cdr_records` in particular: call
records carry customer phone numbers, and the rules that govern them (per-team
confinement, agent auto-scoping) live in the Calls server functions. A direct
PostgREST read would bypass every one of them, so there is no path to one.

### Storage — `avatars` bucket

Private (`storage.buckets.public = false`). Four owner-scoped policies —
`avatars_owner_read` / `_insert` / `_update` / `_delete` — each
`bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text`.
The earlier `avatars_public_read` was dropped: it applied to `PUBLIC` (including
`anon`), so anyone holding the publishable key shipped in the client bundle could
read or sign **any** user's avatar, defeating the private bucket.

Bucket-level limits are enforced server-side: `file_size_limit = 4 MB`,
`allowed_mime_types = {image/png, image/jpeg, image/webp, image/gif}`. The
profile page's client-side checks constrain nothing on their own — the browser
also supplies `contentType` — and the ownership policies constrain _where_ a user
may write, never _what_.

`profiles.avatar_url` stores **only the object path**; short-lived signed URLs
(`AVATAR_SIGNED_TTL = 1 hour`) are minted at display time — client-side for your
own avatar, server-side under `service_role` for the admin user list (owner-scoped
storage RLS would otherwise stop an admin signing someone else's).

### Deliberate design decisions, recorded in-migration

- **Orders and complaints are an intentionally shared book.** `20260725004000`
  states that unscoped SELECT is a confirmed business decision (2026‑07‑25) and
  must not be "fixed" by a later audit. The corollary is written down too:
  `view_all_agents` is **not** a confidentiality boundary for order/complaint
  rows — it gates cross-agent _analytics_ only.
- **Deactivation withholds reads, not just writes.** `is_active()` was added to
  every SELECT policy because deactivating an account does not invalidate its
  session or password.
- **`anon` cannot execute the authorization RPCs** (`20260721000200`) — the
  publishable key is public, and these functions take an arbitrary `_user_id`,
  which made them an unauthenticated "is this account an administrator" oracle.

---

## Components

### App shell (`src/components/`)

| Component               | Notes                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-sidebar.tsx`       | Collapsible rail (76px ↔ 16rem), preference in `localStorage` under `milaserv.sidebar.expanded`, published as the `--app-sidebar-w` CSS variable so fixed overlays inside routes can sit beside it. Exports `resolveActivePath`, which resolves against children as well as top-level items.                       |
| `nav-flyout.tsx`        | Sub-menu rendered through a **portal to `document.body`**, positioned from the trigger's measured rect — the sidebar's `overflow-x-hidden` (required for the width animation) clips any `left-full` panel. Desktop = floating panel, mobile (`lg:hidden`) = inline accordion. Forgiving close with a grace period. |
| `app-header.tsx`        | Sticky title/icon, mobile menu trigger, account dropdown.                                                                                                                                                                                                                                                          |
| `brand-logo.tsx`        | Both light and dark marks stay mounted and cross-fade on `--theme-dark`, so the logo lands on the same frame as everything else.                                                                                                                                                                                   |
| `theme-toggle.tsx`      | Icons interpolate off `--theme-dark` rather than running their own transition.                                                                                                                                                                                                                                     |
| `role-badge.tsx`        | The single way a role is displayed. Owner gets a filled badge with a crown so it is never mistaken for an ordinary admin.                                                                                                                                                                                          |
| `user-avatar.tsx`       | Signed-URL avatar with initials fallback, five sizes.                                                                                                                                                                                                                                                              |
| `notification-bell.tsx` | Unread notifications with relative timestamps.                                                                                                                                                                                                                                                                     |
| `date-range-picker.tsx` | Presets: today, yesterday, last 7 days, this month, last month.                                                                                                                                                                                                                                                    |
| `password-input.tsx`    | One show/hide field used by all three password forms; real `<button>` with `aria-pressed` and a flipping `aria-label`.                                                                                                                                                                                             |
| `saudi-sales-map.tsx`   | Inline SVG heat map, no dependencies; collision-aware labels, reduced-motion aware. Shares the country outline with `src/lib/ksa-geo.ts`.                                                                                                                                                                          |

`src/components/ui/` holds 46 shadcn/ui primitives (accordion → tooltip),
unmodified in structure and consumed through the `@/components/ui/*` alias.

### Feature components (selection)

- **Dashboard:** `stat-card`, `dash-kpi-card`, `analytics-card`,
  `analytics-table` (+ `Thead/Tbody/Th/Td/EmptyRow`), `delivery-matrix`,
  `horizontal-bar-panel`, `sales-charts` (lazy) + `sales-charts-skeleton`,
  `section-title`. The four heavy panels — `delivery-matrix`,
  `horizontal-bar-panel`, `sales-charts`, `monthly-growth-section`, plus the
  shared `saudi-sales-map` — are `memo`ised, because the route re-renders once
  per aggregation query that settles (eleven of them) and each panel's props are
  `useMemo`d in `use-dashboard-data` / `use-monthly-growth`.
- **Orders:** `copyable-order-no`, `invoice-cell`, `kpi-card`, `order-row`
  (`memo`, one table row — see Orders Module → List), `order-form` (the whole
  create/edit form, shared by `/orders/new` and `/orders/$id`),
  `order-activity-timeline`, `status-badge`, `team-badge`.
- **Complaints:** `complaint-form`, shared by `/complaints/$id` and
  `/complaints/new` for the same reason as `order-form`.
- **Users:** `users-table`, `users-toolbar`, `users-stat-cards`,
  `users-pagination`, `user-row-actions`, `create-user-dialog`,
  `edit-user-dialog`, `password-dialog`, `grant-owner-dialog`,
  `permission-editor`, `activity-log-dialog`.
- **Branches:** `branch-card`, `branch-list`, `branch-search-bar`,
  `sticky-search-bar`, `branch-filter-bar`, `branch-stats`,
  `branch-locator-panel`, `branch-preview-panel`, `branch-edit-dialog`,
  `import-preview-panel`, `import-history-table`, `scroll-to-top`.
- **Call centre:** `hero-kpi`, `kpi`, `chart-card`, `chart-primitives`,
  `call-trend-charts`, `telesales-trend-charts`, `call-distribution`,
  `agent-performance-table`, `conversion-by-agent-table`, `top-agents`,
  `team-comparison`, `queue-members`, `unanswered-calls-dialog`,
  `dashboard-section`, `section-header`, `info-banner`, `empty-window-notice`,
  `fetch-progress`.
- **Profile:** `change-password-card`, `force-password-change`,
  `temporary-password-expired`.

---

## Hooks

### Global

- `useAuth()` — `{ session, user, profile, role, loading, signOut, refresh, hasPermission }`.
- `useTheme()` — `light`/`dark`, `useSyncExternalStore`-backed, persisted at
  `milaserv.theme`.
- `useIsMobile()` — `matchMedia` at a 768px breakpoint.
- `useAgentDirectory({ enabled })` (`src/lib/directory.ts`) — one shared key
  (`["agent-directory"]`) replacing what used to be four separate copies of the
  same profiles + user_roles fetch.

### Dashboard

`use-dashboard-filters` · `use-dashboard-data` (11 aggregation queries + their
transforms; supports `restrictAgentIdentity`, which anonymises other agents'
names for roles without `view_all_agents` while leaving the ranking intact, and
`sections`, which gates each query's `enabled` so a consumer reading five of the
eleven pays for five — omitting it means all eleven, which is what the Dashboard
itself does) ·
`use-dashboard-export-data` (`enabled: false`, fetched via `refetch()`) ·
`use-monthly-growth` (the monthly comparison timeline — one `orders_kpis` call
per month per team through `orderKpisQuery`, combined with the historical
baseline).

### Orders

`use-orders-list-filters` · `use-orders-list-data` (paginated page fetch with
`keepPreviousData`, the `orders_kpi_summary` RPC, per-row enrichment) ·
`use-orders-mutations` · `use-orders-export` ·
`use-orders-scroll-restoration` (returns to the edited row, below) ·
`use-starred-orders` (per-agent stars in `order_stars`; optimistic toggle) ·
`use-order-form`.

### Users

`use-users-filters` · `use-users-list` · `use-users-mutations` (every write
returns `true`/`false` so callers close or keep a dialog open; the **only**
writer of the admin-users cache) · `use-admin-activity`.

### Branches

`use-branch-directory` (fetches the whole active table once — at ~145 rows it is
smaller than a page of orders, and local search is the only way to answer a
keystroke in under a frame; explicitly excludes the `location` WKB column) ·
`use-branch-filters` · `use-branch-locator` · `use-branch-import` ·
`use-branch-prefs` · `use-directory-freshness` · `use-virtual-rows`.

### Call centre

`use-call-center-filters` (owns the per-page permission gate via
`canViewCallsPage`) · `use-call-center-analytics` · `use-customer-care-metrics`.

---

## Services

### Server-function modules

`admin.functions.ts` · `profile.functions.ts` · `branches.functions.ts` ·
`geo.functions.ts` · `surveys.functions.ts` · `yeastar.functions.ts`.

### Supabase clients

- `client.ts` — browser/SSR anon client, lazy `Proxy`.
- `client.server.ts` — `service_role` client, **RLS bypassed**. Only ever
  imported dynamically inside a handler.
- `auth-middleware.ts` — `requireSupabaseAuth`.
- `auth-attacher.ts` — `attachSupabaseAuth` (client-side token attachment).

All four carry an "automatically generated — do not edit" banner and are excluded
from ESLint and Prettier.

### Geo Service (`src/lib/geo/`)

Provider-agnostic and pure. `index.ts` is the only import surface.

- `types.ts` — `LatLng`, `Bounds`, `DistanceResult`, `DistanceSource`
  (`road` | `straight-line`), `GeoAddress`, `NearbyBranch`, `RankedBranch`.
- `coordinates.ts` — `KSA_BOUNDS`, `KSA_CENTER`, validation, parsing, centroids.
- `distance.ts` — `haversineMetres`, formatting.
- `ranking.ts` — `rankByDistance` over a pluggable `DistanceProvider`.
- `maps-url.ts` — directions/navigation/multi-stop URL builders (`MAX_WAYPOINTS`).
- `distance-engine.server.ts` — **the Distance Engine**: narrow in the database
  (`branches_nearby`, GiST index), then rank the top _N_ candidates with the
  Google Routes API. If routing is unavailable the straight-line ordering
  stands and the result is labelled `straight-line` so the UI can hedge its
  wording. Takes a `NearbyQuery` callback rather than a Supabase client, so it
  depends on neither Supabase nor the generated types.
- `src/lib/maps/` — `config.ts` (server key, `MAPS_REGION = "SA"`, Routes API
  URL) and `google.server.ts`. There is **no client-side Maps SDK** in the app
  today; the browser key is read nowhere.

### Yeastar service (`src/lib/yeastar/`) — see the dedicated section below.

### MCP service (`src/lib/mcp/`) — five read-only tools behind OAuth.

---

## Shared Utilities

| Module                                       | Responsibility                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/utils.ts`                               | `cn()` — `clsx` + `tailwind-merge`.                                                                                                                                                                                                                                                  |
| `lib/timezone.ts`                            | `BUSINESS_TIMEZONE = "Asia/Riyadh"`, `BUSINESS_UTC_OFFSET_MINUTES = 180`. Fixed a real bug where timelines formatted in UTC+2 while call analytics bucketed in UTC+3.                                                                                                                |
| `lib/branches.ts`                            | `ORDER_TYPES` (Cash, Wasfaty), `DELIVERY_TYPES` (AlShrouq, Store Pickup, Branch Scooter, Azman), `STATUSES`, `COMPLAINT_STATUSES`, `TEAMS`, `STATUS_STYLES`, `CURRENCY = "SAR"`, `fmtSAR`, `formatOrderNo`, `stripOrderPrefix`.                                                      |
| `lib/query-keys.ts`                          | Hierarchical key factory; every entity has a real `all()` invalidation boundary. Lookups live under their own root so an order write does not refetch the directory.                                                                                                                 |
| `lib/query-client.ts`                        | `QUERY_DEFAULTS` / `MUTATION_DEFAULTS`, each option carrying its rationale.                                                                                                                                                                                                          |
| `lib/supabase-paginate.ts`                   | `fetchAllPaginated` — PostgREST caps a response at 1000 rows; safety ceiling 200k.                                                                                                                                                                                                   |
| `lib/security-headers.ts`                    | Enforced CSP (`frame-ancestors`, `base-uri`, `object-src`, `form-action`) + a full report-only CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS over TLS only, `Report-To` + `Reporting-Endpoints`. Never weakens an existing header. |
| `lib/server-env.ts`                          | `hydrateServerEnv` — bridges `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID` across the `VITE_` boundary. The service-role key is deliberately absent from `BRIDGED_KEYS`.                                                                                         |
| `lib/error-capture.ts` / `lib/error-page.ts` | Capture the original `Error` out-of-band and render a dependency-free 500 page.                                                                                                                                                                                                      |
| `lib/floating-card.ts`                       | Pure viewport arithmetic for hover cards, unit-tested rather than hover-tested.                                                                                                                                                                                                      |
| `lib/ksa-geo.ts`                             | 57-vertex Saudi outline + the shared equirectangular projection.                                                                                                                                                                                                                     |
| `lib/avatar.ts`                              | `AVATAR_BUCKET`, `AVATAR_SIGNED_TTL`, `isStoragePath`, `avatarObjectPath` (also extracts a path out of legacy long-lived signed URLs). Import-free so both bundles can use it.                                                                                                       |
| `lib/audit-log.ts`                           | Client-safe half of the audit trail: page size, `ACTIVITY_MAX_ROWS`, `AUDIT_ACTION_LABEL` (`satisfies Record<AuditAction, string>`), `SENSITIVE_AUDIT_ACTIONS`.                                                                                                                      |
| `lib/pwa/register.ts`                        | Guarded service-worker registration; refuses dev, iframes, Lovable preview hosts and `?sw=off`, and unregisters stale workers there.                                                                                                                                                 |
| `lib/theme.tsx`                              | `ThemeProvider`, `THEME_INIT_SCRIPT` (pre-hydration, prevents the flash), `useTheme`.                                                                                                                                                                                                |

---

## Dashboard Module

**Route:** `/dashboard` · **Gate:** `view_dashboard`

### Chart motion (`chart-motion.ts`)

One module owns every Dashboard chart's enter animation: `ease-out`, 550–700ms,
`animationBegin: 0`, nothing looping, bouncing or scaling. `buildChartMotion` is
a pure function of `(reduced, forceStill)` so the contract is unit-tested rather
than checked by eye; `usePrefersReducedMotion` makes reduced-motion still, and
`forceStill` does the same for the PDF export.

`animationBegin` is carried explicitly because **Recharts defaults it to 400 for
`Pie` and 0 for everything else**. A preset that set only the duration therefore
left the pie starting four tenths of a second after the rest of the page — the
one panel that looked like it had stalled.

`useSettledChartMotion(identity)` is what stops the restarts. Recharts wraps each
series in `<Animate key={"bar-" + animationId}>`, and `animationId` is the
chart's internal `updateId`, which `generateCategoricalChart` increments on any
**width or height** change — not only on a data change. So every
`ResponsiveContainer` measurement remounted the `<Animate>` at `t = 0`, and at
`t = 0` a bar has zero height and `Rectangle` returns `null` outright: dragging a
window edge blinked ten panels out and redrew them. `updateId` is internal and
there is no prop to disable it.

Instead, animation is treated as a property of *having just received data*. The
presets are armed for one entrance after `identity` changes and then go still;
once still, Recharts takes its static render path and draws the series at full
size on every subsequent render, so a resize, a hover, a tooltip or a parent
re-render repaints instantly and cannot restart anything. A later data change
re-arms it, and because Recharts keeps the previous series as `prevData` that
second animation interpolates old → new rather than from zero. `identity` must be
the memoised series array — a fresh literal each render would re-arm every render
and defeat the whole mechanism.

Eleven independent aggregation queries plus an on-demand export dataset, all
keyed under `queryKeys.dashboard.*` so one `dashboard.all()` invalidation sweeps
them. Every aggregation is a Postgres RPC (`SECURITY INVOKER`, so RLS applies),
not a client-side reduction:

| Panel                                | RPC                      |
| ------------------------------------ | ------------------------ |
| Headline KPI cards                   | `orders_kpis`            |
| Daily trend                          | `orders_daily`           |
| Status breakdown                     | `orders_status`          |
| Team comparison                      | `orders_teams`           |
| Top agents by sales                  | `orders_agents`          |
| Sales by location (+ Saudi heat map) | `orders_locations`       |
| Delivery method                      | `orders_delivery`        |
| Fulfillment mix                      | `orders_delivery` (same) |
| Delivery matrix                      | `orders_delivery_matrix` |
| Invoice verification                 | `orders_verification`    |
| Complaint KPIs                       | `complaints_kpis`        |
| Complaints by location               | `complaints_locations`   |

Filters: date range (presets + custom), team, agent. `restrictAgentIdentity`
anonymises other agents' names for roles without `view_all_agents`, while the
ranking, the values and the chart layout stay exactly as they are.

`sales-charts.tsx` is `lazy()`-loaded behind `SalesChartsSkeleton`. Export
(`features/dashboard/export.ts`) writes a multi-sheet XLSX from a query with
`enabled: false`, fetched only when the button is pressed.

### Delivery methods

**One question, answered once.** This was two tables that between them answered
it twice: a five-column "fulfillment mix" whose rows were Delivery / Store Pickup
/ Total, and a four-column "method performance" whose rows were the couriers — in
which Store Pickup appeared _again_, now as one method among four. A reader had
to hold the first in their head to make sense of the second.

`components/delivery-methods-section.tsx` is one argument in three steps:

1. **KPI strip** (3 tiles) — completed orders, then Delivery and Store Pickup,
   each with its share and its completed sales.
2. **Fulfillment mix** — a 100% split bar, then each side broken into Cash and
   Wasfaty as labelled proportion bars, with that side's sales and average order
   value underneath.
3. **Method performance** — the couriers ranked by completed orders, volume set
   at display size with sales, AOV and a completion-rate badge as supporting
   figures, and a share bar per row.

Then one **Key insight** card of at most two computed tiles, in the same
figure-and-label shape the Monthly performance insights use.

**The visualisation is CSS, not Recharts.** A 100% stacked bar of two segments is
three divs and reads instantly at any width; routing it through the charting
library would buy a tooltip and cost a lazy boundary. Recharts is untouched by
this section.

**It costs no query.** `orders_delivery` carries `completed_count`,
`completed_cash_count`, `completed_wasfaty_count` and `completed_sales`; the whole
section is a fold over the four rows the Dashboard already fetches, using the same
`classifyFulfillment` every other surface reads. No second definition, no second
round trip, no client-side pass over the orders table. `summarizeFulfillment` also
sums `completedSales` per side, which is what the sales figures and the two
average-order-value comparisons are derived from.

`delivery-analytics.ts` holds the derived half — `rankMethods`,
`averageOrderValue`, `buildDeliveryInsights` — and is pure, so
`__tests__/delivery-analytics.test.ts` pins it to the live figures the section was
designed on (731 completed = 657 delivered + 74 collected; AlShrouq 611, Store
Pickup 74, Branch Scooter 46).

Two things it deliberately does not render. Percentages are taken against
**classified** orders rather than the grand total, which is what makes Delivery% +
Pickup% come to exactly 100; an order whose method was never recorded sits outside
the denominator and is stated as a footnote, only when the count is non-zero. And
a method that completed nothing is dropped from the ranking rather than shown as a
permanent zero — the same reasoning. A method whose `completed_count` is _absent_
(pre-migration `null`) keeps that null to the cell rather than rendering as 0,
which would read as a courier that delivered nothing.

Both figures the old table got wrong stay corrected: completed orders come from
`completed_count`, not `order_count` (every status), and the completion rate is
labelled as the proportion of that method's own orders that completed rather than
as a "share of sales".

### Monthly performance

**Gate:** `view_team_analytics` (not merely `view_dashboard`) — the section
compares Customer Care with Telesales against a team-wide historical baseline, and
for a viewer whose rows RLS narrows to their own, the live months would be one
agent's work sitting in a table beside whole-team history. Same gate as the team
filter, for the same reason.

**Read in ten seconds, not read in full.** The first cut of this section rendered
every figure the analytics layer can produce in three wide tables — eleven
columns, then ten, then seven — which is a data dump, not a management view. It
is now a hierarchy, and the order is the argument:

1. **KPI strip** (5 tiles) — total revenue, revenue growth, completed orders,
   order growth, average order value, all for the **last complete month**, named
   above the strip. No tile repeats another's number: the value tiles carry the
   previous month's figure (`from SAR 445.3K`), the growth tiles carry the
   comparison month (`vs Jun 2026`).
2. **Charts** — revenue trend, revenue mix, MoM growth, order volume.
3. **Team performance** and **Revenue drivers**, side by side. The first is two
   tiles plus a share-of-revenue bar; the second is Cash against Wasfaty by
   revenue Δ, order Δ and average order value, with one computed sentence naming
   the driver.
4. **Monthly trend** — five columns (Month, Revenue, MoM, Orders, Avg order) with
   a Combined / Customer Care / Telesales toggle.
5. **Key insights** — at most three tiles, each a figure and what it is.

| File                                    | Role                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `features/dashboard/monthly-growth.ts`  | Pure: the historical baseline, month arithmetic, every derived rate, the insights and formatters. |
| `features/dashboard/kpis-query.ts`      | `orderKpisQuery` — the shared `orders_kpis` options factory (also used by both Reports hooks).    |
| `hooks/use-monthly-growth.ts`           | Baseline + live months, via `useQueries({ combine })`.                                            |
| `components/monthly-growth-section.tsx` | KPI strip, team performance, revenue drivers, trend table, insights.                              |
| `components/monthly-growth-charts.tsx`  | The four Recharts panels, behind the section's own Suspense boundary.                             |

**Number formatting is part of the design**, and lives in
`features/dashboard/format.ts` because two sections share it. `formatCompactSAR`
gives `SAR 747.5K` / `SAR 1.2M` / `SAR 274`; `formatGrowth` gives one signed
decimal (`+67.9%`); `formatPercent` an unsigned one (`89.9%`); `formatCount` never
abbreviates an order count (`2,727`, not `2.7K`). Full precision belongs in the
chart tooltips (`fmtSAR`) and the export, where there is room to be exact.
`components/kpi-tile.tsx` is the shared tile both strips are built from.

**No migration, no new table, no second source of truth.** February–June 2026
predates the orders table as an authority and is a typed constant
(`HISTORICAL_MONTHLY`); July 2026 onward (`LIVE_DATA_START`) is fetched with the
Dashboard's own `orders_kpis` RPC, one call per month per team, under
`queryKeys.dashboard.kpis` — the Dashboard's own cache entries, so the section and
the headline cards cannot disagree. Only `completed_sales` / `completed_count` are
read; `status = 'Completed'` stays defined once, in SQL. The live window is
`LIVE_DATA_START … current month`, so future months appear by themselves.

Three deliberate behaviours:

- **Absent is not zero.** Telesales did not exist before April 2026, so those
  months carry no Telesales row, never a `0` — which would put a −100% in the
  growth column. A team's growth is measured against the previous month **that
  team has data for**, so April is Telesales' first month and has no rate at all
  (`—`). A live team-month with zero completed orders is likewise treated as
  absent. On a team-scoped trend table the absent months are simply not listed,
  rather than a column of `N/A` down to April.
- **Not scoped by the date picker.** The subject is the whole timeline, and the
  baseline is whole-month, team-wide, agent-less. Slicing only the live half by an
  arbitrary window would put two different questions in one table; the subtitle
  says so rather than silently ignoring the filter.
- **The running month is flagged.** Its row is marked "In progress" and
  `buildInsights` reads the last _complete_ month — "revenue fell 74%" on the 8th
  is an artefact of the calendar, not an insight.

**One supplied figure does not reconcile.** June 2026 Telesales was given as Cash
56,748.31 + Wasfaty 107,474.89 against a stated total of 188,985.39 — a 24,762.19
gap, and the business's own +86.90% validation is measured on the stated total.

The stated total therefore stays authoritative for revenue, growth and average
order value (`MonthTeamTotals.totalRevenue` exists only for this case), and the
difference **is not modelled**. There are exactly two payment channels —
`ORDER_TYPES` is `["Cash", "Wasfaty"]` — and a residual from a supplied
spreadsheet is not a third one. An earlier cut derived an `unallocatedRevenue`
and charted it as an "Unallocated" segment, which put a category the business
does not have in front of users; that derivation is gone, not hidden. The mix
chart reads `cashRevenue` and `wasfatyRevenue` directly, so for that one month
its bar is marginally shorter than the total reported beside it — which is the
honest rendering of a source discrepancy, and a standing reason to reconcile the
June Telesales figure at source.

Every other month reconciles exactly, which `__tests__/monthly-growth.test.ts`
asserts along with all fifteen supplied figures, all six validated growth rates,
and the absence of any residual field on the derived metrics.

---

## Reports Module

**Route:** `/reports` · **Gate:** `view_reports`

Two reports that were being produced by hand — the evening WhatsApp summary and
a monthly Excel workbook — generated from the figures the portal already holds.

`view_reports` already existed and already drew the line the business asked for:
owner, admin, supervisor and auditor hold it, neither agent role does. No new
permission and no new role were added; `__tests__/access.test.ts` pins that so a
future edit to the role tables cannot quietly hand an agent the whole network's
monthly sales.

### It computes nothing

This is the module's defining constraint. `features/reports/daily.ts` and
`monthly.ts` are pure, take figures the Dashboard's RPCs and the Calls module's
analytics already produced, and **rearrange** them. A report that recomputed its
own totals would be a second source of truth for numbers management already reads
on the dashboard, and the first evening the two disagreed the report is the one
that would be believed.

Concretely: order figures come from `orders_kpis`, fulfillment from
`summarizeFulfillment`, the Missed/Abandoned split from
`resolveQueueOutcomeSplit`. None of the three is reimplemented here.

The one piece of arithmetic the daily report does own is the brief's own rule —
**Total Sales = Cash + Wasfaty** — taken over the two type buckets rather than
read off the `total` bucket, which can include an order whose type is neither and
would make the four lines above it fail to add up in front of the reader.

### Daily report

Customer Care and Telesales side by side, then the combined total. Rendered twice
from one `DailyReport` value: the cards on screen and the plain text in the copy
box, so the message and the preview cannot drift. The card order follows the
message order, because the preview exists so the sender can check at a glance
that what they are about to paste is what they are looking at.

The message is three labelled sections — **Customer Care**, **Telesales**,
**Total** — separated by a rule of U+2500 box-drawing characters. It carries the
same figures the hand-typed report always did and no new arithmetic; what changed
is that the two teams and the total no longer run together as one block, which is
how a phone notification preview used to render them.

The text is deliberately not Markdown — WhatsApp renders `*bold*` and swallows
stray asterisks, so anything that looked like formatting would arrive as either
formatting or debris in whichever app it is pasted into. Emphasis is carried by
structure: upper-case headings, rules, a bullet per figure, an arrow on the line
that matters. `__tests__/daily.test.ts` pins the output byte for byte, asserts the
three sections are genuinely separated, and asserts no character WhatsApp treats
as markup survives.

Four queries, two per team: `orders_kpis` and the Calls module's own analytics,
both keyed under the namespaces those modules already use, so a window the
Dashboard or a Calls page has loaded is a cache hit rather than a second fetch.
They run only while the Daily tab is the one on screen — see **Fetching**, below.

**Basis** selects what the day's figures count. The default is every order logged
that day, because that is what the manual report has always counted — it goes out
the same evening, when most of the day's orders are not yet marked complete, and
counting only completed ones would report a fraction of the day's trading as the
day's trading. Completed-only is offered for a report re-run against a closed day,
and the message says so when it is used.

A PBX outage degrades rather than fails: the call lines are flagged as unavailable
and the Supabase-derived sales half still renders. A report whose call figures
read zero because Yeastar was down, sent as though they were real, is worse than
one that says so.

### Monthly report

KPI summary → team performance → charts → call centre → order mix → trend
highlights → branch and geography.

**KPI summary** is the eight figures a management summary quotes: total revenue,
completed revenue, total orders, completed orders, overall completion rate,
average order value, revenue lost (non-completed) and the top city by revenue.
Revenue lost is `totalSales − completedSales` — a subtraction of two figures
already on the page, not a second count of cancelled and pending value, so it
cannot disagree with the RPC's own definition of completed. Each team then gets
its completed revenue, completed orders and completion rate called out above the
full comparison table.

**Charts** (seven, in `components/monthly-charts.tsx`): revenue by team, the daily
revenue trend, revenue by city, top branches, order status distribution, revenue
share by delivery company, and Cash vs Wasfaty revenue. Every series is shaped in
`useMonthlyReport` from buckets the tables above them already render — the
revenue-by-team chart reads the two per-team `orders_kpis` rows rather than
`orders_teams`, so there is one figure for "Telesales revenue" on the page and not
two that could drift. The ranked charts cap at ten; the full lists stay in the
tables.

**Call centre** carries Customer Care total calls, Telesales total calls and
conversion rate, and the network total. The per-team split comes out of the single
whole-network analytics response's own `teamCompare`, so it costs no query and
uses the same extension-to-agent mapping and team classification as every Calls
page. The network total is that response's own total rather than the two teams
added — a call from an unmapped extension belongs in the total and in neither
team. Conversion is Telesales only (`conversion.overall.conversionRate`, orders ÷
answered) and is the one figure that needs the orders join, which is why the
Telesales analytics query is the only one the report runs with `includeOrders`.
An absent rate renders as an em dash, never as 0%.

Percentages divide by the population they are read against — the two teams'
contributions against the month's completed revenue, Cash and Wasfaty against
their own pair's sum — so each set reaches 100 rather than nearly 100. Trend
highlights exclude days that never traded and count them separately: a public
holiday is not the month's worst trading day, and letting it take that label
buries the day that genuinely underperformed.

All seven charts sit behind **one** `lazy()` boundary. Recharts is the largest
dependency the app ships and the Daily Report — which is what the page opens on —
has no chart in it at all; seven boundaries would mean seven chunks and seven
cards popping into a grid at different moments.

The reference workbook (`Shams Call Center June Sales.xlsx`) informed **which**
KPIs are worth showing and nothing else. It is not recreated, converted or
imported; its eleven sheets were mostly working-out, and the portal does the
working-out.

### Fetching

Two decisions keep this page from being the slowest in the portal, and both are
about **not asking** rather than about caching harder.

**Only the visible tab fetches.** `Tabs` is controlled and each hook takes
`active`; Radix already unmounts the hidden tab's markup but cannot stop a hook
the route called. Before this, opening `/reports` issued nineteen requests —
including a month-wide CDR sweep — to render a tab that shows four figures.

**The monthly report asks `useDashboardData` for five of its eleven
aggregations.** `sections` gates each query's `enabled`; passing nothing means all
eleven, which is what the Dashboard does and what the hook did before the option
existed. The report reads `kpis`, `daily`, `status`, `locations` and `delivery`;
the agent ranking, the delivery crosstab, invoice verification and both
complaints aggregations were being fetched, parsed and discarded on every visit.
The keys, RPCs and derivations are untouched, so a section a caller switched off
still reads from cache if the Dashboard has already fetched it.

Everything else was already right and was left alone: the queries are independent
and React Query runs them in parallel, the global `staleTime` is 60s with every
write path invalidating `queryKeys.dashboard.all()`, and `resolveRefreshPolicy`
already stops polling a closed window.

### PDF export

`window.print()` — the browser's own writer over the real DOM, so text stays
selectable and charts stay vector. That was always the right architecture; what
the document lacked was any print geometry at all, which is the whole of the
cropping and overflow that used to come out of the Monthly Report. See the
`@media print` block at the foot of `src/styles.css`:

- **`@page { size: A4 portrait; margin: 14mm 12mm 18mm }`.** There was no `@page`,
  so the writer used its own margins over a layout still carrying the app shell.
- **The shell hides itself.** The rail and the top bar carry `print:hidden`; the
  sidebar was taking a sixth of every sheet and narrowing the report column to
  match, which is what pushed the charts and the nine-column team table off the
  right edge. `main` and its content wrapper drop their padding and their
  `overflow-x-clip`, which on paper is literally a crop rather than a reflow.
- **Nothing is cut mid-card.** Cards and chart panels carry `break-inside-avoid`,
  table headers repeat via `display: table-header-group`, and the major sections
  start on a fresh sheet.
- **Dark mode does not reach paper.** The `.dark` palette block is scoped to
  `@media screen`, so a PDF exported from a dark session falls back to the `:root`
  light values rather than needing all fifty-two tokens restated.
- **Branding.** `components/print-chrome.tsx` adds a masthead on the first sheet
  and a footer at the end of the report. The footer was `position: fixed` so the
  renderer would repeat it per sheet; Chromium does repeat fixed elements, but it
  resolves their offsets against the first page box, so it landed across the
  **top** of pages two and three, over the section heading and the first card.
  Once, at the end, is reliable. There is no page number either: Chromium
  implements neither `@page` margin boxes nor `counter(page)`, and its own print
  options already offer one.

**2. Charts were measured against the screen and printed onto paper.**
`ResponsiveContainer` learns its size from a `ResizeObserver`, whose callback is
delivered before the _next_ frame's paint, while `window.print()` is synchronous —
so the writer received an SVG still carrying the monitor's dimensions.

The first attempt corrected that in CSS, forcing `width: 100%` onto Recharts SVGs,
and made it worse in two ways. `svg.recharts-surface` matches every _legend icon_
as well as the chart, so each 14px dot was blown up to the width of its legend
item — those were the giant circles over the plot area. And scaling a chart laid
out at 1400px into a 703px page halves its axis labels with it. **There is now no
chart CSS in the print block at all.** Instead:

- `features/reports/print-width.ts` states the printable width — A4 less the
  `@page` side margins, 703 CSS px.
- The export handler pins the report to that width, waits two animation frames so
  React can commit and the observer can fire, and only then calls `print()`. The
  chart is already the right size when the page is handed over, so nothing needs
  correcting afterwards.
- Print therefore has **no second layout**. At 703px the responsive classes
  already give one-column grids and a two-across KPI strip, so what is measured is
  what is printed. Print-only column counts were removed for exactly that reason:
  a chart measured against one layout and rendered into another is how it clipped.
- `useChartMotion(forceStill)` switches the enter animations off for the export.
  Recharts animates from the baseline and a print is one instant — it captured
  whichever frame the animation was on, which for a bar starting at zero is a
  chart with axes, a grid, a legend and no data in it.
- `MonthlyReportView` takes `printing` and drops each table's `minWidth` floor.
  `AnalyticsTable` applies that as an inline style, which no `print:` class can
  override, so a 760px floor inside a 703px page printed the nine-column team
  table sliced off at the right edge with a scrollbar under it.

Validated by rendering the real artefact rather than trusting the build: headless
Chrome `--print-to-pdf` over the report yields A4 portrait (MediaBox 595×842pt)
across ten pages, with every legend icon back at 14×14, zero elements past the
703px page width, all five tables inside it, and axis labels at their native
11.5px.

The daily report keeps its **separate print rendering** — one table instead of two
cards and a textarea, because a textarea prints as a grey box with a scrollbar.

### No Excel export

The Monthly Report exports to **PDF only**. A four-sheet XLSX export existed
briefly and was removed at the owner's request: the report's value is its charts
and its layout, and the community build of `xlsx` can carry neither — cell styling
and embedded charts are SheetJS Pro features — so the workbook was a plainer copy
of a document the PDF already delivers.

`xlsx` remains a dependency and is untouched elsewhere: the Dashboard export,
the Orders export and the Branches import/export are genuinely tabular and still
use it.

---

## Orders Module

**Routes:** `/orders`, `/orders/new`, `/orders/$id`

### List

Server-side pagination (`range` + `count`), `keepPreviousData` so a filter change
never blanks the table, and a single `orders_kpi_summary` RPC for the KPI strip.
Filters: date range, team, agent, status, **fulfillment**, "mine only",
**"starred only"**, free-text search — all composable, all applied server-side
through one `applyOrderFilters`. Page size (25/50/100) persists at
`orders.pageSize`.

**The page fetch names its columns** (`ORDER_LIST_COLUMNS` in
`features/orders/constants.ts`), rather than `select("*")`. The five it leaves
out are the five the table has no cell for — `created_at`, `created_by`,
`updated_at`, `delivery_type` and `notes` — and `notes` is unbounded free text,
so at 100 rows a page it was routinely the largest part of the response. Sorting
is unaffected: the ORDER BY runs in Postgres whether or not the key is
projected. `ORDER_EXPORT_COLUMNS` does the same for the XLSX export, which walks
the whole filtered set in 1000-row batches.

**Each row is a `memo`ised `OrderRow`.** The markup is unchanged; it is a
component so that React can skip it. Every re-render of the page — a keystroke
in the search box (which re-renders on every character, ahead of the 300ms
debounce that gates the *query*), opening a filter dropdown, a background
refetch settling, the return highlight arming and disarming — used to re-render
all 25-100 rows, each carrying a Radix `Select`, two tooltips and a copy button.
The memo only pays off if the props are stable, so that is enforced at the
source: `updateStatus` / `canEditOrder` are `useCallback`ed in
`use-orders-mutations`, `toggleStar` reads the shortlist through a ref in
`use-starred-orders` so it does not change identity when a star is toggled, and
`openOrder` is `useCallback`ed on the route's stable `navigate`.

**Page header**, split into two groups by a hairline divider:

- **Scope — All orders · My orders · Starred.** What set am I looking at.
  All/My were one button that swapped its own label, so the state you were _not_
  in was invisible; they are two buttons now, `variant="default"` on the active
  one. Starred joins them because it names a set of orders rather than a
  property to filter them by. It is a separate `aria-pressed` toggle rather than
  a third segment of the pair: it **narrows** whichever of All/My is selected,
  and a third segment would promise a mutual exclusivity it does not have.
- **Actions — Export Excel, New order.** Export is here rather than in the
  filter bar because it acts on what the filters have already selected rather
  than being one of them, and in the bar it was the only control on a second
  row, so the container carried a row of empty space to hold one button.

The header stays on one row down to 720px; the group wraps rather than
overflowing below that.

**Filter bar** — Search · Team · Agent · Status · Delivery & Pickup · Date. One
row of `h-10` controls at ≥1150px of content width (it was ≥1280 before Starred
moved to the header), two below that, never three; `p-2.5 sm:p-3` around them,
since it is a strip of controls rather than content. Search is the primary
control and is built to look it — it takes the leftover width (capped at
`max-w-md`) and lifts its shadow on focus — while keeping the same radius,
border and focus ring as everything beside it.

Contrast, measured against the compiled CSS in both themes (light / dark):
active Starred label 2.3 / 9.4, its count badge 16.3 / 16.5, inactive badge
5.4 / 6.1, search text 16.5 / 15.1. The badge is a **solid** chip when active —
`primary-foreground/20` on the primary fill measured 1.01:1, a count you cannot
read. The 2.3 on the active label is the `variant="default"` pairing itself
(white on brand turquoise), shared with New order and every other primary button
in the app; it is recorded here rather than fixed, since changing it is an
app-wide design-system decision, not an Orders one.

### Returning from an order

`use-orders-scroll-restoration` puts the agent back on the row they left, which
matters most for the agents working the bottom of a long list.

**The router was the thing scrolling to the top, and no amount of restoring
fixed it.** `scrollRestoration: true` installs an `onRendered` subscriber
(`@tanstack/router-core/scroll-restoration`) that looks the incoming location up
in a sessionStorage cache keyed by `location.state.__TSR_key`; finding nothing,
it falls through to `window.scrollTo({top: 0})`. Saving ends in
`navigate({ to: "/orders" })` — a **push**, so a new key, so a guaranteed cache
miss, so a guaranteed jump to the top on every single save. An earlier version of
this hook tried to out-race it with two `requestAnimationFrame`s, which at best
converted one jump into two. The three navigations back to the list (save,
delete, cancel) now pass **`resetScroll: false`**, which sets
`router.resetNextScroll` and makes that subscriber return before touching the
viewport.

With nothing else moving the page, the restore runs in a **`useLayoutEffect`** —
after the DOM holds the new rows, before the browser paints them — so there is no
frame at the wrong position. No timeout, no rAF: both only ever existed to win
that race.

`rememberOrderReturn(orderId)` is called by the row action **before** navigating,
capturing the id, `window.scrollY` **and the row's offset from the top of the
viewport**. Reading it there is the point: opening the much shorter edit form
clamps the scroll offset, so the position is already gone by the time the agent
returns. Restoring the _viewport offset_ rather than the raw scroll is what makes
the return seamless — the row lands back under the agent's eye even when the save
reordered the list. Measured in a browser against the real module: rows removed
above, rows inserted above, and no change at all all land the row within 1px of
where it was, where a raw `scrollY` restore drifts by 267px and 356px in the
first two.

The wait is commit-driven, not timed. The effect keys on `rowsKey` (the rendered
row ids), so it re-runs after every commit that changes the table and always
searches a DOM that holds the latest render, and on `settled` (`!isLoading &&
!isFetching`), which is what distinguishes _not yet_ from _not here_: a missing
row mid-fetch leaves the restore armed for a later commit, while a missing row
once the query has settled means the order moved page or its own update filtered
it out, and the remembered offset applies instead. `decideRestore`,
`scrollTopForRow` and `isRowVisible` are that policy and its arithmetic as pure
functions, pinned by `__tests__/scroll-restoration.test.ts`.

Two cases the geometry cannot honour, both handled: a row sorted to the very top
cannot sit 300px down a page that will not scroll above 0, and a list the save
made much shorter clamps the scroll. Both are caught by re-measuring after the
scroll and falling back to `scrollIntoView({ block: "center" })`, so the
guarantee that survives is the one that matters — the edited order is on screen.

Filters, search, date, Starred and page are preserved independently, by the
module-level filter cache in `use-orders-list-filters`, so the list the agent
comes back to is the one they left.

One twelve-column table at every width, scrolled sideways below `min-w: 1240`.
Three of those columns carry state rather than a field:

- **Call Centre** (col 1) — read-only, derived, three states
  (`components/call-centre-cell`). It used to be a checkbox an agent could tick,
  which made a claim the row cannot support: the channel is a property of the
  *document*, and since `record_invoice_verification` re-derives the flag on
  every reconciliation a disagreeing tick would be silently overwritten. The
  cell is a `span` with a tooltip now — nothing to press.

  The third state is the point. `call_center_verified = false` meant both "not
  checked yet" and "checked, and it is a walk-in invoice", and those want
  opposite treatments; `invoices_verified` separates them:

  | State      | Condition                                     | Row                             |
  | ---------- | --------------------------------------------- | ------------------------------- |
  | `pending`  | `!invoices_verified`                          | muted dash, no tint             |
  | `verified` | `call_center_verified`                        | success tick, success rail      |
  | `walk_in`  | `invoices_verified && !call_center_verified`  | warning icon, rail, faint tint  |

  Only the warning case tints the row, at ~5.5% destructive. The old positive
  tint (`--tint-row`, 15% turquoise across every verified row) is gone: on a
  page where most orders are verified it lit up most of the table at once, which
  made the one row worth looking at harder to find rather than easier. The tick
  carries the positive state.
- **Star** (col 2) — `useStarredOrders`, below. Per agent, in `order_stars`.
- **Invoice No.** — every invoice on the order, one per line
  (`components/invoice-cell`). It used to show the first with a "+2" pill, which
  hid the numbers agents reconcile against all day. The column is sized for a
  six-digit number, so extra invoices grow the row's height, not the table's
  width. Deliberately no copy button: invoice numbers are copied continuously,
  and a hover affordance on every row of the most-read column was noise.

### Starred orders

`hooks/use-starred-orders` reads and writes `order_stars` (schema and RLS above).
This began as localStorage keyed by user id, which scoped stars per agent but
also per _browser_ — an agent who starred an order on the call-floor machine saw
nothing of it on their laptop. Postgres makes a star follow the account.

Isolation is RLS, not the hook. Every policy is `auth.uid() = user_id`, so a bug
in this file degrades to showing an agent nothing, never to showing them somebody
else's shortlist.

The toggle is optimistic and **does not invalidate on settle**: the write is one
id added or one id removed, exactly what `onMutate` already applied, so a refetch
could only re-fetch the answer the cache holds. The error path restores the
previous set and toasts. A `23505` on insert is swallowed — the unique constraint
firing means the star this click asked for already exists, which is the state the
caller wanted (two tabs on the same list).

`order_stars` is **not in the generated Supabase types**, so the queries cast the
table name. That file is re-emitted by Lovable and a hand-edit is lost on the next
sync; the codebase already casts for `orders_kpi_summary` for the same reason.

### Starred only — the filter

A toggle in the Orders page header beside All/My orders (same `Star` icon as the
column, with a count), not a separate page or nav item. Its position is
presentation only — it is still one `starredOnly` flag on `useOrdersListFilters`,
and it composes with every other filter because it is applied through the same
`applyOrderFilters` they are:

- **The list** narrows with `id IN (…)` built from the agent's star set, so
  pagination and the exact count stay server-side. An empty set is passed through
  as `id IN ()` rather than falling through to the unfiltered list — an agent who
  has starred nothing has no starred orders, and showing them the whole range
  would be the wrong answer.
- **The KPI cards** narrow through `orders_kpi_summary(_starred)`, which resolves
  the set from `auth.uid()` server-side. The predicate had to reach both: adding
  it to only the table would put a list and a total on the same screen describing
  different sets of orders, which is the defect `order_fulfillment()` exists to
  have ended.
- **The export** inherits it, since it shares `applyFilters`.

The star set's identity (`starKey` in `OrdersFilters`) is part of the query key,
and empty whenever the filter is off — so starring an order while filtered
refetches the narrowed page, and starring one while unfiltered refetches nothing.
`useStarredOrders` is called inside `useOrdersListFilters` rather than the route
because the ids must be in hand where `applyFilters` is built.

### Fulfillment — one definition, three surfaces

`features/orders/fulfillment.ts` is the **single source of truth** for delivery
vs store pickup. `orders.delivery_type` records only the _method_ — AlShrouq,
Azman, Branch Scooter, Store Pickup — and nothing recorded whether a method _is_
a delivery, so every caller re-derived it and the derivations drifted.

`classifyFulfillment` is three cases: blank → `null`, contains `"pickup"`
(case-insensitive) → `pickup`, otherwise → `delivery`. The asymmetry is
deliberate — _pickup_ is a closed concept whose wording the business controls,
_delivery_ is open, so a courier signed next quarter counts the day it appears in
the data with no code change.

**Blank is `null`, not a delivery**, and that was the bug. The list query used
PostgREST `not(delivery_type, ilike, '%pickup%')`, which reads as "not a pickup"
but under SQL's three-valued logic means "known not to be a pickup" — for a row
with no method, `NULL NOT ILIKE x` is NULL, so the row was dropped. The
`orders_kpi_summary` RPC beside it wrote `COALESCE(delivery_type,'') NOT ILIKE …`
and counted that same row as a delivery. The table and the KPI cards above it
were totalling different sets of orders, which is what "the Delivery/Pickup filter
is not working" actually was. Both now state the null and blank cases explicitly
and land in neither group.

`public.order_fulfillment()` (migration `20260808120000_orders_fulfillment.sql`)
is the SQL mirror, and exists only because a PostgREST filter cannot call into
TypeScript. `__tests__/fulfillment.test.ts` pins both to one table of values.

`FULFILLMENT_OPTIONS` offers the question at two resolutions in one control: the
two groups, then each individual method. Group values go through the classifier;
method values are the stored `delivery_type` verbatim, so filtering to one courier
is an equality test that cannot disagree with the group containing it. Selecting
**Delivery** therefore spans AlShrouq, Azman and Branch Scooter — nothing in
that predicate names a courier at all, which is what guarantees it. The individual
options are derived from `DELIVERY_TYPES`, so a method added to the order form
becomes filterable without a second edit. Methods appear under their stored name;
`METHOD_LABEL` overrides only where a shorter word means the same thing ("Branch
Scooter" → "Scooter"). It used to relabel the stored "AlShrouq" as "El Shorouk",
which named a courier no other surface — the order form, the export, the
Dashboard mix — knew about; the stored value was always `AlShrouq` and is
unchanged.

### Form

`orderFormSchema` (Zod): `order_date`, `team`, `order_type`, `customer_name`,
`customer_phone`, `branch_no` (**required**), `delivery_type` (**required**),
`invoice_no`, `invoice_value` (coerced, non-negative, nullable), `notes`,
`status`, `agent_id` (optional), `call_center_verified` (optional).

The payload itself is built by **`buildOrderPayload`** (pure, in
`features/orders/payload.ts`), not by spreading form state. Editing an order and
changing only its value failed with
`delivery_type: "Delivery / pickup method is required"` — on orders that have
one; all 4344 rows do, and the column is granted to `authenticated`, so the
value was never missing from the *order*, only from form state at submit. That
can happen for more than one reason (a save before the fetch resolved, a stale
`setForm({...form})` closure captured on an earlier render), so the rule is about
shape rather than any one field: **a required field left blank is never a user's
intention** — the UI cannot produce one, every such control being a `Select` or
picker with no empty option — so for an existing order the persisted value backs
it. Optional fields deliberately do the opposite: blank means blank and is sent
as null, or a customer name could never be cleared. A new order has nothing to
fall back to and still fails validation, correctly; the schema is untouched.

Two supporting changes closed the ways form state went stale: hydration is keyed
on the **order id** rather than on `existing`'s object identity (React Query
hands back a new one per refetch, so a verification landing mid-edit used to
rebuild the form under the agent), and every `setForm` in the route is a
functional update. `call_center_verified` is re-applied on its own, raise-only.

#### The same rule governs what the form *shows*

The fallback above covered the **write** and left the **screen** alone, and that
gap was its own reported bug: an AlShrouq order reopened for editing showed
"Delivery & pickup — *Select a method…*" even though the column held `AlShrouq`
(byte-exact, `len 8`, matching `DELIVERY_TYPES[0]`) and the delivery had already
been accepted by the courier. Nothing was wrong with the data — every save had
been falling back correctly — so the order never lost its method; only the
control looked empty.

The cause is the one `features/alshrouq/dispatch-selection.ts` already names.
`form.delivery_type` is state seeded by an effect that runs once per order id, so
it is blank on the first render of every load and **stays blank whenever the
hydration does not run** — a detail query still in flight, a re-used route
component whose `hydratedFor` ref already names the id, or an SSR pass where
effects never run. That is why the AlShrouq card's visibility is decided from
persisted facts rather than from this value.

`requiredFieldValue(formValue, persistedValue)` is now that rule as a shared
function: `buildOrderPayload` applies it on save and `OrderForm` applies it to
`deliveryType`, which feeds the `Select`, the AlShrouq hint, `useAlShrouqOrder`
and `showAlShrouqSection`. Feeding it to `useAlShrouqOrder` matters as much as
the `Select` — the same blank was reaching the hook, so the order's whole
AlShrouq half went inactive with the label. A typed value always wins outright,
so editing the method is unchanged, and a new order still has nothing to fall
back to and must answer for itself.

The last two schema fields are optional so they can be **omitted rather than sent as a default**:
an absent column keeps whatever the row holds. `call_center_verified` is sent
only when the caller may verify *and* is not about to write `false` over a flag a
verified call-centre invoice has set — a save carrying stale form state must not
untick an automated verification, and raising the flag to `true` from the invoice
is not this path's job either (that transition belongs to
`record_invoice_verification`, which writes the automated event beside it).

#### Layout — a two-column operations workspace

`/orders/new` and `/orders/$id` are the same component (`OrderForm`), laid out as
two columns from `xl` and one below it:

- **Workflow** (left) — Order details, Invoicing, Assignment (with the Call
  Center Invoice control), Notes. Four cards rather than one tall banded card,
  which is what left a metre of empty space to the right of a single-column form.
- **Verification** (right) — the invoice panel, the branch preview, the activity
  timeline. Read-only findings, and deliberately outside the `fieldset` a
  read-only role disables: inside it, the people reviewing an order would be the
  ones unable to see what was found.

**One scrollbar.** The verification column was `sticky` with a capped height and
`overflow-y: auto`, which gave the page a second scrolling region: a wheel
gesture did different things a few pixels apart, and reading an invoice's items
meant working out which box the pointer was in. Both columns sit in the document
scroll now (`items-start` keeps them top-aligned); `new-order-layout.test.ts`
asserts that neither `overflow-y-auto` nor a viewport-capped height returns.

The primary actions live in the page header, under a breadcrumb, and reach the
form by id (`form={FORM_ID}`) rather than sitting at the end of a scroll. Both columns carry `min-w-0` inside `minmax(0,…)` tracks,
which is what stops a long Arabic customer name widening the page. The layout
contract is asserted in `__tests__/new-order-layout.test.ts` — a source-level
suite, since the test environment is Node and nothing else here renders.

The split is **60/40** (`xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]`), in
fractions rather than the fixed `26rem` it started as — that made the
verification column a sidebar at under 30% of the page, starving the invoice
while the form's two-up fields swam in whitespace opposite. Measured at 1440px:
806 / 538.

`OrderInvoicePanel` gives each document a compact header (number, state, total,
customer) over branch, channel, document date, *Verified by MilaPortal* and the
item lines. Every document **starts open** — folding was for the old capped
column, and the items are what a pharmacist opens the panel for.

The item table is **product · code · qty · unit · total · stock**. The money was
always on the wire — `Rate`, `Amt` and `Item_NetAmt` come back on every sales
line — and was being dropped at the `ItemAvailability` boundary, so the panel
could say a branch held four of something but not what it cost. It is carried
through now; nothing extra is fetched. An unpriced line reports `null` and
renders a dash: `toMoney` turns an absent field into `0`, and a confident
"0.00 SAR" against a medication is worse than saying nothing.

The product column takes whatever the fixed columns leave (214px at 1440) and
**wraps rather than truncates** — it used to be cut to whatever the quantity and
stock badge left over, rendering `MOUNJARO KWIKPEN 5 MG/0.6ML` and
`… 7.5 MG/0.6ML` identically, two different products as one string. The item
code sits under the name rather than in its own column, and `SAR` sits in the
`Unit`/`Total` headers rather than on every cell; both buy width for the one
field that is genuinely long. Below `sm` the two money columns fold into a line
under the product name, because six fixed columns cannot fit a 295px table
without either overflowing sideways or crushing the name.

### Writes

`useOrdersMutations` enforces `canEditOrder` = `edit_all_orders` OR
(own AND `edit_orders`), and `canVerifyOrder` = `verify_all_orders` OR
(own AND `verify_own_orders`) — mirroring `prevent_order_reassignment` in the
database. Every write invalidates both `orders.all()` and `dashboard.all()`.

### Display numbering

`display_no` is a plain `#<seq>`; `formatOrderNo(team, displayNo)` renders it as
`CC-…` or `TS-…`. `stripOrderPrefix` reverses that for search.

### Activity

`order_activity` rows are written by `log_order_activity` (the trigger) and by
`record_invoice_verification` (the three automated rows: `invoice_verified`,
`value_synced`, `call_center_flagged`), and rendered by `OrderActivityTimeline`
in `Asia/Riyadh` — `Today 12:31 PM` within the business day, the date before it.
Rows carrying `details.automated` are attributed to their `source` (MilaPortal)
and dotted in `success`; everything else names its actor.

### The form lives in the feature module, not the route file

`OrderForm` was exported from `routes/_app.orders.new.tsx` so `/orders/$id` could
reuse it, and `ComplaintForm` from `routes/_app.complaints.$id.tsx` for
`/complaints/new`. That is the one export shape this router punishes: the
TanStack splitter moves a route's own `component` into a lazy chunk, but a second
export has to stay in the route **shell**, and `routeTree.gen.ts` imports every
shell eagerly. Both forms — and with them cmdk, zod, the invoice panel and the
branch picker — were therefore in the entry bundle of every page, Dashboard
included, and emitted a second time in the split chunk that referenced them.

They live in `features/orders/components/order-form.tsx` and
`features/complaints/components/complaint-form.tsx` now. Each route file is four
lines: the route definition and a `component` that renders the form. Measured
effect in the Bundle section below.

`features/orders/__tests__/new-order-layout.test.ts` asserts the form's layout
contract by reading its source, so it reads the new path — pointed at the old
route file it would have gone on passing while asserting nothing.

### Complaints (sibling module)

`/complaints`, `/complaints/new`, `/complaints/$id` share the same shape: a
`display_no`, an owning `agent_id`, `branch_no`, `status`
(`In Progress` | `Resolved`), a `resolution` field, a trigger-written
`complaint_activity` timeline, and notifications on change. Its permission set is
distinct (`*_complaints`, plus `resolve_complaints` / `resolve_all_complaints`),
and Telesales holds none of them.

---

## Users Module

**Route:** `/admin/users` · **Gate:** `manage_users` (so Supervisor reaches it
without being an administrator)

### What the page shows

`adminListUsers` returns each profile joined with its role and its auth email,
plus a freshly signed avatar URL. Facets: search (name, email, agent code), role
filter, active filter; `UsersStatCards` summarise the population;
`UsersPagination` pages client-side. Rows are memoized and every row callback is
`useCallback`-stable, which is what makes typing in the search box cheap.

### Dialogs

| Dialog                                                       | Backing function                             |
| ------------------------------------------------------------ | -------------------------------------------- |
| Create user                                                  | `adminCreateUser`                            |
| Edit user (name, agent code, Yeastar extension, permissions) | `adminUpdateProfile`                         |
| Set password / send reset email                              | `adminSetPassword`, `adminSendPasswordReset` |
| Grant Owner (requires the acting Owner's password)           | `adminSetRole`                               |
| Activity log                                                 | `adminListActivity`                          |

`PermissionEditor` renders `ALL_PERMISSIONS` grouped by `PERMISSION_GROUPS`, with
`defaultPermsForRole` seeding a new user's set.

### Account lifecycle

1. Created with `email_confirm: true`. Role is **never** passed through
   `user_metadata` — `handle_new_user` ignores it and always writes the default;
   elevated roles are granted server-side afterwards.
2. Passwords default to `temporary: true` (an admin-typed password is a password
   two people know), with a 24h/48h deadline.
3. The holder is blocked at `_app` until they replace it; past the deadline the
   credential is rotated away and only recovery works.
4. Deactivation blocks reads and writes at the database level.
5. Deletion is administrator-only, refuses self-deletion and refuses Owners.

Every one of those steps writes an `admin_activity` row. `logAdminAction` never
throws: it runs _after_ the action succeeded, and failing the request there would
prompt a retry — and retrying "reset this password" issues a second credential.

---

## Branches Module

**Routes:** `/branches` (directory), `/branches/import`

### Directory

The whole active table is fetched once (paginated at 1000 rows) and searched in
the browser. `DIRECTORY_COLUMNS` names every column explicitly to exclude
`location`, which PostgREST serializes as ~100 bytes of WKB hex per row that the
browser has no use for.

Search (`search.ts`, `normalize.ts`, `district.ts`) handles the realities of a
hand-maintained bilingual workbook: Arabic/English city aliases, text folding,
phone search forms, `maps_url` labelling, and **district (حي) extraction from the
free-text address** — there is no district column, and the convention is
`city / area / street`. Extraction is deliberately conservative: it returns
`null` rather than guess.

`working_hours` stays free text (`"06 AM - 02 PM & 10 AM - 06 PM & 06 PM - 04 AM"`
has no single open/close pair); `duty_hours` is derived once at import time
because it is what the "20 Hours"/"24 Hours" filter chips match on.

`scooter` (boolean) and `scooter_note` (original wording) are both kept —
collapsing "سكوتر" / "توصيل مجاني" / "مع فرع 8" to a bit would lose the
distinction between "no scooter" and "delivery is free anyway", which agents act
on.

### Branch Locator

`locator.ts` + `location-index.ts` build a gazetteer **out of the directory the
portal already has** — cities, districts, areas, branch codes and addresses —
which is the only geography this business is ever asked about. It answers a
keystroke in microseconds with no key and no quota. `geocode-nominatim.ts` is the
last resort, reached only when the local index has no answer.
`delivery-eta.ts` returns a _band_ rendered with "≈", never a point estimate:
there is no traffic data, no rider availability and no queue depth, so a single
figure would be a promise the model cannot keep.

#### Reading a city out of the query

The gazetteer indexes **one place per entry** — the district "النخيل", the city
"الرياض" — but a Saudi address is dictated as both at once. "حي النخيل، الرياض"
therefore normalized to the single string `"النخيل الرياض"`, which matched
nothing: not the district (whose term is shorter than the query by more than the
fuzzy budget allows on length alone), not the city, not any branch. The search
fell through to OpenStreetMap, whose answer for a bare Arabic district name is a
coin flip between the same-named districts in Riyadh, Qassim and Al Majma'ah —
which is how a customer 3 km from P0030 was told their nearest branch was P0004,
50 km away.

`splitCityQualifier` pulls the two apart before anything is scored, testing both
ends of the query because both are dictated ("حي النخيل، الرياض" and the sheet's
own "الرياض/ حي النخيل"). It generalizes to any `<place> <city>` pair and needs no
per-neighbourhood knowledge — the city terms come from the gazetteer, English
aliases included, so "Al Rawdah Riyadh" splits the same way.

A city read out of the **query text** is a hard filter, where the city
**dropdown** stays a preference. The two are different statements: the dropdown is
a standing hint the agent set once and may have stopped looking at, so out-of-city
matches stay visible beneath it; a city typed into this particular query is that
query's answer to "which one", and re-offering the other city would re-open the
question the agent just closed. This is what makes "حي النخيل" ask and "حي
النخيل، الرياض" answer — and the ambiguity prompt still fires, unchanged, for any
duplicated name typed without a city.

#### Constraining the geocoder, not just checking it

Splitting the query is only half the answer, because the gazetteer holds **only
districts that contain a branch**. حي النخيل in Riyadh has none, so
"الرياض حي النخيل" still reaches OpenStreetMap — which answered with the حي
النخيل in **Huraymila**, a town 75-odd km north-west of Riyadh. Three things had
to change, and the order matters:

1. **The hint goes to the provider.** `Geocoder` takes an optional
   `GeocodeHint` — the named city and its centroid — and `geocode-nominatim`
   turns it into a `viewbox` with `bounded=1`. `countrycodes=sa` narrows to a
   country the size of Western Europe, which is not narrow enough for a name that
   repeats in four Saudi towns. Bounded means the wrong-city answer is not ranked
   lower, it is **not returned**. Checking afterwards can only refuse the wrong
   النخيل; bounding is what returns the right one.
2. **A named city settles it, in either script.** `agreesWithCity` compared
   OpenStreetMap's city against the Arabic "الرياض" only. OSM answered
   `"Huraymila"` — Latin — so the check could never match and the decision fell
   to a distance guard. Both the Arabic name and the curated English alias are
   compared now, and a named city matching neither is a _disagreement_, not an
   absence of agreement. The distance guard survives only for a provider that
   returned a bare point, at 60 km rather than 75 km: any radius wide enough to
   hold every legitimate Riyadh suburb is also wide enough to hold the next town,
   which is precisely why the name check has to carry the weight.
3. **The cache was retired.** Entries are keyed by query and kept forever by
   design, so the Huraymila answer would have outlived the bug. `CACHE_KEY` moved
   to `…osm.v3`, and the key now includes the city hint — two searches for
   "الروضة" that named different cities are different questions, and one entry
   for both would reintroduce the duplicate-name failure through the cache.

When the provider disagrees, or returns nothing inside the box, the named city's
own centroid is the answer — coarse, in the right city, and the origin line says
which it is.

#### What the locator will not show you

Head office, the regional office and the warehouses are in the directory because
agents need their switchboards, but a nearest-branch list is read out loud to a
caller, so `isCustomerFacingBranch` keeps them out of it. Keyed off
`branch.reference` — which `referenceKind` already derives from the branch code —
rather than a list of names, so any code that is not a numbered pharmacy is
excluded the day it is imported. The filter is applied **once**, in
`useBranchLocator`, and feeds both the gazetteer and the ranking: a warehouse is
therefore not merely missing from the results, it is not a place the locator can
resolve to at all.

#### Distance is straight-line, and says so

There is no `GOOGLE_MAPS_API_KEY` configured, so `rankNearestBranches` runs on
Haversine and every `DistanceResult` comes back `source: "straight-line"`. A road
trip across a Saudi city runs 15–25% longer than the direct line, which is the
reported "panel says 55 km, Google says 65 km" gap in full — the arithmetic was
never wrong, the label was missing. Every number now carries "≈", the panel states
once that these are direct distances and not driving distances, and Directions
opens the real route.

Nothing here is a stopgap for a routing call: `rankNearestBranches` already takes
a `DistanceProvider`, `routeMatrix` in `lib/maps/google.server.ts` already
implements it against the Routes API, and the day a key is configured the "≈"
disappears on its own because `source` starts coming back `road`.

#### The branch filter inside the results

The nearest twenty (raised from ten) are the visible slice of a list that ranks
the **whole** serviceable directory, held in full so the filter can answer for a
branch that did not make the cut. Typing "P0030" filters that ranked list — one
`includes` per branch over the haystack `decorate` built once — and deliberately
touches neither `origin` nor the geocoder: the agent has already located the
customer, and asking where one branch sits relative to them must not cost them
that. The "Recommended" hero is suppressed while the filter is on, because the top
row of a filtered list is whatever was typed rather than a recommendation.

### Import

`import-parse.ts` reads the workbook (`xlsx`), `constants.ts` holds
`HEADER_LOOKUP` / `REQUIRED_COLUMNS` / `TEMPLATE_COLUMNS` /
`PREFERRED_SHEET_NAME`, and `import-template.ts` generates a blank template.
Four modes — **replace / merge / update / add** — plus **rollback**.

Import runs as a server function, not a client write, because it is not one
write: it snapshots the table, reconciles ~1000 rows, deactivates what the file
dropped, and records history. Half of that landing is worse than none of it.
Upserts are chunked. "Removed" always means `active = false` — a branch that has
ever taken an order can never be deleted.

`branchImportHistory` deliberately does **not** select `snapshot`: the page shows
ten entries, and pulling ten full table copies to render ten "Roll back" buttons
would cost megabytes.

Import requires `admin_access` (the same permission the RLS policy checks, so the
two cannot drift). Rollback additionally requires `is_administrator`, because it
discards everything since a chosen point — including someone else's corrections —
without a single row on screen changing colour.

---

## Call Center Module

**Routes:** `/calls` (overview), `/calls/overview`, `/calls/customer-care`,
`/calls/telesales`, `/calls/lookup`, `/calls/diagnostics`,
`/calls/configuration`

The PBX vendor is **deliberately not named in the navigation** — "Calls" is the
product feature, the integration is an implementation detail, and swapping
provider would not change a menu entry.

### `/calls` — overview

A health check, not a report: is call data healthy right now, and which page owns
each answer. Team agents are redirected straight to their own dashboard.

### Missed vs. Abandoned — one classifier, every surface

`src/lib/yeastar/call-classification.ts` is the **single source of truth** for
the Missed / Abandoned distinction. Nothing else in the codebase may decide it —
not a KPI card, a chart, a table, a drill-down or an export.

It exports three things and they are used in this order:

| Function                  | Answers                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `isQueueSplitApplicable`  | Does Yeastar's queue split describe THIS view?                    |
| `resolveQueueOutcomes`    | Which system's counts do we render, and what are the rates on it? |
| `classifyUnansweredCalls` | Which individual calls carry each label?                          |

**Why the third one exists.** Yeastar publishes queue COUNTS, not calls. The KPI
cards followed the PBX (O1, Sprint 3.5) while every surface listing individual
calls read CDR's per-call `outcome`, so a card reading "Missed 0" opened onto the
two calls CDR labels missed and the PBX labels abandoned.
`classifyUnansweredCalls` closes that by re-cutting the population at the PBX's
boundary: same calls, ordered by queue wait ascending, cut where the PBX put the
line. A call the queue RELEASES has by definition waited out the queue's timeout,
so the longest waits are the releases (missed) and everything below the cut is
the caller's own hang-up (abandoned) — the same direction CDR's 5-second
threshold already sorts them in. No call is added, dropped or duplicated; only
the line moves. With no PBX opinion the cut lands on CDR's threshold and nothing
moves at all.

**Applicability is stricter for the split than for the missed column.** Call
Report's queue figures are inbound, queue-scoped and queue-WIDE, so the split is
refused on an Outbound-filtered view **and** on a single-agent view (which would
render a queue-wide number over one agent's calls). `isCallReportApplicable` —
which governs the per-agent missed COLUMN, and which the report really does carry
per agent — remains the looser rule.

Consumers: `buildCustomerCareMetrics` (Customer Care cards, charts, agent table),
`/calls/overview` (Missed, Abandoned, Missed rate, the distribution donut), and
`getUnansweredCalls` → `selectUnansweredCalls` (both drill-down dialogs). The
drill-down loads the same cached Call Report snapshot the cards were built from,
via the shared `loadCallReportSnapshot`, so a card's number and the rows behind
it cannot diverge. The remaining honest case is the two feeds disagreeing on the
SIZE of the unanswered population; the dialog says so rather than silently
listing a different count.

### `/calls/overview`

Both teams on one screen — a monitoring surface: one window, no per-agent filter,
one PDF export. Missed and Abandoned resolve through the shared classifier above,
so they state the same thing Customer Care's cards do; Missed rate is derived
from the rendered Missed, not from CDR's, so a card and its rate can never
describe different calls.

### `/calls/customer-care`

Queue-driven. Every rendered number comes from
`buildCustomerCareMetrics` (see Yeastar Integration). Filters: date range, agent,
direction, queue. KPI groups cover queue volume, timing (avg/max wait, avg talk,
SLA attainment) and agent performance. Abandoned and Missed KPIs drill into
`UnansweredCallsDialog` (`getUnansweredCalls`, capped at 1000 rows).

Failure behaviour is asymmetric on purpose: a CDR failure is a page failure; a
Call Report failure degrades one column and is reported through
`metrics.callReport` rather than thrown.

### Exports — PDF only

Overview, Customer Care and Telesales each expose exactly one export: **Export
PDF**, which is `window.print()` against the page's own `print:` utilities, so
what is exported is what is on screen. The XLSX export (`features/call-center/
export.ts`, and Telesales' Excel button) was removed along with the module. The
`xlsx` dependency stays — Dashboard, Orders, Complaints and Branches still use
it.

### `/calls/telesales`

Extension-driven, outbound-oriented, with a conversion join against `orders`.
Customer Care and Telesales are separate pages precisely because computing both
from one set of KPIs produced numbers that were wrong for whichever workflow you
were looking at.

### `/calls/lookup`

A point query for one customer number over a trailing window
(`LOOKUP_MAX_DAYS = 90`, `LOOKUP_MAX_ROWS = 200`). Open to every holder of the
Calls view permission, team agents included.

### `/calls/diagnostics` (administrator) — config/auth/CDR/queue/endpoint probes.

### `/calls/configuration` (Owner) — read-only view of the settings the pipeline

runs on and where each comes from. Deliberately not editable: every value is a
deployment variable or PBX-side configuration, so an editor would either be a lie
or need a settings store. **Secret values are never returned — only whether they
loaded.**

### Refresh policy (`refresh-policy.ts`)

Cadence is derived from the window, not fixed. Three bands:
live (≤ `LIVE_WINDOW_MAX_DAYS = 2`, still accruing) polls; ≥
`HISTORICAL_WINDOW_MIN_DAYS = 8` is fetched once; in between backs off
proportionally. `SERVER_CACHE_TTL_MS = 5 min` matches the server's own CDR cache
TTL — asking sooner cannot return newer rows.

The policy also carries `gcMs` — **retention**, not freshness, and the one that
decides what a user filtering around actually pays. Staleness only says whether a
refetch is _allowed_, and these queries have already opted out of every automatic
trigger (`refetchOnMount: false`, `refetchOnWindowFocus` only while live), so a
window still in cache is reused whether it is stale or not. Eviction is what
forces the full server-side cost again. A large or closed window is therefore
retained for `CLOSED_WINDOW_GC_MS = 60 min` instead of the app-wide 10, because it
is immutable (the PBX cannot add a call to a day that is over) and it is the
expensive one to rebuild; live windows keep `LIVE_WINDOW_GC_MS = 10 min`. The
payload is an aggregate — a few kilobytes whatever the window's size — so holding
several costs nothing measurable, and the Refresh button ignores all of it.

There is deliberately **no progress polling** on the dashboards: the previous
800 ms poll rebuilt every chart array and replayed Recharts' enter animation,
which is what made the pages appear to load, clear and reload on a loop.

The refresh policy is unchanged by the synchronization layer — the cadence
describes how often the same question is asked, and the layer changes only where
the answer comes from. What it does change is what a refresh _costs_: a window
the mirror covers is answered from Postgres, so the poll no longer implies a PBX
sweep once the isolate goes cold.

### What a poll must NOT rebuild

Both dashboard query envelopes carry a per-fetch diagnostic — `cdr.elapsedMs` on
analytics, `elapsedMs` on the Call Report — so **the envelope's identity changes
on every poll even when no number moved**. React Query's structural sharing
preserves the identity of the parts that did not change, so a memo must depend on
those parts and never on the envelope. Depending on the envelope rebuilds every
metric and chart series three times a minute on a live window, and Recharts
replays its enter animation whenever its `data` prop is a new reference.

The analytics path already did this. The Call Report path did not, and now does:
`useCustomerCareMetrics` rebuilds the snapshot from the fields the engine reads
(`available`, `error`, `window`, `queue`, `agents`) and drops `elapsedMs`, which
is a diagnostic on the envelope rather than an input to any metric. The Calls
Overview does the same for its queue split, depending on `available` and `queue`
rather than the whole snapshot.

### One roster fetch, not one per query

Every Calls page starts at least two requests that need the PBX roster at the
same instant (analytics and Call Report; three once a drill-down opens), and on a
cold isolate the roster's TTL cache cannot help any of them because none has
populated it yet. Each therefore issued its own `/queue/list` plus up to ten
`/extension/list` pages, against an appliance whose token endpoint rate-limits
hard enough to lock the whole integration out (`errcode 60002`). `fetchPbxRoster`
now coalesces concurrent callers onto one in-flight fetch — the same thing
`getCdrCached` does for windows, for the same reason.

---

## Yeastar Integration

**Hardware verified in-repo:** Yeastar P570, firmware 37.23.0.83 (`/openapi/v1.0`

- `/openapi/v2.0`). Evidence: `docs/yeastar/live-audit-2026-07-30.md`
  (13,997 CDR rows over 30 days), `field-mapping.md`, `api-discovery-37.23.md`,
  `api-probe-results.{md,json}`, and redacted payloads in `docs/yeastar/samples/`.

### Client (`client.server.ts`)

OAuth against `/openapi/v1.0/get_token` and `/refresh_token`, with a **two-tier
token cache**:

- **L1** — module-scoped memory, per isolate, with single-flight.
- **L2** — `public.yeastar_token_cache` row 1, shared across isolates and cold
  starts.

The PBX rate-limits token issuance aggressively (`errcode 60002` = MAX LIMITATION
EXCEEDED). On 60002 a `blocked_until` window is persisted to L2 so no isolate
retries until it expires (`BLOCK_MS = 5 min`). `yeastarFetch` retries once on
401 / `errcode 10003` / `10004`, with a 25 s default timeout.

### The single most important fact about this firmware

**An inbound call is not one CDR row.** One call emits one row per routing stage,
all sharing `call_id`:

```
call_id 1782844637.854
  row 1  IVR Welcome_AR_EN<6200>   ANSWERED  talk 13
  row 2  IVR Main_AR<6201>         ANSWERED  talk 5
  row 3  Queue CC_Team<6400>       ANSWERED  ring 11  talk 74
  row 4  Shams Rafiq<4005>         ANSWERED  ring 11  talk 74
```

Two consequences drive the whole normalization layer:

1. `disposition: "ANSWERED"` on an IVR row means the **auto-attendant** picked
   up, not a human. 1,741 calls in 30 days were previously counted as answered on
   that basis alone.
2. `talk_duration` repeats down the chain, so summing across rows multiplies it.

Rows are therefore grouped by `call_id` and de-duplicated on **`new_id`** (row-
unique, 13,997 distinct). The previous parser de-duplicated on `uid`, which is a
_call_ id on this firmware — that kept one leg per call (always the IVR leg) and
made every multi-leg code path below it dead.

Fields confirmed **absent** on this firmware and removed from the parser:
`wait_time`, `agent_ring_time`, `last_participant*`, `final_participant`,
`answer_by`, `answered_by`, `agent_number`, `dst*`, `linkedid`, `id`.

### Normalization (`normalize.ts`)

- `LegRole`: `agent | queue | ivr | survey | prompt | external | unknown`.
  Roster membership wins (`/extension/list`, `/queue/list` are authoritative and
  language-independent); label prefixes are only consulted for stages with no
  roster.
- `CallOutcome`: `answered`, `missed`, `abandoned`, `ivr_only`,
  `no_answer_outbound`, `cancelled_by_agent`, `busy`, `failed`, `voicemail`,
  `internal`, `unknown`.
  `cancelled_by_agent` (agent hung up before the ring timeout) is counted in
  Total but **never** in No Answer — folding the two together is what inflated
  the No Answer figure.
- `CallExclusionReason`: `after_hours`, `queue_closed`, `ivr_only`,
  `system_event`, `internal`. Excluded calls are reported separately and must
  never move an operational KPI.
- Queue wait is the **queue** leg's `ring_duration`; agent ring is the **agent**
  leg's. Different numbers, kept apart. Talk seconds come from the agent leg
  only, counted once.
- `ivr_only` is tracked separately and is deliberately **not** Missed.

### Fetch layer

- `cdr.server.ts` — pre-filters with `/cdr/search` (epoch-second
  `start_time`/`end_time`) and authoritatively post-filters every row by its
  epoch `timestamp`. Page 1 is a **blocking probe** whose `total_number` sizes
  the job; remaining pages are fetched with `PAGE_CONCURRENCY` (default **3**).
  `DEFAULT_PAGE_SIZE` is **2,000, not the API maximum of 10,000** — at 10,000 the
  blocking probe alone carries three quarters of a month's rows, making the
  window effectively serial. The modelled table for a 14,000-row month is in the
  source.

  **The `/cdr/list` fallback is reachable in exactly two cases**, and both are
  statements about the endpoint rather than about one request: page 1 itself
  failed (`CdrProbeError` — the epoch form was rejected), or page 1 succeeded and
  the window came back empty (H2, the silent zero-data blackout). A LATER page
  failing is neither, and is now propagated as the honest failure it is.

  That distinction is load-bearing. `/cdr/list` has no date filter, so it sweeps
  the PBX's entire retained history — measured live at **70,052 rows against a
  month's 14,294**. Escalating to it on any page failure is what stopped
  month-wide filtering from loading at all: at concurrency 6 every page took
  26-28 s against the client's 25 s timeout, the aborted page triggered the
  unfiltered sweep, that sweep was five times the work and timed out in turn, and
  the request died with nothing to show. Measured on the live PBX over July 2026:

  | concurrency | per page | total wall |
  | ----------- | -------- | ---------- |
  | 6           | 26-28 s  | 34.8 s     |
  | 3           | ~14.6 s  | 37.7 s     |

  The appliance is throughput-bound — it serializes the work either way, so extra
  concurrency buys only a longer queue in front of each request. Hence
  concurrency 3, a CDR-specific `PAGE_TIMEOUT_MS` of 60 s (the client's 25 s
  default is sized for the small roster calls, not a 2,000-row page), and
  `PAGE_RETRIES = 2` so one slow page on a busy box costs a retry rather than the
  dashboard.

- `cdr-window.server.ts` — **day-partitioned window store**. A business day is
  the right cache unit: once a day has ended its CDR is immutable, so closed days
  hold for `CLOSED_DAY_TTL_MS = 12 h` and only today uses
  `LIVE_DAY_TTL_MS = 5 min`. Missing days are fetched as _contiguous ranges_, so
  a cold month is still one sweep rather than thirty round-trips. Days partition
  the fetch and the cache only — rows are concatenated and normalized over the
  **whole** window, because a call spanning midnight would otherwise be split
  into two half-calls reporting that nobody answered.
- `progress.server.ts` — durable progress in `cdr_progress`, so a fetch survives
  Worker isolate recycling.
- `cdr-days.ts` — the business-day arithmetic (`businessDayOf`, `enumerateDays`,
  `contiguousRanges`, `shiftDay`). Pure, and extracted so the three server tiers
  below can agree on which instants belong to which day without importing one
  another.

### CDR synchronization layer

A background layer that mirrors CDR into Supabase. **Yeastar remains the source
of truth** — nothing here originates a record; it only moves rows the PBX has
already emitted into a store the dashboards can read without waiting.

**Three tiers, cheapest first.** `getCdrWindow` composes a window from days and
asks each tier in turn:

| Tier                                  | Cost                    | Scope                                                           |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| 1. This isolate's day cache           | free                    | one isolate; the only tier that returns the same array identity |
| 2. `cdr_records` (`cdr-store.server`) | one indexed query       | every isolate, survives cold starts                             |
| 3. A live PBX sweep (`cdr.server`)    | the sweep it always was | authoritative, and **written back to tier 2**                   |

A day is servable from tier 2 when it has **ended** (immutable on this PBX, so
age is irrelevant) or when it is today and the mirror was refreshed inside
`LIVE_DAY_TTL_MS` — the same freshness contract tier 1 applies to its own
entries. `isSyncedDayUsable` is the one definition of that rule, because both the
window store and Call Lookup ask it and a dashboard that trusted the mirror
further than the lookup did would show two answers for the same calls.

**Days that have not begun are a third case, and omitting it was a four-minute
bug.** The date presets select a whole CALENDAR month, so "this month" on the
12th requests the 1st to the 31st — nineteen days that do not exist yet. The rule
split days into "ended" and "today or later", so those nineteen were held to the
live-TTL freshness check, which nothing can ever satisfy for a day with no mirror
row. They therefore landed on the missing list on **every** request, joined
today's contiguous range, and turned a one-day live sweep into a twenty-day one.
A measured cold Customer Care → August request took **263 seconds**; the second
team's request then read the isolate's warmed day cache and returned in under a
second, which is why the problem looked like a caching win rather than a defect.

`getCdrWindow` now filters the requested range to days `<= today` before any tier
is consulted — above the mirror deliberately, so it holds even when the mirror is
unreachable — and reports the rest as `daysInFuture`. `isSyncedDayUsable` returns
true for a future day for the same reason: it is complete by construction.
`windowCacheState` excludes them too, or a current-month window would read
"partial" for the rest of the month and Call Lookup could never take its free path.

**What makes it incremental.** `cdr_sync_days`, not a timestamp cursor. Once a
closed day is recorded it is never fetched again; the live tail (today and
yesterday) is refetched every run. That is the finest granularity the PBX's own
API offers — `/cdr/search` is a window query — and it is exact, because a quiet
day is recorded with zero rows rather than looking like a gap. A row-level cursor
would be _worse_ here: CDR is written when a call **ends** but timestamped when
it **started**, so a call spanning the cursor is filed behind it and a
cursor-exact resume would skip it permanently. Yesterday is in the live tail for
the same reason — a call ending after midnight lands in a day already recorded as
covered.

**What makes it idempotent.** Every write is an upsert on `cdr_records.row_id`
(`cdrRowKey`). Running twice over the same window, running while a dashboard
sweep persists the same days, or re-running after a crash mid-way all converge on
the same rows. Overlap is therefore a correctness tool, not a hazard.

**Bounding and backfill.** One run sweeps at most
`YEASTAR_CDR_SYNC_MAX_DAYS_PER_RUN` days, because it executes inside a request
with a bounded runtime. Backfill therefore _walks_: `selectDueDays` takes the
live tail first, then the oldest days still missing with whatever capacity is
left, and successive runs converge on a covered horizon. Live days win the
tie — falling behind on today to make progress on a three-week-old gap is the
wrong trade. Selected days are collapsed into contiguous ranges, so a week is one
sweep and not seven.

**The read path is also the backfill.** After a live sweep, `getCdrWindow` writes
those rows to the mirror (`persistSweptDays`). They have already crossed the
wire, so this is the cheapest backfill available and means a window a human
actually looks at is only ever swept once across the whole deployment. It is
awaited (a floating promise can be cut short when a Worker isolate is recycled)
and best-effort (a mirror write must never fail a dashboard that already has its
answer).

**Mirror I/O runs concurrently, bounded at `STORE_CONCURRENCY = 4`.** Both halves
were fully serial and both sit on the critical path of a user request:

- _Write._ A month is ~14,000 rows at `UPSERT_CHUNK = 500` — twenty-nine
  round-trips one after another, on the request that had already finished its
  sweep. The chunks are disjoint by `row_id` (the `seen` set guarantees a key
  appears once across the payload), so no two can conflict on the same row, which
  is what makes running them together safe rather than merely faster.
- _Read._ Now a single round trip — see "Window reads go through an RPC" below.
  The concurrent `READ_DAY_GROUP = 8` paging remains as the fallback for a
  deployment whose migration has not landed yet.

`pooled` stops taking new work on the first failure and re-throws it once the
workers already in flight have settled — rejecting on the spot would leave the
others running unobserved and surface a later rejection as an unhandled one.

**Window reads go through an RPC (`cdr_window_rows`, `cdr_rows_by_number`).**
Splitting the paging across day groups made it concurrent but did not make it
cheaper, and paging was the dominant cost of a month-wide Calls filter. PostgREST
paging asks for the rows themselves, so a month is ~16 requests capped at 1,000
rows each, and each one re-executes the whole query:

- `.order("row_id")` is not satisfiable from `cdr_records_business_day_idx`, so
  every page re-scanned **and re-sorted** its day group — carrying the `raw`
  jsonb (~600 bytes/row) through the sort, which is the expensive part.
- `OFFSET n` then discarded the rows it had just materialised, so page 4 did four
  pages of work to return one.
- The ordering was never wanted. It existed only to make `.range()` stable;
  callers bucket by `business_day` and `classifyRecords` groups by `call_id`.

`cdr_window_rows(p_days date[])` returns one row **per business day** carrying
that day's legs as `json_agg(raw)`. The response is then a few hundred rows at
most however many legs it contains, so the 1,000-row cap stops being a
constraint and the paging, the OFFSET and the sort all disappear together. Over a
31-day window (~14,000 legs) that is **16 requests → 1**, and Postgres scans the
window once instead of four times. `cdr_rows_by_number` does the same for Call
Lookup, replacing two paged per-column walks and their client-side de-duplication
with one `BitmapOr` over the existing composite indexes; it returns a single
`json` value so no row cap can clip a subscriber's history.

`json_agg`, not `jsonb_agg`: the input is already jsonb, so json_agg serialises
each element straight to text rather than building a second binary container to
serialise afterwards. **The rows are unchanged** — these functions re-shape the
response envelope, never its contents, so `classifyRecords` still receives the
byte-identical object and no KPI moves. No new indexes: what was slow was the
paging and the sort it required, not the row selection.

Both are service-role only (`REVOKE … FROM PUBLIC, anon, authenticated`), like
`cdr_records` itself — these rows carry customer phone numbers and the rules for
who may see which calls live in the Calls server functions. When a function is
absent (code deployed ahead of its migration) the store logs once, latches a
per-isolate flag and falls back to the paged path, so a deployment is never
ordered.

**Triggering.** `POST /api/cdr-sync` from any scheduler. With no scheduler
configured the layer still works — it is then driven entirely by the read path
above, which degrades to exactly the pre-existing behaviour for the first viewer
of a window and to a Postgres read for everyone after.

**Failure behaviour.** The mirror is an accelerator, never a dependency. Every
entry point degrades to the live PBX path: unconfigured service role, unreachable
Supabase, a partially covered window, a mirror read that throws — each falls
through to tier 3 rather than failing or, worse, answering from partial data.

**Reads that benefit.** Customer Care, Telesales and Calls Overview all reach CDR
through `getCallCenterAnalytics` → `getCdrCached` → `getCdrWindow`, so they
inherit tier 2 with no change to the analytics pipeline. Call Lookup gains a
`"synced"` source between `"cache"` and `"targeted"`: one indexed query by
subscriber number, used **only** when the mirror covers the whole window
(`storeCoversWindow`) — a partially covered window would answer from the days it
holds and silently omit the rest, and "nobody has spoken to them" is the one
wrong answer that page must not give.

### Call Report (`call-report.server.ts`) — v2.0 only

`call_report/*` returns `errcode 0` on both API versions, but **only v2.0 honours
`start_time`/`end_time`**. A windowed v1.0 query is accepted, silently ignores
the window and returns `total_number: 0`, which reads as "no data" but means
"wrong partition". Measured on the same token and window: v1.0 → 0 calls, v2.0 →
1,323. Do **not** fall back to v1.0 on failure — it does not fail, it lies.

Wire format is `DD/MM/YYYY hh:mm:ss AM|PM` (the v2.0 validator states it
outright), hard-coded rather than read from `YEASTAR_DATETIME_FORMAT`.
`queueperformance` needs `queue_id_list`, `queueagentperformance` needs
`queue_id`, both taking the PBX's internal numeric id rather than the dialable
number — and a bogus id returns `errcode 0` with an empty result, so an empty
response proves nothing.

### Metrics Engine (`metrics-engine.ts`) — the contract

Every number the Customer Care dashboard renders is produced here, once. A
component may format a value and may choose not to show one; it may never derive
one — no `.filter()`, `.reduce()`, `a / b * 100` or `?? 0` standing in for a
metric. If a widget needs a number that is not on `CustomerCareMetrics`, the
number belongs on `CustomerCareMetrics`.

Source policy, with provenance recorded on `sources` and surfaced in the UI:

| Source               | Used for                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **CDR**              | Every historical KPI.                                                                                 |
| **Call Report v2.0** | Exactly two things: per-agent missed calls, and the Missed/Abandoned split of unanswered queue calls. |
| **Queue API**        | Nothing on the dashboard. It backs `yeastarRealtimeQueue`, which serves `/calls/diagnostics`.         |

Per-agent missed calls are underivable from CDR on this firmware: an agent-leg
row is written **only when the agent answers**, so across 14,294 July rows _zero_
inbound agent legs carried `NO ANSWER`. Yeastar reported 71 missed rings in July,
36 of them on ext 4006 — a blind spot the dashboard had all along.

### Extension mapping

`profiles.yeastar_ext` maps a portal user to a PBX extension, supplemented by
`yeastar_extension_map`. This is why `yeastar_ext` is guarded by both a column
grant and `prevent_profile_escalation`: without them any agent could set their
own extension to a colleague's and read that colleague's call records through the
normal analytics path.

### Server functions

`callsConfiguration` (Owner) · `yeastarConfigDiagnostic`,
`yeastarAuthDiagnostic`, `yeastarCdrProbe`, `yeastarQueueRoster`,
`yeastarEndpointProbe`, `yeastarDevDiagnostics`, `yeastarKpiValidation`,
`yeastarAgentMappingDiagnostic`, `yeastarAnalyticsDebug` (administrator) ·
`getCallCenterAnalytics`, `getUnansweredCalls`, `yeastarQueueOptions`,
`yeastarCallReport`, `yeastarRealtimeQueue`, `lookupCallsByNumber` (Calls view
permission, auto-scoped).

Non-administrators are auto-scoped to their own agent row, and `callerCallsTeam`
confines a team agent's figures to their own team whatever the request asks for.

### Configuration constants

`CUSTOMER_CARE_QUEUE_NUMBER = "6400"` · `CDR_CACHE_TTL_MS = 5 min`,
`CDR_CACHE_MAX = 20` · `ROSTER_TTL_MS = AGENT_ROSTER_TTL_MS = 5 min` ·
`UNANSWERED_MAX_ROWS = 1000` · Call Report TTL scales with the window (long for
a closed window, short for one that includes today) ·
`YEASTAR_CDR_SYNC_HORIZON_DAYS = 90`, `YEASTAR_CDR_SYNC_MAX_DAYS_PER_RUN = 7`,
`LIVE_TAIL_DAYS = 2`, sync lease 5 min.

**Nothing about how a KPI is computed changed.** `normalize.ts`,
`stats.server.ts` and `metrics-engine.ts` are untouched by the synchronization
layer: it changes only where the rows they consume come from.

---

## Shams Pharmacy MIS Integration

Read access to the pharmacy chain's own MIS: product catalog, per-branch stock,
sales documents, and customer loyalty history. Discovery evidence and the full
field-by-field schema are in
[`docs/shams/api-discovery.md`](./shams/api-discovery.md), derived from three HAR
captures of the live portal (2026-08-13 ×2, 2026-08-19). The HARs are **not** in
the repository and must never be committed — they contain a live credential
exchange and customer mobile numbers.

### Authentication — Bearer token

The API is Bearer-authenticated. A machine credential pair is exchanged for a
short-lived token, which is attached to every data request:

```
POST /api/v2/auth/token   {account_identifier, api_key}
  -> {success, token_type: "Bearer", access_token, expires_in: 1800, expires_at, account_identifier}
GET  /api/v2/product/...  Authorization: Bearer <token>
```

**Two endpoints, two purposes — do not conflate them.** `POST /api/v2/auth/login`
is the MIS *portal user's* login; it returns a profile and UI nav permissions and
issues no API token. MilaServ never calls it, and no MIS username/password is
configured.

An earlier capture showed the data endpoints answering anonymously; that window
is closed and they now return `401` without a token. One detail from that capture
predicted the change — every response already carried `Vary: Authorization`, so
the auth layer was installed and dormant rather than absent.

Token handling is **module-scoped memory with single-flight**, a 60 s refresh
skew, and on 401 a forced refresh plus exactly one retry (a second 401 raises
`auth_failed` rather than looping). These parameters are not invented: they are
the contract the MIS portal's own shipped bundle implements.

Deliberately **no Supabase L2 tier** like the Yeastar client's. That exists
because the PBX rate-limits token issuance hard enough to lock the integration
out (`errcode 60002`), which is evidenced. Nothing evidences a rate limit here,
and an L2 tier would mean a migration plus a table holding a live bearer token.
If Shams turns out to throttle `/auth/token`, that is when to add one.

MilaServ's own gate still governs *portal* users: every read sits behind
`requireSupabaseAuth` plus a permission check. `shamsStatus` (administrator only)
forces a real token exchange and reports lifetime and type — never the
identifier, key or token.

### Layering

```
src/lib/shams/client.server.ts   Bearer auth + token cache, transport: timeout (30 s), 1 transient retry (opt-out via `retry`), error taxonomy, TtlCache
src/lib/shams/types.ts           wire shapes + normalized models
src/lib/shams/normalize.ts       PURE: numeric parsing, invoice grouping, Call Centre rule
src/lib/shams/search.ts          PURE: wildcard product matching, branch filter, stock summary
src/lib/shams/availability.ts    PURE: invoice line ↔ branch stock join, the four stock states
src/lib/shams/catalog.server.ts  product search (over the CRM catalog) / info / stock + caches
src/lib/shams/sales.server.ts    invoice lookup + query validation + branch discovery fan-out
src/lib/shams/crm.server.ts      customer sales history (crm/data) + query validation, uncached
src/lib/shams.functions.ts       authenticated, RBAC-gated server functions
```

### Offer coverage on the result list — all / some / none

An agent can see which search results carry a promotion **without opening
them**, and the badge always names its scope: `all branches` (every branch
holding the item also has the offer) or `some branches` (only a subset). "On
offer" alone would be a promise that fails at whichever branch the customer
walks into.

Scope is classified once, server-side, by `classifyOfferScope` in
`lib/shams-crm/offers.server.ts`. The denominator is **branches that hold the
item**, read from `available_qty` on the availability response — the endpoint
returns a row for every branch in the chain, so counting rows would make every
offer look partial. That quantity is consumed there and dropped; it is never
rendered, and MIS `product/stock` remains the only stock number on screen.

**The cap is the load-bearing part.** There is no bulk offers endpoint
(`api-discovery.md` §11.5): each item is its own ~62 KB CRM request. A badge on
every row of an unbounded result set would be up to 100 upstream requests per
search, so `shamsGetOfferScopes` accepts at most **12** item codes, fans them out
server-side at 4 concurrent against the existing 60 s offer cache, and returns
one browser response. Above 12 the list says *"Offers not checked — narrow to 12
results or fewer"* rather than rendering blanks that would read as "no offer".
An item the CRM could not answer for is absent from the result, never reported
as having none.

An opened product gets its scope from the same response as its per-branch
prices (`shamsGetProductOffers` returns both), so the header badge and the price
rows cannot disagree, and no second request is made.

### Branch stock — status cards

The per-branch view is a responsive card grid rather than a table. As a table,
branch code, city, quantity and status all sat at roughly the same small muted
weight, so nothing could be scanned and a 137-row table had nowhere to go on a
phone. Each card now fixes one hierarchy — **branch → status → quantity →
offer** — with the quantity as the largest element and the offer as a footer
line only where one exists. Cards reflow rather than scroll sideways at any
width.

### CRM Sales History — `GET /api/v2/crm/data`

A loyalty lookup keyed on **mobile number** over a date range, paged. It backs
the **Customers** tab on `/shams`: search a number and a From/To range, see the
customer summary (name, mobile, customer ID, available points and their SAR
value) and their purchase history — invoice number, date, branch, item code,
item name, quantity.

Three properties of the payload drive the implementation, all read off the
2026-08-19 capture rather than assumed:

- **The branch arrives under an empty JSON key** (`"": "P0215-JEDDAH"`) — an
  unaliased upstream column. `normalize.ts` reads it via `CRM_BRANCH_KEY` and
  splits it into a branch code and a city.
- **`total` and `total_pages` are always `null`**, so there is no page count to
  render. Paging offers Previous/Next only, and "another page exists" is inferred
  from a full page measured against the `per_page` the API **echoed**.
- **The mobile number has two forms**: queried as nine digits (`555555555`),
  returned with the trunk zero (`0555555555`). `normalizeCrmMobile` accepts every
  way an agent writes it and canonicalizes server-side.

The default range is a **rolling 12 months**, with 1/3/6/12-month quick ranges
beside the picker; a quick range re-runs an existing search and otherwise just
fills the dates. Purchases are sorted **newest first in the normalization layer**
(`sortSalesNewestFirst`) rather than in a component, and grouped into month
headings by `lib/shams/crm-history.ts`, which preserves that order instead of
sorting again. The honest limit: the API exposes no sort parameter, so ordering
is guaranteed *within a page* — with the default 100-row page a year usually
fits in one. Month grouping is per page for the same reason; a month spanning a
page boundary gets a heading on both, and no row appears twice.

Client-side the history is held for 2 minutes (`staleTime`) with a 15-minute
`gcTime`, which is the actual search-performance fix: it was `0`, so every
return to a customer paid the full 1.8–2.2 s round trip again. The read is
**uncached server-side** on purpose — a submitted lookup, not
per-keystroke traffic, and a cache would be a store of identifiable customer data
keyed by mobile number. **The mobile number is never written to the URL**; the
Customers tab keeps its search in local state, unlike the other tabs.

### Invoice ↔ customer — one direction only

**An invoice cannot identify its customer, and the portal does not pretend
otherwise.** `sales/details` returns six customer-ish fields and none is a mobile
number: on the captured document they hold `Customer_Name: "CASH IN BOX-"` (a
till) and `Customer_Code: "14-00-0052"` (a ledger account), while the CRM knows
that same sale's buyer as `SAMI / 0555555555`. There is no key to join on.

The relationship the API *does* establish runs the other way: a `crm/data` row
names the document its line was sold on (`InvNo` + branch). So opening an invoice
from a customer's history records that pairing in
`src/features/shams/invoice-customer-link.ts` — an in-memory, tab-local map keyed
`(branchCode, docNo)` — and the Invoices tab shows Customer Name / Mobile /
Customer ID for that document alone. A document reached by typing its number
shows none, because nothing has established one.

Consequences worth keeping true:

- **Enrichment costs zero extra requests.** The customer was already on screen
  when the agent clicked, so there is no per-invoice CRM call and therefore no
  N+1 to batch or deduplicate.
- The handoff travels as `?doc=&branch=` — business identifiers, not a person.
- The invoice's own label is now shown as **Account** rather than Customer,
  because that is what it is.
- Points are shown on the customer summary only, never on an invoice: a live
  loyalty balance is not a property of a past document.

### Shams CRM — a second Shams system

`shams-crm.cloud` is the backend PharmacyCRM Desktop uses. It is **not** the MIS
above: different host, different credential, different auth header. It exists in
this codebase for one reason — `GET /products/names` returns the **whole**
~8,484-product catalog in one unpaginated response, while the MIS
`product/search` caps at 50 rows with no pagination, so broad and wildcard
searches are truncated before the wanted product is ever seen.

```
src/lib/shams-crm/client.server.ts       login + session (X-Session-Token), 401 -> one re-login -> one retry
src/lib/shams-crm/catalog.server.ts      full-catalog cache: 6 h TTL, single-flight, stale-on-failure fallback
src/lib/shams-crm/products.server.ts     the seam: the catalog as the Portal's own ShamsProduct
src/lib/shams-crm/diagnostics.server.ts  admin-only smoke test (login / catalog / cache reuse)
src/lib/shams-crm/alshrouq-config.server.ts  admin-only AlShrouq connectivity probe (read-only)
src/lib/shams-crm/types.ts               wire shapes + normalized models
```

### AlShrouq connectivity probe

`alshrouq-config.server.ts` reads `GET /integrations/alshrouq/config` through the
same `crmFetch` as everything else and reports what it finds: the CRM's payment
ids, the branch-option count and how many are `covered`, whether every branch
carries the six contract fields, whether the webhook is configured, and any
`missing_secrets`. Exposed as `shamsAlshrouqConfigProbe` behind `assertAdmin`,
rendered on `/admin/shams-diagnostics`.

It is a **read**. Create, refresh and cancel are deliberately absent from the
module, and a test asserts the only paths it touches are `/login` and the config
endpoint. Nothing in `src/features/orders` imports it, and nothing should: the
reverted integration destabilised order entry by reaching into `orderFormSchema`
and `buildOrderPayload`, so the courier code is kept without an edge into them.

Counts, booleans and an error kind cross the boundary — never the credentials,
the session token, a header, the webhook auth value or the raw response.
`missingSecrets` carries the *names* of absent configuration, never a value.

The branch mapping is **not** stored. `branch_options` is the CRM's to publish,
and it is the only source that also carries `covered`.

### AlShrouq payload builder

`alshrouq-payload.ts` turns an order into the create-order payload and does
nothing else — pure, deterministic, no HTTP, no Supabase, no React. Its only
import is `stripOrderPrefix`. Nothing sends the result yet; wiring it to the CRM
is a later phase, and `src/features/orders` neither imports nor calls it.

`buildAlshrouqOrderPayload(order, context)` returns a discriminated result:
`{ok: true, payload}`, `{ok: false, reason: "branch_unresolved"}`, or
`{ok: false, reason: "invalid", errors}`. The unresolved branch is its own
outcome because "AlShrouq does not cover this branch" is not something an agent
can fix by typing.

**The collect amount goes on the wire as `value`, not `order_value`.** The create
contract and the read model disagree about this one key. `POST
/integrations/alshrouq/orders` takes `value` — the key the Desktop's
`_collect_alshrouq_payload` builds, disassembled from the PharmacyCRM Desktop
build — while `GET /integrations/alshrouq/orders` *returns* the same figure as
`order_value`. This builder was originally written from the GET's 127 stored
deliveries and so sent `order_value`, a key the create endpoint does not
recognise. It is ignored rather than refused: the request returns 2xx and the
order is created with a collect amount of 0. Orders #10023 (COD, 95) and #9918
(COD, 89.35) both reached AlShrouq as 0 that way. Do not "correct" `value` back
to `order_value` on the strength of a GET response — the failure is silent, and
it tells a driver to collect nothing.

Three rules come from the CRM's own 127 stored deliveries rather than intuition,
and each is pinned by a test:

- **A collect amount of `0` is valid** — 107 of 127 real records carry it, COD and SPAN
  included. There is no `> 0` rule. Absent is still an error, because every real
  record has a number and defaulting a blank to 0 would invent a "collect
  nothing" instruction.
- **`client_order_id` is a string** — one real value is `"9396####"`. It is
  `display_no` with its stored leading `#` removed and no team prefix added; the
  `CC-`/`TS-` form is a display rendering only.
- **`customer_address` is a Maps link passed through verbatim** — 104 of 126 are
  unresolved `maps.app.goo.gl` short links, so nothing resolves them.

**A prepaid order collects nothing.** `order_value` is the figure the driver is
told to collect at the door, not what the pharmacy invoiced, and on a method
whose CRM label is `Paid` those are two different numbers — sending the invoice
is how a customer is asked to pay for one order twice. So a paid method fixes
`order_value` at `0`, and a blank invoice stops being an error there: there is
nothing to collect, which is a complete answer rather than a missing one. Every
other method is untouched, blank invoice included.

The method is recognised **by its published label, never by an id**, keeping the
"no payment enum in this repository" rule the module already followed for
`paymentOptionIds`. `paidPaymentTypeIds(options)` reads the live
`payment_options` and `buildAlshrouqOrderPayload` takes the result as
`context.paidPaymentTypeIds`; omitting it means "nothing is known to be prepaid"
and leaves the value exactly as before. The label pattern is anchored — `Paid`
matches, `AlshrouqPay` deliberately does not, because that method's courier
collects through AlShrouq's own wallet and zeroing it would tell a driver to hand
over goods and take nothing.

The rule is applied in the builder, which is the only place the wire value is
constructed, so a request that did not come from the Portal's screens obeys it
too. `useAlShrouqOrder` exposes the same answer as `paidPayment` (off until the
option list has loaded — an unknown method fails towards collecting money that is
owed, never towards waiving money that is not), and the approval dialog and the
dispatch card both render through `alshrouqOrderValue(invoiceValue, paidPayment)`
so the card, the confirmation and the payload cannot disagree. `orders.invoice_value`
is never rewritten: it is still the invoice, for everything else that reads it.

### AlShrouq branch resolution and the dispatch dialog

`alshrouq-branches.ts` is pure and holds **no branch ids**. It takes the CRM's
live `branch_options` and answers one question — is this `orders.branch_no`
dispatchable — returning `resolved` / `not_covered` / `unknown` (with a reason:
`no_branch_on_order`, `not_in_crm`, `no_id_published`). The three are kept apart
because they are three different conversations: a data-entry fix, an order that
must go another way, and something for whoever maintains the CRM.

The reverted integration froze 137 rows into a migration instead. A frozen copy
cannot express `covered` — the flag marking the 18 branches AlShrouq does not
serve. (Its ids were in fact 136/136 correct against the live config; the
migration comment claiming otherwise is wrong. Freezing was still the wrong
call.) `fetchAlShrouqDispatchOptions()` reads the same `/config` endpoint the
probe uses, cached 5 minutes and single-flight, and returns **only** the branch
and payment lists — `webhook_auth_value` is never read.

**Why the dialog exists.** A courier needs to know who to call, where to go, and
how the customer pays. The Portal is an order *log* and collects none of it: of
2,823 AlShrouq orders in the last 30 days, **7** carry both a customer name and a
phone, and payment type has no UI at all. Requiring those on the order form would
change the daily workflow for all 2,823 to serve the few that are dispatched —
and conditional-required rules in `orderFormSchema` are exactly what broke order
saving last time. So none of it is *required*, and what an agent must supply
before a **handover** is enforced by `alshrouqRequirements`, which gates the send
rather than the save.

**They are still saved, and that took a correction.** The four values —
`alshrouq_map_url`, `alshrouq_lat`, `alshrouq_lng`, `alshrouq_payment_type` — are
`orders` columns, added by 20260820185447 and verified present and typed in the
live database. Nothing wrote them: they lived in `useAlShrouqOrder`'s own
`useState`, so they reached the dispatch request and nowhere else. An agent who
filled in a location, its coordinates and a payment method, saved the order and
reopened it found all three gone, the card offering *"Select at dispatch"*, and
**Send to AlShrouq** reporting the details incomplete — asked again for what they
had already given. Delivery type, branch, customer and phone survived for the
only reason that mattered: they were already fields of the form, and so of the
payload.

They are form fields now, `optional().nullable()` in `orderFormSchema` and
written by `buildOrderPayload` on every save, so the contract runs
**form → payload → schema → column → rehydration** like every other field.
Optional is what keeps the original promise intact: an ordinary order sends four
nulls — which is what every row predating the columns holds — and no AlShrouq
rule can fail its save. The point is written as a pair or not at all, because
`orders_alshrouq_point_complete` is `(lat IS NULL) = (lng IS NULL)` and half a
point would fail the insert rather than the field.

`AlShrouqDispatchSection` renders **inside** the order form's contextual right
column, **above** `BranchPreviewPanel` and by the same rule those panels follow —
the form renders it from live state, exactly as it renders `BranchPreviewPanel`
on `form.branch_no`. It reflects the customer, phone, branch and order value as
they are typed, reads that state through props and takes no part in validation or
submit.

**What the card shows falls back to the order.** The dispatch row is the
authority once a handover exists — it is what AlShrouq was actually told — but
before that there is no row, and the answer is the order's own columns. Payment,
location, coordinates and the delivery note each read `dispatch ?? order`, which
is what stopped a fully configured order reporting "Select at dispatch" beside an
empty location.

**The safety gate still writes nothing, and is not worked around.** With
`ALSHROUQ_LIVE_DISPATCH_ENABLED` off an immediate handover returns `prepared` and
persists no dispatch row, deliberately — a dry run must not take the order's slot
and block the real send. No state was invented to represent the intent. It does
not need one: the *configuration* is now on the order, so a reopened order is a
complete AlShrouq order reading **Ready to send**, and nothing anywhere claims a
courier was contacted.

**Whether it renders at all is decided from persisted data, not from the form.**
`showAlShrouqSection` in `features/alshrouq/dispatch-selection.ts` is pure and
shows the card when *any* of three hold: the stored `orders.delivery_type` is
`"AlShrouq"`, the order has **any** `alshrouq_dispatches` row (cancelled and
resolved ones included), or `form.delivery_type` is `"AlShrouq"` — the last
covering a draft, where there is nothing persisted yet.

The gate used to be `form.delivery_type === ALSHROUQ` alone, and that is the
whole of the "card disappears when the order is reopened" bug. `form` is React
state seeded by an effect in `useOrderForm` that runs once per order id after the
`orders` fetch resolves, so it is empty on the first render of every page load
and stays empty whenever that hydration does not run. The order timeline sits in
the same column reading the *persisted* dispatch rows, so it went on narrating a
scheduled delivery beside no card at all — two surfaces describing one delivery
from two different sources. The dispatch rows now come from
`useOrderAlShrouqDispatch` under the query key the card and the timeline already
share, so this costs no extra request and the two cannot disagree about whether a
delivery exists.

The same module owns `currentDispatch` (the row with `cancelled_at IS NULL` —
the predicate of `alshrouq_dispatches_live_order_key`), `latestDispatch` and
`shownDispatch = current ?? latest`, which were three inline expressions in three
components and are now one tested rule.

A draft has no id, so it cannot dispatch and does not pretend to: the status
reads **Pending order creation** and the action is disabled. Statuses are limited
to what the backend supports — `Pending order creation`, `Checking…`,
`Ready to send`, `Verification required`, `Not available`, or the persisted
`dispatch_status` of an existing dispatch (see "The dispatch state model"
below). There is no fake "Sent" or "Delivered".

**No delivery fee is displayed, deliberately.** `GET /integrations/alshrouq/config`
publishes `branch_options`, `payment_options`, webhook settings and
`missing_secrets` — and no fee, price, charge, cost, tariff or rate of any kind.
The "3 SAR" that read as an unexplained charge was a misread branch *name*: the
CRM's names carry digits (`Arid 3 RDHN`, `SHUBRA 2 TIF`), so `P0304 — fayzia 3
BUR` was branch code and branch name. Labelling each value in the grid is the
fix; a fee panel would have been a fiction. `alshrouqDispatchContext` gates on the same rule
the form uses to allow editing — `edit_all_orders`, or `edit_orders` on an order
the agent owns — so no new permission, no migration, no parity change. Payment
type is never guessed from `order_type`: sending a driver to collect cash from
someone who has already paid is the failure that blank prevents.

The dialog sends what the agent typed to `alshrouqDispatchOrder` and nothing
else — no payload, no endpoint, no branch id. A component that assembled
requests is how the previous integration turned a re-render into a second
courier.

The card no longer holds a dialog of its own. It opens the **shared**
`AlShrouqApprovalDialog` that the create journey opens, and builds its request
with the same `dispatchInputFor` — see "One approval dialog, one request" below.

### The dispatch service and the production safety gate

`alshrouq-dispatch.server.ts` owns the whole workflow:

```
duplicate check → branch resolution → Phase 6 payload → SAFETY GATE
→ POST (once) → reconcile by client_order_id → persist → result
```

Everything up to the gate runs today. Everything after it is written, typed and
tested against a mocked transport, and **unreachable**.

**The gate** is `ALSHROUQ_LIVE_DISPATCH_ENABLED`, read from `process.env` inside
that one module. It is server-side and un-prefixed (a `VITE_` copy would be
inlined into the browser bundle, where a courier switch has no business being);
**not an argument** — `DispatchRequest` has no `live` field and the server
function's validator accepts only an order id and eight form strings, so no
caller can ask for a live dispatch, only the deployment can permit one; and
default-safe — only the exact string `"true"` opens it, so a typo fails closed.
With it shut the service returns `prepared`: nothing sent, nothing written, no
fabricated reference.

**The reference never comes from the POST body.** That response has never been
captured, so `dispatched` is populated from
`findAlshrouqOrderByClientOrderId` — the GET whose shape *is* evidence-backed.

**An indeterminate result never re-POSTs.** A timeout, 5xx or 401 after
transmission means the courier may already be moving, so the answer is a read.
Found → persisted as `accepted` and reported dispatched; not found → **persisted
as `indeterminate`** and left for a human. No branch in the file sends a second
POST. Both outcomes write a row, and the uncertain one is what stops the order
looking sendable — see "An uncertain dispatch is written down" below.

Duplicate protection is checked before anything is built, using the same
`cancelled_at IS NULL` predicate as the unique index
`alshrouq_dispatches_live_order_key`, so the check and the constraint cannot
disagree. A `23505` on insert is reported as "already sent", not as an error.

#### Sessions are keyed by principal (Phase 2 of per-agent attribution)

Shams CRM derives `created_by_user_id` and `created_by_username` from the
authenticated session and — confirmed by their API team — accepts **no**
caller-supplied attribution, no `X-On-Behalf-Of`, and no service-account
impersonation. The 127 cached deliveries in the Desktop package carry seven
distinct creators, so per-user login is the model the CRM is built around.

The client therefore holds sessions **keyed by principal** rather than in one
module-level slot. The old singleton was a real hazard, not a caching detail: a
Worker isolate is long-lived and serves many people, so one shared mutable
session meant a request made for agent B could go out under agent A's token, and
with attribution derived from the session that is an order recorded against the
wrong person.

`CrmPrincipal` is either `service` — the deployment credential, still used for
every shared read (catalog, offers, config, branch options, diagnostics), where
no `created_by` is written — or `agent`, carrying the **verified** MilaPortal
user id from `requireSupabaseAuth` claims. There is deliberately no way to pass a
key in from outside: a caller who could name the key could borrow a session.

Properties the tests pin: one login per principal, single-flight per principal
rather than globally, `invalidateCrmSession` scoped to one principal, a failed
login for one agent leaving every other session intact, and a cap of 64 agent
sessions so a long-lived isolate cannot leak — the service session is never the
one evicted.

**A missing agent credential fails closed.** It raises `not_configured` naming
the *agent* rather than the deployment, and never falls back to the service
account, because sending under the wrong identity is the one outcome this design
exists to prevent.

Phase 2 changes no dispatch behaviour: every existing caller still runs on the
service principal. Phases 1 (Vault-backed agent credential mapping) and 3
(switching the create POST to the agent principal) are not built.

#### Agent CRM identities (Phase 1)

`shams_crm_agent_links` (20260824090000) maps one MilaPortal agent to one Shams
CRM user. **The password is not in it.** There is no `crm_password` column and no
encrypted-blob column either — a column that can hold a secret is one somebody
eventually selects into a log, an export or a browser. The password lives in
Vault under `shams_crm_agent_<user_id>`, and the table stores only that name in
`vault_key`.

Three `SECURITY DEFINER` functions are the only way to it —
`shams_crm_store_agent_secret` (returns the *name*, never the value),
`shams_crm_agent_secret` (returns NULL for an absent or inactive link rather
than raising, so "no CRM account" is distinguishable from "the database failed")
and `shams_crm_forget_agent_secret`. All three are revoked from `anon` and
`authenticated`: a client must not be able to ask the database for a password.

Unlike `alshrouq_dispatches`, which grants SELECT to `authenticated` because an
agent may see their own order's delivery, this table has **no policy for any
client role**. A CRM username is half of another person's credential.

Two constraints carry the safety: `UNIQUE (crm_username)` so two agents cannot
share one CRM account and make attribution ambiguous, and a CHECK that an
`active` link must have both `verified_at` and `vault_key` — a half-configured
row cannot be dispatchable.

`agentCrmPrincipal()` turns a verified MilaPortal user id into a `CrmPrincipal`,
or returns `not_configured` / `inactive` / `missing_secret`. **It never falls
back to the service principal.** Dispatching under the deployment's own account
would succeed, look fine, and record the delivery against the wrong person —
which is the failure the whole design exists to prevent, so it is a returned
outcome rather than an exception someone might catch.

Verified against the live CRM on 2026-08-23: seven agents, all authenticating,
all active, all holding `alshrouq_delivery`, CRM user ids captured from `/me`.
Login and `/me` only — no order was created.

#### The dispatch runs as the order's agent (Phases 2–3)

`dispatchOrderToAlShrouq` resolves the CRM identity from `DispatchRequest.orderAgentId`,
immediately after the safety gate and before the POST, and passes it to
`createAlshrouqOrder`. There is deliberately no `?? SERVICE_PRINCIPAL` and no
`?? userId`: a missing identity returns the `agent_not_configured` outcome and
**nothing is sent**. Falling back would succeed, look fine, and record the
delivery against the wrong account.

**`orderAgentId` is the order's assignee, not the caller.** It is
`orders.agent_id`, read by `alshrouqDispatchOrder` from the row it has already
fetched — never from the request body, so a caller cannot name an agent. This is
the fix for a real failure: supervisors, administrators and the owner hold
`edit_all_orders` and are deliberately absent from `shams_crm_agent_links`, so a
supervisor creating an order for an agent and approving the handoff was told
"AlShrouq is not configured for your account" for an order whose own agent was
correctly linked. MilaPortal already separates the two ideas — `agent_id` is the
assignee, `created_by` defaults to `auth.uid()` — and the CRM's
`created_by_user_id` now agrees with `agent_id`. For an agent dispatching their
own order the two ids are the same value and nothing changed. An order with no
agent fails closed as `not_configured`.

`dispatched_by` and `scheduled_by` are unchanged and still record **who acted**.
The two questions are kept apart on the row: `crm_agent_id` (20260824160000) is
whose delivery it is.

The worker does the same thing later. It selects `crm_agent_id` with each due
row and logs in as that agent, so a delivery approved at 2pm and sent at 8pm is
still recorded against the agent the order was assigned to when it was approved
— frozen at approval time for the same reason `payload_snapshot` is, so
reassigning an order afterwards cannot move a pending delivery onto somebody
else's name. `scheduled_by` is the fallback for rows written before the column
existed, where an agent approving their own order made them the same value. If
the credential is gone the row goes **back to `scheduled`** with the reason
recorded and the `blocked` counter incremented — not `failed`, because nothing
is wrong with the order and the delivery still goes out once an administrator
fixes the link. A due row naming no agent at all is blocked for the same reason.

The sentence an agent sees names the order's agent rather than "your account",
since the reader is often the supervisor handing the order over and getting
*their* account linked is neither possible nor the fix.

What the CRM receives is unchanged: the ordinary create payload. Tests assert
the outgoing body carries no `scheduled_by`, `dispatched_by`, `agent_id`,
`user_id` or `created_by` — attribution travels in the session, never in the
body — and that the scheduled payload equals the snapshot exactly.

#### Scheduling is MilaPortal's alone

A scheduled order contacts nobody at creation time. It writes one local row with
`dispatch_status='scheduled'`, the MilaPortal instant in `scheduled_for`, and the
frozen CRM payload in `payload_snapshot` — and the CRM is told nothing until the
row is due, when it receives an ordinary immediate create.

The tests assert both halves: zero POSTs before the due time, and no scheduling
key (`scheduled_for`, `scheduled_at`, `dispatch_status`, `payload_snapshot`, …)
anywhere inside the frozen payload or in the `AlShrouqCreatePayload` contract
itself. The snapshot is checked field-by-field against what the immediate path
would have sent, so the two journeys differ only in *when* the POST happens.

#### The gate is reported to the UI, one way

The gate is read in `alshrouq-dispatch.server.ts` and nowhere else, and it is
still not an argument. But its *answer* is now reported to the screen, because
not reporting it produced the worst sequence this feature had: with the gate
shut an immediate handover returns `prepared` and writes **no row**, so the card
fell back to readiness and showed **"Ready to send"** beside a **Send to
AlShrouq** button — and the agent learned the deployment could not call a courier
only from a toast, *after* committing. Everything it said was true; it was said
too late.

Two server functions therefore carry a read-only boolean:

- `alshrouqDispatchContext` → `dispatchAvailable`, for a saved order's card.
- `alshrouqDeliveryOptions` → `dispatchAvailable` (typed as
  `AlShrouqOrderFormOptions`, a superset of the CRM's own
  `AlShrouqDispatchOptions`), for the **create** dialog, which has no order id
  yet and so cannot ask the first function.

Both compute it through `isAlShrouqLiveDispatchEnabled()` rather than reading
`process.env` a second time, so the gate keeps exactly one reader. It travels
one way: no validator accepts it, nothing assigns it from a request, and
`dispatchOrderToAlShrouq` does not consult it — the environment is still the only
thing that permits a send. The env var name stays out of the browser bundle,
which the build output is checked against.

What the surfaces do with it:

- The card gains a readiness, `prepared_only`, badged **"Prepared — dispatch
  unavailable"**. It is distinct from `unavailable`, which is a fact about the
  *branch*: this order could be delivered, and this installation cannot ask.
- The card withholds the send control (`covered && canContactCourier`).
- The dialog disables the dispatch action, labels it **"AlShrouq dispatch
  unavailable"**, and states the reason above the buttons.
- `describeApprovalAction` takes a fourth argument and drops the hand-over
  wording. The scheduled sentence changes too: a `scheduled` row would be picked
  up by a worker reading the same gate, so promising a courier for it would be
  just as wrong.

Both are optimistic while the query is in flight — a card that flashed "switched
off" on every load is one agents would learn to ignore. **No order data is
withheld**: every AlShrouq field is saved by the ordinary insert either way, and
"Create order only" remains a complete, honest outcome that keeps all of it.

### Creating an AlShrouq order — the approval flow

One primary action. For a new AlShrouq order the header's **Create order** button
opens an approval dialog instead of submitting; every other delivery method and
every edit submits exactly as it always has. There is no second dispatch button
anywhere.

The dialog offers **Create order only** and **Create order and send** — the
second changing verb to *schedule delivery* when the chosen time is in the
future, because "send" reads as *sent* to someone in a hurry and nothing is sent
at all on that path.

**Sequencing, and why the partial states are safe.** There is no transaction
across the two systems: the order is inserted through Supabase, the dispatch is
approved through a server function. So the design makes each partial state a
state the Portal already understands, via an `afterCreate` hook on
`useOrderForm` that mirrors the `recordInvoiceVerification` follow-up already
there:

| | |
|---|---|
| order insert fails | nothing else runs — no dispatch, no navigation |
| created, approval fails | an ordinary saved order, **no dispatch row**, no courier. Identical to "Create order only"; approvable later from the order page |
| created + scheduled | order + a `scheduled` row holding a frozen snapshot. Still no courier |
| created + immediate | order + whatever the server's one POST achieved |

The dangerous inverse — a dispatch with no order — cannot occur: approving one
requires an order id only a successful insert produces.

**The client never decides whether to send.** The approval carries a *time*, not
a permission. `alshrouqDispatchOrder` compares it to the **server's** clock to
route between scheduling and immediate dispatch, and the safety gate sits behind
both. Its input schema is an order id, eight form strings and an optional
`scheduledFor` — there is no `live` field, and a browser with a wrong clock
changes nothing.

**Nothing claims success without evidence.** With the gate shut the agent is told
*"AlShrouq dispatch is switched off, so no courier was contacted."* An
indeterminate result says so and says it has **not** been retried. Only a
reconciled `dispatched` reports a reference.

Where the AlShrouq requirements are enforced is deliberately split, and tested as
such: the Phase 6 builder holds coordinates **optional-but-paired**, per the
contract evidence, while `validateAlShrouqOrderFields` and the approval dialog
make a resolved location **mandatory** before "send" is enabled.

### AlShrouq customer location

**The customer's own Google Maps link is the authoritative location.** A customer
sends a link over WhatsApp and the agent pastes it; that link *is* the delivery
address, not a retyped street address and not a geocoder's guess at what one
meant. It is preserved verbatim and goes on the wire as `customer_address` —
which is what the CRM's own records do, 104 of 126 real deliveries carrying an
unresolved `maps.app.goo.gl` link.

**Resolution is server-side, and the coordinates are persisted.** A courier
routes to `customer_lat`/`customer_lng`, and a short link carries neither, only
a redirect. `resolveMapLink` follows it once and the numbers are stored; storing
only the URL would make a delivery depend on a shortener still being up months
later, on a request nobody is watching. The browser could not do this anyway —
the shortener sends no CORS headers — and the authoritative answer must not come
from a client that could be asked to report anything.

`parseMapsUrl` and `short-link.server.ts` were **restored from the reverted
integration** (`3917274`), where they worked; they went out with the wholesale
revert, not for a defect. Two protections were added on the way back: a length
cap before `new URL`, and redirect-loop detection.

**SSRF.** The pasted URL is untrusted input that the server then fetches, so:
an **allow-list** of Google hosts (not a deny-list of private ranges — DNS can
point a permitted name anywhere, and a deny-list is a list of the ranges somebody
thought of), HTTPS only, both **re-checked on every hop** so a redirect cannot
walk off the list; the response **body is never read**, only `Location`; and
caps on length, hops and time.

**No Google credentials.** Nothing here needs `GOOGLE_MAPS_API_KEY` or a browser
key. It reads coordinates already present in a URL, or follows a redirect to one.

**An unresolved link cannot be approved.** Failure produces blank coordinates,
which fail `validateAlShrouqOrderFields` exactly as a location nobody entered
would. No coordinate is ever fabricated, and latitude and longitude are never
typed — they exist only as the product of a successful resolution.

`AlShrouqLocation` — `originalUrl`, `resolvedUrl`, `latitude`, `longitude`,
`address` — is shaped to drop straight into the future
`payload_snapshot.location` without reshaping, so what is frozen at approval is
what a courier is eventually told.

### AlShrouq order data and scheduling contract

Three pure modules under `src/features/alshrouq`, each testable without a
browser, a clock or a network.

**`order-fields.ts`** — the fields AlShrouq requires that an ordinary order does
not: customer name, phone, location, latitude, longitude. **Deliberately not in
`orderFormSchema`.** The reverted integration put its conditional rules inside
that schema, which is the mechanism behind the "agents cannot save orders"
outage: anything there is on the save path for *every* delivery method, so a
mistake in an AlShrouq branch failed orders unrelated to AlShrouq.

Living outside it buys three properties, each pinned by a test:
`validateAlShrouqOrderFields` returns `[]` immediately for every other delivery
method, so the ordinary path is unchanged in *shape* and not merely in
behaviour; it returns errors rather than throwing, so nothing can escape into a
submit handler; and deleting the file would restore previous behaviour exactly.
`orderFormSchema` is byte-identical to the baseline, and a test asserts an
AlShrouq order with no name, phone or coordinates still parses — the 3,993
historical ones look like that and must stay editable.

**`scheduling.ts`** — `parseScheduleInput(date, "03:30 PM")` → a canonical UTC
instant for `scheduled_for`. Riyadh at a fixed +03:00 with no DST, which is what
makes the arithmetic exact rather than approximate; the browser's zone is never
consulted. The past is rejected outright, and a time within two minutes counts
as `immediate` so the clock passing the chosen minute while an agent reads a
confirmation does not silently turn a "send now" into a scheduled order.
`formatScheduledFor` renders `Aug 21, 2026 · 03:30 PM` by hand rather than
through `toLocaleString`, so two machines show the same delivery time.

**`use-scheduled-countdown.ts`** — display only. It has no network call, no
mutation and no server function; its one effect is a `setInterval` that
re-renders, and reaching zero changes a label. The target is read from the
persisted `scheduled_for` on every render, so a refresh, another browser or
another device reconstruct the same figure with no local state to disagree. Once
the row leaves `scheduled` the countdown reports `inactive`, because a number
ticking down beside an order a worker has already claimed is a lie.

**`payload_snapshot` immutability holds structurally.** It is written in exactly
one place — the insert in `scheduleAlShrouqDispatch` — and appears in no
`UPDATE` anywhere. The order save path never touches `alshrouq_dispatches`. No
fix was needed; the invariant is a property of where the write lives.

### Scheduled AlShrouq dispatch

A courier handoff can be parked and performed later without anyone's browser
being open.

```
agent approves → alshrouq_dispatches row (status='scheduled', payload_snapshot)
pg_cron (every minute) → alshrouq_dispatch_due() → net.http_post
  → /api/alshrouq-run-scheduled → runDueAlShrouqDispatches → SAFETY GATE
    → one POST → reconcile → persist
```

**The cron job is registered by migration** (`20260821210000`), so that it is
reproducible: a job that exists only because somebody once ran `cron.schedule` in
a console is one nobody can rebuild, review, or notice the absence of.

> **Correction (Phase 10H).** An earlier version of this paragraph said the
> database had *lost* its `process-email-queue` job in the Lovable revert — 54
> runs ending 2026-08-20 23:15:19Z — and that outbound email had been dead since.
> That was verified wrong against the live database on 2026-08-22.
> `email_queue_dispatch()` **unschedules itself** when both pgmq queues are
> empty, and `email_queue_wake()` — an `AFTER INSERT` trigger on both queues,
> both present and enabled — re-arms it on the next enqueue. An empty `cron.job`
> beside empty queues is that design's idle state, not a regression. Email needs
> no restoration, and no migration registers it.

**The snapshot is the authority.** `payload_snapshot` is written when the agent
approves and read at dispatch time; the worker never reads `orders` — a test
asserts the only table it touches is `alshrouq_dispatches`. So a Portal edit
after scheduling cannot change what a courier is told, because nobody approved
that version.

**Claiming** is a compare-and-swap (`UPDATE … WHERE id=? AND
dispatch_status='scheduled'`), so two workers, or a cron firing twice, dispatch
each order once. The unique index `alshrouq_dispatches_live_order_key` remains
the backstop — and because a `scheduled` row is not cancelled, scheduling an
order *reserves its slot* against a second schedule or a manual send.

**States:** `scheduled → processing → accepted | failed | indeterminate |
cancelled`. `processing` is a claim, not a report. `indeterminate` is terminal
until a human resolves it, and is never followed by another POST — the whole
point of scheduling is that nobody is watching.

**With the gate closed the run claims nothing**, sends nothing and invents no
status; rows stay `scheduled` and are picked up whenever it opens.
`alshrouq_dispatch_due()` is also a no-op while the vault secrets
`alshrouq_scheduler_url` / `alshrouq_scheduler_secret` are absent, so applying
the migration to an unconfigured environment does nothing.

### The dispatch state model, and the order timeline

One dispatch row per order is the whole state model. `dispatch_status` is the
lifecycle — `scheduled → processing → accepted | failed | indeterminate |
cancelled` — and the timestamps beside it are the history:

| Column            | Written by                          | Means                          |
| ----------------- | ----------------------------------- | ------------------------------ |
| `scheduled_at`    | `scheduleAlShrouqDispatch`'s insert | the agent approved a slot      |
| `scheduled_for`   | the same insert                     | when the courier is due        |
| `last_attempt_at` | the worker's compare-and-swap       | a worker claimed the row       |
| `dispatched_at`   | the insert / the accepted update    | the send completed             |
| `cancelled_at`    | a cancellation                      | the delivery was called off    |
| `last_error`      | the failed / indeterminate update   | a fixed, safe sentence         |

**The timeline is derived from those columns, not from a second event log.**
`features/alshrouq/dispatch-timeline.ts` is pure — no React, no network, no
clock — and maps a row to events:

```
scheduled_at         → "AlShrouq delivery scheduled"   (+ due time, + countdown)
last_attempt_at      → "AlShrouq dispatch initiated"   ("Submitted to AlShrouq")
status=accepted      → "Accepted by AlShrouq"          ("Reference: 6099196")
refreshed_at + url   → "Tracking available"            (+ the link)
status=failed        → "AlShrouq dispatch failed"      (+ safe reason)
status=indeterminate → "Delivery status unavailable"   (+ "not automatically retried")
cancelled_at         → "AlShrouq delivery cancelled"   ("Cancelled before dispatch")
```

**Tracking is its own step, not a badge on the acceptance.** A delivery can be
accepted with no tracking page at all, so the link is a separate event or it is
absent — and it appears once rather than on both. Its timestamp is `refreshed_at`,
the moment the reconciliation record carrying the URL was read; there is no
"tracking became available" column and this is the honest stand-in, falling back
to `dispatched_at` only when a row has the URL without it.

**Nothing says "Delivered".** No backend evidence of delivery exists — the
reconciliation record carries a status word, not a lifecycle — so no event
claims one, and a test sweeps every state asserting that no title mentions
delivered, out for delivery, en route or a driver.

An event with no persisted timestamp is **not emitted**. A row that says
`scheduled` but carries no `scheduled_at` produces nothing rather than a guessed
instant, and an order with no dispatch row contributes no events at all — so a
Store Pickup order's timeline is byte-for-byte what it always was.

**Writing `order_activity` rows instead was the alternative, and it was
rejected.** The worker's guarantee is that the only table it touches is
`alshrouq_dispatches` — asserted by a test, and the reason a Portal edit cannot
reach a courier. Giving it a second table to write would trade that guarantee
for events it can already be asked for.

**There is still one timeline.** `OrderActivityTimeline` normalises
`order_activity` rows and dispatch events to one entry shape and sorts the
combined list by time. It is not a second component and not a second card.

`useOrderAlShrouqDispatch` is the single client read of the row, keyed
`["orders","dispatch",id]` so it is swept by the same `orders.all()` boundary as
everything else about an order. The card and the timeline share it, so the two
cannot disagree. **No polling**: there is no `refetchInterval`, because the
dispatch happens server-side whether or not a browser is open. The row is
re-read on invalidation after an approval, and that is all.
`alshrouqDispatchContext` no longer returns the dispatch row — it used to, which
made two reads of one row that could show different things.

### What each state is called on screen

The badge and the timeline use one vocabulary, and it is not the database's:

| `dispatch_status` | On screen |
| --- | --- |
| `scheduled` | Scheduled |
| `processing` | Sending to AlShrouq |
| `accepted` | Accepted by AlShrouq |
| `failed` | Dispatch failed |
| `indeterminate` | Delivery status unavailable |
| `cancelled` | Scheduled delivery cancelled |
| anything unrecognised | Dispatch recorded |

`accepted` used to show `row.status` — AlShrouq's own word, e.g. "Order Created".
It is more specific, but it is not a status *this* system defines, and a courier
word an agent has never seen reads as a fault. The verbatim value is still shown
on the timeline event beside the reference, where it is context rather than a
label; the summary carries it as `courierStatus`.

Two states get a sentence rather than a badge, in a bordered band on the card:

* **indeterminate** — fixed copy: *"AlShrouq response could not be confirmed.
  The order has not been automatically retried."* The second sentence is the one
  an agent must not miss, because reading this as a failure is what makes someone
  send it again.
* **failed** — the persisted `last_error`, but only through `safeFailureReason`,
  which drops anything shaped like a URL, a header, a token or a stack trace and
  falls back to a generic sentence.

A test asserts no label contains `dispatch_status`, `payload`, `snapshot`,
`POST`, `cron`, `worker` or `reconcil`.

### The one-time immutable handoff

Once an order has a dispatch row in any state but `cancelled`, the Portal offers
no way to send it again. `summariseAlShrouqDispatch(row).handedOver` is the flag,
and it is **true for `indeterminate` as well as `accepted`** — an unconfirmed
send is exactly where a second attempt does the most damage, because the courier
may already be moving.

The card says so in as many words: *"AlShrouq submission completed. Changes made
in MilaPortal after submission are not sent to AlShrouq."* There is no AlShrouq
order-update endpoint in this integration, so there is no "Update AlShrouq"
control and no "Syncing" state — a test asserts the card contains no such
wording. The page's primary action for a saved order is **Update order**; the
approval dialog is intercepted on create only.

The send control is **absent, not disabled**: a disabled button beside a delivery
already on its way still invites a click. Three layers enforce this and they
cannot disagree, because they use the same predicate:

1. the UI does not render the action,
2. `prepareAlShrouqDispatch` returns `already_dispatched` before anything is
   built or sent,
3. the unique index `alshrouq_dispatches_live_order_key` (`UNIQUE (order_id)
   WHERE cancelled_at IS NULL`).

**Editing a dispatched order changes nothing about the delivery.** The order save
path and the dispatch path share no code and no table: `payload.ts`,
`use-order-form.ts` and `use-orders-mutations.ts` mention neither
`alshrouq_dispatches` nor `payload_snapshot` nor any dispatch function, and a
test asserts each of those absences. The only edge from the form to the dispatch
layer is `afterCreate`, which runs after an **insert**; there is no
`afterUpdate`. So changing a name, a phone, an address, a payment type, a value,
a note or a branch cannot send a request, rebuild a snapshot, create a second
dispatch, or change the reference or the tracking URL.

`payload_snapshot` is written in exactly **one** statement in the repository —
the insert in `scheduleAlShrouqDispatch` — and appears in no `UPDATE` anywhere.
Tests assert both halves: that the single writer is that insert, and that the
column appears in no update's argument, including the worker's four.

### The state machine, in one place

`shams-crm/alshrouq-dispatch-state.ts` is pure and dependency-free, and it owns
the rules the rest of the integration asks about a stored `dispatch_status`:

| Question | Answer |
| --- | --- |
| `ownsDispatchSlot` / `blocksNewDispatch` | everything except `cancelled` |
| `canCancelDispatch` | `scheduled` only |
| `isWorkerClaimable` | `scheduled` only |
| `isTerminalDispatchStatus` | `accepted`, `failed`, `indeterminate`, `cancelled` |

These rules used to be spread across a duplicate check, a worker query, a claim
predicate and a piece of UI, each stating the lifecycle in its own words — and
the states where they must agree are exactly the states where disagreeing puts a
second driver at a customer's door. The order card's `handedOver` flag is now
`blocksNewDispatch` itself, so the screen and the server refuse on one rule.

**An unrecognised status blocks.** A value this build does not know — added to
the database ahead of the client, or written by something newer — counts as
owning the slot, and the card reports it as "Dispatch recorded" rather than
guessing. Offering "Send to AlShrouq" beside a dispatch nobody here can interpret
is how a second courier gets ordered.

### An uncertain dispatch is written down

An immediate dispatch whose POST cannot be confirmed and whose reconciliation
finds nothing now **persists a row** with `dispatch_status='indeterminate'`.

It used to return without persisting, on the reasoning that a record must not
claim a courier that may not exist. It does not claim one: there is no reference,
no tracking URL and no `accepted` anywhere on the row. What it records is that a
request was made and the outcome is unknown — which is the fact of the matter.

Writing it is what makes the order stop looking sendable. The row takes the
order's slot in `alshrouq_dispatches_live_order_key`, so the duplicate check, the
unique index and the order card all refuse a second send. Returning nothing left
an order that had already been transmitted looking untouched, and the next click
would have put a second driver on the road.

**It is still not `failed`.** Nothing reinterprets an unknown outcome as a
refusal, and nothing retries it — there is no code path in this repository that
re-POSTs an indeterminate dispatch. Resolving one is a human action.

`approvalChangedDispatchState` includes `indeterminate` for the same reason: the
page must re-read the row so the card stops offering to send.

### Resend policy, state by state

| State | A second POST? | Why |
| --- | --- | --- |
| `scheduled` | blocked | already owns the slot; a schedule reserves it |
| `processing` | blocked | a worker has claimed it and may be mid-request |
| `accepted` | blocked | the courier has it |
| `indeterminate` | blocked | the courier may have it, and nobody can say |
| `failed` | blocked | existing scheduler semantics, preserved — no retry policy was invented |
| `cancelled` | allowed | see below |

**`cancelled` is the one state that frees the slot, and that is safe only
because of what cancellation refuses.** A dispatch can be cancelled *only* while
`scheduled`, so a cancelled row is always one that contacted nobody. If an
`indeterminate` row could be cancelled its slot would be released and the order
would become sendable again — the exact hole this phase closed — so the
refusal is what the safety rests on, not the cancellation's own care. A test
pins it from both ends.

**A 4xx on the immediate path still persists nothing**, and that asymmetry with
the scheduler's `failed` is deliberate: a 4xx is the CRM saying it understood the
request and declined it, so nothing was created and the order is genuinely
sendable. A 5xx is not a refusal and never takes this path.

### Cancelling a scheduled dispatch

`cancelScheduledAlShrouqDispatch` moves `scheduled → cancelled`, setting
`dispatch_status` and `cancelled_at` **in one statement** — they are the two
markers the unique index, the due query and the timeline all read, and writing
them separately would leave a window where the row disagreed with itself.

**It contacts nobody.** There is no transport on the path: a scheduled dispatch
has not been sent, and this integration has no AlShrouq cancellation endpoint to
call even if there were something to call off. A test replaces `globalThis.fetch`
and asserts not one outbound request.

**The race with the worker.** An agent can cancel in the same second `pg_cron`
fires. Both operations want the same transition out of `scheduled`:

```
worker: UPDATE … SET dispatch_status='processing' WHERE id=?       AND dispatch_status='scheduled'
cancel: UPDATE … SET dispatch_status='cancelled'  WHERE order_id=? AND dispatch_status='scheduled'
```

Postgres serialises two updates to one row, so exactly one matches and the other
matches nothing. There is no window in which both succeed and no read-then-write
for a concurrent transaction to slip between.

If cancellation wins, the worker's claim finds nothing — and an unclaimed row is
never sent, even by a run that had already selected it as due. If the worker
wins, cancellation returns `{ kind: "conflict" }` carrying *"Dispatch is already
being processed and cannot be cancelled."* It does not retry and it does not
overwrite a `processing` row, which may be mid-request.

Every other state is refused with a sentence naming it —
`describeCancelRefusal` — so a state cannot be added to the lifecycle without
copy for it. `payload_snapshot` is untouched by cancellation, and the order stays
in MilaPortal unchanged.

The cancelled row produces **"AlShrouq delivery cancelled"** through the existing
Phase 10F timeline derivation, which already reads `cancelled_at`. No second
event table, and the worker still touches only `alshrouq_dispatches`.

**Who cancelled is recorded** (`20260822120000`). `cancelled_by` is a nullable
uuid referencing `auth.users`, written server-side from `requireSupabaseAuth`'s
verified claims — the server function's validator accepts an order id and nothing
else, so a browser cannot attribute a cancellation to somebody else by asking to.
It reuses the pattern `dispatched_by` and `scheduled_by` already set rather than
introducing a second audit mechanism, and `admin_activity` is deliberately not
involved: that table records administration of the portal, and this is one more
fact about a dispatch row. Cancellations made before the column existed keep a
NULL actor, which is the honest record.

Authorization is enforced at the server function — `edit_all_orders`, or
`edit_orders` on an order the agent owns, the same rule as dispatching and
editing. No new permission key.

### Every insert states its status

`dispatch_status` is written explicitly by every application insert, never left
to the column's `DEFAULT 'accepted'`. The default remains for the four rows that
predate scheduling; it is a poor way for code to express intent, and defaulting
an *uncertain* dispatch to `accepted` would be the worst possible mislabel.
`attempt_count` and `last_attempt_at` are stated on the same insert — one attempt
was made, and there is never a second.

### Dispatch writes run as the service role

`alshrouq_dispatches` grants `SELECT` to `authenticated` and **no write of any
kind**, deliberately: a row must never be able to claim a dispatch that did not
happen, so every write comes from the code that actually called the CRM.

`requireSupabaseAuth` supplies the *caller's* RLS-bound client, so the inserts
`alshrouqDispatchOrder` needs were being refused by Postgres and no dispatch
record could ever be written — silently, because the unit tests use a fake
client. That silence was the danger rather than the failure: an uncertain
dispatch whose row never lands is an order that still looks sendable.

The dispatch and cancellation writes therefore use `supabaseAdmin`, the pattern
`admin.functions.ts` uses throughout and the client the scheduled worker already
runs on — and, as there, only *after* the handler's permission check has passed.
The order read and the `has_permission` RPCs stay on the caller's client, where
RLS is exactly what should decide them. No RLS policy was added or weakened.

### Verified against the live database — 2026-08-22

Phases 10H and 10I checked the deployed Supabase project rather than the
repository. Every statement below is an observation, not an inference.

**The schema is now in sync (Phase 10I).** `20260821210000` and `20260822120000`
were applied to production and recorded in
`supabase_migrations.schema_migrations`, so a later `db push` sees them as done.
`alshrouq_dispatches` now carries all ten lifecycle columns —

```
dispatch_status   scheduled_for   payload_snapshot   scheduled_by
scheduled_at      last_error      attempt_count      last_attempt_at
cancelled_at      cancelled_by
```

— both CHECK constraints (`alshrouq_dispatches_status_valid`,
`alshrouq_dispatches_scheduled_has_time`), the partial due index
`alshrouq_dispatches_due_idx`, and `alshrouq_dispatches_cancelled_by_idx`. The
one-courier-per-order guarantee `alshrouq_dispatches_live_order_key` — `UNIQUE
(order_id) WHERE cancelled_at IS NULL` — survived unchanged.

The four pre-existing rows are all `dispatch_status = 'accepted'` with no
snapshot and no schedule, which is what they are: completed deliveries that
predate scheduling. `orders` was not touched — 5,240 rows and 23 columns before
and after — and the only trigger on the dispatch table still just stamps
`updated_at`, so nothing at the database level can mutate `payload_snapshot`.

**The scheduler exists and is dormant, and that was observed rather than
assumed.** `public.alshrouq_dispatch_due()` is deployed byte-identical to the
migration, `SECURITY DEFINER`, with `EXECUTE` granted only to `postgres` and
`service_role`. One cron job — `alshrouq-dispatch-due`, `* * * * *`, active,
running `SELECT public.alshrouq_dispatch_due();` — and no duplicates. Its runs
succeed in ~3 ms and return `0`: there is no due work, so the function returns
before it ever reads vault. `net.http_request_queue` is empty and the only row in
`net._http_response` predates the migration, so **no outbound request has been
made**. The scheduler is wired, firing, and reaching nobody.

`pg_cron` 1.6.4, `pg_net` 0.20.3, `pgmq` 1.5.1 and `supabase_vault` 0.3.1 are all
installed.

**What is still missing, deliberately.** The vault secrets
`alshrouq_scheduler_url` / `alshrouq_scheduler_secret` are absent — only
`email_queue_service_role_key` exists — and the runtime
`ALSHROUQ_SCHEDULER_SECRET` is unset. Nothing was invented to fill them. Until
they are configured the waker returns `0` even when work *is* due, so a scheduled
dispatch would sit in `scheduled` rather than being attempted. That is the
intended fail-closed behaviour, and it is the next deployment step rather than a
defect.

**What is left before live dispatch.** The operator recovery gap is closed — see
"Resolve dispatch" below — so what remains is configuration rather than
architecture. Phase 10K walked the chain and found two things that would have
made a configured scheduler fail silently.

### Scheduler preflight — 2026-08-21

Checked link by link, without contacting the courier.

**pg_cron → the waker: healthy.** 25 runs, every minute, all `succeeded`, none
longer than a few milliseconds. `alshrouq_dispatch_due()` returns `0` because
nothing is due, so it exits before it ever reads vault. `net.http_request_queue`
is empty: no request has been made.

**The waker → the endpoint: blocked, twice over.**

1. **The route is not in the deployed build.** `POST /api/alshrouq-run-scheduled`
   on production answers **404**, while `POST /api/cdr-sync` and
   `POST /lovable/email/queue/process` both answer **401** — so API routes are
   served, and this one simply is not there. It is correctly registered in
   `routeTree.gen.ts` and present in the local build output, so this is
   deployment lag rather than a defect: production is running a build older than
   the route. **Deploying current `main` is a prerequisite**, and configuring the
   vault secrets before that would arm a scheduler that posts into a 404.

2. **The URL must be the canonical origin.** The app answers on its own domain
   (`milaportal.live`), and the `*.lovable.app` host issues a `307` to it.
   `pg_net` does **not** follow redirects, so a vault `alshrouq_scheduler_url`
   pointing at the `lovable.app` host would post into a redirect and do nothing at
   all — with no error anywhere, because the waker fires and forgets. The value to
   store is `https://milaportal.live/api/alshrouq-run-scheduled`, and it should be
   re-checked if the domain ever moves.

**The dry-run instrument.** `GET` on the same route is how the chain is checked
without any possibility of a courier request: it reports `configured`, `due` and
`liveDispatchEnabled`, and a test asserts it never calls
`runDueAlShrouqDispatches`. It is behind the same shared secret as the run, so it
cannot be used to enumerate scheduled work either. Once the deploy lands, an
authenticated `GET` is the first thing to try — it exercises DNS, TLS, routing,
the handler and the secret comparison, and dispatches nothing.

**Then, in order:** deploy `main`; create the two vault secrets
(`alshrouq_scheduler_url` pointing at the canonical origin's
`/api/alshrouq-run-scheduled`, and `alshrouq_scheduler_secret`) together with the
matching runtime `ALSHROUQ_SCHEDULER_SECRET`; confirm with an authenticated
`GET`; schedule one order and watch it reach `scheduled` and then be claimed with
the gate still shut (the run reports `skippedDisabled` and touches nothing); and
only then consider `ALSHROUQ_LIVE_DISPATCH_ENABLED`.

Each of those is a deliberate human decision, and none should be taken on the
strength of the tests alone: no dispatch has ever been created against the live
schema, and no courier has ever been contacted from this codebase.

**The write path is protected by the policy, not the grant.** `alshrouq_dispatches`
has RLS enabled with exactly **one** policy — `SELECT`, `TO authenticated`,
qualified by the order's own visibility — and none for `INSERT`, `UPDATE` or
`DELETE`. Under RLS a command with no permissive policy is denied, which is what
refuses a write from the caller's own client.

It is *not* the table grant. `authenticated` and `anon` both hold
INSERT/UPDATE/DELETE grants here, because Supabase issues them by default on new
public-schema tables and the migration's `GRANT SELECT` is additive rather than
restrictive. The `20260820180000` comment claiming there is "no grant" describes
the intent, not the outcome. The protection is real either way, and the Phase 10G
fix — routing dispatch and cancellation writes through `supabaseAdmin` after the
handler's permission check — is required for exactly the reason given, via the
policy rather than the grant.

**Data.** 4,085 orders carry `delivery_type = 'AlShrouq'`; `alshrouq_dispatches`
holds 4 rows, all predating scheduling. `cron.job_run_details` holds 54 rows, the
last at 2026-08-20 23:15:19Z — the email job draining its queue and disarming.

**What remains unverified.** No dispatch was created, no permission boundary was
exercised end to end, and the scheduler chain was never fired: doing any of those
needs either a write to production or the courier gate, and both were declined.
Those links are covered by source and unit assertions only.

### Resolve dispatch — settling what the machine gave up on

Two lifecycle states are terminal with no automatic way out: `indeterminate`
(transmitted, outcome unknown) and `failed` (AlShrouq refused it). Both are
deliberate — an uncertain dispatch must never be retried by machinery, because
the courier may already be moving — and both leave a row a person has to settle.
**Resolve dispatch** is where that answer goes.

**It is reconciliation, never resending.** `alshrouq-resolve.server.ts` has no
transport in its import graph and no outcome has a branch that sends anything.
Tests replace `globalThis.fetch` and assert zero requests for *all three*
outcomes, including "confirmed not delivered". The action is called *resolve* and
never *retry*, and a test asserts no outcome label contains "retry", "resend" or
"send again".

**Allowed source states:** `indeterminate`, `failed` — and only while no answer
has been recorded. Everything else is refused with a sentence naming why
(`describeResolveRefusal`).

**The three answers**, from `alshrouq-resolution.ts`:

| Outcome | Means |
| --- | --- |
| `delivered` — "Confirmed delivered" | AlShrouq confirmed the delivery exists and was completed |
| `not_delivered` — "Confirmed not delivered" | AlShrouq confirmed no delivery was created |
| `undetermined` — "Unable to determine" | the outcome could not be established even after checking |

**Three vocabularies that must not merge.** `status` is AlShrouq's own word,
verbatim — courier truth. `dispatch_status` is this system's lifecycle — machine
truth. `resolution_outcome` is what a person established afterwards — operator
truth. A resolution **never** overwrites `dispatch_status`: a resolved row stays
`indeterminate` or `failed`, because that is what the machine actually observed,
and an operator's conclusion does not get to rewrite the record of what the
courier said. The database enforces the separation — `resolution_outcome` has its
own CHECK listing only operator values.

**The dispatch slot is deliberately not freed.** Resolution writes no
`cancelled_at`, so the row keeps its slot in
`alshrouq_dispatches_live_order_key` and `blocksNewDispatch` still refuses a
second send — for every outcome, "confirmed not delivered" included. That reads
backwards at first: an operator saying no courier exists sounds like it should
release the order. But releasing it *is* authorising a second courier, and
recording what happened and re-authorising a delivery are different decisions
that deserve to be made separately by someone who can see the consequences of
each. A resend workflow, if one is ever wanted, is its own explicit thing.

**Authorization: `admin_access`**, the narrowest *existing* permission that fits.
Resolving a dispatch is supervisory rather than order editing — it overrides an
uncertain courier outcome with a person's judgement, and an agent who may edit
their own orders should not be able to declare a delivery settled. `owner`,
`admin` and `supervisor` hold it by default; `customer_care`, `telesales` and
`auditor` do not. No new permission key, so no migration, no `has_permission()`
change and no parity update.

**The client controls none of the identity.** The validator accepts exactly three
fields — a dispatch id, an outcome from a closed enum, and a note.
`resolved_by` comes from the verified session's claims and `resolved_at` from the
server clock; there is no field through which a browser could attribute a
resolution to someone else, backdate one, or request a lifecycle transition. The
visibility check runs on the *caller's* RLS-bound client, so a dispatch they may
not see is reported absent rather than forbidden; the write then runs as the
service role, the same pattern as every other write to this table.

**Concurrency.** The update is a compare-and-swap guarded on both halves of
"resolvable" — `.in(dispatch_status, ['indeterminate','failed'])` and
`.is(resolution_outcome, null)`. Two operators resolving at once produce exactly
one resolution, one audit event and one honest `already_resolved`; the second is
never allowed to overwrite the first operator's account. The guard is *disjoint*
from the worker's claim and from cancellation, both of which key on `scheduled`,
so a row is either still in play or given up on and the two workflows cannot
collide at all.

**Audit.** A successful resolution writes one `order_activity` row
(`alshrouq_dispatch_resolved`) carrying the outcome, the operator's note and the
lifecycle state it was resolved from — and nothing else. No payload snapshot, no
courier response body, no customer identity; the service reads none of them. This
is a *person's* action, so it belongs on the order's own history beside every
other human act, which does not weaken the worker's invariant — the worker is not
what runs this code and still touches only `alshrouq_dispatches`.

The timeline renders it as **"AlShrouq dispatch resolved by operator"**, worded
that way because it is the one entry that could be mistaken for a courier status
and is not one. AlShrouq's own events read "Accepted by AlShrouq"; this reads as
a decision, because that is what it is. The card shows the same distinction:
*"Resolved by operator: … This is a reviewed decision, not a courier update."*

**The note is required**, 3–280 characters, because the note *is* the evidence —
"Confirmed by phone with AlShrouq operations" is the whole content of the
decision, and a resolution with no account of how it was reached is an unsourced
claim in an audit trail. It is stored as written and rendered on the timeline, so
the dialog says plainly that it is not a place for customer contact details.

**Schema** (`20260823120000`, applied 2026-08-22): four nullable columns, two
CHECK constraints — one restricting the outcome vocabulary, one refusing a
half-written audit record where an outcome has no author or a timestamp has no
outcome — and a partial index over the operator's worklist
(`dispatch_status IN ('indeterminate','failed') AND resolution_outcome IS NULL`).
Additive and idempotent; nothing outside `alshrouq_dispatches` is touched, and a
test asserts the executable SQL names no other table, no cron, and no vault.

**What this does not do.** It does not free the slot, contact AlShrouq, retry
anything, create a dispatch, change an order, or alter the state machine.
`blocksNewDispatch` is unchanged and a test re-asserts it for every status.

### Tracking URL provenance

`tracking_url` comes from `findAlshrouqOrderByClientOrderId` — the reconciliation
GET whose shape *is* evidence-backed — and from nowhere else. Nothing constructs
one, no format is assumed, and no URL is derived from the external reference.

When the column is null the link is simply absent: no disabled button, no
placeholder. **The external reference stays visible either way**, because
"AlShrouq has this order and it is called 6099196" is true whether or not a
tracking page exists.

Before it reaches an anchor the value passes `safeTrackingUrl`, which accepts
`http`/`https` absolute URLs only. The column is upstream text, so the scheme is
checked rather than trusted, and anything else is treated as no URL rather than
rewritten. Links open with `rel="noopener noreferrer"`, the pattern the branch
panels already use.

### The scheduled countdown

Display only, from `use-scheduled-countdown.ts`, rendered in both the AlShrouq
card and beside the timeline's scheduled event. It reads the persisted
`scheduled_for` on every render, so a refresh, another browser or another device
reconstruct the same figure — there is no local state to disagree with the row.

The card presents it as two labelled values — **Scheduled for** with the instant,
and **Dispatch begins in** with the remaining time — rather than a running clock
that dominates the panel.

Reaching zero changes a label to **"Awaiting dispatch"** and nothing else. That
wording is load-bearing: the moment has passed and the worker has not reported,
so the delivery has *not* been sent, and a screen that said otherwise on the
strength of a clock would be claiming something no row supports. The
hook has no network call, no mutation and no server function; its only effect is
a `setInterval` that re-renders. The dispatch is performed by `pg_cron` → the
worker → the safety gate, which is why a closed laptop, a logged-out agent or a
sleeping tab makes no difference to whether the delivery happens. A countdown
that fired the request would mean two open tabs sending two couriers and a
closed one sending none.

Once the row leaves `scheduled` the countdown reports `inactive` and the card
shows the persisted status instead.

### One approval dialog, one request

There were two dispatch UIs: the create journey's approval dialog, and a second
complete implementation inside the AlShrouq card with its own field set, its own
validation and its own request. Two implementations of one handoff is how the
details silently diverge, so they are now one.

`AlShrouqApprovalDialog` takes `mode: "create" | "existing"`. The copy and the
buttons differ — a new order can be recorded without being sent, an existing one
is already recorded — and everything underneath is identical: the same fields,
the same `AlShrouqApprovalPlan`, the same `alshrouqDispatchOrder`.

`approval.ts` is the contract. `dispatchInputFor(orderId, plan)` is the **only**
place either journey assembles a dispatch request, and `describeApprovalResult`
is the only place either journey chooses what the agent is told — so the same
server result cannot be reported two different ways depending on which screen it
came from. Neither builds the object inline any more, and a test asserts it.

The approval still carries a *time*, not a permission: the server compares it to
its own clock to route between scheduling and immediate dispatch, and the safety
gate sits behind both. There is no `live` field anywhere in the plan, the input
or the request.

**The AlShrouq card sits above the branch card** in the order form's right-hand
column. Both are contextual, but only one is acted on, and the column stacks in
document order on a narrow screen — so the delivery integration should not be
below reference material. A test pins the order.

**What the card shows** is the persisted row: status, customer, phone, branch,
payment type as approved, the approved order value, the customer's location and
coordinates, the delivery note as approved, the scheduled slot with its
countdown, the external reference, and the tracking link when one exists. It
builds no payload, knows no endpoint, and reaches the transport through nothing.

### The delivery note

The note the driver gets. Collected in the confirmation dialog on the **create**
journey, under `DELIVERY NOTE — optional`, as one two-row box between the slot
list and the outcome band.

**It is not a second notes system, and no column was added for it.** What the box
writes is the order's own `notes` — through `onDetailsChange`, straight into form
state — so the ordinary insert saves it (`buildOrderPayload` has always sent
`notes`; `orderFormSchema` has always capped it at 500), the order page's Notes
card shows it on a reopen, `ORDER_EXPORT_COLUMNS` puts it under "Notes", and
`alshrouqDispatchContext` hands it back as `prefill.notes`. `ALSHROUQ_NOTE_MAX`
pins the box's `maxLength` to the 500 that `orderFormSchema` and the
`alshrouqDispatchOrder` validator (`details: z.string().max(500)`) already
enforce, so the three cannot drift.

The courier path was already complete and is unchanged:
`AlShrouqApprovalPlan.details` → `dispatchInputFor` → `DispatchRequest.form.details`
→ `buildAlshrouqOrderPayload`'s `notes` → the payload's optional `details` →
`alshrouq_dispatches.details` **and** the frozen `payload_snapshot`. The card
reads it back from the row rather than from the form, deliberately: the order's
note can be edited afterwards and AlShrouq is never told, so showing the live one
would claim a driver had instructions nobody sent.

**"Create order only" keeps it as an ordinary order note.** No dispatch row
exists, so nothing presents it as a handover — the existing note semantics,
unchanged.

**Nothing about identity comes from the browser.** The input carries a string;
`scheduled_by`, `dispatched_by`, `scheduled_at`, the order id and the dispatch id
are all derived server-side from the verified session, exactly as before. No new
permission: the note rides the `edit_all_orders` / `edit_orders`-on-own-order
gate that `alshrouqDispatchOrder` already applies.

On an **existing** order the dialog stays a confirmation and shows the note
read-only. The order's Notes field is on the page behind it; editing a saved
order's note from the dialog would put a value on the dispatch that the order
itself does not hold until somebody presses Save.

### What the AlShrouq screens say — Phase 11

No backend changed in this phase: no migration, no schema, no scheduler, no
state machine, no RLS, and `orderFormSchema` is still byte-identical. What
changed is what an agent reads.

**`features/alshrouq/dispatch-presentation.ts` is the vocabulary and the
palette.** Pure, no React, so it is asserted the way the rest of this feature is
— over values, in Node, with nothing rendered. It holds three things:
`explainAlShrouqState` (what a state *means*, one sentence), `alshrouqToneStyle`
(tone → the portal's own utility classes) and `describeApprovalAction` (what
pressing the button will do). The card, the approval dialog and the tests read
one source for all three, so they cannot drift into three accounts of one row.

**A badge names a state; it cannot say what to do about one.** "Scheduled" needs
nothing from anybody and "Delivery status unavailable" needs a phone call, and
nothing on the old card distinguished them except a colour an agent had to have
been taught. Each state now carries a line beneath the badge saying whether a
courier was contacted — the only fact that changes what the agent should do.
Tests pin the three that must never merge: `scheduled` says AlShrouq has *not*
been contacted, `cancelled` says nobody was, and `indeterminate` says it is not
known and has not been sent again, in words that are neither "failed" nor
"rejected".

**Five tones, from the existing tokens.** The badge used to collapse everything
to "ok or warn" — a scheduled delivery and an accepted one were the same colour,
and a failure and an unreachable CRM were the other. It now maps
`summary.tone` straight through: `muted`, `info` (`primary`, the brand
turquoise, because a scheduled delivery is in hand and is neither a warning nor
a success), `success`, `warning`, `destructive`. A test asserts every class
string is an existing token — no hex, no `rgb()`, no Tailwind palette number —
so light and dark are the theme's problem and not this feature's.

**Two corrections the phase found, both by looking at the rendered card.**

1. *The handover notice was appearing on deliveries nobody had been told about.*
   "AlShrouq submission completed. Changes made in MilaPortal after submission
   are not sent to AlShrouq" was gated on `handedOver`, which is true for
   `scheduled` — a state that reserves the slot without transmitting anything.
   It is now gated on `submitted`, which excludes `scheduled` and `failed`. The
   distinction matters because a line that is sometimes false is a line agents
   learn to skip, including on `indeterminate`, where it is the most important
   sentence on the card.

2. *A cancelled delivery had disappeared from the card entirely.*
   `useOrderAlShrouqDispatch` defines `current` as the row that is **not**
   cancelled, so a cancelled dispatch reaches the card as no dispatch at all —
   correct about what may happen next, and silent about what just happened. The
   badge is right to read "Ready to send"; the card now also reads the cancelled
   row out of `rows`, which the same query already holds, and says a slot was
   booked and called off and that nobody was contacted. No new query, no new
   column.

**The location is presented as a verified fact, not as fields.** It was a
truncated address followed by two rows labelled "Latitude" and "Longitude". It
is now one block: a **Verified** pill shown only where a resolved point actually
exists, the customer's own link as a link rather than as text to copy by hand,
and the coordinates labelled `Lat`/`Lng` so a number is never mistaken for a
reference. The stored `customer_address` goes through `safeTrackingUrl` — the
same http/https-absolute guard the tracking link uses, aliased at the import
rather than reimplemented — before it can reach an anchor, and a value that
fails it is shown as the text it is.

**Timing is a choice.** "Leave the date and time blank to send now" was the
rule, and it is a rule an agent has to be told: a blank field is not an answer,
and here the unanswered question is whether a driver leaves in a minute or
tomorrow. It is two radio options now — *As soon as possible* and *At a set
time* — over the same `parseScheduleInput`, the same validation and the same
server-side decision. Choosing "now" sends no instant, exactly as two blank
boxes did.

**The dialog says what the button will do, in the button's own words.** A
`What happens when you confirm` block heads each outcome with the exact label on
its control — so on the create journey *Create order only* and *Create order and
send* are explained side by side rather than being two verbs at the bottom of a
scroll. The scheduled wording names the instant, adds how far away it is, and
says **no courier is contacted now**; a test asserts it never reads "straight
away", "immediately" or "on its way".

**A draft is told where its action lives.** The card used to end in a
permanently disabled *Send to AlShrouq* beside an order that cannot be sent,
which invites a click that can never work. It now points at the page's own
**Create order** button, which is where the create journey's approval actually
is. The send control remains *absent, not disabled*, once a dispatch exists —
that rule is unchanged.

**Choosing AlShrouq explains itself where the choice is made.** The delivery
method is the one field whose value changes what the page's primary button does,
so the field carries a line saying so. The button's label is untouched.

**Responsive, and asserted as such.** Every grid in the card and the dialog
starts at one column and earns a second at `sm`; long values truncate rather
than widening their container; the dialog's actions are full-width targets on a
phone with the primary lowest in a `flex-col-reverse` footer, and the dialog
keeps `max-h-[85vh] overflow-y-auto` so its buttons are always reachable. Tests
pin all of it, including the absence of fixed pixel widths, which are what
actually force a sideways scroll.

**Verified in a browser**, against a temporary unauthenticated route that seeded
the dispatch query cache rather than fetching it: every state above, at 1280px
and 375px, in light and dark. `document.documentElement.scrollWidth` equalled
the viewport at both widths, and the dark palette resolved to the `.dark` tokens
on load. The harness was deleted before commit. The order form's own create
journey could not be reached — it sits behind `/_app`, which requires a session.

### The confirmation stopped being a second form — Phase 11.1

Still UI only: no migration, no schema change, no scheduler, no state-machine
change, no RLS, no new permission, no credential, and `ALSHROUQ_LIVE_DISPATCH_ENABLED`
untouched. `orderFormSchema` and `buildOrderPayload` are byte-identical and a
test asserts neither mentions AlShrouq at all.

**The complaint was structural, not cosmetic.** Pressing **Create order** on an
AlShrouq order produced a taller form than the one the agent had just finished:
a payment select, a location box with its own resolve button, a driver note and
a free-typed date and time. A dialog that collects data is not a confirmation,
and the agent had no way to know, while taking the order, that three more
answers were coming.

**So the questions moved to where the order is taken.**
`AlShrouqOrderRequirements` renders inside the *Order details* card the moment
the delivery method is AlShrouq, and asks for the three things a courier needs
that no order column holds: where the customer is, how they pay, and — read
rather than asked — the point a driver routes to. Customer name and phone gain a
required marker in the same moment.

**The dialog is a read-only summary and one choice.** Customer, phone, branch,
order value, payment, location and the delivery it is about to arrange; then
*when*; then the delivery note; then **Create order only** or **Create order +
AlShrouq delivery**. Tests assert it contains no `<Input>`, no `useQuery`, no
`useMutation`, no `useServerFn`, exactly one `<Textarea>` (the note), exactly
three `<Select>`s (hour, minute, AM/PM) and no `paymentOptions` or
`branchOptions` — and that its only state is the timing choice, the date and time
behind it, and whether the calendar is open. Nothing it shows about the order is
a copy it owns.

**Coordinates are read in the browser, keylessly.** `parseMapsUrl` was already
pure and already handled every shape a shared Maps link takes — the
`/data=…!3d…!4d…` dropped pin, `?q=`/`?ll=`/`?destination=`, the `@lat,lng`
camera, a `geo:` share, a bare pair — and was only ever called on the server.
There is no reason for a round trip to read numbers already in the URL bar, so
`readLocation` calls it directly and the latitude and longitude fill in as the
agent pastes. The link is the authority: whenever it parses, it overwrites.

**A short link is not a failure.** `maps.app.goo.gl` carries a redirect and
nothing else, and the browser cannot follow it — the shortener sends no CORS
headers. That one case, and only that case, shows **Check location**, which asks
`alshrouqResolveLocation` (unchanged: Google-host allow-list, HTTPS, re-checked
every hop, `Location` header only, capped length/hops/time). Nothing fabricates
a coordinate. A resolution is discarded the moment the link text changes, because
a point belongs to the link it came from.

**A link that cannot be read now says so, and can be worked around.** The two
boxes were `readOnly` on the principle that a coordinate is evidence rather than
an opinion — which holds right up until no link parses, at which point it left an
agent with a delivery they could not hand over and no control to fix it, the
failure showing as grey helper text beside two empty boxes. Three things changed,
and nothing about the principle was given up:

- **The failure is stated.** A non-empty link that yields no point renders as a
  warning naming the way out, not as muted helper text. `needs_check` is excluded
  — a short link has not failed, and there is a button beside it — so the
  commonest pasted link does not cry wolf.
- **The boxes accept a typed pair**, held to exactly the bounds a parsed one is:
  the `location` reading goes through `readCoordinates`, which delegates to the
  same `parseCoordinatePair` `parseMapsUrl` uses. A swapped pair still reads
  `out_of_range`, half a pair and unparseable text read `invalid_pair` (a new
  `LocationReading` kind, because "that link carries no location" and "those
  numbers are not a location" are two different mistakes), and nothing typed can
  render as **Verified location**.
- **One reader answers for every consumer.** `parseCoordinatePair` tolerates the
  stray characters a pasted coordinate arrives with — a trailing comma from
  splitting `24.53738, 46.64555`, a direction letter, the invisible bidi mark a
  WhatsApp copy carries — while the confirmation summary,
  `validateAlShrouqOrderFields` and the dispatch payload all re-read the raw text
  with a bare `Number()`, which is NaN for every one of them. The two disagreed:
  the box showed a valid `24.53738` (it was rendering the *parsed* value) while
  the confirmation read **NaN, 46.64555** and the validator reported the latitude
  missing. `canonicalCoordinate` closes it — consumers read the value the
  location system already parsed, and the boxes bind to `latitudeText`/
  `longitudeText`, the stored text verbatim, so what is displayed is what is
  held. It is conservative by construction: text that already parses is returned
  byte-for-byte, so a link-supplied coordinate still reaches the courier exactly
  as `parseMapsUrl` read it.
- **A typed pair survives a later failed parse.** `useAlShrouqOrder` keeps one
  piece of genuinely local state — `manualCoordinates`, provenance only, never an
  order column — so editing the link box no longer discards coordinates a person
  entered on purpose. The discard rule still applies in full to a pair that came
  from a link, which is the safety rule it was written for; and a link that
  parses, or a successful **Check location**, overwrites and clears the mark.

The resolver's own failure sentences (`describeLocationResult`) gained the same
fallback clause, so no outcome ends on "could not" with nothing to do next.

**Branch coverage is answered before the order exists.** It could not be:
`alshrouqDispatchContext` needs an order id, so a *new* AlShrouq order got no
coverage feedback until after it was saved. `alshrouqPaymentOptions` became
`alshrouqDeliveryOptions` and now returns both lists that
`fetchAlShrouqDispatchOptions` already computed — same endpoint, same five-minute
cache, same single flight, same `create_orders` gate, and `webhook_auth_value`
still never read. A covered branch gets a quiet success line; an uncovered one
gets a warning that names the consequence — *this order cannot be handed over to
AlShrouq from here — choose another delivery method* — because "not covered"
alone reads as something the agent typed wrong, and it is not.

**On the workbook.** `Shams-alshrouq mapping.xlsx` was read for this phase. It
is 137 rows of `AlShrouq id · branch name · city · Maps URL` and **it carries no
coverage column at all** — every row has an id — so it cannot be the source of
truth for coverage that a UI needs; only the CRM's `branch_options.covered` can.
It also carries an AlShrouq login, username, password and token in its first two
columns, none of which is in this repository and none of which this code reads.
Tests assert no branch id, no quoted branch code and no AlShrouq credential
appears in any of the new modules.

**Timing is a calendar and an exact time.** The generated slot list — five whole
hours as radio cards, from `scheduleOptionsAt` — is **gone**, and the module with
it. It was the tallest block in a dialog that had to fit an 800px screen, it
could not express 7:30, and a "slot" implies AlShrouq knows about one when it has
been told nothing.

The choice is now **As soon as possible** or **Schedule delivery**; the second
reveals the portal's own `Calendar` in a `Popover` — the same pair
`DateRangePicker` uses, no second calendar was written — plus three compact
`Select`s for hour, minute and AM/PM. Every minute is offered, so 07:47 PM is
expressible.

`features/alshrouq/schedule-picker.ts` is the pure module behind it and produces
nothing but the `{ date, time }` pair — `"2026-08-23"`, `"07:30 PM"` — that
`parseScheduleInput` has always taken. **No new date/time format reaches the
backend**: the arithmetic, the rejection of the past and the two-minute immediate
window are untouched, and `scheduled_for` still stores the instant that function
returns.

**Every hour, minute and meridiem is always selectable.** The picker briefly
judged one unit at a time — at 10:15 PM the hours 01–09 went dead — which closed
the route to *9 PM tomorrow*: an agent could not touch the hour first. An hour is
not in the past; only a whole datetime is. `earliestMinutesOn`, `isSelectionPast`
and `clampSelection` are gone, nothing snaps the selection forward as it is made,
and `parseScheduleInput` — over the complete `{date, time}` pair, unchanged — is
the only thing that decides validity. A past combination disables the primary
action and says *"That time has already passed. Pick a later time, or another
day."*

The one thing still refused outright is the **day**: the calendar disables days
before today, because a day that has ended cannot contain a future minute under
any combination. "Today" is answered in Riyadh business time, never the
browser's. `calendarDate`/`dateFromCalendar` convert through **local** parts on
both sides, because `react-day-picker` compares days locally and a UTC-midnight
`Date` is the previous day everywhere west of UTC.

**The confirmation scrolls at no supported size.** Measured in a browser, not
asserted from the source — content height against the element's own cap, and
`scrollWidth === clientWidth` on both the dialog and the document:

| Viewport  | ASAP    | Scheduled | Vertical scroll | Horizontal |
| --------- | ------- | --------- | --------------- | ---------- |
| 1280×800  | 517×492 | 517×568   | none            | none       |
| 1440×900  | 517×492 | 517×568   | none            | none       |
| 390×844   | 340×556 | 340×632   | none            | none       |
| 375×812   | 326×556 | 326×632   | none            | none       |

Checked in light and dark at each size. On the tightest of them the scheduled
content is 664px against an 85vh cap of 690.

What buys the height, in order of how much: **the date and the time share one
row** rather than stacking two labels and two control rows (~64px); the three
time units moved behind a trigger that reads the answer back — `10:47 PM` — so
the row costs one button instead of ~200px of selects; the summary is a
two-column definition grid rather than seven bordered rows; the description is
one line; the tinted outcome panel above the buttons is replaced by the muted
sentence it contained; the two secondary actions share a row through a wrapper
that becomes `display: contents` from `sm` up, so the desktop footer is one row
of three exactly as before; and the dialog's own gaps tighten a step below `sm`.

The row is `flex`, not a two-column grid — the phone-layout contract requires
every unprefixed column rule in this flow to be a single column, and splitting a
*form* into two columns on a phone is what that rule exists to prevent. Two
equal-basis flex children holding one control each are a different thing.

`max-h-[85vh]`/`overflow-y-auto` stay as a last resort for a viewport shorter
than anything above. Nothing is clipped, no height is fixed, and no font was
shrunk to buy the room.

**The time popover holds its own against a nested `Select`.** A select portals
its list to the body, which is outside the popover's subtree, so choosing an
hour reads as a click outside and would close the popover under the agent's
finger. `onInteractOutside` treats anything inside a popper — this one, or a
select's own — as not outside. Verified live: picking a minute leaves the
popover open, updates the trigger and updates the summary's Delivery row.

### The card judges the order, not the form

A reopened AlShrouq order reported **"Not available — this order cannot be
delivered by AlShrouq — choose a branch to check AlShrouq coverage"** beside a
branch that was plainly filled in, on an order the agent had just created *with*
a handover, with the send button dead. Two separate things, and only the second
was a defect.

**Nothing was persisted, and that is the gate working.** With
`ALSHROUQ_LIVE_DISPATCH_ENABLED` off, an **immediate** handover runs the whole
pipeline and stops at the safety gate: it returns `prepared` and writes **no
row**, deliberately — a dry run must not take the order's dispatch slot and
block the real send later. So in this deployment "as soon as possible" leaves the
same persisted state as "Create order only", the create toast says so
(*"AlShrouq dispatch is switched off, so no courier was contacted"*), and the
reopened page has no dispatch to report. A **scheduled** handover is different
and always was: it persists a `scheduled` row with a frozen snapshot, contacts
nobody, and survives a reload on any deployment. `handover-persistence.test.ts`
pins both, including that a second immediate approval still writes nothing.

**The defect was what the card did with that.** With no dispatch row it falls
back to *readiness*, and readiness read `alshrouq.coverage` — which
`useAlShrouqOrder` short-circuits to `{ kind: "no_branch" }` the moment
`form.delivery_type` is not AlShrouq. Transient form state was being reported as
a fact about the order, so a saved AlShrouq order whose form had not put the
method back described itself as uncoverable.

`cardCoverage` in `dispatch-selection.ts` is the rule now: the form's answer
while the form is the one being filled in — an agent changing the branch must
see coverage follow — and otherwise `ctx.branch`, the same resolution
`alshrouqDispatchContext` already makes server-side from the order's own
`branch_no` against the same live `branch_options`. No second query, no new
state, no new source of truth. The branch, customer and phone rows fall back the
same way, to `ctx.prefill`, which the approval dialog already read. And
`optionsPending` only counts while the form is active — React Query reports a
*disabled* query as pending, so on a saved order it had the card stuck on
"Checking…" waiting for a request nobody had made.

**The card no longer disappears when an order is reopened.**
`useOrderAlShrouqDispatch` defines `current` as the row that is **not**
cancelled, which is the right answer for the send control and the wrong one for
the display: an order whose only dispatch had been cancelled came back from the
orders list with no dispatch history on the card at all. The card now reports on
`current ?? latest` while `handedOver` and the countdown stay bound to `current`,
so a cancelled delivery is named and the order is still correctly sendable. No
new row, no new column, no new query — the history was already in the same
result.

**The horizontal scrollbar had a cause.** `DialogContent` is a `grid` with an
implicit `auto` column, so its single track was sized to the *max-content* width
of its widest child: one long value widened the track, every sibling stretched
to match, and the dialog overflowed its own `max-width` by 35px.
`grid-cols-[minmax(0,1fr)]` lets the track shrink, which is what lets
`break-words` and `min-w-0` do their job. No overflow is hidden. The raw Maps
URL is never printed — it is a long unbreakable string that tells an agent
nothing they can check, and the coordinates are the readable part.

**Measured, not asserted.** At 1280px the dialog is 547px wide with
`scrollWidth === clientWidth`; at 375px it is 342px inset 24px each side, again
with no horizontal overflow, and the page's `scrollWidth` equals the viewport at
both. Dark mode resolves to the `.dark` tokens on load. Verified through a
temporary unauthenticated route that seeded the query cache; it was deleted
before commit, and the real Create Order page — behind `/_app`'s session gate —
was not reachable.

**What was deliberately not done.** The AlShrouq values are not written to
`orders`. The columns exist (`alshrouq_map_url`, `alshrouq_lat`, `alshrouq_lng`,
`alshrouq_payment_type`, from the reverted integration's migration) and
persisting them would mean adding fields to `orderFormSchema` and
`buildOrderPayload` — the save path, and the exact mechanism behind the "agents
cannot save orders" outage. They travel to the courier the way they always have:
through `AlShrouqApprovalPlan` → `alshrouqDispatchOrder` → the frozen
`payload_snapshot`. The consequence is that an AlShrouq order saved *without*
being handed over does not remember its location or payment method, which is
what the previous build did too.

**And the requirements gate the handover, not the save.** Marking customer name
required does not make an ordinary save fail, and **Create order only** stays
available on an incomplete AlShrouq order. What the requirements disable is the
handover: the primary button is off, and the dialog lists exactly what is
missing. That split is the whole reason these rules live outside
`orderFormSchema`.

### AlShrouq create transport

`alshrouq-create.server.ts` owns the create POST and the read that reconciles
it. **Nothing calls it yet** — it is built, tested against a mocked transport,
and left disconnected from Orders.

It deliberately does **not** use `crmFetch`. `crmFetch` answers a 401 by
re-logging-in and re-sending; correct for a read, and for a create it is a second
driver at a customer's door, because a 401 on the response leg is
indistinguishable from one raised before the CRM processed anything. `crmFetch`
is untouched and still owns every read, including the reconciliation. The two
additive exports it gained — `getCrmSessionToken()` and `crmBaseUrl()` — exist so
the create reuses the session this module already owns instead of racing a second
login. `readCrmEnv` stays private; it is the only thing that holds the password.

The invariant: **if `createAlshrouqOrder` throws, nothing was transmitted; if it
returns, exactly one POST was attempted.** Everything that can fail before
transmission throws. There is no path through the file that sends a second POST.

Three outcomes, and the third is the point:

- `accepted` — 2xx. The delivery exists.
- `rejected` — a **4xx**, and only a 4xx: the CRM understood the request and
  declined it. Nothing was created.
- `indeterminate` — timeout, network failure, unreadable 2xx, 401, **or any
  5xx**. The request left the machine and the result is unknown. Answered by
  `findAlshrouqOrderByClientOrderId`, which is a GET — never by another POST.

**5xx is not a refusal.** A 4xx is the CRM saying "I understood this and will
not do it". A 5xx says nothing of the kind: the CRM brokers this call onward to
AlShrouq, so a 500, a proxy's 502, or a 504 on the response leg is equally
consistent with the delivery having been created and the acknowledgement lost on
the way back. There is no evidence that a 5xx means no courier was dispatched,
and classifying it `rejected` would invite a caller to treat it as safe to send
again — the one mistake that puts a second driver at a customer's door.

`indeterminate` exists because server-side deduplication is **unknown**. The
Desktop sends `X-Client-Operation-Id` on this endpoint (confirmed: the path is
the sixth member of its `tracked_prefixes` tuple), so a uuid4 is sent here too —
but nothing depends on the server honouring it until that is observed.

The create response has never been captured, so no `AlshrouqCreateResponse`
interface exists. The body is passed through `sanitizeResponseBody`, which keeps
shape while redacting credential- and identity-shaped keys and capping depth,
array length and string length. The reconciliation record *is* evidence-backed
and is typed — minus customer and driver identity, which reconciliation does not
need.

Not defaulted: `preparation_time` is `10` on 122 of 127 records, but whether the
client sends it or the CRM fills it in is unestablished, so the key is omitted
unless a caller supplies one. Coordinates are optional and never manufactured —
both or neither, mirroring the `orders` CHECK. Payment ids arrive in
`context.paymentOptionIds` from the live config; there is no enum here, and an
id the CRM does not offer is refused by name rather than rewritten.

**Credentials are `SHAMS_CRM_USERNAME` / `SHAMS_CRM_PASSWORD`, server-only.**
Temporary and deliberately flagged as such: they are a *person's* Desktop login,
used with the account holder's authorization until Shams issues a machine
credential, so every request is attributed to that person. Never `VITE_`, never
logged, never persisted to Supabase — the session token lives in isolate memory
and nowhere else.

**No field mapping exists, on purpose.** `ShamsCrmProduct` and `ShamsProduct` are
the same three fields, so `products.server.ts` converts at the type boundary and
copies nothing. If either shape gains a field, that file stops compiling and the
adapter belongs there.

`getCrmProducts()` returns `readonly ShamsProduct[]` — the live cached array, not
a copy, so a caller cannot sort or splice the catalog out from under every other
caller in the isolate. A cold-cache failure throws `ShamsCrmError` rather than
returning an empty list: an outage and an empty catalog lead to opposite
decisions. A *stale* catalog is not a failure — a failed refresh keeps serving
the previous rows.

**Product discovery is the CRM's; operational data stays on the MIS.** That split
is the whole point:

| Concern | Source |
| --- | --- |
| Catalog, names, item codes, retail price, **search** | Shams CRM |
| Stock, branch availability, invoices, order/transactional data | Shams MIS |

`searchProducts()` in `src/lib/shams/catalog.server.ts` now matches over
`getCrmProducts()` instead of probing `product/search`. The matching rules in
`lib/shams/search.ts` are unchanged — what changed is which products are
available to match against. `product/info` and `product/stock` are untouched and
still answer for a product the agent has opened, keyed by the item code the
search returned.

**The MIS is not a fallback product source.** If the CRM catalog cannot be
loaded, `searchProducts` throws rather than quietly searching the MIS or
returning an empty list — an outage and "no such product" must not look alike.

Two limits disappeared with the 50-row cap: a broad query is no longer truncated
(`nan` returns all 53 matches, and `nan*op` finds the NAN OPTIPRO range), and a
wildcard written against an item code now resolves, because the row is already
in hand rather than needing a probe that could never retrieve it.

### RBAC — one page-level permission

`view_shams_mis` gates every Shams server function, the `/shams` route and the
sidebar entry. `shamsStatus` additionally requires an administrator.

It replaced the earlier arrangement of borrowing `view_orders` for the catalog
and `view_invoice_analytics` for invoices. Borrowing was cheaper but said the
wrong thing once the page became an operational tool: Shams access could not be
granted or withdrawn without also changing someone's Orders or Invoice
Verification rights, and an auditor — who holds both borrowed keys — could not be
kept out of it.

Defaults: owner, admin, supervisor, customer_care, telesales. **Auditor: not by
default, but grantable per user** — see "Auditor: allowed is wider than
defaults" in the RBAC section. One key, not one per tab: the page is a single
read-only window, and gating its halves against each other served nobody.

### Branch identity — a direct join, verified

Shams `branchCode` (stock) and `Whouse` (sales) are the **same identifier space
as `branches.branch_no`**: of MilaServ's 137 seeded branches, 137 appear in the
Shams stock response with identical codes and 0 are missing. Shams additionally
reports `P0310` and `P0311`, which MilaServ's branch directory does not yet have.
**No mapping layer exists or is needed.** Shams `branchName` always duplicates
`branchCode` and carries no display name, so branch names must come from the
`branches` table.

### The invoice row model

`GET /api/v2/sales/details` returns **one flat row shape (35 keys) for both
document headers and item lines**, discriminated by `Prior`: `"0"` is the header
(totals + customer identity, item fields blank), anything else is an item line
(item fields set, totals zeroed). Rows are bucketed by `(Whouse, Doc_No)` in
`groupInvoices`. Treating each row as an invoice double-counts every document —
the captured document carries `GrandAmt "806.220"` on its header and
`Amt "806.22000000000003"` on its single item.

Document numbers are unique only within a warehouse, and the API accepts a
zero-padded number on input while returning it unpadded, so both are reconciled
via `stripLeadingZeros`. Every numeric arrives as a string in inconsistent
notation (`".000"`, `"806.22000000000003"`) and is rounded to two decimals.

### Call Centre classification

A Shams invoice header carries a **sales-channel account label** —
`HOME DELIVERY-Call Centre`, `CALL CENTER SALES`, `NUPCO / …-Call Centre`. It is
the only signal in the payload that says which channel a document came through,
so it is normalized onto `ShamsInvoice` as `customer` (verbatim, trimmed) plus
the derived `isCallCentre`.

**It is read from `Customer_Name`, falling back to `CusName` — not from
`Customer`.** The response carries several customer-ish fields and they do not
agree: for document P0221/22138 `Customer` is `NUPCO / …(نوبكو)` while
`Customer_Name` is `NUPCO / …(نوبكو)-Call Centre`. The precedence mirrors the MIS
portal's own shipped bundle, which renders its Sales Register "Customer" line as
`Customer_Name ?? CusName ?? ""`. Blank counts as absent, which `??` alone does
not do — the API spells a missing field `""`. Reading `Customer` was a real bug:
it silently dropped the suffix and reported call-centre invoices as walk-ins.

The rule lives in one place, `normalize.ts:isCallCentreCustomer`, and is a
**suffix** test: `/-\s*call\s+centre\s*$/i`. Case, whitespace around the hyphen
and trailing whitespace are tolerated; the hyphen and the terminal position are
not negotiable. That narrowness is the point — `CALL CENTER SALES` is a walk-in
account whose *name* mentions a call center, while `CALL CENTER SALES-Call
Centre` is the call-centre account, and a substring match would merge the two.
An absent or blank customer is not Call Centre.

The UI reads `isCallCentre`; it does not restate the rule. `customer` is kept
alongside the derived flag rather than replaced by it, both because the label is
what a human reconciling a document reads and because matching Shams invoices to
MilaServ orders will need the label itself.

### Privacy

`sales/details` returns `PatCd`, `Customer`, `Customer_Code` and `Cus_Cd`. They
are dropped in `normalize.ts` — at the boundary, not in the UI — so they cannot
reach a cache, a log, an export or the browser; `ShamsInvoice` has no field for
them and a test asserts none leaks. The client logs path, status and duration
only, never query values, because `crm/data` carries a mobile number.

`Customer_Name` (fallback `CusName`) is the deliberate exception: it is the label
the MIS portal itself displays as "Customer", and the classification above cannot
be done without it. Every observed value names an account rather than a person,
but no capture proves what it holds for a cash walk-in — see the risk note in
`docs/shams/api-discovery.md` §7.

`GET /api/v2/crm/data` was discovered and is **deliberately not implemented**: it
is unnecessary for this objective, all three captured calls returned zero rows so
its schema is unverified, and it is a bulk lookup of identifiable customer data
behind an unauthenticated endpoint.

### Caching

Search 5 min · info 15 min · stock 60 s · invoices uncached, except the copies
branch discovery already downloaded (`sweptDocuments`, 5 min — see below).
In-memory and
per-isolate — no migration and no table of third-party catalog data, since the
payloads refetch in well under a second. The caches exist mainly to absorb
per-keystroke search traffic. Stock is never fetched for a whole search result
set; callers request it for the one item a user opened, or for the items on one
document (`getStockForItems`, which reuses the same 60 s entries).

### UI — `/shams`

Route `src/routes/_app.shams.tsx`, feature module `src/features/shams/`
(`components/`, `hooks/use-shams-data.ts`, `constants.ts`,
`invoice-customer-link.ts`). **Three** tabs — Branch Stock, Invoices and
Customers — reading exclusively through the server functions in
`lib/shams.functions.ts`; no Shams request is ever made from the browser.

Tab, product and a handed-over document live in the URL (`?tab=&q=&item=&doc=&branch=`),
validated on the way in so a hand-edited address cannot reach a state the page
cannot render. The Customers tab's own search deliberately does **not**: a mobile
number in the address bar ends up in history, in a pasted link and in a
screen-share.

**All three tabs stay mounted** (`forceMount` on every `TabsContent`). Radix
unmounts an inactive tab by default, and that unmount was throwing away every
`useState` in the tab *and* every React Query observer with it — so switching to
Invoices and back re-ran the Branch Stock search from zero. Held mounted, a
return is instant and costs no request. Nothing about refetching is disabled:
`staleTime` still governs freshness, an explicit search or Retry still goes to
the network. The one cost is that three tabs mount together, so each is passed
`active` and only the visible one takes `autoFocus`.

**Change product is one click.** It used to take two: the click cleared
`stockProduct` immediately while the router's `?item=` cleared a tick later, and
in that gap the restore effect saw "URL has an item, state does not", refetched
it from cache and put it straight back. A deselect is now a URL change only, and
the rendered product is gated on `?item=` agreeing with the loaded row
(`openProduct`), so state and URL can never disagree.

The standalone **Products** tab was removed: Branch Stock already opens with the
same `product/search` lookup, and an agent who finds a product almost always
wants to know where it is. `products-tab.tsx` and `product-detail-dialog.tsx`
are gone; the catalog server functions they used are unchanged and still serve
Branch Stock.

Sidebar entry **Shams MIS** (`PackageSearch`) and the route both gate on the
single page permission `view_shams_mis`. The server re-checks it in every
handler.

### Orders ↔ Invoices ↔ Branch Stock

An order's invoices, where Shams actually raised them, and what those branches
still hold. Rendered by `features/orders/components/order-invoice-panel.tsx` in
the order form's **Invoicing** section — edit mode only, gated on
`view_shams_mis` (the panel is a second window onto Shams, not a new
capability), and driven by the **stored** `invoice_no` rather than the inputs
above it, because an unsaved edit is not yet a fact about the order.

**No schema change.** The relationship is resolved dynamically from columns that
already exist:

```text
orders.invoice_no  ──parseInvoiceNumbers──▶  document number(s)
orders.branch_no   ──────────────────────▶  where to look first
        │
        ▼  sales/details (wh_cd = branch, doc_no = number)
   ShamsInvoice ──▶ items[].itemCode ──▶ product/stock ──▶ quantity at that branch
```

**The order's branch is a lead, not an answer.** `orders.branch_no` is what an
agent picked while taking the call; nothing guarantees the invoice was raised
there. So it is used as the *first place to look* — one `sales/details` request,
against a branch that is right most of the time — and the branch is reported as
the invoice's only because Shams returned the document for it. When it does not,
the panel says "Not at P0221, the branch on this order" and offers the
chain-wide sweep, which stays the authoritative answer. Every matching branch is
listed; a number living in two warehouses is two different sales.

**Four stock states, never two** (`lib/shams/availability.ts`, pure):
`in_stock` (branch listed, quantity > 0) · `out_of_stock` (branch listed, zero —
a real answer, since the stock response covers all 137 branches) · `not_found`
(empty response: the MIS knows no such item code) · `unknown` (the lookup failed,
or the response did not mention this branch). Rendering `unknown` as `0` would
tell an agent something false, which is why this is a named type rather than
`number | null`.

**Request budget.** Opening an order with one invoice costs **one** upstream
request when the order's branch holds it, plus one per *distinct* item code
(`invoiceItemCodes` dedupes lines; `getStockForItems` runs them 6 at a time,
capped at 40). Both halves read caches that already existed: `getInvoices`
answers from `sweptDocuments` when discovery has run, so picking a branch off a
sweep costs **zero** further document requests, and stock goes through the same
60 s `stockCache` the Branch Stock tab fills — two invoices sharing a product
cost one request between them. `shamsGetInvoiceStock` does the whole chain in
one server call, because the item codes come out of the document and splitting
it would put a round trip between the browser and something the server knew.

**Degrading.** A stock failure is an omission, not an exception:
`getStockForItems` leaves the failed code out of the map and it renders as
`unknown`, so one dead endpoint never costs the agent the document. A failed
invoice lookup is confined to its own panel row — the order form itself never
depends on Shams.

#### Invoice availability is asynchronous

**The rule the whole feature is built around: a document does not appear in the
MIS when the order is taken.** It can land an hour or two later. So a lookup
that comes back empty is `pending`, never "no such invoice" — the order stays
valid, nothing is marked failed, and when the document appears it attaches
itself to the *existing* order. Nothing has to be recreated.

`features/orders/invoice-verification.ts` (pure) holds the state model. Three
states, and the distinction between the last two is the point: `verified` (Shams
returned the document), `pending` (Shams answered, and has nothing yet),
`unavailable` (Shams could not be reached — temporary by assumption, and
deliberately not the same word as pending).

`useOrderInvoices` resolves the order's numbers on open and on the panel's
**Check again**. There is no polling: React Query's 60 s window plus the server's
document and stock caches absorb repeats, and a 137-branch sweep is never run
from here — the order names a branch and one request asks it. An order with no
branch stays pending rather than triggering a sweep on page open.

#### One order, many invoices

`orders.invoice_no` holds one *or many* numbers, so nothing models "the"
invoice. Identity is the number with leading zeros stripped (`invoiceKey`,
matching `stripLeadingZeros` and the SQL's `ltrim(…, '0')`), which is what stops
`022138` and `22138` counting as two documents. **Order value is the sum of the
distinct verified totals** — never the first found, never a guess for a pending
one. While any invoice is outstanding the panel labels the figure "Verified so
far — n of m"; the field on the form carries a *Verified* badge only while it
still equals that sum, so an agent who types over it is not told a number is
verified when it is not.

#### Automatic verification — `record_invoice_verification`

One SECURITY DEFINER function (`20260814140000`) does three things atomically
when Shams returns a document the order's timeline does not yet record: writes an
`invoice_verified` activity row, sets `orders.invoice_value` to the recomputed
verified total, and sets `call_center_verified`.

It exists because **`order_activity` has no INSERT policy** — 20260624110517
dropped it deliberately, so the table is written only by SECURITY DEFINER code —
and because the three writes have to agree. Idempotence lives in the database,
not the client: the guard is `CONTINUE WHEN EXISTS (… details->>'invoice_key' =
key)`, and the total is recomputed from the log rather than accumulated, so a
repeated call cannot inflate it. `is_active` + the UPDATE policy's own predicate
+ `view_shams_mis` are re-checked inside, since RLS does not run for a definer
function. The flag is only ever **set**: a later MIS outage cannot un-verify an
order.

The Call Center checkbox is checked only when Shams actually returned a
document — never because a number was typed, a lookup ran, one failed, or the
order exists. `invoicesToRecord` filters to `verified` alone, and the client skips
the call entirely when the timeline already holds every key.

**And only when that document is a call-centre document** (`20260814190000`).
The first cut set the flag for *any* verified invoice without reading what the
invoice said, so verifying a walk-in ticked the box — the one thing it is not
allowed to mean. The flag is now decided from the log:
`COUNT(*) WHERE (details->>'is_call_centre')::boolean IS TRUE`, i.e. the MIS's
own channel classification (`Customer_Name`'s `-Call Centre` suffix, carried onto
the activity row when the invoice was recorded). Still only ever **set**:
`CASE WHEN call_centre_cnt > 0 THEN true ELSE call_center_verified END`, so a
walk-in landing later cannot untick a box and neither can an MIS outage.
`InvoiceSummary.callCentreVerified` is the same rule on the client, and
`needsValueSync` only expects the flag when it is true — without that, a verified
walk-in was a permanent disagreement and the client asked on every render.

The portal narrates its own changes. `record_invoice_verification` writes
`value_synced` (`from`, `to`, the invoice numbers behind the figure) and
`call_center_flagged` (the call-centre invoices that caused it) itself, and
`log_order_activity` stands down for `invoice_value` and `call_center_verified`
while `milaserv.invoice_sync` is set — a transaction-local GUC scoped to the one
UPDATE, so an ordinary edit is logged exactly as before and a person's own tick
is still their `verification_changed` row. Both automated events are written only
when that UPDATE actually changed the row, which is where their idempotence comes
from: re-checking the same invoice reconciles nothing and records nothing.

The timeline therefore reads as the real sequence — `invoice_verified` (number,
branch, total, customer, `automated: true`, source), `value_synced`
("Order value updated automatically by MilaPortal — updated to SAR 212.60 based
on invoice 0169580. Previous value: SAR 100.00."), `call_center_flagged`.
Machine-written rows are attributed to **MilaPortal**, not to whoever had the
order open.

#### Verification at creation, not only on re-open

Everything above is keyed on an order id, and at creation there is none — which
was the second half of the reported bug. An order taken for an invoice **already
in the MIS** was inserted with whatever the agent typed and stayed that way until
somebody happened to open it again.

`/orders/new` now runs the same lookup against the numbers being typed
(debounced, `useDebounced`, against the branch chosen on the form), which records
nothing because there is no id, and `submit` inserts with `.select("id")` and
hands the verified documents to `recordInvoiceVerification` — the same RPC, from
`features/orders/record-verification.ts`, the single place either caller shapes
it. A failure there is a warning, not an error: the order is saved and valid, and
the next open reconciles it.

`authoritativeValue(summary, typed)` is the rule itself, in one pure function:
**a verified total overwrites a manually entered value**, and a typed figure only
survives while nothing is verified. It is applied at the point of *writing*, not
only in the box — that was the missing half, since the form could show a verified
figure while saving whatever the field happened to hold, putting a manual 100.00
straight back over a verified 212.60 on the next save.

#### Order value stays in step — reconciliation, not an event

The first cut of this made the sync a **one-shot**, and that was a bug worth
recording. `record_invoice_verification` wrote `orders.invoice_value` only
`IF recorded > 0`, and the client only called it for invoices the timeline did
not already hold. So the value was written on exactly one render — the first
where an invoice became verified — and never again. If that single write did not
land, the order kept a verified invoice of SAR 212.60 beside an order value of
0.00 **permanently**: every later visit correctly found nothing *new* to record
and therefore asked for nothing.

Both halves now reconcile instead. `needsValueSync` (pure) is the second reason
to call the server — *the order's stored figures disagree with what has been
verified* — and the function brings any order holding a verified invoice into
line on whatever call notices, not only when something is new. The `WHERE` guard
means an order already in agreement is not written to at all, so opening one
costs nothing and raises no spurious `edited` row. A failure is surfaced in the
panel with a retry rather than swallowed.

#### The total is the order's *current* invoices — `20260814210000`

The reconciliation summed `SUM(total)` over every `invoice_verified` row the
order had ever collected, which is its history, not its state. Order #8724
recorded the consequence exactly:

```
18:07  created, invoice 0123891 typed, value 1261.40 entered by hand
18:35  0123891 verified — 242.71, Non Call Centre → value 242.71   (correct)
18:38  agent corrects the number on the order to 0123892
18:38  0123892 verified — 1261.40, Call Centre
       → value 1504.11, "invoice_count: 2", "0123891, 0123892"
```

One invoice worth 1261.40, an order claiming 1504.11, because the superseded
number's row went on counting. The same shape is the reported
`1200 + 1261.40 = 2461.40`: **a historical event is not a second invoice.**

Two changes fix it, both inside `record_invoice_verification`:

- **Current, not historical.** `orders.invoice_no` is parsed in SQL — the
  separators `parseInvoiceNumbers` splits on, the zero-stripping `invoiceKey`
  applies — and only invoices keyed on the order *today* contribute to the
  total, the flag or the events. `WITH current_keys … JOIN` is the whole
  mechanism. Remove a number and it stops counting; the log keeps the history.
- **Latest, not first.** A document the MIS reprices used to be skipped by the
  idempotency guard, so the order kept the stale figure for ever. A changed
  total now writes `invoice_value_changed` (`from`, `to`, `invoice_no`) and the
  reconciliation reads `DISTINCT ON (invoice_key) … ORDER BY created_at DESC` —
  the most recent statement per document. `invoice_verified` stays one per
  document, so first-sighting and re-pricing are different events.
- **The channel can be restated too** (`20260815210000`). The re-pricing branch
  was gated on the **total**, and the lookup feeding it selected `prev_total`
  alone — so a document first recorded as a walk-in stayed one for ever, however
  many times Shams answered "Call Centre". Two ordinary things put an order
  there: it was verified before `be824e2`, when the portal read `Customer`
  instead of `Customer_Name`; or the MIS corrected the customer on a number
  already recorded. A changed channel now writes `invoice_channel_changed`
  (`from`, `to` as booleans, plus `total` so it can be the latest statement
  without losing what the document is worth), and every reader of the log — the
  per-invoice lookup, the RPC's derivation and `sync_order_invoice_flags` — takes
  all three actions. The tie-break widened from `= 'invoice_value_changed'` to
  `<> 'invoice_verified'`, so any correction beats the first sighting.

  No backfill: what a document's channel is today is a question only Shams can
  answer. Affected orders repair themselves on the next page open, because
  `needsValueSync` has been asking for a reconciliation all along — that call was
  arriving and being discarded.

Both still read from the log rather than from the caller, so a repeated call
cannot inflate anything, and an unchanged total writes nothing at all.

This is also the **Call Centre attribution** fix. `call_centre_cnt` and the
invoice numbers named in `call_center_flagged` come from the same current-keys
intersection, filtered on the authoritative per-invoice `is_call_centre` — so an
order whose only current invoice is Non Call Centre cannot carry the flag from a
document it no longer has, and the event can never name the wrong invoice. The
flag remains set-only: a call-centre invoice being replaced by a walk-in does
not untick it, since a person may also have ticked it.

#### Order form — creator, assignee, team

Three separate things, and they used to be two. `orders.created_by` (added in
`20260814160000`, defaulting to `auth.uid()`, backfilled from `agent_id`) records
who entered the order and never changes; `agent_id` records who owns it and can
be reassigned. Before that column the INSERT policy required
`auth.uid() = agent_id`, so an Owner or Supervisor taking an order down became
its agent — and appeared in agent workload, the team split and "My orders".

The **Team** selector is gone. It asked the question backwards: an order belongs
to a person and the team is a fact about that person, so choosing "Telesales"
and then a Customer Care agent was possible and filed the order under a team its
agent is not in. `OrderAssignment` picks the **agent**, and `teamForAgent` reads
the team off their `user_roles.role` — the same enum `orders.team` takes, so
there is nothing to map. `isAssignableAgent` keeps Owner, Admin, Supervisor and
Auditor out of the picker entirely: having a team *is* the test for being able to
hold a caseload.

Owner and Admin may reassign on edit (`isAdministrator`); at creation the gate is
`edit_all_orders`, mirroring the INSERT policy so a Supervisor — who cannot be
the assignee — can still file the order under an agent. Both are **narrower**
than the database rule, never wider. The backstop is the UPDATE policy's
`WITH CHECK`, which re-tests the new row: an agent moving their own order away
fails `auth.uid() = agent_id`. The **live backstop is the trigger**, not only
the policy: `orders_prevent_reassignment` (BEFORE UPDATE, running
`prevent_order_reassignment()`) is present on the production database and is
what actually refuses a reassignment, an auditor's write, or an edit outside the
verification-only path. An earlier note here claimed the trigger had been
dropped in `20260701224822` and only the function survived; that was checked
against the live catalog on 2026-08-14 and is **false** — it exists and is
enabled, under the name `orders_prevent_reassignment` (not
`trg_prevent_order_reassignment`).

Two consequences worth knowing. Its first statement is
`IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authorized'`, so **no
connection without a JWT can update `orders` at all** — including a migration
running as `postgres`, which is why `20260814160000`'s `created_by` backfill has
to disable it for that one statement. And because the reconciling UPDATE in
`record_invoice_verification` changes `invoice_value` *and*
`call_center_verified` together, it does not qualify as a "verification-only"
diff: a caller holding `verify_all_orders` but not `edit_all_orders` would be
refused by the trigger even though the function's own check admits them. No
account currently holds that combination, so the path is unreachable today.

Reassignment is a tracked change. `log_order_activity` raises an `assigned`
event carrying both sides, so the timeline reads "Assigned to Ahmed Mohamed" or
"Reassigned from Ahmed Mohamed to Sara Ali". `IS DISTINCT FROM` inside an UPDATE
trigger is the whole idempotency story — no read path can reach it, and a save
that did not move the agent is inert. `agent_id` is deliberately absent from the
`edited` bag, and `team` is only reported there when it moved on its own.

#### Wildcard product search

`*` means "anything in between": `mou*n*j*2.5` finds Mounjaro 2.5,
`*26*gold*3*1800` finds S-26 Gold 3 1800. Fragments are all required and must
appear **in order**; matching is case-insensitive and whitespace-tolerant. A
query with no `*` behaves exactly as before.

**One field has to carry the whole expression** — the item name, or the item
code, tried separately. Matching the joined `"<name> <code>"` let fragments
straddle the join: every code is digits, so `*omega*3*` was answered by products
whose visible name has no `3` in it, the `3` having come from the code. A query
that is only asterisks (`***`) is declined without a request rather than being
sent upstream as three literal characters.

This matches PharmacyCRM Desktop, the client Shams staff use, which matches its
wildcard against the item **name** only. Its rule is anchored — `^…$` with `*`
as `.*` — so `nan*op` means "starts nan, *ends* op" there and finds nothing,
while here it reads as "these pieces, in this order, anywhere" and returns the
ten NAN OPTIPRO/SCOOP products. The portal is deliberately the looser of the two:
a superset of the desktop's answer, never a different one.
`pharmacycrm-parity.test.ts` holds that comparison against real catalog rows;
`docs/shams/api-discovery.md` §10 records how the desktop was read.

**Item codes are exact-only, and that is an API limit.** `product/search?q=`
matches names and cannot see codes, so a partial code — and a wildcard written
against a code — brings no candidate back for local matching. The desktop
supports both because it downloads the whole 8 484-product catalog and matches
offline; closing the gap here needs a catalog source the MIS API does not
currently offer (§10.4).

The MIS API has no wildcard syntax — its only parameter is `q`, matched as a
plain substring — so the expression is split in `catalog.server.ts`: fragments go
upstream as ordinary terms and the full ordered match is applied to the rows that
come back, **before** the result cap. The rule itself is pure and lives in
`lib/shams/search.ts`.

**Up to `MAX_SEARCH_PROBES` (3) probes per wildcard query, not one.** One probe
is logically sufficient — every match contains every fragment, so a
single-fragment search returns a superset — but only if the API returns
everything it matched. It exposes no `limit`, `page` or `offset` (the whole
signature is `?q=`), so a server-side cap cannot be ruled out from the client,
and a truncated superset is not a superset: the wanted product can be cut off
before local matching sees it. Several probes mean a product only has to survive
*one* probe's truncation. The union is de-duplicated by item code, filtered, then
ranked. A plain query still costs exactly **one** request.

Results are ranked (`rankProducts`), not returned in API order: exact name, then
prefix, then contains, then item-code match, with a nudge for names where the
match sits early. Ties keep catalog order, so a repeated search does not
reshuffle under the agent's cursor.

#### Branch Stock table

Filter box over the loaded rows — code (`P0221`), bare number (`0221`), English
city (`Jeddah`) or Arabic city (`جدة`) — filtered client-side with no request,
through `filterBranchStock`. **The summary recomputes from the rows on screen**
(`summariseStock` takes an array, so a filtered table and its counts cannot
disagree); when a filter is active the first count reads "matching branches" and
a line beneath gives the chain-wide figures, so neither can be read as the other.

**`areaName` is not searched and not displayed.** It is a coarse MIS region label
that duplicates the city for most branches and disagrees with it for others, so
searching it matched rows whose visible text had nothing to do with the query.
The field stays on `ShamsBranchStock` because it is what the API returns; nothing
in the UI reads it. `LZ Quantity` was removed earlier for the same kind of
reason — never verified, zero in all 275 captured rows.

Four columns, `table-fixed`: Branch (mono) · City · Qty (right, `text-base`
tabular) · Status. Quantity is the number being scanned so it carries the weight;
zero renders as a **destructive** `Out of Stock` badge and a stocked branch gets
a quiet `In stock` mark rather than a second loud badge. Still no "low stock"
band: the application defines no threshold.

#### Invoice lookup — number first, branch discovered

`Invoice number` → *find matching branches* → `agent picks` → `invoice details`.
One match skips the chooser; none is an empty state, not an error.

A document number is unique only within a warehouse, and **the MIS has no
cross-branch lookup**: its complete endpoint inventory (read from the portal's
shipped bundle) is `product/{search,info,stock}`, `sales/details`, `crm/data`,
four `dashboard/*` reports and auth/users, and `sales/details` always takes one
`wh_cd`. So `findInvoiceBranches` asks each branch, server-side. MilaServ's branch table
supplies only the list of places to look — a branch appears in the result solely
because Shams returned a document for it. A branch that fails is skipped; a total
failure raises, because "nothing matched" and "nothing answered" are different
facts.

**The cheapest sweep is the one that does not run.** The Invoices tab carries an
optional **branch selector** beside the number, and choosing one skips discovery
entirely: `useInvoiceBranches(submitted, !submittedBranch)` disables all four
parts, so a search goes straight to `sales/details` for that `(branch, docNo)`
pair. **141 upstream document lookups become 1** (144 rows in `branches`, 141
carrying a sweepable `^[A-Z]\d{4}$` code). It is never required — a bare number
still sweeps, which is the whole point of the sweep existing — and the filter is
read at submit, not as it changes, so altering the picker cannot silently
re-scope results already on screen. The selector is the same Popover + Command
combobox the order form uses, searching branch code and city in both scripts off
the already-cached `useBranchLabels` map; a result list of six or more branches
gets its own filter box, which narrows rows already in hand and issues no
request.

**What makes the sweep itself fast enough to use:**

- **Concurrency 24** per part, up from 8. 137 branches at 8 in flight is ~17
  waves; at the observed 0.4–2.3 s per lookup that was a 10–40 s wait. No rate
  limit has ever been observed on this API, but absence of evidence is not a
  licence, so this stays in the range a browser would itself produce.
- **6 s per-branch timeout** (`DISCOVERY_TIMEOUT_MS`) instead of the transport's
  30 s. One slow warehouse out of 137 must not hold a worker for half a minute.
  A probe also passes `retry: false`, so 6 s is the whole budget: the transport
  retries a transient failure once after a 300 ms backoff, which made a dead
  branch cost 12.3 s and — since the chooser waits for every part before it
  settles — held the agent for twice as long as the timeout claims.
- **Four parts, run in parallel by the client** (`DISCOVERY_PARTS`). Each part is
  its own server call over an **interleaved** slice (`partitionBranches` — round
  robin, not contiguous, because branch codes are regional and a contiguous slice
  would concentrate one region's latency in one part).
- **Progressive results.** Each part resolves independently, so matches render as
  they are found. `mergeInvoiceBranchMatches` unions the parts, keeps one row per
  branch and re-sorts, so a late Call Centre match still lands at the top and no
  earlier row disappears. The chooser says "still searching the remaining
  branches…" until every part is done, and **nothing is auto-selected until the
  sweep is complete** — a lone first answer is not proof it is the only one.
- **Server-side sweep cache**, 5 min per `(docNo, part)`, on top of the existing
  10-minute React Query window. Two agents looking up the same document cost one
  sweep. A total failure is never cached.
- **The sweep keeps the documents it downloads** (`sweptDocuments`, same 5 min).
  `sales/details` answers a probe with the *whole* document — header and item
  lines — and discovery used to keep only the chooser summary, so opening the
  document sent the identical request again: same path, same `doc_no_start`,
  same `wh_cd`, seconds apart. For the common single-match lookup that second
  round trip was the last thing between the agent and the invoice, and it is now
  a cache read. Only the sweep writes there, only for branches that answered with
  a document, and only a *bare* single-document query reads it — a range or a
  date window was never swept and always goes to the network.

It still runs **only on submit**, never per keystroke.

**Call Centre matches sort first** (`sortInvoiceBranchMatches`), then branch code
— deterministic, and deliberately not by city, total or arrival order. The
chooser marks those rows with a left rule and a tint; everything else stays
plain.

Decisions worth keeping:

- **Search is debounced 350 ms and floored at 2 characters.** The MIS portal
  itself fires a request per keystroke; this one does not.
- **Stock loads only for a selected product.** Availability for a twelve-row
  result set would be twelve requests of ~136 rows each.
- **Detail and stock are one query.** The server function already overlaps them,
  so "View branch stock" reads a warm cache entry.
- **No date filter on invoices.** The API's date parameters are NOT VERIFIED —
  the MIS frontend only ever sends them empty.
- **Branch is required for an invoice lookup.** A document number is unique only
  within a warehouse, so `(branch, docNo)` is the identity and the server
  rejects anything less.
- **The invoice branch picker is searchable** — Popover + `Command`, the same
  pattern as the order form's picker, matching on branch code, English name and
  Arabic city (`P0221`, `0221`, `Jeddah`, `جدة` all find the same branch). 137
  branches is past the point where a plain dropdown is usable. It reads the same
  `useBranchLabels` directory as before; no second branch source.
- **No stock thresholds.** The application defines none. Zero renders as "Out of
  stock" (a fact); every other quantity renders as itself.
- **`totalCost` / `profit` are not rendered.** Margin is not needed to read a
  document. Patient identifiers never reach the client at all — they are dropped
  in `normalize.ts`.
- **An invoice shows its `Customer` label *and* its Call Centre status**, never
  the badge alone. The suffix the rule turns on sits at the end of the label, so
  hiding the label hides the evidence. The label is not truncated.
- **Failure copy is chosen by `kind`, not printed from the server**, so no
  upstream string can surface in a browser.

Tables render twice — a real `<table>` from `md` up, the same rows as cards
below — so a phone never scrolls sideways. Branch labels come from
`branches.branch_no` via the portal's own directory, because the MIS's
`branchName` only ever duplicates its `branchCode`.

---

## Business Rules

### Orders

1. `team` is `customer_care` or `telesales`; `display_no` renders as `CC-…`/`TS-…`.
2. `order_type` ∈ {Cash, Wasfaty}; `delivery_type` ∈ {AlShrouq, Store Pickup,
   Branch Scooter, Azman}; `status` ∈ {Pending, Completed, Cancelled}.
3. `branch_no` and `delivery_type` are required by the form schema.
4. **Reassignment** (`agent_id`, `team`) requires `edit_all_orders`. That single
   permission is what makes reassignment possible.
5. Auditors are refused every order update, at the trigger.
6. **Verification-only updates** are a distinct path: if the diff touches nothing
   but `call_center_verified` (and `updated_at`), `verify_all_orders` or
   own-row + `verify_own_orders` is enough.
7. An agent may only insert an order for themselves (`auth.uid() = agent_id`) and
   must be active.
8. Fulfillment: `delivery_type` containing "pickup" → pickup; any other recorded
   method → delivery; **blank or absent → neither**. One definition, in
   `features/orders/fulfillment.ts`, mirrored by `public.order_fulfillment()`.
9. Completion rate and sales totals count `status = 'Completed'` rows only — the
   Dashboard fulfillment mix included.
10. **A verified invoice total is authoritative.** Once Shams has returned a
    document, `invoice_value` is the sum of the *distinct* verified totals and a
    manually entered figure does not survive it — at creation, on save, and on
    every later reconciliation. Nothing verified yet means the typed value
    stands: an invoice may still be an hour away. One rule,
    `authoritativeValue`, plus the server's own recompute from the activity log.
    The sum is over the invoices the order names **now**, at their **latest**
    known totals — never accumulated onto the previous value, and never counting
    a number since removed or a document's superseded price.
11. **`call_center_verified` means the call centre raised the invoice.** It is
    set automatically only from a *verified* document whose MIS channel says
    Call Centre, never from a typed number, an attempted lookup, a failed one or
    a pending one. It is **derived, not latched**
    (`call_center_verified = (call_centre_cnt > 0)`, `20260815170000`): replace a
    call-centre invoice with a walk-in one, or have the MIS correct the channel
    on the same number, and the flag clears itself and the timeline records
    `call_center_cleared`. The second half of that was a claim this file made and
    the code did not keep until `20260815210000` — nothing re-recorded a
    document's channel, so the flag was decided from the first answer ever
    received about it. It was set-only until then, so a replaced invoice left
    the order claiming a verification its own documents no longer supported.
    Clearing needs *current* evidence — the recompute sits inside
    `IF verified_cnt > 0`, so a pending replacement or an unreachable MIS leaves
    the flag exactly as it was rather than deriving it from an absence.

    That guard left one gap, closed by `20260815190000`: the recompute ran only
    when the *order page* called it, so **changing `invoice_no` did not
    re-derive anything**. Create did (`submit` calls the RPC after the insert);
    the edit path is a plain `UPDATE` and had no equivalent, so an agent who
    replaced a walk-in invoice with a call-centre one, saved, and went back to
    the list saw the old warning against a document the order no longer had.
    `trg_sync_order_invoice_flags` (AFTER UPDATE OF `invoice_no`) now re-derives
    `invoices_verified`, `call_center_verified` and `invoice_value` from the same
    current-keys × latest-per-document evidence, under the same
    `milaserv.invoice_sync` GUC so the correction is attributed to the portal
    and narrated with the same three events. It reads the local activity log, not
    the MIS, and a tick made **by hand in the same statement** survives it
    (`OR manual_tick`), since the form still offers that box to `verify_*`
    holders.

    It recomputes **only when `verified_cnt > 0`** (`20260815230000`) — the same
    guard the RPC has always had, and which this trigger and its one-time
    backfill were written without. With nothing answered for, all three columns
    keep what they hold. The backfill shipped in `20260815165443` did not: it
    applied the derivation to every order in the table at once, and since its
    evidence (`invoice_verified` rows) only began to exist on 2026-08-14 while
    `call_center_verified` had been a hand-ticked box since 2026-06-24, 3,837
    orders were written in one statement at `2026-08-15 16:54:43.943234+00` and
    3,836 lost a flag a person had set. 3,834 were restored from their own
    `verification_changed` history; the pre-restoration state is preserved in
    `public.orders_verification_snapshot_20260815` (RLS on, no grants — evidence,
    not application data).

    Verification is **historical state, not a derived view**. It records what was
    established about an order when someone or something established it, so:
    absence of current `invoice_verified` activity is never evidence that an
    order was not verified, and neither flag may be cleared without positive
    current evidence justifying the change. A new verification still updates
    state, and an explicit un-verification still works — what is gone is
    clearing by silence. `20260815190000` has been retired to a no-op so its
    backfill cannot run again, and `20260815210000` carries the guard so it
    cannot revert the fix if it is ever pushed. `invoice-flags-sync-sql.test.ts`
    holds the regression cases deliberately: the two zero-evidence cases (keep
    what you hold; never promote false to true) and the positive-evidence case
    (reconcile as normal). Absence of evidence is not evidence of a walk-in.

    **Both derivations read channel corrections** (`20260816120000`). A document
    recorded as a walk-in used to stay one for ever unless its *price* moved, so
    the Orders list and the order page could disagree about the same invoice: the
    page reads the live Shams answer and said Call Centre, the list reads
    `call_center_verified` derived from a log that had never been told. The RPC
    now writes `invoice_channel_changed` (`20260815210000`) and
    `sync_order_invoice_flags` reads it, so the two cannot diverge. Affected
    orders repair themselves on the next page open — the client has been asking
    for that reconciliation all along, and it now lands instead of being
    discarded, which also ends a wasted RPC on every open of such an order.

    It is **not** manually tickable from the Orders list any more; the order form
    still offers it to `verify_*` holders, for a document raised outside the
    call centre that operationally belongs to it.
12. **An order completes itself when nothing is left to do.**
    `record_invoice_verification` moves `status` to `Completed` in the same
    statement that reconciles the value, and only when all of: the order has at
    least one invoice, every invoice it names is verified
    (`verified_cnt = current_cnt`, so a pending one blocks it), **every** one of
    those is a Call Centre document (`call_centre_cnt = verified_cnt`), and the
    order is neither `Cancelled` nor already `Completed`.

    The Call Centre clause is `= verified_cnt`, not `> 0`, and the difference is
    the point: a mixed order — one invoice through the call centre, one raised at
    the counter — is precisely the order somebody needs to look at, so it keeps
    the order-level flag (which stays ANY) but is **not** completed. Shipped as
    `> 0` in `20260815120000` and corrected in `20260815140000`; one live order
    (#8328) was auto-completed under the ANY rule and stays Completed, since the
    automation never reverses a status.
13. **Cancelled is terminal for the automation.** Cancellation is a manual
    decision an agent takes when a pharmacist reports one, and no amount of
    later invoice verification may undo it. The same clause makes a re-check
    free: once `Completed`, nothing is written and no event is raised.

### Complaints

Parallel workflow; status `In Progress` | `Resolved`; resolving your own vs. any
complaint are separate permissions; Telesales holds none of the complaint
permissions by default.

### Branches

1. `branch_no` is the natural key and never changes.
2. Branches are never deleted — only deactivated.
3. Only active branches appear in the directory.
4. Import requires `admin_access`; rollback requires administrator.
5. Every import snapshots the prior table state; rollback appends a new history
   entry and never rewrites one.
6. `duty_hours` is derived at import time from `working_hours`.

### Users & credentials

1. At least one Owner must always exist.
2. Owners cannot be deleted, deactivated, or have their role changed.
3. Only an Owner may create or grant Owner, and must re-enter their password.
4. A Supervisor may administer only agents and auditors — never another
   Supervisor, admin or Owner.
5. Only `customer_care` and `telesales` carry an Agent Code; it is cleared for
   everyone else.
6. Admin-set passwords default to temporary (24h/48h); the holder is blocked from
   the entire authenticated surface until they replace it.
7. You cannot set your own password through the admin path, and cannot delete
   your own account.
8. Deactivation withholds reads as well as writes.
9. Every privileged write is audited.

### Call centre

1. Internal (extension-to-extension) calls are excluded from every KPI.
2. An IVR pickup is not an answered call.
3. `ivr_only` is not a missed call.
4. `cancelled_by_agent` counts toward Total but never No Answer; the
   discriminator is `YEASTAR_OUTBOUND_RING_TIMEOUT_SEC` (default 60).
5. After-hours calls are reported but excluded from operational KPIs — and with
   `YEASTAR_BUSINESS_HOURS` empty, **no** after-hours rule is applied at all.
6. Talk time is counted once, from the agent leg.
7. Team agents see only their own team's figures, plus Call Lookup.

### Presentation

Currency SAR; all business timestamps rendered in `Asia/Riyadh`; statuses use one
shared colour vocabulary (Pending `#F59E0B`, Completed `#10B981`, Cancelled
`#EF4444`).

---

## Environment Variables

Template: `.env.example`. `.env` is git-ignored.

### Supabase

| Variable                                                     | Scope           | Notes                                                                                       |
| ------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------- |
| `SUPABASE_PROJECT_ID` / `VITE_SUPABASE_PROJECT_ID`           | server / client | Project ref. The `VITE_` copy is the MCP OAuth issuer.                                      |
| `SUPABASE_URL` / `VITE_SUPABASE_URL`                         | server / client |                                                                                             |
| `SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY` | server / client | Anon key. Browser-safe by design; **RLS is the boundary**.                                  |
| `SUPABASE_SERVICE_ROLE_KEY`                                  | **server only** | Bypasses RLS. Never `VITE_`-prefixed, never bridged by `hydrateServerEnv`, never committed. |
| `SITE_URL` / `VITE_SITE_URL`                                 | server          | Fallback origin for recovery emails when no request context exists.                         |

`vite.config.ts` ships **last-resort fallbacks** for the three public Supabase
values, because the Lovable preview sandbox periodically loses its `.env` and the
bundle then inlines `undefined`. A real value in the environment always wins. The
service-role key is not among them and must never be.

### Google Maps Platform — two keys, on purpose

| Variable                       | Scope           | Notes                                                                                                                                                                    |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_GOOGLE_MAPS_BROWSER_KEY` | client          | Restrict by HTTP referrer + Maps JavaScript API. **Currently read nowhere** — there is no client-side Maps SDK in the app today.                                         |
| `GOOGLE_MAPS_API_KEY`          | **server only** | Geocoding / Routes / Places. Restrict by IP. This is the key that can run up a bill. Absent → the Distance Engine falls back to straight-line distances; nothing breaks. |

### Yeastar

| Variable                                                         | Notes                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `YEASTAR_BASE_URL`, `YEASTAR_CLIENT_ID`, `YEASTAR_CLIENT_SECRET` | Server-only credentials. Absent → the Calls module reports "not configured".                                                                                                                                                                                                                                 |
| `YEASTAR_UTC_OFFSET_MINUTES`                                     | Default `180`.                                                                                                                                                                                                                                                                                               |
| `YEASTAR_DATETIME_FORMAT`                                        | **Unused, and deliberately so.** Documented only so it is not reintroduced: the Call Report wire format is a constant of the API, and the value in the template is wrong on both field order and clock. A malformed value would not fail loudly — v1.0 accepts it, ignores the window and returns zero rows. |
| `YEASTAR_BUSINESS_HOURS`                                         | `"<days> <HH:MM>-<HH:MM>"`, e.g. `"sun-thu 08:00-17:00"`. **Leave empty to apply no after-hours rule.** The PBX cannot supply it (queue 6400 reports `enable_time_condition: 0`), and guessing silently moves every KPI.                                                                                     |
| `YEASTAR_OUTBOUND_RING_TIMEOUT_SEC`                              | Default `60`. The only discriminator between a genuine No Answer and an Agent Cancelled call — both carry disposition `NO ANSWER`. Read the true value off the ring histogram on the diagnostics page.                                                                                                       |
| `YEASTAR_CDR_PAGE_SIZE`                                          | Default 2,000 (clamped 100–10,000).                                                                                                                                                                                                                                                                          |
| `YEASTAR_CDR_PAGE_CONCURRENCY`                                   | Default 3. Higher does not make a window faster — the appliance serializes — it only queues each request closer to its timeout.                                                                                                                                                                              |
| `YEASTAR_CDR_PAGE_TIMEOUT_MS`                                    | Default 60,000 (floor 10,000). Per-page request timeout, separate from the client's 25 s default for control-plane calls.                                                                                                                                                                                    |

### CDR synchronization

| Variable                            | Notes                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDR_SYNC_SECRET`                   | **Server only.** Shared secret a scheduler presents to `POST /api/cdr-sync`; a cron job has no Supabase session, so it cannot use a bearer token. Compared in constant time. Leave **empty** and the secret path is closed entirely — the endpoint then accepts only an administrator's token, and synchronization is driven by the read path. |
| `YEASTAR_CDR_SYNC_HORIZON_DAYS`     | How far back the mirror is kept complete. Default 90 (clamped 1–400) — the widest dashboard preset is a month and Call Lookup's ceiling is 90 days.                                                                                                                                                                                            |
| `YEASTAR_CDR_SYNC_MAX_DAYS_PER_RUN` | Days one run may sweep. Default 7 (clamped 1–60). A run executes inside a request, so it is bounded and a backfill walks across runs.                                                                                                                                                                                                          |

The synchronization layer additionally needs `SUPABASE_SERVICE_ROLE_KEY` — the
mirrored tables are `service_role` only. Without it the layer reports "not
configured" and every read falls back to the live PBX path.

### Shams Pharmacy MIS

| Variable                                     | Notes                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHAMS_MIS_BASE_URL`                         | **Server only.** Origin of the MIS API, no trailing slash or path. Absent → the Shams module reports "not configured" and every server function returns an empty result; nothing else breaks.                                                                                                     |
| `SHAMS_MIS_ACCOUNT_IDENTIFIER` / `SHAMS_MIS_API_KEY` | **Server only, and REQUIRED.** The machine credentials exchanged at `POST /api/v2/auth/token` for the Bearer token every data request carries. The API key is a secret — treat it like `SUPABASE_SERVICE_ROLE_KEY`: never `VITE_`-prefixed, never logged, never committed, never sent to a browser. |

All three Shams variables are required **together**; any one missing is treated
as "not configured" rather than failing later with a 401 that would look like a
Shams-side outage. `SHAMS_MIS_USERNAME` / `SHAMS_MIS_PASSWORD` were removed —
the portal-user login they fed is not part of the API auth path, so configuring
a password bought nothing and stored a credential for no reason.

**`SHAMS_MIS_BASE_URL` must be set in the deployment, not only in a local `.env`.**
`.env` is git-ignored and never ships, so a value present locally does not reach
production — the deployed portal reports "Shams MIS is not configured for this
deployment" until the variable exists in the hosting environment itself
(Lovable's project environment settings for the Cloudflare Worker; project
environment variables on Vercel). Set it as a plain **unprefixed** server
variable — a `VITE_` copy would be inlined into the public bundle — then
redeploy so the Worker picks it up.

The value is `https://mis.shamspharmacy.com`: an origin only, no trailing slash
and no `/api/v2` path, which `readEnv()` appends itself. It is not a credential,
but it stays server-only to keep one configuration pattern for the module.

That the unprefixed server-variable mechanism works on this deployment is not an
assumption: the Yeastar client reads `YEASTAR_BASE_URL` / `_CLIENT_ID` /
`_CLIENT_SECRET` off `process.env` in exactly the same way, and
`public.yeastar_token_cache` carries tokens minted by the deployed Worker. The
Worker build sets `nodejs_compat` (see `.output/server/wrangler.json`), which is
what populates `process.env` from the Worker's own variables. So an absent Shams
value is a missing setting, never a broken bridge — `hydrateServerEnv` does not
need to carry it.

### Build

`NITRO_PRESET` — set to `vercel` by `vercel.json`'s build command.

---

## Deployment

### Primary target — Cloudflare Workers (via Lovable)

Nitro's default preset for this repo is `cloudflare-module`, so `vite build`
emits a Worker bundle. `src/server.ts` is the Worker entry
(`tanstackStart.server.entry = "server"`): it hydrates env from the Worker
bindings, delegates to the TanStack Start server entry, normalizes
h3-swallowed 500s, and applies security headers to **every** response — SSR
documents, `/api` routes, server functions and MCP endpoints alike, which a
host-level `_headers` file would not reach.

### Secondary target — Vercel

`vercel.json` sets `buildCommand: "NITRO_PRESET=vercel npm run build"`, which
makes Vite write `.vercel/output/{config.json,functions,static}` (Build Output
API). Install command and output directory are deliberately unset: the repo
commits `bun.lock`, so Vercel's auto-detection installs with Bun correctly. The
file is inert outside Vercel.

### CI (`.github/workflows/ci.yml`)

Triggers on push to `main`, all PRs, and manual dispatch. Concurrency cancels
superseded runs except on `main`. Node 22 + Bun 1.3.14,
`bun install --frozen-lockfile`, then — cheapest signal first, mirroring
`npm run ci`:

```bash
npm run typecheck && npm run lint && npm run check:permissions && npm test
```

**Bun is forced, not preferred:** `npm install` cannot resolve this tree at all
(`@hookform/resolvers@5.5.1` peer-optionals `valibot@^1`, `@typeschema/valibot`
pins `^0.39` → `ERESOLVE`). `--legacy-peer-deps` would only silence the check and
would still re-resolve semver on every run.

### Local

```bash
npm run dev        # vite dev, port 8080
npm run preview    # vite preview, port 4173
```

`.claude/launch.json` declares both.

### PWA

`vite-plugin-pwa` with `generateSW` + `autoUpdate`, emitting `sw.js`. The app
ships its own `/manifest.webmanifest`. `navigateFallbackDenylist` excludes
`/~oauth`, `/_serverFn`, `/api/`, `/.mcp/`, `/.well-known/`. Runtime caching:
NetworkFirst for HTML navigations (4 s timeout), CacheFirst for same-origin
scripts/styles/fonts and images. Registration is refused in dev, in iframes, on
Lovable preview hosts, and with `?sw=off`.

### Lovable sync

Commits pushed to the connected branch sync back into the Lovable editor
(`AGENTS.md`). **Never rewrite published history** — force-push, rebase, amend or
squash of already-pushed commits rewrites history on Lovable's side and can lose
project history.

---

## Known Technical Debt

1. **~310 `any` casts.** `@typescript-eslint/no-explicit-any` is downgraded from
   `error` to `warn` with a written rationale in `eslint.config.js`: nearly all
   are casts on Supabase query builders written before `types.ts` covered those
   tables. Kept as a warning so the count stays visible in every CI run rather
   than hidden (`off`) or used as an excuse never to enable lint (`error`). Raise
   it back to `error` once it reaches zero.
2. **Tables missing from generated types.** `admin_activity`, `branch_imports`,
   `branches_nearby` and the three CDR-sync tables (`cdr_records`,
   `cdr_sync_days`, `cdr_sync_state`) are reached through `as any` casts because
   the generated `types.ts` is regenerated on its own schedule.
   `geo.functions.ts` confines its cast to a single adapter, and
   `cdr-store.server.ts` confines all three of its tables to one `table()`
   helper.
3. **`profiles.permissions` may hold keys outside the role's ceiling.** They are
   inert (`has_permission()` checks `_allowed` first), but they are dead data
   that reads like a grant.
4. **`public.profile_directory` is a leftover.** A plain (non-`security_invoker`)
   view from `20260701224822`, so it runs as its owner and bypasses the profiles
   policy. Nothing in the application reads it, so it is not a live bypass;
   removing it was recorded as a separate decision.
5. **`call_center` is an orphaned enum value.** It cannot be dropped without
   recreating `app_role`, which is referenced by `user_roles.role` plus numerous
   policies, triggers and functions.
6. **Telesales was never refactored onto the Metrics Engine.**
   `telesales-trend-charts.tsx` still computes two rates in-component — the same
   class of issue as the Customer Care violation that was fixed.
7. **`/api/public/cdr-progress/$jobId` has a misleading path.** It is
   authenticated; the `public` segment is legacy and documented as such in the
   file.
8. **The strict CSP is report-only.** TanStack Start injects inline hydration
   scripts and Radix sets inline style attributes, so an enforced
   `script-src`/`style-src` needs nonce plumbing through the SSR renderer.
   Shipping it enforced and untested would white-screen the app. Promote once
   violation reports are clean.
9. **A Windows-only upstream bug is patched in `vite.config.ts`.**
   `@lovable.dev/mcp-js` (0.20.0 → 0.24.0) compares a forward-slash `config.root`
   against `path.resolve()` output, so its containment guard can never hold on
   Windows and neither `vite dev` nor `vite build` starts. `withNativeSepRoot`
   wraps one hook; it is a no-op off Windows and should be removed when upstream
   fixes it.
10. **Public Supabase values are hard-coded as build fallbacks** in
    `vite.config.ts`, working around a Lovable sandbox that repeatedly loses its
    `.env` (commits `b21a573`, `093dbad` fixed it sandbox-side only, so it kept
    regressing).
11. **`useAgentDirectory` returns `role: null` for most callers**, because
    `user_roles` SELECT is scoped. Every consumer must tolerate it.
12. **Audit writes are best-effort.** `logAdminAction` never throws. Making the
    trail provably complete needs a two-phase write (record, act, mark
    committed), which belongs with that requirement rather than ahead of it.
13. **Local `.env` and the Supabase CLI link disagree.**
    `supabase/config.toml` + `supabase/.temp/project-ref` point at
    `xscurilznfinllufgdpq`, while `.env` and the `vite.config.ts` fallbacks point
    at `gwnxlpophyvgafctrbkx`. Migrations applied through the CLI would land on a
    different project than the running app.
14. **Migration history has a known gap.** `20260726000000` records that
    `20260721001200_owner_protection.sql` was committed but never applied to the
    live project — `schema_migrations` jumps from `20260709174246` to
    `20260723022830` — which took `is_owner()` down and, with it, every admin
    write path. The function was restored separately; **the two owner-protection
    triggers were deliberately left out** and remain a separate decision.
15. **`VITE_GOOGLE_MAPS_BROWSER_KEY` is documented but read nowhere.** The
    client-side Maps SDK was removed with the Branch Directory's interactive map.

---

## Known Issues

1. **O1 — Missed vs. Abandoned follows Yeastar, and now does so everywhere.** On
   the verified window (2026‑07‑29, queue 6400) every KPI matched exactly except
   the split: CDR read 8 missed / 0 abandoned where Yeastar read 0 / 8. Totals
   agree (8 unanswered either way). The dashboard reports Yeastar's split, and
   since the classification module every surface that shows those calls — cards,
   charts, drill-downs, exports — resolves it through
   `call-classification.ts`, so a card and its list can no longer disagree. The
   CDR split is still published for comparison on `unansweredSplit`
   (`UnansweredSplitComparison`) and surfaced by the dashboard notice. What is
   still outstanding is confirming Yeastar's own definitions from the PBX Web UI;
   until then the per-call re-cut is a wait-ordered reconstruction of the PBX's
   boundary, not a field read from the CDR.
2. **Per-agent missed calls are a firmware blind spot.** Unanswered agent rings
   leave no CDR trace at all, so the column reads "—" unless Call Report is
   available.
3. **Multi-queue caveat.** With `queue = "all"`, CDR spans every queue while Call
   Report covers 6400 only. Equivalent today (6400 is the sole configured queue),
   but per-agent missed would be 6400-scoped if another were added.
4. **The Sprint 3 refactor was never verified in a browser** against live PBX
   responses — the dev server starts clean and every module transforms, but the
   O1 notice card and the "—" missed column have not been seen rendering.
   Recorded as "worth a look on first open".
5. **Sprint 2 findings O3, O4, O5, O7, O9 remain open and untouched.**
6. **`/openapi/v1.0/call_report/*` lies rather than fails** — `errcode 0` with an
   ignored window and zero rows. Any future code that "falls back" to v1.0 will
   silently report an empty call centre.
7. **A bogus Call Report queue id is indistinguishable from an empty window** —
   both return `errcode 0` with no rows.
8. **PBX token issuance is rate-limited** (`errcode 60002`); a burst of cold
   starts can block PBX access for up to 5 minutes.
9. **`queue/call_status` and `queue/agent_status` return `60001 DATA NOT FOUND`
   when the queue is idle** — not an unsupported endpoint, but easy to misread.
10. **`YEASTAR_BUSINESS_HOURS` is empty by default**, so no after-hours exclusion
    is applied. Setting it wrong silently moves every KPI.
11. **Orders and complaints are readable by every permission holder.** Any agent
    can read every other agent's customer names and phone numbers via the API,
    the MCP `list_orders` tool, or a direct PostgREST query. This is a confirmed
    business decision (shared order book), recorded in-migration precisely so a
    future audit does not "fix" it — but it is a real data-exposure property that
    must be understood.
12. **`profiles` row-level visibility is open to every active user.** The real
    boundary is the column grant; a row-scoping predicate added here would hide
    nothing.
13. **`must_change_password = true` with a NULL deadline means "expired"**, not
    "no deadline". Comparing the columns by hand instead of calling
    `temporaryPasswordState()` gets this backwards.
14. **`has_permission()` resolves the role with `LIMIT 1` and no `ORDER BY`.** An
    account holding two `user_roles` rows gets a nondeterministic answer, and
    `getRole()` (`.maybeSingle()`) turns the second row into "Forbidden:
    authorization check failed".
15. **The Owner bootstrap is pinned to one hard-coded email address**
    (`20260726001000`). A fresh environment where that account does not exist
    gets a `NOTICE` and no Owner — and there is no other path to mint the first
    one.

---

## Architectural Decisions

**AD-1 — Authorization is defined twice, and a CI guard keeps them honest.**
SQL is authoritative (it is the only layer PostgREST, the SQL console and future
services all pass through); TypeScript mirrors it so the UI can render.
`check-permission-parity.mjs` parses both as _text_ — no app code executed, no
test runner, no dependencies — and fails on any set mismatch.

**AD-2 — Per-permission authorization, with an explicit administration ladder.**
Feature access is never inferred from role rank. Who may administer whom _is_ a
table (`ROLE_ASSIGNABLE_BY`), written out rather than computed, because the rule
is deliberately non-uniform and a security predicate carrying a silent exception
is exactly the kind of thing that rots.

**AD-3 — Invariants in the database, actor rules in the application.**
Privileged writes run as `service_role` where `auth.uid()` is `NULL`, so the
database cannot tell _who_ is acting. Triggers therefore enforce what must be
true regardless of path ("at least one Owner exists"); server functions enforce
who may do it.

**AD-4 — Deny by default for unknown roles.** Both `hasPerm` and
`has_permission()` return false for a role with no rules, rather than indexing
into an undefined entry. `supervisor` hit exactly that before it was wired in —
`undefined.includes(...)` took the whole page down instead of refusing a
permission.

**AD-5 — A single hierarchical query-key factory.** React Query prefix-matches
element by element, so the old flat keys (`orders-page`, `dashboard-kpis`) never
matched `["orders"]`/`["dashboard"]` invalidations. Those calls compiled, ran,
matched nothing, and left stale data on screen.

**AD-6 — Global React Query defaults instead of per-query opt-outs.** The
evidence was already in the tree: one route hand-rolled `staleTime` plus three
`refetchOn*: false` flags. On the Dashboard, library defaults meant eleven RPC
round-trips on every window focus.

**AD-7 — The CALL, not the CDR row, is the unit of analysis.** Forced by the
firmware. Everything downstream — leg roles, outcome taxonomy, wait-vs-ring
separation, once-only talk seconds — follows from it.

**AD-8 — One Metrics Engine, and components may not compute.** The same KPI was
previously derived in three places and they drifted. A single derivation point is
also what makes the parity regression tests meaningful: they assert against
exactly what the user sees.

**AD-9 — The CDR cache is partitioned by business day.** Windows are composed
from days; only genuinely missing days are fetched. A month re-filtered costs
zero PBX calls, and extending a range by one day fetches one day.

**AD-10 — Normalize over the whole window, never per day.** A call starting at
23:58 and answered at 00:02 has legs either side of midnight; per-day grouping
would split it into two half-calls and report that nobody answered.

**AD-11 — Call Report v2.0 only, no fallback.** v1.0 does not fail, it lies.

**AD-26 — CDR is mirrored into Supabase, and the mirror is never an authority.**
The dashboards' dominant cost was waiting on a PBX sweep that a different isolate
had already paid for; a per-isolate memory cache cannot share that work, and
Cloudflare recycles isolates freely. `cdr_records` makes the work shared and
durable. It stores rows **verbatim** and derives nothing, so the analytics
pipeline is byte-identically fed either way — which is what makes "keep the KPIs
unchanged" a property of the design rather than a hope. Every path degrades to
the live PBX on any doubt: unconfigured, unreachable, or merely incomplete
coverage.

**AD-27 — Day coverage, not a timestamp cursor, is the incremental unit.** CDR is
written when a call ENDS but timestamped when it STARTED, so a call spanning a
cursor is filed behind it and a cursor-exact resume skips it permanently.
`cdr_sync_days` records which days are covered — including quiet days, explicitly,
so zero calls is never mistaken for a gap — and the live tail is always refetched.
It is also the granularity the PBX's own API actually offers.

**AD-28 — Idempotency by upsert on the PBX's own row id.** `new_id` is row-unique
on this firmware while `uid` and `call_id` are call-level; keying on either would
collapse a multi-leg call to one row on write, the same mistake the parser made
before AD-7. With `row_id` as the conflict target, overlap becomes a tool: the
sync deliberately re-sweeps the live tail, the read path writes days the sync may
also be writing, and a crashed run re-runs — all converging on the same rows.

**AD-12 — Branch snapshots, not diffs.** Four import modes each touch a different
subset; reversing a diff across all of them means reconstructing deletes, partial
column updates and untouched rows. At ~1000 short-text rows a snapshot is a few
hundred KB — worth paying once per import for an undo an operator can trust.

**AD-13 — Branches are soft-deleted.** `orders.branch_no` is a foreign key, so a
branch that has ever taken an order can never be deleted; a real "Replace All"
DELETE would abort on the first referenced row.

**AD-14 — PostGIS geography, and a generated `location` column.** Geography
measures in metres on a spheroid, so no projection or per-region SRID can be got
wrong. `GENERATED ALWAYS … STORED` means the column cannot drift from
latitude/longitude and no application code has to remember to maintain it.

**AD-15 — Two-stage distance: narrow in the database, rank with road distance.**
The spatial index bounds the work at 145 branches and at 5,000; only the handful
of candidates go to the billed Routes API. When routing is unavailable the
straight-line ordering stands and is _labelled_, so the UI can hedge rather than
overstate.

**AD-16 — A gazetteer built from our own data.** Cities, districts and branch
codes derived from the directory answer a keystroke in microseconds with no key
and no quota; Nominatim is the last resort only.

**AD-17 — Admin-issued passwords are temporary by default.** A password two
people know is not a credential. The forced-change gate is applied at the layout,
not per page, because it is a property of the account.

**AD-18 — Owner is a protected role, and granting it needs a password.** Every
other role change is deliberately _not_ password-gated: prompting on routine
edits trains people to type their password without reading the dialog, which
makes the prompt that does matter weaker.

**AD-19 — The audit log is append-only and denormalized.** No FK to `profiles`
(it must outlive deleted accounts), name/email snapshotted at action time,
`actor_role` captured at import time, and no `UPDATE`/`DELETE` grant for anyone.

**AD-20 — Paging the audit log by growing the limit.** The log is append-only at
the head, so an offset shifts under the reader while a `created_at` cursor drops
entries sharing a timestamp. Re-reading from the top is exact; `ACTIVITY_MAX_ROWS`
bounds it.

**AD-21 — CSP split into enforced and report-only.** Only directives that cannot
break a working app are enforced today.

**AD-22 — Refresh cadence derived from the window.** Nothing about how a KPI is
computed changes; only how often the same answer is asked for.

**AD-23 — Vitest deliberately does not extend `vite.config.ts`.** That config
pulls in TanStack Start, Nitro, the MCP route generator and the PWA build — an
entire application pipeline the unit tests neither need nor should wait for, and
which regenerates route files as a side effect of being loaded. Tests run in
`node` (every unit under test is a pure function) with `globals: false`.

**AD-24 — Generated files are excluded from ESLint and Prettier.** Formatting a
file its generator rewrites verbatim turns `npm run lint` red for a change nobody
made. Paths are spelled without brackets because `[.mcp]` is a character class in
these glob semantics.

**AD-25 — The PBX vendor is not named in the product surface.** Swapping provider
would not change a menu entry.

---

## Future Improvements

Drawn from what the code itself marks as deferred, incomplete, or blocked.

### Correctness and integrity

1. **Close O1.** Confirm Yeastar's own Missed/Abandoned definitions from the PBX
   Web UI, then retire the remaining notices. If the PBX ever exposes a per-call
   "who ended the call" field, `classifyUnansweredCalls` should read it instead
   of reconstructing the boundary from queue wait — that is the one assumption
   in the module and it is deliberately isolated to a single function.
2. **Verify the Customer Care refactor in a browser** against live PBX responses
   — specifically the O1 notice card and the "—" missed column.
3. **Reconcile the Supabase project reference.** Decide whether
   `xscurilznfinllufgdpq` or `gwnxlpophyvgafctrbkx` is the live project and make
   `config.toml`, `.env` and the `vite.config.ts` fallbacks agree.
4. **Decide on the owner-protection triggers.** `trg_protect_last_owner` and
   `trg_protect_owner_profile` were held back from the live project; applying
   them is what makes an Owner grant genuinely irreversible.
5. **Add a `UNIQUE(user_id)` constraint or an `ORDER BY` to role resolution** so
   a double role row cannot produce a nondeterministic authorization answer.
6. **Replace the hard-coded Owner bootstrap email** with a documented, repeatable
   genesis procedure.

### Security

7. **Promote the report-only CSP to enforced** once `/api/csp-report` traffic is
   clean — which needs nonce plumbing through the SSR renderer.
8. **Make the audit trail provably complete** with a two-phase write, if and when
   that is a requirement.
9. **Remove `public.profile_directory`**, or convert it to `security_invoker`.
10. **Prune `profiles.permissions` entries outside each role's ceiling**, so
    stored data cannot read like a grant it is not.

### Engineering

11. **Drive `@typescript-eslint/no-explicit-any` to zero and raise it back to
    `error`**, which mostly means regenerating `types.ts` to cover
    `admin_activity`, `branch_imports` and `branches_nearby`.
12. **Move Telesales onto the Metrics Engine**, eliminating the two in-component
    rate calculations in `telesales-trend-charts.tsx`.
13. **Rename `/api/public/cdr-progress/$jobId`** to drop the misleading segment.
14. **Remove the `withNativeSepRoot` workaround** when `@lovable.dev/mcp-js`
    fixes its Windows path comparison.
15. **Remove the hard-coded public Supabase fallbacks** once the deployment
    environment reliably supplies them.
16. **Add rendering tests.** The suite is 1,054 tests across 32 files, all of pure
    logic in a `node` environment — nothing in the app is currently render-tested.

### Product

17. **Tune the Calls environment from the diagnostics data** — read
    `YEASTAR_OUTBOUND_RING_TIMEOUT_SEC` off the unanswered-outbound ring
    histogram and set `YEASTAR_BUSINESS_HOURS` from the calls-per-hour histogram,
    both on `/calls/diagnostics`.
18. **Scope Call Report per queue** before a second queue is configured, or the
    per-agent missed column silently becomes 6400-only.
19. **Reinstate an interactive map** if needed — the deleted Maps SDK loader and
    provider are recoverable from git history, and
    `VITE_GOOGLE_MAPS_BROWSER_KEY` is already documented for it.
20. **Address Sprint 2 findings O3, O4, O5, O7, O9.**
21. **Attach a scheduler to `POST /api/cdr-sync`** and set `CDR_SYNC_SECRET`.
    Until then the mirror is filled only by the read path, so the first viewer of
    a cold window still pays for its sweep and Call Lookup rarely takes the
    `"synced"` path (it needs today inside the live TTL). A retention policy for
    `cdr_records` beyond the horizon is the natural follow-up.

---

## Appendix — Verification

Facts in this document were checked against the tree at the CDR synchronization
commit on `main`.

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm run check:permissions # SQL ↔ TypeScript permission parity
npm test                 # vitest run
```

Test suite as of writing: **1,054 tests across 32 files, all passing.**

Test coverage is concentrated on pure logic — `permissions`, `roles`,
`authorization-invariants`, `calls-access`, `password-policy`, `floating-card`,
`geo`, the Yeastar pipeline (`normalize`, `stats`, `metrics-engine`,
`cdr-window`, `cdr-paging`, `cdr-by-number`, `cdr-sync`, `call-report`,
`call-report-ttl`, `lookup-match`, `unanswered`, `yeastar-parity`), the branches
feature
(`normalize`, `search`, `district`, `locator`, `location-index`, `import-parse`,
`delivery-eta`, `geocode-nominatim`, `highlight`), `refresh-policy`, the
diagnostics `compare`, and the sidebar navigation builders.
