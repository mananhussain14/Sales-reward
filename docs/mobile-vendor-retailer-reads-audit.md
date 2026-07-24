# Mobile Vendor Retailer Reads — Audit and Contract

**Milestone:** mobile-safe Vendor Retailer list and Retailer detail backend operations
**Branch:** `feature/mobile-vendor-retailer-reads`
**Migration:** `supabase/migrations/20260731090000_mobile_vendor_retailer_reads.sql`
**Covers:** mobile items **V-05** (Retailers directory) and **V-06** (Retailer detail)

This document records what the web does today, the gaps that justified new database
operations, and the exact contract those operations now offer. It supplements
`docs/mobile-backend-contract.md`; it does not replace it.

> **Scope.** This milestone delivers Vendor Retailer **reads** only. Vendor Users, Roles,
> Products, dashboard metrics, campaigns, claims, coins, payouts and reports are **not**
> implemented and are not described as implemented anywhere below.

---

## 1. The web Retailer **list**, as it works today

`lib/retailers/vendor-retailers.ts` → `getVendorRetailers()`, rendered by
`app/(admin)/retailers/page.tsx`.

| Step | Call | Notes |
| --- | --- | --- |
| 0 | `supabase.auth.getClaims()` | Verifies the JWT signature; yields `sub` |
| 0 | `public.get_vendor_super_admin_context()` | One RPC; resolves the Vendor. Request-memoized by React `cache()`, so a page that calls it twice pays once |
| 1 | `from("vendor_retailers").select("id, retailer_organization_id, status").eq("vendor_organization_id", …)` | Unfiltered by status |
| 2 | `from("organizations").select("id, name, status").in("id", retailerIds).eq("organization_type","RETAILER")` | Concurrent with step 3 |
| 3 | `from("retailer_shops").select("retailer_organization_id").in("retailer_organization_id", retailerIds)` | **Every shop row**, selected solely to be counted |
| 4 | JavaScript | Builds a `Map` of organizations, a second `Map` of shop counts, joins, drops every id except the relationship id, sorts by name with `localeCompare(…, "en")` |

**Round trips: four** (one authorization RPC + three table reads), fixed regardless of
Retailer count. It is not N+1 in *queries*.

**It is unbounded in *rows*.** Step 3 transfers one row per shop across all of the Vendor's
Retailers, purely so that step 4 can produce one integer per Retailer. Fifty Retailers of
forty shops each is two thousand rows on the wire to render fifty numbers. That is the
defect this milestone fixes.

**Failure semantics.** Authorization failure → `unauthenticated` / `unauthorized` for the
whole directory. Any data failure → `retailers: null`, still `authorized` — deliberately
never coerced to `[]`, because "could not load" and "manages none" are opposite claims.

---

## 2. The web Retailer **detail**, as it works today

`lib/retailers/vendor-retailer-detail.ts` → `getVendorRetailerDetail(relationshipId)`, plus
`lib/retailers/vendor-retailer-owner-status.ts`, rendered by
`app/(admin)/retailers/[relationshipId]/page.tsx`.

| Step | Call | Notes |
| --- | --- | --- |
| 0 | `get_vendor_super_admin_context()` | Shared with the layout via React `cache()` |
| — | `UUID_PATTERN` check | A malformed id becomes `not-found` before any query, so a mistyped URL cannot be reported as a database outage |
| 1 | `vendor_retailers … .eq("id", …).eq("vendor_organization_id", …).maybeSingle()` | Both predicates; a foreign id matches nothing |
| 2 | `organizations.select("name, status, country_code, default_currency") … .maybeSingle()` | Concurrent with 3 and 4 |
| 3 | `retailer_shops.select("name, code, city, country_code, status")` | Every shop row — here they are actually displayed |
| 4 | `public.get_vendor_retailer_owner_status(p_relationship_id)` | A SECURITY DEFINER RPC that authorizes independently |

**Round trips: five.** Steps 2–4 run concurrently, so wall-clock is three sequential hops,
but four separate results have to be reassembled by the client.

**Failure semantics.** Three kinds are kept strictly apart: authorization failure →
`unauthenticated`/`unauthorized`; addressing failure → `not-found` (malformed id, unknown
id, another Vendor's id, an RLS-declined row, and an unreadable Retailer organization are
all indistinguishable); data failure → `unavailable`, still authorized. Owner status
degrades independently: `{ status: "unavailable" }` disables only the owner card and is
never coerced to `NONE`.

---

## 3. Answers to the ten audit questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | How does the web build the list? | Three table reads plus one authorization RPC; the join, the count and the sort happen in TypeScript (§ 1) |
| 2 | How many round trips? | List **4**; detail **5**. Fixed, not per-Retailer |
| 3 | Does it read every shop row only to count? | **Yes** — `lib/retailers/vendor-retailers.ts` step 3. This is the one real performance defect |
| 4 | How is relationship status derived? | Read directly from `vendor_retailers.status` ∈ `ACTIVE` / `SUSPENDED` / `DEACTIVATED`. Never filtered |
| 5 | How is owner invitation status derived? | **Not in the list at all.** On the detail page only, via `get_vendor_retailer_owner_status(uuid)`: a five-state precedence (`ACTIVE` ≻ `PENDING`/`DELIVERY_FAILED` ≻ `EXPIRED` ≻ `NONE`) over `organization_members` + `member_roles` + `roles` and `retailer_invitations` |
| 6 | How are Retailer names and ids resolved? | Name from `organizations.name`, joined on `vendor_retailers.retailer_organization_id`. The web deliberately returns **only** the relationship id and drops every other id before it reaches the browser |
| 7 | How is detail data assembled? | Relationship row → Retailer organization row + shop rows (concurrent) → owner status RPC (concurrent); joined in TypeScript (§ 2) |
| 8 | Which fields does the web actually display? | **List:** name, Retailer status, relationship status, shop count. **Detail:** name, Retailer status, country code, default currency, relationship status, shop rows (name, code, city, country, status), shop count, and the owner card (state, name, email, `sent_at`, `expires_at`, `accepted_at`, `failure_code`, `invitation_kind`) |
| 9 | What does Flutter need? | Everything in the list plus a per-row owner state (so a directory can show "needs an owner"), `relationship_created_at`, an active-shop count, and `retailer_organization_id` for cross-linking to the product API |
| 10 | Does an existing RPC already cover this? | **Partly.** `get_vendor_retailer_owner_status(uuid)` is already authenticated, Vendor-authorized, leaks no token or hash, and is **reused unchanged** for the detail screen's owner card. It does **not** cover the list (one call per Retailer would be N+1 with per-row authorization), and nothing at all covers Retailer identity, counts, or shops |

### Gaps the audit proved

1. **No RPC returns the Vendor's Retailer list.** Flutter would have to reimplement a
   three-table join and the tenant scoping that goes with it.
2. **No RPC returns Retailer detail identity or shops.** Same problem, four results deep.
3. **Shop counts are computed by transferring shop rows.** Wrong on any connection; badly
   wrong on a mobile one.
4. **No set-based owner state exists.** The only provider is per-relationship and
   re-authorizes on every call.
5. **Two address spaces.** Retailer screens are addressed by `vendor_retailers.id` while
   `list_vendor_product_retailer_assignments()` returns `retailer_organization_id`, with
   nothing mapping between them (`mobile-backend-contract.md` § 6.8).
6. **Shops carry no id.** The web keys shop rows by array index; a mobile list cannot
   (`mobile-backend-contract.md` § 6.3).

---

## 4. What was added

One migration, `20260731090000_mobile_vendor_retailer_reads.sql`. It **creates four
functions and changes nothing that already exists** — no table, column, constraint, index,
trigger, RLS policy, role, permission, or permission mapping; no existing function is
edited, dropped, or replaced; no table privilege is granted to any browser role.

| Function | Grant | Purpose |
| --- | --- | --- |
| `public.vendor_retailer_owner_state(uuid)` | **none** — revoked from `public`, `anon`, `authenticated` | The shared owner-state derivation. Internal only |
| `public.list_vendor_retailers()` | `authenticated` | The Retailer directory |
| `public.get_vendor_retailer_detail(uuid)` | `authenticated` | One relationship, in full |
| `public.list_vendor_retailer_shops(uuid)` | `authenticated` | The justified companion read for shops |

All four are `SECURITY DEFINER`, `STABLE`, `language plpgsql`, `set search_path = ''`, and
fully schema-qualified throughout. None uses dynamic SQL. `service_role` is granted none of
them: they derive their authority from `auth.uid()`, which a service-role connection does
not have.

### Why the owner state is a separate internal function

The precedence is not obvious, and it must not exist twice. Written inline in both reads it
would be two definitions free to drift, and only one could be right. It is therefore
extracted once and called by both — and the pgTAP suite asserts, for every fixture state,
that its answer equals `get_vendor_retailer_owner_status(…).owner_state`. That assertion is
what keeps the mirror honest.

It is granted to **nobody**. It takes a Retailer organization id and performs no
authorization of its own; reachable by a browser role it would be an oracle for probing any
organization id. Its two callers invoke it as its owner because they are themselves
`SECURITY DEFINER` and owned by the same role — the same arrangement
`public.assert_organization_type` has used since migration 7.

### Why shops are a companion operation rather than nested

A Retailer's shop list is unbounded. Nesting it would make the detail payload grow without
limit, which is neither predictable nor cacheable on a mobile connection. The detail read
therefore returns a **fixed-size single row** including `shop_count` and
`active_shop_count`, which answers the summary question, and `list_vendor_retailer_shops()`
answers the inventory question when the screen scrolls to it. This is the one companion
operation the milestone adds.

---

## 5. The list contract

```sql
public.list_vendor_retailers()
returns table (
  relationship_id          uuid,
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_status          text,
  relationship_status      text,
  relationship_created_at  timestamptz,
  shop_count               integer,
  active_shop_count        integer,
  owner_state              text
)
```

**Zero arguments.** There is no Vendor id, Retailer id, user id, role, permission code, or
filter to pass, so no URL segment, form field, header, or cookie can nominate whose
directory is returned.

| Column | Meaning |
| --- | --- |
| `relationship_id` | `vendor_retailers.id` — the selector for the two reads below, and the same id the web route already uses |
| `retailer_organization_id` | `organizations.id` of the Retailer. Returned so a Flutter screen can cross-link to `list_vendor_product_retailer_assignments()` / `assign_vendor_product_to_retailer()`, closing § 6.8. It is **never** accepted as an input |
| `retailer_name` | `organizations.name` |
| `retailer_status` | The Retailer company's own state: `ACTIVE` / `SUSPENDED` / `DEACTIVATED` |
| `relationship_status` | This Vendor's relationship state — a **separate fact** from the above |
| `relationship_created_at` | When the Vendor onboarded this Retailer |
| `shop_count` | **Every** shop, whatever its status. Deliberately identical to the number the web directory shows today, so the two clients cannot disagree |
| `active_shop_count` | The `ACTIVE` subset. New; the web has no column for it |
| `owner_state` | One of `NONE`, `DELIVERY_FAILED`, `PENDING`, `EXPIRED`, `ACTIVE` |

**Ordering:** `retailer_name`, then `relationship_id`. Total, so a re-fetch or a paginated
client cannot see two rows swap places.

**Not returned:** `vendor_organization_id`; any owner name, email, or timestamp; any
invitation id, token, `token_hash`, `failure_code`, or `invitation_kind`; shop rows, shop
ids, or addresses; membership ids, role ids, or permission rows; `updated_at`.

### `owner_state` precedence

| State | Condition |
| --- | --- |
| `ACTIVE` | An `ACTIVE` membership in the Retailer holding an `ACTIVE` `RETAILER_OWNER` role. Wins outright over any invitation history |
| `PENDING` | Else: the newest `PENDING`, unexpired invitation whose flow's completion proof exists — `NEW_USER` needs both a membership and `sent_at`; `EXISTING_USER` needs `sent_at` alone |
| `DELIVERY_FAILED` | Else: that same invitation, without its completion proof (reserved but never dispatched) |
| `EXPIRED` | Else: any invitation that is `EXPIRED`, or `PENDING` with `expires_at <= now()` |
| `NONE` | Else. `REVOKED` rows and settled history land here |

This is byte-for-byte the precedence `get_vendor_retailer_owner_status(uuid)` applies, and
the pgTAP suite pins the two together.

---

## 6. The detail contract

```sql
public.get_vendor_retailer_detail(p_relationship_id uuid)
returns table (
  relationship_id          uuid,
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_status          text,
  country_code             text,
  default_currency         text,
  relationship_status      text,
  relationship_created_at  timestamptz,
  shop_count               integer,
  active_shop_count        integer,
  owner_state              text
)
```

**The column set is the list's, plus exactly the two Retailer profile fields the web detail
page displays and the list does not** (`country_code`, `default_currency`). Every shared
column is identical in name, type, and meaning, so one Flutter model deserializes both and a
future addition must be made to both or to neither. A static test enforces that relation.

```sql
public.list_vendor_retailer_shops(p_relationship_id uuid)
returns table (
  shop_id      uuid,
  shop_name    text,
  shop_code    text,
  city         text,
  country_code text,
  shop_status  text
)
```

Addressed by the **relationship id**, not by a Retailer organization id, so the two
operations cannot drift into two address spaces and a foreign id is inert here for exactly
the reason it is inert there. `shop_id` is included because the web's index-keyed shop list
is not usable by a mobile widget (§ 6.3); the sibling reads
`list_retailer_staff_assignable_shops()` and `list_my_assigned_receipt_shops()` already
return it to their own roles.

**Ordering:** `shop_name`, then `shop_id`. **No status filter** — a `SUSPENDED` or
`DEACTIVATED` shop stays listed, so this list can never contradict `shop_count`.

**Not returned:** `address_line1`, `address_line2`, `region`, `postal_code`, `created_at`,
`updated_at`, `retailer_organization_id`; any owner personal data; any invitation field; any
Retailer staff; any receipt.

**The owner card still comes from `get_vendor_retailer_owner_status(uuid)`.** That function
is unchanged, still granted to `authenticated`, and remains the single source of the
recipient name, email, `sent_at` / `expires_at` / `accepted_at`, `failure_code`, and
`invitation_kind`. Repeating that data here would be a second, drifting source of the same
PII — so the detail read carries only `owner_state`, for a badge.

---

## 7. Authorization and tenant isolation

Identity comes from `auth.uid()` and nothing else. Every function derives the Vendor the
same way every existing Vendor RPC does:

```sql
select ctx.organization_id into v_vendor
from public.get_vendor_super_admin_context() ctx
order by ctx.organization_id
limit 1;

if v_vendor is null
   or not public.has_organization_permission(v_vendor, 'RETAILERS_READ') then
  raise exception 'Not authorized to view Retailers'
    using errcode = 'insufficient_privilege';
end if;
```

Authorization is **delegated, never restated**: `get_vendor_super_admin_context()` evaluates
the whole chain (`ACTIVE` profile owned by `auth.uid()`, `ACTIVE` membership, `ACTIVE`
`VENDOR` organization, `ACTIVE` `VENDOR_SUPER_ADMIN` role), and
`has_organization_permission()` re-checks the reader's active chain against the
`RETAILERS_READ` permission. No role code appears anywhere in the migration — which role
holds `RETAILERS_READ` is seed data (`20260717115211` maps it to `VENDOR_SUPER_ADMIN` and to
nothing else), so no access was broadened here.

`get_my_portal_context()` capabilities are presentation hints and authorize nothing; none of
these functions consults it.

| Caller | Result |
| --- | --- |
| Signed out | `42501` on all three reads |
| Authenticated, no organization | `42501` |
| Retailer Owner | `42501` — including for their **own** Retailer |
| Retailer Manager | `42501` |
| Sales Staff | `42501` |
| Inactive (`SUSPENDED`) Vendor profile | `42501` |
| Inactive (`SUSPENDED`) Vendor membership | `42501` |
| Vendor Super Admin, wrong Vendor organization | Sees only their own Vendor's Retailers |
| Relationship belonging to another Vendor | **Zero rows** — never an error |
| Unknown relationship id | **Zero rows** — indistinguishable from the above |
| `null` relationship id | **Zero rows** |
| `SUSPENDED` / `DEACTIVATED` relationship (own) | **Readable**, with its status reported |

### Why a foreign id returns zero rows rather than a refusal

A distinguishable refusal would confirm that a relationship the caller may not read
nevertheless **exists**, and by sweeping ids, roughly how many. Zero rows is byte-identical
for a nonexistent id, another Vendor's id, and `null`.

This deliberately **differs** from `get_vendor_retailer_owner_status(uuid)`, which raises
`42501` for a foreign or unknown relationship. That function is not modified here — the web
depends on it exactly as it is — but the new contract does not repeat the pattern.

### Multi-Vendor behaviour — preserved, not changed

`get_vendor_super_admin_context()` returns one row per qualifying `VENDOR` organization,
ordered by organization id, and every existing Vendor RPC takes the first. A caller who is a
Super Admin of two Vendors therefore sees the **lowest-id Vendor's** Retailers,
deterministically and on every request.

That is the shipped behaviour of `list_vendor_product_retailer_assignments()`,
`get_vendor_retailer_owner_status()`, `onboard_vendor_retailer()`, and the web itself. It is
reproduced verbatim rather than "fixed": changing it would change which Retailers an
existing Vendor sees as a side effect of a mobile read. It is recorded as a limitation in
§ 11 instead.

**A Retailer legitimately managed by two Vendors** is handled correctly and is covered by
tests: each Vendor sees its **own** relationship id and its **own** relationship status for
that Retailer, and neither can address the Retailer through the other's relationship id.
Both see the Retailer's shops, because shops belong to the Retailer and both Vendors are
authorized over it — which is exactly what `retailer_shops_select_vendor_authorized` already
says.

---

## 8. Result and error semantics

| Situation | List | Detail | Shops |
| --- | --- | --- | --- |
| Authorized, has Retailers | Rows | One row | Rows |
| Authorized, no Retailers | **Empty set** | — | — |
| Authorized, Retailer has no shops | `shop_count = 0` | `shop_count = 0` | **Empty set** |
| Foreign / unknown / null id | — | **Empty set** | **Empty set** |
| Unauthorized caller | `42501` | `42501` | `42501` |
| Operational / database failure | Exception propagates | Exception propagates | Exception propagates |

A denial and "this Vendor manages no Retailers" are different facts and a client renders
them differently — collapsing them would show a brand-new Vendor a permission error and show
a Retailer Owner an empty directory instead of a refusal. Every refusal uses **one** generic
message (`Not authorized to view Retailers`) and the `42501` SQLSTATE; a message that varied
by cause would say which check failed.

> **Note on `list_vendor_retailer_shops`.** Zero rows means either "this relationship is not
> addressable by you" or "this Retailer has no shops". That ambiguity is in the safe
> direction. A client should call `get_vendor_retailer_detail` first: zero rows **there** is
> the authoritative "not addressable".

---

## 9. Performance

| | Web today | Mobile contract |
| --- | --- | --- |
| List round trips | 4 (1 auth RPC + 3 reads) | **1** |
| List rows on the wire | 1 relationship + 1 organization + **1 per shop** | **1 per Retailer** |
| Counting | JavaScript `Map` over every shop row | `count(*)` / `count(*) filter (…)` in a `LEFT JOIN LATERAL` |
| Detail round trips | 5 (1 auth + 3 reads + 1 owner RPC) | **2** (detail + owner status), **3** if the shop list is opened |
| Join | TypeScript, in the client | SQL, in the database |
| Vendor authorization | Once per page | Once per call — never per returned row |

Each read is a **single statement**: no loop, exactly one `return query`, and the Vendor is
resolved once before it. The lateral is an aggregate over an indexed range, not a second
round trip, and `LEFT JOIN LATERAL` + `coalesce(…, 0)` is what keeps a Retailer with no
shops in the list reporting `0` rather than vanishing.

Row multiplicity is fixed by the schema rather than by a `DISTINCT`:
`vendor_retailers_unique_pair` admits at most one row per (vendor, retailer), the
`organizations` join is on a primary key, and the lateral returns exactly one row. A
multi-shop Retailer therefore appears exactly once — asserted directly.

**No index was added.** Every predicate is served by one that already exists:

| Predicate | Existing index |
| --- | --- |
| `vendor_retailers.vendor_organization_id` | `vendor_retailers_vendor_status_idx` |
| `vendor_retailers.id` | primary key |
| `retailer_shops.retailer_organization_id` | `retailer_shops_org_status_idx` |
| `retailer_invitations (retailer_organization_id, status)` | `retailer_invitations_retailer_status_idx` |
| `organization_members.organization_id` | the unique key on `(organization_id, user_id)` |

A speculative index is a permanent write cost with no measured cause, so none was added.

---

## 10. Web compatibility

**Visible web behaviour is unchanged.** No page, loader, Server Action, or component was
touched by this milestone. `getVendorRetailers()` and `getVendorRetailerDetail()` still
perform exactly the reads described in §§ 1–2, still under RLS with the caller's own token,
and `get_vendor_retailer_owner_status(uuid)` is neither renamed, re-signed, re-granted, nor
recreated — a static test forbids the migration from even mentioning it, so this branch
cannot become the fourth breaking change that function has suffered.

The new functions are additive and are, for now, called by nothing in this repository. The
web may adopt them later; that is a separate change with its own review.

RLS is untouched: the three migration-9 read policies
(`vendor_retailers_select_vendor_authorized`, `retailer_shops_select_vendor_authorized`,
`organizations_select_vendor_managed_retailers`) still exist under the same names,
`public.retailer_invitations` still has zero policies and zero browser privileges, and no
table grant was widened. All of that is asserted by the pgTAP suite rather than merely
claimed here.

---

## 11. Flutter integration sequence

```
1. sign in                                  → Supabase Auth
2. get_my_portal_context()                  → route to the Vendor shell (presentation hint only)
3. list_vendor_retailers()                  → the directory screen
      · key each row by relationship_id
      · badge retailer_status + relationship_status separately — they are different facts
      · "N shops (M active)" from shop_count / active_shop_count
      · owner_state drives a "needs an owner" affordance
4. tap a row → get_vendor_retailer_detail(relationship_id)
      · zero rows  ⇒ show "not found" and pop; do NOT retry, do NOT report an outage
      · one row    ⇒ render the header, the statuses, the counts and the owner badge
5. in parallel:  get_vendor_retailer_owner_status(relationship_id)
      · the full owner card: name, email, sent/expires/accepted, failure_code, invitation_kind
      · on error, degrade the CARD only — never render it as NONE
6. on demand:    list_vendor_retailer_shops(relationship_id)
      · key each row by shop_id
```

**Error handling.** `42501` from any of the three reads means *not authorized* — send the
user to the access-denied surface; it never means "retry". Zero rows from an addressed read
means *not addressable* and must never be reported as an outage. Any other SQLSTATE is an
operational failure and is the only case that should be retried.

**Do not** send a Vendor organization id, user id, profile id, membership id, role, or
permission code to any of these functions. There is no parameter that accepts one, and the
absence is the point.

---

## 12. Current limitations

1. **Multi-Vendor Super Admins see one Vendor.** The lowest-id qualifying Vendor, per the
   shipped rule (§ 7). There is still no Vendor-selection mechanism; adding one is a product
   decision that would change existing behaviour for every Vendor RPC at once, not just
   these three.
2. **`list_vendor_retailer_shops` cannot distinguish "no shops" from "not yours".** By
   design (§ 8). Call the detail read first.
3. **No pagination.** A Vendor with hundreds of Retailers receives all of them in one
   response. Cursor pagination is deferred until a real Vendor is large enough to need it;
   adding it later is additive (new optional parameters, same columns).
4. **`owner_state` is coarse.** It carries no recipient, no timestamp, and no failure
   classification. That is deliberate — the detail screen's owner card calls
   `get_vendor_retailer_owner_status(uuid)`, which remains the only source of those.
5. **`get_vendor_retailer_owner_status` is still an unfrozen contract.**
   `mobile-backend-contract.md` § 6.1 stands: it has been dropped and recreated three times
   with a growing column list. This milestone does not add a fourth churn, but it does not
   fix the underlying stability problem either. Freezing or versioning it remains open work.
6. **Nothing consumes these functions yet.** No web page and no Flutter screen calls them in
   this repository; the migration is not deployed.

---

## 13. Tests

| Suite | File | Count | Result |
| --- | --- | --- | --- |
| pgTAP (behavioural) | `supabase/tests/database/vendor_retailer_reads_test.sql` | **127 assertions** | PASS |
| Static contract guards | `lib/retailers/vendor-retailer-reads-contract.test.ts` | **33 tests** | PASS |

The pgTAP suite runs inside one transaction and rolls back, so no fixture survives. It
covers signed-out denial; tenant isolation in both directions; Retailer Owner, Retailer
Manager, Sales Staff and no-organization denials; inactive profile and inactive membership;
the empty-set case for a Vendor with no Retailers; every relationship and Retailer lifecycle
status; shop counts with and without inactive shops; all five owner states **and their
row-for-row agreement with `get_vendor_retailer_owner_status()`**; duplicate-free joins for
multi-shop and multi-Vendor Retailers; stable ordering; the absence of every sensitive
field; the exact signature, output columns, `SECURITY DEFINER`, empty `search_path`,
`STABLE` volatility, and grants of all four functions; and the unchanged RLS posture and
table privileges.

The static guards supplement pgTAP and do not replace it: they assert what is decidable from
the migration source — forward ordering after every declared dependency, no historical
migration touched, no table/policy/index/grant-on-table, no client identity or tenant
parameter, delegated authorization, exact grants, the exact output contract, forbidden
field names, SQL aggregation instead of row transfer, single-statement reads, total
ordering, and one generic `42501` refusal.

---

## 14. Next Flutter milestone

Build the Vendor Retailers directory and Retailer detail screens against the three functions
above, using the sequence in § 11. Nothing else in the Vendor shell is unblocked by this
milestone: Vendor Users, Roles, Products, and dashboard metrics still have **no** mobile
contract, and each needs its own audit before any screen is built against it.
