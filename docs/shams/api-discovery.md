# Shams Pharmacy MIS — API Discovery

**Source of truth:** HAR captures of `mis.shamspharmacy.com`, taken through
Chrome DevTools by a non-privileged MIS account —

| date | requests | what it added |
| --- | --- | --- |
| 2026-08-13 | 21 | the original surface: catalog, stock, `sales/details` |
| 2026-08-13 | 27 | the Bearer token exchange (§0) |
| 2026-08-19 | 22 | the first **populated** `crm/data` row (§6), and the evidence that an invoice cannot identify its customer (§6a) |

Everything below was read off that capture. Anything the capture does not
demonstrate is marked **`NOT VERIFIED`** rather than inferred — including things
that would be reasonable to guess. Nothing here is a guessed response shape.

The HAR itself is **not** in this repository and must never be committed: it
contains a live credential exchange, customer mobile numbers and patient
identifiers.

---

## 0. Status — the API is now authenticated

**Superseded, 2026-08-13.** A second capture (27 requests) shows the MIS API is
now **Bearer-authenticated**, and the live data endpoints answer `401
Unauthorized` without a token.

The first capture recorded genuinely anonymous access: no request carried an
`Authorization` header or cookie, `Set-Cookie` appeared nowhere, and responses
were served with `Access-Control-Allow-Origin: *`. That window is closed. The
finding is kept here rather than deleted because it explains a real exposure that
existed, and because one detail from it predicted the change: **every response
already carried `Vary: Authorization`** — the auth layer was installed and
dormant, not absent.

Two things still follow for this integration:

1. MilaServ's own gate remains the access control for *portal* users: every Shams
   read sits behind `requireSupabaseAuth` plus a permission check.
2. The MIS portal ships its own `account_identifier` and `api_key` in its public
   browser bundle, so those credentials are readable by anyone who loads the
   portal. That is Shams's to fix; on our side the key is a server-only secret
   and never reaches a browser.

---

## 1. Transport

- **Protocol:** REST/JSON over HTTPS. Not SOAP, not GraphQL.
- **Base:** `https://mis.shamspharmacy.com`, all endpoints under `/api/v2/`.
- **Methods:** `POST` for login; `GET` for every data endpoint.
- **Envelope:** every response is a JSON object with `success: true`. List
  endpoints add `count`; `sales/details` and `crm/data` also echo a `parameters`
  object naming the arguments they understood.
- **Errors:** every captured response in both HARs was `HTTP 200`, including for
  a document number that does not exist. `401` is confirmed from live behaviour
  (an unauthenticated `product/search` now returns it), but its **body shape is
  `NOT VERIFIED`**; no 5xx has ever been observed. The client therefore treats
  any non-2xx as opaque and never echoes an upstream body.
- **`auth/permissions/{userId}`:** present in the second capture, called after
  the token exchange. Not used by this integration; contents `NOT VERIFIED`.
- **Rate limits:** `NOT VERIFIED` — no `X-RateLimit-*`, `Retry-After` or similar
  header appears, and no request was throttled. Absence of evidence only.
- **Latency (observed):** 347 ms – 2 218 ms; slowest were `crm/data` (~1.8–2.2 s)
  and `dashboard/item-wise-sale-report` (1.4 s).
- **Documented public API?** No. This is the portal's own internal backend.

---

## 2. Authentication — Bearer token

There are **two separate mechanisms**, and conflating them is the trap:

| Endpoint | Purpose | Issues an API token? |
| --- | --- | --- |
| `POST /api/v2/auth/token` | **Machine authentication.** What the API requires. | **Yes** |
| `POST /api/v2/auth/login` | MIS **portal user** login — returns a profile and UI nav permissions | **No** |

Only the first matters to this integration. The portal-user login is not called
by MilaServ at all, and no MIS username/password is configured.

### 2.1 Token exchange

```
POST /api/v2/auth/token
Content-Type: application/json

{ "account_identifier": "…", "api_key": "…" }
```

Response (`200`):

```jsonc
{
  "success": true,
  "token_type": "Bearer",
  "access_token": "…",          // opaque, 80 chars in the capture
  "expires_in": 1800,            // seconds — 30 minutes
  "expires_at": "2026-08-13T14:06:00+03:00",
  "account_identifier": "…"
}
```

No `Set-Cookie`. The token is bearer-only. `auth/token` is also the one API
response **without** `Vary: Authorization` — correct, since it is the endpoint
that issues the token rather than consuming it.

The client keys expiry off `expires_in` rather than `expires_at`: a duration
cannot drift with clock skew between our server and the MIS.

### 2.2 How the token is used

The capture was taken with Chrome's **"Export HAR (Sanitized)"**, which strips
`Authorization` from every request — so the header's absence in the HAR proves
nothing. The mechanism is instead established from the MIS portal's own shipped
bundle (`/mis/assets/index-*.js`), which implements:

- `Authorization: Bearer <token>` on every request **except** `/auth/token`.
- A **60-second refresh skew**: a token is treated as stale once it is within
  60 s of `expires_at`.
- On `401` (and not already retried): force a new token, then retry the request
  **once**.
- Request timeouts of 120 s, or 180 s for `/dashboard/*`.

Our client implements the same contract; see §9.

**Failure shape of a rejected token exchange:** `NOT VERIFIED` — only successful
exchanges were captured. The client treats any non-success or missing
`access_token` as `auth_failed`.

---

## 3. Products

### 3.1 Search

```
GET /api/v2/product/search?q=<text>
```

Substring match over the item name; case-insensitive. Observed: `q=moun`,
`q=mounj`, `q=mounjaro` (12 hits) and a full name `mounjaro 2.5 mg 0.5ml pen, 4's`
(1 hit). Other parameters: `NOT VERIFIED` — only `q` was ever sent.

**No wildcard syntax.** `q` is the only parameter the endpoint takes (the bundle
builds `/product/search?q=` and nothing else), and it is matched literally — so
an `*` would be searched for as a character. The portal's `mou*n*j*2.5` support
is therefore applied on our side: one fragment is sent as an ordinary `q` and the
ordered match is completed in `lib/shams/search.ts`. See `docs/project.md`.

```jsonc
{ "success": true, "count": 12, "search": "mounjaro",
  "data": [ { "itemCode": "10609670", "itemName": "MOUNJARO 2.5 MG 0.5ML PEN, 4'S", "retailPrice": 1261.4 } ] }
```

**Exactly three fields per row.** `itemCode` and `itemName` are strings;
`retailPrice` is a JSON number.

Fields the catalog does **not** return — confirmed absent, listed so nobody
plans around them: barcode, generic/active ingredient, strength, dosage form,
pack size, category, manufacturer, VAT rate, SFDA registration.

### 3.2 Info

```
GET /api/v2/product/info?itemcode=<code>
```

```jsonc
{ "success": true,
  "data": { "itemCode": "10609670", "itemName": "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
            "retailPrice": 1261.4, "retailPriceWithTax": 1261.4 } }
```

`data` is a single **object**, not an array — the one place the envelope shape
varies between endpoints.

`retailPriceWithTax` equalled `retailPrice` in both captured items. Whether that
holds for zero-rated vs standard-rated goods is `NOT VERIFIED`, so no VAT rate is
derived from the pair.

**Unknown item code:** `NOT VERIFIED` — both captured lookups succeeded. The
client models absence as `null` rather than an error, since the sibling
`sales/details` returns `200` with an empty payload for a miss.

### 3.3 Stock

```
GET /api/v2/product/stock?itemcode=<code>
```

```jsonc
{ "success": true, "count": 136,
  "data": [ { "branchCode": "P0001", "branchName": "P0001", "areaName": "RIYADH",
              "quantity": 0, "lzQuantity": 0 } ] }
```

One row per branch, **including branches with zero stock** — for item 10609670
all 136 rows were zero. Row count varies per item (136 and 139 across the two
captures), so the branch list is item-scoped, not a fixed roster.

- `branchCode` — `P` + 4 digits.
- `branchName` — **always identical to `branchCode`** in every one of the 275
  captured rows. It carries no display name. MilaServ must resolve names from its
  own `branches` table.
- `areaName` — observed: `RIYADH`, `JEDDAH`, `TAIF`, `QASIM`, `MAKKAH`, `MADINA`,
  `TABUK`, `IHSA`, `RAFA`.
- `quantity` — integer, observed 0–20.
- `lzQuantity` — **semantics `NOT VERIFIED`.** Zero in all 275 captured rows.
  Carried through unchanged; no meaning assumed.

---

## 4. Branch mapping — resolved, not assumed

`branchCode` (stock) and `Whouse` (sales) share one identifier space, and it is
**the same space as MilaServ's `branches.branch_no`**. Verified by set comparison
against the seed migration:

| | |
| --- | --- |
| MilaServ `branches.branch_no` | 137 |
| Shams `branchCode` (union of both stock captures) | 139 |
| Intersection | **137** |
| In MilaServ but not Shams | **0** |
| In Shams but not MilaServ | `P0310`, `P0311` |

The area groupings corroborate it: `P00xx`→RIYADH (and `P0023/P0024`→RAFA,
matching MilaServ's رفحاء), `P01xx`→TAIF/الطائف, `P02xx`→JEDDAH/جدة,
`P03xx`→QASIM/القصيم, `P04xx`→MAKKAH/مكة, `P05xx`→MADINA/المدينة,
`P06xx`→TABUK/تبوك, `P07xx`→IHSA/الشرقية.

**No mapping layer is required.** `branchCode` joins directly to
`branches.branch_no`. `P0310` and `P0311` are branches Shams has and MilaServ's
seed does not — a data gap to close in the branch directory, not a code problem.

---

## 5. Sales / invoices

```
GET /api/v2/sales/details?start_date=&end_date=&doc_no_start=<n>&doc_no_end=<n>&wh_cd=<branch>
```

The response echoes the parameters it understood:

```jsonc
"parameters": { "fromdate": null, "todate": null, "start_date": null, "end_date": null,
                "doc_no_start": "0075181", "doc_no_end": "0075181", "wh_cd": "P0304" }
```

So **seven** parameters are recognised. Note:

- `doc_no_start`, `doc_no_end`, `wh_cd` — **verified working.** Zero-padded input
  (`0075181`) is accepted; the response returns the number unpadded (`75181`).
- `start_date` / `end_date` — the frontend sends the keys but always **empty**.
  The accepted format and filter behaviour are `NOT VERIFIED`.
- `fromdate` / `todate` — appear **only** in the echo; never sent. `NOT VERIFIED`.

Document numbers are unique only **within a warehouse**, so `(wh_cd, doc_no)` is
the identity.

**There is no cross-branch document lookup.** `wh_cd` is always sent, and the
portal's own Sales Register marks Store Code required. The complete endpoint
inventory, read from the shipped bundle (`/mis/assets/index-*.js`), is:

```
auth/token · auth/login · auth/permissions/{id} · users · menus
product/search · product/info · product/stock
sales/details · crm/data
dashboard/{sale-report, area-wise-sale-report, item-wise-sale-report, stock-distribution}
```

Nothing there answers "which branches hold document N", which is why
`sales.server.ts:findInvoiceBranches` asks each branch in turn rather than
inventing a query parameter. Whether an **empty** `wh_cd` would search every
warehouse is `NOT VERIFIED` — the portal never sends one — so it is not relied
on.

### 5.1 The row model — one document is several rows

Every row carries the same **35 keys**. The row's role is carried by **`Prior`**:

- `Prior === "0"` → **header**: document totals + customer identity; item fields
  blank/zero.
- `Prior !== "0"` (`"1"`, `"2"`, …) → **item line**: item fields populated;
  document totals zeroed.

From the captured document (`wh_cd=P0304`, `doc_no=0075181`):

| field | header row | item row |
| --- | --- | --- |
| `Prior` | `"0"` | `"1"` |
| `GrandAmt` | `"806.220"` | `".000"` |
| `Credit_Amt` | `"806.22000000000003"` | `"0.0"` |
| `ItmCd` | `""` | `"10612388"` |
| `Amt` | `"0.0"` | `"806.22000000000003"` |

**Treating each row as an invoice double-counts every document.** Rows must be
bucketed by `(Whouse, Doc_No)` and split on `Prior` — this is what
`normalize.ts:groupInvoices` does.

Only a single-item document was captured, so `Prior` values beyond `"1"` are
`NOT VERIFIED`; the implementation therefore tests `Prior === "0"` and treats
everything else as an item, which holds regardless of how the sequence numbers.

### 5.2 Fields

**Header:** `Doc_No`, `Doc_Dt` (`"2026-08-13 00:00:00"`, **no timezone**),
`Doc_type` (observed `"Credit"`; other values `NOT VERIFIED`), `Whouse`,
`Division` (`"##"`), `Doc_Cancelled` (`"0"` / `"1"`), `Cash_Amt`, `Cash_Tax`,
`Credit_Amt`, `Credit_Tax`, `Discount`, `TotalCost`, `Profit`, `TotalTax`,
`GrandAmt`, `Usr_ID`.

**Identifiers (deliberately dropped — see §7):** `PatCd`, `Customer`,
`Customer_Code`, `Cus_Cd`.

### 5.2.1 The customer label — which field, and why it matters

The response carries several customer-ish fields and **they do not agree**.
Verified against document `wh_cd=P0221, doc_no=22138`:

| field | value |
| --- | --- |
| `Customer` | `NUPCO / …(نوبكو)` |
| `Customer_Name` | `NUPCO / …(نوبكو)`**`-Call Centre`** |

Only `Customer_Name` carries the `-Call Centre` channel suffix. Reading
`Customer` loses it and reports a call-centre document as a walk-in one.

**The MIS portal displays `Customer_Name`.** This is not inferred — it is read
from the portal's own shipped bundle (`/mis/assets/index-*.js`), which builds the
Sales Register header as:

```js
customer_name: A.Customer_Name ?? A.CusName ?? "",
customer_code: A.Customer_Code ?? "",
```

where `A` is the header row. The portal never reads `Customer` at all.

`Customer_Name` → `CusName` is therefore what `normalize.ts` reads, mirroring
that precedence, and it becomes `ShamsInvoice.customer` + the derived
`isCallCentre`. A document is a call-centre document when the label **ends with**
`-Call Centre`; the words alone do not qualify it (`CALL CENTER SALES` is a
walk-in account). The full set of labels in use is `NOT VERIFIED` — only the
suffix convention and the field precedence are.

**Item:** `ItmCd`, `ItmName`, `Qty`, `LzQty`, `FocQty` (free-of-charge),
`FocLzQty`, `Rate`, `ItmGrossAmt`, `ItmDiscAmt`, `Amt`, `ItemTax`, `Item_NetAmt`.

**Every numeric arrives as a string**, inconsistently spelled: `".000"`, `"0.0"`,
`"806.22000000000003"`, `"-639.63"`, `".0000000"`. They are parsed and rounded to
two decimals in `normalize.ts`; the float noise is the API's, not ours.

**Missing document:** returns `HTTP 200`, `count: 0`, `data: []` — verified with
`doc_no=87578, wh_cd=P0027`. Absence is data, not an error.

**Payment method detail** beyond the cash/credit split: not exposed.

---

## 6. CRM — customer sales history

```
GET /api/v2/crm/data?mobileno=<9 digits>&fromdt=YYYYMMDD&todt=YYYYMMDD&page=1&per_page=100
```

**Updated 2026-08-19** from a third capture (22 requests) which, unlike the two
before it, returned a **populated** row. The row schema below is therefore no
longer `NOT VERIFIED`, and the endpoint is now implemented — see
`lib/shams/crm.server.ts` and the Customers tab.

**The customer name and mobile number below are placeholders.** The capture holds
a real person's; this file follows the same rule that keeps the HAR itself out of
the repository. Every other value is verbatim, including the empty key.

A loyalty lookup keyed on mobile number. It is the only endpoint in any capture
that takes a date range in a confirmed format and the only one that pages.

### 6.1 The response

```jsonc
{ "success": true,
  "pagination": { "page": 1, "per_page": 100, "total": null, "total_pages": null },
  "parameters": { "fromdt": "20260602", "todt": "20260818", "mobileno": "555555555" },
  "count": 1,
  "data": [{
    "Id": "333181",
    "Name": "SAMI",
    "Mobileno": "0555555555",
    "Lm_Availbale_Points": "1261.400000",
    "Lm_Availbale_Value": "12.614000",
    "": "P0215-JEDDAH",
    "Customer": "CASH IN BOX",
    "InvNo": "22635",
    "InvDate": "2026-07-03 00:00:00",
    "Itm_Cd": "10611030",
    "Itm_Name": "MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA",
    "Qty": "1.00"
  }] }
```

The shape is **denormalized**: there is no customer object and no nested
history. Every row repeats the five customer columns and carries one purchased
line, so a customer with three items across two invoices returns six rows.

### 6.2 Three things that are easy to get wrong

1. **The branch arrives under an empty key.** The JSON literally contains
   `"": "P0215-JEDDAH"` — an unaliased column in the upstream query. It is not a
   capture artefact. `normalize.ts` reads `row[""]` through `CRM_BRANCH_KEY` and
   splits it into a code and a city; the code is the same identifier space as
   `branches.branch_no` and `sales/details`'s `wh_cd`.
2. **`Lm_Availbale_Points` is spelled that way upstream.** The transposition is
   the API's. Correcting it reads `undefined`.
3. **The mobile number has two forms.** The request asked for
   `mobileno=555555555`; the response reported `Mobileno: "0555555555"`. The
   query form is the nine-digit national number **without** the trunk zero.
   `normalizeCrmMobile` converts every way an agent might write it.

### 6.3 Pagination — half a block

`page` and `per_page` are echoed and real. `total` and `total_pages` were
`null` in **every** captured response, including the one that returned a row, so
**the size of a result set is not knowable from this API**.

Consequences, accepted rather than papered over:

- No page count and no "jump to last" — rendering "Page 2 of 7" would mean
  inventing the 7.
- "Is there another page" is inferred from a full page, measured against the
  `per_page` the API **echoed** rather than the one requested, so a clamped page
  size cannot silently truncate a history.
- `per_page=100` is the only size any capture demonstrates. The UI also offers
  25 and 50; the parameter is confirmed and honoured, and nothing downstream
  trusts the requested number.

### 6.4 Authentication — this capture carried none

**No request in the 2026-08-19 capture sent an `Authorization` header or a
cookie**, including `crm/data` and `sales/details`, and all returned `200`. That
does not reverse §0 — the portal still performs a token exchange, and a live
`product/search` without a token still answers `401` — but it means the
anonymous exposure §0 describes is at least partly still open on these paths.

It changes nothing in this integration: every read goes through the
Bearer-authenticated client either way, which is correct whether or not the
endpoint insists.

### 6.5 Access

Gated on `view_shams_mis`, the page-level key. This endpoint returns more
identifiable data than any other read here — a name, a mobile number and a
purchase history — so a narrower permission is a defensible follow-up. It was
not introduced now because a new permission means a migration plus a
`has_permission()` change plus the parity script, and a key enforced only in the
frontend would be worse than reusing the one the server already checks.

---

## 6a. Linking a customer to an invoice — one direction only

The obvious enrichment, **invoice → customer, is not available**, and this
capture is what establishes that.

`sales/details` offers six customer-ish fields. On document 22635 they hold:

| field | value |
| --- | --- |
| `PatCd` | `null` (header) / `""` (item row) |
| `CusName` | `""` |
| `Customer` | `""` |
| `Customer_Name` | `"CASH IN BOX-"` |
| `Customer_Code` | `"14-00-0052"` |
| `Cus_Cd` | `null` |

**None of them is a mobile number**, and the two that are populated identify the
*till* (`CASH IN BOX-`) and a ledger account (`14-00-0052`), not the person. The
CRM says the buyer of that same document was `SAMI`, `0555555555`. There is no
key to join on, so any invoice → customer lookup would be a guess.

The relationship runs the other way and is explicit: a `crm/data` row names the
document its line was sold on — `InvNo` `"22635"` with branch `"P0215-JEDDAH"`
— and the capture shows the MIS operator following exactly that link, calling
`sales/details?doc_no_start=22635&doc_no_end=22635&wh_cd=p0215` immediately
afterwards.

So enrichment is implemented in that direction only. Opening a document from a
customer's history records the pairing in
`features/shams/invoice-customer-link.ts`, and the Invoices tab shows the
customer for that document alone. A document reached any other way shows none,
because for that document nothing has established one.

This also disposes of the N+1 risk: enrichment costs **zero** extra requests.
The customer was already on screen when the agent clicked, so there is no
per-invoice CRM call to deduplicate, batch or cache.

---

## 7. Privacy decisions

`sales/details` returns patient and customer identifiers on every header row.
`PatCd`, `Customer`, `Customer_Code` and `Cus_Cd` are dropped in `normalize.ts`,
at the boundary — not in the UI — so they cannot reach a cache, a log, an XLSX
export or the browser. `ShamsInvoice` has no field for them, and a test asserts
none leaks into the serialized model.

**`Customer_Name` (falling back to `CusName`) is the deliberate exception.** It
is the label the MIS portal itself displays as "Customer" (§5.2.1), and the only
field carrying the sales-channel suffix that identifies a call-centre document.

**Partly answered, 2026-08-19.** The open question below was what
`Customer_Name` holds for a **cash walk-in** document. The 2026-08-19 capture
contains one — document 22635, `Doc_type: "Cash"` — and the field reads
`"CASH IN BOX-"`: an account, not a person, even though the CRM knows that
sale's buyer by name. One document is not a guarantee, so the risk below is
narrowed rather than closed.

The residual risk is stated rather than hidden: every observed value names an
*account* (`HOME DELIVERY-Call Centre`, `NUPCO / …-Call Centre`, `CASH IN BOX-`),
and no capture yet shows a person's name in this field. If one ever does, it is
now visible
in the portal UI, and this decision has to be revisited.

The client logs method, path, status and duration only. **Query values are never
logged**, because `crm/data` carries a mobile number and `sales/details` echoes
patient codes.

`TotalCost` and `Profit` are retained — they are the point of an invoice
lookup — but they are margin data, which is why invoice reads are gated on
`view_invoice_analytics` rather than the broader `view_orders`.

---

## 8. Dashboard endpoints (captured, not implemented)

Present in the capture and documented for future work; none are wired up.

| Endpoint | Parameters | Shape |
| --- | --- | --- |
| `dashboard/sale-report` | `mode=T\|Y\|L7` | `data[]` of `{date, dayName, netSales, netCustomerCount}` |
| `dashboard/area-wise-sale-report` | `mode=T` | `{branchData, areaData}` |
| `dashboard/item-wise-sale-report` | `mode=T`, `report_type=C` | — |
| `dashboard/stock-distribution` | `mode=T` | `{branchData, areaData, summary}` |

`mode` is `T`=today, `Y`=yesterday, `L7`=last 7 days (inferred from the returned
row counts: 1, 1 and 7 respectively). Other `mode` values and `report_type`
values: `NOT VERIFIED`.

---

## 9. Implementation map

| Concern | File |
| --- | --- |
| Bearer auth, token cache, transport, timeout, retry, errors, cache primitive | `src/lib/shams/client.server.ts` |
| Wire + normalized types | `src/lib/shams/types.ts` |
| Pure normalization, invoice grouping | `src/lib/shams/normalize.ts` |
| Product search / info / stock + caching | `src/lib/shams/catalog.server.ts` |
| Invoice lookup + query validation | `src/lib/shams/sales.server.ts` |
| CRM customer history + query validation | `src/lib/shams/crm.server.ts` |
| Authenticated, RBAC-gated server functions | `src/lib/shams.functions.ts` |
| Invoice ← customer provenance (browser, in memory) | `src/features/shams/invoice-customer-link.ts` |
| Customers tab | `src/features/shams/components/customers-tab.tsx` |
| Tests against captured payloads | `src/lib/shams/__tests__/normalize.test.ts`, `src/lib/shams/__tests__/crm-history.test.ts` |

**Auth:** module-scoped token cache with single-flight, a 60 s refresh skew, and
on 401 a forced refresh plus one retry (a second 401 raises `auth_failed` rather
than looping). Deliberately **no Supabase L2 tier** like the Yeastar client's:
that exists because the PBX rate-limits token issuance hard enough to lock the
integration out (`errcode 60002`), which is evidenced. Nothing here evidences a
rate limit, and an L2 tier would mean a migration and a table holding a live
bearer token.

**Cache TTLs:** search 5 min, info 15 min, stock 60 s, invoices uncached,
**CRM history uncached**. In-memory and per-isolate — no migration, no table of
third-party data. The CRM read is left uncached deliberately: it is a submitted
lookup rather than per-keystroke traffic, and a server-side cache of it would be
a store of identifiable customer data keyed by mobile number — something to add
on purpose with a reason, not as a performance reflex.

**Adding an endpoint** means a typed wire shape in `types.ts`, a pure mapper in
`normalize.ts`, a fetch in the relevant `*.server.ts`, and a gated server
function. No transport or auth changes.

---

## 10. PharmacyCRM Desktop — what the client Shams staff actually use

Source: `PharmacyCRM-desktop-update-2026.07.25.112540`, a PyInstaller (Python
3.11 / PySide6) build. Findings below were read out of the shipped archive —
`PYZ.pyz` unpacked from the executable and `desktop.main_window` disassembled —
plus the client's own SQLite file, which ships with a populated HTTP cache. They
are **transcribed, not inferred**; the request shapes come from cache rows the
application itself wrote.

### 10.1 It is a different backend

| | Portal | PharmacyCRM Desktop |
| --- | --- | --- |
| Host | `mis.shamspharmacy.com` | `shams-crm.cloud` |
| Config | `SHAMS_MIS_*` env | `desktop-client.json` → `api_base` |
| Catalog read | `GET /api/v2/product/search?q=` | `GET /products/names` |
| Stock read | `GET /api/v2/product/stock?itemcode=` | `GET /products/search-live?q=` |

The portal holds no credential for `shams-crm.cloud`, and the desktop
authenticates as a *branch user* (bcrypt, per-user), not as a machine account.
Nothing in the package is reusable as a portal credential.

### 10.2 `/products/search-live` is a stock lookup, not a product search

The single cached call the application recorded:

```
GET /products/search-live
  ?q=10612091&limit=20
  &location_lat=26.1295039&location_lon=51.2046522
  &location_link=https://www.google.com/maps?q=26.129504,51.204652
```

```jsonc
{ "query": "10612091", "name_source": "local_products_table",
  "stock_source": "solver_api_branch_stock",
  "resolved_location_lat": 26.1295039, "resolved_location_lon": 51.2046522,
  "items": [ { "item_code": "10612091",
               "item_name": "PHARMATON VITALITY FOOD SUPLEMENT CAP, 30'S",
               "total_available_qty": 5466.0, "available_branch_count": 138,
               "stock_status": "cache_or_live", "nearest_branch_code": "P0701",
               "nearest_branch_distance_km": 187.85,
               "nearest_available_branch_qty": 33.0 } ],
  "warnings": [] }
```

`q` is an **item code that the client has already resolved**, never the text the
agent typed. `search_live_products` resolves the query locally first — through
`_resolve_local_product_selection` or `_wildcard_pattern_candidates`, both of
which set `stock_source: "pending_lookup"` — and only then calls this endpoint
for the chosen product. `limit` is **20**. The `180` visible nearby is the
`timeout` argument to `_api_call`, **not** a result cap.

So switching the portal's product search to `/products/search-live` would not
work: it answers "where is this item code in stock", which is what
`product/stock` already answers here.

### 10.3 Search is local, over a fully cached catalog

`GET /products/names` returns the whole catalog as `{code, name, price}` and is
cached in the client's SQLite `app_state` under `cached_product_names`. The
shipped copy holds **8 484 products** (`cache_metadata.products_count`), refreshed
when a stock-sync marker changes. `_internal/_internal/product_cache_seed.json`
is the same list, shipped as a cold-start seed.

Three search modes, all matched against that local list:

- **Item code** — exact, and `startswith` on the code, so a *partial* code works.
- **Name** — `_find_local_product_candidates`, `startswith`/contains scoring.
- **Wildcard** — `_wildcard_pattern_candidates`:

```python
query = str(query_text or "").strip()
if not query or "*" not in query:
    return []
pattern = re.escape(query).replace("\*", ".*")
regex = re.compile(f"^{pattern}$", re.IGNORECASE)     # anchored, both ends
for code, name in self._product_code_to_name.items():
    if regex.search(str(name or "").strip()):          # item NAME only
        ...
```

Anchored at both ends, `*` → `.*`, case-insensitive, **item name only**, results
sorted by name then code. A `*` is required; without one the mode returns
nothing. This is why the in-app hints read `pana*extr*` and `*omega*` — under
anchoring, a bare `nan*op` means "starts nan, *ends* op" and matches nothing in
the real catalog; the agent has to type `nan*op*`.

### 10.4 What this means for the portal

Verified against the real 8 484-row catalog (`pharmacycrm-parity.test.ts` carries
a 237-row slice of it, and every product any of its queries can reach):

- The portal's fragment matching is a **superset** of the desktop's. Star the
  query at both ends and the two agree row for row — `*omega*` returns the same
  45 products, `pana*extr*` the same 1, `nan*op*` the same 10. The portal also
  answers `nan*op` with those same 10 where the desktop, being anchored, returns
  none. The looser reading is the one this behaviour was asked for.
- Two API limits are the desktop's real advantage, and neither is a matching
  rule: it matches over the **whole catalog**, and its codes are searchable. The
  portal matches over whatever `product/search?q=` returned for its probes, and
  that endpoint sees names only. **A partial item code, and a wildcard written
  against a code, therefore cannot be retrieved at all** — no probe brings the
  row back for local matching to see.
- Closing that gap needs a catalog source: either a credential for
  `shams-crm.cloud`'s `/products/names`, or a catalog-dump endpoint on the MIS
  API. `product/search?q=` is not one — it takes no `limit`/`page`/`offset`, so
  whether it truncates is still `NOT VERIFIED`.

### 10.5 Not verified

No live call was made to either backend while writing this. The portal's
`SHAMS_MIS_*` credentials are absent from the development environment, and no
credential for `shams-crm.cloud` exists at all. Everything above comes from the
shipped package — its bytecode, its config, and the HTTP cache it wrote itself.
Whether the two backends expose the *same* product universe is therefore
**`NOT VERIFIED`**, and it is the most likely explanation for a query returning
different rows in the two systems.

### 10.6 How the desktop keeps its catalog current

`GET /products/names` answers with a **bare JSON array** — not the `{success, data}`
envelope the MIS uses — of `{code, name, price}`. Verified against the shipped
package: the endpoint's cached response, `product_cache_seed.json`, and the live
`app_state.cached_product_names` all hold the **same 8 484 item codes**, so the
seed is the complete catalog and the endpoint returns that same catalog. The seed
is a cold-start copy (`_load_product_seed_rows`), used until the first fetch
lands. Three fields, nothing else: no barcode, no pack size, no branch data.

**The refresh is event-driven, not a TTL.** `_refresh_product_name_cache_for_stock_sync`:

1. `GET /stock/sync/status` (60 s timeout) → `{latest_run, last_success_at_utc,
   sync_interval_minutes, is_running}`.
2. `_extract_stock_sync_success_marker` reduces that to one string — the latest
   run's `completed_at`/`started_at` when its `status` is `success`, otherwise
   `last_success_at_utc`.
3. If the marker differs from `app_state.cached_product_names_stock_sync_marker`,
   re-fetch `/products/names` and **replace** the cache, storing the new marker.

So the catalog is re-pulled when the upstream stock sync reports a *new success*,
and not otherwise. There is no age-based expiry on this path;
`_is_cache_stale(key, max_age_seconds)` exists for the branch list. The captured
deployment reports `sync_interval_minutes: 0` — "Manual" in the UI — with
`last_success_at_utc: 2026-08-14T11:53:23Z`.

**Observed drift**, seed (2026-07-25) against the endpoint's response
(2026-08-14), 20 days apart: 488 of 8 484 prices changed (5.8 %) and 11 names.
Roughly 0.3 % of rows a day, and no code added or removed in the window. A
several-hour TTL would therefore be comfortably current if a marker endpoint is
not available; the marker is better because it refreshes on change rather than on
a clock.

**Authentication is `X-Session-Token`** (`MainWindow._api_call` sets it from
`_current_session_token`), issued by the desktop's own `/login` for a *branch
user* — bcrypt is bundled for it. It is not the portal's machine Bearer
credential, and the portal holds nothing for that host.

### 10.7 Probing this API for a catalog source

`scripts/shams-catalog-probe.mjs` is the read-only check, to be run where
`SHAMS_MIS_*` credentials exist. It allow-lists GET paths only, prints nothing
secret, and answers three things: whether any path on the MIS serves a product
list, whether `product/search?q=` truncates a broad result (its `count` field
reveals the true total even when `data` is capped), and whether the NAN OPTIPRO
rows exist upstream at all. Its output belongs in
`docs/shams/catalog-probe-results.{md,json}`.

Until it has been run, the **MIS** catalog source is `NOT VERIFIED`, and nothing
should be built on the assumption that one exists.

**Superseded for the CRM path.** A credential for `shams-crm.cloud` was obtained,
so `GET /products/names` — the other option §10.4 names — is the catalog source,
and it is now persisted in MilaPortal rather than cached per isolate: see
`shams_product_catalog` in `docs/project.md` (_The local product catalogue_). The
refresh follows §10.6's marker rule, and the Desktop's shipped
`product_cache_seed.json` is committed as a migration for exactly the reason the
Desktop ships it — a cold start that has never reached the endpoint can still
search. This probe remains worth running: an MIS catalog dump would remove the
second credential entirely.

---

## 11. Offers — what the CRM actually provides

Established from the shipped PharmacyCRM package (its bytecode and the HTTP cache
it wrote itself), and from a read-only inspection of this repository. **No live
call was made to discover any of it**, and no undocumented endpoint was probed.

### 11.1 There is no Offers endpoint

There is no `/offers`, no promotions *list*, and no offers feed. Searching the
desktop build for `offer`, `promo` and `discount` turns up exactly two things:
per-item pricing fields, and an administrative sync job. The desktop has no
Offers screen either — it renders offer columns inside its branch-stock table.

### 11.2 An offer is a per-branch field on the availability response

```
GET /products/{item_code}/available-branches      X-Session-Token
```

One row per branch (138 for the captured item), each carrying:

| Field | Type | Meaning |
| --- | --- | --- |
| `price` | number | list price before the offer |
| `offer_percent` | number | discount percentage, `0` when there is none |
| `offer_display` | string | preformatted, e.g. `"25.00%"` |
| `after_offer_price` | number | the price to charge |
| `price_without_tax` | number | ex-VAT list price |

The row also carries `available_qty`, `distance_km`, `within_radius` and a nested
`branch` object (`code`, `city`, `district`, `address`, `latitude`, `longitude`,
`whatsapp`, `maps_url`).

**Fields that do not exist** — confirmed absent, listed so nobody plans around
them: offer id, offer name or title, description, start date, end date, minimum
or maximum quantity, eligibility rules, customer restrictions, active/inactive
status, image, and deep link. An "offer" here is a discount percentage on one
item at one branch and nothing more.

`GET /products/search-live` carries **no** offer fields at all — it answers
stock only. So the availability endpoint is the sole source.

### 11.3 `/promotions/sync` is a job, not a feed

```
POST /promotions/sync           starts a server-side refresh
GET  /promotions/sync/status    {latest_run, active_run, last_success_at_utc,
                                 sync_interval_minutes, is_running}
```

The desktop only *triggers* and *polls* this; it never reads offers back from it.
The captured run: `sync_type: full`, 138 branches, 10,398 rows, ~24 minutes,
`sync_interval_minutes: 0` (Manual). **`POST /promotions/sync` must never be
wired into the portal** — it is a write-side trigger for a 24-minute job on
Shams's infrastructure, and nothing on a page should be able to fire it.

### 11.4 How offers relate to `ShamsProduct`

Keyed by **`item_code`**, which is `ShamsProduct.itemCode` — the same identifier
the catalog and the MIS stock reads already use. No new identifier, no mapping
table, and no change to `ShamsProduct` is required.

Offers should stay a **separate domain model**. They are per-branch and
time-varying; `ShamsProduct` is catalog reference data cached for six hours.
Folding a moving price into it would make the catalog cache wrong rather than
merely stale.

**One observation, and its limit:** for the single captured item, all 138 branches
reported the *same* `offer_percent` (25.0), which suggests the discount is a
property of the product that the response denormalizes per branch. That is `n=1`.
Whether an offer can differ between branches is **`NOT VERIFIED`**, and the
per-branch shape should be preserved until it is.

### 11.5 Reachability, cost and MIS

**Reachable today.** The Phase 1 CRM client already authenticates to this host, so
an offers read is `crmFetch("/products/<code>/available-branches")` — no new
credential, no new client, no new auth flow.

### 11.6 Offer scope — and why it is capped

Coverage ("is this on offer at every branch that has it, or only some?") is
computed by `classifyOfferScope` from a **single** availability response: the
offers it lists, over the branches whose `available_qty` is positive.

`available_qty` was previously declared off-limits so CRM availability could not
drift into a view where MIS stock is the authority. It is read now for this one
purpose — the response returns a row for every branch in the chain, not only
stocked ones, so row count answers "how many branches exist" rather than the
question a badge claims to answer. It is consumed inside `offers.server.ts`,
never returned, and never rendered; `ShamsCrmOffer` still carries no quantity.

Because §11.5 holds — one item per request, ~62 KB, no bulk form —
`getOfferScopes` accepts at most **12** item codes and runs them 4 at a time
against the same 60 s cache. Search returns up to 100 products, so an
uncapped badge-per-row would be ~100 requests and megabytes of traffic per
search. Above the cap the UI states that offers were not checked; a missing
entry is never rendered as "no offer".

**There is no bulk form.** The endpoint takes one item code and returned ~62 KB
for it. Offers for a result set of *n* products would cost *n* requests; there is
no observed way to ask for many at once, and no pagination or `limit` parameter.
Rate limits: `NOT VERIFIED`.

**The MIS is not involved.** `product/stock` carries no offer fields — verified
against `RawStockRow`, `normalizeStock` and §3.3, which hold only `branchCode`,
`branchName`, `areaName`, `quantity`, `lzQuantity`. The MIS `Discount` and
`ItmDiscAmt` fields in §5 are invoice-line amounts on a *sold* document, not a
current promotional price. Offers need no MIS data.

Note that this response is location-aware (it takes `location_lat` / `location_lon`
and sorts by distance) and carries outward-facing `whatsapp` and `maps_url`
links. Those are display data; nothing should follow them server-side.

### 11.6 What a future phase would have to decide

The per-item cost is the whole design problem. Showing an offer badge on a
100-row search result would be 100 requests and ~6 MB. Two shapes avoid that, and
neither is implemented:

1. **On demand, for the opened product only** — one request when an agent opens a
   product, alongside the MIS stock read the page already makes. Smallest, and it
   matches how the desktop itself surfaces offers.
2. **A cached offers index**, if Shams can expose a bulk endpoint. Not possible
   against the API as it stands.

Caching, when it happens, must be **shorter than the catalog's six hours** — an
offer is a live price, and a stale one is a price an agent quotes wrongly. The
60-second MIS stock TTL is the closer precedent.
