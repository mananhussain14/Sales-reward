# Mobile Vendor Dashboard Summary — Audit and Contract

**Milestone:** mobile-safe Vendor Dashboard summary metrics
**Branch:** `feature/mobile-vendor-dashboard-summary`
**Backend base:** `91d39a3` (main)
**Migration added:** `supabase/migrations/20260805090000_mobile_vendor_dashboard_summary.sql`
**Scope:** read-only. No write, no schema change, no web change, no Flutter change.

---

## 1. Audit conclusion in one paragraph

The Vendor Admin dashboard at `/` is **real and fully database-backed**. There is no mocked
card, no sample figure and no zero placeholder anywhere on it. It renders **exactly four
counts** plus the organization's name and three static navigation shortcuts. Two of those four
counts are **not tenant-scoped at all** — they are global RBAC catalogue figures that are
identical for every Vendor in the deployment. The page issues **four separate database round
trips** for the four scalars, on top of the authorization round trip, and encodes all four
metric definitions in TypeScript. No existing RPC returns any of these figures, so calling
existing list RPCs and counting rows in Flutter would mean transferring full member and audit
row sets to produce four integers. One new zero-argument RPC closes the gap:
`public.get_vendor_admin_dashboard_summary()`.

---

## 2. Current web Dashboard behaviour

### 2.1 The files

| File | Role |
| --- | --- |
| `app/(admin)/page.tsx` | Server Component. Renders the page; contains no query. |
| `lib/dashboard/vendor-admin-summary.ts` | Server-only data module. Issues all four counts. |
| `app/(admin)/loading.tsx` | Skeleton — page header, 4 stat cards, 3 shortcut cards. |
| `components/admin/stat-card.tsx` | Presentational metric card. |
| `app/(admin)/layout.tsx` | Admin shell; performs its own Vendor Super Admin guard. |

There is **no dashboard error component**, no `app/(admin)/error.tsx`, and no dashboard
sub-route. `app/(admin)/` contains `page.tsx`, `loading.tsx` and `layout.tsx` only.

### 2.2 The cards actually visible

| # | Label | Hint text | Real or placeholder | Value shown |
| --- | --- | --- | --- | --- |
| 1 | **Active Members** | "Active memberships in this organization" | **Real** | `count(*)` of `organization_members` for the Vendor with `status='ACTIVE'` |
| 2 | **Active Roles** | "Roles available in the role catalogue" | **Real, but GLOBAL** | `count(*)` of `roles` with `status='ACTIVE'` — **no tenant predicate exists on this table** |
| 3 | **Permissions** | "Permissions defined across all modules" | **Real, but GLOBAL** | `count(*)` of `permissions` — **no status column, no tenant predicate** |
| 4 | **Audit Events** | "Recorded admin actions for this organization" | **Real** | `count(*)` of `audit_logs` for the Vendor — **all-time, no window** |

Below the metrics, a "Quick actions" section renders three plain `<Link>` cards (Manage
Retailers, Product catalog, Audit logs). They carry **no data** and issue **no query**.

### 2.3 What the dashboard does NOT show

Confirmed absent from `app/(admin)/page.tsx` by direct inspection: charts, time series,
trends, percentage changes, deltas, sparklines, revenue, sales totals, receipt totals, claim
totals, coin totals, payout totals, campaign metrics, forecasts, leaderboards, reports,
audit-log rows, a recent-activity feed, Retailer counts, Product counts, shop counts,
assignment counts, and invitation counts. Sales Staff, receipts, claims, coins and payouts do
not appear in any form. **No value on the page is fake or a zero placeholder.**

### 2.4 Round-trip behaviour today

| Step | Call | Sequencing |
| --- | --- | --- |
| 1 | `supabase.auth.getClaims()` | Local JWT verification (cached JWKS) |
| 2 | `rpc('get_vendor_super_admin_context')` | Sequential — must complete first |
| 3–6 | Four PostgREST reads on `organization_members`, `roles`, `permissions`, `audit_logs` | **Parallel**, via `Promise.all` |

**Five round trips per dashboard load**, of which four are parallel. Every one of the four
re-evaluates its table's RLS policy, and each of those policies calls
`has_organization_permission()` or `has_organization_role()`, which re-walks the
profile → membership → organization → role → permission chain. So the authorization chain is
walked **once explicitly and four more times implicitly**.

**The page does NOT fetch full row sets to count them.** Every read uses
`{ count: "exact", head: true }`, so PostgREST returns the `Content-Range` count and zero
rows. **Nothing is joined or aggregated in TypeScript** — the only TypeScript logic is
`toCount()` / `safelyReadCount()`, which normalise a failed count to `null`.

### 2.5 Error semantics today

Two failure kinds are kept strictly apart, and correctly so:

- **Authorization failure** → non-authorized status for the whole summary → redirect to
  `/login` or `/access-denied`.
- **Count query failure** → `null` for **that count only**; the card renders "Unavailable"
  and the other three still render.

So the web has **partial degradation on database error**, and **no partial behaviour on
permission** — see § 4.2.

---

## 3. Audit questions, answered

Numbered to match the milestone brief.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Real or placeholder? | **Real.** Fully database-backed, no mock. |
| 2 | Which cards are visible? | Active Members, Active Roles, Permissions, Audit Events. |
| 3 | Backed by real data? | **All four.** |
| 4 | Static/mocked/placeholder? | **None.** The three "Quick actions" tiles are static navigation, not metrics. |
| 5 | Exact values? | See § 2.2. |
| 6 | Which query produces each? | See § 2.2; all four in `lib/dashboard/vendor-admin-summary.ts`. |
| 7 | Round trips today? | **5** (1 auth RPC + 4 counts). |
| 8 | Sequential or parallel? | Auth first (sequential), then the four counts in parallel via `Promise.all`. |
| 9 | Fetches full rows to count? | **No.** `head: true` returns zero rows. |
| 10 | Joins/aggregates in TypeScript? | **No.** Only null-normalisation. |
| 11 | Authoritative table per metric? | `organization_members`, `roles`, `permissions`, `audit_logs`. |
| 12 | Statuses that exist? | `organization_members`: INVITED, ACTIVE, SUSPENDED, DEACTIVATED. `roles`: ACTIVE, INACTIVE. `permissions`: **no status column**. `audit_logs`: **no status column**. |
| 13 | Statuses included in each count? | Members: **ACTIVE only**. Roles: **ACTIVE only**. Permissions: **all**. Audit: **all**. |
| 14 | Labels semantically accurate? | **Two are not.** "Active Roles" and "Permissions" are global catalogue figures shown on an organization overview — identical for every Vendor. See § 3.1. |
| 15 | Does "Retailers" mean…? | **N/A — there is no Retailers card on the dashboard.** |
| 16 | Does "Users" mean…? | The card is "Active Members" and it means **`organization_members` rows for the Vendor with `status='ACTIVE'`**. Not profiles, not invited users, not role assignments. |
| 17 | Does "Products" mean…? | **N/A — there is no Products card on the dashboard.** |
| 18 | Counts assignment rows? | **No.** |
| 19 | Counts unique assigned Retailers? | **No.** |
| 20 | Counts inactive/withdrawn assignments? | **No.** |
| 21 | Counts Retailer shops? | **No.** |
| 22 | Shops only for active relationships? | **N/A.** |
| 23 | Counts owner invitations? | **No.** |
| 24 | Counts Vendor user invitations? | **No — and none could exist.** See § 3.2. |
| 25 | Shows recent audit activity? | It shows an **all-time count**, with no window. |
| 26 | Count or rows? | **A count only.** No audit row reaches the page. |
| 27 | Sales Staff / receipts / claims / coins / payouts? | **None of them.** |
| 28 | Any fake or zero placeholders? | **No.** |
| 29 | Which permission gates the Dashboard? | The **page** is gated by Vendor Super Admin authority (`getVendorSuperAdminAccess()`). Each **count** is additionally gated by its table's RLS policy. |
| 30 | Does Super Admin authority alone suffice? | **Yes, on the web.** Every relevant RLS policy is an `OR` whose `VENDOR_SUPER_ADMIN` branch admits the rows regardless of mapped permissions. |
| 31 | Multiple permissions for different cards? | Under RLS, yes: `ORGANIZATION_MEMBERS_READ` (members), `RBAC_READ` (roles, permissions), `AUDIT_LOGS_READ` (audit) — but each is an `OR` with the role, so none is actually required today. |
| 32 | Suppresses cards when a permission is absent? | **No.** Cards degrade only on a **database error**, never on a permission. |
| 33 | Multi-Vendor ambiguity? | Yes — **lowest-organization-ID rule**, preserved. See § 4.4. |
| 34 | Definitions already shared in PostgreSQL? | **None.** All four definitions live in TypeScript. |
| 35 | Existing safe RPCs reusable? | **No.** See § 3.3. |
| 36 | Would counting rows in Flutter cost extra? | **Yes, badly.** See § 3.3. |
| 37 | Exact totals cheap under current indexes? | Three are trivial; the audit count is proportional to the Vendor's history. **Measured** — see § 8. |
| 38 | Could any count leak another Vendor's existence? | **No.** See § 3.1 and § 7. |
| 39 | Stale or contradictory definitions elsewhere? | **No.** `lib/dashboard/vendor-admin-summary.ts` is the only place these four are defined. |
| 40 | Which metrics are stable enough to pin? | **All four**, with the naming correction in § 3.1. |

### 3.1 The central finding: two of the four cards are not Vendor metrics

`public.roles` and `public.permissions` carry **no `organization_id` column**. They are a
single global catalogue, seeded by `20260716133023` and extended by later module migrations.
Their RLS policies (`roles_select_rbac_authorized`, `permissions_select_rbac_authorized`) gate
the catalogue **wholesale** on `RBAC_READ` or `VENDOR_SUPER_ADMIN` held in *any* of the
caller's organizations; they cannot scope rows to a tenant because there is nothing to scope
by.

So the "Active Roles" and "Permissions" cards **show the same number to every Vendor**.

This is not a security defect — a count of catalogue *definitions* written by migrations
reveals nothing about any tenant's data, size or activity, which is why two Vendors seeing the
same number is evidence of correctness rather than of leakage. But it **is** a semantic trap
for a second client. The mobile contract therefore names the distinction in its field names:

| Field | Scope |
| --- | --- |
| `active_member_count` | Tenant |
| `catalog_active_role_count` | **Global** |
| `catalog_permission_count` | **Global** |
| `audit_event_count` | Tenant |

**The web labels are not changed by this milestone** — that would be a visible web change,
which the milestone forbids. The finding is recorded here and encoded in the contract instead.

### 3.2 There are no Vendor user invitations, so no invitation metric is possible

The schema has exactly two invitation tables and both are **Retailer-scoped**:
`retailer_invitations` is constrained to Retailer organizations by trigger
(`retailer_invitations_assert_organization_types`), and `retailer_staff_invitations` carries no
`vendor_organization_id` at all. **Nothing invites a user into a VENDOR organization.**

A Vendor user's "invited" state is `organization_members.status = 'INVITED'` — ordinary column
data, already visible through `list_vendor_users()`. It is deliberately **excluded** from
`active_member_count`, because the card says "Active Members".

### 3.3 Were existing reads reusable? No.

| Candidate | Why it does not close the gap |
| --- | --- |
| `get_vendor_super_admin_context()` | Returns identity and organization name. **No counts.** |
| `get_my_portal_context()` | Presentation capability hints only. **No counts.** |
| `list_vendor_users()` | Returns full member rows (name, statuses, role arrays). Counting them client-side transfers every member to produce one integer — and it lists **all** memberships, so the client would also have to re-implement the `status='ACTIVE'` filter. |
| `list_vendor_audit_logs(…)` | **Keyset-paginated, hard-capped at 100 rows per page.** Counting the history through it is impossible without paging the entire append-only log to the phone. |
| `list_vendor_roles()` | Returns role rows with nested aggregates. Counting them client-side transfers the catalogue. |
| `list_vendor_retailers()`, `list_vendor_products()` | Irrelevant — those entities are not on the dashboard. |

There is **no existing function that returns any of the four figures**, and no overlapping API
to reuse. Counting rows in Flutter would mean **four list calls transferring full row sets** to
produce four integers, with the audit count being outright unobtainable.

### 3.4 Metrics deliberately NOT implemented

The schema could support many more counts. None is implemented, because **none appears on the
web dashboard**, and the milestone forbids speculative metrics.

| Not implemented | Reason |
| --- | --- |
| Retailer relationship / connected-Retailer counts | No such card exists. Status semantics (`vendor_retailers.status`) would have to be invented here. |
| Retailer shop counts | No such card. Would additionally require deciding whether to count shops of non-active relationships. |
| Product counts, active/inactive Product counts | No such card. |
| Product assignment counts | No such card, and row-vs-distinct semantics would have to be invented. |
| Pending invitation counts | No such card, and expiry/revoked/accepted semantics are non-trivial. |
| "Recent" / windowed audit counts | The product defines no window. |

Each is purely additive later, and each should arrive with the web card that defines it.

---

## 4. Authorization

### 4.1 What was chosen

**Option B: Vendor Super Admin authority PLUS every permission needed for every returned
metric.**

The caller must clear both gates:

1. `get_vendor_super_admin_context()` yields a Vendor — ACTIVE profile owned by `auth.uid()`,
   ACTIVE membership, ACTIVE organization of type VENDOR, ACTIVE `VENDOR_SUPER_ADMIN` role.
2. `has_organization_permission(<that Vendor>, …)` is true for **all three** of
   `ORGANIZATION_MEMBERS_READ`, `RBAC_READ`, `AUDIT_LOGS_READ`.

All three are **real, already-seeded codes** already mapped to `VENDOR_SUPER_ADMIN` in
`20260716133023`, and each is already named by the RLS policy on the table it gates. **Nothing
is invented and no permission is seeded.** No shipped caller's access changes.

### 4.2 Why not partial cards

The web has **no permission-based partial behaviour to mirror** — its cards degrade only on a
database error. Beyond that:

- A nullable count is a trap: `null` and `0` are one typo apart in every client, and a field
  that is sometimes "not permitted" and sometimes "none" invites a dashboard that renders
  "0 members" to someone who simply may not see members.
- It matches every other mobile Vendor read, so **the summary can never be more permissive
  than the screens it summarises**: a client cannot learn a member count here that
  `list_vendor_users()` would refuse it.

### 4.3 Narrower than RLS, deliberately

Requiring the role **and** the permissions is narrower than the RLS policies, which are `OR`s.
Narrower is safe by construction: it can only refuse callers the policies would have admitted,
never admit one they would refuse. Concretely, a Vendor Super Admin whose role has had
`AUDIT_LOGS_READ` withdrawn is **refused here** while the web dashboard would still render all
four cards. That is the correct direction, and pgTAP asserts it by removing each seeded mapping
in turn.

### 4.4 Multi-Vendor limitation (preserved, not redesigned)

`get_vendor_super_admin_context()` returns one row per qualifying VENDOR organization, ordered
by organization id, and every existing Vendor RPC takes the first. A caller who is a Super
Admin of two Vendors therefore summarises the **lowest-id Vendor**, deterministically on every
request — the shipped behaviour of `list_vendor_retailers()`, `list_vendor_users()`,
`list_vendor_products()`, `list_vendor_audit_logs()` and the web's own
`getVendorSuperAdminAccess()`. **This is reproduced verbatim rather than fixed**, because
changing it would change which organization's figures an existing operator sees as a side
effect of a mobile read. It is a documented limitation, not a defect this milestone resolves.

### 4.5 Confirmed behaviour per caller

| Caller | Result |
| --- | --- |
| Signed out | **Denied** — 42501 |
| Authenticated, no organization | **Denied** — 42501 |
| Vendor member without Super Admin authority | **Denied** — 42501 |
| Vendor Super Admin missing any one permission | **Denied** — 42501 (whole summary) |
| Retailer Owner | **Denied** — 42501 |
| Retailer Manager | **Denied** — 42501 |
| Sales Staff | **Denied** — 42501 |
| Inactive (SUSPENDED) caller profile | **Denied** — 42501 |
| Inactive (SUSPENDED / DEACTIVATED) Vendor membership | **Denied** — 42501 |
| Suspended Vendor organization | **Denied** — 42501 |
| Authorized Vendor with no data | **One row of zeros** (member count is 1 — the caller) |
| Another Vendor's rows | **Absent** — never counted, never hinted at |
| Multi-Vendor caller | Lowest organization id, deterministically |

Every denial is the **same generic 42501** with a message naming no table, column, policy,
permission, Vendor or count.

---

## 5. The contract

### 5.1 Signature

```sql
public.get_vendor_admin_dashboard_summary()
returns table (
  active_member_count       bigint,
  catalog_active_role_count bigint,
  catalog_permission_count  bigint,
  audit_event_count         bigint
)
language plpgsql
stable
security definer
set search_path = ''
```

**Zero arguments.** Granted to `authenticated` only; revoked from `PUBLIC` and `anon`; **not**
granted to `service_role`.

### 5.2 Output fields

| Field | Type | Nullable | Zero possible | Meaning |
| --- | --- | --- | --- | --- |
| `active_member_count` | `bigint` | **No** | Not in practice (≥ 1) | ACTIVE memberships in the caller's Vendor |
| `catalog_active_role_count` | `bigint` | **No** | Yes | ACTIVE role definitions, **deployment-wide** |
| `catalog_permission_count` | `bigint` | **No** | Yes | All permission definitions, **deployment-wide** |
| `audit_event_count` | `bigint` | **No** | **Yes** | All-time audit rows for the caller's Vendor |

No id, name, status, timestamp, JSON, array or nested collection is returned. **The contract is
counts and nothing else.**

### 5.3 Exact metric definitions

#### `active_member_count`

| Property | Value |
| --- | --- |
| Relation | `public.organization_members` |
| Tenant predicate | `organization_id = <derived Vendor>` |
| Status predicate | `status = 'ACTIVE'` |
| Historical/inactive rows count? | **No** — INVITED, SUSPENDED and DEACTIVATED are excluded |
| Deleted rows count? | **No** — FKs are `ON DELETE CASCADE`; no soft-delete column exists |
| Duplicates possible? | **No** — UNIQUE `(organization_id, user_id)` |
| Rows or unique entities? | Rows, but the row **is** the entity (see above). No `DISTINCT`. |
| Depends on another entity's status? | **No** — `profiles.status` is deliberately **not** joined, matching the web |
| Zero for no rows? | Yes (unreachable in practice — the caller's own ACTIVE membership authorized them) |
| Matches web? | **Yes, exactly** |

#### `catalog_active_role_count`

| Property | Value |
| --- | --- |
| Relation | `public.roles` |
| Tenant predicate | **None — the table has no `organization_id`.** Global. |
| Status predicate | `status = 'ACTIVE'` |
| Historical/inactive rows count? | **No** — INACTIVE definitions excluded |
| Duplicates possible? | **No** — `roles.code` is UNIQUE |
| Rows or unique entities? | Role **definitions**, not assignments. `member_roles` is not read. |
| Zero for no rows? | Yes |
| Matches web? | **Yes, exactly** |

#### `catalog_permission_count`

| Property | Value |
| --- | --- |
| Relation | `public.permissions` |
| Tenant predicate | **None — the table has no `organization_id`.** Global. |
| Status predicate | **None — the table has no status column.** Whole catalogue. |
| Duplicates possible? | **No** — `permissions.code` is UNIQUE |
| Rows or unique entities? | Permission **definitions**, not grants. `role_permissions` is not read. |
| Zero for no rows? | Yes |
| Matches web? | **Yes, exactly** |

#### `audit_event_count`

| Property | Value |
| --- | --- |
| Relation | `public.audit_logs` |
| Tenant predicate | `organization_id = <derived Vendor>` |
| Status predicate | **None.** No window, no date range, no action/entity/actor filter. |
| Historical rows count? | **Yes** — the table is append-only and never pruned; this figure only grows |
| Null-organization rows? | **Excluded** — plain equality; null never equals anything |
| Deleted rows count? | No delete path exists. An erased actor nulls `actor_profile_id` but the row survives and still counts. |
| Duplicates possible? | **No** — `organization_id` is a scalar FK |
| Zero for no rows? | **Yes — and 0 is a real answer, not a denial** |
| Matches web? | **Yes, exactly** |

### 5.4 Result and error semantics

| Situation | Behaviour |
| --- | --- |
| Authorized Vendor with data | **Exactly one row** |
| Authorized Vendor with no relevant data | **Exactly one row containing zeros** |
| Unauthorized caller (any reason) | **One generic 42501**, byte-identical across all causes |
| Inactive caller | Same generic 42501 |
| Operational/database failure | Exception propagates |

Zero rows is **not reachable** for an authorized caller. This is structural: the body is a
single `select` with **no from-clause** and four scalar aggregate subqueries. A select without
a from-clause emits exactly one row; an aggregate scalar subquery with no `GROUP BY` returns
`0` over an empty set, not `NULL` and not "no row". No `coalesce()` is written, because writing
one would imply a null was possible.

---

## 6. Tenant isolation

- The two tenant-scoped counts compare against a Vendor **derived from `auth.uid()`**, never
  from a parameter — there is no parameter.
- `organization_members.organization_id` and `audit_logs.organization_id` are scalar FKs, so a
  row belongs to exactly one organization and cannot be shared or double-counted.
- Another Vendor's rows are **absent** — not refused, not counted, not hinted at.
- Null-organization audit rows are invisible, reproducing `audit_logs_select_authorized`.
- The two catalogue counts are **identical for every Vendor**, which is precisely why they leak
  nothing: they do not depend on any tenant's rows. pgTAP asserts this by proving the two
  tenant counts **differ** between two Vendors with different data while the two catalogue
  counts are **equal**.

### 6.1 Why SECURITY DEFINER counts equal the web's RLS-filtered counts

| Table | Reason |
| --- | --- |
| `organization_members` | Policy admits a row on self OR `ORGANIZATION_MEMBERS_READ` OR `VENDOR_SUPER_ADMIN` for that row's organization. The caller holds role and permission in the derived Vendor, so all of that Vendor's rows are admitted. |
| `roles`, `permissions` | Policies gate the catalogue wholesale on `RBAC_READ` OR `VENDOR_SUPER_ADMIN` in any of the caller's organizations. The caller holds both, so the whole catalogue is admitted. |
| `audit_logs` | Policy admits non-null-organization rows on `AUDIT_LOGS_READ` OR `VENDOR_SUPER_ADMIN`. The predicate selects exactly that Vendor's non-null rows. |

The definer rights are what let the function answer in one statement instead of paying the
policy predicates — each of which re-walks the authorization chain — once per counted table.

---

## 7. Security boundary

Not returned, and why:

| Withheld | Reason |
| --- | --- |
| `organization_id`, organization name | The caller already knows which Vendor they are; an id in a payload is one a form could echo back as authorization. |
| Any id at all | Nothing here addresses a row. |
| Auth ids, profile ids, emails, phone numbers, display names | No person is identified. `public.profiles` is **not read at all**. |
| Role codes/names, permission codes, module names | The catalogue is returned as a **number**. |
| Audit rows, action codes, entity types, actor names, metadata, `ip_address`, `user_agent` | This is a count, not a feed. |
| Raw statuses | Statuses are **predicates**, not output. |
| Invitation tokens/hashes | Never returned anywhere — and neither invitation table is read. |
| Percentages, deltas, trends, time series | No such figure exists on the web dashboard. |

---

## 8. Performance

### 8.1 Measured plans

`EXPLAIN (ANALYZE, BUFFERS)` on a local reset, 200,000 audit rows and 5,000 memberships.

**Shape A — one Vendor owns everything** (the shape SalesReward actually has). The
organization predicate selects nothing away, so the planner **correctly declines both
indexes** — reading a whole table through an index is strictly worse than reading it directly:

| Count | Plan | Cost |
| --- | --- | --- |
| `organization_members` | `Aggregate → Seq Scan` (4,038 of 5,000 ACTIVE) | 63 buffers, **1.2 ms** |
| `audit_logs` | `Finalize Aggregate → Gather (2 workers) → Parallel Seq Scan` | 3,847 buffers, **28.6 ms** |
| `roles` | `Aggregate → Seq Scan`, 6 rows | **0.05 ms** |
| `permissions` | `Aggregate → Seq Scan`, 18 rows | **0.04 ms** |

**Shape B — 40 Vendors, the target holding 1/40 of the rows.** The predicate is now selective
and **both shipped indexes are used**, without anything being added:

| Count | Plan | Cost |
| --- | --- | --- |
| `organization_members` | `Aggregate → Bitmap Heap Scan → Bitmap Index Scan on organization_members_org_status_idx` | 101 rows, 62 buffers, **0.6 ms** |
| `audit_logs` | `Aggregate → Bitmap Heap Scan → Bitmap Index Scan on audit_logs_org_created_idx` | 5,000 rows, 3,893 buffers, **6.4 ms** |

Note the audit buffer count in Shape B: **3,893 heap blocks to count 5,000 rows**, essentially
the whole table, because a Vendor's events are interleaved with every other Vendor's in
physical order. The index narrows the **rows** but not the **pages**.

### 8.2 Indexes: none added, and why

No index is added. Every predicate is already served by a shipped index
(`organization_members_org_status_idx`, `audit_logs_org_created_idx`), and where no index is
used the planner is right to decline it. Avoiding the heap on the audit count would require a
covering index-only scan on the **largest append-only table in the schema**, paid for on every
administrative write — which the measured 6.4 ms does not justify.

### 8.3 The exact audit count is kept deliberately

An exact `COUNT` over an append-only table costs proportionally to the Vendor's history. That
is **accepted rather than optimised away**, because it is exactly what the web card already
does. Substituting a planner estimate, a materialised counter or a time window would make the
mobile figure **disagree with the web figure** — two clients showing different numbers for the
same card is how an operator stops trusting both. If the history ever outgrows this, the
correct answer is a product decision applied to **both** clients together.

### 8.4 What the contract avoids

- One RPC per card → **one RPC for all four**.
- Transferring member or audit rows to count them → **no rows transferred**.
- Client-side joins → **none**.
- Repeated Vendor authorization resolution → **resolved once**, versus five walks today.
- Duplicate counts from joins → **structurally impossible**; the four scalar subqueries share
  no key and there is no join in the query.
- Unbounded audit scans → the count is bounded by the Vendor's own history, as on the web.

---

## 9. Expected Flutter behaviour

**Loading sequence.** One call, no arguments:

```dart
final row = await supabase.rpc('get_vendor_admin_dashboard_summary');
```

Exactly one row for an authorized caller. There is no pagination, no cursor and no parameter.

**Refresh.** Pull-to-refresh re-invokes the same call. The result is not cacheable across
sessions: it is authorization-scoped and derived from `auth.uid()`.

**Rendering rules.**

- Every field is a **non-null, non-negative `bigint`**. There is no "unavailable" state to
  render — a failure is an exception, not a null count.
- `0` means **none**, never "not permitted".
- A `42501` means **denied**; it must never be rendered as zeros.
- **Do not label `catalog_active_role_count` or `catalog_permission_count` as belonging to the
  Vendor.** They are deployment-wide catalogue figures. Neutral wording such as "Roles in
  catalogue" / "Permissions defined" is correct; "Your roles" is not.
- `audit_event_count` is **all-time**. Do not label it "today", "this week" or "recent".

---

## 10. Web compatibility

**The web is untouched.** `app/(admin)/page.tsx` and `lib/dashboard/vendor-admin-summary.ts`
are unmodified and keep issuing exactly the four direct reads they issued before, with the same
labels, the same ordering and the same per-card "Unavailable" degradation. No function was
removed or renamed. No card label, count, navigation item or authorization rule changed. The
new RPC is purely additive and is called by nothing in the web app; migrating the web onto it
is a separate change with its own review.

---

## 11. Current limitations

1. **Multi-Vendor callers see only the lowest-id Vendor.** Shipped behaviour, preserved
   deliberately (§ 4.4). Not a defect this milestone resolves.
2. **Two of the four figures are deployment-wide, not tenant figures.** Named in the contract
   (§ 3.1), but the **web labels still read as though they were organization metrics**. Fixing
   the labels is a visible web change and is out of scope here.
3. **The audit count is exact and unbounded**, growing with the Vendor's history (§ 8.3).
4. **The contract is non-partial**: a Vendor Super Admin missing any one of the three
   permissions is denied the whole summary, where the web would still render all four cards
   (§ 4.3). Narrower, and intentional.
5. **No Retailer, Product, shop, assignment or invitation metric exists**, because no such card
   exists on the web (§ 3.4).

---

## 12. Tests

| Suite | File | Assertions | Result |
| --- | --- | --- | --- |
| pgTAP behavioural | `supabase/tests/database/vendor_dashboard_summary_test.sql` | **66** | **PASS** |
| Static contract guards | `lib/dashboard/vendor-dashboard-summary-contract.test.ts` | **32** | **PASS** |

pgTAP coverage: signature and zero-argument shape; exact output columns, order and `bigint`
types; forbidden-field guards; `SECURITY DEFINER`, `STABLE`, empty `search_path`; grants for
`authenticated` / `anon` / `PUBLIC` / `service_role`; exactly one row; non-null, non-negative
counts; exact member and audit figures; catalogue counts equal to direct catalogue queries;
INACTIVE role definitions excluded; nine denial cases plus a suspended organization; denial is
never a row of zeros; tenant counts differ between Vendors while catalogue counts are equal;
Retailer and null-organization audit rows counted by neither Vendor; multi-role and
multi-organization members counted once (with explicit anti-vacuity assertions); each of the
three permissions individually required and restored; partial-permission callers denied
entirely; the empty Vendor returning one row of zeros.

---

## 13. Next Flutter milestone

Build the Vendor Dashboard screen against `get_vendor_admin_dashboard_summary()`, replacing the
current placeholder. One call on load, pull-to-refresh, four count tiles using the labelling
rules in § 9. No chart, no trend, no feed, no navigation change beyond the existing shipped
Vendor read screens.
