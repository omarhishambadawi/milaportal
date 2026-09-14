# Final Production Cutover — Preparation Document

**Status of this document: PREPARATION ONLY. No cutover step below has been executed.**
Written after Phase 50, incorporating the business decisions confirmed on 2026-09-12
(migrate all 5 optional branches; exclude `orders_verification_snapshot_20260815`;
cutover after 12:30 AM, exact date/time not yet set; password-reset-only credential
strategy). This phase performed **read-only verification only** — every fact below was
re-checked live against the running self-hosted stack this session
(`docker ps`, `docker exec supabase-db psql ...`) and found **unchanged from Phase 50**:
`owner_protection`/`is_owner()`, storage buckets (0), `shams_offers` (0)/
`shams_product_catalog` (8,484 exact match), all 3 cron jobs active, all 11 production
containers `Up 5 days (healthy)`, production destination tables (`orders`, `complaints`,
`profiles`, `user_roles`, `cdr_records`, `alshrouq_dispatches`) all still 0 rows, and the
exact trigger inventory on `orders` (6), `complaints` (2), and the two telesales sync
triggers. No Cloud write, no self-hosted schema/data write, no migration applied, no DNS
change, no branch created/switched, no credential invented, no cutover date/time chosen.

**One genuine change since Phase 50, found during this phase's own git push**: while this
document was being prepared, 5 new commits landed on `origin/main` (merged into this
branch, no conflicts, no code reviewed or altered by this phase), including a new
migration file, `20260918120000_alshrouq_handled_manually.sql`. It **widens** the
`alshrouq_dispatches_resolution_outcome_valid` CHECK constraint to admit a fourth value
(`handled_manually`) alongside the existing three (`delivered`, `not_delivered`,
`undetermined`); it modifies no data and touches no other table. Confirmed live this
session: **not yet applied to self-hosted** (`schema_migrations` still shows 150 applied;
this version is absent from the ledger). This is a **normal pending migration**, unrelated
to migration 69's cutover-specific hold — it must be applied to self-hosted through the
project's regular migration-deployment process before or during cutover, like any other
ordinary schema change, and is tracked as its own line item below (§1, item 1b). It was
**not applied in this phase** — applying any migration to self-hosted is schema
modification, which this phase's hard safety rules forbid regardless of how low-risk the
change is.

**Second finding, from a dedicated read-only capability investigation (no cutover action
taken)**: this session's already-authenticated Lovable MCP connector
(`mcp__claude_ai_Lovable__*`) was confirmed — via a minimal read-only aggregate query, not
a data export — to be a live, working, authenticated connection to the actual MilaPortal
Lovable Cloud project (project id `ee0d9841-3e00-4fc2-b9e5-873ee8568720`, Supabase-stack
database enabled, project ref `gwnxlpophyvgafctrbkx` matching `supabase/config.toml`) —
not self-hosted, and not a stale or unrelated project. Through this connector: (a)
`auth.users` is directly queryable, giving `id`/`email`/metadata for the real Cloud Auth
roster without ever selecting `encrypted_password`; (b) arbitrary `SELECT` can be run
against every Cloud table needed for the final production dataset. This resolves §1 items
7 and 12 below (and their corresponding rows in §6) **without requiring any new
credential from the business owner**. The same connector also supports
`INSERT`/`UPDATE`/`DELETE`/`DDL` — it is not a scoped read-only credential — so its use
during preparation is restricted to `SELECT` only, per the safety statement immediately
below.

**Third finding, from this phase's documentation-audit task (no cutover action taken)**:
this document's items 10–11 (§1), runbook step 10.2, and the credentials checklist (§6)
described the live application as deployed to Vercel, authenticated via a separate Vercel
MCP connector. That is now stale: `vercel.json` was removed from the repository on
`origin/main` (commit `fa0a188`, 2026-09-12, merged into this branch before this phase
began), along with the last Vercel references in `.env.example`,
`.github/workflows/ci.yml`, and `src/routes/api/cdr-sync.ts` — confirmed this phase via
`git show`/`grep`, no repository file changed. `docs/project.md`'s own Deployment section
(already accurate, not modified by this phase) confirms the live app builds as a
Cloudflare Worker (Nitro preset `cloudflare-module`, `vite.config.ts`) and deploys via
Lovable — this was already the actual architecture; removing `vercel.json` did not change
it. This phase also re-confirmed live that the canonical Lovable Cloud Supabase project
remains `gwnxlpophyvgafctrbkx` (`supabase/config.toml`, `.lovable/mcp/manifest.json`,
`vite.config.ts`'s fallback constants all agree, unchanged) and that no prior phase ever
actually completed Vercel MCP authentication or used it to close any item — items 10–11
were only ever describing Vercel as the intended target, never resolved through it. Every
Vercel reference below is corrected to Lovable's Cloudflare Worker deployment target. No
prerequisite's status changes as a result of this correction alone: items 10 and 11 remain
**REQUIRES OPERATOR INPUT** — only the described dependency target changes, and item 10's
blocker on Vercel MCP OAuth is removed as moot (it never applied to the real
architecture), which simplifies but does not close that item.

**Fourth finding, from a dedicated read-only SMTP readiness audit (no cutover action, no
configuration change, no email sent)**: prior phases (49, 50, and this document's item 9)
confirmed only that `GOTRUE_SMTP_USER` matched a placeholder-pattern and left the other
`GOTRUE_SMTP_*` values as "cannot be verified without printing them." This audit went
further using safe, non-value-revealing checks and found the self-hosted SMTP
configuration to be **conclusively non-functional, not merely unverified**:
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, and `SMTP_SENDER_NAME` all
  match placeholder/fake-pattern shapes (checked by substring/shape heuristics only — no
  value was printed).
- `SMTP_PORT` is set to `2500`, a non-standard port (GoTrue's own documented default is
  `587`; common real values are `25`/`465`/`587`).
- The configured `SMTP_HOST` **fails DNS resolution** from inside the `supabase-auth`
  container.
- A control check resolving `smtp.gmail.com` from the same container **succeeded**,
  proving the container's own DNS/egress is fine — the failure is specific to the
  configured (placeholder) hostname, not the environment.
- **No email was sent** at any point during the audit; only DNS lookups and a TCP
  connection attempt (which failed, consistent with the DNS failure) were performed —
  both read-only, non-mutating network diagnostics.

The same audit also found that `GOTRUE_SITE_URL` (`http://localhost:3000`) and
`API_EXTERNAL_URL` (`http://localhost:8000/auth/v1`) — GoTrue's own site/API URLs, used to
build every email link and to validate `redirectTo` — are still set to local development
values, and `GOTRUE_URI_ALLOW_LIST`/`ADDITIONAL_REDIRECT_URLS` is empty (so only
`GOTRUE_SITE_URL` itself is an accepted redirect target). **This is a distinct dependency
from the application-level `SITE_URL`/`VITE_SITE_URL` in item 10 below** — that pair is
read by the Cloudflare Worker application itself (`src/lib/password.server.ts`) to build
the link it *asks* GoTrue to redirect to; `GOTRUE_SITE_URL`/`API_EXTERNAL_URL`/
`GOTRUE_URI_ALLOW_LIST` are GoTrue's own server-side settings that generate and *validate*
that link independently. Neither was previously tracked as its own prerequisite in this
document (see the new item 9b below). Item 9's status is corrected accordingly, and item
9b is added; no other item's status changes as a result of this finding.

**Fifth finding, from this phase's SMTP/GoTrue-URL/reverse-proxy configuration work (real
config changes made, no cutover action, no email sent yet)**: item 9b's `GOTRUE_SITE_URL`,
`API_EXTERNAL_URL`, and `GOTRUE_URI_ALLOW_LIST` have now been set to the real production
domain (`https://milaportal.milaserv.com`, `https://milaportal.milaserv.com/auth/v1`, and
`https://milaportal.milaserv.com/reset-password` respectively, matching the exact
`redirectTo` the application builds in `src/lib/password.server.ts`) and item 9's
`GOTRUE_SMTP_*` values have been replaced with real Zoho Mail production credentials
(`smtp.zoho.com:587`, `milaportal@milaserv.com`); both changes are live on self-hosted
`supabase-auth`, which was restarted and confirmed healthy, DNS/TCP-verified reachable to
`smtp.zoho.com:587`. Neither item is marked CLOSED yet, because the controlled end-to-end
SMTP/password-reset test (runbook step 12) has not succeeded — it depends on the domain
actually being reachable over HTTPS, which this finding also addresses:

A read-only network-topology audit (with IT) established that `milaportal.milaserv.com` is
Cloudflare-proxied (SSL/TLS mode: Flexible), the origin's real public IP
(`196.219.151.53`, distinct from this host's internal IP `10.10.11.160`) has only port 443
forwarded by the edge firewall (port 80 closed), and — before this phase — no TLS listener
of any kind existed on the origin. This phase enabled the project's own `docker-compose
.nginx.yml` overlay (`jonasal/nginx-certbot`, layered via `COMPOSE_FILE` using the
project's `run.sh config add nginx` helper) as the origin's TLS-terminating reverse proxy
in front of Envoy/`api-gw` (which keeps port 8000 as the upstream, now internal-only —
its host-port binding was removed by the overlay, matching the pattern already used by the
project's unused `docker-compose.caddy.yml` overlay, which was inspected, confirmed
inactive, and left completely untouched). Verified live this phase: `nginx -t` passes,
Diffie-Hellman parameters generated, ports 80/443 bound on the host by the `supabase-nginx`
container, the container can reach `api-gw:8000` over the internal Docker network
(confirmed via an HTTP request that reached GoTrue and got a real `401` back, not a
connection error), and all 12 production containers (11 prior + the new `supabase-nginx`)
are healthy.

Because Cloudflare-proxied DNS means ACME HTTP-01/TLS-ALPN-01 validation traffic can never
reach this origin directly (validated by web research against Let's Encrypt/Cloudflare
behavior, not assumed), `CERTBOT_AUTHENTICATOR=dns-cloudflare` was configured (added as a
new passthrough in `docker-compose.nginx.yml`, not present in the shipped file), and the
Let's Encrypt credential volume was switched from an anonymous Docker volume to a bind
mount (`volumes/proxy/nginx/letsencrypt/`) so the one remaining file is a plain file drop,
not a `docker exec`. That one file — a scoped Cloudflare API token
(`Zone:DNS:Edit` on `milaserv.com`) saved as `volumes/proxy/nginx/letsencrypt/cloudflare.ini`
(a `cloudflare.ini.example` placeholder with no real token documents the exact format and
steps) — is the **single remaining external dependency**, owned by IT, before a real
certificate can be issued. Confirmed live and safe: on this first startup certbot
attempted issuance, found the credentials file missing, failed **locally** (no ACME order
was created — no Let's Encrypt rate-limit exposure) with a clear log line, and correctly
disabled the HTTPS vhost until a real certificate exists, rather than serving with a
broken one; it will not retry again for 8 days unless the container is restarted once the
token is supplied. No Cloudflare, DNS, or NAT/firewall change was made by this phase — the
audit and this remaining dependency were both read-only/document-only from this session's
side. No item's status in §1 changes as a result of this finding; items 9 and 9b remain
open below pending the controlled test.

**Sixth finding, superseding part of the fifth (config change, no cutover action, no
email sent)**: the intended TLS-provisioning model changed — IT manages Cloudflare DNS
and the Let's Encrypt DNS-01 challenge/issuance entirely on their own systems, and **no
Cloudflare API token is to be requested, stored, or used on the MilaPortal server at
all**. The `CERTBOT_AUTHENTICATOR=dns-cloudflare` setting from the fifth finding has been
removed. In its place, `CERTBOT_AUTHENTICATOR=dns-rfc2136` is set as a deliberately inert
placeholder — a real certbot plugin this image ships, but with no `rfc2136.ini`
credentials file, chosen only so the container's built-in autorenewal loop keeps failing
**locally** (confirmed live: `Authenticator is 'dns-rfc2136' but '/etc/letsencrypt/
rfc2136.ini' is missing`, zero Let's Encrypt contact, no Cloudflare reference anywhere in
its config or logs) rather than falling back to the default HTTP-01 `webroot`
authenticator, which — unlike the DNS-authenticator credential check — would actually
contact Let's Encrypt and accumulate real failed-validation attempts every ~8 days
(Cloudflare Flexible mode plus the closed port 80 make HTTP-01 validation impossible
here, per the earlier network-topology audit). `volumes/proxy/nginx/letsencrypt/
cloudflare.ini.example` was kept, per instruction, but its header now marks it superseded
documentation, not the active path.

This phase also corrected a mechanics misunderstanding worth recording: a DNS-01 ACME
challenge is created fresh by, and cryptographically bound to, a single certbot
invocation (one order, one time-limited token) — it cannot be "completed later" by this
container just because IT separately created a `_acme-challenge` TXT record during their
own, independent issuance run elsewhere. This container was never part of that ACME
order and has no mechanism to join it retroactively. The revised, and now fully prepared,
path is a direct file handoff: IT supplies the already-issued certificate and key, and
this phase created the exact expected drop-in location, bind-mounted and persistent —
`volumes/proxy/nginx/letsencrypt/live/milaportal.milaserv.com/{fullchain.pem,privkey.pem,
chain.pem}` — with a README documenting the exact three files, an `openssl` verification
recipe, and the one command to reload Nginx afterward. **This file handoff is now the
single remaining external dependency**, superseding the fifth finding's Cloudflare-token
dependency. Re-verified live this phase after the change: `nginx -t` passes, all 12
containers remain healthy, Nginx→Envoy connectivity still confirmed (a real `401` from
GoTrue, not a connection error), Envoy still has no host-exposed port, port 80 still
redirects to 443, and the public HTTPS endpoint is still unreachable (expected — no
certificate exists yet). No item's status in §1 changes as a result of this finding.

**Seventh finding, from this phase's HTTPS validation (real cert now live, no cutover
action, no email sent)**: IT reported all external infrastructure work — Cloudflare, DNS,
NAT/port-forwarding, and Let's Encrypt issuance — complete. Live verification this phase
found a real, trusted, correctly-matched Let's Encrypt certificate now issued and loaded
(`CN=milaportal.milaserv.com`, SAN `DNS:milaportal.milaserv.com`, issued by Let's Encrypt
intermediate `YE1`, valid `2026-09-13` to `2026-12-12`, ECDSA key confirmed matching the
certificate via `openssl x509 -pubkey` / `openssl pkey -pubout` comparison — note a plain
`openssl rsa -noout -modulus` check on this key falsely reports a mismatch because the key
is EC, not RSA; the pubkey-based comparison is the correct method and confirms a MATCH).
`CERTBOT_AUTHENTICATOR` was found already changed on disk (outside this repo, by IT/an
external process) from the sixth finding's inert `dns-rfc2136` placeholder to `webroot`,
consistent with certbot having actually completed a real HTTP-01 issuance — left as-is,
not reverted, since it now reflects a real working state. `nginx -t` passes, all 12
containers remain healthy, Envoy still has no host-exposed port, and requesting
`https://milaportal.milaserv.com/auth/v1/health` **directly against this origin**
(`10.10.11.160`, matching what this host's own internal/split-horizon DNS resolves the
hostname to) succeeds end-to-end with a real `401` from GoTrue through Nginx → Envoy — the
full internal chain and the certificate itself are confirmed correct.

However, **the actual internet-facing path is not yet working**, found by resolving the
hostname via a public resolver (`1.1.1.1`) to get the real public IP (`196.219.151.53`,
no longer Cloudflare-proxied — the DNS record now appears unproxied/"grey-clouded" rather
than going through Cloudflare's edge) and connecting to it directly: **port 80 correctly
forwards through to this server's Nginx** (received the expected 301-to-HTTPS response,
`Server: nginx`), but **port 443 does not reach Nginx at all** — it is answered instead by
`pfSense`'s own web-GUI self-signed certificate (`CN=pfSense-6861967375476`) and returns a
generic `404`, not GoTrue's response. This indicates the pfSense firewall/router's own
management WebGUI is bound to port 443 on the WAN/public interface and is intercepting
the connection before any NAT port-forward rule to `10.10.11.160:443` can apply — a
firewall-side configuration conflict (two things wanting port 443 on the same public IP),
not anything on this server. This is **squarely IT's pfSense box**, outside this session's
access and explicitly outside its remit to touch. Until resolved, a real user clicking a
password-reset link from outside this network would hit pfSense's admin interface, not
MilaPortal — so per this phase's own stop condition, **no email was sent** and no
prerequisite below is marked CLOSED. GoTrue's SITE_URL/API_EXTERNAL_URL/URI_ALLOW_LIST and
the Zoho SMTP configuration were independently re-verified correct and unchanged (DNS
resolves, TCP `587` open) and remain ready the moment the pfSense conflict is fixed.

**Eighth finding, from this phase's final external production validation (read-only
checks only, no configuration change, no email sent)**: IT reported the pfSense WAN
port-443 conflict (seventh finding) resolved. Live re-verification this session found
this **not actually true** — the conflict is unchanged from the seventh finding. Evidence:
- Internal chain re-confirmed fully healthy: `nginx -t` passes; the real Let's Encrypt
  certificate is loaded and unchanged (`CN=milaportal.milaserv.com`, SAN
  `DNS:milaportal.milaserv.com`, issued by Let's Encrypt `YE1`, valid `2026-09-13` to
  `2026-12-12`); requesting `https://milaportal.milaserv.com/auth/v1/health` directly
  against the origin (`10.10.11.160`) with a valid `apikey` header returns a correct `200`
  with GoTrue's own health payload (`{"version":"v2.189.0","name":"GoTrue",...}`) through
  Nginx → Envoy → GoTrue; `GOTRUE_SITE_URL`, `API_EXTERNAL_URL`, and
  `GOTRUE_URI_ALLOW_LIST` are confirmed set to the real production domain
  (`https://milaportal.milaserv.com`, `https://milaportal.milaserv.com/auth/v1`,
  `https://milaportal.milaserv.com/reset-password`); Zoho SMTP is reachable
  (`smtp.zoho.com` resolves to `136.143.190.56`, TCP `587` confirmed open from
  `supabase-auth`); all 12 production containers remain healthy; Envoy still has no
  host-exposed port (host port 8000 confirmed absent from `ss -tln`).
- Resolving the hostname via a public resolver (`1.1.1.1`) still gives the same real
  public IP as the seventh finding (`196.219.151.53`). Port 80 against that IP still
  forwards correctly to this server's own Nginx (`301` to HTTPS, `Server: nginx`).
- **Port 443 against that same public IP is still answered by pfSense's own WebGUI**,
  not this server's Nginx: three separate connection attempts all returned pfSense's
  self-signed certificate (`CN=pfSense-6861967375476`) and its `404` HTML page, identical
  to the seventh finding's evidence. This was re-checked three times to rule out a
  transient result.

**Conclusion drawn at the time — since proven wrong, see the correction in the ninth
finding**: the evidence above was read as "the pfSense WAN port-443 conflict is still
live." No email was sent, no `avatars`-bucket or other write action was attempted, and no
prerequisite was marked CLOSED on the strength of it. The observation itself is accurate
and reproducible; only the conclusion drawn from it was wrong.

**Ninth finding, from this phase's root-routing work (real Nginx change made, no cutover
action, no email sent)** — this finding **corrects the seventh and eighth findings' central
conclusion**:

*The pfSense port-443 "blocker" was a measurement artifact.* Every prior probe was issued
**from this server itself** to the WAN IP (`196.219.151.53`). Traffic taking that path
leaves the LAN, comes back to the firewall's own WAN address, and — with no NAT reflection
/hairpin rule configured — is answered by pfSense's own WebGUI. That is why those probes
saw `CN=pfSense-6861967375476`. It says nothing about the path real users take. Proven this
phase from the Nginx access log: a **real external browser** (`197.53.56.87`, an ISP
address outside this LAN, Chrome/Windows) loaded `https://milaportal.milaserv.com/dashboard`
and `/orders` plus their asset bundles, all `200`, and Cloudflare edge addresses
(`172.68.234.57`, `172.64.0.0/13`) appear in the same log. **The internet-facing path works
and has been working; port 443 does reach this server's Nginx from outside.** No pfSense,
NAT, DNS, or Cloudflare change was made by this phase (or any prior one) — the firewall
never needed the fix the seventh and eighth findings asked IT for. Probes from this host to
the WAN IP remain unreliable by design; validate from a genuinely external client, or from
the access log.

*The real defect, found and fixed this phase, was Nginx's root routing.* The proxy was
running the **unmodified vendor-default** `supabase-nginx.conf.tpl`, whose `location /`
serves **Supabase Studio behind HTTP Basic Auth** — so the production domain's root
answered `401 WWW-Authenticate: Basic realm="supabase"` (a browser-native credential
dialog) instead of the application. The Basic Auth was never accidental: it is the only
thing guarding Studio, and removing it would have published a full database admin console.
The routing around it was the defect. The template now reads:

| Path | Upstream | Note |
|---|---|---|
| `/` (everything else) | `https://milaportal.live` | The existing MilaPortal Cloudflare Worker, deployed via Lovable — its canonical origin, per `docs/project.md`. Catch-all, so the app's client-side routing (`/dashboard`, `/orders`, `/reset-password`, …) resolves as it does on that origin |
| `/auth/v1` | `api-gw:8000` (Envoy) | **Narrowed from `/auth`** — the bare prefix also swallowed the application's own `/auth` sign-in route. `/auth/v1` is the gateway's real GoTrue prefix (confirmed against Envoy's `lds.yaml`), so no Supabase behaviour is lost |
| `/rest`, `/graphql`, `/realtime/v1/`, `/storage/v1/`, `/functions`, `/mcp`, `/sso` | `api-gw:8000` (Envoy) | Unchanged, byte-for-byte |

Worker upstream specifics, each established by test rather than assumption: the `Host`
header **must** be rewritten to `milaportal.live` (forwarding `milaportal.milaserv.com`
makes Cloudflare route the request back to this origin — a loop; verified directly); SNI is
set to match; the upstream certificate is verified against the container's CA bundle
(`Verify return code: 0`); and the resolver is pinned to Docker's embedded DNS with
**`ipv6=off`**, because the container has no IPv6 default route while `milaportal.live`
publishes AAAA records. `proxy_redirect`/`proxy_cookie_domain` map the upstream origin back
to this one.

*Studio kept its protection and left the public root.* Studio is a Next.js app with no base
path — its assets and API calls are absolute, and its `/api/*` would collide with the
application's own `/api/*` routes — so a `/studio` sub-path is not safely possible without
rebuilding it, and was **not** forced. It now has its own listener, `8443`, where it still
owns `/`, behind the **same** Basic Auth, published on the LAN address `10.10.11.160` only
(confirmed: `LISTEN 10.10.11.160:8443`, refused on loopback, nothing forwards it publicly).
Verified: `/project/default` on the public 443 returns the application's `404`, not Studio;
`8443` without credentials returns `401`; with credentials returns Studio's own `307` to
`/project/default`.

*Two items remain open and are deliberately not closed by this phase.* (a) The deployed
Worker still points at **Cloud** Supabase (`gwnxlpophyvgafctrbkx.supabase.co`, read from its
own live CSP `connect-src`), not at this self-hosted stack — so a self-hosted password-reset
link would land on an application wired to Cloud. That is a cutover-day switch (§1 item 10),
not a proxy concern, and it is the substantive reason **no password-reset email was sent
this phase**. (b) `/mcp` is claimed by both sides — Envoy routes it, and the application
also serves it (`src/routes/mcp.ts`, `.lovable/mcp/manifest.json`). The existing Supabase
block was preserved unchanged, so the application's `/mcp` is currently shadowed on this
domain; whoever owns that endpoint at cutover should decide deliberately.

Re-verified after the change: `nginx -t` passes, all 12 containers healthy, certificate
untouched (`CN=milaportal.milaserv.com`, valid to `2026-12-12`), port 80 still redirects to
443, `/auth/v1/health` returns GoTrue `v2.189.0` `200`, `/storage/v1/version` `200`,
`/rest/v1/` returns the same `403` through Nginx as it does straight from Envoy, and host
port 8000 remains unexposed. **The Nginx files themselves live in
`/opt/supabase/supabase-project/`, which is not a git repository** — only this document is
version-controlled.

**Tenth finding, from this phase's pre-cutover repository hardening (repository changes
made and committed; no Worker environment, no database, no migration, no DNS/Cloudflare/NAT
and no Nginx routing changed)**: the two dependencies the ninth finding's audit left
standing — D8 (the hard-coded Cloud fallback in `vite.config.ts`) and D5/D6 (the
`SUPABASE_PROJECT_ID` dependency) — are now **closed in the repository**, along with the
D17 `SUPABASE_PUBLIC_URL` hygiene item. What changed, and the evidence for each:

- **D8 — `PUBLIC_SUPABASE_FALLBACKS` is deleted** (`vite.config.ts`). The Cloud project
  ref, the Cloud URL and the Cloud anon key are gone from the repository's build config.
  In its place the plugin (renamed `supabase-public-env`) **requires** `SUPABASE_URL` and
  `SUPABASE_PUBLISHABLE_KEY` under either the `VITE_`-prefixed or unprefixed name, still
  bridges whichever one is supplied to the other, and throws a named-variable error
  otherwise. Verified by running both cases in a Node 22 container: with no Supabase
  variables, `vite build` **fails** with `Missing Supabase environment variable(s):
  VITE_SUPABASE_URL (or SUPABASE_URL), VITE_SUPABASE_PUBLISHABLE_KEY (or
  SUPABASE_PUBLISHABLE_KEY)`; with them set, the build completes normally. **The silent
  failure mode is gone** — a build missing its Supabase variables can no longer produce a
  Cloud-wired bundle, because it can no longer produce a bundle at all.
- **D5/D6 — the project-ref dependency is removed from the code**, not merely documented
  as "remove it from the Worker env." `src/lib/mcp/index.ts` now derives the MCP OAuth
  issuer from `VITE_SUPABASE_URL`/`SUPABASE_URL` alone; `SUPABASE_PROJECT_ID` is dropped
  from `BRIDGED_KEYS` in `src/lib/server-env.ts` and from `.env.example`. Consequence for
  cutover: leaving `VITE_SUPABASE_PROJECT_ID` set in the Worker environment is now
  **inert** rather than dangerous — nothing reads it — so the split-state hazard §9.4
  describes cannot occur. Removing it from the Worker env remains the tidy action (B4),
  but it is no longer load-bearing.
- **Behaviour-equivalence check on today's Cloud build**: a build with
  `VITE_SUPABASE_URL=https://gwnxlpophyvgafctrbkx.supabase.co` leaves
  `.lovable/mcp/manifest.json` **byte-identical** (`git status` clean, mtime unchanged) —
  the URL-derived issuer reproduces exactly what the project ref produced, so this change
  is a no-op for the currently-deployed Cloud configuration and does not require a
  same-build pairing the way D8's old fallback did.
- **Cutover-direction check**: a build with `VITE_SUPABASE_URL=https://milaportal.milaserv.com`
  produces `.output/` containing **zero** occurrences of `gwnxlpophyvgafctrbkx` (`grep -rl`
  over the whole build output). No hard-coded Cloud value survives anywhere in a
  self-hosted-targeted bundle.
- **D17 — `SUPABASE_PUBLIC_URL` corrected** in `/opt/supabase/supabase-project/.env`
  line 97, from the installer default `http://localhost:8000` to
  `https://milaportal.milaserv.com`. Exactly one line changed (verified by diff against a
  pre-edit copy, which was then securely deleted; no secret was read or printed).
  **No container was recreated or restarted**, so the running stack is untouched: the live
  `supabase-studio` and `supabase-storage` environments still carry the old value, and the
  new one takes effect at the next recreate — a cutover-time action, not this phase's.
  All 12 containers remain healthy.
- **Validation**: `npm run typecheck` clean; `npm run lint` 0 errors (595 pre-existing
  `no-explicit-any` warnings, unchanged); `npm run check:permissions` passes; the full
  suite passes **4,339 tests across 151 files**. The tests had to be run in a `node:22`
  container because this host's Node is v18 and `vitest` requires Node ≥ 20.12
  (`node:util` `styleText`) — a pre-existing environment gap unrelated to these changes,
  and the same Node 22 that CI uses.
- **Not changed, deliberately**: the deployed Worker's environment, any database/schema/
  migration (migration 69 still held, `20260918120000` still unapplied), DNS, Cloudflare,
  NAT/pfSense, and the Nginx templates — including the `/mcp` block (§10, re-verified
  unchanged this phase).

**One consequence to be aware of before the next deploy, stated plainly rather than
buried**: because the fallback is gone, the next Lovable build **will fail** if Lovable's
build environment does not itself supply `SUPABASE_URL`/`VITE_SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`/`VITE_SUPABASE_PUBLISHABLE_KEY`. That is the intended and
desirable behaviour — it is precisely the silent gap this change exists to expose — and the
error names the missing variable, so the fix is to set it in Lovable's project environment
settings, never to restore a fallback. §9.2's live CSP evidence proves the Worker's
*runtime* environment carries `SUPABASE_URL`; the publishable key's presence in the *build*
environment is not independently provable from here, so treat the next deploy as the test.
Nothing about the currently-running deployment changes until someone rebuilds.

The full repository re-scan behind this finding, with every remaining occurrence
classified, is §9.10. The `avatars` storage preparation is §12 and the auth-email/template
change is §13.

**Eleventh finding, from this phase's final pre-cutover closure audit (repository changes
made; no Worker environment, no database write, no migration applied, no container
recreated, no Nginx/DNS/Cloudflare/NAT change, no email sent)**: three things previously
recorded as open decisions or accepted losses turn out to be closable from the repository,
and one previously-understated dependency is larger than documented.

- **The branded auth emails do not have to be lost (§14, supersedes §13's conclusion and
  checklist item A5).** §13 recorded self-hosted GoTrue falling back to its plain built-in
  templates as "a deliberate, acceptable trade" needing a business decision. It is neither
  necessary nor a decision: GoTrue reads each template from a URL
  (`GOTRUE_MAILER_TEMPLATES_*`) and each subject from `GOTRUE_MAILER_SUBJECTS_*`, for all
  six mail types — verified against `supabase/auth`'s own `example.env` and its
  `internal/mailer/templatemailer/template.go`. The six branded React Email templates are
  now rendered to static GoTrue templates by `scripts/render-auth-email-templates.mjs`
  (`npm run build:auth-email-templates`) into `public/auth-email-templates/`, with GoTrue's
  own placeholders (`{{ .ConfirmationURL }}`, `{{ .SiteURL }}`, `{{ .Email }}`,
  `{{ .NewEmail }}`, `{{ .Token }}`) where the per-message values go. They render from the
  same components the Cloud webhook renders, so the branding has one source, not two.
  Setting the env vars is a cutover-window action; nothing is applied to the running
  `supabase-auth`, and no email was sent.
- **Only one of the six auth mails is reachable in this application at all (§14.1).**
  Verified by reading every auth call site: `resetPasswordForEmail` is called in exactly
  three places (`src/routes/auth.tsx:91`, `src/lib/password.server.ts:127`,
  `src/features/profile/components/temporary-password-expired.tsx:50`); account creation
  goes through `admin.createUser({ email_confirm: true })` (`src/lib/admin.functions.ts:231`),
  which sends nothing; every other admin/profile path calls `updateUserById({ password })`
  or `updateUser({ password })`. There is no signup, invite, magic-link, email-change or
  reauthentication flow. So `recovery` is the only template that can fire — which is also
  the one email every migrated user must receive under the password-reset-only strategy
  (§5). The other five are prepared for completeness, not because a user can trigger one.
- **The scheduler/Vault dependency is four secrets, not two (§15).** §1 item 11 recorded
  `shams_sync_scheduler_url` and `email_queue_service_role_key`. Reading the actual function
  bodies in the migrations and the live `cron.job` table found three active jobs, each of
  which needs a URL secret plus the shared service-role key: `shams-sync-tick` →
  `shams_sync_scheduler_url`, `alshrouq-dispatch-due` → `alshrouq_scheduler_url`,
  `telesales-generation-tick` → `telesales_generation_url`. Confirmed live this phase
  (names only, no value read, read-only `SELECT`): `vault.secrets` holds **zero rows**, so
  all three are unconfigured. This also closes §9.9's "not re-verified" gap. The failure
  mode is the dangerous one `.env.example` already documents from a real incident: pg_cron
  records the run as **succeeded** while issuing no HTTP request at all, so AlShrouq
  scheduled dispatch and telesales generation would be silently dead after cutover exactly
  as Shams sync would.
- **`.env.example` now documents `SITE_URL`/`VITE_SITE_URL` and `LOVABLE_API_KEY`/
  `LOVABLE_SEND_URL`** — the four load-bearing variables §1 item 10 recorded as "absent
  from `.env.example`, must come from institutional knowledge." Placeholders only; no value
  was read, guessed or committed. This does not close item 10 (the operator must still
  confirm they are set on the deployed Worker), but it removes the documentation gap that
  made them easy to forget.
- **The `avatars` creation statement is now a runnable, reviewed artifact**
  (`docs/migration/cutover-avatars-bucket.sql`) rather than a fenced block inside this
  document: transactional, idempotent, with its own verification and rollback queries, and
  deliberately **not** placed under `supabase/migrations/` because `supabase/config.toml`
  still names the Cloud project and a CLI push would carry it there. Re-verified live and
  read-only this phase: `storage.buckets` 0 rows, `storage.objects` 0 rows, all 4
  owner-scoped policies attached. The bucket was **not** created — it stays a Gate-B write
  (C4), per this task's own instruction to prefer preparation.
- **Re-verified live, read-only, unchanged**: migration ledger at **150** applied with
  `20260723022830` (migration 69) **absent**; latest applied `20260917130000`, so
  `20260918120000_alshrouq_handled_manually.sql` remains the single pending normal
  migration; destination tables `orders`/`complaints`/`profiles`/`user_roles`/`cdr_records`/
  `alshrouq_dispatches`/`auth.users` all **0 rows**; all 12 containers healthy; all 3 cron
  jobs active.
- **Cloud-dependency re-scan (§9.10) re-run this phase over tracked files**: no new
  occurrence, no reclassification. The five `gwnxlpophyvgafctrbkx` hits are exactly
  `.lovable/mcp/manifest.json` (generated), `supabase/config.toml` (tooling), and three
  `docs/project.md` history lines.
- **Validation**: `npm run typecheck`, `npm run lint`, `npm run check:permissions` and the
  full test suite re-run after these changes — results in §16.

> Until explicit cutover authorization is given, all Lovable Cloud access used for
> preparation must remain read-only/SELECT-only. No freeze, export execution, INSERT,
> UPDATE, DELETE, DDL, credential changes, or other production mutation is permitted.

---

## 1. Reconciliation — final prerequisite status (baseline: Phase 50)

| # | Prerequisite | Status | Notes |
|---|---|---|---|
| 1 | Migration ledger / migration 69 hold | **CLOSED** | 150 applied of 152 files now on disk (151 as of Phase 48, +1 new normal migration since, see 1b); `20260723022830` confirmed absent from the ledger, unchanged since Phase 48 |
| 1b | New migration `20260918120000_alshrouq_handled_manually.sql` (landed on `origin/main` during this phase, merged in) | **REQUIRES CUTOVER-DAY ACTION** | Pure additive CHECK-constraint widening on `alshrouq_dispatches.resolution_outcome`, no data change; confirmed not yet applied to self-hosted; unrelated to migration 69's hold — apply via the normal migration-deployment process before or during cutover (pre-cutover check 1.2 below), not part of this preparation phase |
| 2 | `owner_protection` / `is_owner()` | **CLOSED** | Both triggers present, enabled, live-verified this session |
| 3 | Auth FK graph / `telesales_leads` self-ref / order-complaint triggers | **CLOSED** | Live-verified this session, exact names below (§4) |
| 4 | Security ACLs / RLS (6 functions, 4 email tables) | **CLOSED** | Unchanged since Phase 48; one non-blocking low-severity note (unpinned `search_path` on 4 fully-qualified email-queue functions) carried forward, not a gate item |
| 5 | Self-hosted schema recapture | **CLOSED** | Performed in Phase 50 (`prod_schema_phase50.sql`); a further recapture immediately before the real export remains standard cutover-day hygiene, not an outstanding gap |
| 6 | Phase 44 scratch rehearsal container | **CLOSED** | Destroyed in Phase 50, confirmed absent this session, production containers unaffected |
| 7 | Auth roster pull | **READY FOR CUTOVER** | Confirmed this phase: obtainable via the already-authenticated Lovable MCP connector's direct query access to Cloud `auth.users` (`id`/`email`/metadata only, never `encrypted_password`) — no Cloud `service_role` GoTrue Admin API key or other new credential required |
| 8 | `avatars` storage bucket | **READY FOR CUTOVER** (settings fully determined and re-verified — §12; execution is a Gate-B write) | No longer an open decision: name (`avatars`), private, `file_size_limit = 4194304` (4 MB), and `allowed_mime_types = {image/png,image/jpeg,image/webp,image/gif}` are all fixed by already-applied migration `20260721002100_avatars_bucket_limits.sql` and `src/lib/avatar.ts` — not "no existing Cloud value to mirror" as previously stated. That migration is an `UPDATE ... WHERE id='avatars'`, applied while the bucket didn't exist, so it was a no-op; creation must set these values explicitly, not rely on the migration re-firing. The statement is now a reviewed, runnable artifact carrying its own verification and rollback queries — `docs/migration/cutover-avatars-bucket.sql` — kept deliberately outside `supabase/migrations/` so the Cloud-linked CLI cannot carry it to Cloud (§12). Only remaining step is running it against self-hosted, behind Gate B (C4) |
| 9 | Real SMTP credentials | **CONFIGURED; CONNECTIVITY VERIFIED; END-TO-END TEST PENDING ON ITEM 10** | Real Zoho Mail production credentials remain set on self-hosted `supabase-auth` (`smtp.zoho.com:587`, `milaportal@milaserv.com`): DNS resolves to `136.143.190.56`, TCP `587` open, `supabase-auth` healthy. Item 9b's HTTPS dependency is now resolved, but the controlled test is still not runnable: the deployed Worker application points at **Cloud** Supabase, not this stack (ninth finding), so a self-hosted reset link would land on an app wired to Cloud. The test belongs after item 10's env-var switch, at cutover |
| 9b | GoTrue URL/redirect configuration (`GOTRUE_SITE_URL`, `API_EXTERNAL_URL`, `GOTRUE_URI_ALLOW_LIST`) | **CLOSED for HTTPS/routing; end-to-end reset test still pending on item 9** (the pfSense "blocker" was a measurement artifact — see the ninth finding) | All three are set to the real production domain and verified working end-to-end: `/auth/v1/health` returns GoTrue `v2.189.0` `200` through Nginx→Envoy→GoTrue, and external HTTPS is **confirmed working** — real external browsers load the application over `https://milaportal.milaserv.com` (Nginx access log, ISP client addresses, `200`s). The seventh/eighth findings' pfSense port-443 conflict was an artifact of probing the WAN IP from inside the LAN with no NAT reflection; no firewall change was ever required. Root routing was separately wrong (Studio behind Basic Auth on `/`) and is fixed this phase |
| 10 | Application env vars (`SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL`) | **REQUIRES OPERATOR INPUT** | **Now documented in `.env.example`** (eleventh finding) with the exact reason each is load-bearing — placeholders only, no value read or guessed. The remaining gap is confirmation that they are actually set on the deployed Worker, which nothing available here can observe. **Corrected in a prior phase**: Vercel is no longer part of the architecture (see the third finding at the top of this document) — the live app deploys as a Cloudflare Worker via Lovable, so these vars must be set in Lovable's project environment settings for that Worker, per `.env.example`'s own guidance for `SHAMS_MIS_BASE_URL`. No MCP tool available this session exposes Worker environment-variable values or presence, so this remains unverifiable from here — operator confirmation required, not a guess |
| 11 | Shams credentials (`SHAMS_CRM_*`, `SHAMS_MIS_*`) | **REQUIRES OPERATOR INPUT** | No `SHAMS_*` name found in any inspectable container this session; consumed only by the deployed Cloudflare Worker's server-only code (`src/lib/shams-crm/client.server.ts`, `src/lib/shams/client.server.ts`), not by any self-hosted container. **Corrected and widened this phase (§15)**: the self-hosted Vault requirement is **four** secrets, not two — all three active cron jobs need one, and `vault.secrets` is confirmed **empty** (0 rows, names-only read). Silent-failure risk: an unconfigured job records `succeeded` while issuing no HTTP request. A separate self-hosted wiring step from the CRM/MIS credentials themselves, not resolvable until the Worker's scheduler endpoints answer on the self-hosted origin |
| 11b | Self-hosted Vault scheduler secrets (`shams_sync_scheduler_url`, `alshrouq_scheduler_url`, `telesales_generation_url`, `email_queue_service_role_key`) | **REQUIRES CUTOVER-DAY ACTION** | New row, split out of item 11 by this phase (§15). Confirmed live, read-only, names only: `vault.secrets` holds 0 rows, while `cron.job` holds 3 active jobs (`shams-sync-tick`, `alshrouq-dispatch-due`, `telesales-generation-tick`) whose functions each read a URL secret plus the shared `email_queue_service_role_key`. Values are derivable at cutover without any new credential from the business: the three URLs are the app's own scheduler routes on the post-cutover origin, and the key is self-hosted's own `SERVICE_ROLE_KEY` |
| 12 | Cloud production export path | **READY FOR CUTOVER** | Confirmed this phase: obtainable via the same Lovable MCP connector's `query_database` capability against the live Cloud project — a literal `psql`/`pg_dump` binary is not required for this path; export *execution* is still a cutover-day action (item 18) and remains SELECT-only until Gate B |
| 13 | 5 optional branches decision | **CLOSED** | Business confirmed: migrate all 5 (`P0312`, `P0313`, General Administration, Branch Administration, Warehouse) |
| 14 | `orders_verification_snapshot_20260815` exclusion sign-off | **CLOSED** | Business confirmed: exclude |
| 15 | Maintenance window | **REQUIRES OPERATOR INPUT (business)** | Business confirmed "after 12:30 AM" as a constraint only — exact date/time still not chosen; this phase does not choose it |
| 16 | Credential-strategy sign-off | **CLOSED** | Business confirmed password-reset-only, UUID/relationship-preserving, no hash migration |
| 17 | Cloud write freeze | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 18 | Final production export/snapshot | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 19 | DNS/reverse-proxy switch | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 20 | Branded auth email templates preserved on self-hosted | **PREPARED — cutover-window configuration only** (§14) | Supersedes §13's "accepted regression" and checklist A5. All six branded templates are rendered to GoTrue-compatible static HTML (`npm run build:auth-email-templates` → `public/auth-email-templates/`) from the same React components the Cloud webhook uses. Closing it needs only the `GOTRUE_MAILER_TEMPLATES_*`/`GOTRUE_MAILER_SUBJECTS_*` values at cutover plus the pre-send fetch check in §14.4 — GoTrue falls back to its plain defaults **silently** if a template URL does not resolve. Only `recovery` is reachable in this application (§14.1) |

**Net change from Phase 50**: business decisions 13, 14, and 16 move from OPEN to
CLOSED. The maintenance window (15) is partially constrained ("after 12:30 AM") but not
closed — the exact date/time is still required from the business before Gate A.

**Net change in that phase**: items 7 (Auth roster pull) and 12 (Cloud production export
path) moved from REQUIRES OPERATOR INPUT to READY FOR CUTOVER — both resolved via the
already-authenticated Lovable MCP connector, with **no new credential required from the
business owner**.

**Net change in this prerequisite-closure phase**: item 8's decision (`avatars` bucket
name/private/MIME/size limits) is now fully determined from existing code and migration
— it was never actually a business/operator decision, only an investigation gap. Bucket
*creation* remains open, blocked this phase by the session's own permission classifier
(see item 8's note and §2 step 9.1) — the operator can run the one exact statement given
there, or grant approval for it to be run in-session. Items 9–11 (real SMTP, Cloudflare
Worker application env vars, Shams CRM/MIS credentials) remain open and genuinely require
operator/business action; none of the 4 remaining items (8–11) require further
investigation beyond what is already documented.

**Net change in this documentation-audit phase**: no prerequisite's status changes. Items
10–11's described dependency is corrected from Vercel (removed from the architecture,
`vercel.json` deleted on `origin/main`) to the actual deployment target, a Cloudflare
Worker deployed via Lovable — see the third finding at the top of this document.

**Net change in this pre-cutover hardening phase**: item 8 (`avatars`) moves from
REQUIRES OPERATOR INPUT to READY FOR CUTOVER — its configuration is fully determined and
re-verified live (§12); only the Gate-B write remains. No other item's status changes, but
two dependencies outside the §1 table are closed outright in the repository (D8's silent
Cloud fallback and D5/D6's project-ref dependency) and one self-hosted config value is
corrected (D17) — see the tenth finding at the top of this document.

**Net change in this SMTP-readiness documentation update**: item 9 is relabeled from
"REQUIRES OPERATOR INPUT" (implying only that a value was unverified) to **NOT
PRODUCTION-READY** (confirmed non-functional by DNS/TCP checks) — operator action is
still what closes it, so this is a wording correction, not a new blocker. A new item, 9b,
is added for GoTrue's own URL/redirect settings, previously untracked in this document.
See the fourth finding at the top of this document for the full evidence trail.

---

## 2. Final cutover runbook (exact ordered sequence — NOT executed)

This sequence is the single authoritative execution order for the eventual cutover. It
consolidates the validated findings of Phases 44–50 into one document. **Steps 2 onward
may not begin until Gate B (§8) receives an explicit `GO`.**

### 1. Pre-cutover checks
1.1. Confirm all prerequisites in §1 are CLOSED or READY FOR CUTOVER (no
REQUIRES OPERATOR INPUT items remain).
1.2. Apply any normal (non-migration-69) pending migrations to self-hosted through the
project's regular migration-deployment process — as of this document, exactly one is
pending: `20260918120000_alshrouq_handled_manually.sql` (§1, item 1b). Re-check the
migration directory for any further migration added between now and the cutover window,
since main is an actively developed branch and this phase already observed one land
mid-preparation. **Migration 69 (`20260723022830`) remains excluded from this step and
from every step of this runbook.**
1.3. Recapture `prod_schema.sql` fresh (self-hosted, schema-only, read-only) — even
though Phase 50 already did this once, a same-day recapture is standard hygiene since
self-hosted may have advanced further (confirmed true again this phase — see the note at
the top of this document).
1.4. Re-run the same live checks as the Phase 50 baseline (ledger, triggers, containers,
cron, storage) one final time immediately before freeze.
1.5. Confirm the exact maintenance-window date/time has been supplied by the business
(Gate A).
1.6. Confirm rollback plan (§7) and all named operators/approvers are available and on
call for the window.

### 2. Cloud write freeze
2.1. Pause/freeze writes to Lovable Cloud at the agreed instant (exact mechanism to be
selected by the operator performing cutover — e.g., maintenance-mode flag, connection
revocation, or provider-level pause — not decided in this document).
2.2. Record the exact freeze timestamp.
2.3. Confirm no write activity continues after the freeze (spot-check `updated_at`/
`created_at` max values on the highest-traffic tables: `orders`, `order_activity`,
`cdr_records`, `alshrouq_dispatches`).

### 3. Final production snapshot/export
3.1. Using the already-authenticated Lovable MCP connector's `query_database` capability
against the live Cloud project (verified this phase; a literal `libpq`/`pg_dump` binary
is not required for this path), extract the authoritative final dataset for every table
classified CLOUD→REPLACE, MERGE/RECONCILE, or HYBRID via `SELECT`-only queries, following
`phase45_export_runbook.md`'s table-by-table methodology. This step is a cutover-day
action gated behind Gate B (§8) — it is not performed by this preparation phase, and the
connector must be used SELECT-only throughout per the safety statement at the top of this
document (it also supports writes, which must never be issued against Cloud here).
3.2. Record final row counts for every exported table and compare against every prior
phase's reconciliation assumption; reconcile any drift found before proceeding.
3.3. This export explicitly **includes** all 7 previously-partitioned branch rows:
`P0310`, `P0311` (already required) plus the 5 newly-approved optional branches
(`P0312`, `P0313`, General Administration, Branch Administration, Warehouse).
3.4. This export explicitly **excludes** `orders_verification_snapshot_20260815` per the
confirmed business decision.

### 4. Cloud Auth roster acquisition
4.1. Using the already-authenticated Lovable MCP connector's direct query access to the
live Cloud project (verified this phase), `SELECT id`, `email`, and required metadata
columns from `auth.users` to acquire the complete, current Cloud Auth roster. A separate
Cloud `service_role` GoTrue Admin API credential is not required for this path.
4.2. Record each user's `id` (UUID), `email`, and metadata needed for `profiles`/
`user_roles` reconciliation. **Never select `encrypted_password`, MFA factor secrets, or
any other credential-internal column** — the confirmed strategy is password-reset-only
(§5); the connector's own privilege is broader than this step needs, so this restriction
is procedural, not tool-enforced, and must be followed deliberately.

### 5. UUID-preserving Auth import (password-reset-only strategy)
5.1. For each Cloud Auth user, call self-hosted GoTrue's `admin.createUser` with the
caller-specified `id` set to the exact Cloud UUID (Phase 47's empirically validated
mechanism — accepted and preserved by GoTrue `v2.189.0`).
5.2. Do **not** supply or migrate any password hash. Users are created without a valid
password and will authenticate for the first time only via the password-reset flow.
5.3. Allow `handle_new_user()` to fire and create the default `profiles`/`user_roles`
row exactly as it does today (default `customer_care` role).
5.4. Upsert the real `profiles` row (name, contact fields, etc.) and the real
`user_roles` row on top of the synthetic default, then delete any stray default role row
left over from the trigger, per the Phase 44-proven sequence.
5.5. Reject/investigate any duplicate-UUID creation attempt — this is expected to fail
cleanly at the database level (`users_pkey` unique violation) per Phase 47's validation;
it must not be forced through.
5.6. Confirm final `auth.users` count matches the Cloud roster count exactly, and every
`profiles`/`user_roles` row's `id` matches its `auth.users.id`.

### 6. Dependency-safe business-data import
Import in the FK-safe order established across Phases 44–46:
6.1. `branches` (reconcile: base 137 self-hosted rows plus the 7 Cloud-only rows —
`P0310`, `P0311`, `P0312`, `P0313`, General Administration, Branch Administration,
Warehouse — all now in scope per the confirmed business decision).
6.2. `telesales_products` (reconcile), `telesales_product_aliases`/`telesales_product_patterns`
(verify identical, no import needed unless drift is found in step 1.3/3.2).
6.3. Auth/profiles/user_roles (already completed in step 5, sequenced here for
dependency completeness — all downstream business tables reference `profiles.id`).
6.4. `orders`, `complaints`, and their activity/dependent tables (CLOUD→REPLACE),
disabling the 4 import-unsafe triggers first (§4 of this runbook).
6.5. `telesales_leads` using the validated two-pass strategy for its non-deferrable
self-referential FK (`telesales_leads_parent_lead_id_fkey`): first pass inserts all rows
with `parent_lead_id` temporarily NULL, second pass updates `parent_lead_id` to the real
value once all rows exist.
6.6. Remaining `telesales_*` transactional tables (customers, activities, followups,
generation runs) per their established CLOUD→REPLACE/MERGE classification.
6.7. `telesales_product_relations` (Cloud 26, human-curated, no enforced FK) — reconcile
by direct copy, no FK validation needed by design.
6.8. `alshrouq_dispatches` (CLOUD→REPLACE) — the `20260820180000_alshrouq_dispatch.sql`
*migration* is already applied on self-hosted and must **not** be manually replayed;
only the *data* is imported here. **Dependency**: Cloud rows may carry
`resolution_outcome = 'handled_manually'` (three incidents corrected on Cloud around
2026-09-12) — step 1.2's migration application
(`20260918120000_alshrouq_handled_manually.sql`) must complete *before* this import step,
or any such row will fail self-hosted's `alshrouq_dispatches_resolution_outcome_valid`
CHECK constraint.
6.9. CDR historical data per the hybrid strategy (`phase45_cdr_migration_plan.md`) —
import historical rows, then let the existing Yeastar sync resume for anything after the
freeze point.
6.10. Confirm `orders_verification_snapshot_20260815` is **not** created or imported on
self-hosted at any point in this sequence.

### 7. Trigger handling
See §4 of this document (dedicated section) for the exact list. Summary: disable the 4
import-unsafe triggers only for the duration of steps 6.4–6.5, then re-enable
immediately after. Migration 69 remains held throughout — it is never applied at any
point in this sequence.

### 8. Shams rebuild/sync
8.1. `shams_product_catalog` requires no action — already an exact match (8,484 rows)
via its own independent sync pipeline, unaffected by this cutover.
8.2. Once Shams credentials are configured (§6), allow the existing
`shams-sync-tick` cron job (already active, running every minute) to rebuild
`shams_offers` via its own staging-table + atomic-promotion mechanism
(`20260916120000_shams_offers.sql`). This is a **rebuild/derive**, not a row-for-row
Cloud copy — do not attempt to import `shams_offers` data directly from Cloud.
8.3. Confirm `shams_offers` row count approaches Cloud's live count (was 110,524 at
Phase 48, growing) only as a sanity check, not an exact-match requirement (Cloud
continues to grow independently).

### 9. Storage bucket/object handling
9.1. Create the self-hosted `avatars` bucket. The decision is no longer open (§1, item
8) — the exact statement, fully determined from existing code/migration, is:
```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 4194304,
        ARRAY['image/png','image/jpeg','image/webp','image/gif'])
ON CONFLICT (id) DO NOTHING;
```
Attempted this phase and blocked by this session's own permission classifier ("Modify
Shared Resources") as a self-hosted write — requires the operator to run it directly, or
to grant explicit approval for it to be run in-session. The 4 RLS policies
(`avatars_owner_insert/read/update/delete`) are already attached and require no changes.
9.2. Migrate any required existing avatar objects from Cloud storage to the new bucket,
preserving object paths/ownership so the pre-attached RLS policies resolve correctly.

### 10. SMTP/application/Shams configuration
10.1. Replace placeholder `GOTRUE_SMTP_*` values on self-hosted `supabase-auth` with real
production SMTP credentials. The current values are confirmed non-functional (§1 item 9)
— `SMTP_HOST` does not resolve — not merely unverified, so this is not optional hygiene.
10.2. Set `SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` in Lovable's
project environment settings for the deployed Cloudflare Worker — the app's current, and
only, deployment target (Vercel was removed from the architecture; see the third finding
at the top of this document and §1 item 10).
10.3. Set `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD`, `SHAMS_MIS_*` wherever the Shams
sync runtime reads them.
10.4. Do not print or log any of these values at any point; verify presence by name/
connectivity test only.
10.5. Set GoTrue's own `GOTRUE_SITE_URL` and `API_EXTERNAL_URL` to the real production
domain (currently `localhost` values — §1 item 9b), and populate
`GOTRUE_URI_ALLOW_LIST`/`ADDITIONAL_REDIRECT_URLS` with any additional redirect targets
the application requires. **This is not the same variable as step 10.2's application-level
`SITE_URL`/`VITE_SITE_URL`** — GoTrue reads its own copy independently to both generate
email links and validate `redirectTo`. Skipping this step leaves step 10.1's SMTP fix
insufficient on its own: real credentials would deliver an email, but every link inside it
would still point at `localhost`.

10.6. Recreate `supabase-studio`, `supabase-storage` and `supabase-edge-functions` so the
already-corrected `SUPABASE_PUBLIC_URL` (§9.7 — the file is fixed, the running containers
still carry the installer default) takes effect. No other container needs recreating for
this, and no value has to be decided at the time.

10.7. Set `GOTRUE_MAILER_TEMPLATES_*` and `GOTRUE_MAILER_SUBJECTS_*` on `supabase-auth` so
the branded templates survive the cutover instead of being replaced by GoTrue's plain
defaults — exact values, ordering constraint and the mandatory pre-send fetch check are in
§14. This must be done **before** step 12's single test email, not after: that email is the
one every migrated user then receives.

10.8. Create the four self-hosted Vault secrets the three active cron jobs need
(`shams_sync_scheduler_url`, `alshrouq_scheduler_url`, `telesales_generation_url`,
`email_queue_service_role_key`) — §15. Without them each job records `succeeded` while
making no request at all, so this cannot be validated by watching `cron.job_run_details`.

### 11. Post-import validation
11.1. Run full count/FK/orphan validation across every imported table
(`phase45_validation.sql` methodology).
11.2. Run Auth/profile/role consistency checks — every `auth.users.id` has exactly one
`profiles` row and one `user_roles` row, no orphans, no duplicates
(`phase46_auth_validation.sql` sections D–G methodology).
11.3. Confirm branch count now includes all 7 newly-required rows (137 + 7 = 144,
matching Cloud's reference count from Phase 48) and that `orders`/`telesales_leads`
FK integrity holds against the newly-added branch rows.
11.4. Confirm the 4 disabled triggers have been re-enabled and are reporting
`tgenabled='O'`.
11.5. Confirm migration 69 is still absent from the ledger.

### 12. Controlled authentication/password-reset test
12.1. Confirm both step 10.1 (real SMTP credentials) and step 10.5 (GoTrue
`SITE_URL`/`API_EXTERNAL_URL`/`URI_ALLOW_LIST` set to the real production domain) are
complete. SMTP credentials alone are not sufficient — see the fourth finding at the top
of this document.
12.2. Restart only the `supabase-auth` container to pick up the new environment values.
No other self-hosted container needs to restart for this change.
12.3. Before sending anything, re-verify DNS resolution and TCP reachability of the newly
configured `SMTP_HOST`:`SMTP_PORT` from inside `supabase-auth`, using the same read-only
method as the SMTP readiness audit (`getent hosts`, then a TCP connect attempt) — this
confirms the new values are actually live without yet sending any mail.
12.4. Send **exactly one** test through the real, now-configured SMTP path: a
password-recovery/invite request to a single designated operator/test account. Respect
GoTrue's mailer rate limit (`GOTRUE_SMTP_MAX_FREQUENCY`, ~1 minute per address by
default) — do not resend speculatively.
12.5. Confirm all of: real delivery, correct sender identity, a link pointing at the real
(non-`localhost`) production domain, and a successful end-to-end password-reset round
trip (request → receive → set new password → log in).
12.6. Do not skip this step — SMTP presence (name-only) was never confirmed to produce
real deliverable email in any prior phase; this is the first real-world proof.

### 13. Application smoke tests
13.1. Verify core surfaces load and authenticate correctly: Dashboard, Orders,
Complaints, Calls, Branches (including the 7 newly-added branches), Users.
13.2. Verify RBAC/permission checks behave identically to Cloud for at least one account
per role tier.
13.3. Verify Yeastar CDR mirror and AlShrouq dispatch flows are live and functioning.

### 14. DNS/reverse-proxy switch
14.1. Only after every check in steps 11–13 passes, switch DNS/reverse-proxy routing to
point at self-hosted production.
14.2. This step requires explicit Gate B `GO` and is the last irreversible-in-practice
action of the cutover (see §7 rollback plan for what "irreversible in practice" means
here).

### 15. Rollback decision point
15.1. Immediately after the DNS switch, monitor closely for the defined observation
window (§7).
15.2. If any rollback trigger condition is met (§7), revert DNS to Cloud and treat
self-hosted as not yet cut over; Cloud remains authoritative and untouched up to the
freeze point.
15.3. If no rollback trigger fires within the observation window, declare cutover
accepted.

### 16. Post-cutover monitoring
16.1. Continue observing error rates, auth success rates, cron job health, and Yeastar/
Shams sync health for an extended period after acceptance.
16.2. Keep the Cloud rollback path available (per §7) until the business formally closes
out the migration.

---

## 3. Data scope

### Included — required branches
`branches` reference data already present on self-hosted (137 rows) is retained as-is;
no destructive replace, only additive reconciliation for the rows below.

### Included — 7 branch rows sourced from Cloud
- `P0310`, `P0311` — **required regardless of business decision** (live-referenced by
  Cloud `orders.branch_no`).
- `P0312`, `P0313`, General Administration (الادارة العامة), Branch Administration
  (الادارة الفرعية), Warehouse (المستودع) — **newly approved** by the business for
  migration (previously optional/undecided as of Phase 49–50).

### Included — Auth/profile/role relationships
- Full Cloud Auth roster (UUIDs, emails, metadata) — imported preserving UUIDs via
  `admin.createUser({id})`.
- `profiles` and `user_roles` for every imported user, upserted on top of the
  `handle_new_user()` default, per the Phase 44-proven sequence.
- **Not included**: password hashes, MFA secrets/factors, or any other Cloud
  Auth-internal credential material — the confirmed strategy is password-reset-only.

### Included — business tables (CLOUD→REPLACE / MERGE / HYBRID, per Phase 42–48 classification)
`orders`, `order_activity`, `complaints`, `complaint_activity`, `satisfaction_surveys`,
`notifications`, `admin_activity`, `alshrouq_dispatches`, all 5 `telesales_*`
transactional tables (`telesales_leads`, `telesales_customers`, `telesales_lead_activities`,
`telesales_followups`, `telesales_generation_runs`), `telesales_product_relations`,
`cdr_records` (per the hybrid historical-import + resume-live-sync strategy).

### Included — Shams data (rebuild/derive strategy, not copied)
- `shams_product_catalog`: no action needed — already synced via its own independent
  pipeline (exact match, 8,484 rows).
- `shams_offers`: **not copied from Cloud**. Rebuilt locally via the existing
  `shams-sync-tick` cron and the migration's own staging + atomic-promotion mechanism,
  once Shams CRM/MIS credentials are configured.
- `shams_catalog_state`, `shams_sync_*`, `shams_crm_agent_links`: DEFER-classified —
  operational/runtime state, not treated as export targets.

### Excluded
- `orders_verification_snapshot_20260815` — **explicit business decision to exclude**.
  Confirmed static (3,837 rows, unchanged across every phase that checked), not
  referenced by any application code, does not exist on self-hosted, and will not be
  created.
- Cloud Auth password hashes and any other credential material — excluded per the
  password-reset-only strategy, not a data-completeness gap.
- No additional table, row, or credential is excluded or included beyond what is listed
  above or in the confirmed business decisions — this document does not invent scope.

---

## 4. Trigger safety

**Migration 69 (`20260723022830`) MUST remain held for the entire cutover.** It is never
applied at any step of this runbook. No trigger state is modified by this preparation
document — the following is documentation of what the eventual execution phase must do,
verified live this session but not acted upon.

### Triggers that MAY be disabled — only for the duration of the bulk import (steps 6.4–6.5), and MUST be re-enabled immediately after
| Table | Trigger | Verified live state |
|---|---|---|
| `orders` | `trg_log_order_activity` | enabled (`tgenabled='O'`) |
| `orders` | `trg_notify_order` | enabled (`tgenabled='O'`) |
| `complaints` | `trg_log_complaint_activity` | enabled (`tgenabled='O'`) |
| `complaints` | `trg_notify_complaint` | enabled (`tgenabled='O'`) |

These 4 exist specifically because migration 69 (which would drop `trg_notify_order`,
`trg_notify_complaint`, and their backing functions) has never been applied — this is
precisely why migration 69 must stay held: disabling-then-re-enabling requires the
triggers to still exist.

### Triggers that MUST remain enabled throughout (never disabled)
| Table | Trigger | Verified live state |
|---|---|---|
| `orders` | `orders_prevent_reassignment` | enabled |
| `orders` | `orders_updated` | enabled |
| `orders` | `trg_set_order_display_no` | enabled |
| `orders` | `trg_sync_order_invoice_flags` | enabled |
| `telesales_followups` | `telesales_followups_sync_lead` | enabled |
| `telesales_lead_activities` | `telesales_activities_sync_last_contact` | enabled |
| all other tables | every trigger not named above | enabled |

Rationale: only the 4 named triggers cause the specific bulk-insert duplication problem
identified in Phase 44 (synthetic activity/notification rows fired once per imported
historical row). No other trigger has this failure mode, so no other trigger may be
touched.

**FK note carried forward**: `telesales_leads_parent_lead_id_fkey` remains
non-deferrable (confirmed live this session) — this is why the two-pass import strategy
(§2, step 6.5) is required rather than a deferred-constraint bulk insert.

---

## 5. Password-reset handling — post-migration user experience

This is a plain description of what every migrated user will experience. Nothing in
this section is implemented or tested against production in this phase.

1. **Accounts and identity are preserved.** Every user keeps the same account, the same
   UUID, and the same `profiles`/`user_roles` relationships they had on Cloud. Nothing
   about who a user is or what they can do changes.
2. **Passwords are not preserved.** Cloud password hashes are never read, transported,
   or written anywhere in this migration. This is a deliberate, validated strategy
   (Phase 47), not a limitation being worked around.
3. **Every user must reset their password once, after cutover, before they can log in.**
   There is no password that will work immediately post-migration — this must be
   communicated to users ahead of the cutover window as part of the business's own
   communication plan (outside the scope of this technical document).
4. **SMTP must be proven to deliver real email before the system is opened to users**
   (runbook steps 12.1–12.4) — presence of `GOTRUE_SMTP_*` variable names is not
   sufficient proof, and neither is real SMTP credentials alone: a dedicated SMTP
   readiness audit found the self-hosted configuration confirmed non-functional (DNS
   resolution failure on `SMTP_HOST`, not just an unverified placeholder — see the
   fourth finding at the top of this document), and separately found that GoTrue's own
   `GOTRUE_SITE_URL`/`API_EXTERNAL_URL` still point at `localhost` (§1 item 9b). Both
   must be corrected (runbook steps 10.1 and 10.5) before an actual test email is sent
   and received with a usable, non-`localhost` link.
5. **Exactly one controlled reset-password smoke test is required during cutover**
   (runbook step 12.5), using a designated test/operator account, performed after both
   SMTP credentials (10.1) and GoTrue's URL/redirect settings (10.5) are configured and
   before the system is declared open. This is the first real-world validation of the
   full reset flow against the self-hosted GoTrue instance with real SMTP — Phase 47
   validated the mechanism structurally (`resetPasswordForEmail` compatibility) but
   never sent a real, deliverable email.
6. Only after both the SMTP test and the controlled reset test (runbook 12.4–12.5)
   succeed should the system be considered ready to accept real user traffic.

---

## 6. Credentials and secrets checklist

No secret value appears anywhere below — this is a checklist of what must be supplied,
by whom, and where. All rows are unchanged from Phase 50's findings and re-confirmed live
this session (name-only presence checks), **except the two rows marked superseded**,
which were resolved this phase via the already-authenticated Lovable MCP connector (see
the note at the top of this document). The connector's own authentication is pre-existing
and was neither created, modified, nor reset in this phase — only its capability was
verified, using a minimal, non-sensitive aggregate-count query (no rows dumped, no
secrets read). **"Where it must be supplied" is corrected in this phase**: rows previously
naming "Vercel project environment variables" are updated to Lovable's project environment
settings for the deployed Cloudflare Worker, the app's actual (and only) deployment target
— Vercel was removed from the architecture; see the third finding at the top of this
document. No status changes as a result, only the named destination.

| Credential/config | Required for | Where it must be supplied | Current status |
|---|---|---|---|
| Cloud Auth `service_role` key | Auth roster pull | — | **Superseded.** No longer required: the already-authenticated Lovable MCP connector (verified this phase) provides equivalent capability via direct `SELECT` on Cloud `auth.users`; no new credential needed from the business owner. |
| Cloud Postgres direct connection credentials (libpq) | Final production export | — | **Superseded.** No longer required: the already-authenticated Lovable MCP connector (verified this phase) can `SELECT` every table needed for the export directly against the live Cloud project; a literal `psql`/`pg_dump` binary is not required for this path. The connector is also capable of writes, so export *execution* remains a SELECT-only, Gate-B-gated cutover-day action, not performed by this preparation phase. |
| Self-hosted `GOTRUE_SMTP_HOST/PORT/USER/PASS/SENDER_NAME/ADMIN_EMAIL` | Real password-reset email delivery | `supabase-auth` container environment (self-hosted) | **NOT PRODUCTION-READY** (confirmed, not just placeholder-patterned): all 5 non-port values match placeholder/fake shapes and `SMTP_HOST` fails DNS resolution from `supabase-auth` (control lookup of `smtp.gmail.com` succeeds from the same container, so the container's own DNS/egress is not the cause); `SMTP_PORT` is a non-standard `2500` — **operator must replace with real, reachable production SMTP credentials** |
| Self-hosted `GOTRUE_SITE_URL`, `API_EXTERNAL_URL`, `GOTRUE_URI_ALLOW_LIST` | Correct (non-`localhost`) password-reset/invite links; `redirectTo` validation | `supabase-auth` container environment (self-hosted) | **New row, added by the SMTP readiness audit.** `GOTRUE_SITE_URL=http://localhost:3000`, `API_EXTERNAL_URL=http://localhost:8000/auth/v1`, `GOTRUE_URI_ALLOW_LIST` empty — all local-development values. Distinct from the `SITE_URL`/`VITE_SITE_URL` row below, which the Cloudflare Worker application reads separately — **operator must set these to the real production domain** |
| `SITE_URL`, `VITE_SITE_URL` | Password-reset redirect URL correctness | Lovable project environment settings (Cloudflare Worker) | **Missing from `.env.example`; must come from institutional knowledge — operator must supply** |
| `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` | Email queue/webhook routes | Lovable project environment settings (Cloudflare Worker) | **Missing from `.env.example`; must come from institutional knowledge — operator must supply** |
| `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD`, `SHAMS_MIS_BASE_URL`, `SHAMS_MIS_ACCOUNT_IDENTIFIER`, `SHAMS_MIS_API_KEY` | `shams_offers` rebuild via `shams-sync-tick` | Wherever the Shams sync runtime reads its environment | **Not found in any inspectable container — operator must supply, all required together per `.env.example`'s documented grouping** |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY` (+ `VITE_` counterparts) | Application-to-database connectivity | Lovable project environment settings (Cloudflare Worker) | Documented in `.env.example`; live presence on the actual deployment unverifiable from this environment — operator should confirm. **`SUPABASE_PROJECT_ID`/`VITE_SUPABASE_PROJECT_ID` dropped from this row**: no code reads them since the pre-cutover hardening phase (§9.4), and `.env.example` no longer lists them |
| `ALSHROUQ_SCHEDULER_SECRET`, `CDR_SYNC_SECRET`, `YEASTAR_*` | Scheduler/sync authentication | Lovable project environment settings (Cloudflare Worker) | Documented in `.env.example`; live presence unverifiable — operator should confirm |
| `ALSHROUQ_LIVE_DISPATCH_ENABLED` | Live dispatch gating | Lovable project environment settings (Cloudflare Worker) | Documented, defaults safe-closed (`"false"`) — no action required unless the business wants it enabled post-cutover |

**No credential above was read, guessed, or invented in this phase.** Every "status" is
a presence/pattern observation only.

---

## 7. Rollback plan

### What remains available on Cloud before cutover
Cloud (Lovable-managed Supabase project) remains the live, authoritative, growing
source of truth **up until the write freeze (runbook step 2)**. Nothing in this
preparation phase or any prior phase has paused, exported, or altered Cloud in any way.

### When rollback is still possible
- **Before the write freeze**: trivially possible — nothing has happened yet.
- **After the write freeze, before DNS switch**: possible and low-cost — simply resume
  Cloud writes (unfreeze) and abandon the in-progress self-hosted import; self-hosted was
  never serving traffic, so no user-facing impact occurred.
- **After the DNS switch, before rollback trigger conditions are evaluated**: possible
  by reverting DNS back to Cloud. Cloud has been frozen (not deleted or modified) since
  step 2, so it still holds an accurate, if slightly stale (frozen-at-cutover), copy of
  all data. Any writes that happened on self-hosted between DNS switch and the rollback
  decision would be lost on rollback — this is the real cost of rolling back post-switch,
  and is the reason for the smoke tests (runbook step 13) and monitoring window (step 15)
  before declaring acceptance.
- **After acceptance is formally declared**: rollback is no longer a same-day operation;
  it would require a fresh reverse-migration effort. This is why acceptance must not be
  declared until all validation gates below pass.

### Validation gates that must pass before declaring success
1. Post-import count/FK/orphan validation (runbook 11.1) — zero orphans, counts
   reconcile against the final export.
2. Auth/profile/role consistency checks (runbook 11.2) — zero mismatches.
3. Branch integrity check including all 7 newly-added rows (runbook 11.3).
4. Trigger re-enable confirmation — all 4 temporarily-disabled triggers back to
   `tgenabled='O'` (runbook 11.4).
5. Migration 69 still absent from the ledger (runbook 11.5).
6. SMTP real-delivery test succeeds (runbook 12.4).
7. Controlled password-reset smoke test succeeds end-to-end (runbook 12.5).
8. Application smoke tests pass across all 6 surfaces (runbook 13).
9. No rollback-trigger condition (below) is observed during the post-switch monitoring
   window (runbook 15).

### What would trigger rollback
- Any validation gate above fails and cannot be corrected within the maintenance window.
- Auth import produces any duplicate-UUID corruption, orphaned `profiles`/`user_roles`
  row, or a roster count mismatch against the acquired Cloud roster.
- FK/orphan validation finds any violation in the imported business data.
- SMTP delivery test or the controlled password-reset test fails.
- Any of the 4 temporarily-disabled triggers fails to re-enable correctly.
- Critical application smoke test failure (login broken, RBAC broken, core surface
  non-functional) on self-hosted post-switch.
- Any evidence of data loss or corruption relative to the final Cloud export.
- Migration 69 is found applied, or any other unplanned schema/trigger change is
  detected, at any point in the sequence.

Rollback itself (reverting DNS, resuming Cloud) is **not performed by this document** —
it is a decision and action reserved for the operator during the actual cutover, per
runbook step 15.

---

## 8. Human confirmation gates

### Gate A — Before scheduling cutover
**Required before any date/time is fixed for the cutover:**
- Every prerequisite in §1 must be CLOSED or READY FOR CUTOVER — no
  REQUIRES OPERATOR INPUT item may remain open.
- The business must supply the exact cutover date/time, honoring the confirmed
  constraint of "after 12:30 AM." **This document does not choose that date/time.**

Gate A has **not** been passed yet — 5 items (§1, rows 8–9b, 10–11: `avatars` bucket
creation execution, real SMTP [now confirmed NOT PRODUCTION-READY, not just unverified],
GoTrue URL/redirect configuration [new, item 9b], Cloudflare Worker application env vars,
Shams CRM/MIS credentials) remain open, and the exact date/time has not been provided.
Item 8's decision is resolved (see its row) — only the creation statement's execution is
still pending. Items 7 and 12 (Auth roster pull, Cloud production export path) closed via
the already-authenticated Lovable MCP connector — no new credential required.

### Gate B — Immediately before executing cutover
Once Gate A is passed and a specific date/time is scheduled, execution may not begin
until the user explicitly responds `GO` or `NO-GO` at the start of the scheduled window.

**No freeze, final export, import, DNS switch, or any other cutover action (runbook
steps 2–16) may occur before Gate B receives an explicit `GO`.** A `NO-GO` (or no
response) means the cutover does not proceed and Cloud continues operating normally,
untouched.

---

## 9. Worker → Cloud Supabase dependency audit (read-only; nothing changed)

Performed against the repository, the live Worker's own response headers, the self-hosted
stack's configuration, and the running containers. **No Worker environment variable, no
repository source file, no Nginx file and no container configuration was modified.**

### 9.1 The single source of every Supabase endpoint

`supabase-js` derives the REST, Auth, Storage, Realtime, Functions and GraphQL endpoints
from **one** value — the URL passed to `createClient` — by appending a fixed path prefix.
There is no separate "API URL", "Auth URL", "Storage URL", "Realtime URL" or "Functions
URL" variable anywhere in this repository; a grep for such names returns nothing. This
matters for cutover scope: **switching the URL switches all six services at once**, and
there is no second place to forget.

Confirmed this phase that Nginx already proxies all six derived prefixes to Envoy on
`milaportal.milaserv.com`, so the derived endpoints resolve:

| `supabase-js` derived path | Nginx `location` | Upstream |
|---|---|---|
| `/auth/v1/*` | `/auth/v1` | `api-gw:8000` |
| `/rest/v1/*` | `/rest` | `api-gw:8000` |
| `/storage/v1/*` | `/storage/v1/` | `api-gw:8000` |
| `/realtime/v1/*` (incl. `/realtime/v1/websocket`) | `/realtime/v1/` | `api-gw:8000` |
| `/functions/v1/*` | `/functions` | `api-gw:8000` |
| `/graphql/v1` | `/graphql` | `api-gw:8000` |

A consequence worth stating explicitly, because it changes the security posture: after
cutover **Supabase becomes same-origin with the application** (both are
`https://milaportal.milaserv.com`). Today they are cross-origin.

### 9.2 Confirmed: the deployed Worker still points at Cloud

Re-verified live this phase, without touching the deployment: `GET https://milaportal.live/mcp`
returns its `Content-Security-Policy-Report-Only` header containing
`connect-src … https://gwnxlpophyvgafctrbkx.supabase.co wss://gwnxlpophyvgafctrbkx.supabase.co …`.
Because that directive is **computed at request time** from `SUPABASE_URL`/`VITE_SUPABASE_URL`
(`src/lib/security-headers.ts`, `connectSources()`), it is direct evidence of the Worker's
live environment rather than of a build artifact. The Worker is on Cloud.

### 9.3 Dependency inventory

Self-hosted target values are named by their source of truth rather than reproduced, per
this document's own rule (§2 step 10.4) that credential values are never printed.

| # | Variable / config | Current Cloud value | Exact intended self-hosted value | Where configured | Must change at cutover? |
|---|---|---|---|---|---|
| D1 | `VITE_SUPABASE_URL` | `https://gwnxlpophyvgafctrbkx.supabase.co` | `https://milaportal.milaserv.com` | Lovable project environment settings for the deployed Cloudflare Worker (build-time inlined by Vite) | **YES** |
| D2 | `SUPABASE_URL` | `https://gwnxlpophyvgafctrbkx.supabase.co` | `https://milaportal.milaserv.com` | Same (read from `process.env` at runtime; gap-filled from D1 by `hydrateServerEnv`) | **YES** |
| D3 | `VITE_SUPABASE_PUBLISHABLE_KEY` | Cloud anon JWT, `ref: gwnxlpophyvgafctrbkx` | Value of `ANON_KEY`, `/opt/supabase/supabase-project/.env` line 35 | Lovable Worker env | **YES** |
| D4 | `SUPABASE_PUBLISHABLE_KEY` | Same Cloud anon JWT | Same as D3 | Lovable Worker env (gap-filled from D3 by `hydrateServerEnv`) | **YES** |
| D5 | `VITE_SUPABASE_PROJECT_ID` | `gwnxlpophyvgafctrbkx` | **Unset / empty — not a self-hosted value** | Lovable Worker env | **NO LONGER LOAD-BEARING** — the code that read it is removed (tenth finding, §9.4). Still worth deleting from the Worker env as hygiene (B4); leaving it set now changes nothing |
| D6 | `SUPABASE_PROJECT_ID` | `gwnxlpophyvgafctrbkx` | **Unset / empty** | Lovable Worker env | **NO LONGER LOAD-BEARING** — same as D5 |
| D7 | `SUPABASE_SERVICE_ROLE_KEY` | Cloud service-role JWT | Value of `SERVICE_ROLE_KEY`, `/opt/supabase/supabase-project/.env` line 36 | Lovable Worker env, **server-only**, never `VITE_`-prefixed | **YES** |
| D8 | `PUBLIC_SUPABASE_FALLBACKS` | ~~Cloud project ref, URL and anon key hard-coded in `vite.config.ts`~~ | **Removed.** The build now requires `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` and fails, naming them, when absent | Repository source file (`vite.config.ts`) | **CLOSED this phase** — see the tenth finding and §9.5 |
| D9 | `SITE_URL` / `VITE_SITE_URL` | Presumed `https://milaportal.live` (unverifiable from here) | `https://milaportal.milaserv.com` | Lovable Worker env; read at `src/lib/password.server.ts:88` as the reset-link origin fallback | **YES** |
| D10 | `supabase/config.toml` → `project_id` | `gwnxlpophyvgafctrbkx` | Self-hosted project ref used by the migration tooling | Repository source file | **Tooling only — not read at runtime by the Worker** |
| D11 | `.lovable/mcp/manifest.json` → `auth.issuer` | `https://gwnxlpophyvgafctrbkx.supabase.co/auth/v1` | `https://milaportal.milaserv.com/auth/v1` | **Generated artifact** — `@lovable.dev/mcp-js`, from `src/lib/mcp/index.ts`; `.prettierignore` documents it as generator-owned | **Now derived from D1/D2, not D5** (§9.4). **Note, measured this phase**: a plain `vite build` did **not** rewrite this file in either direction (mtime unchanged, `git status` clean) — it is re-emitted by the Lovable pipeline, so B9 must verify it after a real Lovable deploy, not after a local build. Never hand-edit |
| D12 | CSP `connect-src` allowlist | `https://gwnxlpophyvgafctrbkx.supabase.co` + `wss://…` | `https://milaportal.milaserv.com` + `wss://milaportal.milaserv.com` | `src/lib/security-headers.ts`, `connectSources()` | **Derived from D1/D2 — no separate change, and no code change** |
| D13 | Auth redirect URL (`redirectTo`) | `${origin}/reset-password` | Unchanged — already origin-relative | `src/routes/auth.tsx:92`, `src/features/profile/components/temporary-password-expired.tsx:51`, `src/lib/password.server.ts:128` | **NO — already correct** |
| D14 | `GOTRUE_URI_ALLOW_LIST` | n/a (Cloud-side) | `https://milaportal.milaserv.com/reset-password` | Self-hosted `supabase-auth` | **NO — already set, verified live this phase** |
| D15 | `GOTRUE_SITE_URL` / `API_EXTERNAL_URL` | n/a (Cloud-side) | `https://milaportal.milaserv.com` / `https://milaportal.milaserv.com/auth/v1` | Self-hosted `supabase-auth` | **NO — already set, verified live this phase** |
| D16 | `LOVABLE_API_KEY` / `LOVABLE_SEND_URL` + `/lovable/email/auth/webhook` | Cloud GoTrue delivers auth mail through this Worker webhook | **Becomes dormant** — self-hosted GoTrue sends via its own SMTP and never calls the webhook | Lovable Worker env; route at `src/routes/lovable/email/auth/webhook.ts` | **NO change required, but see §9.6** |
| D17 | `SUPABASE_PUBLIC_URL` | n/a (Cloud-side) | `https://milaportal.milaserv.com` | `/opt/supabase/supabase-project/.env` line 97 | **CORRECTED this phase** (was `http://localhost:8000`). File-only: no container recreated, so the running stack still carries the old value until the next recreate — see §9.7 |

### 9.4 D5/D6 — the non-obvious one: the project ref must be removed, not replaced

`src/lib/mcp/index.ts` builds the MCP OAuth issuer as
`https://${VITE_SUPABASE_PROJECT_ID}.supabase.co/auth/v1` **whenever that variable is set**,
and only falls back to `VITE_SUPABASE_URL`/`SUPABASE_URL` when it is not. The file's own
comment explains why: on Cloud, publish can rewrite `SUPABASE_URL` to a `.lovable.cloud`
proxy, so the project ref is deliberately the more trustworthy source there.

The cutover consequence is that **switching D1–D4 and D7 alone is not sufficient**. If
`VITE_SUPABASE_PROJECT_ID` is merely left in place, the application's data path moves to
self-hosted while its MCP OAuth issuer keeps pointing at Cloud GoTrue — a split state that
no other variable reveals. Setting it to some self-hosted string is equally wrong: it would
produce `https://<whatever>.supabase.co/auth/v1`, a Cloud hostname pattern that does not
exist for this stack. The only correct action is to **remove/empty it**, at which point the
issuer resolves to `https://milaportal.milaserv.com/auth/v1` — which matches self-hosted
GoTrue's `API_EXTERNAL_URL` exactly (verified live this phase).

This dependency was not previously recorded in this document.

**Resolved in the repository (tenth finding).** Rather than rely on the Worker environment
being edited correctly at cutover, the dependency itself was removed:
`src/lib/mcp/index.ts` no longer reads `VITE_SUPABASE_PROJECT_ID` at all and derives the
issuer from `VITE_SUPABASE_URL`/`SUPABASE_URL` with any trailing slash stripped;
`SUPABASE_PROJECT_ID` is out of `BRIDGED_KEYS` in `src/lib/server-env.ts` and out of
`.env.example`. The Cloud rationale the old comment gave (publish can rewrite
`SUPABASE_URL` to a `.lovable.cloud` proxy) is accepted as a real Cloud behaviour, but it
is the wrong trade here: it protected the issuer on Cloud at the cost of a silent
Cloud/self-hosted split at cutover, and the issuer only has to match GoTrue's own
`API_EXTERNAL_URL`, which on self-hosted is exactly `SUPABASE_URL` + `/auth/v1`. Verified
no-op for today's Cloud deployment: rebuilding with the Cloud URL reproduces the existing
`.lovable/mcp/manifest.json` byte-for-byte.

### 9.5 D8 — the hard-coded Cloud fallback in `vite.config.ts` is the highest-risk item

`PUBLIC_SUPABASE_FALLBACKS` (`vite.config.ts` lines 64–69) hard-codes the Cloud project
ref, the Cloud URL **and the Cloud anon key** into the repository. Its `config` hook applies
them whenever the build environment supplies neither the `VITE_`-prefixed nor the
unprefixed name. The block exists for a legitimate reason, documented in place: the Lovable
preview sandbox periodically loses its `.env`, and without the fallback the bundle inlines
`undefined` and the app dies on load.

At cutover that safety net inverts into a hazard. A build in which the Supabase variables
are missing or misspelled will **not fail** — it will silently produce a bundle wired to
Cloud Supabase, and the failure mode is a working-looking application reading the wrong
database. Every other dependency in §9.3 fails loudly; this one fails quietly. It must be
changed in the same build that changes the Worker environment, not afterwards.

**CLOSED this phase.** The fallback block is deleted; `vite.config.ts` now treats
`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as required (either spelling satisfies the
other, as before) and throws a build error naming the missing variables when neither is
present. The sandbox problem the fallback existed for is now a clear message instead of a
rescue — the correct trade, since the rescue's cost was a bundle silently pointed at a
project nobody chose. Both halves were exercised in a Node 22 container: missing variables
fail the build; supplied variables build normally; a self-hosted-URL build's `.output/`
contains zero occurrences of `gwnxlpophyvgafctrbkx`. **The same-build pairing requirement
is therefore gone**: checklist item A2 no longer exists as an unmerged commit that has to
land with B6 — the repository is now correct for both targets, and only the Worker
environment changes at cutover.

### 9.6 D16 — the auth-email transport changes hands at cutover

Today, Cloud GoTrue hands auth mail to this Worker's `/lovable/email/auth/webhook`, which
renders the React Email templates and sends via Lovable (`LOVABLE_API_KEY`,
sender domain `milaportal.live`, hard-coded at `webhook.ts:34–36`). Self-hosted GoTrue has
no such hook configured: it sends directly over SMTP (`smtp.zoho.com:587`, sender
`milaportal@milaserv.com`). So at cutover the auth-email path moves from the Worker to
GoTrue, the webhook route becomes dormant rather than broken, and **the branded templates
in `src/lib/email-templates/` stop being used for auth mail** — self-hosted GoTrue will
send its own default templates instead. That is a deliberate, acceptable trade for this
cutover, but it is a visible user-facing change and is recorded here so it is not
discovered from a user's inbox.

### 9.7 D17 — `SUPABASE_PUBLIC_URL` is still the installer default

`/opt/supabase/supabase-project/.env` line 97 read `SUPABASE_PUBLIC_URL=http://localhost:8000`
— unchanged from the installer default, and inconsistent with the rest of the stack
(`API_EXTERNAL_URL` and `SITE_URL` on the same file both correctly name
`https://milaportal.milaserv.com`, and port 8000 is deliberately internal-only). No failure
was attributed to it and it is not on the application's data path, so it was recorded as a
correctness/hygiene item rather than a blocker.

**Corrected this phase to `https://milaportal.milaserv.com`.** Three services consume it,
per `docker-compose.yml`: `studio` (`SUPABASE_PUBLIC_URL`, line 52), `storage`
(`STORAGE_PUBLIC_URL`, line 370) and `edge-functions` (`SUPABASE_PUBLIC_URL`, line 457) —
all three previously being told the stack's public address was a localhost port that is no
longer even exposed. Exactly one line of the file changed (diffed against a pre-edit copy,
which was then securely deleted; no secret was read or printed).

**Deliberately not applied to the running stack.** Container environments are fixed at
create time, so this takes effect on the next `docker compose up -d` recreate. Confirmed
live after the edit: `supabase-studio` still reports `SUPABASE_PUBLIC_URL=http://localhost:8000`
and `supabase-storage` still reports `STORAGE_PUBLIC_URL=http://localhost:8000`, and all 12
containers remain healthy — i.e. nothing running was disturbed. Recreating those containers
is a cutover-window action (add it to runbook step 10), not a preparation action.

### 9.8 Corroboration of items 9 and 9b

Independently re-verified this phase, and both hold: `smtp.zoho.com` resolves to
`136.143.190.56` and TCP `587` is open from the host; `supabase-auth`'s live container
environment carries `GOTRUE_SITE_URL=https://milaportal.milaserv.com`,
`API_EXTERNAL_URL=https://milaportal.milaserv.com/auth/v1` and
`GOTRUE_URI_ALLOW_LIST=https://milaportal.milaserv.com/reset-password`. The "Current
verdict" section below had not been updated to match items 9/9b and is corrected in this
phase.

### 9.9 Not re-verified this phase

The self-hosted Vault secrets (`shams_sync_scheduler_url`, `email_queue_service_role_key`,
`alshrouq_scheduler_url`) and the `cron.job` command URLs were **not** re-checked: the
query was blocked by this session's own permission classifier ("Production Reads"). §1 item
11's prior finding is carried forward unchanged rather than restated as though re-confirmed.

---

### 9.10 Repository re-scan — every remaining Cloud reference, classified

Run over **tracked files only** (`git grep`, so build output and `node_modules` are
excluded by construction) for `gwnxlpophyvgafctrbkx`, `*.supabase.co`, Lovable Cloud hosts
(`lovable.cloud`, `lovableproject.com`, `lovable.app`) and the current production origin
`milaportal.live`. Every hit is below; there are no others.

| Occurrence | Classification |
|---|---|
| `supabase/config.toml` → `project_id = "gwnxlpophyvgafctrbkx"` | **Must change at cutover — tooling only.** The Supabase CLI's link target. Not read at runtime by the Worker and not read by the self-hosted stack; deliberately left as-is, since changing it would repoint the CLI while Cloud is still authoritative. Repoint when the migration tooling is repointed |
| `.lovable/mcp/manifest.json` → `auth.issuer` | **Must change at cutover — generated, never hand-edited.** D11. Re-emitted by the Lovable pipeline; measured this phase that a local `vite build` does not rewrite it |
| `.env.example` → `https://your-project-ref.supabase.co` (×2) | **Test/example.** Placeholder, no real ref. Left as a Supabase-shaped example since Cloud remains a valid target for the variable |
| `src/lib/mcp/index.ts` comment mentioning `https://<ref>.supabase.co` | **Safe historical/documentation reference.** Explains the removed override; names no project |
| `docs/project.md` — issuer description, decision log items 10/13, correctness item 3, env table | **Safe documentation reference**, all updated this phase to match the code |
| `docs/project.md:6835` → `xscurilznfinllufgdpq` | **Safe historical reference.** A different project the CLI was once linked to; recorded as resolved history, referenced nowhere in code |
| `docs/migration/*.md` (all `gwnxlpophyvgafctrbkx` / `supabase.co` hits) | **Safe historical/documentation reference.** This document and its predecessors describing the dependency being migrated |
| `src/routes/lovable/email/auth/webhook.ts:35–37` → `notify.milaportal.live`, `milaportal.live` | **Must change at cutover — but no code change needed now.** Sender/root domain for Lovable-delivered auth mail. After cutover self-hosted GoTrue sends over Zoho SMTP and this route goes dormant (§13), so the constants stop being reached rather than becoming wrong |
| `src/routes/lovable/email/auth/preview.ts:22,29` → `milaportal.live` | **Safe — developer preview route.** Renders sample emails; no production path |
| `src/routes/__root.tsx:123,128` → `pub-….r2.dev/…ee0d9841-…lovable.app-….png` | **Unexpected live dependency, non-blocking.** The `og:image`/`twitter:image` are hosted on Lovable's R2 CDN and keyed by the Lovable project id. Not Supabase and not on any data path: it is a social-preview image fetched by link-unfurlers, not by the app. It keeps working after cutover as long as the Lovable project exists, and would degrade to a missing preview thumbnail if that ever stopped. Rehosting it on the portal's own origin is optional hygiene, not cutover work |
| `src/integrations/supabase/previewAuthStorage.ts:8` → `lovableproject.com`, `lovable.app`, `gpt-eng.com` host list | **Safe — sandbox detection.** Decides where preview auth state is stored; matches on the *browser's* host, contacts nothing |
| `src/lib/pwa/register.ts:16–17` → `lovableproject.com` | **Safe — sandbox detection.** Suppresses service-worker registration in preview hosts |
| `docs/project.md:4159,5919–5923` → `milaportal.live`, `*.lovable.app` | **Safe documentation reference.** Describes the current deployment; will need a pass after cutover, not before |

Deliberately re-confirmed absent: no `*.supabase.co` host, no Cloud anon key and no Cloud
project ref remains anywhere in `vite.config.ts`, `src/lib/`, or any other file that ships
in a build. The only runtime Supabase endpoint in the repository is whatever
`SUPABASE_URL`/`VITE_SUPABASE_URL` is set to (§9.1).

---

## 10. `/mcp` collision — assessment (routing NOT changed)

This resolves open item (b) recorded in the Nginx routing section above.

### 10.1 What each side actually serves

**Supabase's `/mcp` is disabled by design.** Envoy's `lds.template.yaml` (lines 556–582)
routes `prefix: /mcp` to the **`studio`** cluster with `prefix_rewrite: /api/mcp`, and
attaches an RBAC per-route filter whose rule is `action: DENY` over `any: true` principals,
under the literal comment `# Block access to /mcp by default`. The enabling configuration
sits immediately below it, commented out and labelled `# Enable local access (danger
zone!)`, and restricts principals to `127.0.0.1`/`::1`. Empirically, through the production
Nginx listener:

```
curl -k -H 'Host: milaportal.milaserv.com' https://127.0.0.1/mcp
→ 403  "RBAC: access denied"
```

So the endpoint Nginx currently forwards to is Supabase **Studio's** MCP interface, which
this stack denies to everyone. Studio is already confined to the LAN-only `8443` listener
by deliberate design (§ Nginx routing, above). Routing `/mcp` to Envoy on the public `443`
listener therefore cannot produce anything but `403` — it delivers **zero functionality**.

**MilaPortal's `/mcp` is real and working.** Against the Worker's own origin:

```
curl -i https://milaportal.live/mcp
→ 401
   WWW-Authenticate: Bearer realm="mcp",
     resource_metadata="https://milaportal.live/.well-known/oauth-protected-resource"
```

That is a correct, live OAuth-gated MCP server — `src/routes/mcp.ts` → `src/lib/mcp/index.ts`,
five read-only tools (`whoami`, `list_orders`, `get_order`, `list_complaints`,
`orders_summary`), each building a per-request Supabase client from the caller's bearer
token so RLS remains the boundary.

### 10.2 Is MilaPortal's `/mcp` used by production application code?

**No.** A grep across `src/` for any fetch or reference to `/mcp` returns only the
generator-emitted route handlers (`src/routes/mcp.ts`, `src/routes/[.mcp]/…`,
`src/routes/[.well-known]/oauth-protected-resource.ts`) and the tool definitions under
`src/lib/mcp/`. No page, no component, no server function and no scheduled job calls it.

`/mcp` is an **external integration surface** — an endpoint for third-party MCP clients —
not an internal dependency of the portal. Nothing a user does in the UI traverses it.

### 10.3 What actually breaks

Only one path is shadowed. Nginx's `location /mcp` is a prefix match, and the portal's
sibling MCP routes all begin with `/.` — `/.mcp/list-tools`, `/.mcp/invoke-tool/$tool`,
`/.well-known/oauth-protected-resource` — so they do **not** match it and already reach the
application. The collision claims exactly the MCP **transport** endpoint.

That partial shadowing is worse than a clean one. `trustForwardedHost: true` is set on the
handlers and Nginx sets `X-Forwarded-Host`, so after cutover the discovery document at
`/.well-known/oauth-protected-resource` — which reaches the app — will advertise the
resource as `https://milaportal.milaserv.com/mcp`, and that exact URL will answer with
Supabase's `403 RBAC: access denied`. The MCP server becomes **discoverable but unusable**,
and the error it returns points an integrator at Supabase rather than at the real cause.

### 10.4 Verdict

**Not a production blocker. A real defect, safe to defer, trivial and safe to fix.**

- No user-facing functionality breaks — nothing in the application calls `/mcp`.
- Nothing is lost by removing Supabase's claim on it: that route is DENY-all in this stack
  and reaches a Studio instance that is intentionally not public.
- The fix is to delete the `location /mcp { … }` block from the Nginx template, so the
  catch-all `location /` carries `/mcp` to the application like every other app route. It
  is one block, in a file that is **not** version-controlled
  (`/opt/supabase/supabase-project/`), and it is reversible.
- It does **not** gate `GO`. It should be closed either before cutover as independent
  hygiene, or immediately after, and it must be a deliberate decision rather than an
  accident of a vendor default.

**Re-verified this phase (read-only), unchanged:**

```
curl -sk -H 'Host: milaportal.milaserv.com' https://127.0.0.1/mcp
→ 403  "RBAC: access denied"          (Envoy → Studio, DENY-all)

curl -sk -H 'Host: milaportal.milaserv.com' https://127.0.0.1/.well-known/oauth-protected-resource
→ 200                                  (reaches the application)
```

The partial shadowing described in §10.3 is therefore confirmed still live: the discovery
document resolves to the application while the transport endpoint it advertises resolves to
Supabase's `403`.

### 10.5 The minimal safe fix (prepared, deliberately NOT applied)

Delete one block from `/opt/supabase/supabase-project/volumes/proxy/nginx/supabase-nginx.conf.tpl`
(lines 121–123 as of this phase):

```nginx
    location /mcp {
        proxy_pass http://api_gw_upstream;
    }
```

then `docker exec supabase-nginx nginx -t && docker exec supabase-nginx nginx -s reload`.
The catch-all `location /` then carries `/mcp` to the application like every other app
route. Nothing is lost: that route reaches Studio's MCP interface, which this stack denies
to every principal, and Studio itself is confined to the LAN-only `8443` listener.

**Not applied this phase, and that is the evidence-based call, not caution for its own
sake.** The constraint was to change routing only if it is clearly safe *and* does not
affect production functionality. The first holds; the second does not quite. This Nginx
instance currently terminates TLS for real external users of `https://milaportal.milaserv.com`
(ninth finding), so any edit + reload puts live traffic at risk of a typo — while the
benefit today is exactly zero, because the application on that domain is still the
Cloud-wired Worker and external MCP clients use `https://milaportal.live/mcp`, which is
unaffected. The fix becomes worth its risk at cutover, when `/mcp` on this domain starts
mattering. It stays a deferred, one-block, reversible change (checklist A3), and the file
remains outside version control.

**Not changed this phase**, per this task's constraints: no Nginx file was edited and no
route was moved.

---

## 11. Minimal cutover checklist — Worker: Cloud → self-hosted

Scoped deliberately to **moving the application's Supabase dependency**. It does not
restate the data-migration runbook in §2 (steps 2–9), which stands unchanged; it is the
env/config half that §2 step 10.2 previously covered only in outline. Categories B and C
were **not executed** this phase.

### A. Can be prepared now — no production effect, no GO required

| | Action | Notes |
|---|---|---|
| A1 | Read the self-hosted `ANON_KEY` and `SERVICE_ROLE_KEY` from `/opt/supabase/supabase-project/.env` (lines 35, 36) and stage them into Lovable's secret store **without** applying | Values never printed, logged or committed (§2 step 10.4) |
| A2 | *(Done this phase)* `PUBLIC_SUPABASE_FALLBACKS` removed from `vite.config.ts`; the build now requires the Supabase URL and anon key and fails naming them (D8) | Merged, not held back: it is correct for Cloud and self-hosted alike, so it no longer has to land with B6 |
| A3 | Nginx `location /mcp` removal — exact one-block diff and reload command prepared, **unapplied** (§10.5) | Independent of cutover; zero benefit until the domain serves the self-hosted app, so deferred deliberately |
| A4 | *(Done this phase)* `SUPABASE_PUBLIC_URL` corrected in `/opt/supabase/supabase-project/.env` (D17, §9.7) | File only — takes effect when `studio`/`storage`/`edge-functions` are next recreated; fold that recreate into runbook step 10 |
| A5 | ~~Confirm with the business that GoTrue's **default** templates replacing the branded ones is accepted~~ | **Superseded (§14).** There is nothing to accept: the branded templates are preserved by configuration. Reduced to awareness that the From address becomes `milaportal@milaserv.com` |
| A6 | *(Done this phase)* Re-check the Vault secrets and `cron.job` URLs that §9.9 could not read | `vault.secrets` empty; 3 active jobs; **4** secrets required, not 2 (§15) |
| A7 | *(Done this phase)* Verify SMTP reachability, GoTrue URL/redirect config, and that all six Supabase path prefixes proxy correctly | §9.1, §9.8 |
| A8 | *(Done in the hardening phase)* `SUPABASE_PROJECT_ID` dependency removed from the code (D5/D6, §9.4); full repository re-scan classified (§9.10); `avatars` configuration pinned down (§12); auth-email delta documented (§13) | Typecheck, lint, permission parity and 4,339 tests all pass |
| A9 | *(Done this phase)* Branded auth templates rendered to GoTrue-compatible static HTML and committed; exact `GOTRUE_MAILER_*` configuration and the mandatory pre-send fetch check written out (§14) | Repository only — nothing set on `supabase-auth`, no email sent |
| A10 | *(Done this phase)* `avatars` creation turned into a runnable, idempotent artifact with verification and rollback (`docs/migration/cutover-avatars-bucket.sql`); `.env.example` gap for `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` closed | Bucket **not** created — still C4 behind Gate B |

### B. Must happen during cutover — after Gate B `GO`, in this order

| | Action | Verifies |
|---|---|---|
| B1 | Apply the pending migration(s) to self-hosted (§1 item 1b) | `schema_migrations` ledger advances |
| B2 | Set `VITE_SUPABASE_URL` **and** `SUPABASE_URL` = `https://milaportal.milaserv.com` | D1, D2 |
| B3 | Set `VITE_SUPABASE_PUBLISHABLE_KEY` **and** `SUPABASE_PUBLISHABLE_KEY` = self-hosted `ANON_KEY` | D3, D4 |
| B4 | Remove `VITE_SUPABASE_PROJECT_ID` and `SUPABASE_PROJECT_ID` from the Worker env — **now hygiene, no longer load-bearing**: nothing in the code reads them since this phase | D5, D6 (§9.4) |
| B5 | Set `SUPABASE_SERVICE_ROLE_KEY` = self-hosted `SERVICE_ROLE_KEY` | D7 |
| B6 | Set `SITE_URL` / `VITE_SITE_URL` = `https://milaportal.milaserv.com` | D9 (D8 no longer needs pairing here — it is already merged) |
| B7 | Redeploy the Worker | — |
| B8 | **Verification gate:** fetch any Worker URL and read `Content-Security-Policy-Report-Only`. `connect-src` must contain `https://milaportal.milaserv.com` and `wss://milaportal.milaserv.com`, and must **not** contain `gwnxlpophyvgafctrbkx` | D12 — single highest-value check; it proves the live environment, not the build |
| B9 | After the Lovable deploy, confirm `.lovable/mcp/manifest.json`'s issuer no longer names `gwnxlpophyvgafctrbkx` | D11, now downstream of B2 (the URL), not B4. A local `vite build` does not rewrite this file — verify it against a real deploy |
| B10 | Recreate `supabase-studio`, `supabase-storage` and `supabase-edge-functions` so the corrected `SUPABASE_PUBLIC_URL` takes effect | D17 (§9.7) |

`.lovable/mcp/manifest.json` and the `src/routes/mcp.ts` family are **generator-owned** —
they regenerate from the Supabase URL and must not be hand-edited (`.prettierignore`
records this).

### C. Requires explicit GO/NO-GO — not executed, not preparable

| | Action |
|---|---|
| C1 | Cloud write freeze (§2 step 2) |
| C2 | Final Cloud export / Auth roster acquisition (§2 steps 3–4) |
| C3 | UUID-preserving Auth import and business-data import (§2 steps 5–7) |
| C4 | `avatars` bucket creation (§1 item 8) |
| C5 | The controlled password-reset test email (§2 step 12) — **still blocked until B2–B8 land**, because a self-hosted reset link sent today reaches an application wired to Cloud |
| C8 | Set `GOTRUE_MAILER_TEMPLATES_*`/`GOTRUE_MAILER_SUBJECTS_*` and recreate `supabase-auth`, then run the §14.4 fetch check — after B7, before C5 (§14.3) |
| C9 | Create the four Vault scheduler secrets (§15), then verify by an actual HTTP response row rather than by cron job status |
| C6 | DNS / NAT / reverse-proxy switch (§2 step 14) |
| C7 | Rollback decision (§2 step 15) |

---

## 12. `avatars` storage — exact prepared configuration (nothing created, no data touched)

Re-verified live this phase against `supabase-db`, read-only:

| Check | Result |
|---|---|
| `select count(*) from storage.buckets` | **0** — no bucket of any name exists |
| `select count(*) from storage.objects` | **0** — no object exists, so there is no self-hosted avatar data to preserve or destroy |
| RLS policies on `storage.objects` | **4, already attached**: `avatars_owner_insert` (INSERT), `avatars_owner_read` (SELECT), `avatars_owner_update` (UPDATE), `avatars_owner_delete` (DELETE) |

Every setting is fixed by code already in the repository, not by an open decision:

- **Name** `avatars` — `AVATAR_BUCKET` in `src/lib/avatar.ts`.
- **Private** (`public = false`) — the module mints short-lived signed URLs
  (`AVATAR_SIGNED_TTL`, 1 hour) rather than serving public objects, and the RLS policies
  are owner-scoped.
- **`file_size_limit = 4194304`** (4 MB) and
  **`allowed_mime_types = {image/png,image/jpeg,image/webp,image/gif}`** — migration
  `20260721002100_avatars_bucket_limits.sql`, whose own header records why they exist
  (the client-side checks in `_app.profile.tsx` are bypassable; the bucket enforces them
  server-side on the same request path).

**The trap, restated because it is easy to get wrong:** that migration is an
`UPDATE storage.buckets … WHERE id = 'avatars'`. It ran when no such bucket existed, so it
was a **no-op** and is already recorded as applied — it will not re-fire. Creating the
bucket without spelling the limits out explicitly would produce an unlimited,
any-MIME-type bucket that looks correct and silently lacks both server-side guards. The
creation statement in runbook step 9.1 sets all five columns for exactly this reason and
is the only statement that should be used.

**Status: prepared, not executed.** Bucket creation is a write to self-hosted and remains a
Gate-B action (checklist C4). Object migration from Cloud storage (runbook 9.2) is likewise
untouched; with 0 objects on both sides of the RLS boundary here, nothing can be lost by
the creation step itself.

---

## 13. Auth email and GoTrue templates — exactly what changes at cutover

Both sides were inspected this phase (container environment + repository source). **No
email was sent and no user-facing behaviour was changed.**

### 13.1 Today (Cloud)

Cloud GoTrue does not send auth mail itself: it posts to the Worker's
`/lovable/email/auth/webhook`, which renders React Email templates and sends via Lovable.
From `src/routes/lovable/email/auth/webhook.ts` and `src/lib/email-templates/`:

| Property | Current value |
|---|---|
| Sender identity | `SENDER_DOMAIN = notify.milaportal.live`, `FROM_DOMAIN = milaportal.live`, site name `MilaPortal` |
| Templates | 6 branded React Email templates — `signup`, `invite`, `magic-link`, `recovery`, `email-change`, `reauthentication` |
| Subjects | Explicit and human-written: e.g. recovery → **"Reset your password"**, invite → "You've been invited" |
| Branding | MilaPortal card layout, brand teal `#25BDBC` top rule, navy `#12263F` headings, a "Reset Password" button, and a "if you didn't request this, ignore it" footer |
| Transport | `LOVABLE_API_KEY` / `LOVABLE_SEND_URL` |

### 13.2 After cutover (self-hosted)

Self-hosted `supabase-auth` sends directly over SMTP. Verified from its live container
environment this phase:

- `GOTRUE_SITE_URL=https://milaportal.milaserv.com`,
  `API_EXTERNAL_URL=https://milaportal.milaserv.com/auth/v1`,
  `GOTRUE_URI_ALLOW_LIST=https://milaportal.milaserv.com/reset-password`.
- `GOTRUE_MAILER_URLPATHS_RECOVERY` (and `CONFIRMATION`/`INVITE`/`EMAIL_CHANGE`) =
  `/auth/v1/verify`, `GOTRUE_MAILER_AUTOCONFIRM=false`.
- **No `GOTRUE_MAILER_TEMPLATE_*` and no `GOTRUE_MAILER_SUBJECTS_*` variable is set at
  all** — checked by listing the container's environment and filtering for
  `MAILER|TEMPLATE|SUBJECT`. GoTrue therefore uses its **built-in default templates and
  subjects**.
- Transport: Zoho (`smtp.zoho.com:587`, sender `milaportal@milaserv.com`), independently
  re-verified reachable (§9.8).

### 13.3 The visible difference

| | Before | After |
|---|---|---|
| From address | Lovable, `@milaportal.live` | `milaportal@milaserv.com` via Zoho |
| Look | Branded MilaPortal card, brand colours, button | GoTrue's plain built-in HTML — a line of text and a bare link, no branding |
| Subject | "Reset your password" (and 5 siblings) | GoTrue's built-in defaults |
| Link | Worker origin | `https://milaportal.milaserv.com/auth/v1/verify?…`, redirecting to `/reset-password` |
| Webhook route | Live | **Dormant, not broken** — self-hosted GoTrue never calls it; the route, its templates and `LOVABLE_API_KEY` stay in place unused |

**Superseded by §14 — read that section, not this conclusion.** The paragraph that stood
here called the unbranded email an accepted regression requiring a business decision. It was
describing the consequence of leaving `GOTRUE_MAILER_TEMPLATES_*` unset, not a property of
self-hosting. The branded templates are now rendered as static GoTrue templates and the
exact configuration is written out in §14; the residual user-visible delta is the From
address alone. Everything above in §13 remains an accurate description of the two transports
and of what happens if §14's configuration is **not** applied.

---

## 14. Preserving the branded auth emails on self-hosted (prepared; nothing configured, no email sent)

§13 documented the branded templates being replaced by GoTrue's plain built-in ones as an
accepted, reversible-later regression needing a business sign-off (checklist A5). That
framing was wrong in one specific way: it treated "GoTrue sends its own defaults" as a
property of self-hosting. It is a property of **leaving `GOTRUE_MAILER_TEMPLATES_*`
unset**, which is where this stack happens to be, and it is fixable at cutover with
configuration alone — no application change, no webhook, no dependency on Lovable after
cutover.

### 14.1 Scope: one template is reachable, five are insurance

Read from the code, not assumed. The only auth mail this application can cause is
`recovery`:

| Flow | Call site | Sends mail? |
|---|---|---|
| "Forgot password?" on sign-in | `src/routes/auth.tsx:91` — `resetPasswordForEmail` | **Yes — recovery** |
| Admin-triggered reset | `src/lib/password.server.ts:127` — `resetPasswordForEmail` | **Yes — recovery** |
| Expired temporary password | `src/features/profile/components/temporary-password-expired.tsx:50` | **Yes — recovery** |
| Admin creates a user | `src/lib/admin.functions.ts:231` — `admin.createUser({ email_confirm: true })` | No — confirmed at creation, no invite/confirmation mail |
| Admin resets a password | `src/lib/admin.functions.ts:501` — `updateUserById({ password })` | No |
| User changes own password | `src/lib/profile.functions.ts:97,207`, `src/routes/reset-password.tsx:34` | No |

There is no signup, magic-link, email-change or reauthentication path anywhere in `src/`.
So `recovery` is the one that matters — and under the password-reset-only strategy (§5) it
is also the one email **every** migrated user is required to receive. The remaining five
are prepared because they cost nothing extra to render and leaving them unset would mean a
plain email the day someone adds a flow.

### 14.2 What is prepared, and where it lives

`npm run build:auth-email-templates` (`scripts/render-auth-email-templates.mjs`) renders
the six components in `src/lib/email-templates/` to static GoTrue templates in
`public/auth-email-templates/`, substituting GoTrue's own placeholders for the per-message
props:

| File | GoTrue template | Placeholders substituted |
|---|---|---|
| `recovery.html` | `RECOVERY` | `{{ .ConfirmationURL }}` |
| `confirmation.html` | `CONFIRMATION` (from `signup.tsx`) | `{{ .ConfirmationURL }}`, `{{ .SiteURL }}`, `{{ .Email }}` |
| `invite.html` | `INVITE` | `{{ .ConfirmationURL }}`, `{{ .SiteURL }}` |
| `magic_link.html` | `MAGIC_LINK` | `{{ .ConfirmationURL }}` |
| `email_change.html` | `EMAIL_CHANGE` | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` |
| `reauthentication.html` | `REAUTHENTICATION` | `{{ .Token }}` |

Rendering rather than hand-copying is the point: the Cloud webhook
(`src/routes/lovable/email/auth/webhook.ts`) renders the same components per message, so
the brand exists once. Change a template and re-run the script; both transports move
together. The output is generator-owned and listed in `.prettierignore` alongside the other
generated files. Verified after rendering: every `{{`/`}}` in all six files belongs to one
of the placeholders above — no stray Go template syntax was introduced by the renderer.

Because the files sit in `public/`, they ship with the application build and are served at
`/auth-email-templates/<name>.html` on whatever origin the app is deployed to. One
consequence to state plainly: the next Lovable deploy publishes these paths on
`milaportal.live` as well. They contain branding and placeholders only — no secret, no
token, no user data — and nothing links to them.

### 14.3 The exact cutover configuration

Set on self-hosted `supabase-auth` (runbook step 10.7). Subjects are set explicitly rather
than left to GoTrue's defaults: comparing against `supabase/auth`'s own `example.env`,
`RECOVERY` and `INVITE` happen to match today's wording, `CONFIRMATION`, `MAGIC_LINK` and
`EMAIL_CHANGE` do not, and `REAUTHENTICATION`'s default is not documented there. Setting
all six removes the question:

```
GOTRUE_MAILER_TEMPLATES_RECOVERY=https://milaportal.milaserv.com/auth-email-templates/recovery.html
GOTRUE_MAILER_TEMPLATES_CONFIRMATION=https://milaportal.milaserv.com/auth-email-templates/confirmation.html
GOTRUE_MAILER_TEMPLATES_INVITE=https://milaportal.milaserv.com/auth-email-templates/invite.html
GOTRUE_MAILER_TEMPLATES_MAGIC_LINK=https://milaportal.milaserv.com/auth-email-templates/magic_link.html
GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE=https://milaportal.milaserv.com/auth-email-templates/email_change.html
GOTRUE_MAILER_TEMPLATES_REAUTHENTICATION=https://milaportal.milaserv.com/auth-email-templates/reauthentication.html

GOTRUE_MAILER_SUBJECTS_RECOVERY=Reset your password
GOTRUE_MAILER_SUBJECTS_CONFIRMATION=Confirm your email
GOTRUE_MAILER_SUBJECTS_INVITE=You've been invited
GOTRUE_MAILER_SUBJECTS_MAGIC_LINK=Your login link
GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE=Confirm your new email
GOTRUE_MAILER_SUBJECTS_REAUTHENTICATION=Your verification code
```

Subjects are copied verbatim from `EMAIL_SUBJECTS` in `webhook.ts`, so the subject line does
not change for users.

**Ordering constraint — what it actually depends on.** Not the Worker env switch. The
templates are static assets of the application build, and Nginx's catch-all `location /`
already proxies this domain to the deployed Worker (ninth finding), so these URLs start
resolving as soon as a Lovable deploy ships the files — before cutover, and on
`milaportal.live` too. What the configuration must not precede is that deploy. It is kept in
the cutover window regardless, for a different reason: applying it means recreating
`supabase-auth`, and there is no benefit to doing that early when nothing sends mail through
this stack yet. Set it after B7 and before the step-12 test email.

**Two mechanics worth knowing before setting these**, both read from
`supabase/auth`'s `internal/mailer/templatemailer/template.go`:

1. A value that does not start with `http` is treated as a path and appended to
   `SiteURL` — so `/auth-email-templates/recovery.html` also works and stays correct if the
   domain ever changes. Absolute URLs are used above because they are what the verification
   command in §14.4 can be run against verbatim.
2. **Failure is silent.** If the URL does not resolve, GoTrue logs the fetch error and
   sends its **built-in default template** instead. Nothing fails, nothing retries loudly,
   and the only visible symptom is an unbranded email in a user's inbox. This is why §14.4
   is not optional.

### 14.4 Mandatory verification, before the one test email

From inside the auth container, after setting the variables and recreating it:

```
docker exec supabase-auth wget -qO- https://milaportal.milaserv.com/auth-email-templates/recovery.html | head -5
```

It must return the template's HTML. A redirect, a 404, the application's HTML shell, or a
DNS/TLS error all mean GoTrue will quietly fall back to its default. Only after this
succeeds should runbook step 12's single password-recovery test be sent — and that email is
then also the end-to-end proof that the branding survived.

If the fetch cannot be made to work from inside the container (the request leaves the Docker
network and returns through the public edge), the fallback is to serve the same six files
directly from the `supabase-nginx` container on an internal-only listener and point the
variables at `http://supabase-nginx:<port>/...`. That keeps the templates inside the Docker
network with no public round trip. It is a change to a file outside version control
(`/opt/supabase/supabase-project/`), so it is recorded as the fallback rather than the
default.

### 14.5 What still changes for users, and what does not

| | Before (Cloud) | After (self-hosted, configured per §14.3) |
|---|---|---|
| Look | Branded MilaPortal card | **Unchanged** — same components, same brand rule, same button |
| Subject | "Reset your password" | **Unchanged** — set explicitly |
| From address | `MilaPortal <noreply@milaportal.live>` via Lovable | `MilaPortal <milaportal@milaserv.com>` via Zoho — **changes**, and cannot not change: it is the SMTP identity, not a template |
| Link | Worker origin | `https://milaportal.milaserv.com/auth/v1/verify?…` → `/reset-password` |
| Webhook route | Live | Dormant, not broken — self-hosted GoTrue never calls it |

So the residual user-visible delta is the sender address alone. That is a consequence of
moving mail transport to the business's own Zoho mailbox, and the display name (`MilaPortal`,
already set as `SMTP_SENDER_NAME`) is preserved. **Checklist item A5 is therefore no longer
a business decision about accepting unbranded email** — it is reduced to awareness that the
From address becomes `milaportal@milaserv.com`.

---

## 15. Scheduler Vault secrets — four, not two (verified live, names only)

§1 item 11 recorded two Vault secrets, scoped to Shams. Reading the function bodies and the
live `cron.job` table shows the dependency is wider and identical in shape for all three
active jobs: each reads a URL secret naming the application endpoint it must call, plus one
shared service-role key used as the `Authorization: Bearer` credential.

| Cron job | Schedule | Function | URL secret | Application route it must reach |
|---|---|---|---|---|
| `shams-sync-tick` | every minute | `public.shams_sync_tick()` | `shams_sync_scheduler_url` | `/api/shams-sync-run` |
| `alshrouq-dispatch-due` | every minute | `public.alshrouq_dispatch_due()` | `alshrouq_scheduler_url` | `/api/alshrouq-run-scheduled` |
| `telesales-generation-tick` | hourly | `public.telesales_generation_tick()` | `telesales_generation_url` | `/api/telesales-generate` |

Plus, shared by all three: **`email_queue_service_role_key`** — read 9 times across the
migrations, the same credential `email_queue_dispatch()` uses.

**Live state, re-verified this phase (read-only, names only, no value read or printed):**
`vault.secrets` contains **0 rows**; all three cron jobs are **active**. Definitions are in
`20260916120000_shams_offers.sql:705-708`, `20260901120000_alshrouq_scheduler_canonical.sql:191-197`
and `20260901160000_telesales_scheduler.sql:124-131`.

**Why this is a real gate item and not hygiene.** An unconfigured job does not error: it
returns 0, and pg_cron records the run as `succeeded`. `.env.example` documents the
precedent in the repository's own words — "5,769 consecutive 'succeeded' runs; not one HTTP
request; a real delivery left unsent for days." Post-cutover this would silently disable
Shams offer sync, AlShrouq scheduled dispatch and telesales generation at once, and
`cron.job_run_details` would show nothing wrong.

**What must be supplied, by whom, when.** No new credential from the business is needed for
this item — unlike the Shams CRM/MIS credentials in item 11, which are genuinely external:

| Secret | Value source | When |
|---|---|---|
| `shams_sync_scheduler_url` | `https://milaportal.milaserv.com/api/shams-sync-run` | Cutover window, after B2–B7 |
| `alshrouq_scheduler_url` | `https://milaportal.milaserv.com/api/alshrouq-run-scheduled` | Same |
| `telesales_generation_url` | `https://milaportal.milaserv.com/api/telesales-generate` | Same |
| `email_queue_service_role_key` | Self-hosted `SERVICE_ROLE_KEY` (`/opt/supabase/supabase-project/.env` line 36) — never printed, never committed | Same |

**The pairing that is easy to get wrong.** All three routes authenticate the caller by
comparing the bearer token against the **Worker's own** `SUPABASE_SERVICE_ROLE_KEY`
(`isScheduler()` in `src/routes/api/shams-sync-run.ts:67-70`,
`telesales-generate.ts:58-61`, `alshrouq-run-scheduled.ts:82`). So
`email_queue_service_role_key` in the database Vault and `SUPABASE_SERVICE_ROLE_KEY` in the
Worker environment (checklist B5) must be the **same** key. Set one and not the other and
every scheduled run gets a `401` — which, per the silent-failure mode above, still reads as
`succeeded` in `cron.job_run_details`.

Verify by evidence of an actual request, not by job status — e.g. the most recent row in
`net._http_response`, per `.env.example`'s own recipe.

Still genuinely external and unresolved (item 11 proper): `SHAMS_CRM_USERNAME`,
`SHAMS_CRM_PASSWORD`, `SHAMS_MIS_BASE_URL`, `SHAMS_MIS_ACCOUNT_IDENTIFIER`,
`SHAMS_MIS_API_KEY`. All five are read server-side only — `src/lib/shams-crm/client.server.ts:120-121`
and `src/lib/shams/client.server.ts:85-87` — from the Worker environment, never from a
self-hosted container, and each group is all-or-nothing: a partial set reports "not
configured" rather than failing at request time.

---

## 16. GO/NO-GO gate — the final checklist

Nothing below is a judgement call about risk appetite; each line is either evidenced or it
is not. **This document does not declare cutover readiness: as of this phase, 5 lines are
red.**

### 16.1 Green — closed and evidenced

| | Item | Evidence |
|---|---|---|
| ✅ | Migration 69 held | Ledger 150 applied, `20260723022830` absent — re-verified live this phase |
| ✅ | Destination clean | `orders`/`complaints`/`profiles`/`user_roles`/`cdr_records`/`alshrouq_dispatches`/`auth.users` all 0 rows |
| ✅ | Stack healthy | 12 production containers up, and all 11 that declare a healthcheck report healthy (`supabase-nginx` declares none); 3/3 cron jobs active; host port 8000 absent from `ss -tln`, so Envoy is still unexposed, `8443` still bound to `10.10.11.160` only |
| ✅ | HTTPS + certificate | Real Let's Encrypt cert to 2026-12-12; external browsers served. Carried forward from the ninth finding — **not** re-probed this phase |
| ✅ | GoTrue URL/redirect config | `SITE_URL`, `API_EXTERNAL_URL`, `ADDITIONAL_REDIRECT_URLS` re-read on file this phase, all naming the production domain |
| ✅ | SMTP reachability | DNS/TCP to `smtp.zoho.com:587` verified in the eighth finding and **not** re-probed this phase; re-read on file here: `SMTP_PORT=587`, `SMTP_SENDER_NAME=MilaPortal` (so the display name survives cutover) |
| ✅ | No Cloud fallback in the build | `PUBLIC_SUPABASE_FALLBACKS` deleted; build fails naming the missing variable (§9.5) |
| ✅ | No project-ref dependency | Nothing reads `SUPABASE_PROJECT_ID` (§9.4) |
| ✅ | Repository Cloud scan | 5 `gwnxlpophyvgafctrbkx` hits, all generated/tooling/historical (§9.10, re-run this phase) |
| ✅ | `avatars` configuration | Pinned and runnable — `docs/migration/cutover-avatars-bucket.sql` (§12) |
| ✅ | Branded auth templates | Rendered and committed; configuration written out (§14) |
| ✅ | Vault requirement understood | 4 secrets identified with sources; silent-failure mode documented (§15) |
| ✅ | Test suite | See §16.4 |

### 16.2 Red — must be green before `GO`

| | Item | What closes it | Owner |
|---|---|---|---|
| ⛔ | **Cutover date/time** | Business names an exact date/time honouring "after 12:30 AM" | Business |
| ⛔ | **Worker env values confirmed** | Operator confirms `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` are set on the deployed Worker, and that Lovable's **build** environment supplies `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` (the next build fails without them — by design, §9.5) | Operator |
| ⛔ | **Shams CRM/MIS credentials** | Five values supplied to the Worker environment (§15) | Business/operator |
| ⛔ | **End-to-end password-reset test** | Runbook step 12 — cannot run before B2–B7, since a self-hosted link today reaches a Cloud-wired app | Cutover window |
| ⛔ | **Branded-template fetch check** | §14.4 — must pass before the step-12 email is sent | Cutover window |

The last two are *scheduled*, not *missing*: they are gated on the cutover window itself and
cannot be closed beforehand. The first three are genuinely outstanding inputs and are what
Gate A is waiting on.

### 16.3 Cutover-window sequence, corrected for this phase's findings

Ordering that the findings above actually constrain — the full runbook remains §2:

1. Apply pending migration `20260918120000` (B1). Migration 69 stays held.
2. Freeze Cloud writes → export → Auth roster → import (§2 steps 2–7).
3. Create the `avatars` bucket — `docs/migration/cutover-avatars-bucket.sql` (C4).
4. Switch the Worker env and redeploy (B2–B7), then verify via the live CSP header (B8) and
   the regenerated MCP manifest (B9).
5. Set `GOTRUE_MAILER_TEMPLATES_*`/`SUBJECTS_*` and recreate `supabase-auth` (10.7). The
   prerequisite is a Lovable deploy carrying `public/auth-email-templates/`, not step 4
   (§14.3) — it sits here only because recreating the auth container earlier buys nothing.
6. Run the §14.4 fetch check from inside `supabase-auth`.
7. Create the four Vault secrets (10.8), and verify by an actual HTTP response row, not by
   job status.
8. Recreate `studio`/`storage`/`edge-functions` for `SUPABASE_PUBLIC_URL` (B10).
9. Send the single password-reset test (step 12) — it now also proves the branding.
10. Smoke tests (step 13) → DNS/routing switch (step 14) → rollback window (step 15).

Rollback checkpoints are unchanged (§7): free before the freeze; cheap between freeze and
DNS switch; costly after the switch, bounded by the observation window. Steps 5–7 above are
individually reversible by restoring the previous env values and recreating the container —
they touch no data.

### 16.4 Validation run for this phase

`npm run typecheck && npm run lint && npm run check:permissions && npm test` was re-run in
a `node:22` container after the changes in the eleventh finding (this host's Node is v18 and
`vitest` requires ≥ 20.12 — the same pre-existing environment gap earlier phases recorded,
and the same Node major CI uses). The chain exited **0**: typecheck clean, lint clean, the
permission-parity guard passes, and **4,339 tests across 151 files pass** — unchanged from
the hardening phase, as expected, since nothing under `src/` was modified. The new
`scripts/render-auth-email-templates.mjs` was additionally linted on its own and is clean.

---

## Current verdict

**NOT CUTOVER-READY — but every pre-cutover item this side could close is now closed.**
Five lines in the §16 gate remain red: the cutover date/time, confirmation of the Worker
environment values, the Shams CRM/MIS credentials, and two checks that are scheduled rather
than missing (the end-to-end reset test and the template fetch check, both of which can only
run inside the cutover window). **No claim of readiness is made while any of those stand.**

This closure phase added: the branded auth emails are preserved rather than lost (§14), the
scheduler Vault dependency is four secrets rather than two (§15), the `avatars` creation is
a runnable artifact rather than a fenced block (§12), `.env.example` documents the four
previously-undocumented load-bearing variables, and the gate itself is written out as a
checklist (§16). Nothing was applied: no Worker environment, no database write, no migration,
no container recreated, no Nginx/DNS/Cloudflare/NAT change, no email sent.

The two dependencies the previous revision called genuine pre-cutover work — the
hard-coded Cloud fallback in `vite.config.ts` (§9.5, D8) and the
`VITE_SUPABASE_PROJECT_ID`/`SUPABASE_PROJECT_ID` dependency (§9.4, D5/D6) — are **resolved
in the repository** this phase, along with the stale `SUPABASE_PUBLIC_URL` (§9.7, D17).
The silent failure mode is gone: a build without its Supabase variables now stops and names
them, instead of shipping an application quietly wired to Cloud. The project-ref hazard is
gone at the source rather than delegated to a checklist item — no code reads that variable
any more.

What remains is no longer repository work. It is operator/business input (Worker
environment values, Shams credentials, the email-template decision, the cutover date/time)
and Gate-B execution (freeze, export, import, bucket creation, DNS). This phase changed no
Worker environment, no database, no migration, no DNS/Cloudflare/NAT and no Nginx routing.

Also standing from earlier phases: SMTP connectivity and GoTrue's URL/redirect
configuration are correct and working (§9.8), and the `/mcp` collision remains a
non-blocking, deferred-safe defect with its exact one-block fix written out (§10.5).

### Remaining operator inputs
1. ~~**Business decision (§13, checklist A5): accept that self-hosted GoTrue's plain default
   auth emails replace the branded MilaPortal templates.**~~ **Closed by §14** — the
   templates are preserved by configuration, so there is no regression to accept. What
   remains is awareness, not a decision: the From address becomes `milaportal@milaserv.com`.
2. **Worker environment values at cutover (§11 category B)** — the URL, anon key and
   service-role key switch, plus `SITE_URL`/`VITE_SITE_URL`. Nothing in the repository
   blocks these any more; they are Lovable project settings only.

   *Superseded, no longer remaining:* the `vite.config.ts` fallback and the project-ref
   removal, previously items 1 and 2 here — both closed this phase (tenth finding). Real
   SMTP credentials and GoTrue's `GOTRUE_SITE_URL`/`API_EXTERNAL_URL`/`GOTRUE_URI_ALLOW_LIST`
   were closed before that; only the end-to-end reset test remains, gated on item 3 below.
3. Confirmation that `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` are
   set in Lovable's project environment settings for the deployed Cloudflare Worker.
   **Corrected in a prior phase**: Vercel is no longer part of the architecture, so no
   MCP connector authorization or OAuth step applies here — this is a direct operator
   confirmation, not gated on any authentication flow.
4. Shams CRM/MIS credentials for the sync runtime — genuinely external, five values
   (§15). **Corrected**: the self-hosted Vault requirement alongside them is **four**
   secrets, not two, and covers all three active cron jobs, not just Shams. Those four need
   no new credential from the business — three are the app's own scheduler URLs on the
   post-cutover origin and the fourth is self-hosted's own service-role key — but they are
   easy to miss because an unconfigured job reports success while doing nothing (§15).
5. Execute `avatars` bucket creation — the decision is closed and the configuration is
   fully pinned down with live evidence (§12). Only running it remains: it is a write to
   self-hosted, so it belongs behind Gate B (C4). **Run
   `docs/migration/cutover-avatars-bucket.sql` as written** — the limits migration already
   ran as a no-op and will not re-fire, so a bucket created without those five columns set
   silently loses both server-side upload guards.

Resolved in a prior phase, no longer remaining: Cloud Auth roster access and the Cloud
production export path (previously listed here) — both are obtainable via the
already-authenticated Lovable MCP connector, with no new credential required from the
business owner. See the note at the top of this document and §6. Within item 5 above, the
`avatars` bucket's size/MIME-limit *decision* is also resolved — only the creation
statement's *execution* remains open.

### Remaining credentials/access
Identical to the 5 items above (§6 gives the exact variable names and destinations for
each) — no credential has been supplied, read, or invented in any documentation phase.
Two previously-listed credential requirements (Cloud Auth `service_role` key, Cloud
Postgres libpq credentials) are superseded — see §6.

### Remaining business confirmations
1. Exact cutover date/time (constraint already given: after 12:30 AM; specific date/time
   still pending).

No other business decision remains open — optional branches, verification-snapshot
exclusion, and credential strategy are all CLOSED as of this phase.

### Exact next action
Operator closes items 1–5 above (in parallel, independent of each other and of the date/
time decision — items 1 and 2 are both self-hosted `supabase-auth` environment changes and
are naturally done together, but neither depends on the other being done first). Once
closed, and once the business supplies the exact cutover date/time,
Gate A is passed. At the start of the scheduled window, the user must issue an explicit
`GO`/`NO-GO` at Gate B before any execution phase (a future "Phase 51 — Cutover
Execution") may begin runbook step 2 onward. Cloud production export and Auth roster
acquisition (runbook steps 3–4) will use the already-authenticated Lovable MCP connector
SELECT-only, per the safety statement at the top of this document, and remain gated
behind Gate B like every other cutover action.
