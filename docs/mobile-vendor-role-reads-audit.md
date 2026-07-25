# Mobile Vendor Role Reads — Audit and Contract

**Milestone.** The smallest stable authenticated read contract a Vendor Super Admin needs to
list roles, open one role, and see the permissions that role grants, from a Flutter client.

**Scope.** Read-only, backend-only, additive. No role is created, edited, deleted, activated
or deactivated; no permission is created or edited; no role→permission mapping and no
member→role assignment is added or removed; no role seed is touched; and no web page changes
behaviour.

**Migration.** `supabase/migrations/20260802090000_mobile_vendor_role_reads.sql`

| Operation | Grant | Requires |
| --- | --- | --- |
| `public.list_vendor_roles()` | `authenticated` | `RBAC_READ` **and** `ORGANIZATION_MEMBERS_READ` |
| `public.get_vendor_role_detail(p_role_id uuid)` | `authenticated` | `RBAC_READ` **and** `ORGANIZATION_MEMBERS_READ` |
| `public.list_vendor_role_permissions(p_role_id uuid)` | `authenticated` | `RBAC_READ` |

All three are `SECURITY DEFINER`, `STABLE`, `language plpgsql`, `set search_path = ''`.
`anon`, `PUBLIC` and `service_role` hold `EXECUTE` on none of them.

---

## 1. The single finding that shapes everything: the role catalogue is GLOBAL

`public.roles`, `public.permissions` and `public.role_permissions` carry **no
`organization_id`** (migration `20260716125559_vendor_admin_rbac.sql`). They are **one
catalogue of role and permission DEFINITIONS shared by every organization on the platform.**
What is per-organization is the **assignment** of a role to a member, which lives in
`public.member_roles` and is keyed by `organization_member_id`.

The deployed catalogue is:

| Role code | Display name | Status | Permissions mapped |
| --- | --- | --- | --- |
| `VENDOR_SUPER_ADMIN` | Vendor Super Admin | ACTIVE | 10 |
| `CLAIM_REVIEWER` | Claim Reviewer | ACTIVE | 0 |
| `FINANCE_ADMIN` | Finance Admin | ACTIVE | 0 |
| `RETAILER_OWNER` | Retailer Owner | ACTIVE | 6 |
| `RETAILER_MANAGER` | Retailer Manager | ACTIVE | 4 |
| `SALES_STAFF` | Sales Staff | ACTIVE | 3 |

Six roles, eighteen permissions, one namespace. Three consequences follow, and each is a
deliberate contract decision rather than an oversight:

1. **"Roles available within the trusted Vendor organization" resolves to the WHOLE
   catalogue.** There is no Vendor-scoped subset to return, and `app/(admin)/roles/page.tsx`
   already shows a Vendor Super Admin all six roles today — including the three Retailer
   roles. `list_vendor_roles()` returns the same six. Filtering to "Vendor roles" would
   require a scope or kind property that does not exist, so it could only be inferred from
   the role **code** — inventing a taxonomy in a mobile read, which would immediately
   disagree with the web.

2. **The role catalogue is not tenant-isolated, and this contract does not pretend it is.**
   Two Vendors read byte-identical role rows, because there is only one set of rows. That is
   the shipped behaviour of `roles_select_rbac_authorized`
   (`20260716131930_vendor_admin_rls_read_policies.sql`), which gates the catalogue
   **wholesale** rather than per row. What **is** tenant-isolated is `assigned_member_count`
   — see § 9.

3. **There is therefore no "another Vendor's role" to leak.** The non-leaking answer the
   detail read must deliver is the one for an id that names no role at all. See § 11.

> This is the point at which the milestone brief's phrasing and the deployed schema diverge,
> and the schema wins. The brief asks that Vendor A not see Vendor B's *organization-scoped*
> roles; the schema has no organization-scoped roles. Narrowing the mobile read to something
> the web does not narrow would have been a silent product change, which this milestone
> explicitly forbids. It is documented here and asserted in pgTAP § B instead.

---

## 2. The web Vendor Roles page, as it works today

**Route** `/roles` → `app/(admin)/roles/page.tsx` (Server Component)
**Data module** `lib/rbac/vendor-rbac-catalog.ts` → `getVendorRbacCatalog()`

### Round trips

| # | Call | Purpose |
| --- | --- | --- |
| 1 | `getVendorSuperAdminAccess()` → `get_vendor_super_admin_context()` | Authorization + `organizationName` |
| 2 | `.from("roles").select("id, name, description, status")` | Whole table |
| 3 | `.from("permissions").select("id, name, description")` | Whole table |
| 4 | `.from("role_permissions").select("role_id, permission_id")` | Whole table |

**Four round trips.** Reads 2–4 are issued concurrently through `Promise.all`, so the wall
clock is 2 RTT, not 4. Every read is a **whole-table scan of a small global catalogue** —
there is no id set to pass to `.in()`, and therefore no N+1: the query count is fixed at
three regardless of how many roles or permissions exist.

### What happens in TypeScript

`assembleRoles()` builds a `Map` of permissions by id, walks every `role_permissions` row to
group permission summaries by `role_id`, then projects each role and sorts both the role list
and each permission list with `localeCompare(…, "en")`. Every id read is used for the join
and then **dropped**.

### What the page renders

**Section 1 — Roles.** One card per role: `name`, a `StatusBadge` for the stored `status`,
`description` when non-null, and the mapped permissions as `name` over `description`. A role
with no mappings renders "No permissions assigned".

**Section 2 — Permissions catalogue.** Every permission on record, `name` over
`description` — including permissions not mapped to any role.

### Failure and empty handling

Authorization failure → `unauthenticated` → `/login`, or `unauthorized` → `/access-denied`.
A **data** failure degrades **that section only** to `null`, rendered as "Roles unavailable"
/ "Permissions unavailable" — deliberately distinct from `[]`, which renders "No roles yet".
The two failure kinds never mix: a query failure is never a denial.

### The gap for mobile

- **No ids at all.** Both lists are keyed by **array index** (`key={index}`), with an
  explicit comment saying so. A mobile list can key nothing, deduplicate nothing, and
  navigate nowhere from that shape. Same defect as `docs/mobile-backend-contract.md` § 6.3.
- **The join is business shape, not presentation.** Reimplementing it in Dart would be a
  second definition of "which permissions does this role grant".
- **Three whole-table transfers** to render a per-role permission list, with the grouping
  done client-side.

---

## 3. The web Vendor Role detail page, as it works today

**There is none.** `app/(admin)/roles/` contains exactly `page.tsx` and `loading.tsx`. There
is no `[roleId]/page.tsx`, no role-detail data module, and no navigation into a single role.

**There is also no role write surface anywhere in the repository** — no create, edit, delete,
activate, deactivate, duplicate, template, or permission-assignment page; no Server Action;
no RPC; and no `INSERT`/`UPDATE`/`DELETE` policy on `roles`, `permissions`, `role_permissions`
or `member_roles` for any browser role. `authenticated` holds `SELECT` and nothing else on
all four tables. **The entire Roles surface is read-only in the shipped product.**

So the detail read below has no web assembly to reproduce. It is *specified* as the list row
narrowed to one role, and nothing more.

---

## 4. Answers to the audit questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | What does the Roles page display? | Per role: name, stored status, description, and its permissions as name + description. Plus a second section listing the whole permission catalogue. |
| 2 | Is there a role-detail page? | **No.** `app/(admin)/roles/` has only `page.tsx` and `loading.tsx`. |
| 3 | Which identifier opens a role? | **None today** — nothing opens a role. The web drops every id and keys by array index. The new contract uses `roles.id`. |
| 4 | Are roles global, org-scoped, Vendor-scoped or mixed? | **Global.** No `organization_id` on `roles`, `permissions` or `role_permissions`. |
| 5 | Can a role belong to one organization? | **No.** Only an *assignment* belongs to an organization, via `member_roles → organization_members`. |
| 6 | Are system roles stored differently from custom roles? | **No.** There is no kind/`is_system`/`is_custom` column — and no custom roles, because nothing in this product can create one. |
| 7 | Which role statuses exist? | `ACTIVE`, `INACTIVE` — the only two `roles_status_allowed` permits. |
| 8 | Which permission statuses exist? | **None.** `public.permissions` has no `status` column. |
| 9 | Which role fields does the web show? | `name`, `status`, `description`. Not `code`, `id`, `created_at`, `updated_at`. |
| 10 | Which permission fields does the web show? | `name`, `description`. Not `code`, `id`, `module`. |
| 11 | Codes, names, descriptions, modules, actions, or counts? | **Names and descriptions only.** No codes, no modules, no actions, no counts. |
| 12 | Does the web group permissions by module? | **No.** Flat, sorted by name. |
| 13 | How does it decide a permission is assigned? | A row in `role_permissions`, joined in TypeScript. |
| 14 | How does it count members per role? | **It does not.** No per-role member count exists anywhere in the web. (The dashboard counts *active roles* and *all permissions* globally — different questions.) |
| 15 | Are inactive role definitions hidden, shown or marked? | **Shown and marked**, deliberately: "a catalogue that hid INACTIVE definitions would misrepresent what is stored". |
| 16 | Are inactive permission definitions hidden, shown or marked? | Not applicable — permissions have no status. An inactive assigned permission is **unrepresentable**, not merely unseeded. See § 8.1. |
| 17 | Are roles with no permissions permitted? | **Yes.** `CLAIM_REVIEWER` and `FINANCE_ADMIN` are seeded exactly that way, and the page renders "No permissions assigned". |
| 18 | Are users with multiple roles counted once per role? | No count exists in the web. The new count is **once per role**, set-wise — see § 9. |
| 19 | Can one role be assigned across multiple organizations? | **Yes** — the same global definition is assignable in any organization. `VENDOR_SUPER_ADMIN` is held in every Vendor. |
| 20 | Round trips for the role list? | **4** (1 authorization + 3 whole-table reads), of which the last 3 are concurrent. |
| 21 | Round trips for role detail? | Not applicable — there is no detail page. |
| 22 | N+1 permission or member queries? | **No.** Fixed at three reads regardless of catalogue size. |
| 23 | Does it fetch every member-role row to count? | **No** — it never reads `member_roles` at all. |
| 24 | Does an existing RPC already return a safe reusable contract? | **No.** `get_vendor_super_admin_context()` returns authorization context only; nothing returns role or permission rows. |
| 25 | Are direct RLS table reads suitable for Flutter? | Partly. The policies are correct and would admit the reads — but the *assembly* would be duplicated in Dart, and no id ever reaches a client from the web shape. |
| 26 | Would direct Flutter reads require client-side joins? | **Yes** — across `roles`, `role_permissions`, `permissions`, and (for any member count) `member_roles` + `organization_members`. Four to five tables. |
| 27 | Are permission codes authorization internals or user-facing? | **Internals.** `lib/rbac/vendor-rbac-catalog.ts` says so in terms: `code` is "deliberately never selected … the internal literals the RLS policies match on". |
| 28 | Does role visibility depend on organization ownership and role status? | **Neither.** Visibility is wholesale: hold `RBAC_READ` or `VENDOR_SUPER_ADMIN` in one of your own organizations and you see the entire catalogue, whatever each role's status. |
| 29 | What happens for a multi-Vendor Super Admin? | `get_vendor_super_admin_context()` orders by organization id and every Vendor RPC takes the first. Role **rows** are unaffected (global); only `assigned_member_count` is computed against the lowest-id Vendor. Preserved verbatim — see § 14. |
| 30 | Which fields are necessary for the first Flutter read-only screen? | `role_id`, `role_name`, `role_description`, `role_status`, `role_created_at`, `permission_count`, `assigned_member_count`; and per permission, `permission_name` + `permission_description`. |

### Gaps the audit proved

1. **No stable id reaches a client**, so a mobile list cannot key a widget or open a role.
2. **The role→permission join is client-side**, and Dart would be a second implementation of
   it.
3. **No role detail contract exists at all** — there is no web page to translate.
4. **No per-role member count exists**, so a Vendor has no way to see which catalogue roles
   are actually live in their own organization. This is the one Vendor-scoped fact a global
   catalogue needs, and it is added here (§ 9).
5. **Three whole-table transfers** where one aggregated statement suffices.

### Were existing reads reusable?

**Partly, and not enough.** The RLS policies are sound and a Flutter client *could* read the
three tables directly. But it would have to reproduce the join, it would receive no member
count without two further tables, and — the deciding factor — the web's own projection emits
no id, so "reuse the web contract" is not an option that exists. A shared SQL contract is the
smaller and safer surface.

---

## 5. What was added

Three functions. Nothing else — no table, column, constraint, index, trigger, RLS policy,
role, permission, mapping, or seed row.

### `public.list_vendor_roles()`

```
returns table (
  role_id               uuid,
  role_name             text,
  role_description      text,        -- nullable; NEVER fabricated
  role_status           text,        -- 'ACTIVE' | 'INACTIVE', stored value
  role_created_at       timestamptz,
  permission_count      integer,     -- never null; 0 for a role with no mappings
  assigned_member_count integer      -- never null; scoped to the CALLER'S Vendor
)
```

Ordered by `role_name`, then `role_id`. **Zero arguments.**

### `public.get_vendor_role_detail(p_role_id uuid)`

**Identical column set**, one row or zero.

`public.roles` has seven columns; five are already here. The sixth is `code`, which this
contract refuses (§ 8), and the seventh is `updated_at`, which the seed migration's upsert
sets to `now()` on every re-run — so it records when the seed last ran, not when the role last
changed. There is genuinely nothing further to show about a role definition, so a wider detail
shape would mean inventing data. One Flutter model deserializes both reads.

**Why it exists at all**, given it returns a row the list already returned: a detail *screen*
needs a refresh that costs one row instead of the catalogue, a deep link openable without the
list, and — decisively — an **authoritative answer to "is this id addressable"**, which is
what disambiguates an empty permission list (§ 11).

### `public.list_vendor_role_permissions(p_role_id uuid)`

```
returns table (
  permission_name        text,
  permission_description text   -- nullable
)
```

Ordered by permission name, then permission id (the id is ordered **on** but never returned —
a tie-break need not be visible to be effective).

---

## 6. Why a companion read rather than a nested array or JSON

A permission is a **pair** (`name`, `description`), so it cannot be carried by a typed
`text[]` — the shape this schema's other aggregate contracts use (`list_vendor_users()
role_names`). That leaves three options:

| Option | Verdict |
| --- | --- |
| `text[]` of permission names, descriptions dropped | Returns **less** than the web page shows today. Rejected. |
| `jsonb` array nested in the detail row | Would make this the one part of the milestone's contract with no column types, no catalogue-level assertion of its shape, and nothing to stop a later edit adding a key. |
| **Companion operation with typed columns** | **Chosen.** |

The catalogue is also open-ended in the direction that matters: it has grown with every module
built so far (RBAC and members → retailers → shops → owner invitations → staff → receipts →
products, now 18 permissions), and each future module — campaigns, claims, coins, payouts —
seeds more. A role that eventually grants all of them would make the detail row grow without
bound, which is precisely the condition under which nesting is wrong.

**The cost is one extra round trip on a detail screen**, and it is the same trade
`list_vendor_retailer_shops()` (`20260731090000`) already made for shops. The two reads may be
issued concurrently; the detail read is the authoritative one for existence.

**The consistency guarantee:** `permission_count` is computed by joining `role_permissions` to
`permissions`, so it is *by construction* the number of rows `list_vendor_role_permissions()`
returns for the same role. pgTAP asserts this for **every** role in the catalogue, not just a
sample.

---

## 7. Why the selector is the role id

`roles.code` is `UNIQUE` and would address a role just as precisely — and that is exactly why
it is refused. The codes (`VENDOR_SUPER_ADMIN`, `RBAC_READ`, …) are the literals the
migration-5 RLS policies and the migration-4 helpers match on. Accepting one as input would
put authorization vocabulary in a client's hands and invite the client to reason about it. The
uuid is opaque, is what the list already returned, and means nothing anywhere else.

**Neither read accepts** a user id, auth user id, profile id, membership id, Vendor
organization id, tenant id, role code, role name, role status, permission id, permission code,
permission set, module, or organization context. `list_vendor_roles()` accepts nothing at all.

The role id **selects** which already-authorized catalogue row is read; it never decides
**whether** anything may be read. Holding one grants nothing.

---

## 8. Permission representation, and the code decision

**Returned:** `permission_name`, `permission_description`. Exactly the two fields
`app/(admin)/roles/page.tsx` renders, through one shared component used for both the per-role
list and the whole-catalogue section.

**Permission codes are NOT returned.** The milestone rule is that a code may appear only when
the existing product intentionally shows it as a user-facing catalogue value. It does not —
`lib/rbac/vendor-rbac-catalog.ts` states that `code` is "deliberately never selected from
either catalogue table" because the codes are "the internal literals the RLS policies match
on". They are authorization vocabulary, and publishing them would invite a client to reason
about authorization it must never compute.

**Module is NOT returned either**, and this was the one genuinely arguable candidate.
`public.permissions.module` is a real `NOT NULL` column (`RBAC`, `ORGANIZATION_MEMBERS`,
`RETAILERS`, `PRODUCTS`, …) and grouping a long permission list by module would be a better
screen. But: the web neither displays nor groups by it; the stored values are SCREAMING_CASE
internal category labels rather than display strings; and this milestone is additive and
read-only. Returning it would mean shipping a field with no user-facing precedent and no
screen asking for it. **When a Flutter design actually groups permissions, `module` is added
deliberately, with a display mapping — not inferred now.**

**Also not returned:** permission id; the `role_permissions` mapping row (it has no id of its
own — its primary key *is* the pair); `created_at` / `updated_at`; any policy name, function
name, RLS expression or grant text; the caller's own permission calculations; and any
permission not mapped to the selected role. The whole-catalogue permission list that the web
page renders in its second section is **not reachable** through this operation, which answers
only "what does *this* role grant".

### 8.1 Permission status: an inactive assigned permission is **unrepresentable**

This is the question most likely to be asked of this contract, so it is answered from the
schema rather than from the seeds.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Can an INACTIVE permission remain assigned through `role_permissions`? | **No — it cannot exist.** Neither `permissions` nor `role_permissions` has a status column, and no migration adds one. |
| 2 | Does `has_organization_permission()` ignore INACTIVE permissions? | **The question does not arise.** It carries no permission-status predicate, because there is no column. It gates on `r.status = 'ACTIVE'` — the **role's** status. |
| 3 | Does the web Roles page include INACTIVE assigned permissions? | Not applicable. It selects `id, name, description` with no status filter, and there is no status to filter. It **does** render an `INACTIVE` role's full permission list beside its status badge. |
| 4 | Does `list_vendor_role_permissions()` include or exclude them? | Neither — there are none. It returns **every mapping** for the role, matching the web. |
| 5 | Does `permission_count` include or exclude them? | Same: it counts every mapping, and equals the companion's row count for every role. |
| 6 | Can the contract distinguish an inactive assigned permission from an active effective one? | **There is no such distinction to draw.** The distinction that *is* real — effective vs. not — is carried by **`role_status`**, returned by the list and the detail reads. |
| 7 | Would Flutter display an inactive permission as active? | **No inactive permission can be displayed, because none can exist.** The one way a client could mislead is by rendering an `INACTIVE` role's permission list *without* `role_status`; § 16 makes rendering it mandatory, and the migration and pgTAP § K state and prove why. |

| Table | Columns | Status column? |
| --- | --- | --- |
| `public.permissions` | `id`, `code`, `name`, `description`, `module`, `created_at`, `updated_at` | **No** |
| `public.role_permissions` | `role_id`, `permission_id`, `created_at` | **No** |

No migration in this repository ever adds one — `grep` finds exactly one `alter table
public.permissions` in the whole history and it is `enable row level security`. An
`INSERT … (…, status)` against either table is a hard error:

```
ERROR: column "status" of relation "permissions" does not exist
ERROR: column "status" of relation "role_permissions" does not exist
```

So an inactive assigned permission **cannot exist**. It is not merely absent from the current
catalogue; there is nowhere to record it. Returning a `permission_status` would mean returning
a constant, and an `active_permission_count` would be a second name for `permission_count`.

**What CAN make a mapped permission ineffective is the ROLE's status.**
`public.has_organization_permission()` (`20260716131104`) joins
`role_permissions → permissions`, filters on `perm.code`, on the profile / membership /
organization statuses, and on **`r.status = 'ACTIVE'`**. There is no permission-status
predicate in it, because there is no column to predicate on. **An `INACTIVE` role therefore
grants nothing, however many permissions remain mapped to it.**

`list_vendor_role_permissions()` **still lists those mappings**, and that is correct rather
than misleading:

- it answers *"what is mapped to this role"*, which is exactly what an administrator needs
  before retiring a definition further;
- it is what `app/(admin)/roles/page.tsx` shows today — an `INACTIVE` role's full permission
  list beside its status badge;
- filtering them out would make a retired role look permission-less, hide the very state the
  screen exists to explain, and break the `permission_count` ↔ companion invariant.

**The fact that makes the list truthful is `role_status`**, returned by both
`list_vendor_roles()` and `get_vendor_role_detail()`. A client **must** render the role's
status alongside the permission list — which is one more reason the documented Flutter
sequence (§ 16) calls the detail read.

pgTAP proves the whole chain: § B asserts both tables' exact column sets and that the helper
carries no permission-status predicate but does gate on `r.status`; § K flips a single role
between `ACTIVE` and `INACTIVE` and watches the *same* member's *same* mapped permission
become effective and ineffective, while the contract keeps listing and counting it and
`role_status` keeps reporting the truth.

---

## 9. `assigned_member_count` — semantics

**What it is.** The number of memberships **of the calling Vendor Super Admin's own Vendor
organization** that hold this role.

```sql
select count(*)
from public.member_roles mr
join public.organization_members m on m.id = mr.organization_member_id
where mr.role_id = r.id
  and m.organization_id = v_vendor     -- derived from auth.uid(), never a parameter
```

**Why it is included, given the web shows no such number.** It is the **only tenant-scoped
value in this contract**, and the only reason a global catalogue means anything to one Vendor:
without it, every Vendor sees six identical rows and learns nothing about their own
organization. It also discloses **no new information** — an authorized caller can already
derive it from `list_vendor_users()` (`20260801090000`), which returns `role_names` for every
member of the Vendor. Precedent exists in the sibling milestone: `active_shop_count` in
`list_vendor_retailers()` is likewise a field "which the web has no column for but a mobile
summary line does".

**Exact semantics, and why each was chosen:**

| Rule | Behaviour | Reason |
| --- | --- | --- |
| Scope | Caller's Vendor only | `m.organization_id = v_vendor`. A Retailer role reads **0** for a Vendor — the true answer, not a hidden row. |
| Double counting | Impossible | `member_roles` PK is `(organization_member_id, role_id)`; `organization_members` is unique on `(organization_id, user_id)`. |
| Multi-role member | Counted **once per role** | A person holding three roles contributes 1 to each of three counts, never 3 to one. |
| Multi-organization person | Counted once, in **this** organization | The join is through this Vendor's own memberships. |
| Membership status | **Not filtered** — `INVITED`, `SUSPENDED`, `DEACTIVATED` all count | `lib/members/vendor-organization-members.ts` filters neither, and `list_vendor_users()` lists every lifecycle state. A count that silently excluded a suspended member would contradict the very screen it sits beside. It is an **assignment count**, not a headcount of active staff. |
| Profile status | **Not filtered** | Same reason. `public.profiles` is not read at all — a count needs no profile row. |
| Role status | **Not filtered** | `role_status` is its own column, so a retired definition still held by four people reports **4** — exactly what an administrator needs before retiring it further. |
| Empty | `0`, never `NULL` | `count(*)` over an empty set is 0. |

**One documented disagreement, by design.** For an **INACTIVE** role, this count and
`list_vendor_users().role_names` disagree: the count reports the holders, while the user
directory hides an inactive *definition* from a member's role names. Both are correct for
their own question — one describes the definition, the other describes a live assignment — and
pgTAP § K asserts **both sides**, so neither can be "fixed" without the other being
reconsidered.

**No member personal data is returned by any of the three reads.** Only the count crosses that
boundary — no name, id, status, email or profile field. The member directory is
`list_vendor_users()`, which is where a Vendor goes to learn *who* holds a role.

---

## 10. Authorization and tenant isolation

### The chain

Identity comes from `auth.uid()` alone, through the existing helpers — never restated:

```sql
select ctx.organization_id into v_vendor
from public.get_vendor_super_admin_context() ctx
order by ctx.organization_id
limit 1;
```

`get_vendor_super_admin_context()` (`20260717083515`) evaluates the whole chain: ACTIVE
profile owned by `auth.uid()`, ACTIVE membership, ACTIVE `VENDOR` organization, ACTIVE
`VENDOR_SUPER_ADMIN` role. A signed-out caller, a Retailer Owner, a Retailer Manager, a Sales
Staff member, a caller with no organization, a suspended profile and a deactivated membership
all resolve to **zero rows** here.

### Which permission, and why the requirement is split

The audit question — "is the authority `RBAC_READ`, another permission, or a combination?" —
resolves to: **Vendor Super Admin authority *and* the permission matching each table actually
read.** Each function requires exactly what the migration-5 policy over its tables requires,
because `SECURITY DEFINER` means it runs outside those policies:

| Function | Tables read | Required |
| --- | --- | --- |
| `list_vendor_roles()` | `roles`, `role_permissions`, `permissions`, `member_roles`, `organization_members` | `RBAC_READ` + `ORGANIZATION_MEMBERS_READ` |
| `get_vendor_role_detail()` | same | `RBAC_READ` + `ORGANIZATION_MEMBERS_READ` |
| `list_vendor_role_permissions()` | `role_permissions`, `permissions` only | `RBAC_READ` only |

The companion deliberately does **not** demand `ORGANIZATION_MEMBERS_READ`: it touches no
membership table, so requiring a membership permission would be asking for a privilege it has
no use for. pgTAP § L proves the split is real by removing `ORGANIZATION_MEMBERS_READ` from
`VENDOR_SUPER_ADMIN` and watching the two counting reads fail while the companion keeps
working, then removing `RBAC_READ` and watching all three fail.

`get_my_portal_context()` capabilities are **presentation hints only** and authorize nothing
here; none of the three functions reads them.

### Confirmed denial behaviour (all pgTAP-asserted)

| Caller | Result |
| --- | --- |
| Signed out | `42501` on all three |
| Authenticated, no organization | `42501` |
| Vendor member without `VENDOR_SUPER_ADMIN` (holds `CLAIM_REVIEWER` + `FINANCE_ADMIN`) | `42501` — including for a role she herself holds |
| Vendor member with **no** role at all | `42501` — an absent role is never a default grant |
| Vendor Super Admin whose role lost `RBAC_READ` | `42501` on all three |
| Vendor Super Admin whose role lost `ORGANIZATION_MEMBERS_READ` | `42501` on list + detail; companion still works |
| Retailer Owner / Retailer Manager / Sales Staff | `42501` on all three — including for the role they hold |
| SUSPENDED profile holding `VENDOR_SUPER_ADMIN` | `42501` |
| DEACTIVATED membership holding `VENDOR_SUPER_ADMIN` | `42501` |
| Unknown role id / foreign-table id / null | **zero rows**, no error |
| Inactive (`INACTIVE`) target role | **returned and marked** — a detail screen is where a Vendor goes to understand a retired role |

### Tenant isolation

The role **definitions** are global and are not isolated — see § 1. The **member count** is,
and that is where the boundary lives: `m.organization_id = v_vendor`, compared against the
Vendor derived from `auth.uid()` and never against a parameter. pgTAP asserts it in both
directions — Vendor A reads `Vendor Super Admin = 3`, Vendor B reads the same role row with
`Vendor Super Admin = 1` — and asserts that a person holding memberships in both Vendors moves
neither Vendor's count for the other's role.

---

## 11. Result and error semantics

### `list_vendor_roles()`

| Situation | Result |
| --- | --- |
| Authorized | Ordered rows, one per role definition |
| Authorized, catalogue empty | **Empty set** (reachable only if the role seeds are removed — a caller cannot be authorized without holding `VENDOR_SUPER_ADMIN`, which is itself a row of this catalogue) |
| Unauthorized | `42501 insufficient_privilege`, message `Not authorized to view Vendor roles` |
| Database failure | Exception propagates |

### `get_vendor_role_detail(uuid)`

| Situation | Result |
| --- | --- |
| Authorized, real role | **Exactly one row** |
| Unknown uuid | **Zero rows** |
| Id belonging to another table (organization, membership, …) | **Zero rows** — identical |
| `null` | **Zero rows** — identical |
| Inactive role | One row, `role_status = 'INACTIVE'` |
| Unauthorized | `42501`, same generic message |

### `list_vendor_role_permissions(uuid)`

| Situation | Result |
| --- | --- |
| Authorized role with permissions | Ordered rows |
| Authorized role with **no** permissions | **Empty list** |
| Unknown / foreign-table / `null` id | **Empty list** — identical to the line above |
| Unauthorized | `42501`, same generic message |

**The ambiguity is deliberate and in the safe direction.** "This role grants nothing" and
"this is not a role" are the same answer here; the **detail read** is what disambiguates, which
is one of the three reasons it exists. A client opens a role by calling both.

**The denial message is byte-identical across all three functions** and names no table,
column, policy, Vendor, role or permission: one refusal for "not signed in", "not a Vendor
Super Admin", and "your role no longer holds the permission" alike.

### Ordering (exact)

| List | Order |
| --- | --- |
| Roles | `role_name` ASC, then `role_id` ASC |
| Permissions | `permission_name` ASC, then `permissions.id` ASC (id not returned) |
| Permission groups | **None** — permissions are a flat list, matching the web |

Both are **deterministic and total**: two roles or two permissions sharing a display name
cannot swap places between requests. The name comparison uses the database collation rather
than the web's `localeCompare(…, "en")`; the two agree on every seeded name, and the web is
unchanged either way.

---

## 12. Status and nullability rules

| Field | Rule |
| --- | --- |
| `role_status` | The **stored** value, `ACTIVE` or `INACTIVE`. Never mapped, never defaulted, never derived. pgTAP flips a role's status and watches the output follow. |
| `role_description` | Nullable. A role with no description returns `NULL` — **never a fabricated string**. |
| `role_name` | `NOT NULL` by constraint. Display names only — never the internal code. |
| `role_created_at` | `NOT NULL`. `updated_at` is excluded (§ 5). |
| `permission_count` | Never `NULL`; `0` for a role with no mappings. Never defaulted to "all permissions". |
| `assigned_member_count` | Never `NULL`; `0` for a role nobody in this Vendor holds. |
| `permission_description` | Nullable, returned verbatim. |
| system / custom kind | **Not returned.** No such column exists; it could only be invented from the name or code. |
| `is_editable` | **Not returned.** It would advertise a write path that does not exist. |
| `permission_status` | **Not returned.** Neither `permissions` nor `role_permissions` has a status column, so an inactive assigned permission is unrepresentable and the field would be a constant. Role status is the effectiveness gate — § 8.1. |
| `active_permission_count` | **Not returned.** Same reason: it would always equal `permission_count`. |

---

## 13. Performance

| | Web today | Mobile contract |
| --- | --- | --- |
| Role list | 4 round trips (1 auth + 3 whole-table, last 3 concurrent); whole `permissions` and `role_permissions` tables transferred; join, grouping and both sorts in JS | **1 round trip.** One statement, two scalar aggregates. Authorization resolved **once**, not per row. |
| Role detail | — (no page) | **1 round trip** for the role + **1** for its permissions, issuable concurrently |

**Avoided, by construction:**

- **No N+1**: one statement per operation, whatever the role, permission or member count.
- **No per-role RPC call**, no per-role member-count query, no per-role permission-count query.
- **No duplicated rows**: both counts are *scalar subqueries*, not joins, so they are evaluated
  once per role row and cannot multiply it. `role_permissions` is keyed by
  `(role_id, permission_id)` and `member_roles` by `(organization_member_id, role_id)`, so a
  join *would* have duplicated a role — which is why there is no join, and no `DISTINCT`
  anywhere (a `DISTINCT` would hide a genuine duplication bug rather than prevent one).
- **No client-side join** across `roles`, `role_permissions`, `permissions`, `member_roles` and
  `organization_members`.
- **No membership rows fetched to be counted** — the count is computed in SQL and only the
  integer crosses the wire.
- **Authorization resolved once per function call**, never per result row.

**Expected access path:** a sequential scan of the six-row `public.roles`; per role a
primary-key range scan of `role_permissions` (its PK leads on `role_id`) and an index scan of
`member_roles_role_id_idx`, followed by primary-key probes of `permissions` and
`organization_members`.

**No index is added.** Every predicate is already served by an existing one
(`role_permissions_pkey`, `member_roles_role_id_idx`, and the `permissions` /
`organization_members` primary keys), and a speculative index would be a cost with no measured
cause.

---

## 14. Current limitations

1. **The role catalogue is not tenant-isolated** (§ 1). Every authorized Vendor sees the same
   six roles, including the three Retailer roles. This is the shipped web behaviour, preserved
   deliberately. Making roles Vendor-scoped is a schema change and a product decision, not a
   mobile read.
2. **Multi-Vendor Super Admins.** A caller who is a Super Admin of two Vendors has
   `assigned_member_count` computed against the **lowest organization id**, deterministically
   and on every request — the same rule `list_vendor_retailers()`, `list_vendor_users()`,
   `list_vendor_products()` and the web itself already follow. Reproduced verbatim rather than
   "fixed": changing it would change which organization an existing Vendor's numbers describe
   as a side effect of a mobile read. There is no Vendor switcher in the shipped product.
   Role **rows** are unaffected, since the catalogue is global.
3. **No permission `module` grouping** (§ 8) — deferred until a screen groups by it.
4. **No role writes of any kind.** Creating, editing, deleting, activating, deactivating or
   duplicating a role, assigning or removing a role, and adding or removing a permission are
   all out of scope and have **no backend at all** in this product — not just no mobile
   contract.
5. **The whole-catalogue permission list** that the web page renders as its second section has
   no mobile operation. `list_vendor_role_permissions()` answers only "what does *this* role
   grant". A `list_vendor_permissions()` can be added when a screen needs it.
6. **`permission_count` and `assigned_member_count` are the two additions with no web
   precedent** (§ 9). Both are justified above; neither changes what the web renders.

---

## 15. Web compatibility

**Nothing in the web changed.** `lib/rbac/vendor-rbac-catalog.ts` still performs its own three
table reads and `app/(admin)/roles/page.tsx` renders exactly what it rendered before. The new
functions are additive and have **no caller in this repository**. No existing function was
edited, dropped, renamed or replaced; no RLS policy, table grant, role seed, permission seed,
or role→permission mapping was touched; and `lib/dashboard/vendor-admin-summary.ts` keeps
computing its own role and permission counts. Static guards 34–36 assert each of these.

Migrating `/roles` onto the shared contract is a separate, reviewable change.

---

## 16. Flutter integration sequence

**Roles list screen**

1. `rpc('list_vendor_roles')`.
2. `42501` → show the standard "not authorized" screen; **do not** retry, and do not infer
   anything from `get_my_portal_context()` capabilities, which are hints only.
3. `[]` → "no role definitions on record" (distinct from a failure, which is an exception).
4. Rows → render `role_name`, a status chip from `role_status`, `role_description` when
   non-null, and a summary line from `permission_count` and `assigned_member_count`. Key the
   list by `role_id`.

**Role detail screen**

1. `rpc('get_vendor_role_detail', {'p_role_id': roleId})` **and**
   `rpc('list_vendor_role_permissions', {'p_role_id': roleId})` — issue concurrently.
2. Detail returns **zero rows** → the role is not addressable; show "not found" and pop.
   **This is the authoritative check** — an empty permission list alone is ambiguous.
3. Detail returns one row → render the same fields as the list; render the permission rows as
   `permission_name` over `permission_description`, in the order received (already sorted —
   do not re-sort).
   **Always render `role_status` alongside the permission list.** The list reports what is
   *mapped* to the role; an `INACTIVE` role grants none of it (§ 8.1). Never present a
   permission list without the role's status, and never compute effectiveness on the client.
4. An empty permission list with a present detail row → "No permissions assigned", exactly as
   the web renders it.

**Never** send a role code, permission code, organization id, tenant id, or any identity value
to these operations. There is no parameter for one.

---

## 17. Tests

| Suite | File | Assertions |
| --- | --- | --- |
| pgTAP (behavioural) | `supabase/tests/database/vendor_role_reads_test.sql` | **164** |
| Static contract guards | `lib/rbac/vendor-role-reads-contract.test.ts` | **36 tests** |

**pgTAP sections:** A signature / security attributes / privileges / RLS-still-enabled ·
B the schema facts the contract rests on (no `organization_id`, no permission `status`, no
role kind, the exact `roles` column set) · C signed-out denials · D authorized listing and
stable ordering · E every unauthorized caller · F field accuracy and nothing fabricated ·
G `permission_count` semantics and the count↔companion invariant across every role ·
H `assigned_member_count` semantics and tenant isolation in both directions · I detail, and
the three indistinguishable non-answers · J the permission companion · K inactive-definition
semantics and the documented disagreement with `list_vendor_users()` · L the split permission
requirement, proved by removing seeded mappings.

Every fixture is deterministic, the whole suite runs in one transaction, and it rolls back.

---

## 18. Next Flutter milestone

Build the read-only Flutter **Vendor Roles list and detail** screens against these three
operations. Do not implement any role write, do not duplicate the join, and do not compute
authorization on the client.

After that, the remaining Vendor reads without a mobile contract are the **dashboard summary**
(`get_vendor_admin_dashboard_summary()`) and the **audit log feed**
(`list_vendor_audit_logs(p_limit, p_before)`), neither of which is started.
