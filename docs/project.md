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
│   │   ├── branches/  call-center/  calls/  dashboard/
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
│   ├── migrations/              87 SQL migrations
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

### Parity guard

`npm run check:permissions` text-parses the newest migration that redefines
`has_permission()` and `src/lib/permissions.ts`, and asserts the per-role
permission _sets_ are identical for `supervisor`, `customer_care`, `telesales`,
`auditor`. It runs in CI between lint and tests.

---

## Database Schema

PostgreSQL on Supabase, `public` schema, PostGIS 3.3.x enabled. 87 migrations in
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
`created_at`, `updated_at`.

Indexes include `orders_team_date_idx (team, order_date) INCLUDE (agent_id,
status, order_type, invoice_value)` and `orders_agent_date_idx (agent_id,
order_date) INCLUDE (…)` — index-only plans for the Calls conversion join.

### `complaints`

`id`, `display_no`, `complaint_date`, `agent_id`, `branch_no`, `category`,
`status`, `resolution`, `description`, `customer_name`, `customer_phone`,
timestamps.

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
`_fulfillment`; returns `json`), `orders_daily`, `orders_status`, `orders_teams`,
`orders_agents`, `orders_locations`, `orders_delivery`,
`orders_delivery_matrix`, `orders_verification`; and for complaints
`complaints_in_scope`, `complaints_kpis`, `complaints_locations`.

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
| `trg_prevent_order_reassignment`                        | `orders`     | The real order-update authorization: `edit_all_orders` passes; auditors are refused outright; otherwise `agent_id`/`team` are immutable and the caller needs `edit_orders` on their own row, or a verification-only diff plus `verify_all_orders` / `verify_own_orders`. |
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
  `section-title`.
- **Orders:** `copyable-order-no`, `invoice-cell`, `kpi-card`,
  `order-activity-timeline`, `status-badge`, `team-badge`.
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
names for roles without `view_all_agents` while leaving the ranking intact) ·
`use-dashboard-export-data` (`enabled: false`, fetched via `refetch()`) ·
`use-monthly-growth` (the monthly comparison timeline — one `orders_kpis` call
per month per team through `orderKpisQuery`, combined with the historical
baseline).

### Orders

`use-orders-list-filters` · `use-orders-list-data` (paginated page fetch with
`keepPreviousData`, the `orders_kpi_summary` RPC, per-row enrichment) ·
`use-orders-mutations` · `use-orders-export` · `use-orders-scroll-restoration` ·
`use-starred-orders` (per-agent stars, localStorage keyed by user id) ·
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

Telesales and Customer Care side by side, then the combined total, in the exact
format currently sent by hand. Rendered twice from one `DailyReport` value: the
cards on screen and the plain text in the copy box, so the message and the
preview cannot drift.

The text is deliberately not Markdown — WhatsApp renders `*bold*` and swallows
stray asterisks, so anything that looked like formatting would arrive as either
formatting or debris. `__tests__/daily.test.ts` pins the output byte for byte
against the report it replaces.

Four queries, two per team: `orders_kpis` and the Calls module's own analytics,
both keyed under the namespaces those modules already use, so a window the
Dashboard or a Calls page has loaded is a cache hit rather than a second fetch.

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

Executive KPIs → team performance → Cash vs Wasfaty → Delivery vs Store Pickup →
sales trend → call centre → branch and geography.

It reuses **`useDashboardData` wholesale** rather than reimplementing it, which is
the load-bearing decision: that hook already fetches, for one window and under
`queryKeys.dashboard.*`, every aggregation this report needs. The report and the
dashboard cannot disagree because they read the same cache entries. Two extra
`orders_kpis` calls sit on top, one per team, because the team comparison needs
Cash and Wasfaty per team and `orders_teams` carries only sales and a completion
rate.

Percentages divide by the population they are read against — the two teams'
contributions against the month's completed sales, Cash and Wasfaty against their
own pair's sum — so each set reaches 100 rather than nearly 100. Trend highlights
exclude days that never traded and count them separately: a public holiday is not
the month's worst trading day, and letting it take that label buries the day that
genuinely underperformed.

One chart, `lazy()`-loaded. Recharts is the largest dependency the app ships and
the Daily Report — which is what the page opens on — has no chart in it at all.

The reference workbook (`Shams Call Center June Sales.xlsx`) informed **which**
KPIs are worth showing and nothing else. It is not recreated, converted or
imported; its eleven sheets were mostly working-out, and the portal does the
working-out.

### PDF export

`window.print()`, the same as the Calls pages: the browser's own PDF writer
renders what is on screen and `print:` utilities drop the controls. The daily
report gets a **separate print rendering** — one table instead of two cards and a
textarea, because a textarea prints as a grey box with a scrollbar.

---

## Orders Module

**Routes:** `/orders`, `/orders/new`, `/orders/$id`

### List

Server-side pagination (`range` + `count`), `keepPreviousData` so a filter change
never blanks the table, and a single `orders_kpi_summary` RPC for the KPI strip.
Filters: date range, team, agent, status, **fulfillment**, "mine only", free-text
search. Page size (25/50/100) persists at `orders.pageSize`.

One twelve-column table at every width, scrolled sideways below `min-w: 1240`.
Three of those columns carry state rather than a field:

- **Verified** (col 1) — the `call_center_verified` checkbox, a 3px `bg-primary`
  rail down the row's left edge, and the row tint `--tint-row`. One state, one
  set of styles, both themes. Light mode tinted at 6% turquoise over a white
  card, which was invisible without a second row to compare against; it is 15%
  now — the row composites to `#dcf5f5`, body text 14.5:1 and muted text 5.2:1 —
  matching what dark mode already did at 12% over a dark surface (`#13313a`,
  unchanged).
- **Star** (col 2) — `useStarredOrders`, below.
- **Invoice No.** — every invoice on the order, one per line
  (`components/invoice-cell`). It used to show the first with a "+2" pill, which
  hid the numbers agents reconcile against all day. The column is sized for a
  six-digit number, so extra invoices grow the row's height, not the table's
  width. Deliberately no copy button: invoice numbers are copied continuously,
  and a hover affordance on every row of the most-read column was noise.

### Starred orders

`hooks/use-starred-orders` — one agent's shortcut list, keyed
`milaserv.orders.starred.<user id>` in localStorage. Same reasoning as the branch
directory's favourites (`features/branches/hooks/use-branch-prefs`): nobody
reports on them, nobody else may read them, and losing one costs a re-star, so a
table would buy a migration, RLS policies and a write round trip per click for
nothing. **The user id in the key is load-bearing** — the call floor shares
machines, and an unkeyed list would show one agent another's stars on the next
sign-in. Hydrated in an effect keyed on the user id, never during render (this
app server-renders). Consequence: stars are per browser, so an agent signing in
on a second machine starts with none.

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
`status`.

### Writes

`useOrdersMutations` enforces `canEditOrder` = `edit_all_orders` OR
(own AND `edit_orders`), and `canVerifyOrder` = `verify_all_orders` OR
(own AND `verify_own_orders`) — mirroring `prevent_order_reassignment` in the
database. Every write invalidates both `orders.all()` and `dashboard.all()`.

### Display numbering

`display_no` is a plain `#<seq>`; `formatOrderNo(team, displayNo)` renders it as
`CC-…` or `TS-…`. `stripOrderPrefix` reverses that for search.

### Activity

`order_activity` rows are written by trigger and rendered by
`OrderActivityTimeline`, formatted in `Asia/Riyadh`.

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
- _Read._ PostgREST caps a response at 1,000 rows, so the same month is fifteen
  sequential `.range()` walks on every cold isolate. Days partition the rows
  exactly, so `readCdrDays` splits the window into `READ_DAY_GROUP = 8`-day
  groups and reads them concurrently; each still pages itself, and the groups are
  disjoint by construction.

`pooled` stops taking new work on the first failure and re-throws it once the
workers already in flight have settled — rejecting on the spot would leave the
others running unobserved and surface a later rejection as an unhandled one.

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
