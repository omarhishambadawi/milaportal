# Sprint 2 — Customer Care Analytics Source Validation

**Scope:** identify the authoritative source for every Customer Care KPI.
**Not in scope, and not done:** no dashboard code, analytics, KPI calculation or
endpoint was changed by this work. The repository tree is unchanged apart from
this document.

- **PBX:** Yeastar P570 `Shams_VOIP`, SN `3633E3461744`, firmware **37.23.0.123**
- **Queue in scope:** `6400` `CC_Team`, id `1`, static agents `4000 4002 4003 4004 4005 4006`
- **Queue config:** `sla_time 60`, `sla_interval 30`, `agent_timeout 30`, `retry_time 30`,
  `wrap_up_time 10`, `max_wait_time 1800`, `ring_strategy rrmemory`, `fail_dest ring_group`
- **PBX display prefs:** `system_date_format DD/MM/YYYY`, `system_time_format hh:mm:ss PM`
- **Probed:** 2026-08-01, read-only GETs only (plus the single `get_token` POST)

---

## 0. Headline

Two results change the picture Sprint 1 left behind.

1. **The Call Report API works.** The `errcode 0 / total_number 0` problem was
   never a data problem — it is a **wrong API version**. `call_report/*` must be
   called on **`openapi/v2.0`**. On `v1.0` the PBX accepts `start_time`/`end_time`,
   silently fails to honour them, and returns `total_number: 0` for every window.
   Evidence in §2.

2. **The CDR pipeline is already correct.** Over the same window, the dashboard's
   CDR-derived Customer Care KPIs match Yeastar's own Queue Performance report
   **exactly** on Total, Answered, Answer Rate, SLA, total waiting time and
   answered waiting time. The only genuine divergence is that **Missed and
   Abandoned use different business definitions** — the populations are identical
   (97 calls both ways), only the split differs.

The one thing CDR **cannot** produce is per-agent missed calls, and that is
structural, not a bug. See §5.

---

## 1. Method

Business definitions were compared before any numbers, per the sprint rule. A
KPI pair is only ever placed side by side in §6 once both sides were shown to
describe the same population.

The comparison window is **July 2026** (`01/07/2026 00:00:00` → `31/07/2026
23:59:59`, PBX-local, UTC+3), with **2026-07-29** and **June 2026** as controls.
All three sources were asked for the same window:

| Source | How it was read | Status |
| --- | --- | --- |
| **CDR API** | `cdr/search` v1.0, epoch seconds, paged to exhaustion → the repo's own unmodified `classifyRecords` + `aggregateClassified` | ✅ obtained |
| **Call Report API** | `call_report/list` **v2.0**, `DD/MM/YYYY hh:mm:ss AM` | ✅ obtained |
| **Yeastar Web UI** | not machine-readable | ❌ **required from you — see §9** |

Row counts retrieved: July 14,294 CDR rows; 2026-07-29 446 rows; June 12,679 rows.

---

## 2. Task 4 — why Call Report returned `errcode 0, total_number = 0`

### Cause: the request was sent to `openapi/v1.0`

`call_report/*` exists on both versions and returns `errcode 0` on both. Only
`v2.0` actually applies the time window.

| Request | Version | Result |
| --- | --- | --- |
| `extcallstatistics`, July window | v1.0 | `errcode 0`, **`total_number 0`** |
| `extcallstatistics`, July window | **v2.0** | `errcode 0`, **`total_number 3`, 1,086 calls** |
| `queueperformance`, July window | v1.0 | `errcode 0`, **`total_number 0`** |
| `queueperformance`, July window | **v2.0** | `errcode 0`, **`total_number 1`, 1,323 calls** |
| `queueagentperformance`, July window | v1.0 | `errcode 0`, **`total_number 0`** |
| `queueagentperformance`, July window | **v2.0** | `errcode 0`, **`total_number 6` agents** |
| `extcallstatistics`, **no window at all** | v1.0 | `errcode 0`, **`total_number 5`** — data returns the moment the window is dropped |

That last row is the proof: on v1.0 the endpoint has data and will return it,
but **any** `start_time`/`end_time` pair reduces the result to zero.

This is the documented v1.0/v2.0 data partitioning — quoted in Sprint 1 for CDR —
applying to Call Report as well: *"new and historical data are managed separately
— `openapi/v2.0` for new data and `openapi/v1.0` for historical data."* A
windowed v1.0 query addresses the legacy (pre-`37.21.0.117`) report partition,
which on this PBX is empty.

### The date format, settled from the PBX itself

The v2.0 validator names the format outright. Verbatim from the live response:

```json
{ "errcode": 40002, "errmsg": "PARAMETER ERROR",
  "invalid_param_list": [
    { "field": "start_time", "valid_msg": "start_time format invalid, valid format: 02/01/2006 03:04:05 PM" },
    { "field": "end_time",   "valid_msg": "end_time format invalid, valid format: 02/01/2006 03:04:05 PM" } ] }
```

`02/01/2006 03:04:05 PM` is Go's reference-time layout, i.e. **`DD/MM/YYYY hh:mm:ss AM|PM`**
— day first, zero-padded 12-hour, meridiem. It agrees with the PBX's own
`system_date_format DD/MM/YYYY` + `system_time_format hh:mm:ss PM`, and it
contradicts Sprint 1's conclusion that the format was `YYYY/MM/DD hh:mm:ss AM`
from the documentation example.

Note `.env` currently carries `YEASTAR_DATETIME_FORMAT="yyyy/MM/dd HH:mm:ss"`,
which is wrong on **both** counts (field order and 24-hour clock). It is unused by
the CDR path, so nothing is broken today — but it must not be trusted by whatever
consumes Call Report later.

### Hypotheses tested and eliminated

The sprint named six candidate causes. Every one was tested live:

| Candidate cause | Verdict | Evidence |
| --- | --- | --- |
| Report database not populated | ❌ **Ruled out** | v2.0 returns 1,323 queue calls and full per-agent detail for the same window |
| Recent firmware upgrade cleared the store | ❌ **Ruled out** | June 2026 (pre-upgrade traffic) returns 1,052 queue calls on v2.0 |
| Reporting engine delay | ❌ **Ruled out** | Same-day window (`2026-08-01`) returns 30 calls |
| Licensing (Contact Center) | ❌ **Ruled out** | Queue Performance, Agent Performance and Avg Wait/Talk all return licensed-feature data |
| Queue configuration | ❌ **Ruled out** | Only queue id `1` exists and it is the queue in question; it returns data |
| Required report generation | ❌ **Ruled out** | `call_schedule_report/list` → `total_number 0` (no scheduled jobs) yet reports still return data on demand |
| Wrong date format | ❌ **Ruled out as the cause of the zero** | All six formats returned `errcode 0 / total 0` on v1.0 — the zero is format-independent |
| **Wrong API version** | ✅ **CONFIRMED CAUSE** | v1.0 zero / v2.0 populated, identical params, same token, same window |

### Two secondary faults, also resolved

- **`queueavgwaittalktime` required a `time` parameter.** The PBX said so
  directly: `"time must required when type is queueavgwaittalktime"`. With
  `time=1` it returns data. Sprint 1's guess of `ring_duration_range` was wrong.
- **`my_report_id=1` still returns `errcode -2 INTERNAL SERVER ERROR`** on both
  versions. Unresolved; it is not needed, since the `type` enum covers the same
  datasets. Carried to Open Issues.

Also worth recording: a **bogus** `type` returns `errcode -2`, while a **bogus**
`ext_id_list` returns `errcode 0 / total 0`. So the PBX validates the report type
but not entity ids — an empty result never distinguishes "no data" from "wrong id".

---

## 3. Task 1 — Customer Care KPI definitions

Every KPI rendered on `/calls/customer-care`, with the definition the code
actually implements (not the label on the card). Sources:
`src/features/call-center/*`, `src/lib/yeastar/stats.server.ts`,
`src/lib/yeastar/normalize.ts`.

### 3.1 Overview / Service level / Queue statistics

| # | KPI (UI label) | Business definition | Source definition | Calculation method | Data source today |
| --- | --- | --- | --- | --- | --- |
| K1 | Total calls | Operational calls in scope | One `call_id` group, Internal / IVR-only / system events excluded | `totals.total` — count of normalized calls after direction + queue + scope filters | CDR |
| K2 | Answered calls | A **human agent** picked up | ≥1 leg whose `call_to_number` is on the extension roster with `disposition ANSWERED`. An `ANSWERED` IVR leg does **not** count | `outcome === "answered"` | CDR |
| K3 | Answer rate | Answered ÷ total | Denominator is **all** in-scope calls, inbound + outbound | `answered / total × 100` | CDR |
| K4 | Avg talk time | Mean conversation length on answered calls | Agent-leg `talk_duration`, counted once per call | `talkSeconds / answered` | CDR |
| K5 | SLA (answered ≤ 60s) | Share of queue calls answered inside the target | Target = `slaSeconds` (60, matching queue `sla_time`) | `slaAnsweredWithin / (inboundAnswered + missed + abandoned) × 100` | CDR |
| K6 | Within SLA | Count answered inside the target | Queue-leg `ring_duration ≤ 60` **and** answered | `slaAnsweredWithin` | CDR |
| K7 | Average queue wait | Mean caller wait | **Queue**-leg `ring_duration`, averaged over every call that reached a queue (answered *and* unanswered) | `waitSeconds / queueWaitCount` | CDR |
| K8 | Queue calls | Calls that reached a queue | ≥1 leg whose destination is on the queue roster | `reachedQueue` count | CDR |
| K9 | Missed queue calls | Queued, no agent answered, caller waited **≥ 5s** | Queue leg `NO ANSWER` and `ring_duration ≥ 5` | `outcome === "missed"` | CDR |
| K10 | Abandoned calls | Queued, no agent answered, caller hung up **< 5s** | Queue leg `NO ANSWER` and `ring_duration < 5` | `outcome === "abandoned"` | CDR |
| K11 | Queue answer rate | Answered ÷ calls offered to agents | Denominator excludes calls that never queued | `inboundAnswered / (inboundAnswered + missed + abandoned) × 100` | CDR |
| K12 | Inbound calls | Direction inbound after correction | `call_type`, overruled to Outbound/Internal when the caller is one of our own extensions | `totals.inbound` | CDR |
| K13 | Outbound calls | Direction outbound | as above | `totals.outbound` | CDR |
| K14 | Total talk duration | Sum of agent-leg talk | Counted once per call | `talkSeconds` | CDR |
| K15 | IVR-only *(reported, not shown)* | Caller hung up inside the IVR | Never reached a queue or agent — deliberately **not** Missed | exclusion ledger | CDR |

### 3.2 Realtime queue (six tiles)

| # | KPI | Business definition | Source definition | Method | Source |
| --- | --- | --- | --- | --- | --- |
| K16–K18 | Waiting / Active / Ringing | Calls in each state **right now** | `waiting_list` / `active_list` / `ringing_list` | Live scalars off the PBX | `queue/call_status` v1.0 |
| K19–K21 | Agents ready / busy / paused | Agent state **right now** | `queue/agent_status.data` | Live | `queue/agent_status` v1.0 |

These are point-in-time state, not history. No historical source can produce them
and they are excluded from the validation matrix.

### 3.3 Agent performance table

| # | KPI | Business definition | Source definition | Method | Source |
| --- | --- | --- | --- | --- | --- |
| K22 | Agent total | Calls this agent took part in | One contribution per (call, agent) | `participantsOf()` | CDR |
| K23 | Agent answered | Calls this agent personally answered | That agent's own leg answered | per-agent `answered` | CDR |
| K24 | **Agent missed** | This agent's phone rang and they did not pick up | Agent leg present with a non-answered disposition | per-agent `missed` | **CDR — structurally unavailable, see §5** |
| K25 | Agent talk / avg talk / avg ring | Durations from that agent's own leg | agent-leg `talk_duration` / `ring_duration` | per-agent sums | CDR |

---

## 4. Task 2 — business-definition comparison *before* numbers

### 4.1 Definitions that MATCH — safe to compare numerically

| Dashboard KPI | Yeastar Queue Performance field | Both mean |
| --- | --- | --- |
| K1 Queue calls (queue-filtered) | `total_calls` | Every call that entered the queue |
| K2 Answered | `answered_calls` | An agent picked up |
| K11 Queue answer rate | `answered_rate` | answered ÷ total queue calls |
| K5 SLA | `sla` | answered within `sla_time` ÷ **total** queue calls |
| K7 Average queue wait | `all_call_average_waiting_time` | mean wait over **all** queue calls |
| K14 waitSeconds | `total_waiting_time` | sum of wait over all queue calls |

### 4.2 Definitions that DIFFER — must NOT be compared as-is

| # | Dashboard | Yeastar | Nature of the difference |
| --- | --- | --- | --- |
| **D1** | **K9 Missed** = queued, unanswered, wait **≥ 5s** | `missed_calls` = queue released the call without the caller hanging up (routed to `fail_dest`) | **Different partition of the same population.** We split by a *duration threshold*; Yeastar splits by *who ended the call*. |
| **D2** | **K10 Abandoned** = queued, unanswered, wait **< 5s** | `abandoned_calls` = **caller hung up while waiting**, any duration | Same as D1. Yeastar's Abandoned ≈ our Missed **+** our Abandoned. |
| **D3** | K7 Average queue wait = over **all** queue calls | `average_waiting_time` = over **answered** calls only | Yeastar publishes both; the UI headline is the answered-only one. Our card matches Yeastar's `all_call_average_waiting_time`, not its `average_waiting_time`. |
| **D4** | K22 Agent total = calls the agent **took part in** | `total_calls` = answered **+** ring-no-answer for that agent | Ours cannot include ring-no-answer (§5). |
| **D5** | K14 Talk = **every** answered agent leg summed | `total_talking_time` = the answering agent only | On a transferred call we count both legs; Yeastar counts one. |
| **D6** | Answer rate K3 = answered ÷ (inbound **+ outbound**) | Queue reports are inbound-only | Compare K11 (queue answer rate), never K3. |

**Consequence:** Missed and Abandoned are the only Customer Care KPIs where the
dashboard and the PBX disagree — and they disagree by *definition*, not by
arithmetic. Neither is "wrong"; they answer different questions.

---

## 5. The structural limit of CDR — per-agent missed calls

Measured directly over the July CDR (14,294 rows):

```
leg roles:                      queue 1,323   agent 1,248   other 11,723
QUEUE-leg dispositions:         ANSWERED 1,226   NO ANSWER 97
INBOUND agent-leg dispositions: ANSWERED 1,231   ← and nothing else
```

**There are zero inbound agent legs with `NO ANSWER`.** This firmware writes an
agent-leg CDR row only when the agent *answers*. When the queue rings an agent
who does not pick up and moves on, no row is produced.

Therefore per-agent missed calls (K24) are **not derivable from CDR at all**, and
the dashboard's per-agent `missed` column is permanently `0`. It is not a parsing
bug — the data does not exist.

Call Report supplies it. For July, queue 6400:

| Agent | Yeastar `missed_calls` | Dashboard per-agent missed |
| --- | --- | --- |
| 4000 | 0 | 0 |
| 4002 | **13** | 0 |
| 4003 | **11** | 0 |
| 4004 | **5** | 0 |
| 4005 | **6** | 0 |
| 4006 | **36** | 0 |

4006 missing 36 rings in a month is an operational signal the dashboard is
currently blind to.

---

## 6. Task 5 — Validation Matrix

**Window:** July 2026, queue `6400` CC_Team. Yeastar UI column is pending (§9).
Per the sprint rule, no row is marked PASS/FAIL where the definitions differ —
those are `DEFINITION MISMATCH`.

| KPI | Dashboard (CDR) | Call Report (v2.0) | Yeastar UI | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Queue calls | **1,323** | **1,323** | *pending* | ✅ **PASS** | Exact |
| Answered | **1,226** | **1,226** | *pending* | ✅ **PASS** | Exact |
| Queue answer rate | **92.67%** | **92.67%** | *pending* | ✅ **PASS** | Exact to 2dp |
| SLA attainment | **89.34%** | **89.34%** | *pending* | ✅ **PASS** | Exact. 1,182 answered ≤60s ÷ 1,323 |
| Within SLA (count) | **1,182** | not published | *pending* | ✅ **PASS** | Independently recomputed from queue-leg ring ≤60s |
| Total waiting time | **23,735s** | **23,735s** | *pending* | ✅ **PASS** | Exact |
| Answered waiting time | **17,322s** | **17,322s** | *pending* | ✅ **PASS** | Exact |
| Avg queue wait (all calls) | **17.9s** | **17s** | *pending* | ✅ **PASS** | Yeastar publishes an integer; 23,735÷1,323 = 17.94 |
| Avg queue wait (answered) | not shown | **14s** | *pending* | ⚠️ **GAP** | D3 — dashboard shows only the all-call variant |
| Max waiting time | not shown | **455s** | *pending* | ⚠️ **GAP** | Longest *unanswered* wait; confirmed against CDR |
| Unanswered queue calls (total) | **97** | **97** | *pending* | ✅ **PASS** | 95 missed + 2 abandoned = 1 missed + 96 abandoned |
| **Missed** | **95** | **1** | *pending* | ⛔ **DEFINITION MISMATCH** | D1 — not comparable |
| **Abandoned** | **2** | **96** | *pending* | ⛔ **DEFINITION MISMATCH** | D2 — not comparable |
| Avg talk time | **105.1s** | **104s** | *pending* | ⚠️ **INVESTIGATE** | D5 — +1.0% |
| Total talk time | **128,870s** | **127,625s** | *pending* | ⚠️ **INVESTIGATE** | D5 — +1,245s (+0.98%), consistent with 4 transferred calls double-counted |
| Per-agent answered (sum) | **1,230** | **1,226** | *pending* | ⚠️ **INVESTIGATE** | +4 — same transfer effect; **platform totals are unaffected** |
| Per-agent missed | **0** (all agents) | **71** total | *pending* | ⛔ **NOT DERIVABLE** | §5 — CDR has no such row |
| Extension Call Statistics | 1,879 calls / 1,649 ans | 1,807 calls / 1,655 ans | *pending* | ⛔ **NOT YET ALIGNED** | Different populations; see Open Issue O4 |

### Control windows

| Window | Metric | Dashboard | Call Report | Match |
| --- | --- | --- | --- | --- |
| 2026-07-29 | Queue calls | 35 | 35 | ✅ |
| 2026-07-29 | Answered | 27 | 27 | ✅ |
| 2026-07-29 | Answer rate | 77.14% | 77.14% | ✅ |
| 2026-07-29 | SLA | 77.14% | 77.14% | ✅ |
| 2026-07-29 | Avg wait (all) | 26.6s | 26s | ✅ |
| 2026-07-29 | Missed / Abandoned | 8 / 0 | 0 / 8 | ⛔ D1/D2 |
| June 2026 | Queue calls | 1,052 | 1,052 | ✅ |
| June 2026 | Answered | 1,001 | 1,001 | ✅ |
| June 2026 | Answer rate | 95.15% | 95.15% | ✅ |
| June 2026 | SLA | 92.59% | 92.49% | ⚠️ 1 call apart (O3) |
| June 2026 | Missed / Abandoned | 51 / 0 | 0 / 51 | ⛔ D1/D2 |

Three independent windows agree on the headline figures. This is not a
coincidence of one window.

---

## 7. Task 3 — Source of Truth Matrix

| KPI | Recommended source of truth | Why |
| --- | --- | --- |
| Queue calls (K1/K8) | **CDR** | Exact parity, and CDR supports arbitrary windows, per-call drill-down and export |
| Answered (K2) | **CDR** | Exact parity |
| Queue answer rate (K11) | **CDR** | Exact parity |
| SLA attainment / Within SLA (K5, K6) | **CDR** | Exact parity, and CDR lets the target be re-run at other thresholds; Call Report is fixed at the queue's `sla_time` |
| Avg queue wait — all calls (K7) | **CDR** | Exact parity, sub-second precision (Call Report rounds to integer seconds) |
| Avg queue wait — answered only | **Call Report** `average_waiting_time` | Not currently computed from CDR; trivially derivable, but Call Report is authoritative today |
| Max waiting time | **Call Report** `max_waiting_time` | Not currently computed |
| Avg / total talk (K4, K14) | **CDR**, after resolving D5 | Parity within 1%; the gap is our transfer handling, which is a decision to make, not a defect to inherit |
| **Missed / Abandoned (K9, K10)** | **Call Report** `queueperformance` | **Yeastar's split is the operationally meaningful one** — "the caller gave up" vs "the queue gave up". Our 5-second threshold is arbitrary and has no counterpart in any report the business will ever see. Adopt Yeastar's definition. |
| **Per-agent missed (K24)** | **Call Report** `queueagentperformance` | **CDR physically cannot supply it** (§5) |
| Per-agent answered / talk (K23, K25) | **CDR** | Parity; keeps per-agent drill-down to individual calls |
| Inbound / outbound split (K12, K13) | **CDR** | Queue reports are inbound-only |
| IVR-only (K15) | **CDR** | No Call Report equivalent |
| Realtime tiles (K16–K21) | **Queue API** (`queue/call_status`, `queue/agent_status`) | Only source of present-moment state |
| Conversion / revenue | **Supabase orders** | Not a PBX metric |

### Verdict: **HYBRID**

- **CDR** — the primary source, and it stays primary. It is the only source with
  per-call granularity, arbitrary windows, direction splits, IVR-only visibility
  and a drill-down path.
- **Call Report v2.0** — authoritative for the queue's own Missed/Abandoned
  split, per-agent missed, answered-only average wait, and max wait.
- **Queue API** — realtime tiles only. It cannot answer a historical question.

Pure Call Report is not viable: it is inbound/queue-only, integer-rounded, has no
per-call detail, and cannot express the IVR-only or direction-correction rules
the business already depends on. Pure CDR is not viable either, because of §5.

---

## 8. Open Issues List

| ID | Severity | Issue | Evidence | Proposed resolution |
| --- | --- | --- | --- | --- |
| **O1** | **High** | Missed/Abandoned definitions are inverted relative to the PBX. Anyone comparing the dashboard to a Yeastar report sees 95 vs 1 and 2 vs 96. | §4.2 D1/D2; three windows | Adopt Yeastar's definition (Abandoned = caller hung up; Missed = queue released). ~~Sprint 3 decision — not made here.~~ **Adopted in Sprint 3.5 — see §10.** |
| **O2** | **High** | Per-agent missed is permanently 0; 71 missed rings in July are invisible. | §5 | Source K24 from `queueagentperformance`. Requires a new Call Report client. |
| **O3** | Low | June SLA differs by one call (92.59% vs 92.49%). | §6 controls | Likely a window-boundary call. Re-check with the boundary probe already in `kpi-validation.server.ts`. |
| **O4** | Medium | Extension Call Statistics is not yet definition-aligned with our extension-scoped totals (1,807 vs 1,879 calls). | §6 | Not a defect — the populations were never aligned. Needs its own definition pass before any comparison. |
| **O5** | Medium | Talk seconds run +0.98% high; per-agent answered sums +4 against queue answered. | §6 | Confirm the transfer hypothesis (calls with two answered agent legs) and decide whether a transferred call credits one agent or both. Platform totals are unaffected. |
| **O6** | Medium | `YEASTAR_DATETIME_FORMAT="yyyy/MM/dd HH:mm:ss"` in `.env` / `.env.example` is wrong on both field order and clock. | §2 | Correct to `dd/MM/yyyy hh:mm:ss a` **when** Call Report is wired in. Harmless today — nothing reads it. |
| **O7** | Low | `my_report_id=1` returns `errcode -2 INTERNAL SERVER ERROR` on both versions. | §2 | Not needed; the `type` enum covers the same datasets. Raise with Yeastar only if saved reports are ever wanted. |
| **O8** | Low | A bogus `ext_id_list` returns `errcode 0 / total 0`, identical to a genuinely empty result. | §2 | Any future Call Report client must validate entity ids itself — an empty response is not evidence of no data. |
| **O9** | Low | `queueavgwaittalktime` over a July window returned an extra `time: 8` (August) bucket of 25 calls. | §2 | Window-edge/timezone handling in the report engine. Confirm before relying on bucketed output. |
| **O10** | Info | Sprint 1's `api-discovery-37.23.md` states Call Report is "resolved format, data retrieval unconfirmed" and that v2.0 is CDR-only. Both are now superseded. | §2 | Superseded by this document. Left in place per the Sprint 1 convention of preserving overturned conclusions. |

---

## 9. What is needed from the Yeastar Web UI

The third validation source cannot be read programmatically. **Please supply the
following**, and the matrix in §6 will be completed against it.

### 9.1 Reports → Queue → **Queue Performance**

- **Queue:** `CC_Team (6400)`
- **Date range:** `01/07/2026 00:00:00` → `31/07/2026 23:59:59`
- **Values needed:** Total Calls · Answered Calls · Missed Calls · Abandoned Calls ·
  Answered Rate · Missed Rate · Abandoned Rate · Average Waiting Time ·
  Average Talking Time · Max Waiting Time · SLA

*Expected from the API, for cross-check: 1,323 / 1,226 / 1 / 96 / 92.67% / 0.08% /
7.26% / 14s / 104s / 455s / 89.34%.*

### 9.2 Reports → Queue → **Agent Performance**

- Same queue and date range.
- **Per agent (4000, 4002, 4003, 4004, 4005, 4006):** Total Calls · Answered Calls ·
  Missed Calls · Average Talking Time · Total Talking Time · Average Waiting Time

*Expected Missed: 4000→0, 4002→13, 4003→11, 4004→5, 4005→6, 4006→36.*

### 9.3 Reports → Extension → **Extension Call Statistics**

- **Extensions:** 4000, 4002, 4003, 4004, 4005, 4006
- Same date range, **communication type = All**, then repeated for **Inbound** and
  **Outbound** separately.
- **Values:** Total Calls · Answered · No Answer · Busy · Voicemail · Abandoned ·
  Total Talking Time · Total Holding Time

### 9.4 The definitions themselves — the most important item

Please confirm, from the UI's own tooltips/help or from Yeastar support:

1. **What exactly does the UI count as a "Missed" queue call?** Our reading is
   "the queue released the call to the failover destination". Confirm or correct.
2. **What exactly does it count as "Abandoned"?** Our reading is "the caller hung
   up while waiting, regardless of how long they waited".
3. Is **Average Waiting Time** on the Queue Performance screen the answered-only
   figure (14s) or the all-calls figure (17s)?

O1 cannot be resolved without answer 1 and 2. Everything else in Sprint 3 can
proceed without them.

> **Superseded by Sprint 3.5.** O1 was resolved by business decision rather than
> by confirmation: the dashboard now reports Yeastar's split verbatim, because
> supervisors reconcile the page against the PBX's own Queue panel and a
> dashboard that disagrees with it on Abandoned cannot be used for that. Answers
> 1 and 2 above are still worth obtaining — they would let us describe the
> figures precisely rather than merely mirror them — but nothing is blocked on
> them now. See §10, row O1.

### 9.5 A screenshot is fine

A screenshot of each of the three report screens for that date range answers all
of §9.1–9.3 at once.

---

## 10. Confirmation of sprint constraints

- ✅ No dashboard code modified
- ✅ No analytics refactored
- ✅ No KPI calculation changed
- ✅ No endpoint replaced
- ✅ All PBX access read-only (GET; the sole POST is `get_token`)
- ✅ Every conclusion backed by a live response or a documented quote
- ✅ No KPI marked PASS/FAIL where business definitions differ

**Sprint 2 ends here. Awaiting approval before Sprint 3.**

---

## 11. Sprint 3 status of the Open Issues

Sprint 3 (Customer Care Analytics Refactor) built the Metrics Engine on the
findings above. Current state of §8:

| ID | Status after Sprint 3 |
| --- | --- |
| **O1** | **Resolved in Sprint 3.5** (was: still open, blocked on §9.4). The dashboard now reports Yeastar's split — `resolveQueueOutcomeSplit` in `metrics-engine.ts` takes Missed/Abandoned from `queueperformance` whenever Call Report applies, and falls back to the CDR wait threshold with `sources.queueOutcome: "cdr"` when it does not. The population stays CDR's, so `answered + unansweredTotal === queueCalls` still holds. CDR's own split is retained on `UnansweredSplitComparison` (`cdrMissed` / `cdrAbandoned`), shown in a collapsed info banner when the two differ, and exported on the "Missed vs Abandoned (O1)" sheet. Pinned by `yeastar-parity.test.ts`. |
| **O2** | **Resolved.** Per-agent missed calls now come from `queueagentperformance` on `openapi/v2.0` via `call-report.server.ts`. When unavailable the column renders "—", never a zero. |
| **O3** | Still open. One-call SLA difference on the June window; needs the boundary probe. |
| **O4** | Still open. Extension Call Statistics remains definition-unaligned and is not consumed. |
| **O5** | Still open. Talk +0.98% / per-agent answered +4, consistent with transferred calls crediting two agents. Platform totals unaffected. |
| **O6** | **Resolved.** `call-report.server.ts` hard-codes `DD/MM/YYYY hh:mm:ss AM\|PM` as an API constant and never reads `YEASTAR_DATETIME_FORMAT`; `.env.example` now documents why that variable must stay unused. |
| **O7** | Still open, not needed. `my_report_id` is unused. |
| **O8** | **Mitigated.** The client requires a resolved numeric `queueId` and reports "unavailable" rather than treating an empty response as zero. |
| **O9** | Still open. `queueavgwaittalktime` bucketing is not consumed. |
| **O10** | **Resolved.** Supersession recorded in `api-discovery-37.23.md`. |

Two rows the §6 matrix marked ⚠️ **GAP** are also closed — **avg wait
(answered)** and **max wait** are now derived from CDR rather than read from
Call Report, and both are asserted against the PBX's own figures in
`src/lib/yeastar/__tests__/yeastar-parity.test.ts`.
