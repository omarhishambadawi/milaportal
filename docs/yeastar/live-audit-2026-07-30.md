# Yeastar live API audit — 2026-07-30

**PBX:** `hogdfpbxy.ras.yeastar.com` — Yeastar **P570**, firmware **37.23.0.83**, device `Shams_VOIP`
**Evidence:** 13,997 CDR rows over a 30-day window (2026-06-30 → 2026-07-30), plus a
27-endpoint capability sweep. Redacted samples are in `./samples/`.

Every statement below was verified against the live PBX. Nothing here is taken from Yeastar's
published documentation.

---

## 1. Supported APIs on this firmware

Probed 27 endpoints with a live token. `errcode: 10001 INTERFACE NOT EXISTED` is the firmware's
"not implemented" signal.

### Supported

| Endpoint                               | Array field                                     | Purpose                                                                |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /openapi/v1.0/get_token`         | —                                               | Auth. Rate-limited (`60002`)                                           |
| `POST /openapi/v1.0/refresh_token`     | —                                               | Token refresh                                                          |
| `GET /openapi/v1.0/system/information` | `data` (object)                                 | Model + firmware                                                       |
| `GET /openapi/v1.0/cdr/search`         | `data`                                          | **Primary analytics source.** `start_time`/`end_time` as epoch seconds |
| `GET /openapi/v1.0/cdr/list`           | `data`                                          | Same row schema, no date filter                                        |
| `GET /openapi/v1.0/extension/list`     | `data`                                          | **Authoritative extension roster**                                     |
| `GET /openapi/v1.0/queue/list`         | `queue_list`                                    | **Authoritative queue roster** + members                               |
| `GET /openapi/v1.0/queue/query`        | `data`                                          | Queue config. Requires **`ids`**, not `queue_id`                       |
| `GET /openapi/v1.0/queue/call_status`  | `waiting_list` / `active_list` / `ringing_list` | Realtime queue calls                                                   |
| `GET /openapi/v1.0/queue/agent_status` | `data`                                          | Realtime agent status                                                  |
| `GET /openapi/v1.0/call/query`         | —                                               | Active calls                                                           |
| `GET /openapi/v1.0/trunk/list`         | `data`                                          | Trunk roster                                                           |
| `GET /openapi/v1.0/recording/list`     | `data`                                          | Recording index                                                        |

> `queue/call_status` and `queue/agent_status` returned `errcode 60001 DATA NOT FOUND` during the
> audit. That is **not** an unsupported endpoint — the response carries the full field skeleton and
> simply means the queue was idle and no agent was signed in at that moment. Both were re-probed
> with `queue_id`, `queue`, `queue_number` and no parameters; all four behave identically.

### Not supported — `10001 INTERFACE NOT EXISTED`

`cdr/detail` · `queue/callstatistics` · `queue/panel/callstatistics` ·
`call_report/queue_performance` · `call_report/agent_performance` ·
`call_report/extension_call_statistics` · `call_report/queue_avg_waiting_talking` ·
`extension/callstatistics` · `event/list` · `event_center/event/list` · **`extension_group/list`**

### Not usable — other failures

| Endpoint                           | Result                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `/openapi/v2.0/cdr/list`           | `errcode -2 INTERNAL SERVER ERROR` — v2.0 namespace is not functional |
| `/openapi/v1.0/call_report/list`   | `errcode -2 INTERNAL SERVER ERROR`                                    |
| `/openapi/v1.0/call_report/detail` | `errcode -2 INTERNAL SERVER ERROR`                                    |
| `/openapi/v1.0/subscribe`          | HTTP 400 to a read probe                                              |

**Consequence:** there is **no** server-side queue/agent statistics API and **no** event-push API on
this firmware. Every historical KPI must be derived from CDR. `extension_group/list` is confirmed
absent, matching the standing constraint.

---

## 2. The structural finding: an inbound call is not one CDR row

A single inbound call emits **one row per routing stage**, all sharing `call_id`:

```
call_id 1782844637.854
  row 1  call_to "IVR Welcome_AR_EN<6200>"   ANSWERED           talk 13
  row 2  call_to "IVR Main_AR<6201>"         ANSWERED           talk 5
  row 3  call_to "Queue CC_Team<6400>"       ANSWERED  ring 11  talk 74
  row 4  call_to "Shams Rafiq<4005>"         ANSWERED  ring 11  talk 74
```

Two properties of this shape break naive parsing:

1. **`disposition: "ANSWERED"` on an IVR row means the auto-attendant picked up**, not a human.
2. **`talk_duration` repeats down the chain** — the queue row and the agent row both report 74s.

Leg distribution across the 9,239 inbound rows:

| Leg kind            | Rows  |
| ------------------- | ----- |
| IVR                 | 6,121 |
| Queue               | 1,285 |
| Agent extension     | 1,197 |
| Satisfaction survey | 543   |
| Other               | 93    |

Grouping: 13,997 rows → **7,769 calls** (avg 1.80 legs; inbound queue calls run 5–6 legs).

---

## 3. Fields that do not exist on this firmware

Zero occurrences across all 13,997 rows — yet every one of them was read by
`src/lib/yeastar/stats.server.ts` at the time of the audit (all removed in §7):

`wait_time` · `agent_ring_time` · `last_participant_number` · `last_participant` ·
`final_participant` · `answer_by` · `answered_by` · `agent_number` · `dst` · `dst_num` ·
`dst_number` · `linkedid` · `linked_id` · `id`

The inbound agent-resolution chain in `agentExtFor()` tries nine of these in priority order before
falling through to `call_to_number`. Since all nine are absent, **it always falls through** — and
`call_to_number` on an IVR row is the IVR number, on a queue row the queue number.

### `uid` is a call id, not a row id

`classifyRecords()` de-duplicated rows on `uid ?? new_id ?? id`. On this firmware:

| Field    | Distinct values across 13,997 rows | Meaning                   |
| -------- | ---------------------------------- | ------------------------- |
| `uid`    | **7,769** — exactly the call count | Call-level correlation id |
| `new_id` | **13,997** — one per row           | The row-unique id         |
| `id`     | absent                             | —                         |

All six legs of call `1782844637.854` carry the identical `uid` `2026063021371710F70` and six
different `new_id` values. De-duplicating on `uid` therefore **discards every leg after the first**,
which — since the first leg is always the IVR — removes the queue and agent legs from the record set
entirely. `new_id` is the correct de-duplication key.

---

## 4. Verified answers to the six field questions

| Question                   | Answer                                                                                                                           | Evidence                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Answering extension**    | `call_to_number` **of the agent leg only** — the leg whose `call_to_number` is in `/extension/list`. No single field carries it. | 1,197 agent legs; `call_to` renders as `Name<ext>`                                                           |
| **Queue wait time**        | `ring_duration` **on the queue leg**                                                                                             | Present on 100% of the 1,285 queue legs                                                                      |
| **Agent ring time**        | `ring_duration` **on the agent leg** — a different number                                                                        | Queue-leg ring ≠ agent-leg ring on 101 of 1,192 answered queue calls (queue had already tried another agent) |
| **Linked call identifier** | `call_id`                                                                                                                        | Present on 100% of rows                                                                                      |
| **Queue identifier**       | `call_to_number` matched against `/queue/list` → only `6400` (CC_Team) exists                                                    | `queue/list`                                                                                                 |
| **Caller / callee**        | `call_from_number` / `call_to_number`; `did_number` for the inbound DID; `dod_number` for outbound caller ID                     | 100% / 100% / 66% / 33.9%                                                                                    |

Field presence census (of 13,997 rows): `time`, `call_from`, `call_to`, `timestamp`, `uid`,
`disposition`, `call_type`, `call_from_number`, `call_to_number`, `call_id`, `did`, `new_id`,
`pin_code` at **100%**; `duration` 98.5%; `talk_duration` 85.5%; `src_trunk`/`did_number` 66.0%;
**`ring_duration` 52.0%** (absent on IVR legs, present on every queue leg); `record_file` 38.5%;
`dod_number`/`dst_trunk` ~33.9%.

---

## 5. Root cause analysis — measured KPI error

Both columns below were produced by running code over the same 13,997 live rows: the left by a
faithful replication of `classifyRecords` + `aggregateClassified`, the right by
`src/lib/yeastar/normalize.ts`.

| KPI                     | Current parser | Correct     | Delta                     |
| ----------------------- | -------------- | ----------- | ------------------------- |
| Total calls             | 7,761          | 7,761       | 0                         |
| Inbound                 | 3,026          | 3,026       | 0                         |
| Outbound                | 4,735          | 4,735       | 0                         |
| **Answered**            | **6,026**      | **4,192**   | **−1,834**                |
| **Missed**              | **0**          | **91**      | **+91**                   |
| **Abandoned**           | **0**          | **2**       | **+2**                    |
| **Talk seconds (all)**  | **274,735**    | **356,355** | **+81,620**               |
| — inbound talk          | 43,911         | 125,531     | **+81,620 (2.86×)**       |
| — outbound talk         | 230,824        | 230,824     | **0 — unchanged**         |
| IVR-only (never queued) | —              | 1,741       | counted as Answered today |
| Avg queue wait          | 0.03s          | 17.7s       | wait is effectively lost  |
| Answer rate             | 77.6%          | 54.0%       | −23.6pp                   |
| Avg talk (answered)     | 45.6s          | 85.0s       | +39.4s                    |

### Root cause 1 — `uid` de-duplication silently discards every leg but the first

`classifyRecords()` de-duplicates on `uid ?? new_id ?? id`. `uid` is a **call** id, so this keeps
exactly one row per call. Measured: 13,984 non-internal rows → **7,761 surviving rows → 7,761
groups, every one of them a single leg**:

```
legs/group histogram after the current dedup:  { "1": 7761 }
```

The row that survives is the earliest — for inbound, always the **IVR** leg. So the queue leg and
the agent leg never reach the aggregator at all. This makes the entire multi-leg machinery below it
(correlation grouping, the 120-second sliding fingerprint, the cross-leg talk summing, the
transfer-dedup fingerprint) dead code: it only ever sees groups of one.

### Root cause 2 — the surviving leg is an IVR leg

**Answered — over-counted by 1,834.** The surviving IVR leg carries `disposition: "ANSWERED"`, so
`anyAnswered` is true for **all 3,026 inbound calls — a 100% inbound answer rate**. 1,741 of those
callers hung up inside the IVR and never reached a queue; 91 waited in the queue and were never
picked up.

**Missed and Abandoned — structurally pinned to zero.** Both are only reachable in the `else` branch
of `if (anyAnswered)`. Since `anyAnswered` is always true for inbound, that branch never executes.
Ground truth: 93 queue legs with `NO ANSWER` → 91 missed + 2 abandoned.

**Talk seconds — inbound under-reported by 65%.** The surviving IVR leg's `talk_duration` is the
few seconds the caller spent in the menu, not the conversation. Inbound talk reads 43,911s against a
true 125,531s. Note the direction: this is **under**-reporting, not inflation — the cross-leg
double-counting the aggregator would otherwise do never happens, because it never sees two legs.

**Average queue wait — effectively zero.** `waitOf()` reads `wait_time` (absent) and falls back to
`ring_duration`, which the IVR leg also lacks. Total accumulated wait across 3,026 inbound calls is
**77 seconds**, an average of 0.03s. The real average, from the queue leg, is 17.7s over 1,285 calls
that actually reached the queue.

**Per-agent inbound stats are starved, not wrong.** Agent legs never survive the `uid` dedup, so
inbound rows reaching the per-agent loop resolve to IVR numbers, miss the roster and land in
`unmatched`. Per-agent inbound counters are therefore near-empty rather than mis-attributed — which
is why no agent has ever been credited with someone else's call, and equally why inbound per-agent
figures have looked implausibly low.

**Outbound is correct and stays correct.** Outbound calls are single-leg (4,727 of 4,736 groups), so
the `uid` dedup removes nothing, and `call_from_number` matched the extension roster on 4,744 of
4,745 rows. Outbound talk seconds are **identical in both columns (230,824)**, as are outbound call,
answered and no-answer counts. Nothing in this sprint changes outbound behaviour.

### Realtime widget

`yeastarRealtimeQueue` reads `cs.data` or `cs.queue_call_status_list` from `queue/call_status`.
**Neither field exists.** The real response carries `waiting_list`, `active_list`, `ringing_list`
plus ready-made scalars `waiting_calls`, `active_calls`, `ringing_calls`. The widget then
re-derives those counts by substring-matching a `status` field. `queue/agent_status` does use
`data`, so the agent half works.

---

## 6. What was built

- `src/lib/yeastar/normalize.ts` — normalization layer using only verified fields.
- `src/lib/yeastar/__tests__/normalize.test.ts` — 20 tests, fixtures transcribed from live payloads.

The layer was then replayed over the full 13,997-row live dataset and reproduces the corrected
column of the table above exactly:

```
calls 7769
answered 4192 · ivr_only 1741 · missed 91 · abandoned 2
no_answer_outbound 1439 · busy 287 · failed 9 · internal 8
inbound talk seconds 125531
answered calls with an Unknown answering extension: 0
queue waits recorded: 1285   (= the exact number of queue legs)
```

- `src/lib/yeastar/diagnostics.server.ts` + `/admin/yeastar-diagnostics` — dev-only page showing
  endpoint, request, status, body, parsed output and parse errors, including a live check that the
  14 retired fields are still absent.

**Not done in this pass, deliberately:** `stats.server.ts` was left untouched. Correcting the KPIs
was the next sprint; this one only established a trustworthy data source.

---

## 7. Phase 2 — the analytics pipeline now runs on the normalization layer

`src/lib/yeastar/stats.server.ts` was rewritten on top of `normalize.ts`. Every KPI is derived from
normalized CALLS; no KPI reads a raw CDR row.

**Removed** (obsolete once rows are grouped by `call_id`): the `uid` de-duplication, the
`correlationId()` chain over `linkedid`/`linked_id`, the 120-second sliding-fingerprint fallback,
`agentExtFor()`'s nine-field priority list, `ringOf()`/`waitOf()`'s reads of `wait_time` and
`agent_ring_time`, `routedThroughQueue()`, and the `Classified` group type. `CdrRecord` is now an
alias of the verified `RawCdrRow` rather than a hand-written interface declaring fourteen fields
this firmware never sends.

**KPI definitions now in force**

| KPI                 | Derivation                                                                          |
| ------------------- | ----------------------------------------------------------------------------------- |
| Answered            | An agent leg answered. An `ANSWERED` IVR leg is not an answered call                |
| Missed              | Reached the queue, no agent answered, queue-leg ring ≥ 5s                           |
| Abandoned           | Reached the queue, no agent answered, queue-leg ring < 5s                           |
| IVR-only            | Never reached a queue — reported separately, never as Missed                        |
| Queue wait          | Queue-leg `ring_duration`, averaged over calls that reached a queue                 |
| Agent ring          | Agent-leg `ring_duration` — a separate number                                       |
| Talk time           | Agent-leg `talk_duration`, counted once per call                                    |
| Agent KPIs          | One contribution per (call, agent); durations from that agent's own leg             |
| Inbound answer rate | Answered inbound ÷ all inbound; queue answer rate ÷ (answered + missed + abandoned) |
| Outbound            | Unchanged — single-leg, attributed to `call_from_number`                            |

**New:** `src/lib/yeastar/validate.ts` re-derives every headline KPI independently and asserts 27
invariants (no duplicate calls, no IVR pickup scored as answered, no multiplied talk, no queue
number as an answering agent, buckets summing to totals, …). It runs in the test suite over
fixtures and over the captured live payload, and on `/admin/yeastar-diagnostics` against live CDR.

**Also corrected:** the realtime widget reads `waiting_list` / `active_list` / `ringing_list` and
the PBX's own `waiting_calls` / `active_calls` / `ringing_calls` scalars, and treats `errcode
60001` as "idle" rather than as a failure. It previously read `data` / `queue_call_status_list`,
neither of which exists, and therefore always rendered zeros.

---

## 8. Phase 3 — parity with Yeastar Reports › Extension Call Statistics

The parity target is **Reports › Extension Call Statistics**, which counts only calls that reached
an extension. That single fact drives the business rules below.

### Direction accuracy

Reported defect: official Inbound 44, dashboard Inbound 46 — two outbound **Busy** calls counted as
inbound.

Root cause: direction was taken verbatim from `call_type` on the first leg. The fix reads the call's
own endpoints and overrules the label when they contradict it — **an inbound call's caller is
external by definition**, so a row labelled `Inbound` whose `call_from_number` is one of our own
extensions is not inbound. `call_from_number` is trustworthy here: it matched the extension roster on
4,744 of 4,745 outbound rows.

The correction is **one-way** — it can only move a call OUT of Inbound, never into it — so the
outbound totals verified in §5 cannot regress. Every correction is counted and reported
(`directionCorrections`) rather than applied silently.

### Operational business rules

A call is operational unless one of these applies, in precedence order:

| Reason         | Meaning                                                | Live behaviour                              |
| -------------- | ------------------------------------------------------ | ------------------------------------------- |
| `internal`     | Extension-to-extension                                 | as before                                   |
| `system_event` | No counterparty at either end                          | rare                                        |
| `queue_closed` | Queued while closed, never offered to an agent         | **0 while `enable_time_condition: 0`**      |
| `after_hours`  | Arrived outside the configured window                  | **0 until `YEASTAR_BUSINESS_HOURS` is set** |
| `ivr_only`     | Caller hung up in the IVR — never reached an extension | the largest exclusion                       |

Excluded calls are reported with counts but **never** move Total, Answered, Missed, Abandoned,
Answer Rate, queue, agent or conversion figures.

> `system_event` is deliberately decided on the **numbers**, not on leg roles. An earlier role-based
> rule dropped real outbound calls whose destination did not parse as a clean number. Excluding a
> call is far more damaging than mislabelling a leg.

### Business hours are configuration, not PBX data

Queue 6400 reports `enable_time_condition: 0`, so the queue never closes; any time condition lives
on the inbound route, which this firmware exposes no API for. Hours are therefore set via
`YEASTAR_BUSINESS_HOURS` (e.g. `"sun-thu 08:00-17:00"`), and **when unset no call is excluded for
arriving after hours** — an unverified window would silently move every KPI. The validation report
prints an operational-calls-per-hour histogram so the real window can be read off live data first.

### Performance

Normalization already ran once per window; Phase 3 removed the remaining repeated work. The CDR and
PBX-roster caches now match the client's own 5-minute `staleTime` instead of expiring at 60s, and the
agent roster (three Supabase reads + a PBX fetch) is cached rather than reloaded on every filter
toggle. The Call Center page also stopped replacing live numbers with skeletons during a refetch —
`keepPreviousData` was already holding the previous values, so the skeletons were pure flicker.

None of this touches how a KPI is computed; the caches are keyed by window **and** roster **and**
business-hours signature, so any change to those invalidates them.

---

**Roster gap found while replaying the captured payload:** `/extension/list` is paginated, and the
captured page holds 8 of the PBX's 28 extensions — 4005, who answers the sample call, is not on it.
`buildContext()` now folds queue MEMBERS (`queue_list[].static_agent_list[].text2`) into the
extension set, and the server pages `/extension/list` to exhaustion. Without that, an agent on an
unfetched page would be unrecognisable and their answered calls would be reported as Missed.
