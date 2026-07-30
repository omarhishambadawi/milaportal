# Yeastar field mapping — raw → normalized

Source of truth: live PBX `hogdfpbxy.ras.yeastar.com` (P570, firmware 37.23.0.83), verified
2026-07-30 over 13,997 CDR rows. Implemented in `src/lib/yeastar/normalize.ts`.

## Scope note

The unit of normalization is the **call**, not the CDR row. One inbound call is several rows sharing
`call_id`, one per routing stage. Leg-level fields are mapped first, then call-level fields are
derived from the legs.

---

## Leg level — `RawCdrRow` → `NormalizedLeg`

| Raw field        | Presence | Normalized field          | Notes                                                                    |
| ---------------- | -------- | ------------------------- | ------------------------------------------------------------------------ |
| `new_id`         | 100%     | `rowId`                   | **Row-unique** (13,997 distinct / 13,997 rows). The de-duplication key   |
| `uid`            | 100%     | —                         | **Call-level, NOT row-level** (7,769 distinct). Correlation only         |
| `call_to_number` | 100%     | `destinationNumber`       | Verbatim                                                                 |
| `call_to`        | 100%     | `destinationLabel`        | `"Queue CC_Team<6400>"` → `"Queue CC_Team"`                              |
| `disposition`    | 100%     | `disposition`, `answered` | `answered = disposition === "ANSWERED"`                                  |
| `ring_duration`  | 52.0%    | `ringSeconds`             | **`null` when absent** — never coerced to 0                              |
| `talk_duration`  | 85.5%    | `talkSeconds`             | `null` when absent                                                       |
| `duration`       | 98.5%    | `durationSeconds`         | `null` when absent                                                       |
| `timestamp`      | 100%     | `timestamp`               | Epoch seconds, UTC                                                       |
| _derived_        | —        | `role`                    | `agent` / `queue` / `ivr` / `survey` / `prompt` / `external` / `unknown` |

### `role` derivation

Roster membership wins, because `/extension/list` and `/queue/list` are authoritative and
language-independent. Label prefixes are only consulted for stages that have no roster.

1. `call_to_number` ∈ queue roster → **`queue`**
2. `call_to_number` ∈ extension roster → **`agent`**
3. `call_to` starts `IVR ` or `Voicemail` → **`ivr`**
4. `call_to` contains `Satisfaction Survey` → **`survey`**
5. `call_to` starts `Play Prompt` → **`prompt`**
6. `call_to_number` matches `^\+?\d{6,}$` → **`external`**
7. otherwise → **`unknown`**

---

## Call level — leg group → `NormalizedCall`

| Raw source                        | Normalized field         | Derivation                                            |
| --------------------------------- | ------------------------ | ----------------------------------------------------- |
| `call_id`                         | `callId`                 | **The verified linked-call identifier.** 100% present |
| `uid`                             | —                        | Backup correlation key; same grouping as `call_id`    |
| `call_type`                       | `direction`              | `Inbound` / `Outbound` / `Internal`                   |
| `timestamp` (first leg)           | `startedAt`              | Epoch seconds                                         |
| `call_from_number`                | `callerNumber`           | From the first leg                                    |
| `call_to_number`                  | `calleeNumber`           | Agent leg if there is one, else the last leg          |
| `did_number` → `did`              | `didNumber`              | Inbound DID                                           |
| `call_to_number` of the queue leg | `queueNumber`            | `null` when the call never reached a queue            |
| **agent leg** `call_to_number`    | **`answeringExtension`** | Answered agent leg only. **`null` = Unknown**         |
| —                                 | `answeredByAgent`        | True only when a real extension answered              |
| —                                 | `reachedQueue`           | A queue leg exists                                    |
| **queue leg** `ring_duration`     | **`queueWaitSeconds`**   | How long the caller waited                            |
| **agent leg** `ring_duration`     | **`agentRingSeconds`**   | How long that agent's phone rang                      |
| **agent leg** `talk_duration`     | **`talkSeconds`**        | Agent legs only — counted once                        |
| —                                 | `outcome`                | See below                                             |

### `outcome` derivation

**Inbound**

| Condition                                                   | Outcome                         |
| ----------------------------------------------------------- | ------------------------------- |
| An agent leg is `ANSWERED`                                  | `answered`                      |
| No agent answer, any leg `VOICEMAIL` / `BUSY` / `FAILED`    | `voicemail` / `busy` / `failed` |
| No agent answer, reached the queue, queue-leg ring **< 5s** | `abandoned`                     |
| No agent answer, reached the queue, queue-leg ring **≥ 5s** | `missed`                        |
| Never reached a queue or agent                              | `ivr_only`                      |

`ivr_only` is deliberately **not** `missed`: no agent was ever offered the call, so charging it
against answer rate would be wrong. This is the single largest correction — 1,741 calls in 30 days.

**Outbound** (unchanged from current behaviour)

| Condition                       | Outcome                         |
| ------------------------------- | ------------------------------- |
| Any leg `ANSWERED`              | `answered`                      |
| `BUSY` / `FAILED` / `VOICEMAIL` | `busy` / `failed` / `voicemail` |
| `NO ANSWER`                     | `no_answer_outbound`            |

`answeringExtension` for outbound is `call_from_number` — the placing extension, validated against
the roster (4,744 of 4,745 rows matched).

---

## Roster endpoints

| Endpoint                       | Raw                                                         | Normalized                                                                             |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/openapi/v1.0/extension/list` | `data[].number`                                             | `NormalizationContext.extensionNumbers`                                                |
| `/openapi/v1.0/queue/list`     | `queue_list[].number`                                       | `NormalizationContext.queueNumbers`                                                    |
| `/openapi/v1.0/queue/list`     | `queue_list[].static_agent_list[]` / `dynamic_agent_list[]` | Members: `value` = extension id, `text` = display name, **`text2` = extension number** |

`buildContext()` removes any queue number from the extension set, so a queue can never be returned
as an answering extension.

---

## Realtime endpoints

| Endpoint                           | Correct fields                                                                                  | What the current widget reads                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `/openapi/v1.0/queue/call_status`  | `waiting_list`, `active_list`, `ringing_list`, `waiting_calls`, `active_calls`, `ringing_calls` | `data` / `queue_call_status_list` — **neither exists** |
| `/openapi/v1.0/queue/agent_status` | `data`, `total_number`                                                                          | `data` — correct                                       |

`errcode 60001 DATA NOT FOUND` from either endpoint means idle, not unsupported.

---

## Fields deliberately NOT mapped

Confirmed absent — zero occurrences in 13,997 rows:

`wait_time` · `agent_ring_time` · `last_participant_number` · `last_participant` ·
`final_participant` · `answer_by` · `answered_by` · `agent_number` · `dst` · `dst_num` ·
`dst_number` · `linkedid` · `linked_id` · `id`

The dev diagnostics page re-checks all fourteen on every run and flags any that reappear.
