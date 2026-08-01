# Sprint 3 — Completion Report

**Customer Care Analytics Refactor.** Architecture in
`sprint3-architecture.md`; source evidence in `sprint2-source-validation.md`.

- **Tests:** 923 passing (from 862 — **+61**), 23 files
- **Typecheck:** clean · **Production build:** clean · **Lint:** 0 errors
- **Parity:** 21 assertions against the live PBX report, all passing

---

## 1. Objectives

| # | Objective | Outcome |
| --- | --- | --- |
| 1 | Keep the CDR normalization pipeline | **Met.** No existing calculation altered. Two additive fields only: `waitSecondsAnswered` / `avgWaitAnsweredSec` and `maxWaitSec`. |
| 2 | Call Report v2.0 authoritative only where CDR cannot | **Met, and narrower than planned** — see §3. |
| 3 | Queue APIs for realtime only | **Met.** Unchanged; `sources.realtime` is the only `queue_api` value the engine can emit. |
| 4 | Build a unified Metrics Engine | **Met.** `metrics-engine.ts` — pure, synchronous, zero runtime imports. |
| 5 | Every widget consumes Metrics Engine only | **Met** after fixing one violation (D1). |
| 6 | No duplicated calculations in React | **Met** after D1. `hourLabel` reduced to one definition. |
| 7 | Preserve KPI values that match Yeastar | **Met.** Proven by the parity suite, not asserted. |
| 8 | Leave Missed vs Abandoned unchanged | **Met.** Untouched, and now visibly explained rather than silently divergent. |
| 9 | Mark O1 with a TODO + report reference | **Met.** 5 `TODO(O1)` markers, all citing §9.4. |
| 10 | Regression tests proving parity | **Met.** `yeastar-parity.test.ts`, against a live fixture. |

---

## 2. Acceptance verification

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Widgets consume Metrics Engine only | ✅ after D1 | Route reads `metrics.*`; remaining `.map()` calls are roster dropdowns, not KPIs |
| 2 | No KPI calculation in any React component | ✅ after D1 | Scan of all 7 CC components returns clean |
| 3 | One source of truth per KPI | ✅ | Source table, `sprint3-architecture.md` §2 |
| 4 | Every metric documents its origin | ✅ after D5 | `sources` covers all 8 groups; a test fails if a group is added without one |
| 5 | No duplicated calculations | ✅ after D1 | `hourLabel` has exactly one definition; project scan clean within scope |
| 6 | API calls cached, no unnecessary execution | ✅ after D4 | Six cache layers, `sprint3-architecture.md` §3 |
| 7 | Correct behaviour when sources fail | ✅ | 3 degradation paths, each unit-tested |
| 8 | No regression in export / filters / dates / agent / direction | ✅ after D2, D3 | Analytics payload byte-identical to HEAD apart from two intentional changes |

---

## 3. Call Report is load-bearing for exactly one metric

Sprint 2 listed three candidates. On re-checking, only one is genuinely
underivable from CDR:

- **Per-agent missed calls** — this firmware writes an agent-leg CDR row *only
  when the agent answers*. Across 14,294 July rows, **zero** inbound agent legs
  carried `NO ANSWER`. The data does not exist in CDR. Yeastar reported 71
  missed rings in July, 36 of them on ext 4006 — a blind spot the dashboard has
  had all along.
- **Avg wait (answered)** and **max wait** were *also* on the candidate list,
  but both **are** derivable from CDR, and the Sprint 2 evidence already proved
  it (17,322s and 455s matched exactly). They are now CDR-derived: sub-second
  precision instead of Yeastar's integer truncation, and no extra network call.
  This closes both ⚠️ GAP rows in the Sprint 2 matrix.

Net effect: Call Report is used less than the plan allowed, which is the correct
direction for objective 2.

---

## 4. Defects found during acceptance, and fixed

All five were introduced by Sprint 3 itself. No pre-existing analytics logic was
touched.

| ID | Severity | Defect | Fix |
| --- | --- | --- | --- |
| **D1** | **High** | `call-trend-charts.tsx` computed the daily answer rate inside the component — a KPI defined in a second place, in a file whose own docstring claimed the opposite. Violated acceptance items 2 and 5. | Engine now emits `trends.dailyAnswerRate` and `hasDailyData`; the chart is purely presentational. A test asserts it uses the same formula as the headline card. |
| **D2** | **Medium** | Export regression — the Agents sheet had become the *search-filtered* list. Pre-refactor, the table got the searched list and the export got the full one. A user searching "4002" would have exported one agent. | Export uses `agents.rows`; a test pins `rows` ≠ `visible`. |
| **D3** | **Low** | Export regression — the "No-answer outbound" row was dropped from the KPI sheet. | Added `direction.noAnswerOutbound` to the engine and restored the row. |
| **D4** | **High** | Call Report had **no server-side cache**, while CDR is protected by a 5-minute one. Each 20s client poll was 2 live PBX GETs *per viewer* — against a box whose `get_token` rate-limits hard enough (`errcode 60002`) to lock the whole integration out. | 5-minute server cache keyed on `from\|to\|queueId`, matching the CDR pattern. Rejections are not cached, so one blip cannot pin "unavailable" for five minutes. |
| **D5** | **Low** | `sources` covered 5 of 8 metric groups, so `direction`, `time` and `trends` had no documented origin. Violated acceptance item 4. | `sources` now exhaustive; a test fails if a group is added without an entry. |

---

## 5. Test coverage added

| Suite | Tests | Purpose |
| --- | --- | --- |
| `yeastar-parity.test.ts` | 21 | Engine output vs the PBX's own Queue Performance report, over a live 446-row fixture |
| `metrics-engine.test.ts` | 32 | Source policy, applicability, degradation, O1 surfacing, derivations |
| `call-report.test.ts` | 9 | The date format, pinned against Go's reference layout |

The parity fixture (`samples/parity-2026-07-29.json`) holds the CDR rows **and**
the Yeastar report captured at the same moment. External numbers are masked with
stable pseudonyms per the existing `samples/` convention; masking cannot affect
any assertion because legs are classified by roster membership.

Two tests are worth singling out:

- One asserts the answered-only and all-call wait series are **genuinely
  different numbers**, so a refactor cannot quietly wire both KPIs to the same
  value and still pass.
- One re-proves the structural finding from the fixture itself — every inbound
  agent leg is `ANSWERED`, CDR's per-agent missed is all zeros, and the engine
  sources the real figure from Call Report.

---

## 6. Verified parity (2026-07-29, queue 6400)

| Metric | Dashboard | Yeastar | |
| --- | --- | --- | --- |
| Queue calls | 35 | 35 | ✅ |
| Answered | 27 | 27 | ✅ |
| Queue answer rate | 77.14% | 77.14% | ✅ |
| SLA attainment | 77.14% | 77.14% | ✅ |
| Avg wait (answered) | 10s | 10s | ✅ |
| Avg wait (all) | 26s | 26s | ✅ |
| Max wait | 160s | 160s | ✅ |
| Avg talk | 110s | 110s | ✅ |
| Per-agent answered ×4 | — | — | ✅ exact |
| Per-agent talk ×4 | — | — | ✅ exact |
| Unanswered total | 8 | 8 | ✅ |
| Missed / Abandoned | 8 / 0 | 0 / 8 | ⛔ **O1**, deliberate |

---

## 7. Known limitations

- **O1 remains open** and is the only intentional divergence. It is surfaced in
  three places — a dashboard notice, an XLSX sheet, and
  `UnansweredSplitComparison`. **Blocked on §9.4** of the validation report:
  confirming Yeastar's own Missed/Abandoned definitions from the Web UI.
- **Not verified against live data in a browser.** The dev server starts clean
  and every module transforms, but the page is behind a sign-in I did not
  perform. **The O1 notice card and the "—" missed column have not been seen
  rendering against real PBX responses.** Worth a look on first open.
- **Telesales was not refactored.** `telesales-trend-charts.tsx` still computes
  two rates in-component. That is the same class of issue as D1, but Telesales
  is outside this sprint's scope; flagged rather than silently expanded into.
- **Multi-queue caveat.** With `queue = "all"`, CDR spans every queue while Call
  Report covers 6400 only. Equivalent today — 6400 is the sole configured queue —
  but per-agent missed would be 6400-scoped if another were added.
- **O3, O4, O5, O7, O9** from the Sprint 2 report remain open and untouched.
