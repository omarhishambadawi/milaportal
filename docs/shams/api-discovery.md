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
`PatCd`, `Customer`, `Customer_Code` and `Cus_Cd` are dropped in `normalize.ts`,
at the boundary — not in the UI — so they cannot reach a cache, a log, an XLSX
export or the browser. `ShamsInvoice` has no field for them, and a test asserts
none leaks into the serialized model.

**`Customer_Name` (falling back to `CusName`) is the deliberate exception.** It
is the label the MIS portal itself displays as "Customer" (§5.2.1), and the only
field carrying the sales-channel suffix that identifies a call-centre document.

The residual risk is stated rather than hidden: every observed value names an
*account* (`HOME DELIVERY-Call Centre`, `NUPCO / …-Call Centre`), but no capture
proves what this field holds for a **cash walk-in** document, where a pharmacy
system could plausibly put a person's name. If one ever does, it is now visible
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

Until it has been run, the catalog source is **`NOT VERIFIED`** and no
server-side catalog cache should be built: there is nothing confirmed to fill it
from.
