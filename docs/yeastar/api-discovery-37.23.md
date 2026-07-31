# Yeastar API Discovery — firmware 37.23.0.123 (V24.3 GA)

**Sprint 1 · Discovery only.** No analytics logic, dashboard calculations or
existing code were changed by this work.

> ## Status: documentation half complete, live half **not run**
>
> This machine has **no Yeastar credentials**. `.env` contains zero `YEASTAR_*`
> variables (they exist only as names in `.env.example`), and the shell has none
> either. Every endpoint probe, the firmware/edition auto-detection and the
> `INTERFACE NOT EXISTED` reproduction therefore **could not be performed here**.
>
> Nothing in this document is a guessed API response. Rows that require the PBX
> are marked `NOT PROBED` and stay that way until someone runs
> `scripts/yeastar-api-probe.mjs` where the credentials live. That script was
> written for this sprint and emits the live half of the matrix directly.

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

**Three endpoints this integration currently calls are absent from the official
Appliance-Edition interface summary.** The summary page was queried explicitly for
each name and returned no match:

| Called by | Path | In official summary? |
| --- | --- | --- |
| `src/lib/yeastar/*` | `/openapi/v1.0/queue/callstatistics` | ❌ not listed |
| `src/lib/yeastar/*` | `/openapi/v1.0/queue/panel/callstatistics` | ❌ not listed |
| `src/lib/yeastar/*` | `/openapi/v1.0/extension/callstatistics` | ❌ not listed |

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
