# Shams Pharmacy MIS — API Discovery

**Source of truth:** a HAR capture of `mis.shamspharmacy.com`, 2026-08-13, 21
requests, captured through Chrome DevTools by a non-privileged MIS account.

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

**Customer (deliberately dropped — see §7):** `PatCd`, `CusName`, `Customer`,
`Customer_Name`, `Customer_Code`, `Cus_Cd`.

**Item:** `ItmCd`, `ItmName`, `Qty`, `LzQty`, `FocQty` (free-of-charge),
`FocLzQty`, `Rate`, `ItmGrossAmt`, `ItmDiscAmt`, `Amt`, `ItemTax`, `Item_NetAmt`.

**Every numeric arrives as a string**, inconsistently spelled: `".000"`, `"0.0"`,
`"806.22000000000003"`, `"-639.63"`, `".0000000"`. They are parsed and rounded to
two decimals in `normalize.ts`; the float noise is the API's, not ours.

**Missing document:** returns `HTTP 200`, `count: 0`, `data: []` — verified with
`doc_no=87578, wh_cd=P0027`. Absence is data, not an error.

**Payment method detail** beyond the cash/credit split: not exposed.

---

## 6. CRM — discovered, deliberately not implemented

```
GET /api/v2/crm/data?mobileno=<msisdn>&fromdt=YYYYMMDD&todt=YYYYMMDD&page=1&per_page=100
```

```jsonc
{ "success": true,
  "pagination": { "page": 1, "per_page": 100, "total": null, "total_pages": null },
  "parameters": { "fromdt": "20260813", "todt": "20260813", "mobileno": "<msisdn>" },
  "count": 0, "data": [] }
```

A customer purchase-history lookup keyed on mobile number. This is the **only**
endpoint in the capture that takes a date range in a confirmed format
(`YYYYMMDD`) and the only one with a pagination block.

**All three captured calls returned `count: 0` with an empty `data` array, so the
row schema is `NOT VERIFIED`** — it is not known what a populated CRM row
contains.

**Not implemented**, on two grounds: it is not needed for the product/stock/
invoice objective, and it is a bulk lookup of identifiable customer data sitting
behind an endpoint that requires no authentication. Implementing it should be a
separate, deliberate decision.

---

## 7. Privacy decisions

`sales/details` returns patient and customer identifiers on every header row.
They are dropped in `normalize.ts`, at the boundary — not in the UI — so they
cannot reach a cache, a log, an XLSX export or the browser. `ShamsInvoice` has no
field for them, and a test asserts none leaks into the serialized model.

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
| Authenticated, RBAC-gated server functions | `src/lib/shams.functions.ts` |
| Tests against captured payloads | `src/lib/shams/__tests__/normalize.test.ts` |

**Auth:** module-scoped token cache with single-flight, a 60 s refresh skew, and
on 401 a forced refresh plus one retry (a second 401 raises `auth_failed` rather
than looping). Deliberately **no Supabase L2 tier** like the Yeastar client's:
that exists because the PBX rate-limits token issuance hard enough to lock the
integration out (`errcode 60002`), which is evidenced. Nothing here evidences a
rate limit, and an L2 tier would mean a migration and a table holding a live
bearer token.

**Cache TTLs:** search 5 min, info 15 min, stock 60 s, invoices uncached.
In-memory and per-isolate — no migration, no table of third-party data.

**Adding an endpoint** means a typed wire shape in `types.ts`, a pure mapper in
`normalize.ts`, a fetch in the relevant `*.server.ts`, and a gated server
function. No transport or auth changes.
