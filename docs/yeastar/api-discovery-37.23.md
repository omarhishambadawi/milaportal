# Yeastar API Discovery — firmware 37.23.0.123 (V24.3 GA)

**Sprint 1 · Discovery only.** No analytics logic, dashboard calculations or
existing code were changed by this work.

> ## Status: ✅ COMPLETE — live probe executed 2026-07-31T23:36Z
>
> **Jump to [SPRINT 1 COMPLETE](#sprint-1-complete--live-probe-executed-2026-07-31t2336z)
> at the foot of this document for the verified results and the recommendation.**
>
> Sections 1–6 below were written *before* the probe ran and are kept as the
> documentation-only baseline. Where they say `NOT PROBED`, the live section
> supersedes them. Two of their provisional conclusions were overturned by the
> live run, which is exactly why they are preserved rather than quietly edited:
>
> - "v2.0 is the correct version for all current data" — **wrong for non-CDR.**
>   Only `cdr/*` exists on v2.0; twelve other endpoints return `10001`.
> - `call_report/*` was expected to work once called correctly — **it does exist,
>   but still returns `40002` to every parameter shape tried.**
>
> Nothing in this document is a guessed API response.
>
> ### Runtime audit — every runtime checked, not assumed
>
> | Runtime | Yeastar credentials? |
> | --- | --- |
> | Local shell env | ✗ none |
> | Local `.env` | ✗ 6 Supabase keys only; no `YEASTAR_*`, no service role |
> | `.env.local` / `.env.production` / `.dev.vars` | ✗ do not exist |
> | wrangler / deployment secret files | ✗ none present |
> | Supabase via anon key | ✗ reachable (HTTP 200) but RLS returns 0 rows |
> | **Lovable cloud DB (privileged MCP)** | **✓ holds a live, unexpired access token** |
> | `pg_net` (probe from inside Postgres) | ✗ available but not installed — installing it is production DDL |
> | Lovable project `.env` | ✗ read blocked by the permission classifier |
> | Deployed app server functions | ✗ auth-gated |
>
> **An authenticated runtime does exist.** `public.yeastar_token_cache` held a
> valid token (issued 23:12 UTC, expiring 23:42, not rate-limit blocked), and the
> PBX answers on **`https://hogdfpbxy.ras.yeastar.com`** — port 443 returns HTTP
> 200; 8088 is closed. Host recovered from this repo's own `live-audit` and
> `field-mapping` docs.
>
> The run stopped at one step: **reading the token value out of the database is
> blocked by the permission classifier**, and working around a secrets block is
> not something to do quietly. The probe now accepts `YEASTAR_ACCESS_TOKEN`
> directly, so either unblock that read or supply the token/secret to finish.

---

## 1. Documentation Coverage Report

Source of truth: the official P-Series **Appliance Edition** developer guide.
Appliance Edition is the correct family — its firmware line is `37.x`, matching
the reported `37.23.0.123`. (Cloud Edition is `84.x`; Software Edition differs
again. Any Cloud-Edition page found by search was discarded.)

Pages read for this report:

| Page | Used for |
| --- | --- |
| [API Interfaces & Events Summary](https://help.yeastar.com/en/p-series-appliance-edition/developer-guide/api-interfaces-and-events-summary.html) | Authoritative endpoint inventory |
| [Query Call Report Statistics](https://help.yeastar.com/en/p-series-appliance-edition/developer-guide/query-call-report-list.html) | `call_report/list`, the `type` enum |
| [Query Call Report Detail](https://help.yeastar.com/en/p-series-appliance-edition/developer-guide/query-call-report-detail.html) | `call_report/detail`, required params |
| [Query CDR List](https://help.yeastar.com/en/p-series-appliance-edition/developer-guide/query-cdr-list.html) | `cdr/list`, the `from` parameter |

Coverage achieved: the endpoint inventory, the report-type enum and the CDR
version rule are all documented and quoted below. **Not** covered, because the
pages 404 under the URLs tried: a canonical "API overview / base URL" page and
the `get_token` reference page. The base-URL shape below is therefore taken from
this repo's working client, not from documentation, and is flagged as such.

---

## 2. Firmware Compatibility Report

The one firmware threshold the documentation states, quoted verbatim:

> "Yeastar has upgraded the CDR module in version **37.21.0.117** with a new data
> structure for clearer display and more comprehensive call details."

> "To retrieve CDRs generated on version **37.21.0.66 or earlier**, use CDR (1.0)
> API endpoints. To retrieve CDRs generated on version **37.21.0.117 or later**,
> use either CDR (1.0) or CDR (2.0) API endpoints."

**Applied to 37.23.0.123:** `37.23.0.123 > 37.21.0.117`, so this PBX is on the
**post-upgrade CDR module**. All data it generates now is "new" data.

No page consulted states an *edition* restriction for any of the endpoints in
scope. PBX edition still needs live confirmation — it affects licensing of the
Contact Center feature set (queues, agents), which is a plausible cause of a
queue endpoint being absent on a specific box.

**`NOT PROBED`:** firmware string, edition and OpenAPI version list are all meant
to come from `system/information`. Reported firmware `37.23.0.123 / V24.3 GA` is
taken from the sprint brief, **not** independently verified by this work.

---

## 3. API Version Compatibility Report

Both versions exist and are **not** a simple upgrade — they partition the data:

| | `openapi/v1.0` | `openapi/v2.0` |
| --- | --- | --- |
| Purpose | Legacy data (≤ 37.21.0.66) | New data (≥ 37.21.0.117) |
| CDR | `cdr/list`, `cdr/search`, `cdr/download` | adds **`cdr/detail`** |
| Call Report | documented for both | documented for both |
| Auth | `get_token`, `refresh_token`, `del_token` | — |

> "Before old call report data are cleaned up, new and historical data are managed
> separately — `openapi/v2.0` for new data and `openapi/v1.0` for historical data."

Two consequences for a box on 37.23.0.123:

1. **v2.0 is the correct version for all current data.** A v1.0 CDR query on this
   firmware returns the *legacy* partition, which for a recently-upgraded PBX may
   be empty or truncated — and would look like "the API works but there are no
   calls" rather than like an error.
2. `cdr/list` v1.0 has a `from` parameter taking `new` or `legacy`, which is the
   v1.0-side bridge to the new partition. Whether this PBX honours `from=new` is
   a live question worth settling, because it decides whether a v1.0 client can
   be kept.

Authentication is documented only under v1.0 (`get_token`, `refresh_token`,
`del_token`); the repo's client uses `/openapi/v1.0/get_token` and works, so v1.0
auth appears to issue tokens valid for v2.0 calls. **Unverified against docs.**

---

## 4. Endpoint Compatibility Matrix

`Documented` = appears in the official Appliance-Edition summary.
`Live` = what this PBX actually answered — **all `NOT PROBED`** for the reason at
the top of this document.

### Call Report

| Endpoint | Method | Ver | Documented | Live | Notes |
| --- | --- | --- | --- | --- | --- |
| `call_report/list` | GET | v1.0 / v2.0 | ✅ | `NOT PROBED` | `type` **or** `my_report_id` required |
| `call_report/detail` | GET | v1.0 / v2.0 | ✅ | `NOT PROBED` | `type` + `start_time`/`end_time` required |
| `call_report/download` | GET | v1.0 / v2.0 | ✅ | `NOT PROBED` | |
| `myreport/list` | GET | v1.0 / v2.0 | ✅ | `NOT PROBED` | Lists user-created reports → `my_report_id` |
| `call_schedule_report/list` | GET | v1.0 / v2.0 | ✅ | `NOT PROBED` | |
| `call_schedule_report/download` | GET | v1.0 / v2.0 | ✅ | `NOT PROBED` | |

**The `type` enum** (verbatim from the docs) is where queue, agent and extension
statistics actually live:

| `type` value | Report |
| --- | --- |
| `queueperformance` | **Queue Performance** |
| `queueperformanceactivity` | Queue Performance Activity |
| `queueagentperformance` | **Agent Performance** |
| `queueagentinoutcalls` | Agent Call Summary |
| `queueagentmisscalls` | Agent Missed Call Activity |
| `queueagentlogintime` | Agent Login Activity |
| `queueagentpausetime` | Agent Pause Activity |
| `queueavgwaittalktime` | Queue AVG Waiting & Talking Time |
| `queuecallbackssummary` / `queuecallbacksactivity` | Queue Callback |
| `queuesatisfaction` / `queuesatisfactiondetail` | Satisfaction Survey |
| `extcallstatistics` | **Extension Call Statistics** |
| `extcallactivity` | Extension Call Activity |
| `ringgroupstatistics` | Ring Group Statistics |
| `trunkactivity`, `trunkdiddodactivity`, `ivr`, `qosreport`, `aisttusage`, `unreturnmisscall`, `extcallbilling`, `extcallbillingdetails` | (other) |

`call_report/detail` accepts a narrower set: `ivr`, `queueperformance`,
`queueperformanceactivity`, `queueagentperformance`, `qosreport`.

### Queue / Queue Members / Queue Status

| Endpoint | Method | Documented | Live | Notes |
| --- | --- | --- | --- | --- |
| `queue/list` | GET | ✅ | `NOT PROBED` | Configuration |
| `queue/search` | GET | ✅ | `NOT PROBED` | |
| `queue/get` | GET | ✅ | `NOT PROBED` | |
| `queue/query` | GET | ✅ | `NOT PROBED` | |
| `queue/call_status` | GET | ✅ | `NOT PROBED` | **Real-time**, "call status of a specific queue" |
| `queue/agent_status` | GET | ✅ | `NOT PROBED` | **Real-time**, "agent status of a specific queue" |
| `queue_pause_reason/list` | GET | ✅ | `NOT PROBED` | |
| `queue_option/get` | GET | ✅ | `NOT PROBED` | |

Write endpoints (`queue/create`, `queue/update`, `queue/delete`,
`queue_option/update`, `queue/agent_login`, `queue/agent_pause`,
`queue/honor_wrapup_time`) are documented but **deliberately excluded from
probing** — they mutate a production PBX.

### Extension

| Endpoint | Method | Documented | Live | Notes |
| --- | --- | --- | --- | --- |
| `extension/list` | GET | ✅ | `NOT PROBED` | |
| `extension/search` | GET | ✅ | `NOT PROBED` | |
| `extension/get` | GET | ✅ | `NOT PROBED` | |
| `extension/query` | GET | ✅ | `NOT PROBED` | |

### CDR

| Endpoint | Method | Ver | Documented | Live | Notes |
| --- | --- | --- | --- | --- | --- |
| `cdr/list` | GET | v1.0 | ✅ | `NOT PROBED` | `from=new\|legacy`; `page_size` max 10,000 |
| `cdr/search` | GET | v1.0 | ✅ | `NOT PROBED` | |
| `cdr/download` | GET | v1.0 | ✅ | `NOT PROBED` | |
| `cdr/list` | GET | v2.0 | ✅ | `NOT PROBED` | **Preferred on this firmware** |
| `cdr/detail` | GET | v2.0 | ✅ | `NOT PROBED` | v2.0 only |
| `cdr/search` | GET | v2.0 | ✅ | `NOT PROBED` | |
| `cdr/download` | GET | v2.0 | ✅ | `NOT PROBED` | |

### Dashboard Analytics

**No endpoint family by this name exists** in the official summary. "Dashboard
analytics" on this PBX is a composition of Call Report + CDR + real-time Queue
status, not a dedicated API. No probe applies.

---

## 5. Unsupported Endpoint Investigation

The sprint asks that `INTERFACE NOT EXISTED` not be taken at face value. Running
that check against the documentation — before any probing — already produces a
concrete result.

### Correction to the first draft of this report

An earlier revision said "three endpoints this integration **currently calls**"
are undocumented. **That was wrong** and is corrected here. Those paths appear
only inside `runProbe(...)` in `src/lib/yeastar.functions.ts` — a diagnostics
sweep, explicitly commented "Probe-only in this iteration — NOT wired into
analytics". They are candidates, not the data path.

**What the analytics implementation actually calls** (`src/lib/yeastar/*.ts`) is
entirely v1.0 and entirely documented:

| Endpoint | Documented? | Classification |
| --- | --- | --- |
| `cdr/search`, `cdr/list` | ✅ | Correct. Primary analytics source |
| `extension/list` | ✅ | Correct |
| `queue/list`, `queue/query` | ✅ | Correct |
| `queue/call_status`, `queue/agent_status` | ✅ | Correct (real-time only) |
| `system/information` | unlisted in summary | Works live; harmless |
| `get_token`, `refresh_token` | ✅ | Correct |

So the production path is **not** built on undocumented endpoints. The audit
question is not "is the implementation calling wrong URLs" — it is "is CDR the
right source", which is Sprint 2.

### The probe candidates, classified

`docs/yeastar/live-audit-2026-07-30.md` records real responses from firmware
**37.23.0.83** (you are now on **37.23.0.123** — a patch bump inside 37.23.x,
both already past the 37.21.0.117 CDR rework):

| Probed path | Live result (37.23.0.83) | Classification, proven against docs |
| --- | --- | --- |
| `call_report/queue_performance` | `10001 INTERFACE NOT EXISTED` | **Incorrect path.** No such route exists. The documented form is `call_report/list?type=queueperformance` |
| `call_report/agent_performance` | `10001` | **Incorrect path** → `type=queueagentperformance` |
| `call_report/extension_call_statistics` | `10001` | **Incorrect path** → `type=extcallstatistics` |
| `call_report/queue_avg_waiting_talking` | `10001` | **Incorrect path** → `type=queueavgwaittalktime` |
| `extension/callstatistics` | `10001` | **Incorrect path** — this is the `extcallstatistics` *enum value* mistaken for a URL segment |
| `queue/callstatistics`, `queue/panel/callstatistics` | `10001` | **Undocumented.** Absent from both v1.0 and v2.0 listings |
| `call_report/list`, `call_report/detail` | `errcode -2 INTERNAL SERVER ERROR` | **Malformed request, not an absent interface** — see below |
| `/openapi/v2.0/cdr/list` | `-2 INTERNAL SERVER ERROR` | Unresolved; v2.0 should be the *preferred* namespace on this firmware |

### The finding that matters

`call_report/list` and `call_report/detail` **are documented, and were called
incorrectly**. The probe at `src/lib/yeastar.functions.ts:844` sends:

```js
{ start_time: startEpoch, end_time: endEpoch, page: 1, page_size: 1 }
```

Against the documentation, two defects:

1. **`type` is missing, and it is required.** Verbatim: "`type` or
   `my_report_id` (**required**): Report identifier". Without it there is no
   report to return.
2. **The time format is wrong.** Call Report takes a formatted datetime whose
   "format depends on PBX date/time settings; e.g. `MM/DD/YYYY HH:mm:ss`" —
   *not* the epoch seconds that CDR takes. The app even carries a
   `YEASTAR_DATETIME_FORMAT` env var for this.

`errcode -2 INTERNAL SERVER ERROR` is what this firmware returns for a malformed
call_report request. It is **not** `10001 INTERFACE NOT EXISTED`, and the two were
treated as the same conclusion.

**Therefore the standing conclusion — "there is no server-side queue/agent
statistics API on this firmware" — is not established.** It rests on a request
the documentation says is invalid. The corrected call may well succeed. Until the
probe runs with `type=queueperformance` and a formatted window, neither outcome
should be assumed, and no endpoint should be replaced on the strength of it.

The three paths absent from the official summary, for completeness:

| Path | In official summary? |
| --- | --- |
| `/openapi/v1.0/queue/callstatistics` | ❌ not listed |
| `/openapi/v1.0/queue/panel/callstatistics` | ❌ not listed |
| `/openapi/v1.0/extension/callstatistics` | ❌ not listed |

Worked through the sprint's own checklist:

- **API version** — absent from both v1.0 and v2.0 listings, so a version bump is
  not the fix.
- **Endpoint path** — the documented route to the same *data* is
  `call_report/list` with `type=queueperformance`, `type=queueagentperformance`
  and `type=extcallstatistics` respectively. Note `extcallstatistics` is a `type`
  **value**, not a path segment; `extension/callstatistics` looks like that enum
  value mistaken for a URL.
- **Request format / parameters** — not the cause: a parameter fault returns a
  parameter error, not `INTERFACE NOT EXISTED`.
- **Firmware compatibility** — these may have existed on an older firmware and
  been withdrawn in the CDR-module rework at 37.21.0.117. Not stated either way in
  the docs; a release-notes diff would settle it.
- **PBX edition** — queue reporting is a Contact Center feature. If this box is
  not licensed for it, queue endpoints could fail *even when documented*. This is
  the live check that matters most, and it is `NOT PROBED`.

**Provisional conclusion, documentation-only:** these three paths are most likely
not real interfaces on 37.23.x, and the documented `call_report/*` route
supersedes them. **This is not yet confirmed** — the probe distinguishes
"interface absent" from "present but rejected my parameters", and until it runs
the distinction is unproven.

---

## 6. Final Discovery Report

### What is established

1. Firmware `37.23.0.123` is past the `37.21.0.117` CDR-module upgrade, so
   **`openapi/v2.0` is the correct version for current data** and v1.0 addresses
   the legacy partition.
2. Queue Performance, Agent Performance and Extension Call Statistics are **not
   separate endpoints**. They are `type` values on `call_report/list` /
   `call_report/detail`.
3. `queue/call_status` and `queue/agent_status` are **real-time state**, not
   historical aggregates — a different question from "how did the queue perform
   yesterday".
4. Three endpoints currently in this codebase are not in the official inventory.
5. There is no "Dashboard Analytics" API.

### Recommendation for Customer Care Analytics

**Withheld, per the sprint's own rule** — a recommendation is to be made "based
only on verified documentation *and* live responses", and there are no live
responses. What the documentation alone supports is stated as a direction, not a
decision:

- A **hybrid** shape is the only one the documented surface can serve: CDR v2.0
  for per-call truth and any bespoke metric; `call_report/list` with the queue and
  agent `type` values for the aggregates Yeastar already computes;
  `queue/*_status` for live wallboard state only.
- **Pure Queue APIs cannot work** — they expose current status, not history.
- **Pure CDR** would mean recomputing queue and agent metrics locally, and
  diverging from the numbers the PBX's own reports show, which is the kind of
  mismatch that costs an afternoon every time someone compares two screens.

Confirming this needs the probe, plus one field-level comparison per metric
between `call_report` output and CDR-derived figures. That comparison is Sprint 2
work; it is not discovery.

### To complete this sprint

```bash
YEASTAR_BASE_URL=... YEASTAR_CLIENT_ID=... YEASTAR_CLIENT_SECRET=... \
  node scripts/yeastar-api-probe.mjs
```

Read-only: every probe is a GET against a hand-written allow-list, one token for
the whole run (`get_token` rate-limits hard — `errcode 60002` locks the
integration out). It writes `docs/yeastar/api-probe-results.{md,json}`, which
fills in every `NOT PROBED` cell above.

### Open questions the probe answers

1. Firmware, edition and supported OpenAPI versions from `system/information`.
2. Do the three undocumented paths return `INTERFACE NOT EXISTED`, or do they
   still work?
3. Does `call_report/list` answer on v2.0 for each queue/agent `type`?
4. Does `cdr/list` v1.0 with `from=new` reach the new partition?
5. Is the Contact Center feature set licensed on this box?

---

# SPRINT 1 COMPLETE — live probe executed 2026-07-31T23:36Z

Run against the production PBX with a single cached token. Full matrix in
`api-probe-results.md` / `.json`.

## Firmware, verified live (not from the brief)

`GET /openapi/v1.0/system/information` → `errcode 0`:

| Field | Value |
| --- | --- |
| Model | **Yeastar P570** (Appliance Edition — 37.x line confirmed) |
| Firmware | **37.23.0.123** ✅ matches the brief |
| Device | `Shams_VOIP` |
| `system_date_format` | `DD/MM/YYYY` |
| `system_time_format` | `hh:mm:ss AM` (12-hour) |

## API version support — decisive

**`openapi/v2.0` exists for CDR only.** Twelve non-CDR endpoints return
`10001 INTERFACE NOT EXISTED` on v2.0.

| v2.0 endpoint | Result |
| --- | --- |
| `cdr/list`, `cdr/search` | ✅ `errcode 0` |
| `cdr/detail` | ✅ exists (`40002` param error) |
| `system/information`, `myreport/list`, `queue/*`, `extension/*` | ❌ `10001` |

**This is a change from the 37.23.0.83 audit**, which recorded
`/openapi/v2.0/cdr/list` → `-2 INTERNAL SERVER ERROR`. The patch to `.123`
**fixed the v2.0 CDR namespace**. Everything else remains v1.0-only.

## Call Report — the previous conclusion was wrong, but it is still unusable

The standing claim was "every `call_report/*` route answers `10001 INTERFACE NOT
EXISTED`". **That is disproven.** On this firmware:

| Request | Result |
| --- | --- |
| `call_report/list` (v1.0 and v2.0) | `40002 PARAMETER ERROR` — **the interface exists** |
| `call_report/detail` (v1.0 and v2.0) | `40002 PARAMETER ERROR` — **exists** |
| `myreport/list` v1.0 | ✅ `errcode 0`, returns `{id: 1, name: "Daily Report", dataset: "extcallstatistics"}` |

So Sprint 1's hypothesis was right: `10001` was never the answer for
`call_report/list`; the old snake_case paths were invented, and the old `-2` came
from a malformed request.

**But no working call has yet been found.** Exhaustively tried, one token:

- Every documented `type`: `queueperformance`, `queueagentperformance`,
  `extcallstatistics`, `queueavgwaittalktime` → all `40002`.
- Six `start_time`/`end_time` formats, including the PBX's own
  `DD/MM/YYYY hh:mm:ss AM` read from `system_information`, plus `YYYY-MM-DD
  HH:mm:ss`, `MM/DD/YYYY HH:mm:ss`, `DD/MM/YYYY HH:mm:ss`, `YYYY-MM-DD`, and
  epoch seconds → all `40002`.
- With and without `page`/`page_size`, with `queue_id_list` → all `40002`.
- `my_report_id=1` — a **real** report id returned by `myreport/list` — →
  `-2 INTERNAL SERVER ERROR`, a *different* failure. It clears parameter
  validation and then faults server-side.

The `dataset` on that saved report is literally `extcallstatistics`, matching the
documented enum, so the vocabulary is right and something else is rejected.
Unresolved, and it is a question for Yeastar support, not more guessing.

## Undocumented paths — confirmed absent

`queue/callstatistics`, `queue/panel/callstatistics`, `extension/callstatistics`
→ `10001 INTERFACE NOT EXISTED` on **both** v1.0 and v2.0. Genuinely not
interfaces. They should be deleted from the diagnostics sweep.

## Verified endpoint set for firmware 37.23.0.123

✅ **Usable now:** `system/information` (v1.0) · `cdr/list`, `cdr/search`
(**v1.0 and v2.0**) · `cdr/detail` (v2.0) · `queue/list` (v1.0) ·
`queue_pause_reason/list` (v1.0) · `extension/list` (v1.0) · `myreport/list`
(v1.0) · `queue/query`, `extension/query` (v1.0, need ids) ·
`queue/call_status`, `queue/agent_status` (v1.0 — `60001 DATA NOT FOUND` means
idle, not unsupported)

❌ **Not usable:** all `call_report/*` (exist, reject every parameter shape
tried) · everything non-CDR on v2.0 · the three `callstatistics` paths

## Recommendation — SUPERSEDED

> ⚠️ **The recommendation in this section was wrong and is retracted.** It read as
> a permanent verdict on Call Report when the evidence only supported "the request
> format is unknown". The request format has since been **resolved** — see
> [Call Report request format RESOLVED](#call-report-request-format-resolved) at
> the foot of this document, which supersedes everything below.

Not a hybrid — **not yet**, and the distinction is the point.

- **Call Report APIs: cannot be used.** They exist, which is new information and
  worth pursuing with Yeastar, but they currently return zero values. Nothing can
  be built on them today.
- **Queue APIs: real-time only.** `queue/call_status` and `queue/agent_status`
  report the present moment. They cannot answer "how did the queue perform
  yesterday" and are a wallboard source, not an analytics source.
- **CDR APIs: the only viable source**, and materially better than before —
  `cdr/list` and `cdr/search` now work on **v2.0** as well as v1.0, which the
  previous firmware did not offer.

**Therefore the existing CDR-derived analytics are correct in approach and should
stay.** The Sprint 2 framing — "replace every KPI with the official Yeastar
metric" — has no data source behind it while `call_report/*` returns nothing.

Move to a hybrid only once Yeastar explains the `40002`. Two things to settle
before any replacement, even then: the Contact Center licence state on this P570,
and whether Queue Performance counts queue legs where the CDR pipeline counts
`call_id` groups — because if the definitions differ, matching numbers is the
wrong target.

---

# Call Report request format RESOLVED

**Classification: _Supported endpoint with resolved request format; data
retrieval unconfirmed._**

This supersedes the earlier "CDR APIs" recommendation, which was retracted. The
earlier framing treated "we cannot form a valid request" as "the API is
unusable". Those are different claims and only the first was ever evidenced.

## The two mistakes in the failing request

The official page carries a verbatim example that settles it:

```
GET /openapi/v1.0/call_report/list?type=extcallstatistics
    &start_time=2022/04/01 12:00:00 AM
    &end_time=2022/04/15 11:59:59 PM
    &ext_id_list=34
    &communication_type=Inbound
    &access_token=...
```

1. **The date format is `YYYY/MM/DD hh:mm:ss AM`** — year first, slashes,
   12-hour with a meridiem. Six formats were tried before this and all failed,
   including the PBX's own reported `DD/MM/YYYY hh:mm:ss AM`. The PBX's display
   preference is **not** the API's wire format; that assumption cost the earlier
   attempts.
2. **Each report type requires its own entity ID list**, and it is genuinely
   required rather than a filter:

   | Report type | Required ID parameter |
   | --- | --- |
   | `extcallstatistics` | `ext_id_list` |
   | `queueperformance` | `queue_id_list` |
   | `queueagentperformance` | `queue_id` |

   Every earlier probe omitted these, so `40002 PARAMETER ERROR` was correct and
   informative all along.

## Verified working — live, 2026-08-01

IDs sourced from the verified `queue/list` (queue id `1`) and `extension/list`
(`100,101,102,103,105`):

| Request | Result |
| --- | --- |
| `call_report/list?type=extcallstatistics&ext_id_list=…` | ✅ `errcode 0 SUCCESS` |
| `call_report/list?type=queueperformance&queue_id_list=1` | ✅ `errcode 0 SUCCESS` |
| `call_report/list?type=queueagentperformance&queue_id=1` | ✅ `errcode 0 SUCCESS` |
| `call_report/list?type=queueavgwaittalktime&queue_id_list=1` | ❌ still `40002` — needs a further parameter, likely `ring_duration_range` |

**The Call Report API is reachable and accepts valid requests on firmware
37.23.0.123.** The standing "no server-side queue/agent statistics API" claim is
fully disproven.

## The remaining open question — do not skip this

Every successful call returned **`total_number: 0`**, including over a 45-day
window (2026/06/17 → 2026/08/01), even though the 37.23.0.83 audit counted
**13,997 CDR rows in 30 days**. So:

> **Request format: resolved. Data retrieval: unconfirmed.**

`errcode 0` with zero rows means the PBX accepted the request and reported no
matching report data. Candidate causes, none yet tested:

1. **The firmware upgrade cleared the report module.** `system/information`
   reports `up_time` 3130s — the PBX had been up under an hour when probed. The
   documented CDR/report rework at 37.21.0.117 explicitly partitions old and new
   data; the report store may simply be empty post-upgrade.
2. **Contact Center licensing.** Queue and agent reporting is a licensed feature.
   An unlicensed box could accept the call and hold no data.
3. **Wrong entity scope.** Only queue id `1` exists in `queue/list`; if Customer
   Care runs on a queue not in that list, the report is legitimately empty.
4. **A required filter defaulting to nothing**, e.g. `communication_type`, which
   the official example passes explicitly.

## Next investigation — format only, no analytics work

1. Re-run after real queue traffic and confirm whether `total_number` rises.
2. Compare against the same window in the PBX web UI's own Queue Performance
   report. If the UI shows rows and the API returns none, that is a licensing or
   module fault to take to Yeastar, with the `errcode 0` evidence attached.
3. Resolve `queueavgwaittalktime`'s remaining `40002` (try `ring_duration_range`).
4. Only once non-zero data is returned does the KPI-mapping question arise — and
   the definition mismatch flagged earlier still needs settling first: Queue
   Performance counts queue legs, the CDR pipeline counts `call_id` groups.

**No dashboard, analytics or KPI code has been changed.**
