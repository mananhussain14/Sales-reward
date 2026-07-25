# Mobile Vendor Audit Log Reads — Audit and Contract

**Milestone:** mobile-safe Vendor Audit Log reads
**Branch:** `feature/mobile-vendor-audit-log-reads`
**Migration:** `supabase/migrations/20260804090000_mobile_vendor_audit_log_reads.sql`
**Status:** read-only. No audit write, audit edit, audit deletion, retention change, export,
dashboard metric, alert, Product write, Vendor user write or role write is added, changed, or
described here as implemented.

---

## 0. Summary of the finding

The Vendor Audit Logs page is **real and database-backed**, not a placeholder. It renders
`public.audit_logs` through `lib/audit/vendor-audit-logs.ts`, and that module is a careful
piece of work: it selects four columns and no more, resolves actor names in a single batched
second query rather than one per row, keeps authorization delegated to
`getVendorSuperAdminAccess()`, and keeps "could not load" strictly distinct from "nothing
recorded".

It is nevertheless **not usable as a mobile contract**, for three proved reasons:

| Gap | Consequence for Flutter | Closed by |
| --- | --- | --- |
| **There is no pagination at all.** A fixed `AUDIT_LOG_LIMIT = 100`, no cursor, no offset, no "older" affordance. | Record 101 is unreachable **forever**. A history screen that cannot scroll is not a history screen. | keyset cursor on `(created_at, id)` |
| **The actor name is a join written in TypeScript**, over a second round trip, and its result depends on the `profiles` RLS policy as evaluated for that caller. | Rebuilding it in Dart makes a second client responsible for a privacy decision — and the two clients would resolve *different* subsets. | one SQL function, one scoped join |
| **The affected entity is typed but never named.** The page can say a product was updated, not *which* product, because `entity_id` is opaque and `metadata` is never selected. | The single most useful fact on an audit line is missing. | a closed metadata name-snapshot whitelist |

**One function was added. No detail function was added** — see § 6, which is a finding, not an
omission. **No index was added** — see § 12, which is a measurement, not an assumption.

---

## 1. The web Vendor Audit Logs page, as it works today

**Route:** `/audit-logs` — `app/(admin)/audit-logs/page.tsx`
**Module:** `lib/audit/vendor-audit-logs.ts` → `getVendorAuditLogs()`
**Whole surface:** `app/(admin)/audit-logs/` contains exactly **two** files — `page.tsx` and
`loading.tsx`. There is no detail route, no drawer, no modal, no expandable row.

### Round trips — **two, and only two, regardless of row count**

| # | Call | Purpose |
| --- | --- | --- |
| 1 | `getVendorSuperAdminAccess()` | Authorization + the organization id and name. |
| 2 | `audit_logs.select("actor_profile_id, action, entity_type, created_at").eq(organization_id).order(created_at desc).limit(100)` | The newest 100 records. |
| 3 | `profiles.select("id, first_name, last_name").in("id", distinctActorIds)` | Actor names — **one batched query**, skipped entirely when every actor is null. |

It is explicitly **not N+1**. The distinct actor ids are collected in JS, queried once, and
joined through a `Map`. This audit found nothing to fix in that shape; the problem is only that
it is a join *in TypeScript*.

### What happens in TypeScript

| Step | Code |
| --- | --- |
| Timestamp formatting | `Intl.DateTimeFormat("en-GB", { timeZone: "UTC", … })` — fixed locale, fixed zone. |
| Action / entity humanising | `toReadableLabel()` — a **generic** humanizer: underscores → spaces, sentence case. |
| Actor resolution | `null → "System"`, resolved → `"First Last"`, unresolvable → `"Unknown user"`. ⚠️ The web's bare *"System"* is the same overclaim § 5.5 documents — it is recorded here as existing behaviour, **not endorsed**, and is not changed by this milestone. |
| Join | `Map<actorId, displayName>` built in memory. |

The module's own comment states that `toReadableLabel()` is a temporary stand-in to be replaced
by an explicit `Record<string, string>` once the action vocabulary exists.

### What the page renders

Four columns — **Time (UTC), Actor, Action, Resource** — as a table above `md` and as labelled
cards below it. No id is rendered; React keys are array indices, which the page comments
justify by the list being server-rendered in a fixed order and never mutated.

### Failure and empty handling

| Case | Behaviour |
| --- | --- |
| Not signed in | `redirect("/login")` |
| Not a Vendor Super Admin | `redirect("/access-denied")` |
| Query failure | `auditLogs: null` → *"Audit logs unavailable"*, still `status: "authorized"` |
| No records | `auditLogs: []` → *"No activity recorded yet"* |

The `null` / `[]` distinction is deliberate and correct, and the mobile contract preserves it
(§ 10).

### Pagination, filters, detail — **none of the three**

No cursor, no offset, no page controls, no action filter, no entity filter, no actor filter, no
date range, no detail view, no export.

---

## 2. The authoritative schema

**Table:** `public.audit_logs` — created by `20260716130351_vendor_admin_audit_logs.sql`. There
is exactly one audit table; nothing else in the schema records activity history.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK, `gen_random_uuid()` | the tie-breaker this contract paginates on |
| `organization_id` | `uuid` **nullable**, FK → `organizations` `ON DELETE SET NULL` | the **only** tenant column |
| `actor_profile_id` | `uuid` **nullable**, FK → `profiles` `ON DELETE SET NULL` | **`profiles.id` IS the auth user id** |
| `action` | `text` NOT NULL, non-empty check | open-ended; no enum, no lookup table |
| `entity_type` | `text` NOT NULL, non-empty check | open-ended |
| `entity_id` | `text` **nullable** | opaque; meaning depends on `entity_type` |
| `metadata` | `jsonb` NOT NULL default `{}`, `jsonb_typeof = 'object'` check | **contents unconstrained** |
| `ip_address` | `inet` **nullable** | **never written by any shipped function** |
| `user_agent` | `text` **nullable** | **never written by any shipped function** |
| `created_at` | `timestamptz` NOT NULL default `now()` | the **only** timestamp |

**No `updated_at`, no `updated_at` trigger** — append-only by design. **No audit triggers
exist anywhere**; rows are inserted explicitly by trusted `SECURITY DEFINER` functions. **No
`old_values`, `new_values`, `request_id`, `correlation_id`, `result`, `outcome`, `severity` or
`actor_name` column exists.**

### Indexes (all pre-existing)

| Index | Columns |
| --- | --- |
| `audit_logs_org_created_idx` | `(organization_id, created_at desc)` ← **either of these can serve the read** |
| `audit_logs_created_idx` | `(created_at desc)` ← **↑ planner's choice; see § 12** |
| `audit_logs_actor_created_idx` | `(actor_profile_id, created_at desc)` |
| `audit_logs_entity_idx` | `(entity_type, entity_id)` |

### RLS and grants (unchanged by this milestone)

`audit_logs_select_authorized` — `FOR SELECT TO authenticated`:

```sql
organization_id is not null
and (has_organization_permission(organization_id, 'AUDIT_LOGS_READ')
     or has_organization_role(organization_id, 'VENDOR_SUPER_ADMIN'))
```

The `is not null` is factored **out** of the `OR` deliberately, so neither branch can admit a
null-organization row. `authenticated` holds `SELECT` and nothing else; `anon` holds nothing.

---

## 3. The real action and entity vocabulary

Read from every `insert into public.audit_logs` in the repository. **Nothing here is invented,
and the contract adds no category to it.**

| Action | Entity type | Organization the row is filed under | Actor |
| --- | --- | --- | --- |
| `RETAILER_ONBOARDED` | `RETAILER_ORGANIZATION` | Vendor | Vendor admin |
| `RETAILER_SHOP_ADDED` | `RETAILER_SHOP` | Vendor | Vendor admin |
| `RETAILER_OWNER_INVITED` | `RETAILER_INVITATION` | Vendor | Vendor admin (**nullable**) |
| `RETAILER_OWNER_INVITATION_REVOKED` | `RETAILER_INVITATION` | Vendor | Vendor admin |
| `RETAILER_OWNER_INVITATION_ACCEPTED` | `RETAILER_INVITATION` | **Retailer** | the accepting user |
| `STAFF_INVITATION_RESERVED` / `_SENT` / `_RESENT` / `_REVOKED` / `_DELIVERY_FAILED` / `_ACCEPTED` | `RETAILER_STAFF_INVITATION` | **Retailer** | Retailer staff/owner (**nullable**) |
| `PRODUCT_CREATED` / `_UPDATED` / `_ACTIVATED` / `_DEACTIVATED` / `_ASSIGNED_TO_RETAILER` / `_UNASSIGNED_FROM_RETAILER` | `VENDOR_PRODUCT` | Vendor | Vendor admin |

**A Vendor's history therefore contains the Vendor-filed rows only.** Retailer-side acceptance
and staff-invitation events are filed under the *Retailer* organization and are correctly
invisible to the Vendor — that is the shipped tenant model, not a defect, and this milestone
does not change it.

### Metadata keys actually written

`retailer_name`, `product_name`, `product_code`, `product_status`, `vendor_name`,
`first_shop_name`, `retailer_status`, `relationship_status`, `shop_name`, `shop_code`,
`shop_city`, `shop_country_code`, `shop_status`, `role_code`, `invitation_status`,
`membership_status`, `shop_count`, `assignment_status`.

**No shipped writer puts an email, phone number, invitation token, token hash, storage path,
receipt path, IP address, user agent, auth identity, service-role hint or secret into
`metadata`.** That is a property of *today's writers*, not of the schema — `metadata`'s contents
are unconstrained — which is exactly why the contract reads a **closed whitelist** rather than
trusting the column (§ 5.3).

---

## 4. Answers to the audit questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Functional Audit Logs page? | **Yes.** |
| 2 | What does it display? | Time (UTC), actor name, humanized action, humanized entity type. |
| 3 | Real or placeholder? | **Real**, database-backed. |
| 4 | Authoritative table? | `public.audit_logs`. The only one. |
| 5 | Authoritative timestamp? | `created_at`. The only one. |
| 6 | How is a row scoped to a Vendor? | `organization_id` — one scalar FK column. |
| 7 | Can a row belong to >1 organization? | **No.** Scalar column; exactly one, or null. |
| 8 | Actor representation? | `actor_profile_id` → `profiles.id`, which **is the auth user id** (1:1 FK to `auth.users`). Nullable. |
| 9 | Deleted / unavailable actor? | FK is `ON DELETE SET NULL`, so a deleted profile becomes null — **indistinguishable from a system action**. See § 7.2. |
| 10 | Actor name: snapshot or live join? | **Live join.** No name snapshot column exists. |
| 11 | Actor emails stored? | **No.** Not on `audit_logs`, and `auth.users` is never queried. |
| 12 | Should emails be shown? | **No.** The web shows none; nothing in the product requires one. |
| 13 | Which action codes exist? | The 17 in § 3. |
| 14 | Constrained or open text? | **Open** `text`, non-empty check only. |
| 15 | Entity type? | Yes — `entity_type text NOT NULL`. |
| 16 | Entity id? | Yes — `entity_id text`, **nullable**, opaque. |
| 17 | Entity display-name snapshot? | **Yes, in `metadata`** — `product_name` / `retailer_name` / `shop_name`. |
| 18 | Does the web resolve entity names? | **No.** It renders the type only. |
| 19 | Old/new values stored? | **No such columns.** |
| 20 | Metadata JSON stored? | Yes, unconstrained `jsonb` object. |
| 21 | Can metadata contain secrets? | **Not today** (§ 3), but the schema permits anything — hence the whitelist. |
| 22 | Does the web display raw metadata? | **No.** It never selects the column. |
| 23 | Existing safe projection? | **No.** The web's projection is TypeScript-side and unshared. |
| 24 | Detail available? | **No.** List only, everywhere. |
| 25 | Does the web paginate? | **No.** |
| 26/27 | Pagination style? | Fixed `LIMIT 100`. Not offset, not cursor — **no pagination at all**. |
| 28 | Duplicates/omissions from new rows? | N/A today (single page); would occur immediately under offset. |
| 29 | Stable tie-breaker? | **Not in the web.** `ORDER BY created_at DESC` alone. |
| 30 | Default page size? | 100 (`AUDIT_LOG_LIMIT`). |
| 31 | Bounded server-side? | Only by that constant; the client cannot ask for more, but nothing in SQL enforces it. |
| 32 | Filters? | **None.** |
| 33 | Useful first-Flutter filters? | **None yet** — see § 11.4. Scroll + refresh is the whole first experience. |
| 34 | Client-side joins? | **Yes** — the actor `Map` join. |
| 35 | Round trips per page? | **3** (authorization, audit rows, actor batch); 2 when every actor is null. |
| 36 | One actor lookup per row? | **No.** Batched and deduplicated. |
| 37 | One entity lookup per row? | **No.** No entity lookup at all. |
| 38 | Loads unrestricted JSON for a short description? | **No.** `metadata` is never selected. |
| 39 | Existing reusable RPC? | **No.** No audit RPC exists. |
| 40 | Direct RLS reads suitable for Flutter? | **No** — see § 8.1. |
| 41 | Fields required for a safe first screen? | The seven in § 5.1. |
| 42 | Sensitive / unstable / unnecessary? | `metadata`, `entity_id`, `ip_address`, `user_agent`, `actor_profile_id`, `organization_id`. |
| 43 | Which permission gates the page? | `AUDIT_LOGS_READ` (via the RLS policy) plus Vendor Super Admin authority (via the module). |
| 44 | Does Super Admin authority alone suffice? | For the **RLS policy**, yes — it is an `OR`. This contract requires **both** (§ 8.2). |
| 45 | May Retailer roles read Vendor audit history? | **Never.** pgTAP asserts all three Retailer roles are denied. |
| 46 | Multi-Vendor ambiguity? | Existing lowest-organization-id behaviour, reproduced verbatim (§ 4.4). |
| 47 | Are rows immutable? | **In practice, yes.** No `updated_at`, no update path, no `UPDATE`/`DELETE` privilege for browser roles. Not enforced by a trigger. |
| 48 | Retained indefinitely? | **Yes.** No pruning, no partitioning, no retention job anywhere. |
| 49 | Enough indexes for keyset pagination? | **Yes** — `audit_logs_org_created_idx`. Measured; § 12. |
| 50 | Failed or successful actions recorded? | **Successful changes**, plus exactly one explicit failure *action*: `STAFF_INVITATION_DELIVERY_FAILED`. **Failed authorization attempts are never recorded** — the audit row is written inside the transaction that succeeded. |

### Gaps proved

1. **No pagination.** Record 101 unreachable forever.
2. **Actor join lives in TypeScript**, with caller-dependent results.
3. **Entity never named**, though the snapshot is already stored.
4. **No tie-breaker.** `created_at` alone is not a total order — and `now()` is the
   *transaction* timestamp, so ties are reachable, not theoretical.

### Were existing reads reusable?

**No.** There is no audit RPC to reuse, and the web module is a Next.js server-only TypeScript
function — not a shared backend operation. One new RPC was added; nothing existing was
modified.

### 4.4 Multi-Vendor limitation (preserved, not fixed)

`get_vendor_super_admin_context()` returns one row per qualifying Vendor, ordered by
organization id; every Vendor RPC — and `getVendorSuperAdminAccess()` on the web, via
`contextRows[0]` — takes the first. A Super Admin of two Vendors reads the **lowest-id
Vendor's** history, deterministically. This is reproduced verbatim. Changing it would change
which organization's history an existing operator sees as a side effect of a mobile read, so it
is **documented rather than redesigned**.

---

## 5. What was added

### `public.list_vendor_audit_logs(p_limit integer default 50, p_before_occurred_at timestamptz default null, p_before_audit_log_id uuid default null)`

`LANGUAGE plpgsql` · `STABLE` · `SECURITY DEFINER` · `SET search_path = ''`
`REVOKE ALL … FROM public` · `REVOKE EXECUTE … FROM anon` · `GRANT EXECUTE … TO authenticated`
service_role: **nothing**.

### 5.1 Output contract and nullability

| Column | Type | Nullable | Meaning |
| --- | --- | --- | --- |
| `audit_log_id` | `uuid` | **No** | `audit_logs.id`. The list key **and** the cursor id. |
| `occurred_at` | `timestamptz` | **No** | `audit_logs.created_at`, exact. The cursor timestamp. |
| `action_code` | `text` | **No** | `audit_logs.action`, **raw**. |
| `entity_type` | `text` | **No** | `audit_logs.entity_type`, **raw**. |
| `entity_display_name` | `text` | **Yes** | Historical name snapshot, or null. |
| `actor_type` | `text` | **No** | `'USER'` \| `'SYSTEM'` \| `'UNKNOWN'`. |
| `actor_display_name` | `text` | **Yes** | Non-null **iff** `actor_type = 'USER'`. |

That biconditional is asserted over the whole page in pgTAP, not row by row.

### 5.2 Action-code semantics

**Returned exactly as stored.** Nothing is mapped, defaulted, humanized, hidden or inferred.

**No label column is returned, because no trusted mapping exists to return.** Both code columns
are plain `text` with only a non-empty check — no enum, no lookup table, no reference data. The
web's `toReadableLabel()` is a generic humanizer whose own comment calls it a temporary
stand-in; promoting a placeholder into a shared database contract would freeze a stop-gap into
an API.

**Client rule:**

* known codes (§ 3) → friendly labels;
* unknown codes → neutral humanization (underscores → spaces, sentence case), **neutral
  styling**, still visible;
* **no security decision is ever made from a label.**

An unknown code is returned unchanged and its row is returned in full — never dropped, never
coerced to a known code, never inferred from `entity_type`. pgTAP asserts this against a
deliberately unrecognisable `SOMETHING_NOT_YET_INVENTED` / `FUTURE_ENTITY` row.

**There is no `result` / `outcome` field, and none is fabricated.** The table has no such
column. Outcome is encoded in the action itself where it is recorded at all
(`STAFF_INVITATION_DELIVERY_FAILED` is the only failure event this schema writes).

### 5.3 Entity semantics — a snapshot, never a live lookup

```
VENDOR_PRODUCT            -> metadata ->> 'product_name'
RETAILER_ORGANIZATION     -> metadata ->> 'retailer_name'
RETAILER_SHOP             -> metadata ->> 'shop_name'
RETAILER_INVITATION       -> metadata ->> 'retailer_name'
RETAILER_STAFF_INVITATION -> metadata ->> 'retailer_name'
anything else             -> null
```

**No entity table is joined.** Four properties follow:

* a **deleted** entity still has a name — the record survives the thing it records;
* a **renamed** entity keeps its historical name;
* **no existence oracle** — a live join by `(entity_type, entity_id)` would answer "does this id
  still exist" for any id, across tenants;
* **no N+1**, and no per-row tenant check.

Two guards make the extraction safe against a *future* writer, since `metadata`'s contents are
unconstrained:

* `jsonb_typeof(metadata -> key) = 'string'` — a non-string value would otherwise be stringified
  by `->>` into raw JSON text, which is precisely the leak this forbids;
* `nullif(btrim(…), '')` — a blank snapshot reads as *unavailable*, not as an empty name.

`entity_display_name` is **null** for an unknown entity type (even one whose metadata happens to
carry a familiar key), a missing key, a blank value, or a non-string value. A client treats null
as *"target not named"* — never as an error, and never as a reason to hide the row.

**`entity_id` is deliberately not returned.** It is opaque, and for the two invitation types it
identifies a row that also carries an email and a token hash. No web navigation from an audit
row exists to mirror, so the id would be an unused identifier of a sensitive row travelling to a
phone. See § 11.3 for the future cross-linking note.

### 5.4 Actor and system-event semantics

| `actor_type` | Condition | `actor_display_name` |
| --- | --- | --- |
| `'USER'` | `actor_profile_id` resolves to a **member of this same Vendor organization** (any membership status, any profile status) | `"First Last"` |
| `'SYSTEM'` | `actor_profile_id IS NULL` — **no actor identity remains**. See § 5.5. | `null` |
| `'UNKNOWN'` | `actor_profile_id` is present but resolves to no membership in this Vendor | `null` |

The exact expressions, from the deployed `pg_proc.prosrc`:

```sql
case when a.actor_profile_id is null then 'SYSTEM'
     when actor.first_name    is null then 'UNKNOWN'
     else                                  'USER'  end,
case when actor.first_name is null then null
     else actor.first_name || ' ' || actor.last_name end
```

### 5.4.1 Every database state, resolved — verified against the live database

| # | Database state | `actor_type` | `actor_display_name` |
| --- | --- | --- | --- |
| 1 | Written with a null actor (genuine system event) | `SYSTEM` | `null` |
| 2 | Actor recorded, then nulled by `ON DELETE SET NULL` | `SYSTEM` | `null` |
| 3 | Actor is a member of the audit row's Vendor | `USER` | `"First Last"` |
| 4 | Actor is a real profile with **no membership anywhere** | `UNKNOWN` | `null` |
| 5 | Actor's **profile status is `SUSPENDED`** | `USER` | `"First Last"` |
| 6 | Actor's **membership is `DEACTIVATED`** | `USER` | `"First Last"` |
| 7 | Actor belongs to **another Vendor** | `UNKNOWN` | `null` |
| 8 | Actor's profile/membership **deleted** | `SYSTEM` | `null` |
| 9 | `actor_display_name` is null | ⇔ type is **not** `USER` | — |

Rows **5 and 6** are deliberate: a suspended or deactivated person's past actions are exactly
the history an operator reviews *after* suspending them. Requiring `ACTIVE` would erase an
actor's name as a side effect of an unrelated administrative act.

**`UNKNOWN` is reachable by two distinct states** — 4 and 7 — and both are covered by
deterministic pgTAP fixtures (`F_NO_MEMBER` / `E_OTHER_VEND` shapes; suite § E).

### 5.5 The one genuine ambiguity — `SYSTEM` does **not** prove a system process

**The function cannot distinguish state 1 from state 2, and neither can the schema.**

`public.profiles.id REFERENCES auth.users ON DELETE CASCADE`, and
`audit_logs.actor_profile_id REFERENCES profiles ON DELETE SET NULL`. Deleting an auth user
therefore cascades to the profile and its memberships and **nulls the audit row's actor, while
leaving the audit row intact**.

Verified directly against the local database: a row reading `USER` / `"Gone Forever"` became
`SYSTEM` / `null` after `delete from auth.users`, and was then **byte-identical in every emitted
actor field** to a row born with a null actor.

No *application* code path deletes a profile — there is no SQL delete and no `admin.deleteUser`
call anywhere in this repository. But the **Supabase Admin API and the Studio user list both
expose auth-user deletion to an operator**, so this state is reachable in operation even though
no product feature causes it. Calling it "unreachable" would be too strong.

**Therefore `SYSTEM` must be read as "no actor identity remains", never as "a system process did
this".** Client wording must be neutral — see § 11.3. The correct fix is an actor-name snapshot
column on `audit_logs`, which is a schema change a read-only milestone must not make.

**The membership scope is a privacy boundary, not an optimization.** The function is
`SECURITY DEFINER`, so an unscoped join to `public.profiles` would bypass the `profiles` RLS
policy and could print a person from a *different* organization onto a Vendor's audit screen.
Requiring an `organization_members` row in the audit row's own organization means the only
names that can appear are the Vendor's own people. pgTAP asserts this with a real Vendor B
member as the actor on a Vendor A row: `actor_type = 'UNKNOWN'`, **no name**.

**Membership status is deliberately not required to be `ACTIVE`.** A suspended member's past
actions are precisely the history an operator reviews *after* suspending them; demanding
`ACTIVE` would turn a named actor into `UNKNOWN` the moment their access was revoked, silently
rewriting history as a side effect of an unrelated act.

**A row is never dropped for missing actor context.** Both joins are `LEFT`. An audit log that
discards records whose context is incomplete is not an audit log.

**The actor is never inferred from the caller.** pgTAP asserts that exactly the nine rows the
caller actually wrote name her, out of twelve.

---

## 6. Why there is **no** detail operation

The audit searched the whole repository for an audit-detail surface: a drawer, a modal, a
`[auditLogId]` route, an expandable row, a "view details" action. **There is none.**
`app/(admin)/audit-logs/` contains exactly two files, and the page renders one flat table over
four preformatted strings.

There is therefore **no second web read to share**, and no shipped notion of what audit "detail"
even means in this product. The only thing a detail read could add over the list is precisely
what this contract withholds — `metadata` as a whole, `entity_id`, `ip_address`, `user_agent`.
Adding a function to expose those would not be *sharing an existing capability*; it would be
**inventing a new and more sensitive one** on the most sensitive table in the schema.

The milestone is therefore **list-only, by decision**. If a detail view is ever built for the
web, the right sequence is: design it there first, then share the projection it proves is
needed.

---

## 7. Current limitations

### 7.1 A Vendor sees only Vendor-filed rows

`RETAILER_OWNER_INVITATION_ACCEPTED` and every `STAFF_INVITATION_*` row is filed under the
**Retailer** organization (§ 3), so a Vendor's history shows the invitation being *sent* and
*revoked* but not *accepted*. This is the shipped tenant model. Changing it would mean changing
audit-write semantics, which this read-only milestone must not do. It is recorded here so the
Flutter screen's copy does not imply completeness it does not have.

### 7.2 A deleted actor is indistinguishable from a genuine system event

**Proven, not theorised** — see § 5.5 for the verification. `SYSTEM` means *"no actor identity
remains"*, and covers both a row born without an actor and a row whose actor was erased by
`ON DELETE SET NULL` when an auth user was deleted. No application code path deletes a profile,
but the Supabase Admin API and Studio both expose auth-user deletion to an operator, so the
state is reachable in operation.

**Consequence for clients:** never render `SYSTEM` as a confident *"System"*. Use neutral
wording (§ 11.3). The correct fix is an **actor-name snapshot column** on `audit_logs` — a
schema change a read-only milestone must not make.

### 7.3 No cross-linking from an audit row

`entity_id` is not returned, so a client cannot open the affected product or Retailer from a
history row. Adding it later is **additive** and would work cleanly for `VENDOR_PRODUCT` (→
`get_vendor_product_detail`) and `RETAILER_ORGANIZATION` (→ the Retailer reads, after mapping an
organization id to a relationship id); the two invitation types would stay unlinked. Not done
here because no web navigation exists to mirror and the milestone forbids adding entity
navigation.

### 7.4 No filters, no total count, no export

By design. See § 11.4 and § 5 respectively; export is explicitly out of scope.

### 7.5 Rows are immutable by convention, not by constraint

There is no `updated_at`, no update path, and no `UPDATE`/`DELETE` privilege for `anon` or
`authenticated` — but no trigger forbids a future migration from editing a row. Unchanged by
this milestone, and noted rather than acted on.

---

## 8. Authorization and tenant isolation

### 8.1 Why direct RLS reads are not suitable for Flutter

`authenticated` *does* hold `SELECT` on `audit_logs`, and the policy *would* return the caller's
rows. Four reasons that is the wrong contract anyway:

1. **`SELECT *` would return `metadata`, `ip_address`, `user_agent`, `entity_id` and
   `actor_profile_id`** — the last of which **is the auth user id**. Column choice would become
   a client responsibility, on the most sensitive table in the schema.
2. **The actor join would have to happen in Dart**, subject to the `profiles` policy, producing
   a *different* resolved subset than the web produces.
3. **Keyset pagination over a row comparison** is not expressible through PostgREST's filter
   syntax without either an `OR` that defeats the index or a client-built predicate.
4. **The tie-breaker would be the client's job.** It would be got wrong, and only at a tie.

### 8.2 The chain

```
auth.uid()
  → get_vendor_super_admin_context()      -- ACTIVE profile, ACTIVE membership,
      (zero arguments)                    -- ACTIVE VENDOR org, ACTIVE VENDOR_SUPER_ADMIN role
  → ORDER BY organization_id LIMIT 1      -- shipped multi-Vendor rule
  → has_organization_permission(v_vendor, 'AUDIT_LOGS_READ')
```

**Both gates, not either.** This is deliberately **narrower than the RLS policy**, which is an
`OR`. Narrower is safe by construction: it can only refuse callers the policy would admit, never
admit one the policy would refuse. Concretely, a Vendor Super Admin whose role has had
`AUDIT_LOGS_READ` withdrawn is refused here while the web page would still render — the correct
direction, and pgTAP proves it by **removing the seeded mapping**.

`AUDIT_LOGS_READ` is the **real, already-seeded** code (`20260716133023`, module `AUDIT_LOGS`),
already mapped to `VENDOR_SUPER_ADMIN` and already named by the RLS policy. **Nothing is
invented; no permission is seeded.** No shipped caller's access changes.

### 8.3 Confirmed denial behaviour — all `42501`, all identical

| Caller | Result |
| --- | --- |
| Signed out | `42501` |
| JWT naming a user with no profile | `42501` |
| Retailer Owner | `42501` |
| Retailer Manager | `42501` |
| Sales Staff | `42501` |
| Vendor member with **no role** | `42501` |
| Vendor Super Admin, **SUSPENDED profile** | `42501` |
| Vendor Super Admin, **SUSPENDED membership** | `42501` |
| Vendor Super Admin **without `AUDIT_LOGS_READ`** | `42501` |

The message names no table, column, policy, permission, Vendor or row. Authorization is decided
**before any argument is validated**, so probing the limit or cursor rules cannot distinguish an
unauthorized caller from an authorized one — asserted statically.

### 8.4 Tenant isolation

* Vendor A sees exactly its own rows; Vendor B's are **absent**, not refused, not counted.
* Vendor B sees exactly its own; none of Vendor A's ids, and none of Vendor A's entity names.
* **Null-organization rows are invisible to both**, reproducing the RLS policy's deliberate
  exclusion.
* A Vendor with no history gets `[]` — and that **returns**, so "none" stays distinct from
  "denied".
* Nothing reveals whether another Vendor has any history at all.

### 8.5 The client supplies no authorization context

No user id, auth user id, profile id, membership id, organization id, tenant id, role code,
permission code, actor id, entity owner id or organization selector — statically asserted
against the parameter names and structurally against the body (`organization_id` is never
compared to a parameter).

**The cursor is not authorization.** It is applied **after** the tenant predicate, never instead
of it. A cursor lifted from another Vendor's page — or invented outright — moves the window
within the caller's **own** history. pgTAP proves this three ways: a foreign cursor newer than
everything returns the caller's **entire** history; a foreign cursor at a **tied** timestamp
still pulls in no foreign row; a wholly fabricated id cannot widen the result.

`get_my_portal_context()` capabilities remain presentation hints only.

---

## 9. Pagination contract

**Ordering:** `occurred_at DESC, audit_log_id DESC` — both columns, always.

**Why the tie-breaker is load-bearing:** `created_at` defaults to `now()`, which in PostgreSQL
is the **transaction** timestamp. Two audit rows written inside one transaction carry
byte-identical `created_at`. A timestamp-only cursor over a tied pair either re-emits both rows
or skips both; there is no third outcome. `id` is the primary key, so `(created_at, id)` is
**unique** and the page boundary falls at exactly one place.

**Cursor:** the same two columns, taken from the **last row of the previous page**.

| Input | Behaviour |
| --- | --- |
| both `null` | newest page |
| both non-null | strictly older than that exact position |
| **exactly one** non-null | `22023` — a half cursor is a client bug, not a default |
| cursor at the oldest row | **empty list** |
| cursor older than every row | **empty list** |
| fabricated / foreign cursor | positions the window; grants nothing |

**Limit:**

| Input | Behaviour |
| --- | --- |
| omitted or `null` | **50** |
| `1 … 100` | honoured exactly |
| `0`, negative, `> 100` | **`22023`** |

**Out-of-range raises rather than clamping**, and that choice matters: a client asking for 500
and silently receiving 100 has been told nothing, and the natural (wrong) inference — *"fewer
rows than I asked for, so I've reached the end"* — terminates its paging loop early and hides
the rest of the history. A zero limit would be an empty page indistinguishable from the end of
history; a negative `LIMIT` is **unbounded** in PostgreSQL.

**New events cannot corrupt traversal.** The predicate is strictly-less-than against a fixed
position in a descending order, so every row a later page can return is *older* than the cursor.
Events arriving after page 1 are all *newer* than page 1's last row and land outside every
subsequent page by construction. They are not lost either: they appear the moment the client
refreshes with a null cursor — which is exactly what pull-to-refresh does.

pgTAP walks the whole history at page sizes **1, 3, 5 and 100** and compares each traversal
against one unpaginated read. Any duplicate, omission or reordering at any boundary — including
inside a deliberately constructed three-row tie group — fails.

**No total row count is returned.** An exact `COUNT` over an append-only table that grows
forever costs a full scan per page and is stale the moment it is computed. Keyset paging needs
none: the end of the history is a short or empty page.

---

## 10. Result and error semantics

| Case | Result |
| --- | --- |
| Authorized Vendor with events | stable ordered page |
| Authorized Vendor with no events | **empty list** (returns; never raises) |
| Cursor beyond the oldest event | **empty list** |
| Another Vendor's rows | **absent** — never refused, never counted, never hinted at |
| Unauthorized caller | one generic `42501` |
| Invalid cursor combination | `22023` |
| Invalid limit | `22023` |
| Operational / database failure | the underlying exception propagates |

**"Denied", "empty" and "failed" stay three different answers.** A denial is never converted to
an empty page, and an empty page never raises. On an audit surface, confusing "you may not read
this" with "nothing has happened" would be a serious misstatement — which is the same
distinction `lib/audit/vendor-audit-logs.ts` already preserves with its `null` vs `[]` result.

---

## 11. Flutter integration

### 11.1 Loading sequence

1. Sign in. `auth.uid()` is the only identity that travels.
2. `list_vendor_audit_logs()` — no arguments. Newest 50.
3. Render. Map known `action_code`s to friendly labels; humanize unknown ones neutrally.
4. On scroll-to-end: `list_vendor_audit_logs(50, lastRow.occurred_at, lastRow.audit_log_id)`.
5. Stop when a page returns fewer than the requested rows, or zero.

### 11.2 Refresh

Pull-to-refresh calls with a **null cursor** and replaces the list. New events appear at the
head. Do not merge a refreshed head into a paged tail without re-anchoring the cursor — the two
were taken at different instants.

### 11.3 Rendering rules

| Field | Rule |
| --- | --- |
| `entity_display_name == null` | show the humanized `entity_type` alone. **Never hide the row.** |
| `actor_type == 'SYSTEM'` | show **"System or unavailable actor"** (or an equivalent neutral phrase). **Do NOT render a bare "System"** — the value does not prove a system process acted; it means no actor identity remains, and a deleted user produces the same value. See § 5.5. |
| `actor_type == 'UNKNOWN'` | show a neutral *"Unknown actor"*. Do **not** substitute the caller. |
| `actor_display_name` | render verbatim; it is already the only name the caller is entitled to see. Never append an id or email — neither is returned. |
| unknown `action_code` | humanize neutrally, **neutral styling**, still visible. |
| any field | never drive an authorization, navigation or visibility decision from a label. |

**Why the `SYSTEM` wording matters.** A bare *"System"* on an audit line is a claim about *who
acted*. The schema cannot support that claim (§ 5.5), and an audit surface is the last place to
state something stronger than the evidence. Neutral wording costs nothing and stays true if an
actor-name snapshot column is ever added.

### 11.4 Filters — deliberately none, yet

Scroll and refresh are the whole first experience. The web offers no filters, so there is no
shipped filter semantics to share, and one invented here would be a product decision made in a
migration. Adding a bounded, non-authorizing filter later is **additive**; the obvious first
candidate is `entity_type`, which is indexed and closed-ish. `actor` is deliberately *not* a
candidate — it would take an identity as input.

---

## 12. Performance

**One round trip. One statement. One index range scan.** No client-side join, no per-row actor
query, no per-row entity query, no per-row authorization, no unbounded metadata transfer.

The Vendor context is resolved **once per call** and the permission checked **once per call** —
statically asserted (`get_vendor_super_admin_context` and `has_organization_permission` each
appear exactly once in the body).

### Measured — local reset, 200 000 audit rows

**The chosen index is planner-dependent, and the contract does not rely on which one wins.**
Two shipped indexes can serve this query — `audit_logs_org_created_idx` `(organization_id,
created_at desc)` and `audit_logs_created_idx` `(created_at desc)` — and the choice moves with
table statistics, row width and Vendor cardinality. Both were observed; both are bounded by the
limit. Measured at both extremes:

| Shape | Cursor depth | Plan | Rows read | Filtered |
| --- | --- | --- | --- | --- |
| **1 Vendor** (what this product is) | **150 000 rows deep** | `Index Scan using audit_logs_created_idx` | **51** | 1 |
| **40 Vendors** | null cursor | `Index Scan using audit_logs_created_idx` | **51** | 1 984 |
| **40 Vendors** | deep cursor | `Index Scan using audit_logs_created_idx` | **51** | 1 984 |

```
Limit
  -> Incremental Sort   (Sort Key: created_at DESC, id DESC; Presorted Key: created_at)
       -> Index Scan  (peak sort memory 27 kB throughout)
```

**The property that matters holds in every plan observed: cost is proportional to the *page*,
not to how deep the cursor sits.** A cursor **150 000 rows** into the history still read 51 rows.

**Contrast with `OFFSET`, measured on the same data.** `OFFSET 4500 LIMIT 50` planned a Bitmap
Heap Scan of **5 000 rows** and sorted **4 550** of them to emit 50 — and that cost grows with
every page, while the keyset cost does not.

**The worst case is bounded by (number of Vendor *organizations* × limit) index entries, never by
history depth.** When the planner uses the `created_at`-leading index it walks past other
Vendors' interleaved rows: ~2 000 index entries per page at 40 Vendors, ~51 at the single Vendor
this product is built around.

The `created_at <= coalesce(cursor, 'infinity')` line exists so that bound is **unconditional**
and therefore usable as an index qual. Written as `cursor is null or created_at <= cursor`, the
planner could not use it at all and every page would walk the organization's whole history.

### Indexes

**Reused:** `audit_logs_created_idx` / `audit_logs_org_created_idx` (planner's choice),
`organization_members_unique_membership` `(organization_id, user_id)`, the `profiles` primary key.

**Added: none.** A covering `(organization_id, created_at desc, id desc)` index would pin the
better plan and remove the id sort — but it buys a **bounded constant factor that is ≈1× for a
single-Vendor product**, in exchange for a third index to maintain on every audit insert: a
permanent write cost on every administrative action plus storage on the largest append-only
table in the schema.

**If this ever becomes a multi-Vendor deployment with a deep history, that index is the correct
and purely additive answer** — and the table above is the measurement that would justify it.

---

## 13. Web compatibility

**Visible web behaviour is unchanged.** Nothing about the web was rewritten or migrated.

| Surface | State |
| --- | --- |
| `app/(admin)/audit-logs/page.tsx` | **untouched** |
| `app/(admin)/audit-logs/loading.tsx` | **untouched** |
| `lib/audit/vendor-audit-logs.ts` | **untouched** — still two direct table reads, still its own actor `Map` |
| `audit_logs` table, columns, constraints, indexes | **untouched** |
| `audit_logs_select_authorized` policy | **untouched** |
| Table grants | **untouched** |
| Audit **writes** and the functions that emit them | **untouched** |
| Actor resolution used by the web | **untouched** |
| Retention | **untouched** (there was never any pruning) |
| Permissions and role mappings | **untouched** |
| Product / Retailer / User / Role behaviour | **untouched** |

Static tests assert the web module still calls `.from("audit_logs")` and `.from("profiles")`
itself, still selects exactly its four columns, and does **not** reference
`list_vendor_audit_logs`. The web may adopt the shared contract later; that is a separate,
optional change.

---

## 14. Security and privacy boundary

**Never returned:** raw `metadata`; `entity_id`; `ip_address`; `user_agent`; `actor_profile_id`
(**the auth user id**); `organization_id`; membership, role or permission internals; actor email;
phone number; invitation token, token hash or invitation email; old/new value JSON; request or
correlation identifiers (no such columns exist); storage paths, signed URLs or receipt
references; policy names; raw SQL errors; service-role information; total row counts.

`ip_address` and `user_agent` are **never selected**, not merely never rendered — a column that
is not read cannot leak from a future refactor, a log line, or an error payload. pgTAP proves
this against a fixture row that **populates both columns** and stuffs an email, an invitation
token, a token hash, a phone number, a storage path, an auth identifier and a service-role hint
into `metadata`: only `'Secret Widget'` — the whitelisted product name — comes out, and every
emitted value across the whole page is regex-searched for each of those secrets.

`auth.users` is never queried; `auth.uid()` is the only auth-schema reference in the migration.
RLS is not weakened anywhere; no table grant is added; `service_role` is granted nothing.

---

## 15. Tests

| Suite | File | Assertions |
| --- | --- | --- |
| pgTAP (behavioural) | `supabase/tests/database/vendor_audit_log_reads_test.sql` | **130** |
| Static contract guards | `lib/audit/vendor-audit-log-reads-contract.test.ts` | **26 tests** |

pgTAP sections: **A** catalogue, signature, attributes, grants and the unchanged table posture ·
**B** authorization and denial · **C** newest page, ordering, tie-break · **D** action, entity
type and the name snapshot · **E** actor semantics · **F** privacy against a hostile row ·
**G** limits, cursor validation and full traversal · **H** new events and foreign cursors ·
**I** tenant isolation and the empty history · **J** the exact permission requirement, proved by
removing the seeded mapping · **K** the read writes nothing · **L** the actor ambiguity, proved by
actually deleting an auth user and observing the row flip from `USER`/named to `SYSTEM`/null.

---

## 16. Next Flutter milestone

Build the Vendor Audit Logs screen against `list_vendor_audit_logs`, replacing the current
placeholder: newest 50, infinite scroll on the two-part cursor, pull-to-refresh with a null
cursor, a label map for the 17 known action codes with neutral fallback, and the three actor
states rendered distinctly.

**Still without a mobile contract:** the Vendor dashboard summary (V-01). That, and Vendor
*writes*, are separate milestones and are not started here.
