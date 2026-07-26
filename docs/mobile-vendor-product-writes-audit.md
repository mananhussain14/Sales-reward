# Mobile Vendor Product Writes — Audit and Contract

Milestone: mobile-safe Vendor Product management writes — create, edit and status.
Branch: `feature/mobile-vendor-product-writes`.
Scope: backend/web repository only. **No Flutter file is touched.**

---

## 0. Summary of the finding

**Audit outcome: A + G.**

**A — the web already calls stable PostgreSQL write functions that Flutter can reuse
unchanged.** The Vendor Product write surface is not a Next.js server action holding
business logic. It is three SECURITY DEFINER RPCs released in
`20260727210000_vendor_product_catalog_operations.sql`:

| Operation | Function | Returns |
| --- | --- | --- |
| Create | `create_vendor_product(text, text, text, text, text)` | `uuid` |
| Edit | `update_vendor_product(uuid, text, text, text, text)` | `void` |
| Status | `set_vendor_product_status(uuid, text)` | `void` |

Each derives the Vendor from `auth.uid()`, gates on `PRODUCTS_MANAGE`, normalizes and
validates server-side, relies on unique indexes for concurrency, and writes the product
row and its audit row in one transaction. The Next.js server actions in
`app/(admin)/products/actions.ts` add nothing an RPC does not already enforce: they
re-resolve access, map SQLSTATEs to UI copy, and call `revalidatePath`.

**So no new write RPC was created.** Duplicating these for mobile would be a second
definition of "create a product", free to drift from the one the web already calls — the
exact mistake `20260803090000` avoided when it reused `list_vendor_products()` for the
mobile product list instead of writing a mobile twin.

**G — the write flow contained one confirmed defect, and it is fixed.** Both
`create_vendor_product` and `update_vendor_product` normalized text as
`btrim(...)` → `regexp_replace('\s+', ' ')`. `btrim/1` removes **only U+0020**, so a
leading or trailing tab, newline, carriage return, form feed, vertical tab or Unicode
space separator survived it, was then turned *into* a plain space by the collapse, and was
never trimmed. The value reached `INSERT`/`UPDATE` with an untrimmed edge and hit a table
`CHECK` constraint — returning PostgreSQL's own error text, naming the table
`vendor_products` and the constraint, to the caller.

Reproduced on a fresh local database before the repair:

```
create_vendor_product('P1', E'\tWidget')
  -> 23514  new row for relation "vendor_products" violates check constraint
            "vendor_products_name_trimmed"
create_vendor_product(E'P2\t', 'Widget Two')
  -> 23514  ... violates check constraint "vendor_products_code_normalized"
create_vendor_product('P3', 'Widget Three', null, E'\t')
  -> 23514  ... violates check constraint "vendor_products_brand_shape"
create_vendor_product('P4', 'Widget Four', null, E'\nAcme')
  -> 23514  ... violates check constraint "vendor_products_brand_shape"
create_vendor_product('P7', E'\u00A0Widget Seven')   -- a no-break space
  -> 23514  ... violates check constraint "vendor_products_name_trimmed"
update_vendor_product(<own product>, E'\tRenamed')
  -> 23514  ... violates check constraint "vendor_products_name_trimmed"
```

The web never hit it because `lib/products/product-input.ts` normalizes in JavaScript
first, where `.trim()` *does* strip those characters. That made the rule
**TypeScript-only in practice** — precisely the shape this project's shared-backend
principle forbids, and precisely the rule a second client bypasses. The repair moves the
whole rule into PostgreSQL.

**One migration was added: `20260807090000_repair_vendor_product_write_normalization.sql`.**
It adds two internal text helpers and `CREATE OR REPLACE`s the two affected functions with
**identical signatures, return types, volatility, security context, search_path and
privileges**. `set_vendor_product_status` is not touched.

**Product-to-Retailer assignment writes are deferred**, and the audit found no coupling
that would prevent that: they are separate functions, gated on a separate permission
(`PRODUCT_RETAILER_ASSIGN`), and product create/edit/status neither creates, reads nor
mutates an assignment row. See § 12.

---

## 1. The web Product surface, as it works today

### Routes

| Route | File | Real or placeholder |
| --- | --- | --- |
| `/products` | `app/(admin)/products/page.tsx` | **Real.** Catalogue list + inline create form + per-row status toggle. |
| `/products/[productId]` | `app/(admin)/products/[productId]/page.tsx` | **Real.** Detail, edit form, status toggle, assignment matrix. |
| `/retailer/products` | `app/(retailer)/retailer/products/page.tsx` | **Real,** Retailer-side read only. Out of scope. |

There is **no** `/products/new`, `/products/create` or `/products/[id]/edit` route. Create
is an inline form on the list page; edit is an inline form on the detail page. **Nothing in
the product surface is a placeholder** — every control submits to a Server Action that
calls a real RPC.

There is **no delete control anywhere**, and no delete function in the schema.

### Components

`app/(admin)/products/product-forms.tsx` — `CreateProductForm`, `EditProductForm`,
`ProductStatusForm`, `AssignRetailerForm`, `UnassignRetailerForm`. All Client Components
using `useActionState`. Only the withdrawal control confirms first (`window.confirm`), and
that is UX only — the action re-authorizes regardless.

`app/(admin)/products/product-form-state.ts` — form/action state types.
`lib/products/product-input.ts` — pure normalization + validation (not an enforcement
boundary; see § 8).
`lib/products/product-normalization.ts` — response normalization for reads.
`lib/products/vendor-products.ts` — the seven RPC wrappers. **Zero `.from(` calls**; no
service-role client is imported anywhere in the feature.

### The write path, end to end

```
<form action={createProductAction}>          product-forms.tsx  (client)
  -> createProductAction(prevState, formData)  actions.ts       ("use server")
       normalizeProductInput(...)              product-input.ts (advisory only)
       requireVendorAdmin()                    vendor-admin-access.ts
       validateProductInput(...)               product-input.ts (advisory only)
    -> createVendorProduct({...})              vendor-products.ts
       -> supabase.rpc('create_vendor_product', { p_... })   CALLER'S OWN TOKEN
          -> SECURITY DEFINER function                       THE ENFORCEMENT BOUNDARY
       revalidatePath('/products')
```

**One RPC per operation. One database round trip per write.** The server action performs
one extra call — `getVendorSuperAdminAccess()` — but that is a cached, request-scoped read
shared with the layout, not a per-write cost.

### Error mapping

`classifyWriteError` in `lib/products/vendor-products.ts` inspects **only the SQLSTATE**,
never rendering a Supabase/PostgREST error object:

| SQLSTATE | Result | Web copy |
| --- | --- | --- |
| `42501` | `denied` | "We couldn't complete that. Refresh the page and try again." |
| `55000` | `not-active` | "Activate this product before assigning it to a Retailer." |
| `23514` | `invalid` | "Check the details and try again." |
| `23505` | `duplicate` | The matched fixed literal, attached to the field. |
| anything else | `unavailable` | the generic message |

The `duplicate` branch is the one place a database **message** is carried forward, and only
from this repository's own two fixed literals. An unrecognized message degrades to a
generic duplicate notice rather than being echoed.

**This is why the defect was invisible on the web**: a raw constraint violation arrives as
`23514`, which the web already maps to a generic "Check the details and try again". The
raw text was never rendered — but it *was* returned over the wire, and a second client has
no such mapper by default.

---

## 2. Answers to the audit questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Web supports create? | **Yes** — inline form on `/products`. |
| 2 | Web supports edit? | **Yes** — inline form on `/products/[productId]`. |
| 3 | Web supports activate/deactivate? | **Yes** — a dedicated single-button form on both pages. |
| 4 | Web supports delete? | **No.** No control, no action, no RPC, no `DELETE` in the schema. |
| 5 | Web supports Retailer assignments? | **Yes** — assign/withdraw matrix on the detail page. Deferred here. |
| 6 | Real vs placeholder? | **All real.** Nothing in the product surface is a stub. |
| 7 | Fields visible on create? | `productCode`, `productName`, `barcode`, `brand`, `description`. |
| 8 | Fields visible on edit? | `productName`, `barcode`, `brand`, `description`. Code is static text. |
| 9 | Immutable after creation? | `product_code`, `vendor_organization_id`, `created_by_profile_id` — all three by trigger. |
| 10 | Required? | `product_code` (create only), `product_name`. |
| 11 | Optional? | `barcode`, `brand`, `description`. |
| 12 | Accept empty strings? | The optionals do; they are normalized to `null`. |
| 13 | Empty → null? | `barcode`, `brand`, `description`. Never stored as `''`. |
| 14 | Max lengths | code 64, name 200, brand 120, description 2000, barcode 8–14 digits. |
| 15 | Trimmed? | **Yes**, all five — now against the full JS `\s` set (§ 8). |
| 16 | Internal repeated spaces preserved? | **No** for code/name/brand (collapsed to one space). **Yes** for description. |
| 17 | Case significant? | Code is upper-cased. Name, brand, description keep the author's casing. |
| 18 | Characters permitted in `product_code`? | `^[A-Z0-9][A-Z0-9 ._/-]*$`, `COLLATE "C"`, and no run of two spaces. |
| 19 | Code entered or generated? | **Entered by the administrator.** Nothing generates it. |
| 20 | Code unique globally or per Vendor? | **Per Vendor** — `vendor_products_code_unique_idx (vendor_organization_id, product_code)`. |
| 21 | Code case-sensitive? | Stored upper-cased, so comparison is effectively case-insensitive. |
| 22 | Code editable? | **No.** Not a parameter, and a trigger refuses a direct change. |
| 23 | Barcode optional? | **Yes.** |
| 24 | Barcode unique? | **Yes**, where present. |
| 25 | Barcode unique scope? | **Per Vendor**, via a **partial** index `where barcode is not null`. |
| 26 | Barcode case-sensitive? | Not applicable — digits only. |
| 27 | Barcode clearable? | **Yes** — an empty value normalizes to `null`. |
| 28 | Barcode editable? | **Yes.** |
| 29 | Barcode digits only? | **Yes**, 8–14. Spaces and hyphens are stripped first. |
| 30 | Name required? | **Yes.** |
| 31 | Name duplicable? | **Yes.** No uniqueness on `product_name`. |
| 32 | Brand nullable? | **Yes.** |
| 33 | Description nullable? | **Yes.** |
| 34 | Brand/description trimmed? | **Yes.** Brand is also collapsed; description is not. |
| 35 | Exact statuses | `ACTIVE`, `INACTIVE`. Two, by CHECK constraint. |
| 36 | Permitted transitions | Both directions, freely. |
| 37 | INACTIVE → ACTIVE? | **Yes.** |
| 38 | Status change during edit? | **No.** `update_vendor_product` never touches `status`. |
| 39 | Dedicated status action? | **Yes** — `set_vendor_product_status`. |
| 40 | Deactivation alters assignments? | **No.** Assignment rows are untouched, including their `updated_at`. |
| 41 | Deactivation blocks receipt submission? | Not directly. It removes the product from `list_retailer_assigned_products()` and blocks *new* assignments. No receipt-matching step exists yet. |
| 42 | Deactivation preserves history? | **Yes.** It is a status change; nothing is deleted. |
| 43 | Creation auto-assigns a Retailer? | **No.** Asserted in pgTAP. |
| 44 | Edit modifies assignments? | **No.** |
| 45 | ACTIVE assignment requires ACTIVE product? | Only at **assign time** (`55000` otherwise). An existing ACTIVE assignment survives deactivation. |
| 46 | Assignment state gates status change? | **No.** A product with active assignments can be deactivated freely. |
| 47 | Permission gating create | `PRODUCTS_MANAGE`. |
| 48 | Permission gating edit | `PRODUCTS_MANAGE`. |
| 49 | Permission gating status | `PRODUCTS_MANAGE`. **All three share one permission** — verified, not assumed. |
| 50 | Is Super Admin authority alone sufficient? | **No.** The role must additionally hold the permission through `role_permissions`; pgTAP proves this by deleting the seeded mapping. |
| 51 | Writes restricted to the owning Vendor? | **Yes** — every id is filtered on the id *and* the derived Vendor. |
| 52 | Can another Vendor discover a product ID exists? | **No.** Foreign, unknown and null ids are refused byte-identically. |
| 53 | Unknown Product ID? | `42501`, "Not authorized to manage this product". |
| 54 | Foreign Vendor Product ID? | Identical to the above. |
| 55 | Errors generic or field-specific? | Field-specific for **validation and uniqueness**; generic for **everything about addressing**. |
| 56 | Which errors are safe to return? | The ten fixed literals in § 10. Nothing else — now enforced (§ 8). |
| 57 | Does the web write `vendor_products` directly? | **No.** Zero `.from(` calls. |
| 58 | Does it rely only on RLS? | **No.** RLS is default-deny with *zero* policies; the RPCs are the only path. |
| 59 | Service-role credentials? | **No.** None imported, none granted. |
| 60 | Through a server action? | Yes, but the action is a transport, not the boundary. |
| 61 | Uses a database function? | **Yes** — one RPC per operation. |
| 62 | Round trips per write? | **One.** |
| 63 | Authorization/validation repeated across calls? | Repeated between TS and SQL by design (advisory + enforcing), never across multiple SQL calls. |
| 64 | Writes transactional? | **Yes** — one function invocation is one transaction. |
| 65 | Audit row per action | `PRODUCT_CREATED` / `PRODUCT_UPDATED` / `PRODUCT_ACTIVATED` / `PRODUCT_DEACTIVATED`. |
| 66 | Automatic or explicit? | **Explicit**, inside each function. There is no audit trigger. |
| 67 | action_code / entity_type | As above; `entity_type` is always `VENDOR_PRODUCT`, `entity_id` the product uuid as text. |
| 68 | Metadata keys | Create: `product_code`, `product_name`, `product_status`, `vendor_name`. Update/status: the first three. |
| 69 | Old and new values recorded? | **No.** Only the resulting values. A before/after diff is not stored. |
| 70 | Could metadata expose a barcode? | **No.** No metadata key carries a barcode or description — asserted in both suites. |
| 71 | Create returns the new ID? | **Yes** — `returns uuid`. |
| 72 | Edit returns the product? | **No** — `returns void`. |
| 73 | Status returns the product? | **No** — `returns void`. |
| 74 | Web refetches after each write? | **Yes** — `revalidatePath` re-runs the page's read. |
| 75 | Optimistic updates? | **No.** |
| 76 | Concurrent edits detected? | **No.** Last write wins (§ 13). |
| 77 | `updated_at` used for optimistic locking? | **No.** It is a trigger-maintained timestamp only. |
| 78 | Can two concurrent creates violate uniqueness? | **No.** The unique indexes are the authority; the loser gets `23505`. |
| 79 | Final constraint protection | The two unique indexes plus five CHECK constraints and three immutability triggers. |
| 80 | Indexes serving lookups | PK for the update target; the two unique indexes for uniqueness. Measured in § 14. |
| 81 | Validation duplicated only in TypeScript? | **It was — that is the defect.** Now every rule exists in SQL. |
| 82 | Could Flutter bypass a web-only rule? | **It could, and it did.** Closed by `20260807090000`. |
| 83 | Which validation must move into PostgreSQL? | Whitespace trimming across the full JS `\s` set, for code, name, brand and description. Done. |
| 84 | Can the write reuse the read output shape? | It does not need to — see § 11. |
| 85 | Should writes return one complete Product row? | **No.** Deliberate; see § 11. |
| 86 | Should assignment counts be returned after writes? | **No.** |
| 87 | Would `assignment_count` create a race or coupling? | **Yes** — it would couple a product mutation to the assignment table for no gain. |
| 88 | The exact backend gap Flutter must solve | **None in contract terms.** The three RPCs are reusable as-is. The only gap was the normalization defect, now repaired. Flutter's remaining work is client-side only (§ 16). |

---

## 3. Authoritative columns and mutability

`public.vendor_products` (migration `20260727090000`):

| Column | Type | Null | Set by | Mutable |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | no | `gen_random_uuid()` | no |
| `vendor_organization_id` | `uuid` | no | **derived** from `auth.uid()` | **no** (trigger) |
| `product_code` | `text` | no | caller, normalized | **no** (trigger) |
| `barcode` | `text` | **yes** | caller, normalized | yes |
| `product_name` | `text` | no | caller, normalized | yes |
| `brand` | `text` | **yes** | caller, normalized | yes |
| `description` | `text` | **yes** | caller, normalized | yes |
| `status` | `text` | no | `'ACTIVE'` on create; the status RPC thereafter | yes, via the status RPC only |
| `created_by_profile_id` | `uuid` | no | **`auth.uid()`** | **no** (trigger) |
| `created_at` | `timestamptz` | no | `now()` | never written by any RPC |
| `updated_at` | `timestamptz` | no | `set_updated_at` trigger | trigger-owned |

Constraints: `vendor_products_status_allowed`, `vendor_products_code_normalized`,
`vendor_products_code_length`, `vendor_products_code_shape`,
`vendor_products_barcode_shape`, `vendor_products_name_trimmed`,
`vendor_products_name_length`, `vendor_products_brand_shape`,
`vendor_products_description_shape`.

Triggers: `set_updated_at_on_vendor_products`,
`vendor_products_assert_vendor_type_on_insert`,
`vendor_products_assert_immutable_on_update`.

RLS is **enabled with zero policies**, and neither `anon` nor `authenticated` holds any
privilege on the table. The RPCs are the only way in.

---

## 4. Create semantics

```sql
public.create_vendor_product(
  p_product_code text,
  p_product_name text,
  p_barcode      text default null,
  p_brand        text default null,
  p_description  text default null
) returns uuid
```

`plpgsql`, `volatile`, `security definer`, `set search_path = ''`.
`revoke all from public` · `revoke execute from anon` · `grant execute to authenticated`.

1. Resolve the actor: `auth.uid()`.
2. Resolve the Vendor: the **lowest** `organization_id` from
   `get_vendor_super_admin_context()`, which itself requires an ACTIVE profile, ACTIVE
   membership, ACTIVE VENDOR organization and ACTIVE `VENDOR_SUPER_ADMIN` role.
3. Require `has_organization_permission(v_vendor, 'PRODUCTS_MANAGE')`.
4. Normalize all five inputs (§ 8).
5. Validate length, emptiness and character rules.
6. Insert exactly one row, with `status = 'ACTIVE'` and
   `created_by_profile_id = auth.uid()` — **neither is a parameter**.
7. Catch `unique_violation`, mapping each index to its own safe message.
8. Insert exactly one `PRODUCT_CREATED` audit row, in the same transaction.
9. Return the new `uuid`.

**No assignment row is created.** Asserted in pgTAP, and again at the end of a full
create → edit → deactivate → activate lifecycle.

**There is no initial-status parameter.** The web has never offered that choice, so
neither does the contract; inventing one would be a mobile-only capability the product has
never had.

---

## 5. Edit semantics

```sql
public.update_vendor_product(
  p_product_id   uuid,
  p_product_name text,
  p_barcode      text default null,
  p_brand        text default null,
  p_description  text default null
) returns void
```

Same hardening and privileges as create.

1–3. Identical authorization chain.
4. `select … where id = p_product_id and vendor_organization_id = v_vendor **for update**`.
   The **two-column filter is the entire security boundary** for the caller-supplied id;
   `FOR UPDATE` serializes concurrent edits of the same row.
5. A null id, an unknown id and a foreign id all leave the row null and raise the *same*
   `42501` message.
6. Normalize and validate, **using the same helpers as create**.
7. **No-op short-circuit**: if none of name, barcode, brand or description differs from
   what is stored, return having written nothing — no `UPDATE`, no `updated_at` movement,
   no audit row.
8. Otherwise update only those four columns; catch a barcode `unique_violation`.
9. Insert exactly one `PRODUCT_UPDATED` audit row.

**No product-code parameter.** The code is the canonical key that assignments are made
against and a future receipt-matching step will resolve, so re-keying in place would
silently change what every downstream reference means.

**No-op behaviour is a success, not an error** — a client must not have to distinguish
"nothing changed" from "the write failed". Because normalization runs first, a
**whitespace-only difference is also a no-op**: submitting `"  Spaced    Name  "` against a
stored `"Spaced Name"` writes nothing.

**A failed edit rolls back completely.** pgTAP proves that an edit which changes the name
*and* duplicates another product's barcode leaves the name unchanged and writes no audit
row.

---

## 6. Status semantics

```sql
public.set_vendor_product_status(
  p_product_id uuid,
  p_status     text
) returns void
```

Same hardening and privileges. **Not modified by this milestone** — see § 9.

- Accepts only `ACTIVE` or `INACTIVE`, after `upper(btrim(...))`, so `'  inactive  '` is
  understood. Anything else raises `23514` "Choose a valid product status". `DELETED` and
  `ARCHIVED` are not statuses in this schema.
- Same two-column `FOR UPDATE` lookup and same non-leaking refusal as edit.
- **Setting the status it already has is an idempotent no-op**: no write, no
  `updated_at` movement, no audit row. This matters on mobile, where a double-tap must not
  produce two audit rows describing one decision.
- Both transitions are permitted, in both directions.
- Audits `PRODUCT_ACTIVATED` or `PRODUCT_DEACTIVATED`.

### Interaction with assignments — none

**Deactivating a product does not touch its assignment rows**, not even their
`updated_at`. pgTAP asserts this directly. Deactivation instead:

- makes the product ineligible for a **new** assignment
  (`assign_vendor_product_to_retailer` raises `55000`), and
- removes it from the Retailer-facing `list_retailer_assigned_products()`, which requires
  both the product and the assignment to be ACTIVE.

Cascading a status change into assignment rows would destroy the record of which Retailers
held the product, and reactivating could not restore it faithfully.

**Deactivation is not deletion.** The product row, its `created_at`, and all of its
assignment history survive.

---

## 7. Authorization and tenant isolation

### The chain, identical in all three writes

```
auth.uid()
  -> get_vendor_super_admin_context()      -- ACTIVE profile, membership, VENDOR org, role
       order by organization_id limit 1    -- the shipped multi-Vendor tie-break
  -> has_organization_permission(v_vendor, 'PRODUCTS_MANAGE')
  -> the product id is matched on BOTH its own id AND v_vendor
```

**No write accepts an identity, Vendor, tenant, owner, membership, role or permission
argument.** Create accepts the five product fields and nothing else — there is no
organization id to send. Update and status accept only the opaque product id needed to
address the target. Both suites assert this against the catalogue and the source.

**The lowest-organization-id rule is preserved, not "fixed".** A caller who is a Super
Admin of two Vendors writes to the lowest-id Vendor, deterministically — the shipped
behaviour of every other Vendor RPC and of the web itself. Changing it would change which
catalogue an existing operator writes to, as a side effect of a mobile milestone. It is
recorded as a limitation in § 15.

### Confirmed denial behaviour — every one `42501`, every one pgTAP-asserted

| Caller | Result |
| --- | --- |
| Signed out | denied |
| Authenticated, no membership | denied |
| Vendor member without `VENDOR_SUPER_ADMIN` | denied |
| Vendor Super Admin, `PRODUCTS_MANAGE` removed | denied (all three writes) |
| SUSPENDED profile, role held | denied |
| SUSPENDED membership, role held | denied |
| Super Admin of a SUSPENDED Vendor organization | denied |
| Retailer Owner | denied |
| Retailer Manager | denied |
| Sales Staff | denied |
| Unknown product id | denied |
| Foreign Vendor's product id | denied, **byte-identically** |
| Null product id | denied, **byte-identically** |
| Malformed uuid | `22P02` from the type system, before any authorization runs |

The permission is proved genuinely separate from the role by **deleting the seeded
`VENDOR_SUPER_ADMIN → PRODUCTS_MANAGE` mapping** inside the test transaction: all three
writes then deny, while `list_vendor_products()` (which needs `PRODUCTS_READ`) still
works. The mapping is restored before the transaction rolls back.

### Tenant isolation, proved in both directions

- Vendor A cannot edit, or change the status of, Vendor B's product — and Vendor B's row
  is asserted **unchanged** afterwards, which is the real test.
- Vendor B cannot edit Vendor A's product.
- No audit row is written against another Vendor's product.
- Every audit row a write produces carries the **derived** Vendor as `organization_id`.
- **Vendor B's values do not leak.** Because uniqueness is per-Vendor, Vendor A may freely
  create a product with the same `product_code` *and* the same `barcode` that Vendor B
  already uses. A cross-tenant collision is impossible, so no error can hint that a value
  is taken elsewhere.

---

## 8. Input normalization and validation — the repaired rule

Every field, as enforced **in PostgreSQL**:

| Field | JSON/Dart in | PG type | Req. | Normalization | Bounds | Chars | Case | Unique | Nullable | Editable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `p_product_code` | `String` | `text` | **yes** | trim + collapse + **upper** | 1–64 | `^[A-Z0-9][A-Z0-9 ._/-]*$` | folded up | **per Vendor** | no | **no** |
| `p_product_name` | `String` | `text` | **yes** | trim + collapse | 1–200 | any Unicode | preserved | no | no | yes |
| `p_barcode` | `String?` | `text` | no | strip whitespace **and hyphens**; `''` → null | 8–14 | digits only | n/a | **per Vendor**, where non-null | **yes** | yes |
| `p_brand` | `String?` | `text` | no | trim + collapse; `''` → null | 1–120 | any Unicode | preserved | no | **yes** | yes |
| `p_description` | `String?` | `text` | no | **trim only**; `''` → null | 1–2000 | any Unicode | preserved | no | **yes** | yes |

`null`, `''` and whitespace-only are equivalent for every optional and all produce `null`.
For the two required fields they all produce the field's own `23514` message.

Lengths are counted in **characters, not bytes**: a 200-character name of multi-byte
characters is accepted, and 201 is refused. Asserted.

### The whitespace set — stated once, in two places, and proved equal

The repair replaces `btrim`-then-collapse with **collapse-then-trim over an explicit
character class**:

```
[ \t\n\v\f\r\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]
```

U+0020 space · U+0009 tab · U+000A newline · U+000B vertical tab · U+000C form feed ·
U+000D carriage return · U+00A0 no-break space · U+1680 ogham space mark ·
U+2000–U+200A the en/em quad family · U+2028 line separator · U+2029 paragraph separator ·
U+202F narrow no-break space · U+205F medium mathematical space · U+3000 ideographic space ·
U+FEFF zero-width no-break space.

That is **exactly JavaScript's `\s`** — the set `.trim()` removes, and therefore exactly
what `lib/products/product-input.ts` already strips in the browser. The class is written
with regex escapes, never literal characters, so a migration diff contains no invisible
non-breaking space.

`lib/products/vendor-product-writes-contract.test.ts` **computes** the JavaScript set at
test time (every code point in `0..0xFFFF` for which `/\s/` matches), parses the SQL class
out of the migration, expands its ranges, and asserts the two sets are equal **in both
directions**. If either side ever changes, that test fails — which is the only durable way
to keep two clients from disagreeing about what `"SR-100"` means.

Two helpers carry the rule, so create and edit cannot drift:

| Helper | Behaviour | Used for |
| --- | --- | --- |
| `normalize_product_line(text)` | every whitespace char → space, collapse runs, trim | code, name, brand |
| `normalize_product_block(text)` | trim at both ends only; **internal formatting untouched** | description |

Both are `immutable`, `security invoker`, `search_path`-pinned, read no table, and are
**revoked from PUBLIC and granted to nobody** — only the SECURITY DEFINER writes, running
as the owner, call them.

`IMMUTABLE` is honest here *only because* the class is written out literally. A
`[[:space:]]` class is locale-dependent for multibyte encodings, and labelling that
`IMMUTABLE` would be a lie the planner is entitled to believe.

### One behaviour deliberately widened: `description`

It was trimmed with `btrim`, so a description submitted with a leading tab or newline was
**stored with it** (the description CHECK also uses `btrim`, so it agreed and no error
occurred) — while the web stripped it in JavaScript. Two clients stored different text for
the same keystrokes. Description is now trimmed against the same explicit set, so both
agree. Internal formatting is still preserved verbatim: a paragraph break belongs to its
author, and that is the one rule distinguishing a description from a name.

### Why nothing else changed

For **every input the web can send**, the result is byte-identical. The browser trims and
collapses before the value leaves the page, so it arrives with no leading, trailing or
repeated whitespace — and collapse-then-trim and trim-then-collapse agree exactly on such
a value. Verified live, before and after:

```
create_vendor_product('  sr-100  ', '  Clean   Name  ', ' 012 345-678-905 ',
                      '  Acme  Co ', '  Hello  ')
-> code 'SR-100' · name 'Clean Name' · barcode '012345678905'
   brand 'Acme Co' · description 'Hello'          (identical before and after)
```

The no-op comparison in `update_vendor_product` makes this doubly important: it compares
normalized input against stored values, so a fix that changed what "normalized" means for
an already-clean value would turn no-op edits into real ones and fill the audit log with
entries corresponding to no change. It does not.

---

## 9. What was changed, and what was not

**Migration: `supabase/migrations/20260807090000_repair_vendor_product_write_normalization.sql`**

Adds:
- `public.normalize_product_line(text)` — internal
- `public.normalize_product_block(text)` — internal

`CREATE OR REPLACE`s, with **identical** signature, argument names and order, return type,
language, volatility, security context, `search_path` and privileges:
- `public.create_vendor_product(text, text, text, text, text)`
- `public.update_vendor_product(uuid, text, text, text, text)`

**Not touched:**
- `set_vendor_product_status(uuid, text)` — its only normalization feeds a closed
  `in ('ACTIVE','INACTIVE')` test, so every malformed input already fails *that* test with
  its own safe message. It has no path to a raw constraint error, so replacing it would be
  a change with no defect behind it.
- All five read functions.
- Both assignment write functions.
- Every table, column, constraint, index, trigger, RLS policy, role, permission and
  role-permission mapping.
- Every seed row. No data is read, updated or backfilled — the defect could never *store*
  a bad value, so there is nothing in the data to repair.
- Every web file. The web implementation is byte-for-byte unchanged.

No `DROP FUNCTION`: both replacements keep their identity, so existing grants and the
web's calls continue against the same object.

---

## 10. Result and error semantics

| Outcome | SQLSTATE | Message | Safe to show |
| --- | --- | --- | --- |
| Create success | — | returns `uuid` | — |
| Edit success | — | `void` | — |
| Edit no-op | — | `void` (indistinguishable from success — deliberate) | — |
| Status success | — | `void` | — |
| Status no-op | — | `void` | — |
| Invalid code | `23514` | `Enter a valid product code` | **yes**, on the code field |
| Missing/invalid name | `23514` | `Enter a product name` | **yes**, on the name field |
| Invalid barcode | `23514` | `Enter a valid barcode, or leave it blank` | **yes**, on the barcode field |
| Brand too long | `23514` | `Brand is too long` | **yes**, on the brand field |
| Description too long | `23514` | `Description is too long` | **yes**, on the description field |
| Invalid status | `23514` | `Choose a valid product status` | **yes** |
| Duplicate code | `23505` | `A product with that code already exists` | **yes** — describes the caller's own catalogue |
| Duplicate barcode | `23505` | `A product with that barcode already exists` | **yes** — same reason |
| Not authorized | `42501` | `Not authorized to manage products` | generic only |
| Unknown / foreign / null product | `42501` | `Not authorized to manage this product` | generic only |
| Malformed uuid | `22P02` | type-system error | reject client-side first |
| Operational failure | anything else | — | generic only |

**A denial is never converted into zero rows**, and an unknown product is never
distinguishable from a foreign one. Both uniqueness messages are safe precisely because
the indexes are **scoped per Vendor**: neither can describe another Vendor's data.

**No raw database error is reachable any more.** The pgTAP suite asserts this as a
*property of the whole input space* rather than as a list of cases: for a deliberately
hostile input set — every whitespace character wrapped around every field, over-length
values, forbidden characters, empty and whitespace-only values — every outcome is either
success or one of the ten literals above. A future edit that reintroduces a raw constraint
error for some case nobody thought to write down still fails that assertion. A companion
assertion checks that none of the ten literals names a table, constraint, column or SQL
construct.

**Nothing sensitive can travel back.** The three writes return `uuid`, `void` and `void`;
they declare **no output columns at all**, so no organization id, profile id, membership
id, actor id, audit metadata, role code, permission code or assignment row can be added to
a result by accident. Asserted against the catalogue.

---

## 11. Why the writes do not return a Product row

The milestone brief asks whether create/edit/status should return one complete Product row.
**They should not, and they do not.**

- `get_vendor_product_detail(uuid)` (migration `20260803090000`) already returns the
  canonical single-product row, and it is the shape the mobile product screens already
  deserialize. Create returns the new id, so the read-after-write is a **primary-key
  lookup** — one indexed round trip (§ 14). Edit and status operate on an id the client
  already holds.
- A row returned from a write would have to either **omit** the two assignment counts —
  making it a *third* product shape, on top of the list row and the detail row — or
  **include** them, which couples every product mutation to the assignment table for no
  gain and re-reads data the write did not change.
- Changing `create_vendor_product` from `returns uuid` to `returns table (...)` cannot be
  done with `CREATE OR REPLACE`; it needs a `DROP` and re-`CREATE` of a function the web
  depends on. That is not an additive backend change.

So the mobile write flow is: **write → `get_vendor_product_detail(new_id)`**, which is
also exactly what the web does (`revalidatePath` re-runs the page's read). pgTAP asserts
the read-after-write path returns the freshly written values, and that it carries the
assignment counts the writes deliberately do not.

---

## 12. The assignment boundary — audited, and deferred

Assignment writes were audited to confirm they can be separated. **They can**, cleanly:

| Property | Value |
| --- | --- |
| Functions | `assign_vendor_product_to_retailer(uuid, uuid)`, `unassign_vendor_product_from_retailer(uuid, uuid)` |
| Permission | **`PRODUCT_RETAILER_ASSIGN`** — a different permission from `PRODUCTS_MANAGE` |
| Selector | `(product id, retailer_organization_id)` — the web sends the **organization id**, never `relationship_id` |
| Required relationship status | `ACTIVE` to **assign**; **not required** to withdraw |
| Required Retailer org status | `ACTIVE` to assign; not required to withdraw |
| Required product status | `ACTIVE` to assign (`55000` otherwise); not required to withdraw |
| Uniqueness | one row per `(product, Retailer)` **for all time**; re-assigning flips the same row |
| Withdrawal | sets `INACTIVE`. **Never deletes** — there is no `DELETE` in the schema |
| Audit | `PRODUCT_ASSIGNED_TO_RETAILER` / `PRODUCT_UNASSIGNED_FROM_RETAILER` |
| Transaction | one function invocation, mutation and audit together |
| Idempotency | assigning an already-ACTIVE pair, or withdrawing an already-INACTIVE one, is a silent no-op |

**No coupling exists in either direction.** Product create writes no assignment row;
product edit touches none; product status changes none, not even `updated_at`. The pgTAP
suite proves a full create → edit → deactivate → activate lifecycle produces **zero**
assignment rows and exactly four audit rows.

This milestone therefore did **not** enlarge into assignment writes, and this document does
not describe them as implemented. A static test asserts that exactly the two shipped
assignment writes exist, so a third cannot appear unnoticed.

Note for the future milestone: the assignment **read** contract
(`list_vendor_product_assigned_retailers`) returns `relationship_id`, while the assignment
**write** contract is addressed by `retailer_organization_id`. Both are returned by the
read, so no extra lookup is needed — but the two address spaces should be reconciled
explicitly when the write milestone is planned.

---

## 13. Concurrency and atomicity

**Every write is one transaction.** Authorization, mutation and audit insert happen inside
a single function invocation, so a product change and its audit row can never be observed
apart, and a failed write leaves neither.

| Scenario | Behaviour |
| --- | --- |
| Concurrent duplicate creates | The unique index settles it. One inserts; the other gets `23505` and a safe message, having written nothing — no product row, no audit row. |
| Two concurrent edits of one product | `FOR UPDATE` serializes them. The second re-reads the committed row, so its no-op comparison is made against fresh data. **Last write wins.** |
| Status change during an edit | Both take `FOR UPDATE` on the same row, so they serialize. An edit never writes `status` and a status change never writes the display fields, so neither can clobber the other's columns. |
| Uniqueness race on barcode edit | Same as create: `23505`, full rollback of the entire edit including the name change. |
| Audit rows under retry/failure | pgTAP asserts no product audit row exists without the product it describes, and that a refused duplicate wrote no audit row. |

**Optimistic concurrency was considered and deliberately not added.** The product currently
uses last-write-wins; `updated_at` is a trigger-maintained timestamp, not a version, and
the web does not send it. Adding `expected_updated_at` would change the shipped web
contract to solve a conflict nobody has demonstrated — two Vendor Super Admins editing the
same product's description in the same seconds. It is recorded as a limitation in § 15.
No client-generated idempotency key was introduced either: the two no-op short-circuits
already make a repeated identical submission harmless.

---

## 14. Performance and indexes

**No index was added.** Every predicate the writes use is already served.

Measured on a local database holding **10,000 products — 5,000 for each of two Vendors**,
after `ANALYZE`. The two catalogues deliberately use the **same 5,000 product codes**
(`PERF-1` … `PERF-5000`), so a plan that ignored the Vendor predicate would both return the
wrong row and touch twice the pages:

| Operation | Plan | Buffers | Exec time | Other Vendor's rows scanned |
| --- | --- | --- | --- | --- |
| Edit/status target lookup (`id` + Vendor, `FOR UPDATE`) | `LockRows → Index Scan using vendor_products_pkey` | 4 | **0.048 ms** | none |
| `product_code` uniqueness | `Index Only Scan using vendor_products_code_unique_idx` | 3 | **0.055 ms** | none |
| `barcode` uniqueness | `Index Only Scan using vendor_products_barcode_unique_idx` (partial) | 3 | **0.042 ms** | none |
| Audit insertion | `Insert on audit_logs` + 2 FK triggers, **no lookup** | 14 | **0.444 ms** | n/a |
| Read-after-write (`get_vendor_product_detail`) | `Nested Loop Left Join` → PK scan + `Bitmap Index Scan on vendor_product_assign_product_status_idx` | 4 | **0.073 ms** | none |

**No sequential scan appears in any plan**, and no growing table is scanned: 3–4 shared
buffers is an index page plus one heap page, where a 10,000-row sequential scan would touch
roughly 60. The uniqueness probes return `rows=1` even though the *other* Vendor holds a
product with the identical code — the composite `(vendor_organization_id, product_code)` index
is what makes that both correct and cheap.

**Why no new index is justified:** every write predicate is already the leading-column prefix
of an existing index — the primary key for the target lookup, and the two unique indexes that
are themselves the concurrency authorities. An added index would be pure write cost against a
measured 0.05 ms read.

The writes avoid every anti-pattern the brief lists: no Vendor-wide product fetch before
writing, no client-side duplicate check as the authority (the indexes are), one
authorization resolution per call rather than one per field, no separate non-transactional
audit call, and no full-list refetch to obtain one updated row — the detail read is a
primary-key lookup.

---

## 15. Known limitations

1. **Multi-Vendor Super Admins write to the lowest-id Vendor.** Preserved deliberately;
   changing it would alter existing behaviour as a side effect of a mobile milestone.
2. **Last-write-wins on concurrent edits.** No optimistic locking; see § 13.
3. **No audit diff.** Metadata records the resulting values, not old-versus-new.
4. **`product_code` is immutable.** A miscoded product must be replaced, not renamed. This
   is a product decision inherited from the storage migration, not a gap.
5. **No product images, prices, incentives, campaigns or inventory** — none of those
   columns exists anywhere in the schema, so nothing was returned or accepted for them.
6. **No product deletion**, by design.
7. **Assignment writes are deferred** to their own milestone.
8. **`create_vendor_product` has no initial-status parameter**, matching the web.

---

## 16. Expected Flutter flow (no Flutter change in this PR)

| Screen action | Call | Then |
| --- | --- | --- |
| Add product | `create_vendor_product(code, name, barcode?, brand?, description?)` → `uuid` | `get_vendor_product_detail(uuid)` to render the new row |
| Save edits | `update_vendor_product(id, name, barcode?, brand?, description?)` | `get_vendor_product_detail(id)` |
| Activate / Deactivate | `set_vendor_product_status(id, 'ACTIVE' \| 'INACTIVE')` | `get_vendor_product_detail(id)` |

Rules for the client:

- **Send no organization, tenant, user, profile, role or permission value.** There is no
  parameter for one.
- **Do not treat Dart-side validation as enforcement.** Mirror it for responsiveness only;
  the database re-normalizes and re-validates every value from scratch.
- **Reject a malformed uuid before calling** — a bad cast returns `22P02` from the type
  system, which is not an authorization answer.
- **Map by SQLSTATE, not by message text**: `23514` → field error, `23505` → duplicate
  (attach to barcode if the message mentions "barcode", otherwise the code field), `42501`
  → one generic refusal, anything else → generic unavailable.
- **Do not distinguish "not found" from "not permitted."** The backend deliberately does
  not.
- A no-op edit and a no-op status change both **succeed silently**. Treat them as success.

**No new audit action code was introduced**, so no Flutter label change is required: the
shipped mobile Audit Logs screen already maps `PRODUCT_CREATED`, `PRODUCT_UPDATED`,
`PRODUCT_ACTIVATED` and `PRODUCT_DEACTIVATED` under `VENDOR_PRODUCT`, resolving the display
name from `metadata->>'product_name'`. A pgTAP assertion pins that no product audit row can
carry an action code outside the six already shipped.

---

## 17. Web compatibility

**Visible web behaviour is unchanged.** No product label, form layout, navigation element,
assignment control, validation wording, list ordering, read behaviour, Retailer behaviour
or receipt behaviour is altered, and no web file is modified in this PR.

The two replaced functions keep their exact names, argument names, argument order, types,
return types and grants, so `lib/products/vendor-products.ts` calls the same objects with
the same payloads. Static tests assert the web module still names all three RPCs, still
sends all seven parameter names, still contains zero `.from(` calls, constructs no
service-role client, and still reads only eight form fields — the five product fields, two
ids and a status.

For every input the browser can produce, the stored result is byte-identical (§ 8).

---

## 18. Tests

### pgTAP — `supabase/tests/database/vendor_product_writes_test.sql`

**211 assertions.** New file; the three write functions previously had **no** database test
of any kind.

| Section | Covers |
| --- | --- |
| A | Signature, parameter names/types/order, return types, SECURITY DEFINER, VOLATILE (not STABLE), empty `search_path`, grants (authenticated only; anon, PUBLIC and service_role all denied), helper attributes, table default-deny, RLS still policy-free, no delete function anywhere |
| B | Fixtures — two Vendors, one Retailer, ten callers spanning every rejected state |
| C | Create authorization — 10 denied caller classes, plus the seeded-mapping removal proving `PRODUCTS_MANAGE` is separate from `PRODUCTS_READ` and from the role |
| D | Create validation, normalization, both length boundaries per field, character rules, Unicode, ownership from the derived Vendor, no assignment created, audit row shape and metadata whitelist |
| E | Per-Vendor uniqueness for code and barcode, case/whitespace/separator variants, multiple null barcodes, failed create writes neither product nor audit |
| F | Edit authorization and tenant isolation, byte-identical refusals, Vendor B's row unchanged, cross-tenant duplicate values permitted |
| G | Edit semantics — every mutable field, clearing to null, normalization parity with create, code immutability (including the trigger), `created_at` preserved, no-op and whitespace-only-no-op, one audit row per meaningful change, full rollback on conflict |
| H | Status transitions both ways, idempotent same-status, invalid statuses, status/edit independence, assignment non-interaction, history preserved, INACTIVE products still editable |
| I | **The regression suite for the repaired defect** — 16 representative whitespace characters against name, code, brand and description (every distinct member of JavaScript's `\s`, plus both endpoints of the U+2000–U+200A range; the **full 25-code-point set equality is proven by the static test**, not here); whitespace-only optionals; and the whole-input-space property that nothing but a safe message can be returned |
| J | Writes expose nothing sensitive; read-after-write through the existing detail read |
| K | Uniqueness authorities are real per-Vendor unique indexes, the barcode one partial; no audit row without its product; every audit row on the trusted Vendor |
| L | Assignment boundary untouched; full lifecycle produces zero assignment rows and exactly four audit rows in order; no action code outside the six shipped; nothing deleted |

Verified to **fail without the repair**, in two independent ways:

1. **Migration removed + `db reset`** — Section A fails on the missing helpers (`function
   "public.normalize_product_line(text)" does not exist`).
2. **Helpers kept, only the two function bodies reverted to the pre-repair `btrim`-first
   versions** — the stronger proof, because it isolates the behaviour rather than the
   objects. Test 116 fails (`a TAB-padded spelling is also refused as a duplicate`) and
   Section I then aborts with the defect itself:
   `new row for relation "vendor_products" violates check constraint
   "vendor_products_name_trimmed"`.

### The `updated_at` witness — corrected during final verification

Three no-op assertions originally compared `updated_at` before and after. **That comparison is
vacuous inside this suite**: `set_updated_at` assigns `now()`, which is the *transaction*
timestamp, so every row created here has `created_at = updated_at` and the check would have
passed even if the no-op had performed a full `UPDATE`. Verified directly against the database.

They now assert on **`ctid`, the physical row version**. PostgreSQL implements `UPDATE` as
insert-new-version + mark-old-dead, so any row-touching write changes it and a statement that
writes nothing leaves it alone — proving the stronger claim the no-op branches actually make.
Mirror assertions prove a *real* edit and a *real* status change **do** change the version, so
"unchanged" cannot pass vacuously. The same correction was applied to the assignment-row check
in Section H, and two audit-ordering assertions were re-anchored from `created_at` (which ties
for every row in one transaction) to `ctid`.

Validated by simulation: with the no-op short-circuit deleted from the live
`update_vendor_product`, **three** assertions now fail (146, 148, 150) where only the audit-row
one would have failed before.

### Static — `lib/products/vendor-product-writes-contract.test.ts`

**50 tests.** Migration hygiene and forward ordering; proof that no applied migration was
edited; exactly two helpers added and two functions replaced; no table/index/trigger/policy/
type/constraint/RLS change; no top-level DML, no seed write, no `DELETE`; signature identity
asserted **against the deployed migration's own declaration** rather than against a restated
literal; no identity/tenant arguments; derivation from `auth.uid()` and delegation to the
existing authorization helpers; hardening and exact grants; one audit insert per write,
inside the same body; the **whitespace-set equality proof** against JavaScript's `\s`;
collapse-then-trim ordering; the safe-message allowlist; and the web implementation left
untouched.

### Repository totals after this milestone

| | Before | After |
| --- | --- | --- |
| Migrations | 40 | **41** |
| Database test files | 9 | **10** |
| pgTAP assertions | 1,053 | **1,264** (+211) |
| Node test suites | 242 | **243** |
| Node assertions | 989 | **1,039** (+50) |

---

## 19. Next milestones

1. **Flutter Vendor Product writes** — client-side only. Wire the three existing RPCs into
   the shipped product screens per § 16. **No backend work is required.**
2. **Vendor Product assignment writes** — the deferred milestone. Audit complete (§ 12);
   the two functions exist and are already permission-gated, so that milestone is likewise
   expected to be adoption plus tests rather than new SQL. Reconcile the
   `relationship_id` / `retailer_organization_id` address spaces when planning it.

Neither is started in this PR.
