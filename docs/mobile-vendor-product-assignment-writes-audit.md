# Mobile Vendor Product-to-Retailer Assignment Writes — Audit

**Milestone:** mobile-safe Vendor Product-to-Retailer assignment writes
**Branch:** `feature/mobile-vendor-product-assignment-writes`
**Scope:** backend / web repository only. **No Flutter file is touched.**

---

## 0. Conclusion, stated first

**Audit outcome B: the existing PostgreSQL assignment write functions are already safe for
Flutter and are reused unchanged. They lacked deterministic behavioural tests and mobile
documentation; this milestone supplies both and adds no migration.**

| | |
|---|---|
| New migration | **None.** |
| New RPC | **None.** |
| Modified RPC | **None.** |
| Modified web file | **None.** |
| Modified Flutter file | **None.** |
| Added | one pgTAP suite (195 assertions), one static contract suite (47 tests), this document, and updates to the three mobile contract documents |

The two shipped functions

```
public.assign_vendor_product_to_retailer(p_product_id uuid, p_retailer_organization_id uuid)
  returns void
public.unassign_vendor_product_from_retailer(p_product_id uuid, p_retailer_organization_id uuid)
  returns void
```

already are the shared, tenant-derived, permission-gated, transactionally-audited write
contract a second client needs. Duplicating them for mobile would be a second definition of
"assign a product", free to drift from the one the web calls.

**Flutter-only next step:** build the assignment surface against these two RPCs. No backend
work remains for this milestone.

---

## 1. The complete current flow, traced end to end

### 1.1 Where assignment starts

One place, and only one: the **Vendor product detail page**,
`app/(admin)/products/[productId]/page.tsx`, section *"Retailer assignments"*.

There is **no** assignment surface on the Retailer detail page, no assignment entry in a
product action menu, no bulk control, no CSV path, and no assignment dialog — the surface is an
inline table with one button per row. Every action on it is **real**; nothing is a placeholder.

### 1.2 The call chain

```
app/(admin)/products/[productId]/page.tsx      renders the matrix; no data access of its own
  └─ getProductRetailerAssignments(productId)  lib/products/vendor-products.ts
       └─ RPC list_vendor_product_retailer_assignments(p_product_id)

  └─ <AssignRetailerForm> / <UnassignRetailerForm>   app/(admin)/products/product-forms.tsx
       └─ assignProductAction / unassignProductAction   app/(admin)/products/actions.ts
            └─ assignProductToRetailer / unassignProductFromRetailer
                 lib/products/vendor-products.ts  →  runWrite(rpc, params)
                      └─ RPC assign_/unassign_vendor_product_…(p_product_id, p_retailer_organization_id)
```

**There is no direct table write anywhere on this path.** `lib/products/vendor-products.ts`
contains zero `.from(` calls, `app/(admin)/products/actions.ts` contains zero, and neither
constructs a service-role client — the RPC runs under the **caller's own token** through the
ordinary publishable-key server client. `public.vendor_product_retailer_assignments` has RLS
enabled with **zero policies** and **no privilege granted to `anon` or `authenticated`**, so
the two RPCs are structurally the only way in.

### 1.3 Round trips

| Operation | Round trips today |
|---|---|
| Render the assignment matrix | 2 (`list_vendor_products` for the product, `list_vendor_product_retailer_assignments` for the matrix) |
| Assign | **1** |
| Withdraw | **1** |

Eligibility is **not** checked separately from the mutation. Authorization, ownership proof,
product eligibility, Retailer eligibility, the mutation and the audit insert are all inside one
`plpgsql` function body — therefore one statement, one transaction, one round trip.

---

## 2. The four intended actions, mapped onto two functions

| Intended action | Implemented by | Notes |
|---|---|---|
| 1. Assign a product to an eligible connected Retailer | `assign_vendor_product_to_retailer` | inserts when no row exists |
| 2. Activate an existing inactive assignment | `assign_vendor_product_to_retailer` | **same function** — flips the existing row back to `ACTIVE` |
| 3. Deactivate an active assignment | `unassign_vendor_product_from_retailer` | separate function |
| 4. Preserve assignment history | the schema | one row per pairing for all time; nothing deletes |
| 5. Keep ownership isolated | both | every id filtered on the id **and** the derived Vendor |
| 6. Create the audit event transactionally | both | one `insert into public.audit_logs` in the same body |

**This is audit outcome D**: creation and activation are one upsert-like operation, and
deactivation is separate. That split is correct and must not be "fixed" into three functions,
because **the two operations have genuinely different eligibility rules** (§ 5) — a single
`set_assignment_status(product, retailer, status)` would have to branch on the status anyway,
and would give the eligibility rules a second home.

---

## 3. Identifier decision

**Decision: option B — `p_product_id` + `p_retailer_organization_id`.** This is the shipped
contract and it is reused unchanged.

Why not the relationship id (`vendor_retailers.id`):

* **It is what the web already sends.** `list_vendor_product_retailer_assignments()` returns
  `retailer_organization_id` and no relationship id; the assignment matrix's only source of
  Retailer identity is that column, and both Server Actions pass it straight through.
* **The stored column is `retailer_organization_id`.**
  `vendor_product_retailer_assignments` stores the Retailer organization directly and has **no
  relationship_id column at all**, so a relationship-id parameter would need a translation step
  whose failure modes (missing relationship, replaced relationship) have no correct answer.
* **`relationship_id` is nullable in the read contract.**
  `list_vendor_product_assigned_retailers()` joins `vendor_retailers` LEFT precisely so an
  assignment row cannot vanish if its relationship row ever ceased to exist. A write addressed
  by a nullable identifier would be un-callable for exactly the historical rows that most need
  withdrawing.
* **Ownership is still proven.** The Retailer organization id is **not** authorization: the same
  Retailer may legitimately be managed by two Vendors, and the pgTAP suite exercises exactly
  that (Vendor A and Vendor C both manage `ret_ok`). The write reaches it only through
  `vendor_retailers` filtered on the **derived** Vendor, so Vendor A's call can only ever touch
  Vendor A's own assignment row.

**Both identifiers are already available to Flutter**, so this decision costs the client
nothing: `list_vendor_retailers()` and `list_vendor_product_assigned_retailers()` each return
`relationship_id` **and** `retailer_organization_id`. The "two address spaces" concern recorded
against V-16 in `docs/mobile-role-flow-map.md` is therefore **resolved by the reads**, not by a
change to the writes — a mobile screen addresses the Retailer detail screen by
`relationship_id` and addresses the assignment write by `retailer_organization_id`, from the
same row.

Neither write accepts both identifiers, and neither accepts anything else.

---

## 4. Trusted identity and tenant authority

Both functions derive the Vendor server-side, with the established pattern reproduced verbatim:

```sql
select ctx.organization_id into v_vendor
from public.get_vendor_super_admin_context() ctx
order by ctx.organization_id
limit 1;
```

`get_vendor_super_admin_context()` takes **no arguments** and filters on `auth.uid()`
internally, evaluating the whole chain — ACTIVE profile owned by `auth.uid()`, ACTIVE
membership, ACTIVE VENDOR organization, ACTIVE `VENDOR_SUPER_ADMIN` role. The actor is
`auth.uid()` and comes from nowhere else.

**There is no user id, auth user id, profile id, membership id, Vendor organization id, tenant
id, role code, permission code, actor profile id or audit organization id parameter on either
function.** The two parameters are the product id and the Retailer organization id, and both are
addresses filtered against the derived Vendor.

**Multi-Vendor behaviour is preserved, not changed.** A Super Admin of two Vendors acts as the
**lowest organization id**, deterministically, on every request — the shipped rule for every
Vendor RPC in this schema. The pgTAP suite computes the expected Vendor from the fixture rather
than assuming a sort order, and asserts that the higher-id Vendor's product is refused. It is a
documented limitation (§ 12), not a defect repaired here: changing it would change which
catalogue an existing Vendor sees as a side effect of a mobile milestone.

---

## 5. Status and eligibility matrix

Status values are read from the schema, not inferred:

| Entity | Allowed values | Source |
|---|---|---|
| Product | `ACTIVE`, `INACTIVE` | `vendor_products_status_allowed` |
| Retailer organization | `ACTIVE`, `SUSPENDED`, `DEACTIVATED` | `organizations_status_allowed` |
| Vendor–Retailer relationship | `ACTIVE`, `SUSPENDED`, `DEACTIVATED` | `vendor_retailers_status_allowed` |
| Assignment | `ACTIVE`, `INACTIVE` | `vendor_product_assignments_status_allowed` |

### The rule, stated once

* **Assign** requires product `ACTIVE` **and** relationship `ACTIVE` **and** Retailer
  organization `ACTIVE`. Reactivation goes through the same gate — it is the same call.
* **Withdraw** requires **none** of the three. Only that the pairing is addressable by this
  Vendor.

That asymmetry is deliberate: a Vendor must be able to withdraw a product from a Retailer it has
since suspended, which is exactly when withdrawal matters most. A status gate on withdrawal
would strand historical assignments as permanently un-endable.

### The matrix

`create` = no row exists yet · `activate` = an `INACTIVE` row exists · `deactivate` = an
`ACTIVE` row exists.

| Product | Retailer org | Relationship | create | activate | deactivate |
|---|---|---|---|---|---|
| ACTIVE | ACTIVE | ACTIVE | **allowed** | **allowed** | **allowed** |
| ACTIVE | ACTIVE | SUSPENDED | denied `42501` | denied `42501` | **allowed** |
| ACTIVE | ACTIVE | DEACTIVATED | denied `42501` | denied `42501` | **allowed** |
| ACTIVE | SUSPENDED | ACTIVE | denied `42501` | denied `42501` | **allowed** |
| ACTIVE | DEACTIVATED | ACTIVE | denied `42501` | denied `42501` | **allowed** |
| INACTIVE | ACTIVE | ACTIVE | denied `55000` | denied `55000` | **allowed** |
| INACTIVE | any non-ACTIVE | any | denied `55000` | denied `55000` | **allowed** |
| any | not this Vendor's | — | denied `42501` | denied `42501` | denied `42501` |

**Same-status requests are silent no-ops, never errors:**

| Request | Existing state | Result |
|---|---|---|
| assign | `ACTIVE` row | returns normally · **no row version written** · **no audit row** |
| withdraw | `INACTIVE` row | returns normally · no write · no audit row |
| withdraw | no row at all | returns normally · **no row is created** · no audit row |

**Check order is observable and safe.** Ownership is proven first, then the product's status,
then the Retailer's eligibility. So a call in which both the product and the Retailer are
ineligible reports the **product** problem (`55000`). That leaks nothing: the `55000` branch is
reachable only after the caller has been shown to own the product, and its status is already on
their own catalogue page.

---

## 6. Authorization

**The permission is `PRODUCT_RETAILER_ASSIGN`, and it is distinct from `PRODUCTS_MANAGE`.**

Seeded in `20260727090000_vendor_product_catalog_foundation.sql`, mapped to
`VENDOR_SUPER_ADMIN` only. This was **verified by removing each seeded mapping in turn inside
the pgTAP transaction**, not assumed:

| Caller state | assign | withdraw | `set_vendor_product_status` |
|---|---|---|---|
| Vendor Super Admin, all three product permissions | allowed | allowed | allowed |
| **minus `PRODUCT_RETAILER_ASSIGN`** | `42501` | `42501` | **allowed** |
| **minus `PRODUCTS_MANAGE`** | **allowed** | **allowed** | `42501` |
| minus `PRODUCTS_READ` | allowed | allowed | allowed |

So: `PRODUCTS_MANAGE` alone does **not** grant assignment, and `PRODUCT_RETAILER_ASSIGN` alone
**is sufficient** for both writes. `PRODUCTS_READ` gates neither.

Every other caller state is refused with `42501`:

| Caller | Result |
|---|---|
| signed out | `42501` |
| Retailer Owner / Retailer Manager / Sales Staff | `42501` |
| Vendor member with a membership but no role | `42501` |
| Vendor member holding a non-Super-Admin Vendor role (`FINANCE_ADMIN`) | `42501` |
| SUSPENDED profile, even holding the role | `42501` |
| DEACTIVATED membership, even holding the role | `42501` |
| Super Admin of a DEACTIVATED Vendor organization | `42501` |
| malformed / unknown / foreign product id, and `null` | `42501` |
| unknown / foreign Retailer id, and `null` | `42501` |

**Flutter never inspects or sends a permission code.** It calls the RPC and handles `42501`.

A **malformed UUID** never reaches the function: PostgREST rejects it at the type boundary with
`22P02`, whose message names a type and no table, column or constraint. The web additionally
screens both ids with a UUID pattern before calling, purely to avoid a pointless round trip.

---

## 7. Tenant isolation, and refusals that leak nothing

Every caller-supplied id is filtered on **two** columns — the id itself and the Vendor derived
from `auth.uid()`. An id belonging to another Vendor matches zero rows.

| Attempt | Result |
|---|---|
| Vendor A assigns Vendor B's product to Vendor A's own Retailer | `42501` |
| Vendor A assigns its own product to Vendor B's Retailer | `42501` |
| Vendor A pairs Vendor B's product with Vendor B's Retailer | `42501` |
| Vendor B reaches the pairing Vendor A created | `42501` |

**Foreign existence does not leak.** The refusals are compared as **messages**, not merely as
SQLSTATEs — two different sentences carrying the same code would still be an oracle:

* a foreign product, a nonexistent product and `null` produce one identical message;
* a foreign Retailer and a nonexistent Retailer produce one identical message;
* **suspended, deactivated, unrelated and nonexistent Retailers all produce the same single
  refusal**, so a caller cannot learn that a Retailer exists but is suspended.

No refusal names a table, column, index, constraint or database-level error phrasing, and none
echoes another Vendor's organization name, Retailer name, product name or product code.

**The same Retailer organization id is legitimately addressable by two Vendors.** The fixture
has Vendor A and Vendor C both managing `ret_ok`; Vendor A's assignment is Vendor A's alone, and
exactly one assignment row exists against that shared Retailer.

---

## 8. Assignment-row integrity

`public.vendor_product_retailer_assignments`
(`20260727090000_vendor_product_catalog_foundation.sql`):

| Property | Value |
|---|---|
| Primary key | `id uuid default gen_random_uuid()` |
| FK `vendor_product_id` | → `vendor_products(id)` **on delete restrict** |
| FK `retailer_organization_id` | → `organizations(id)` **on delete restrict** |
| FK `assigned_by_profile_id` | → `profiles(id)` **on delete restrict** |
| Unique | `vendor_product_retailer_assign_unique_idx (vendor_product_id, retailer_organization_id)` — **UNIQUE and UNPARTIAL** |
| Status constraint | `check (status in ('ACTIVE','INACTIVE'))` |
| Default status | `'ACTIVE'` |
| `assigned_at` | `not null default now()` — **overwritten on reactivation** |
| `updated_at` | `not null default now()`, maintained by `set_updated_at` trigger on every UPDATE |
| `relationship_id` column | **does not exist** — the Retailer organization is stored directly |
| Delete behaviour | RESTRICT on both sides; **nothing in the schema deletes an assignment row** |
| RLS | enabled, **zero policies**, zero privileges for `anon` / `authenticated` |

Triggers:

* `vendor_product_assign_assert_link` (insert, and update of either key) — the Retailer must be
  a `RETAILER` organization and a `vendor_retailers` row must link it to the product's Vendor.
  Defence in depth beneath the RPCs' stricter status rules.
* `vendor_product_assign_assert_immutable` — **a pairing cannot be re-pointed**. Even a direct
  `UPDATE` of `retailer_organization_id` raises `23514`. Proven in pgTAP.
* `set_updated_at_on_vendor_product_assignments`.

**Duplicates are structurally impossible.** The unique index is unpartial, so a withdraw + fresh
insert cycle cannot accumulate a second history row — attempted directly, it raises `23505` for
both an `ACTIVE` and an `INACTIVE` existing row.

**Hard deletion is prevented by design, not convention.** Neither installed function contains a
`DELETE` or a `TRUNCATE` (asserted against `pg_proc.prosrc`, so a later `CREATE OR REPLACE`
cannot slip past it), and the browser roles hold no `DELETE` privilege on the table.

**No constraint, index or column was added or changed by this milestone**, so there is no
existing-data compatibility question and no write cost.

---

## 9. Concurrency and atomicity

Authorization, eligibility, mutation and audit are one `plpgsql` body — therefore one
transaction. Neither function manages its own transaction boundary.

### The locks

* `assign` takes `FOR UPDATE` on the **product row** before it looks at anything else, so two
  concurrent assignments of the same product serialize completely.
* Both writes take `FOR UPDATE` on the **existing assignment row**, which orders an assign
  against a withdraw.
* `assign` takes `FOR SHARE` on the Retailer organization row while proving eligibility.

### The four races, run against a live two-session database

Each pair ran concurrently, session A holding its transaction open for 3 s while session B
entered the same operation:

| Session A (holds) | Session B | Starting state | Errors | Final rows | Final status | Audit rows |
|---|---|---|---|---|---|---|
| assign | assign | no row | **0** | **1** | `ACTIVE` | **1** |
| assign | assign | `INACTIVE` | **0** | **1** | `ACTIVE` | **1** |
| assign | withdraw | `INACTIVE` | **0** | **1** | `INACTIVE` | 2 |
| withdraw | assign | `ACTIVE` | **0** | **1** | `ACTIVE` | 2 |
| withdraw | withdraw | `ACTIVE` | **0** | **1** | `INACTIVE` | **1** |

**Every race serializes cleanly.** No duplicate row is ever created, no call errors, and the
audit-row count equals the number of **real** transitions — the loser of a same-operation race
finds the work already done and takes the silent no-op branch rather than raising a conflict.

The unique index remains the **final protection** and is reached only if the product-row lock is
somehow bypassed; when it is hit, `assign` catches it and reports a safe message that does not
name the index.

**No client idempotency key is added.** There is no demonstrated need: the no-op branches make
a repeated request harmless, and database uniqueness is the authority.

### Atomicity, proven rather than asserted

A trigger that fails every assignment audit `INSERT` was installed inside the pgTAP transaction.
With it in place:

* an `assign` call raises, **and no assignment row survives**;
* a `withdraw` call raises, **and the status is unchanged**.

So an audit failure rolls the mutation back, and a failed mutation leaves no audit row.

---

## 10. Audit behaviour

| Field | assign | withdraw |
|---|---|---|
| `action` | `PRODUCT_ASSIGNED_TO_RETAILER` | `PRODUCT_UNASSIGNED_FROM_RETAILER` |
| `entity_type` | `VENDOR_PRODUCT` | `VENDOR_PRODUCT` |
| `entity_id` | the **product** id | the **product** id |
| `organization_id` | the **derived** Vendor | the derived Vendor |
| `actor_profile_id` | `auth.uid()` | `auth.uid()` |
| `ip_address`, `user_agent` | null — the function cannot observe them truthfully | same |

**Metadata whitelist — exactly five keys, all display fields:**

`product_code`, `product_name`, `product_status`, `retailer_name`, `assignment_status`.

* `product_name` and `retailer_name` are **display-name snapshots** taken at write time.
* `assignment_status` records the state the operation **established** (`ACTIVE` / `INACTIVE`),
  not the one it replaced. There is no old/new pair — the action code carries the direction.
* **No key is an id**, organization, profile, membership, role, permission, token or contact
  field. There is no relationship reference of any kind.
* **No foreign name can appear**: the Retailer name is read through the derived Vendor's own
  relationship row, so it can only ever be a Retailer this Vendor manages.

**One successful mutation writes exactly one audit row. A no-op writes none** — which is what
stops a mobile double-tap producing two audit entries for one decision. **Failed authorization
attempts are not recorded anywhere**; the audit row is written inside the transaction that
succeeded.

**No audit metadata is returned to Flutter** — the writes return `void`.

**The action vocabulary did not grow.** Both codes are already in the set recorded by
`20260804090000_mobile_vendor_audit_log_reads.sql` and documented in
`docs/mobile-vendor-audit-log-reads-audit.md` § 5.2, so the shipped Flutter Audit Logs screen
maps them as known codes; an unmapped code would still render through the neutral humanization
fallback. **No Flutter change is required, and none is made.**

---

## 11. Result semantics, error contract and read-after-write

### Result

Both writes `returns void`. This is the shipped contract and is **deliberately not widened**:
changing a return type requires `DROP` + `CREATE`, which would break the web's calls and any
pinned client, for no security benefit. The consequence — **a no-op is indistinguishable from a
change** — is the known limitation already recorded as § 6.6 of
`docs/mobile-backend-contract.md`.

Nothing is returned, so no Vendor organization id, actor profile id, membership id, permission
code, role code, raw audit metadata, Retailer record, product record or unrelated assignment can
leak through a result. **No write returns an assignment collection.**

### Behaviour by outcome

| Outcome | Result |
|---|---|
| success | returns normally |
| already active (assign) | returns normally — silent no-op, no write, no audit |
| already inactive / never assigned (withdraw) | returns normally — silent no-op |
| ineligible product | `55000` · `Activate this product before assigning it to a Retailer` |
| ineligible / unknown / foreign Retailer or relationship | `42501` · `Select one of your active Retailers` (assign) or `Select one of your Retailers` (withdraw) |
| unknown / foreign / null product | `42501` · `Not authorized to manage this product` |
| permission denial, inactive caller, signed out | `42501` · `Not authorized to manage product assignments` |
| uniqueness race | `23505` · `That product is already assigned to this Retailer` (unreachable in practice — see § 9) |
| malformed UUID | `22P02` from PostgREST, before the function runs |
| operational failure | the web maps anything unclassified to a generic unavailable message |

No raw constraint name, SQL fragment or table name appears in any of these.

### The existing error mapping, and the one literal it depends on

`lib/products/vendor-products.ts::classifyWriteError` branches on **SQLSTATE only** for
`42501`, `55000` and `23514`. It matches English message text in exactly one place: the `23505`
branch, against two literals defined in this repository's own migrations — *"A product with that
code already exists"* and *"A product with that barcode already exists"*. **Neither is an
assignment message**, so an assignment uniqueness race degrades to the generic
*"That product already exists."* notice. That is cosmetically imprecise in a race that § 9 shows
does not occur in practice, and it is not changed here: altering it would change visible web
wording in a backend-only milestone.

Both literals describe the caller's **own** catalogue — the unique indexes are scoped per Vendor
— so no foreign-tenant data can appear in a message.

### Read-after-write

Because the writes return `void`, **a client re-reads canonical state**. The pgTAP suite proves
the three shipped reads agree with the table after every mutation:

| After | `assignment_count` | `active_assignment_count` | `list_vendor_product_assigned_retailers()` |
|---|---|---|---|
| no assignments | 0 | 0 | empty |
| one assign | 1 | 1 | 1 row, `ACTIVE` |
| withdraw | **1** | 0 | **1 row, `INACTIVE`** — still listed |
| re-assign | 1 | 1 | 1 row, `ACTIVE` — the row was reused, not duplicated |

`list_vendor_products().active_assignment_count` agrees with
`get_vendor_product_detail().active_assignment_count` at every step, and the assigned-Retailer
row count equals `assignment_count` exactly.

**Neither count consults relationship or Retailer status.** An `ACTIVE` assignment to a
`SUSPENDED` Retailer still counts as active — the shipped meaning of the number the web prints.
The companion read returns `retailer_status` and `relationship_status` honestly, so a client
wanting a narrower figure computes it from data it can see.

**Recommended Flutter sequence:** call the write; on success, re-read
`get_vendor_product_detail(productId)` and `list_vendor_product_assigned_retailers(productId)`.
Treat a no-op as success.

### The read contracts are unchanged

Asserted column-for-column, in order, in both the pgTAP and the static suite:

* `list_vendor_product_assigned_retailers(uuid)` → `relationship_id` (**nullable**),
  `retailer_organization_id`, `retailer_name`, `retailer_status`, `relationship_status`
  (**nullable**), `assignment_status` (never null), `assigned_at`, `assignment_updated_at`;
  ordered by `retailer_name, retailer_organization_id`.
* `get_vendor_product_detail(uuid)` → 11 columns including `status`, `assignment_count`,
  `active_assignment_count` (both `bigint`, both non-null), `updated_at`.
* `list_vendor_products()` → 10 columns including `active_assignment_count` (`bigint`).
* `list_vendor_product_retailer_assignments(uuid)` → the web's 6-column editor matrix,
  untouched.

---

## 12. Timestamp semantics — the one thing a client will get wrong

Verified against backdated rows, because `now()` is transaction-constant and cannot witness
this by itself:

| Operation | `assigned_at` | `updated_at` | `assigned_by_profile_id` |
|---|---|---|---|
| withdraw | **preserved** | moves | unchanged |
| reactivate | **overwritten with `now()`** | moves | **set to the current caller** |

**`assigned_at` is when the CURRENT assignment began — not when the pairing was first created.**
A client must not label it "first assigned". The pairing's full history is not recoverable from
the assignment row; it lives in the audit log, which retains one row per real transition.

This is shipped behaviour and is **documented rather than changed**: altering it would change
the meaning of a field the read contract already publishes.

---

## 13. Performance

Measured on a fixture of **20 Vendors × 200 Retailers × 100 products = 40 001 assignment rows,
2 001 products, 4 001 relationships**, after `ANALYZE`.

| Step | Plan | Time |
|---|---|---|
| Product ownership proof (`id` + derived Vendor, `FOR UPDATE`) | `Index Scan using vendor_products_pkey` | 0.11 ms |
| Relationship + Retailer org lookup | `Index Scan using vendor_retailers_retailer_status_idx` → `organizations_pkey` | 0.26 ms |
| Existing assignment lookup (`FOR UPDATE`) | `Index Scan using vendor_product_retailer_assign_unique_idx` | 0.09 ms |
| Audit insert | plain append | — |
| Read-after-write: detail counts | `Bitmap Index Scan on vendor_product_assign_product_status_idx` | 0.21 ms |
| Read-after-write: assigned-Retailer list | same index + `vendor_retailers_vendor_status_idx` + `organizations_pkey` | 0.65 ms |

* **No sequential scan on any growing table**, on any path.
* **No foreign Vendor row is scanned** — every predicate is anchored on the derived Vendor or on
  a primary key.
* The uniqueness-conflict path is the same index scan; it is reached only under a race that § 9
  shows does not occur.
* **No index is added.** Every predicate is served by an existing one, and a speculative index
  would be a write cost with no measured cause.

---

## 14. Web compatibility

**Zero web files changed. Visible behaviour is unchanged**, and the static suite pins the exact
operator-facing strings: the *"Retailer assignments"* heading, the section description, the
*"Not assigned"* label, and the *"Product assigned." / "Product withdrawn." / "Activate this
product before assigning it to a Retailer."* messages.

The web renders an assign/withdraw matrix over **every** Retailer the Vendor manages, from
`list_vendor_product_retailer_assignments()`. That read is **unchanged** and remains the web's.
It shows *"Assigned"* for `assignment_status = 'ACTIVE'` and *"Not assigned"* for both `NULL`
(never assigned) and `'INACTIVE'` (withdrawn) — so **the web does not visually distinguish a
withdrawn assignment from one that never existed**. The mobile read
`list_vendor_product_assigned_retailers()` does distinguish them, which is a mobile improvement
and not a web change.

The assign button is disabled when `canAssignToRetailer(row) && product.status === "ACTIVE"` is
false. That is a **UI enablement mirror** of the SQL rule, documented as such in
`lib/products/product-normalization.ts`; the database refuses the call regardless, so a client
that ignores it gets `42501` or `55000` rather than an unauthorized write. It is **not** a
TypeScript-only rule.

**No TypeScript-only validation rule exists on the assignment path.** The Server Action's UUID
pattern check is a shape screen that saves a round trip; every eligibility, ownership,
uniqueness and status rule lives in SQL. This is the shape the product *record* write path did
**not** have before `20260807090000` — and the reason that repair was needed and this one is
not: the assignment writes accept **no text input at all**, so they have no normalization path
to a raw constraint error.

---

## 15. Verification

| Check | Result |
|---|---|
| `npm test` | **PASS** |
| `npx tsc --noEmit` | **PASS** |
| `npm run lint` | **PASS** |
| `npm run build` | **PASS** |
| `git diff --check` | clean |
| `npx supabase db reset` | applies 42 migrations cleanly |
| `npx supabase test db` | **PASS** — 11 files, **1 459 assertions**, 0 failures |

**Migration count:** 42 total, **0 added by this milestone**.
**Database test files:** 11 (**1 added**).
**Assertions added:** **195** (pgTAP) + **47** (static contract tests).

---

## 16. Known limitations

1. **`void` returns hide the outcome.** A no-op and a real change are indistinguishable to the
   caller. Re-read canonically. (Contract § 6.6.)
2. **`assigned_at` is overwritten on reactivation** (§ 12). The pairing's first-ever assignment
   time is not recoverable from the assignment row.
3. **Multi-Vendor Super Admins act as the lowest organization id**, with no way to choose. The
   shipped rule across every Vendor RPC.
4. **An assignment uniqueness race maps to a generic web message** (§ 11). Cosmetic, and
   unreachable in practice.
5. **A withdrawn assignment and a never-assigned Retailer look identical on the web** (§ 14).
   The mobile read distinguishes them.
6. **An assignment whose `vendor_retailers` row no longer exists could not be withdrawn.**
   Theoretical only: relationship rows are `ON DELETE RESTRICT` and nothing in the schema
   deletes one — the lifecycle is a status column.
7. **No bulk assignment, assign-all, scheduling, effective dates, notes, assignment-level
   pricing or overrides.** None exists in the product; none was invented.

---

## 17. Next Flutter milestone

Build the Vendor product assignment surface in Flutter against the **existing** contract:

1. Read `get_vendor_product_detail(productId)` for status and both counts.
2. Read `list_vendor_product_assigned_retailers(productId)` for current and historical
   assignments — `assignment_status` distinguishes them; **do not infer from a date**.
3. Read `list_vendor_retailers()` for the eligible-Retailer picker; both `relationship_id` and
   `retailer_organization_id` are on the row.
4. Assign or reactivate with
   `assign_vendor_product_to_retailer(p_product_id, p_retailer_organization_id)`.
5. Withdraw with
   `unassign_vendor_product_from_retailer(p_product_id, p_retailer_organization_id)`.
6. On success, re-read (1) and (2). Treat a no-op as success.
7. Disable the assign control when the product is not `ACTIVE`, or the Retailer organization or
   relationship is not `ACTIVE` — mirroring the web, and knowing the database is the authority.
8. Label withdrawal as *withdraw*, never *delete*.

**No backend work remains for this milestone.**
