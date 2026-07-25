# Mobile Vendor User Reads — Audit and Contract

**Milestone:** mobile-safe Vendor User list and Vendor User detail backend reads
**Branch:** `feature/mobile-vendor-user-reads`
**Migration:** `supabase/migrations/20260801090000_mobile_vendor_user_reads.sql`
**Covers:** mobile item **V-02** (Organization members directory), plus the user-detail
screen that has no web equivalent

This document records what the web does today, the gaps that justified new database
operations, and the exact contract those operations now offer. It supplements
`docs/mobile-backend-contract.md`; it does not replace it.

> **Scope.** This milestone delivers Vendor **user reads** only. Inviting, creating,
> editing, activating, deactivating and deleting users, assigning or removing roles,
> password and authentication management, Vendor Roles mobile reads, Vendor Products,
> dashboard metrics, Retailer users, Retailer staff management, Sales Staff features,
> campaigns, claims, coins, payouts and reports are **not** implemented and are not
> described as implemented anywhere below.

---

## 1. The web Vendor Users **list**, as it works today

`lib/members/vendor-organization-members.ts` → `getVendorOrganizationMembers()`, rendered by
`app/(admin)/users/page.tsx`.

| Step | Call | Notes |
| --- | --- | --- |
| 0 | `supabase.auth.getClaims()` | Verifies the JWT signature; yields `sub` |
| 0 | `public.get_vendor_super_admin_context()` | One RPC; resolves the Vendor. Request-memoized by React `cache()`, so a page that calls it twice pays once |
| 1 | `from("organization_members").select("id, user_id, status").eq("organization_id", …)` | Unfiltered by status |
| 2 | `from("profiles").select("id, first_name, last_name, status").in("id", profileIds)` | Concurrent with step 3 |
| 3 | `from("member_roles").select("organization_member_id, role_id").in("organization_member_id", membershipIds)` | Concurrent with step 2 |
| 4 | `from("roles").select("id, name").in("id", roleIds).eq("status","ACTIVE")` | Skipped entirely when no role assignment exists |
| 5 | JavaScript | Builds a `Map` of profiles, a `Map` of role names, a `Map` of role names per membership; drops **every** id; sorts by display name with `localeCompare(…, "en")` and sorts each role array the same way |

**Round trips: five** (one authorization RPC + four table reads), fixed regardless of member
count. It is not N+1 in *queries* and it does not transfer rows it merely counts — this list
is materially healthier than the Retailer directory was before the previous milestone.

**Row volume is proportional to the answer**, not quadratic: one row per membership, one per
profile, one per role assignment, one per distinct role definition.

**What it displays.** Four columns and nothing else: display name, membership status, profile
status, role names (or the literal "No active role"). Every internal id — membership,
profile, role — is used to join on the server and then **dropped**, so no UUID reaches the
RSC payload at all. The page keys its rows by array index for exactly that reason.

**Failure semantics.** Authorization failure → `unauthenticated` / `unauthorized` for the
whole directory. Any data failure → `members: null`, still `authorized` — deliberately never
coerced to `[]`, because "could not load" and "has none" are opposite claims.

---

## 2. The web Vendor User **detail**, as it works today

**It does not exist.** `app/(admin)/users/` contains `page.tsx` and `loading.tsx` and
nothing else — no `[…]/page.tsx` route, no detail data module, no Server Action, and no link
out of the list. `components/admin/nav-items.tsx` points at `/users` and stops there.

This is the single most consequential audit finding, and it shapes the whole contract:

* There is **no existing detail assembly to reproduce**, so the detail read is not a
  translation of web behaviour. It is specified from first principles as *the list row plus
  the one membership timestamp a single-user screen has room for*.
* There is **no existing detail address space**, so nothing constrains the selector except
  what is safest. The membership id is chosen for the reasons in § 6.
* There is **nothing on web that could disagree with it**, so the risk of the two clients
  drifting is limited to the list, where the contract deliberately mirrors the web exactly.

---

## 3. Invitations: there are none for Vendor users

The audit brief asks whether the Vendor Users experience includes pending invitations, how
they are addressed, and how a duplicate email between an invitation and an accepted
membership is resolved. The answer to all of it is that **the situation does not arise**,
and the reason is structural rather than a product choice:

| Table | Introduced | Scope |
| --- | --- | --- |
| `public.retailer_invitations` | `20260720092755` | Trigger `retailer_invitations_assert_organization_types` asserts `vendor_organization_id` is a **VENDOR** and `retailer_organization_id` is a **RETAILER**. The membership it finalizes is created in the **Retailer** organization |
| `public.retailer_staff_invitations` | `20260723090000` | Carries **no** `vendor_organization_id` at all; asserted RETAILER-only. Its membership is created in the **Retailer** organization |
| `public.retailer_invitation_shop_assignments` | `20260723090000` | Shop scoping for the above; not an invitation of a person |

**Nothing in this schema invites a user into a VENDOR organization.** Vendor users are
created by trusted server-side code assigning a membership and a role directly; there is no
Vendor invitation flow, no Vendor invitation token, and no Vendor invitation lifecycle.

So the "invited" or "pending" state of a Vendor user is not an invitation row — it is
ordinary column data on rows this contract already returns:

* `public.organization_members.status = 'INVITED'`
* `public.profiles.status = 'INVITED'`

Consequently this milestone:

* does **not** build a combined typed list — a `row_kind` discriminator would be a field with
  exactly one possible value, which is a promise about a table that does not exist;
* does **not** add a companion invitation-detail operation;
* has **no** second id address space to keep apart from the membership id;
* has **no** duplicate-email reconciliation rule to define, because an invitation and an
  accepted membership cannot both exist for one Vendor address;
* has **no** token, token hash, or delivery secret that could leak, because no such row
  exists to read.

Two guards keep that honest rather than assumed. The pgTAP suite asserts the exact set of
invitation tables in the schema, so the day a Vendor user invitation table is added, this
suite fails and the contract is revisited deliberately. The static suite forbids either
function from so much as naming an invitation table.

---

## 4. Answers to the audit questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | What does the current Vendor Users page display? | Display name, membership status, profile status, role names. No email, no ids, no timestamps (§ 1) |
| 2 | Only accepted members, or also pending invitations? | Only memberships — but **unfiltered by status**, so an `INVITED` membership is already listed. There are no Vendor invitations (§ 3) |
| 3 | Separate lists or one combined list? | One list. There is nothing to combine |
| 4 | Which identifier does the web use to open a user? | **None.** There is no user-detail route (§ 2), and the list deliberately carries no id at all |
| 5 | Which identifier is safest for a mobile detail selector? | `public.organization_members.id`. A membership names one person **in one organization**, so tenant scoping is a predicate on the same row (§ 6) |
| 6 | How does the web resolve the current Vendor organization? | `public.get_vendor_super_admin_context()`, first row by `organization_id`, via `getVendorSuperAdminAccess()` |
| 7 | How does it verify Vendor Super Admin authorization? | The same RPC — ACTIVE profile owned by `auth.uid()`, ACTIVE membership, ACTIVE VENDOR organization, ACTIVE `VENDOR_SUPER_ADMIN` role — plus the migration-5 RLS policies on every table it then reads |
| 8 | How many round trips does the list require? | **Five** (1 RPC + 4 table reads), fixed |
| 9 | How many round trips does detail require? | **N/A** — there is no detail screen |
| 10 | Does the web perform N+1 role queries? | **No.** One `member_roles` read keyed by all membership ids, one `roles` read keyed by all role ids |
| 11 | Does it fetch permission rows to display role names? | **No.** `public.permissions` and `public.role_permissions` are never read by this path |
| 12 | How are multiple assigned roles represented? | `member_roles` is keyed by `(organization_member_id, role_id)`, so a membership may hold several. The web groups them into a `string[]` per member and joins with ", " |
| 13 | How are inactive profiles and memberships treated? | **Shown, never hidden.** Both statuses are returned per row and neither is filtered |
| 14 | How are pending / expired / accepted / revoked / cancelled invitations derived? | They are not — there are no Vendor invitations (§ 3). The only lifecycle vocabulary is the four-value `status` check on `profiles` and `organization_members`: `INVITED`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED` |
| 15 | Can one email appear as both an invitation and a membership? | Not for a Vendor user. `organization_members_unique_membership` also makes two memberships of one person in one organization impossible |
| 16 | How does the web prevent duplicate rows? | It builds `Map`s keyed by id and iterates memberships once. The new contract does it with a correlated aggregate rather than a join — see § 8 |
| 17 | Which profile fields are already visible to the Vendor? | `first_name`, `last_name` (composed into one display name) and `status`. **Not** `mobile_number`, and **not** email — which lives in `auth.users` and is never queried by this path |
| 18 | Which personal fields does the first Flutter Users experience need? | The same ones. Email is **excluded** from this milestone precisely because the web does not show it; widening what a Vendor may see about a person is a product decision, not a mobile-parity decision (§ 12) |
| 19 | Does an existing RPC already provide a safe reusable contract? | **No.** `get_vendor_super_admin_context()` returns only the caller's own row; `list_retailer_staff_members()` is a Retailer roster with a different permission, a different tenant resolver and a one-row-per-role shape. Nothing returns Vendor organization users |
| 20 | Are there two address spaces for members and invitations? | No — there is one, because there are no invitations (§ 3) |
| 21 | Does user detail expose authorization internals mobile should not receive? | There is no detail today. The new one exposes none: role **names** only, no codes, no ids, no permission rows |
| 22 | Is there ambiguity when a profile belongs to more than one organization? | Not in the result. Both reads scope by `organization_members.organization_id`, so a person in several organizations contributes exactly the one membership belonging to the caller's Vendor. The ambiguity that *does* remain is about the **caller** — see § 7 |

### Gaps the audit proved

1. **No RPC returns the Vendor's user list.** Flutter would have to reimplement a four-table
   join, the `ACTIVE`-role filter, the role grouping and the tenant scoping in Dart — a
   second place for each to be got wrong.
2. **No user detail exists at all**, in any client, at any layer.
3. **The web list carries no identifier**, so there is nothing for a mobile list to key a
   widget by, deduplicate on, or navigate with. (The same defect
   `mobile-backend-contract.md` § 6.3 records for `list_retailer_owner_portal_shops()`.)
4. **The role grouping is client-side.** Whether an `INACTIVE` role definition counts as a
   live role is currently a decision made in TypeScript, and a second client would be free
   to decide differently.

---

## 5. What was added

One migration, `20260801090000_mobile_vendor_user_reads.sql`. It **creates two functions and
changes nothing that already exists** — no table, column, constraint, index, trigger, RLS
policy, role, permission, or permission mapping; no existing function is edited, dropped, or
replaced; no table privilege is granted to any browser role.

| Function | Grant | Purpose |
| --- | --- | --- |
| `public.list_vendor_users()` | `authenticated` | The Vendor user directory |
| `public.get_vendor_user_detail(uuid)` | `authenticated` | One user of that Vendor, in full |

Both are `SECURITY DEFINER`, `STABLE`, `language plpgsql`, `set search_path = ''`, and fully
schema-qualified throughout. Neither uses dynamic SQL. `service_role` is granted neither:
they derive their authority from `auth.uid()`, which a service-role connection does not
have, so granting it would produce a function that can only ever refuse.

> **Naming.** `mobile-backend-contract.md` § V-02 previously recommended the name
> `public.list_vendor_organization_members()`. The functions ship as `list_vendor_users()` /
> `get_vendor_user_detail()` so that the pair reads as one feature and matches the Vendor
> Users surface the Flutter milestone is named after. The recommendation is superseded, not
> duplicated: there is exactly one Vendor user list operation in the schema.

### Why there is no separate internal derivation function

Unlike the Retailer milestone, nothing here needs one. The Retailer reads shared a five-state
owner-status precedence that would have been two definitions free to drift. Vendor user state
is two ordinary status columns and one role aggregate; the aggregate appears in both
functions, byte-identical, and the pgTAP suite asserts the two agree on the same fixture
rather than trusting the copy.

---

## 6. Why the selector is the membership id

`get_vendor_user_detail()` takes exactly one argument: `p_membership_id uuid`, a
`public.organization_members.id`.

**A membership row is the tenant boundary itself.** It names one person *in one
organization*, so scoping it to the caller's Vendor is a predicate on the same row —
`m.organization_id = v_vendor` — evaluated in the same `WHERE` clause as the selector. A
foreign membership id therefore matches nothing; it is not filtered afterwards, it is never
reached.

**A profile id is not.** One profile may hold memberships in several organizations, so a
profile id names a person *globally*. Accepting one would mean resolving it to a membership
before it could be authorized, and getting the "which membership?" question wrong would be a
cross-tenant read. Section 8's fixture makes this concrete: one person, `Hal Bee`, holds a
membership in Vendor A **and** in Vendor B, with a different role in each.

**An auth user id is worse still.** `public.profiles.id` *is* the `auth.users` id
(`20260716124419`). It is the subject Supabase Auth mints tokens for. It is neither accepted
as an input nor returned as an output by anything in this milestone, under any column name.

The membership id is also the only identifier either function returns, which closes the
"the web carries no id" gap without opening a second one.

---

## 7. Authorization and tenant isolation

Both functions resolve the caller in exactly two steps, before any data query runs:

```
1. v_vendor := (select organization_id
                from public.get_vendor_super_admin_context()
                order by organization_id limit 1)

2. v_vendor is not null
   and public.has_organization_permission(v_vendor, 'ORGANIZATION_MEMBERS_READ')
   and public.has_organization_permission(v_vendor, 'RBAC_READ')
```

Step 1 is the whole existing chain — ACTIVE profile owned by `auth.uid()`, ACTIVE membership,
ACTIVE **VENDOR** organization, ACTIVE `VENDOR_SUPER_ADMIN` role — and it is **delegated, not
restated**. A signed-out caller, a caller with no organization, a Retailer Owner, a Retailer
Manager, a Sales Staff member, a suspended profile, a suspended or deactivated membership and
a Vendor member without the role all resolve to zero rows here.

Step 2 exists because these functions are `SECURITY DEFINER` and therefore run **outside**
the migration-5 RLS policies that would otherwise gate this data. Those policies require
`ORGANIZATION_MEMBERS_READ` for `profiles` and `organization_members`, and `RBAC_READ` for
`member_roles` and `roles`. Requiring both here is what stops the contract from becoming a
way to read role assignments that RLS would have refused. Both are already mapped to
`VENDOR_SUPER_ADMIN` (`20260716133023`); pgTAP Section K proves the check is load-bearing by
deleting a mapping and watching an otherwise-perfect Super Admin be refused.

**Capabilities from `get_my_portal_context()` authorize nothing here.** They are presentation
hints for routing a Flutter shell. Neither function reads them.

**Fail-closed throughout.** Every branch that cannot prove authorization raises `42501`. No
branch can turn a failure into access.

### Tenant isolation

| Caller | Result |
| --- | --- |
| Signed out | `42501` |
| Authenticated, no organization | `42501` |
| Vendor member without `VENDOR_SUPER_ADMIN` | `42501` |
| Vendor Super Admin with a `SUSPENDED` profile | `42501` |
| Vendor Super Admin with a `DEACTIVATED` membership | `42501` |
| Retailer Owner / Manager / Sales Staff | `42501` |
| Vendor Super Admin, own Vendor's membership id | one row |
| Vendor Super Admin, **another Vendor's** membership id | **zero rows** |
| Vendor Super Admin, a **Retailer** membership id | **zero rows** |
| Vendor Super Admin, unknown id | **zero rows** |
| Vendor Super Admin, `null` | **zero rows** |

### Why a foreign id returns zero rows rather than a refusal

The caller *is* an authorized Vendor Super Admin; they have simply named a membership they may
not read. A distinguishable refusal would confirm that another Vendor's user **exists**, and
by sweeping ids, roughly how many. "Zero rows" is byte-identical for a nonexistent id, another
Vendor's id, a Retailer membership id, and `null` — pgTAP Section H asserts that the SQLSTATE
of a foreign id and of a random uuid are the same value, and that the value is `NULL`.

### Multi-Vendor behaviour — preserved, not changed

`get_vendor_super_admin_context()` returns one row per qualifying VENDOR organization, ordered
by organization id, and every existing Vendor RPC takes the first. A caller who is a Super
Admin of two Vendors therefore sees the lowest-id Vendor's users, deterministically and on
every request. That is the shipped behaviour of `list_vendor_retailers()`,
`list_vendor_products()`, `onboard_vendor_retailer()` and the web itself. It is reproduced
verbatim rather than "fixed": changing it would change which users an existing Vendor sees as
a side effect of a mobile read. It is recorded as a limitation in § 12 instead.

Note the asymmetry, which is the honest state of the product: the ambiguity is about **which
Vendor the caller is acting as**, never about which users belong to that Vendor. Once
`v_vendor` is chosen, the result set is exact.

---

## 8. The list contract

```sql
public.list_vendor_users()
returns table (
  membership_id         uuid,
  display_name          text,
  profile_status        text,
  membership_status     text,
  membership_created_at timestamptz,
  joined_at             timestamptz,
  role_names            text[]
)
```

| Column | Nullability | Meaning |
| --- | --- | --- |
| `membership_id` | never null | `public.organization_members.id`. The selector for the detail read, and the key a Flutter list widget uses |
| `display_name` | never null | `first_name` and `last_name`, each trimmed, joined with one space. Falls back to the literal `Member` only if both were somehow blank — the same fallback and the same literal the web uses. Both columns are `NOT NULL` with non-empty `CHECK`s, so the fallback is a defensive floor, not a reachable branch |
| `profile_status` | never null | One of `INVITED`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED` (`profiles_status_allowed`) |
| `membership_status` | never null | One of `INVITED`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED` (`organization_members_status_allowed`). Independent of `profile_status` |
| `membership_created_at` | never null | When the membership row was created |
| `joined_at` | **nullable** | When the person actually joined. `NULL` for a membership that has not — an `INVITED` row typically. Never fabricated |
| `role_names` | never null; may be **empty** | Display names of every **ACTIVE** role definition assigned through *this* membership, ordered by name then role id |

**Ordering:** `display_name`, then `membership_id`. Deterministic and total — two users
sharing a display name cannot swap places between requests. The name comparison uses the
database collation rather than the web's `localeCompare(…, "en")`; the two agree on ordinary
names, and the web is unchanged either way.

**No status filter.** Every lifecycle state is listed, matching the web exactly. A directory
that hid `SUSPENDED` or `DEACTIVATED` people would misrepresent what is stored, and an
`INVITED` row is precisely how a not-yet-active Vendor user appears.

### Role-array semantics

* One membership may hold several roles (`member_roles` is keyed by
  `(organization_member_id, role_id)`).
* All of them are returned in **one array**, so a multi-role user is **one row**. The roles
  come from a correlated `array_agg`, not a join — a join would emit one row per role and
  duplicate the user. No `DISTINCT` is used or needed; a `DISTINCT` would hide a genuine
  duplication bug rather than prevent one.
* Only **ACTIVE role definitions** appear, mirroring
  `lib/members/vendor-organization-members.ts`. A retired (`INACTIVE`) definition still
  assigned to someone is not advertised as a live role.
* Ordering inside the array is `role name, role id` — stable and total.
* **Role names, never codes.** `VENDOR_SUPER_ADMIN` is authorization vocabulary;
  `Vendor Super Admin` is what a screen renders.
* A user with **no** qualifying role gets an **empty array** — never `NULL`, so no client
  branches on null, and **never a default**. An absent role is not a Vendor Super Admin, and
  the pgTAP suite asserts precisely that. The web renders this same case as "No active
  role".
* Only roles assigned through **this Vendor's** membership appear. A person who is a Finance
  Admin in Vendor A and a Claim Reviewer in Vendor B shows one role in each Vendor's list.

### What the list does not return, and why

| Withheld | Reason |
| --- | --- |
| auth user id | `profiles.id` **is** the `auth.users` id. It is the token subject, it is the selector this contract refuses, and it has no use on a directory screen |
| email | Lives in `auth.users`; the web Vendor Users page neither queries nor displays it. Widening what a Vendor sees about a person is a product decision (§ 12) |
| `mobile_number` | A private profile field the Vendor UI has never shown |
| profile id, organization id, user id | The caller knows which Vendor they are; the profile id is the identifier this contract deliberately does not use |
| role ids, role codes | Names are what a screen renders; codes are internal |
| permission rows, permission codes | Authorization internals are not display data. Neither function reads `public.permissions` or `public.role_permissions` at all — the two permission checks go through a boolean helper |
| role count | Derivable from `role_names`. Two representations of one fact can disagree; one cannot |
| any invitation field, token, hash, secret | There are none for Vendor users (§ 3), and neither function may even name an invitation table |
| password, provider, session, login metadata | `auth.users` is never read by either function |
| `updated_at` | Administration trivia at list level |
| `deactivated_at` | Returned by the **detail** read, where a single-user screen has room and reason for it |
| other organizations' memberships, Retailer staff | Scoped out by `m.organization_id = v_vendor` |

---

## 9. The detail contract

```sql
public.get_vendor_user_detail(p_membership_id uuid)
returns table (
  membership_id         uuid,
  display_name          text,
  profile_status        text,
  membership_status     text,
  membership_created_at timestamptz,
  joined_at             timestamptz,
  deactivated_at        timestamptz,
  role_names            text[]
)
```

**The column set is the list's, plus exactly one: `deactivated_at`.** Every other column is
byte-identical in name, type, meaning, nullability and ordering rule, so one Flutter model
deserializes both and a future addition has to be made to both or to neither. Both the pgTAP
suite and the static suite assert this as a *relationship* between the two column lists, not
just as two literals.

| Extra column | Nullability | Meaning |
| --- | --- | --- |
| `deactivated_at` | **nullable** | When the membership was deactivated. `NULL` for a live membership — never fabricated |

**Result semantics**

| Case | Result |
| --- | --- |
| Authorized caller, own Vendor's membership | exactly one row |
| Authorized caller, another Vendor's membership | zero rows |
| Authorized caller, a Retailer membership | zero rows |
| Authorized caller, unknown id | zero rows |
| Authorized caller, `null` | zero rows |
| Unauthorized caller | `42501`, generic message |
| Operational / database failure | the underlying exception, unchanged |

**No status filter.** A `SUSPENDED`, `DEACTIVATED` or `INVITED` membership is readable here
for the same reason it is listed: the detail screen is where a Vendor goes to *understand* a
state, so refusing to open the rows that need explaining would be backwards.

**Not exposed:** auth user id; email; mobile number; password, provider, session or login
metadata of any kind; role ids or codes; permission rows or codes; the Vendor organization
id; the profile id; any membership in another organization; any invitation field, token or
hash; any receipt, reward, sales or audit data. There is no audit-event feed on this screen —
the web detail screen it would mirror does not exist, and inventing one would exceed the
milestone.

---

## 10. Result and error semantics

| Situation | List | Detail |
| --- | --- | --- |
| Authorized, Vendor has users | rows | — |
| Authorized, membership addressable | — | one row |
| Authorized, membership not addressable | — | **zero rows**, no error |
| Unauthorized (any reason) | `42501` `insufficient_privilege`, message `Not authorized to view Vendor users` | same |
| Operational failure | exception propagates | exception propagates |

**One denial for every unauthorized reason.** "Not signed in", "not a Vendor Super Admin" and
"your role no longer holds `RBAC_READ`" are byte-identical to a client. The message names no
table, column, policy, Vendor or person.

**The empty set, honestly stated.** The contract's answer for a match-nothing query is an
empty set rather than a raise — but note the consequence of the authorization chain: an
authorized caller is **by definition** an ACTIVE member of the Vendor they are listing, so
their own row is always present and the list is never actually empty. A Vendor whose only
user is its administrator returns **exactly one row**. That is the real "no other users"
case, and it is the one the pgTAP suite asserts; a Flutter empty-state should be written
against "one row, and it is me" rather than against zero rows.

---

## 11. Performance

| | Web today | This contract |
| --- | --- | --- |
| Round trips, list | 5 (1 RPC + 4 table reads) | **1** |
| Round trips, detail | n/a (no screen) | **1** |
| Rows on the wire, list | memberships + profiles + role assignments + role definitions | **one per user** |
| Join location | TypeScript `Map`s | SQL |
| Role queries | 2 set-based reads | 1 correlated aggregate, evaluated once per user row |
| Authorization resolutions | 1 (React `cache()`-memoized) | **1 per call**, before the query, never per row |

**Expected query behaviour.** The membership scan is served by
`organization_members_org_status_idx`, whose leading column is `organization_id`. The profile
lookup is a primary-key probe. Each role aggregate is a primary-key range scan of
`member_roles` (its PK leads on `organization_member_id`) followed by primary-key probes of
`roles`. **No index is added by this migration** — every predicate is served by an existing
one, and a speculative index would be a cost with no measured cause.

**What the contract cannot become.** No N+1: one statement per call whatever the user count,
asserted statically. No per-user RPC. No per-user role query. No permission rows fetched to
render a name. No repeated authorization per row: `get_vendor_super_admin_context()` appears
exactly once in each body, and each permission check exactly once, both asserted statically.
No duplicate users from multiple role assignments: the aggregate is correlated, not joined.

---

## 12. Web compatibility

**Visible web behaviour is unchanged.** No page, loader, Server Action, or component was
touched. `getVendorOrganizationMembers()` still performs exactly the five calls described in
§ 1, still under RLS with the caller's own token, and `app/(admin)/users/page.tsx` renders
exactly what it rendered before. A static test asserts both facts directly: that the web
module still reads all four tables itself and does **not** call the new RPCs, and that
`app/(admin)/users/` still contains only `page.tsx` and `loading.tsx`.

No existing function is removed, renamed, re-signed, or re-granted. Invitation flows, role
assignment, membership activation, profile activation, audit logging and every authorization
helper are untouched.

RLS is untouched: `public.profiles`, `public.organization_members`, `public.member_roles` and
`public.roles` all still have row-level security enabled, and the four migration-5 read
policies (`profiles_select_self_or_authorized_members`,
`organization_members_select_self_or_authorized`,
`member_roles_select_self_or_rbac_authorized`, `roles_select_rbac_authorized`) still exist
under the same names. No table grant was widened; `public.retailer_invitations` and
`public.retailer_staff_invitations` remain unreadable by `authenticated`. All of that is
asserted by the pgTAP suite rather than merely claimed here.

The new functions are additive and are, for now, called by nothing in this repository. The
web may adopt them later; that is a separate change with its own review.

---

## 13. Flutter integration sequence

```
1. sign in                                → Supabase Auth
2. get_my_portal_context()                → route to the Vendor shell (presentation hint only)
3. list_vendor_users()                    → the Users screen
      · key each row by membership_id
      · badge membership_status and profile_status SEPARATELY — they are different facts
      · role_names is already sorted; join with ", " and render "No active role" when empty
      · an empty role array is normal; it is NEVER a Super Admin
      · the caller's own row is always present — write the empty state as "no other users"
4. tap a row → get_vendor_user_detail(membership_id)
      · zero rows ⇒ show "not found" and pop; do NOT retry, do NOT report an outage
      · one row   ⇒ render name, both statuses, the role list, joined_at, deactivated_at
```

**Error handling.** `42501` from either read means *not authorized* — send the user to the
access-denied surface; it never means "retry". Zero rows from the detail read means *not
addressable* and must never be reported as an outage. Any other SQLSTATE is an operational
failure and is the only case that should be retried.

**Do not** send a Vendor organization id, user id, profile id, auth user id, email, role, or
permission code to either function. There is no parameter that accepts one, and the absence
is the point.

---

## 14. Current limitations

1. **No email address is returned.** The web Vendor Users page does not show one, so this
   milestone does not introduce one. A Flutter screen therefore cannot let an administrator
   confirm *which* "Sam Ahmed" they are looking at when two share a name. Adding email means
   reading `auth.users` from a `SECURITY DEFINER` function and deciding, as a product
   question, that a Vendor Super Admin may see their organization's addresses — worth doing
   deliberately, in its own change, with the web updated to match.
2. **Multi-Vendor Super Admins see one Vendor.** The lowest-id qualifying Vendor, per the
   shipped rule (§ 7). There is still no Vendor-selection mechanism; adding one would change
   existing behaviour for every Vendor RPC at once, not just these two.
3. **No pagination.** A Vendor with hundreds of users receives all of them in one response.
   Cursor pagination is deferred until a real Vendor is large enough to need it; adding it
   later is additive (new optional parameters, same columns).
4. **No search or filter.** By design for a first read contract — a filter parameter is a
   second thing a client can get wrong, and the list is small enough to filter on device.
5. **There are no Vendor user invitations to show** (§ 3). A Flutter "Invite user" affordance
   has no backend at all, not merely no read contract.
6. **No write operations.** Inviting, editing, activating, deactivating and role assignment
   remain web-only and are out of scope.
7. **Ordering collation differs subtly from the web's.** SQL uses the database collation;
   the web uses `localeCompare(…, "en")`. They agree on ordinary names. Reconciling them
   would mean changing the web, which this milestone must not do.
8. **Nothing consumes these functions yet.** No web page and no Flutter screen calls them in
   this repository; the migration is **not deployed**.

---

## 15. Tests

| Suite | File | Count | Result |
| --- | --- | --- | --- |
| pgTAP (behavioural) | `supabase/tests/database/vendor_user_reads_test.sql` | **106 assertions** | PASS |
| Static contract guards | `lib/members/vendor-user-reads-contract.test.ts` | **34 tests** | PASS |

The pgTAP suite runs inside one transaction and rolls back, so no fixture survives — including
Section K, which temporarily deletes a seeded role→permission mapping to prove the permission
check is load-bearing. It covers: signed-out denial; tenant isolation in both directions;
Retailer Owner, Retailer Manager, Sales Staff and no-organization denials; a Vendor member
holding non-privileged roles; a Vendor member holding no role; inactive caller profile and
inactive caller membership (using the same fixtures that appear as ordinary *listed* rows,
which is what proves the ACTIVE requirements govern who may call rather than who may be
seen); the single-user directory; all four profile and membership lifecycle states; `joined_at`
and `deactivated_at` null behaviour; single-role, multi-role, no-role and inactive-role-
definition cases; that two role assignments produce one row; role-array ordering and the
absence of role codes; that a missing role is never defaulted; stable ordering across repeated
calls; a person with memberships in two organizations appearing once with only this Vendor's
roles; the four indistinguishable zero-row answers; list/detail agreement on name, roles and
timestamps; the exact signature, input arguments, output columns, `SECURITY DEFINER`, empty
`search_path`, `STABLE` volatility and grants of both functions; the absence of every
forbidden field name; the unchanged RLS posture, policy names and table privileges; and the
exact set of invitation tables in the schema.

The static guards supplement pgTAP and do not replace it: they assert what is decidable from
the migration source — forward ordering after every declared dependency, no historical
migration touched, no table/policy/index/trigger/grant-on-table/RLS change, no catalogue
seeding, no client identity or tenant parameter, delegated authorization through both
permission helpers, no reading of `auth.users` or the permission tables, exact grants and
signatures, the exact output contract and its list↔detail relationship, forbidden field
names, correlated aggregation instead of a duplicating join, one authorization resolution per
call, single-statement reads, total ordering, one generic `42501` refusal, the non-raising
null selector, and the untouched web module and route tree.

---

## 16. Next Flutter milestone

Build the Vendor Users list and Vendor User detail screens against the two functions above,
using the sequence in § 13. Nothing else in the Vendor shell is unblocked by this milestone:
Vendor Roles, Vendor Products and dashboard metrics still have **no** mobile contract, and
each needs its own audit before any screen is built against it. Vendor user *writes* —
inviting, editing, role assignment, activation — have no backend contract and, in the case of
invitations, no backend at all.
