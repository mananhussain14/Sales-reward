# Mobile Vendor Product Reads — Audit and Contract

**Milestone:** mobile-safe Vendor Product list, Product detail and Retailer-assignment reads
**Branch:** `feature/mobile-vendor-product-reads`
**Migration:** `supabase/migrations/20260803090000_mobile_vendor_product_reads.sql`
**Status:** read-only. No product write, assignment write, image upload, audit-log read or
dashboard metric is added, changed, or described here as implemented.

---

## 0. Summary of the finding

The Vendor product catalogue is **already the best-shaped read surface in this schema**.
`public.list_vendor_products()` (migration `20260727210000`) takes no arguments, derives the
Vendor from `auth.uid()`, aggregates its assignment count in SQL, returns no identity or
tenant internals, and is granted to `authenticated` only. **It is reused verbatim.** No second
list read was added, because a duplicate catalogue read would be a second definition of "this
Vendor's products", free to drift from the one the web already renders.

Two genuine gaps were proved, and exactly two functions were added to close them:

| Gap | Consequence for Flutter | Added |
| --- | --- | --- |
| **There is no product detail read at all.** The web opens one product by downloading the *whole* catalogue and running `Array.find()` in TypeScript. | Opening one product transfers every product. A Vendor with 2 000 products transfers 2 000 rows to render 1, on every detail open. | `get_vendor_product_detail(uuid)` |
| **The existing assignment read is an editor contract, not a read contract.** It requires `PRODUCT_RETAILER_ASSIGN` (the permission to *change* assignments), returns *every* Retailer the Vendor manages — including never-assigned ones, with `assignment_status = NULL` — and returns no relationship id. | A read-only screen would have to demand a write permission, filter nulls client-side, and could not cross-link to the shipped Vendor Retailer detail screen. | `list_vendor_product_assigned_retailers(uuid)` |

**Product images: option A — no image field, because no product image exists anywhere.**
See § 9.

---

## 1. The web Vendor Products page, as it works today

**Route:** `/products` — `app/(admin)/products/page.tsx`
**Module:** `lib/products/vendor-products.ts` → `getVendorProducts()`

### Round trips

| # | Call | Purpose |
| --- | --- | --- |
| 1 | `supabase.auth.getClaims()` | verify the session (local JWT verification) |
| 2 | `rpc('get_vendor_super_admin_context')` | page-level authorization gate |
| 3 | `rpc('list_vendor_products')` | the catalogue |

**Two database round trips.** `getVendorSuperAdminAccess()` and `getVendorProducts()` are both
wrapped in React `cache`, so the layout and the page share one resolution each.

### What happens in TypeScript

Only **shape validation** — `normalizeVendorProducts()` in
`lib/products/product-normalization.ts` walks the rows, rejects a malformed one, and maps
snake_case to camelCase through an explicit allow-list. **There is no client-side join and no
client-side counting.** `active_assignment_count` is a correlated `count(*)` inside the RPC.

This is the one Vendor read in the codebase that was already doing the right thing. The
Retailer directory, by contrast, transferred every shop row to count them
(`docs/mobile-vendor-retailer-reads-audit.md`).

### What the page renders

Code · Product name (+ brand beneath) · Barcode · `N Retailers` · Status pill ·
Updated timestamp · an activate/deactivate control. Below the table, a create form.

### Failure and empty handling

| Outcome | Behaviour |
| --- | --- |
| `denied` (42501) | The page renders "Products could not be loaded" — it does **not** redirect. |
| `unavailable` | Same amber empty state. |
| Zero products | A distinct "No products yet" empty state. |

---

## 2. The web Product detail page, as it works today

**Route:** `/products/[productId]` — `app/(admin)/products/[productId]/page.tsx`

### Round trips

| # | Call | Purpose |
| --- | --- | --- |
| 1 | `rpc('get_vendor_super_admin_context')` | authorization gate |
| 2 | `rpc('list_vendor_products')` | **the entire catalogue** |
| 3 | `rpc('list_vendor_product_retailer_assignments', {p_product_id})` | the assignment matrix |

**Three database round trips, one of which is unbounded in the catalogue size.**

### How the product is selected

```ts
const normalizedId = productId.trim().toLowerCase();
const catalog = await getVendorProducts();
const product = catalog.products.find((entry) => entry.productId === normalizedId);
if (!product) notFound();
```

This is **safe** — the id selects from a set already scoped to the caller's Vendor, so a
foreign id is simply absent and renders the ordinary not-found page — but it is **not
reusable**. Reimplementing that `find()` in Dart would make a second client responsible for a
scoping decision that belongs in SQL, and would keep the whole-catalogue transfer.

### What the page renders

Product name · product code · status label + status control · an **edit form** carrying name,
barcode, brand and description · and the Retailer assignment table: Retailer name, Retailer
status badge, `Assigned` / `Not assigned`, and an assign/withdraw control per row.

---

## 3. The Retailer-assignment behaviour today

`public.list_vendor_product_retailer_assignments(p_product_id uuid)` — migration
`20260727210000`:

```sql
from public.vendor_retailers vr
join public.organizations o on o.id = vr.retailer_organization_id and o.organization_type = 'RETAILER'
left join public.vendor_product_retailer_assignments a
  on a.retailer_organization_id = o.id and a.vendor_product_id = v_product
where vr.vendor_organization_id = v_vendor
order by o.name, o.id;
```

It is driven **from `vendor_retailers`**, so it returns every Retailer the Vendor manages and
reports `assignment_status = NULL` for one that has never held the product. That is exactly
right for the assign/withdraw matrix it serves, and exactly wrong as the answer to "which
Retailers is this product assigned to". It is **not modified**.

Three further properties, all preserved:

- It requires `PRODUCT_RETAILER_ASSIGN`.
- It raises `42501` for a foreign or unknown product id (a *distinguishable* refusal).
- It returns `retailer_organization_id` and no relationship id — the two-address-space defect
  recorded in `docs/mobile-backend-contract.md` § 6.8 and `docs/mobile-role-flow-map.md` V-15.

---

## 4. Answers to the audit questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | What does the Products page display? | Code, name, brand, barcode, active-assignment count, status, updated timestamp, status control. |
| 2 | Is there a Product detail page? | **Yes** — `/products/[productId]`. |
| 3 | Which identifier opens a product? | `vendor_products.id` (uuid), lower-cased from the URL. |
| 4 | Which table is authoritative? | `public.vendor_products`. |
| 5 | Is a product scoped to a Vendor? | Yes — `vendor_organization_id`, `NOT NULL`, `REFERENCES organizations`, **immutable by trigger**. |
| 6 | Can one product belong to more than one Vendor? | **No.** One `vendor_organization_id`, immutable. |
| 7 | Which product statuses exist? | Exactly two: `ACTIVE`, `INACTIVE` (`vendor_products_status_allowed`). **No draft, archived, discontinued, review or approval state exists.** |
| 8 | Which assignment statuses exist? | Exactly two: `ACTIVE`, `INACTIVE` (`vendor_product_assignments_status_allowed`). |
| 9 | Which product identifiers exist? | `product_code` (the canonical internal code) and `barcode` (a GTIN-family value: 8–14 digits). **There is no separate SKU, GTIN, EAN or UPC column** — `barcode` is the single GTIN-family field. |
| 10 | Required or nullable? | `product_code` **NOT NULL**, normalized (upper-cased, trimmed, whitespace-collapsed), shape-checked. `barcode` **nullable**. `product_name` NOT NULL. `brand`, `description` nullable. |
| 11 | Are product names unique within a Vendor? | **No.** Only `product_code` and `barcode` are unique. |
| 12 | Are codes/barcodes unique globally or per Vendor? | **Per Vendor** — `vendor_products_code_unique_idx (vendor_organization_id, product_code)` and a partial `vendor_products_barcode_unique_idx`. Two Vendors may each own `A-100`. |
| 13 | Fields on the web list? | code, name, brand, barcode, active-assignment count, status, updated_at. |
| 14 | Fields on web detail? | name, code, status, and the edit form's name/barcode/brand/description. |
| 15 | Descriptions, brands, categories, images? | Description and brand: **yes**. **There is no category column and no image of any kind.** |
| 16 | Reward/incentive data on the product screen? | **No.** No price, incentive, campaign, reward, coin or payout column exists anywhere in the schema. |
| 17 | Does the web show assignment counts? | Yes — `active_assignment_count`, rendered as "N Retailers". |
| 18 | Active vs inactive assignment counts? | Only the **active** count. The total was not available before this milestone. |
| 19 | How are assignments stored? | `public.vendor_product_retailer_assignments (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id, assigned_at, updated_at)`. |
| 20 | What scopes an assignment? | **Vendor product id + Retailer organization id.** Not the relationship id, not a shop id. |
| 21 | Safest selector for a mobile assignment result? | **The product id** — it is `NOT NULL`, immutable, and belongs to exactly one Vendor, so it *is* the tenant boundary. A Retailer organization id names a tenant other Vendors may also manage. |
| 22 | Can a product be assigned to the same Retailer twice? | **No.** `vendor_product_retailer_assign_unique_idx (vendor_product_id, retailer_organization_id)` — one row per pairing **for all time**. |
| 23 | How are withdrawn assignments represented? | `status = 'INACTIVE'`. **Rows are never deleted**; re-assigning flips the same row back. There is no `withdrawn_at` column — `updated_at` carries the moment of the last status change. |
| 24 | History or current only? | The **matrix** read returns every managed Retailer regardless. The table itself holds one row per pairing, so "history" here means a status, not a stream of rows. |
| 25 | Useful dates/metadata? | `assigned_at` and `updated_at`. (`assigned_by_profile_id` exists but is audit data and is not returned.) |
| 26 | Does visibility depend on relationship status? | **Reads: no.** Every assignment is visible whatever the relationship status. **Writes: yes** — a *new* assignment requires an `ACTIVE` relationship and an `ACTIVE` Retailer. |
| 27 | Products visible to suspended/inactive relationships? | On the Vendor side, yes — the row and its statuses are returned. On the Retailer side, `list_retailer_assigned_products()` requires both product and assignment `ACTIVE`. |
| 28 | Does the list do client-side joins? | **No.** SQL-aggregated. |
| 29 | Round trips for the list? | **2** (authorization + list). |
| 30 | Round trips for detail? | **3** (authorization + whole catalogue + assignment matrix). |
| 31 | One assignment query per product? | **No** — a correlated aggregate inside one statement. |
| 32 | Does it fetch all assignment rows to count them? | **No.** |
| 33 | Retailer names queried separately? | **No** — joined in SQL inside the matrix read. |
| 34 | Relationship rows queried separately? | **No** — the matrix read is driven from `vendor_retailers`. |
| 35 | How are product images fetched? | **They are not. No product image exists** — no column, no bucket, no rendering, no storage call. |
| 36 | Is any image URL safe and stable for Flutter? | Not applicable. |
| 37 | Does an existing RPC already return a safe reusable contract? | **`list_vendor_products()`: yes** — reused verbatim. `list_vendor_product_retailer_assignments()`: **no** — wrong permission, wrong row set, no relationship id. Detail: **does not exist**. |
| 38 | Are RLS-protected direct reads suitable? | **No, and deliberately.** Both product tables have RLS enabled with **zero policies** and no privilege for `anon` or `authenticated`. RPC is the only way in, by design. |
| 39 | Which fields does Flutter genuinely need? | Identity, code, barcode, name, brand, description, status, both counts, timestamps; per assignment: relationship id, Retailer organization id, Retailer name, three statuses, two timestamps. |
| 40 | Which fields must stay omitted? | `vendor_organization_id`, `created_by_profile_id`, `assigned_by_profile_id`, the assignment row's own id, all Retailer personal/contact data, all invitation artefacts, all audit metadata. |

### Gaps proved

1. **No detail read.** `Array.find()` over the whole catalogue in TypeScript.
2. **The assignment read requires a write permission** (`PRODUCT_RETAILER_ASSIGN`).
3. **The assignment read answers a different question** — every managed Retailer, not the
   assigned ones — so a read-only client must filter nulls itself.
4. **No relationship id**, so a product screen cannot cross-link to the shipped Vendor
   Retailer detail screen.
5. **No total assignment count** — only the active one — so a detail screen could not say
   "3 of the 5 Retailers that have ever held this product".

### Were existing reads reusable?

| Read | Reusable? |
| --- | --- |
| `list_vendor_products()` | **Yes, verbatim.** No change, no wrapper, no replacement. |
| `list_vendor_product_retailer_assignments(uuid)` | **No** — but left completely untouched, because the web assign/withdraw matrix depends on exactly its current behaviour. |
| A detail read | **Did not exist.** |

---

## 5. What was added

### `public.get_vendor_product_detail(p_product_id uuid)`

```
returns table (
  product_id              uuid,
  product_code            text,
  barcode                 text,
  product_name            text,
  brand                   text,
  description             text,
  status                  text,
  assignment_count        bigint,
  active_assignment_count bigint,
  created_at              timestamptz,
  updated_at              timestamptz
)
language plpgsql · stable · security definer · set search_path = ''
requires PRODUCTS_READ
granted to authenticated · revoked from PUBLIC and anon · not granted to service_role
```

**The column set is `list_vendor_products()` plus `assignment_count`, and nothing else.**
Every shared column is byte-identical in name, type and meaning — including
`active_assignment_count`, which is `bigint` in both. That relationship is asserted
structurally in `lib/products/vendor-product-reads-contract.test.ts` (test 23) by parsing the
shipped list contract out of migration `20260727210000` rather than restating it.

### 5.1 One Flutter entity, or two? — **two**

An earlier summary of this milestone said "one Flutter model deserializes both". Verified
against the deployed signatures, that is **overstated**, and the correction matters because it
drives client architecture rather than file count.

```
list_vendor_products()        →  10 columns, NO assignment_count
get_vendor_product_detail()   →  11 columns, WITH assignment_count
```

The list genuinely does not return `assignment_count`, and it was deliberately left unchanged.
So a single strict entity is only possible if `assignmentCount` is made **nullable or
optional** — and **a nullable count is ambiguous**: `null` would mean both "this product has
zero assignments" *(impossible here — the detail returns `0`, never `null`)* and "this row came
from the list, where the total was never computed". Collapsing a real value with an absent one
is exactly what every other field in this contract refuses to do.

**Recommendation — option B: two entities over one shared set of common fields.**

| Layer | Shape |
| --- | --- |
| `VendorProductSummary` | the 10 list columns; `activeAssignmentCount` **non-null** |
| `VendorProductDetail` | the same 10 **plus** `assignmentCount` **non-null** |
| shared | one mapper/mixin for the 10 common fields — the byte-identical names and types are what make that safe, and what the static guard protects |

Do **not** model the detail as a subtype that widens the list, and do not make either count
nullable. If a later milestone adds `assignment_count` to `list_vendor_products()`, the two
entities can collapse into one at that point — but that would be a change to a shipped
contract the web already consumes, and is not made here.

### `public.list_vendor_product_assigned_retailers(p_product_id uuid)`

```
returns table (
  relationship_id          uuid,     -- NULLABLE, see § 8
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_status          text,
  relationship_status      text,     -- NULLABLE, see § 8
  assignment_status        text,     -- never null
  assigned_at              timestamptz,
  assignment_updated_at    timestamptz
)
language plpgsql · stable · security definer · set search_path = ''
requires PRODUCTS_READ *and* RETAILERS_READ
granted to authenticated · revoked from PUBLIC and anon · not granted to service_role
```

**One row per existing assignment row, and nothing else.** Driven *from* the assignment table,
so `assignment_status` is never null and a client never has to decide what a null means.

**Ordering:** `retailer_name`, then `retailer_organization_id`. Deterministic and total. The
tie-break is the organization id rather than the relationship id, because the latter is
nullable.

---

## 6. Product-status semantics

Exactly two values, returned verbatim: **`ACTIVE`** and **`INACTIVE`**.

- There is **no draft, archived, discontinued, review or approval state** in this schema, and
  none is invented. `vendor_products_status_allowed` permits exactly these two; the pgTAP
  suite asserts the constraint still exists, and the static suite forbids an output column
  named for any of the absent states.
- **An `INACTIVE` product is fully readable** by both the list and the detail. Neither filters
  by product status — matching the web catalogue, which shows it with a status pill and an
  Activate control. Hiding it would make deactivating look like deleting.
- An `INACTIVE` product **keeps its assignment rows and its counts.**
  `set_vendor_product_status` deliberately does not cascade, so an `INACTIVE` product with a
  live assignment reports `assignment_count = 1, active_assignment_count = 1`.
- The status is never derived, defaulted, or mapped. An unknown value cannot arise (the CHECK
  constraint), and nothing coalesces it to `ACTIVE`.

## 7. Assignment-status semantics

Exactly two values, returned verbatim: **`ACTIVE`** and **`INACTIVE`**.

- **Withdrawal sets `INACTIVE` and never deletes.** The row is the surviving record that this
  product was once available at this Retailer, so it is **returned and marked**, not hidden.
- **Four statuses travel, and they are four different facts.** None is derived from another:

  | Field | Vocabulary | Means |
  | --- | --- | --- |
  | `assignment_status` | `ACTIVE` / `INACTIVE` | is this product assigned to this Retailer *now* |
  | `relationship_status` | `ACTIVE` / `SUSPENDED` / `DEACTIVATED` | the Vendor–Retailer relationship |
  | `retailer_status` | `ACTIVE` / `SUSPENDED` / `DEACTIVATED` | the Retailer organization itself |
  | product `status` | `ACTIVE` / `INACTIVE` | returned once, by the detail read |

- **An `ACTIVE` assignment against a `SUSPENDED` relationship is a real, reachable state.** A
  Vendor may suspend a relationship without withdrawing its products, and
  `unassign_vendor_product_from_retailer` deliberately does *not* require an active
  relationship. Both values are returned exactly as stored so a client can render that
  honestly rather than guessing.
- **No date is used to infer a status, and no date is fabricated.** There is no `withdrawn_at`
  column, so none is invented. `assignment_updated_at` is the assignment row's real
  `updated_at`: for an `INACTIVE` row it *is* the moment of withdrawal (the only write that
  could follow would flip it back to `ACTIVE`), but it is named for what it is.

## 8. Assignment-count semantics

**An assignment is a row in `public.vendor_product_retailer_assignments`.**
`vendor_product_retailer_assign_unique_idx (vendor_product_id, retailer_organization_id)`
guarantees **at most one row per pairing, for all time**, so a Retailer assigned, withdrawn
and re-assigned is *one* row that flipped status twice.

| Rule | Value |
| --- | --- |
| What counts as an assignment | one row in the assignment table |
| Do **withdrawn** (`INACTIVE`) assignments count in the total? | **Yes** |
| Do withdrawn assignments count as active? | **No** |
| Do only **`ACTIVE` relationships** count? | **No** — relationship status is not consulted by either count |
| Do **suspended** relationships count? | **Yes**, in both counts |
| Do **suspended Retailer organizations** count? | **Yes**, in both counts |
| Can multiple rows exist for the same (product, Retailer)? | **No** — prevented by the unique index |
| How are duplicates prevented? | by that index; the reads add no `DISTINCT` and need none |
| Do **shop-level** assignments affect Retailer counts? | **Not applicable** — assignment is Retailer-level; there is no shop-level product assignment table |
| Does the **product's own status** affect either count? | **No** |
| Are cross-Vendor rows counted? | **No** — the product is matched on the derived Vendor first |

**Two invariants, both pgTAP-asserted:**

1. `assignment_count` **equals** the number of rows
   `list_vendor_product_assigned_retailers()` returns for the same product. Both are the same
   set, computed with the same predicate over the same table.
2. `active_assignment_count` **equals** the number `list_vendor_products()` already publishes
   for the same product — reproduced predicate-for-predicate, so the list and the detail can
   never disagree.

**Why the relationship join is `LEFT`.** The insert trigger requires a `vendor_retailers` row
when an assignment is created, so in practice every row has one. It is joined `LEFT` anyway:
an `INNER` join would make an assignment row *vanish* from the list if its relationship row
ever ceased to exist, while `assignment_count` — taken from the assignment table alone — would
keep counting it, breaking invariant 1. A missing relationship surfaces as a **null
`relationship_id` and null `relationship_status`**, and a client must treat a null
`relationship_id` as "not cross-linkable" rather than as an error.

## 9. Product-image decision — **option A: no image field**

The audit searched the whole repository:

- `public.vendor_products` has **no** image, photo, media, asset, thumbnail or storage column.
  Migration `20260727090000` states this explicitly: *"No product image column or image bucket
  — no compatible product-image storage exists and the current application does not require
  one."*
- **No storage bucket holds product media.** The only buckets in this schema are the receipt
  ones (`20260726090000`). Asserted in pgTAP against `storage.buckets`.
- Neither web product page renders an image, and `lib/products/*` contains **zero** storage
  calls.

Nothing is returned, because nothing exists. Options B (a public stable URL) and C (a signing
Edge Function) both presuppose a column that does not exist; building either now would be
introducing an image system to decorate the first Flutter screen — precisely what the
milestone forbids.

Three layers enforce it: the output columns are pinned exactly; the static suite forbids any
column matching an image/storage/URL pattern *and* forbids either function body from touching
the `storage` schema or naming a signed URL; and pgTAP asserts that `public.vendor_products`
still has no such column and no product bucket exists.

---

## 10. Authorization and tenant isolation

### The chain

```
auth.uid()
  → public.get_vendor_super_admin_context()      -- 0 args; filters on auth.uid() internally
      ACTIVE profile owned by auth.uid()
      ACTIVE organization_members row
      ACTIVE VENDOR organization
      ACTIVE VENDOR_SUPER_ADMIN role
  → order by ctx.organization_id limit 1          -- the shipped multi-Vendor tie-break
  → public.has_organization_permission(v_vendor, 'PRODUCTS_READ')
  → (companion only) has_organization_permission(v_vendor, 'RETAILERS_READ')
  → product matched on BOTH its own id AND the derived Vendor
```

**No function accepts** a user id, auth user id, profile id, Vendor organization id,
membership id, role code, permission code, tenant id, Retailer organization id, product status
or assignment status. Both take exactly one argument: `p_product_id uuid`. This is asserted
three ways — pgTAP against `pg_proc.proargnames`/`proargmodes`, and twice statically.

### Which permissions, and why the requirement is split

| Function | Requires | Because it reads |
| --- | --- | --- |
| `list_vendor_products()` *(reused)* | `PRODUCTS_READ` | `vendor_products`, `vendor_product_retailer_assignments` |
| `get_vendor_product_detail()` | `PRODUCTS_READ` | the same two tables |
| `list_vendor_product_assigned_retailers()` | `PRODUCTS_READ` **and** `RETAILERS_READ` | those two **plus** `organizations` and `vendor_retailers` |

Both permissions already exist and are already mapped to `VENDOR_SUPER_ADMIN`
(`20260727090000` and `20260717115211`). **No permission is seeded and no mapping is changed**,
so no shipped caller's access changes. What the split buys is that a future products-only role
cannot read the Retailer directory sideways through a product screen.

Neither read requires `PRODUCT_RETAILER_ASSIGN` or `PRODUCTS_MANAGE`. Requiring the permission
to *change* assignments in order to *read* them is exactly what makes the existing editor read
unusable as a read contract.

### Confirmed denial behaviour (all pgTAP-asserted, all `42501`)

| Caller | List | Detail | Assignments |
| --- | --- | --- | --- |
| Signed out | denied | denied | denied |
| Authenticated, no organization | denied | denied | denied |
| Vendor member, non-Super-Admin role (`FINANCE_ADMIN`) | denied | denied | denied |
| Vendor Super Admin, **SUSPENDED profile** | denied | denied | denied |
| Vendor Super Admin, **DEACTIVATED membership** | denied | denied | denied |
| Retailer Owner | denied | denied | denied |
| Retailer Manager | denied | denied | denied |
| Sales Staff *(at a Retailer the product is actively assigned to)* | denied | denied | denied |
| Vendor Super Admin without `PRODUCTS_READ` | denied | denied | denied |
| Vendor Super Admin without `RETAILERS_READ` | **allowed** | **allowed** | denied |

The refusal message is the single generic string `Not authorized to view products` — the same
wording `list_vendor_products()` already raises — so a caller cannot tell the three operations
apart, nor tell "not signed in" from "not a Vendor Super Admin" from "your role lost
`RETAILERS_READ`".

### Tenant isolation

| Situation | Result |
| --- | --- |
| Another Vendor's product id | **zero rows** (both reads) |
| An id that names nothing | **zero rows** |
| An id from another table (a relationship id) | **zero rows** |
| `null` | **zero rows** |
| Another Vendor's assignments | absent from every answer |
| Another Vendor's Retailer | never named |
| A product code shared with another Vendor's product | resolves to exactly one row — the caller's own |

All four zero-row cases raise **nothing**, and pgTAP asserts their SQLSTATEs are identical, so
an id sweep reveals neither the existence nor the size of another Vendor's catalogue.

This deliberately **differs** from `update_vendor_product`, `set_vendor_product_status` and
`list_vendor_product_retailer_assignments`, all of which raise `42501` for a foreign or
unknown product id. Those are not modified — the web depends on them exactly as they are — and
the new contract simply does not repeat the pattern.

---

## 11. Result and error semantics

### `list_vendor_products()` *(unchanged)*

| Situation | Result |
| --- | --- |
| Authorized Vendor with products | ordered rows, newest created first |
| Authorized Vendor with no products | **empty set** |
| Unauthorized caller | raises `42501` |
| Operational/database failure | exception propagates |

### `get_vendor_product_detail(uuid)`

| Situation | Result |
| --- | --- |
| Authorized, own product | **exactly one row** |
| Unknown product id | **zero rows** |
| Another Vendor's product | **zero rows — identical to unknown** |
| `null` selector | **zero rows — identical to unknown** |
| Unauthorized caller | raises `42501` |
| Operational failure | exception propagates |

### `list_vendor_product_assigned_retailers(uuid)`

| Situation | Result |
| --- | --- |
| Authorized, own product with assignments | ordered rows |
| Authorized, own product with **no** assignments | **empty set**, no raise |
| Unknown or foreign product | **zero rows — identical to the empty case** |
| `null` selector | **zero rows** |
| Assignments of another product | absent |
| Assignments of another Vendor | absent |
| Retailers with no assignment row | **absent** (not a null-status row) |
| Unauthorized caller | raises `42501` |
| Operational failure | exception propagates |

**The ambiguity is in the safe direction:** an unknown product and a genuinely unassigned
product both return an empty set. A client therefore calls the **detail** read first — zero
rows *there* is the authoritative "this product is not addressable by you".

### Ordering (exact)

| Read | Order |
| --- | --- |
| `list_vendor_products()` | `created_at desc, id desc` *(newest first)* |
| `get_vendor_product_detail()` | one row |
| `list_vendor_product_assigned_retailers()` | `retailer_name asc, retailer_organization_id asc` |

Both orderings are **total**, so a re-fetching client sees a stable sequence. pgTAP proves the
assignment ordering against a fixture where two Retailers deliberately share a name.

---

## 12. Nullability

| Field | Nullable | Note |
| --- | --- | --- |
| `product_id`, `product_code`, `product_name`, `status` | **no** | `NOT NULL` columns |
| `barcode`, `brand`, `description` | **yes** | returned as `null`, never coalesced to `''` |
| `created_at`, `updated_at` | **no** | `NOT NULL` with defaults |
| `assignment_count`, `active_assignment_count` | **no** | `count(*)` over an empty set is `0` |
| `relationship_id`, `relationship_status` | **yes** | only if the relationship row is absent — see § 8 |
| `retailer_organization_id`, `retailer_name`, `retailer_status` | **no** | primary-key join to `organizations` |
| `assignment_status`, `assigned_at`, `assignment_updated_at` | **no** | `NOT NULL` columns on the assignment row |

Nothing is defaulted, substituted or fabricated. The static suite forbids a `coalesce` over
any status or optional field and forbids a `case when … status` derivation; pgTAP asserts an
all-null product returns three nulls.

---

## 13. Performance

| | Before (web assembly) | After (shared contract) |
| --- | --- | --- |
| **List** | 2 round trips, 1 row per product, counts aggregated in SQL | **unchanged — already optimal** |
| **Detail** | 3 round trips; trip 2 transfers the **entire catalogue** so TypeScript can `find()` one row | **2 round trips**, one row each, whatever the catalogue size |
| **Assignments** | returns one row per *managed Retailer* (assigned or not); client filters | one row per *assignment*; no client-side filter |

**Query behaviour of the two new reads:**

- `get_vendor_product_detail` — one statement. The product is found by primary key; both
  counts come from a **single** `LEFT JOIN LATERAL` aggregate over an index range
  (`vendor_product_assign_product_status_idx` leads on `vendor_product_id`), so the assignment
  table is scanned once and the wire carries one row.
- `list_vendor_product_assigned_retailers` — one ownership lookup by primary key, then one
  statement: an index range over the product's assignments, a primary-key join to
  `organizations`, and a unique-key join (`vendor_retailers_unique_pair`) to
  `vendor_retailers`. Each contributes at most one row.

**What is structurally impossible here** (each asserted): N+1 assignment queries · one RPC per
product · one Retailer-name query per assignment · one relationship query per assignment ·
client-side joins · per-row Vendor resolution (the context function is called **exactly once**
per operation, the permission helpers exactly once each) · duplicate product rows from an
assignment join (a lateral, not a join) · duplicate Retailer rows (schema-guaranteed) ·
fetching assignment rows merely to count them.

**No index was added.** Every predicate is served by an existing one: `vendor_products`'
primary key, `vendor_product_assign_product_status_idx`, `organizations`' primary key, and
`vendor_retailers_unique_pair`. A speculative index would be a write cost with no measured
cause.

---

## 14. Current limitations

1. **Multi-Vendor callers see one Vendor.** A Super Admin of two Vendors reads the
   **lowest-id** Vendor's catalogue, deterministically, on every request — the shipped
   behaviour of every Vendor RPC and of the web itself. It is reproduced verbatim rather than
   "fixed", because changing it would change which products an existing Vendor sees as a side
   effect of a mobile read. See `docs/mobile-backend-contract.md` § 7 Q2.
2. **No pagination.** Both reads return a full set. Bounded by the Vendor's catalogue size and
   Retailer count respectively; a `keyset` parameter can be added later without changing the
   column contract.
3. **No product image, anywhere.** § 9.
4. **No search or filter.** A client filters the returned list. Adding a server-side filter
   parameter would need care: a filter that narrows rows is fine, but a *status* filter would
   put a status value in a caller's hands, which this contract deliberately refuses.
5. **`relationship_id` can be null.** § 8. Treat it as "not cross-linkable", never as an error.
6. **No category field**, because no category column exists.
7. **The existing editor read is unchanged**, including its `42501` for a foreign product id
   and its `retailer_organization_id`-only addressing. Web still uses it.
8. **`assignment_updated_at` is not a `withdrawn_at`.** It is the row's real `updated_at`. For
   an `INACTIVE` row it *is* the withdrawal moment; do not read it as one for an `ACTIVE` row.

---

## 15. Web compatibility

**Nothing visible changes.** This branch adds two SQL functions, one pgTAP suite, one static
suite and this document.

- `lib/products/vendor-products.ts` — **unmodified**. Still calls the same seven RPCs by the
  same names, still contains zero direct table reads. Asserted (test 37).
- `app/(admin)/products/page.tsx`, `app/(admin)/products/[productId]/page.tsx`,
  `actions.ts`, `product-forms.tsx`, `product-form-state.ts` — **unmodified**. The route's
  file list is asserted (test 38).
- `lib/products/product-normalization.ts` — **unmodified**; both status vocabularies still
  hold exactly two values (test 40).
- `lib/products/retailer-products.ts` — **unmodified** (test 39).
- All eight shipped product functions keep their exact names, signatures, permissions and
  bodies. The migration contains no `create or replace`, no `drop`, and no `alter function`.
- Product creation, editing, status changes, assignment, withdrawal, Retailer onboarding,
  authorization, audit logging and storage behaviour are all untouched.

The web may migrate onto `get_vendor_product_detail()` in a later milestone — it would remove
the whole-catalogue transfer from the detail page — but that is deliberately **not** done here.

---

## 16. Security boundary

| Rule | How it holds |
| --- | --- |
| Identity comes from `auth.uid()` only | via `get_vendor_super_admin_context()`; neither body calls `auth.uid()` directly or reads `auth.users` |
| The Vendor is resolved server-side | derived once per call; never a parameter |
| Authorization is delegated, not reimplemented | `has_organization_permission`; no role code appears in either body |
| Fail closed | one generic `42501` covering every unauthorized case |
| RLS preserved | both product tables keep RLS enabled with **zero policies**; no policy is created, altered or dropped anywhere |
| No broad grants | `EXECUTE` to `authenticated` only; `REVOKE` from `PUBLIC` and `anon`; no table grant of any kind |
| No service-role design | `service_role` is granted nothing — these reads have no `auth.uid()` on such a connection and could only refuse |
| No dynamic SQL | none |
| Empty `search_path` | both functions; every reference schema-qualified |
| Read-only | both `STABLE`; no `insert`, `update`, `delete`, `for update`, or `audit_logs` reference; pgTAP proves calling all three writes nothing |
| No sensitive personal data | no email, phone, name, address, contact, token, hash or invitation field is returned or read |

---

## 17. Flutter integration sequence

```
1. sign in                       → Supabase Auth
2. get_my_portal_context()       → capability HINTS only (presentation, never authority)
3. list_vendor_products()        → the catalogue screen  [existing RPC, unchanged]
4. tap a product
     get_vendor_product_detail(product_id)
       → 0 rows ⇒ "not found"  (identical for unknown, foreign and null)
       → 1 row  ⇒ render name, code, barcode, brand, description, status,
                  "N of M Retailers"  (active_assignment_count of assignment_count)
5. the assignments section
     list_vendor_product_assigned_retailers(product_id)
       → [] ⇒ "Not assigned to any Retailer yet"
       → rows ⇒ one tile per Retailer: name, assignment_status badge,
                relationship_status + retailer_status badges, assigned_at
6. tap a Retailer tile
     relationship_id != null
       → get_vendor_retailer_detail(relationship_id)     [shipped 20260731090000]
     relationship_id == null
       → not cross-linkable; render the row without navigation
```

**Cross-linking is the point of `relationship_id`.** It is the same `vendor_retailers.id` that
`list_vendor_retailers()` and `get_vendor_retailer_detail()` already use, so a product's
assignment row opens the already-shipped Vendor Retailer detail screen with no second lookup.
pgTAP asserts the id returned here is the same id `list_vendor_retailers()` returns *and* that
it opens `get_vendor_retailer_detail()` successfully.

Every capability from `get_my_portal_context()` is a **presentation hint**. The database
re-derives authority on every call.

### 17.1 The detail read must come first — it is the only disambiguator

Both reads return an empty set for a product the caller cannot address, and the companion
returns an empty set for a product that simply has no assignments. **Those two are
indistinguishable from the companion alone**, and that ambiguity is deliberate: closing it
would mean telling a caller whether another Vendor's product exists.

The detail read is what separates them, so the sequence is **not** interchangeable and the two
calls must **not** be issued in parallel:

| Case | `get_vendor_product_detail` | then `list_vendor_product_assigned_retailers` | Render |
| --- | --- | --- | --- |
| Valid product, **zero assignments** | **1 row** | `[]` | detail + "Not assigned to any Retailer yet" |
| **Unknown** product | **0 rows** | *(not called)* | "Not found" |
| **Foreign** product (another Vendor's) | **0 rows** | *(not called)* | "Not found" — byte-identical to unknown |
| **Null** selector | **0 rows** | *(not called)* | "Not found" |
| Unauthorized caller | `42501` | `42501` | one generic denial |

Unknown and foreign are **intentionally** indistinguishable, at both layers. A client must not
attempt to tell them apart, and must not present them differently.

### 17.2 Malformed selectors: reject in Flutter, before the call

A selector that is not a valid UUID never reaches either function. PostgreSQL rejects it while
casting the argument, **before the body runs and therefore before any authorization check**:

```
select * from public.get_vendor_product_detail('not-a-uuid');
→ 22P02  invalid input syntax for type uuid: "not-a-uuid"
```

`22P02` (`invalid_text_representation`) is a **fourth, distinct outcome** — not `42501`, not
zero rows. It leaks nothing (it describes only the literal the caller sent, and the function
never executed), but it is a raw database error surfacing in a client.

**Flutter should validate the UUID locally and never issue the call.** Three reasons:

1. A malformed id can only come from a client bug or a hand-crafted deep link — it is never a
   state a user can reach through the UI, so it deserves a local guard, not a round trip.
2. Handling `22P02` at the call site means teaching every product screen a PostgreSQL error
   code, when the same condition is decidable offline in one line.
3. It keeps the client's error model to the three the contract actually defines: **denied**
   (`42501`), **not found / empty** (zero rows), and **unavailable** (transport or other
   failure).

A malformed id should therefore be treated exactly as "not found" in the UI — the same screen
an unknown or foreign id produces — decided locally rather than by the database.

---

## 18. Tests

### pgTAP — `supabase/tests/database/vendor_product_reads_test.sql`

**180 assertions**, all passing. Sections:

| Section | Covers |
| --- | --- |
| A | exact signatures, zero-identity input, exact output columns, the detail-is-list-plus-one relationship, forbidden field classes (auth, contact, image/storage, policy internals, invented commercial fields), `SECURITY DEFINER`, empty `search_path`, `STABLE`, grants for `authenticated`/`anon`/`PUBLIC`/`service_role` |
| B | both product tables still RLS-enabled with **zero policies** and no browser privilege; both status CHECKs unchanged; the (product, Retailer) unique index still present |
| C | every denial: signed out, no organization, non-Super-Admin Vendor role, suspended profile, deactivated membership, Retailer Owner, Retailer Manager, Sales Staff — plus indistinguishability across callers and functions |
| D | list identity, field and null accuracy, `INACTIVE` visibility, one row per product regardless of assignment count, newest-first ordering |
| E | detail row count, field accuracy, all-null optional fields, and byte-identical agreement with the list on every shared column |
| F | the full count specification against four status combinations, the `assignment_count = companion rows` invariant, the `list = detail` active-count invariant, zero-not-null for an unassigned product, cross-Vendor exclusion |
| G | assigned-Retailers membership (never-assigned Retailers absent; the editor read still returns them), never-null `assignment_status`, per-row status accuracy, real relationship and organization ids, the cross-link into `get_vendor_retailer_detail()`, exact timestamps, no duplicate Retailers, other products' assignments absent, empty-not-refused |
| H | tenant isolation and the non-leaking selector in both directions, including a product code shared across Vendors |
| I | calling all three reads writes no product, no assignment and no audit row |
| J | ordering stability across repeat calls and under a duplicated Retailer name |
| K | the permission requirement proved by **removing** seeded mappings: `PRODUCTS_READ` gates all three; `RETAILERS_READ` gates only the companion; `PRODUCT_RETAILER_ASSIGN` still gates only the old editor read |
| L | no permission was seeded and no mapping changed; `SALES_STAFF` still holds none of the four catalogue permissions (and still holds only the narrow `RECEIPT_PRODUCTS_READ`) |
| M | a **deleted** Vendor–Retailer relationship: the assignment row survives, `relationship_id` and `relationship_status` are genuinely `NULL` (never fabricated), the Retailer's own name/status/id are unaffected, `assignment_count` still equals the companion's row count, ordering is unchanged, only one row loses its id, and the tenant boundary still holds |

### Static — `lib/products/vendor-product-reads-contract.test.ts`

**40 tests**, all passing. Migration hygiene and forward-only ordering · exactly two functions
and no table/policy/index/seed/grant/write · no permission invented · no applied migration
referenced or redefined · the pgTAP suite exists and rolls back · exact signature and shared
selector name · forbidden parameter list · delegated authorization with the shipped
multi-Vendor tie-break · the split permission requirement · ownership compared against the
derived Vendor · definer hardening, schema qualification, no writes, no row locks · generic
denial with no internal identifier · zero rows for an unaddressable id · exact privilege
statements · the exact output contract including the parsed detail-equals-list-plus-one
relationship and matching `bigint` types · forbidden auth/contact/invitation/storage/image and
invented-commercial field classes · single lateral aggregate, assignment-driven companion,
once-per-call authorization, one row-producing statement, total ordering, no filtering or
fabrication · and the four web-compatibility guards.

### Repository totals after this milestone

| | Count |
| --- | --- |
| Migrations | **37** |
| Database test files | **6** |
| pgTAP assertions (all files) | **711** |
| pgTAP assertions added here | **180** |
| `npm test` tests | **897** |
| `npm test` tests added here | **40** |

---

## 19. Next Flutter milestone

The Vendor Super Admin mobile surface now has Retailers (list/detail/shops), Users
(list/detail), Roles (list/detail/permissions) and Products (list/detail/assignments) — all
read-only, all cross-linkable.

Remaining Vendor reads, in the order the audit recommends:

1. **Vendor Audit Logs** — `list_vendor_audit_logs()`. Not started. The table exists
   (`20260716130351`) and the web has a feed; a mobile contract needs paging and a
   non-leaking actor representation.
2. **Vendor dashboard summary** — the last of the five RPCs
   `docs/mobile-backend-contract.md` § 8 counts as outstanding.

Neither is begun here. **Product writes remain deliberately out of scope**: creating, editing,
activating, assigning and withdrawing all exist as shipped RPCs but are not part of any mobile
milestone yet, and their `void` returns and message-discriminated duplicates
(`docs/mobile-feature-matrix.md` fixes 4–5) should be addressed before a client depends on
them.
