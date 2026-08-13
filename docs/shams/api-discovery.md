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

## 0. The security finding — read this first

**The MIS data API performs no authentication of any kind.**

This is not an inference from an undocumented scheme. It is what all 21 requests
show:

| Evidence | Observation |
| --- | --- |
| `POST /api/v2/auth/login` response body | `{success, user, permissions, needsPasswordReset}` — **no token, no session id, no expiry** |
| `POST /api/v2/auth/login` response headers | **no `Set-Cookie`** |
| All 20 subsequent requests | **no `Authorization`, no `Cookie`, no session parameter** |
| Union of request headers, whole capture | `Accept`, `Content-Type`, `DNT`, `Referer`, `User-Agent`, `sec-ch-ua*` — nothing else |
| Response headers | `Access-Control-Allow-Origin: *` |
| Server banner | `Apache/2.4.62 (Win64) OpenSSL/3.1.7 PHP/8.3.14` |

The practical consequence: **anyone who knows the URL can read the entire product
catalog, every branch's stock, sales documents including cost and margin, and the
CRM customer lookup — with no credential.** The login endpoint is a front-door
formality that gates the portal's UI, not its data.

This is Shams's system to fix, not MilaServ's, but it must be reported to them.
Two things follow for this integration:

1. MilaServ's own auth is the **only** access control in the path, so every
   Shams read is behind `requireSupabaseAuth` plus a permission check.
2. `authHeaders()` in `client.server.ts` is the single seam where a real scheme
   gets added when Shams closes this.

---

## 1. Transport

- **Protocol:** REST/JSON over HTTPS. Not SOAP, not GraphQL.
- **Base:** `https://mis.shamspharmacy.com`, all endpoints under `/api/v2/`.
- **Methods:** `POST` for login; `GET` for every data endpoint.
- **Envelope:** every response is a JSON object with `success: true`. List
  endpoints add `count`; `sales/details` and `crm/data` also echo a `parameters`
  object naming the arguments they understood.
- **Errors:** `NOT VERIFIED` — every captured response was `HTTP 200`, including
  for a document number that does not exist. No 4xx or 5xx was observed, so the
  error body shape is unknown. The client therefore treats any non-2xx as opaque.
- **Rate limits:** `NOT VERIFIED` — no `X-RateLimit-*`, `Retry-After` or similar
  header appears, and no request was throttled. Absence of evidence only.
- **Latency (observed):** 347 ms – 2 218 ms; slowest were `crm/data` (~1.8–2.2 s)
  and `dashboard/item-wise-sale-report` (1.4 s).
- **Documented public API?** No. This is the portal's own internal backend.

---

## 2. Authentication

```
POST /api/v2/auth/login
Content-Type: application/json

{ "username": "...", "password": "..." }
```

Response:

```jsonc
{
  "success": true,
  "user": {
    "id": "...", "username": "<redacted>", "email": "...", "fullName": "...",
    "userType": "normal", "isActive": "1",
    "createdAt": "...", "updatedAt": "...", "last_login": "...",
    "resetPasswordOnLogin": "0"
  },
  "permissions": [ { "id": "3", "path": "/operation-report", "label": "...", "icon": "...", "order": "2", "parent": null } ],
  "needsPasswordReset": false
}
```

`permissions[]` drives the MIS portal's own navigation. It has no bearing on API
access — see §0.

**Failure shape:** `NOT VERIFIED`. Only a successful login was captured.

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
| Transport, timeout, retry, errors, cache primitive, `login()` | `src/lib/shams/client.server.ts` |
| Wire + normalized types | `src/lib/shams/types.ts` |
| Pure normalization, invoice grouping | `src/lib/shams/normalize.ts` |
| Product search / info / stock + caching | `src/lib/shams/catalog.server.ts` |
| Invoice lookup + query validation | `src/lib/shams/sales.server.ts` |
| Authenticated, RBAC-gated server functions | `src/lib/shams.functions.ts` |
| Tests against captured payloads | `src/lib/shams/__tests__/normalize.test.ts` |

**Cache TTLs:** search 5 min, info 15 min, stock 60 s, invoices uncached.
In-memory and per-isolate — no migration, no table of third-party data.

**Adding an endpoint** means a typed wire shape in `types.ts`, a pure mapper in
`normalize.ts`, a fetch in the relevant `*.server.ts`, and a gated server
function. No transport or auth changes.
