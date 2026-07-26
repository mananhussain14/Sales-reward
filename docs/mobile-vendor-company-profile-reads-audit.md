# Mobile Vendor Company & Administrator Profile Reads — Audit

**Milestone:** mobile-safe Vendor company and signed-in administrator profile details,
read-only.
**Branch:** `feature/mobile-vendor-company-profile-reads`
**Backend base:** `main` @ `92ce138`
**Migration added:** `supabase/migrations/20260806090000_mobile_vendor_company_profile_reads.sql`
**Date:** 2026-07-26

**Outcome in one line.** The company half of the screen needs **no new backend at all** —
`public.get_my_portal_context()` already returns the only company field this product has. The
personal half needs **one** new zero-argument read, because the caller's own display name and
own role names are not addressable by any shipped contract. One function was added:
`public.get_my_vendor_profile()`, returning exactly two personal fields.

This is audit outcome **B + C combined**, and architecture option **3** of the five offered:
*PortalContext plus one self-profile-details RPC*. It is explicitly **not** option 2 (no
company-details RPC was justified), **not** option 4 (there is no second company contract), and
**not** option 5 (company and personal data are kept in separate contracts with separate
authorization arguments).

---

## 1. Existing web routes — the complete inventory

Every route in the application was enumerated from `app/`, and every one that could plausibly
show company or profile data was read in full.

| Candidate surface | Route / file | Exists? | Real or placeholder? |
| --- | --- | --- | --- |
| Settings | `/settings` | **No route exists** | **Placeholder.** `components/admin/nav-items.tsx` lists it with `disabled: true`, rendered as non-navigable text so it does not open a 404 |
| Company | `/company` | **No** | — |
| Organization | `/organization` | **No** | — |
| Vendor profile / My profile | `/profile`, `/me` | **No** | — |
| Account | `/account` | **No** | — |
| Account menu (top-right) | `components/admin/admin-header.tsx` | Yes | **Real, but it is not a menu.** There is no dropdown, no popover and no profile link — it is a static identity lockup plus a Sign out button |
| Organization header | `components/admin/admin-header.tsx` | Yes | **Real.** Renders `organizationName` and `userDisplayName` as props |
| General settings / branding / business information / contact information / security information | — | **No** | No such surface exists anywhere in the product |

Vendor Admin routes that **do** exist: `/` (dashboard), `/retailers`, `/retailers/new`,
`/retailers/[relationshipId]` (+ `owner/invite`, `shops/new`), `/products`,
`/products/[productId]`, `/users`, `/roles`, `/audit-logs`. Campaigns, Claims, Coins, Payouts,
Reports and Settings are all `disabled: true` nav placeholders with no route behind them.

**There is no edit form for company or profile data anywhere in this product**, so questions
about "edit forms populated from real values", "which writes populate the fields", and
"validation" have one answer: **none exist**. The only Vendor write surfaces are Retailer
onboarding, shop creation, owner invitations, and product create/update/status/assignment.

---

## 2. What the web actually displays

### 2.1 Company data — one field, in five places

| Surface | Value shown | Source |
| --- | --- | --- |
| `components/admin/admin-header.tsx` | `organizations.name`, plus **initials derived from that name** (`getOrganizationInitials`) | prop from `app/(admin)/layout.tsx` |
| `app/(admin)/users/page.tsx` | "Members of **&lt;name&gt;**" | `getVendorOrganizationMembers().organizationName` |
| `app/(admin)/page.tsx`, `/products`, `/roles`, `/audit-logs` | the name in a page description | the same authorized access result |

That is the **entire** company surface. `organizations.status`, `country_code`,
`default_currency`, `created_at` and `updated_at` are **never displayed for the caller's own
Vendor** by any route, component, loader or server action. `lib/retailers/vendor-retailer-detail.ts`
does select `name, status, country_code, default_currency` — but for a **Retailer** organization
the Vendor administers. That is a different screen about a different tenant and is not evidence
for a Vendor company field.

**No web module reads the caller's own `organizations` row at all.** Verified by grepping every
`.from("organizations")` call site: there are exactly two, in
`lib/retailers/vendor-retailers.ts` and `lib/retailers/vendor-retailer-detail.ts`, both
Retailer-scoped.

### 2.2 Personal data — the caller's name, and the caller's row in a directory

| Surface | Value shown | Source |
| --- | --- | --- |
| `admin-header.tsx` | the signed-in administrator's composed display name | `getVendorSuperAdminAccess().userDisplayName`, built from `get_vendor_super_admin_context().first_name/last_name` |
| `app/(admin)/users/page.tsx` | for **every** member including the caller: display name, membership status badge, profile status badge, comma-joined ACTIVE role names (or "No active role") | `lib/members/vendor-organization-members.ts` |

The caller's **own** membership status, profile status and role names are therefore genuinely
displayed by the shipped product — but only as one row among all members, on a directory page,
and never as "my profile".

### 2.3 Does the web distinguish company from current-user information?

Yes, but only implicitly, and only in the header: the identity lockup stacks the person's name
over the organization's name with different type weights. There is no screen, card, section or
heading anywhere that presents them as two separate read models.

---

## 3. Answers to the audit questions

Numbered to match the milestone brief.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Which Vendor company/profile routes exist? | **None.** See § 1 |
| 2 | Real vs placeholder | Settings is a `disabled: true` nav placeholder. The header is real |
| 3 | Readable without edit mode? | The header values, yes. There is no edit mode anywhere |
| 4 | Edit forms populated from the database? | **None exist** |
| 5 | Organization header values | `organizations.name` + initials derived from it |
| 6 | Account menu values | There is no menu — a static name/organization lockup and a Sign out button |
| 7 | Settings page values | No page |
| 8 | Company/organization page values | No page |
| 9 | Personal profile page values | No page |
| 10 | Company vs current-user distinguished? | Only visually, in the header |
| 11 | Fields from `get_my_portal_context()` | `vendor.organization_id`, `vendor.organization_name`, plus `context_version`, `portal_kind`, and the whole `retailer` block |
| 12 | Fields fetched separately | The caller's name parts, via `get_vendor_super_admin_context()` |
| 13 | Round trips for the header | **One** RPC (`get_vendor_super_admin_context`), memoized per request by React `cache()`. Both header values come from that single row |
| 14 | Sequential or parallel? | Single call; nothing to parallelize |
| 15 | Full rows / raw metadata fetched? | No. The context RPC returns five narrow columns; no metadata column is read anywhere |
| 16 | Does TypeScript assemble across tables? | For the header, **no** — the SQL function does the join. For `/users`, **yes**: four reads joined in JS (already addressed by `list_vendor_users()` in `20260801090000`) |
| 17 | Authoritative table per field | `organizations.name` (company name); `profiles.first_name/last_name` (person); `organization_members.status` (membership); `roles.name` (role) |
| 18 | Stored in columns? | All of the above, yes |
| 19 | Stored in json/jsonb? | **Nothing.** No identity or organization table has a jsonb column. The only `jsonb` in the schema is `audit_logs.metadata` |
| 20 | Metadata whole or whitelisted? | Not applicable — no metadata is involved |
| 21 | Values derived from `auth.users`? | **No.** `profiles.id` **is** the auth user id, so `auth.uid()` addresses the profile row directly. `auth.users` is never queried by any Vendor read |
| 22 | Emails shown? | **No.** No Vendor surface displays an email address |
| 23 | Phone numbers shown? | **No.** `profiles.mobile_number` exists and is never displayed |
| 24 | Addresses shown? | **No.** No address column exists on `organizations` or `profiles` at all |
| 25 | Legal / registration identifier? | **No such column exists** |
| 26 | Tax information? | **No such column exists** |
| 27 | Website? | **No such column exists** |
| 28 | Logo or avatar? | **No such column exists.** Both clients render initials computed from a name |
| 29 | Image paths public/private/signed? | Not applicable. The only bucket in the project is `receipts` (private, zero policies), unrelated to identity |
| 30 | Organization status shown? | **No** — for the caller's own Vendor. It is shown for *Retailer* organizations |
| 31 | Current profile status shown? | Yes, as a badge in the caller's own `/users` row |
| 32 | Membership status shown? | Yes, same place |
| 33 | Caller's role shown? | Yes, same place — as `roles.name` |
| 34 | Permission codes shown? | **No.** No screen in the product renders a permission code |
| 35 | IDs exposed to the browser? | **No.** `getVendorSuperAdminAccess()` keeps `userId`/`organizationId` server-side; `VendorOrganizationMember` deliberately carries no ids ("no UUID crosses into the RSC payload") |
| 36 | Created/updated timestamps shown? | **No.** Not for the company, the profile, or the membership |
| 37 | Values editable on the web? | **No** |
| 38 | Which writes populate the fields? | `organizations`/`profiles`/`organization_members` rows for a Vendor are created out of band (there is no Vendor onboarding or Vendor invitation path in the schema at all) |
| 39 | Blank/null supported? | `organizations.name`, `profiles.first_name`, `profiles.last_name` are all `NOT NULL` with `length(trim(...)) > 0` CHECKs, so blank is impossible. `country_code`/`default_currency`/`mobile_number`/`joined_at` are nullable but unused here |
| 40 | Stable enough for a mobile contract? | The company **name**; the caller's **display name**; the caller's **ACTIVE role names** |
| 41 | Internal, keep hidden | every id, every role/permission code, `organization_type` |
| 42 | Sensitive personal data | email (in `auth.users`), `mobile_number` — neither is returned |
| 43 | Can another Vendor administrator read the caller's personal profile? | **Yes, today, via the directory** — `profiles_select_self_or_authorized_members` and `list_vendor_users()` admit a Vendor Super Admin to every member of their own Vendor. The new function does **not** widen this: it narrows to `auth.uid()` |
| 44 | Can the caller read another member's details? | Yes, through `list_vendor_users()` / `get_vendor_user_detail()`, under `ORGANIZATION_MEMBERS_READ` + `RBAC_READ`. Unchanged |
| 45 | Does the new screen show only the caller? | **Yes**, by construction — `m.user_id = auth.uid()` and no selector exists |
| 46 | Permission gating company information | None beyond membership. `organizations_select_active_members` admits any ACTIVE member of the row's own organization; the name reaches the client through the Vendor Super Admin authorization chain |
| 47 | Permission gating personal profile information | **Ownership**, not a permission. The migration-5 policies admit a caller's own `profiles`, `organization_members` and `member_roles` rows unconditionally. The **role name** is the exception: `roles_select_rbac_authorized` requires `RBAC_READ` **or** the `VENDOR_SUPER_ADMIN` role |
| 48 | Is Vendor Super Admin authority sufficient? | For the RLS policies, yes (they are `OR`s). The new RPC deliberately also requires `RBAC_READ` — narrower, see § 6 |
| 49 | Does the web rely only on route authorization + RLS? | No — better. `app/(admin)/layout.tsx` calls `getVendorSuperAdminAccess()`, and `/users` calls it **again** rather than trusting the layout; RLS then re-decides in SQL |
| 50 | Multi-Vendor ambiguity | Uses the existing **lowest-organization-id** rule (`order by organization_id ... [0]`). Preserved verbatim |
| 51 | Can any current query leak another Vendor's company data? | No. Every organization id is chained off the caller's own membership row, and none is ever a parameter |
| 52 | Inconsistent field definitions in the web? | **One, and it is cosmetic.** The nameless-profile fallback is `"Vendor Admin"` in `lib/auth/vendor-admin-access.ts` and `"Member"` in `lib/members/vendor-organization-members.ts` (and in the shipped SQL reads). Both branches are unreachable — the CHECK constraints forbid empty names. The new RPC matches the SQL literal (`'Member'`); the web is not changed |
| 53 | Does PortalContext provide the organization name and caller display name? | **Organization name: yes.** **Caller display name: no** — the `vendor` block is exactly `{organization_id, organization_name}` |
| 54 | Would another RPC create duplicated sources of truth? | For the **organization name**, yes — which is why the new function does not return it. For the caller's name and roles, no: nothing else returns them addressably |
| 55 | Which exact read gap must Flutter solve? | **Self-identification.** See § 4 |

---

## 4. The exact gap

Three facts, established above:

1. **Company name** → `get_my_portal_context().vendor.organization_name`. Already shipped,
   already consumed by Flutter routing, resolved through the same authorization chain the web
   header uses. **No gap.**
2. **Administrator display name** → not in PortalContext. `get_vendor_super_admin_context()`
   returns `first_name` and `last_name` as **raw parts**, so a Dart client would become the
   third implementation of "trim, drop empties, join with one space" (after
   `lib/auth/vendor-admin-access.ts` and `list_vendor_users()`). **A composition gap, not an
   access gap.**
3. **The caller's own role name** → **not addressable at all.** `list_vendor_users()` returns
   every user's roles but carries **no marker for which row is the caller**. The only way a
   mobile client could render "your role" today is to download the whole Vendor directory and
   guess which row is itself by matching a display name it composed locally. Two colleagues who
   share a name break that, and it puts every colleague's status on the wire to render one field
   about oneself. This is precisely the *"fetching the Vendor user list to identify the caller"*
   anti-pattern the milestone forbids. **A real access gap.**

### 4.1 Alternatives considered and rejected

| Alternative | Verdict |
| --- | --- |
| **No new RPC; compose from PortalContext + `get_vendor_super_admin_context()`** | Rejected. It covers the company name and the name parts but leaves the role unobtainable, and makes Dart re-implement name composition |
| **Return the caller's own `membership_id` so Flutter can call `get_vendor_user_detail()` on itself** | Rejected. That function is the **directory** read — "one of the people I administer". Reusing it as "me" conflates two subjects behind one contract, and it puts a row id in a payload for a navigation flow that does not exist. The brief forbids exactly this: *"Do not return a Vendor user directory row as 'my profile'"* |
| **A `get_vendor_company_detail()` RPC returning status/country/currency/timestamps** | Rejected. **No web surface displays any of them for the caller's own Vendor.** Shipping them would invent a product decision inside a migration and freeze it into a pinned mobile contract |
| **Add the caller's name/role to `get_my_portal_context()`** | Rejected. `jsonb` makes it *technically* additive, but PortalContext is the boot-time routing contract for **both** clients and for all four roles; growing it with Vendor-only profile display data widens what every sign-in transfers and edits a live function. An additive new RPC is strictly safer, which is what the brief prescribes |
| **A combined company + profile RPC** | Rejected. It would duplicate `organization_name`, giving the one company field the product has two sources |

---

## 5. The contract added

```sql
public.get_my_vendor_profile()
returns table (
  administrator_display_name text,
  administrator_role_names   text[]
)
language plpgsql stable security definer set search_path = ''
```

| Property | Value |
| --- | --- |
| Arguments | **zero** |
| Grants | `authenticated` only. `anon` revoked, `PUBLIC` revoked, `service_role` **not granted** |
| Volatility | `STABLE` — cannot write |
| `search_path` | empty, every reference schema-qualified |
| Rows | **exactly one** for an authorized caller; a denial is an exception, never zero rows |
| Nullability | **neither field is nullable** |
| Tables read | `organization_members`, `profiles`, `member_roles`, `roles` |
| Audit row | none — reading one's own name is not a state change |
| Index added | **none.** Every predicate is served by an existing index (§ 10) |

### 5.1 Field definitions

#### `administrator_display_name text` — NOT NULL

| Aspect | Detail |
| --- | --- |
| User-facing meaning | The signed-in administrator's own name |
| Authoritative source | `public.profiles.first_name` + `public.profiles.last_name` |
| Company or personal | **Personal** |
| Tenant predicate | `organization_members.organization_id = <derived Vendor>` |
| Caller predicate | `organization_members.user_id = auth.uid()` |
| Nullability | Never null. Both columns are `NOT NULL` with `length(trim(...)) > 0` CHECKs |
| Status semantics | n/a |
| Formatting responsibility | **The database.** `coalesce(nullif(btrim(btrim(first_name) \|\| ' ' \|\| btrim(last_name)), ''), 'Member')` — byte-identical to `list_vendor_users()`, `get_vendor_user_detail()` and, in behaviour, `lib/auth/vendor-admin-access.ts`. **For any storable profile the result is exactly `trim(first) + one space + trim(last)`**; see § 5.3 for the full shape matrix and the unreachability proof for every other branch |
| Already in PortalContext? | **No** |
| Why Flutter needs it | It is the primary line of the profile screen, and the only alternative is composing it in Dart |
| Does the web display it? | **Yes** — the admin header, and the caller's own `/users` row |
| Changes audited? | No. There is no profile-write path in this product, so there is nothing to audit |
| Deletion can erase it? | Yes. `profiles.id` cascades from `auth.users`; deleting the person removes the row (and their authorization with it) |
| Snapshot or live? | **Live** |

#### `administrator_role_names text[]` — NOT NULL, never empty for an authorized caller

| Aspect | Detail |
| --- | --- |
| User-facing meaning | The role(s) the caller holds in this Vendor, as the product names them |
| Authoritative source | `public.roles.name`, via `public.member_roles` |
| Company or personal | **Personal** (an assignment about the caller) |
| Tenant predicate | reached only through the caller's own membership in the derived Vendor |
| Caller predicate | `member_roles.organization_member_id = <that membership>` |
| Nullability | Never null — coalesced to `'{}'`. For an authorized caller it always contains at least `'Vendor Super Admin'`, because that role is what authorized them |
| Status semantics | **ACTIVE role definitions only.** An `INACTIVE` definition still assigned to someone is not advertised as a live role — the same filter the web applies |
| Formatting responsibility | **The client.** The web joins with `", "` and shows "No active role" when empty; Flutter should do the same. The array order is fixed in SQL (`order by r.name, r.id`) |
| Already in PortalContext? | **No.** PortalContext returns *role codes* only as `portal_kind`, a routing literal — never a display name, and never a list |
| Why Flutter needs it | It is the one genuinely unobtainable field (§ 4) |
| Does the web display it? | **Yes** — the caller's own `/users` row |
| Changes audited? | No. There is **no role-assignment write path anywhere in this product**, web or mobile |
| Deletion can erase it? | Yes. `member_roles` cascades from `organization_members`; `roles` uses `ON DELETE RESTRICT`, so a role in use cannot be deleted |
| Snapshot or live? | **Live** |

### 5.2 Company vs personal boundary

| Domain | Contract | Authorization argument |
| --- | --- | --- |
| **Company** | `get_my_portal_context()` → `vendor.organization_name` | Membership of the organization, resolved through `get_vendor_super_admin_context()`. A company read cannot select another Vendor because the id is never a parameter |
| **Personal** | `get_my_vendor_profile()` | **Ownership** (`auth.uid()`), plus `RBAC_READ` for the role catalogue name. A self read cannot select another profile because no selector exists |

The two are kept in separate contracts precisely because their authorization arguments differ:
one is "which tenant do I belong to", the other is "who am I". They are **composed by the
client**, never chained in SQL — the new function does not call PortalContext, and PortalContext
does not call it.

Both resolve their Vendor through the same `get_vendor_super_admin_context()` with the same
`order by organization_id limit 1`, so the company name and the role list on one screen are
always about the **same** organization. pgTAP asserts this for a caller who administers two
Vendors.

### 5.3 `administrator_display_name` — the full shape matrix, and why the fallback is unreachable

The expression is
`coalesce(nullif(btrim(btrim(first_name) || ' ' || btrim(last_name)), ''), 'Member')`. Every shape
below was **evaluated against the deployed database**, and every one is pinned by pgTAP § I.

| `first_name` | `last_name` | Result | Storable in `public.profiles`? |
| --- | --- | --- | --- |
| `'Ada'` | `'Admin'` | `Ada Admin` | **Yes** — the only ordinary case |
| `'  Pia  '` | `'  Padded  '` | `Pia Padded` | **Yes** — the CHECK tests the *trimmed* length, so padding is legal and is trimmed away |
| `'Ada'` | `''` | `Ada` | **No** — `23514`, `profiles_last_name_not_empty` |
| `''` | `'Admin'` | `Admin` | **No** — `23514`, `profiles_first_name_not_empty` |
| `'   '` | `'  '` | `Member` | **No** — `23514` |
| `''` | `''` | `Member` | **No** — `23514` |
| `null` | anything | `Member` | **No** — `23502`, NOT NULL |
| anything | `null` | `Member` | **No** — `23502`, NOT NULL |

**Verified rejections** (INSERT *and* UPDATE, both asserted): null first name `23502`, null last
name `23502`, empty first name `23514`, empty last name `23514`, whitespace-only pair `23514`, and
an UPDATE of an existing profile to a blank name `23514`.

**Conclusion — audit outcome A: the divergence is provably unreachable.** For *any* profile that
`public.profiles` will accept, `administrator_display_name` is exactly
`trim(first_name) + one space + trim(last_name)`. The single-part outputs and the `'Member'` floor
are therefore both unreachable, which means:

| Source | Nameless floor | Reachable? |
| --- | --- | --- |
| `get_my_vendor_profile()` | `'Member'` | No |
| `list_vendor_users()`, `get_vendor_user_detail()` | `'Member'` | No |
| `lib/auth/vendor-admin-access.ts` (web header) | `"Vendor Admin"` | No |
| Flutter / PortalContext | *no name at all* — PortalContext returns no caller name, so it has no floor to diverge from | n/a |

The new RPC matches the **SQL** convention (`'Member'`) so the database has one answer; the web
header literal is **deliberately not changed**, because that would be a visible web change this
milestone forbids and the difference cannot be observed. Both literals *and* the four constraints
that keep them unreachable are pinned by static test 33, so a future relaxation of the schema turns
this from a documented non-issue into a test failure rather than a silent inconsistency.

Non-ordinary caller states do **not** reach the fallback either — they are refused before any row
is composed: a suspended profile, another Vendor's administrator (no selector exists), and a caller
whose `auth.users` row has been deleted (the profile and membership cascade away, so the chain
resolves to no Vendor) all receive `42501`. All three are asserted in pgTAP §§ C and L.

---

## 6. Authorization

**Gate 1 — the chain.** `get_vendor_super_admin_context()` must yield a Vendor: an ACTIVE
profile owned by `auth.uid()`, an ACTIVE membership, an ACTIVE organization of type `VENDOR`,
and an ACTIVE `VENDOR_SUPER_ADMIN` role.

**Gate 2 — one permission.** `has_organization_permission(<that Vendor>, 'RBAC_READ')`.

`RBAC_READ` is the real, already-seeded code (`20260716133023`, module `RBAC`), already mapped
to `VENDOR_SUPER_ADMIN`. **No permission is invented and none is seeded.** It is required
because the returned role **names** come from `public.roles`, whose policy
(`roles_select_rbac_authorized`) requires exactly that permission of a browser client.

**Why not `ORGANIZATION_MEMBERS_READ`.** This is a self-read, and the migration-5 policies are
explicit that a person's own rows need no permission: `profiles_select_self_or_authorized_members`,
`organization_members_select_self_or_authorized` and `member_roles_select_self_or_rbac_authorized`
all admit the caller's own rows unconditionally. Requiring the directory permission would assert
something untrue — that reading your own name is a directory capability — and would refuse a
caller data RLS grants them by ownership. The requirement is therefore the **union of what the
returned facts need, and no more**. pgTAP asserts that a Super Admin *without*
`ORGANIZATION_MEMBERS_READ` can still read their own profile, and that `AUDIT_LOGS_READ` is
irrelevant.

**Narrower than RLS, deliberately — and now proven, not argued.** The `roles` policy is an `OR`
(`RBAC_READ` **or** the `VENDOR_SUPER_ADMIN` role), so requiring both can only refuse callers the
policies would have admitted, never admit one they would refuse. pgTAP § K asserts this as a direct
comparison rather than a claim: with `RBAC_READ` withdrawn, the same caller is run **through the
real policies as the `authenticated` role** and still reads the roles catalogue (via the role
branch) — while the function refuses them. The function is therefore strictly inside RLS.

The same section supplies the evidence for the `ORGANIZATION_MEMBERS_READ` decision: with **every**
role→permission mapping deleted, the caller still reads their own `profiles` row, their own
`organization_members` rows and their own `member_roles` rows under RLS. Self data is gated by
ownership, so requiring the directory permission would refuse a caller data the policies grant
them — and would state something untrue about what the field is.

It also means this read can **never be more permissive than `list_vendor_users()`**, which requires
`RBAC_READ` too. pgTAP asserts that when `RBAC_READ` is withdrawn, both refuse identically.

### 6.1 Behaviour per caller

| Caller | Result |
| --- | --- |
| Signed out | `42501` (and `anon` has no EXECUTE at all) |
| Authenticated, no organization | `42501` |
| **Vendor Super Admin** | **one row** |
| Vendor member without Super Admin authority | `42501` |
| Vendor Super Admin missing `RBAC_READ` | `42501` |
| Vendor Super Admin missing `ORGANIZATION_MEMBERS_READ` | **one row** — self data is gated by ownership |
| Retailer Owner / Manager / Sales Staff | `42501` |
| INVITED / SUSPENDED / DEACTIVATED profile | `42501` |
| INVITED / SUSPENDED / DEACTIVATED membership | `42501` |
| SUSPENDED / DEACTIVATED organization | `42501` |
| Organization whose type is `RETAILER` | `42501` |
| `VENDOR_SUPER_ADMIN` role definition set `INACTIVE` | `42501` |
| Vendor with null optional fields | Irrelevant — no nullable column is read |
| Vendor with no logo/avatar | Irrelevant — no such column exists |
| Another Vendor's organization / profile / membership | **Unrepresentable.** No selector exists |
| Multi-Vendor Super Admin | one row, for the **lowest-organization-id** Vendor |

Every denial is **one generic `42501`** with an identical message that names no table, column,
policy, permission, organization or person. pgTAP asserts both the SQLSTATE set and the message
set have cardinality **one** across eight different failing callers, so the refusal cannot be
used as an oracle for which gate refused — and cannot reveal whether another organization or
profile exists.

---

## 7. Status semantics

Audited exact allowed values (all from `20260716124419` / `20260716125559` CHECK constraints):

| Column | Allowed values |
| --- | --- |
| `organizations.status` | `ACTIVE`, `SUSPENDED`, `DEACTIVATED` |
| `profiles.status` | `INVITED`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED` |
| `organization_members.status` | `INVITED`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED` |
| `roles.status` | `ACTIVE`, `INACTIVE` |

**No status column is returned, and that is the finding rather than an omission.** An authorized
caller of this function has an ACTIVE profile, an ACTIVE membership and an ACTIVE organization
**by construction**, because those are conditions of `get_vendor_super_admin_context()`. A
returned `administrator_profile_status` could therefore only ever hold the single literal
`'ACTIVE'` — a column whose value is provably constant, which invites a client to build a badge
that can never change.

This follows the installed convention rather than inventing a third answer:
`get_vendor_super_admin_context()` documents *"no status columns: the statuses are CONDITIONS
here, not output"*, and `get_vendor_admin_dashboard_summary()` repeats it.

**How Flutter should present it.** A caller who receives a row **is** an active administrator of
an active Vendor; that is what the screen may state, from the fact of a successful read. A caller
who is not receives `42501` and has no profile screen to render at all. The three statuses are
**never** combined into one "Account status" — they are simply not returned, individually or
together. The `roles.status` value is likewise not returned; it is applied as a filter, so an
`INACTIVE` definition simply does not appear in the array.

pgTAP asserts this claim directly (Section F): it proves that every caller who receives a row has
all three statuses `ACTIVE`, and that a SUSPENDED profile, a DEACTIVATED membership and a
SUSPENDED membership all receive no row.

---

## 8. Null behaviour, and fields deliberately withheld

**Nothing is nullable.** Both output fields are `NOT NULL` in practice and in intent: the name is
composed from two `NOT NULL` CHECK-constrained columns with an unreachable `'Member'` floor (§ 5.3),
and the array is coalesced to `'{}'`. There is therefore **no documented optional field**, and a
client needs no null handling.

**The empty role array is unreachable — proven, not assumed.** The array can only be empty if the
caller's membership holds no ACTIVE role definition; but the role that authorizes them *is* an
ACTIVE `VENDOR_SUPER_ADMIN` assignment on that same membership, so it is always in the array. pgTAP
§ J proves the property rather than observing it: deleting the caller's only role assignment
produces `42501`, **not** a row with `{}`. The `coalesce(…, '{}')` therefore remains as a defensive
floor — it guarantees the column can never be SQL `NULL` even if the aggregate matched nothing —
and Flutter's "No active role" branch is dead code kept only for symmetry with the web directory,
where it *is* reachable for a non-caller member.

**No optional source value can leak SQL `NULL` into a required output.** The two source columns are
`NOT NULL`; `||` propagates null (verified for each position) and the `coalesce` catches it; and the
aggregate's null is caught by its own `coalesce`. Both guards are asserted by the static test and
exercised by pgTAP § I.

### 8.1 Withheld, with the reason

| Withheld | Reason |
| --- | --- |
| `organization_name`, `organization_id` | **Guaranteed by `get_my_portal_context()`.** Duplicating the name would give the one company field the product has two sources; the id would put a tenant identifier in a payload |
| organization status / country / currency / `created_at` / `updated_at` | Real columns, **never displayed** for the caller's own Vendor by any web surface |
| legal name, trading name, registration id, tax id, website, business phone, business email, postal address | **No such column exists in the schema** |
| logo, avatar, image path, signed URL | **No such column exists.** § 11 |
| profile status, membership status, organization status | ACTIVE by construction. § 7 |
| every timestamp (`profiles.created_at`, `organization_members.created_at`, `joined_at`, `deactivated_at`) | No web surface displays one for the caller. "Member since" is a product decision no shipped screen has made |
| auth user id | `profiles.id` **is** the auth user id — the subject Supabase Auth mints tokens for |
| profile id, membership id | No navigation flow addresses this screen. The membership id is the **directory** contract's selector |
| email | Lives in `auth.users`, which this function never reads. No Vendor surface displays one |
| `mobile_number` | A private profile column the Vendor UI has never shown |
| role codes, role ids, permission codes, permission rows, module names | Internal authorization vocabulary. `public.permissions` and `public.role_permissions` are **not read at all** |
| raw metadata, `app_metadata`, `user_metadata`, provider data | `auth.users` is never queried; no jsonb column is read or returned |
| tokens, token hashes, password data, invitation data, sessions, MFA, security logs | Never returned by anything, anywhere. Neither invitation table (both Retailer-scoped) is read |
| `ip_address`, `user_agent` | `audit_logs` is not read |
| billing, subscription, payment, invoice, bank data | No such table exists in this schema |
| any other member's name, status or role | The self predicate is `m.user_id = auth.uid()`. `list_vendor_users()` remains the only read that returns other people |

---

## 9. Tenant isolation, self isolation, and known limitations

**Tenant isolation is structural.** The only organization id in the function is `v_vendor`,
derived from `get_vendor_super_admin_context()`, which chains it off the caller's own membership
row. There is no parameter through which another Vendor could be named, and pgTAP proves Vendor
B's administrator receives no Vendor A person's data.

**Self isolation is structural.** `m.user_id = auth.uid()` is compared against the verified
request claims. pgTAP puts **two** administrators in the same Vendor with different names and
different second roles and proves each receives only their own — and that the *same*
zero-argument call returns a different row per caller. A role the same person holds in another
organization (a Retailer membership) does not appear.

**Row multiplicity cannot inflate.** `organization_members` is UNIQUE on
`(organization_id, user_id)`, the profile join is on a primary key, and the roles are a
correlated aggregate rather than a join. pgTAP proves a caller with two roles, two Vendor
memberships and a Retailer membership still receives exactly one row.

### 9.1 Limitations (documented, not fixed)

1. **Multi-Vendor ambiguity uses the lowest organization id.** A Super Admin of two Vendors sees
   the lowest-id Vendor's roles, deterministically, and PortalContext shows the same Vendor's
   name. This is the shipped behaviour of every Vendor RPC and of the web itself
   (`contextRows[0]`). It is **not** the fail-closed rule the Retailer resolvers use. Changing it
   would change which organization an existing operator sees as a side effect of a mobile read,
   and there is no organization switcher in which anyone could see or change the choice. Recorded
   here rather than redesigned.
2. **A Vendor administrator can still read every colleague's profile** through
   `list_vendor_users()` / `get_vendor_user_detail()`, exactly as the web `/users` page does.
   This milestone neither widens nor narrows that.
3. **The nameless-profile floor differs between the web header (`"Vendor Admin"`) and the SQL
   reads (`"Member"`).** **Resolved as audit outcome A — proven unreachable**, not merely believed
   to be: `public.profiles` rejects null, empty and whitespace-only name parts on both INSERT and
   UPDATE, so no storable profile can reach either floor (§ 5.3, pgTAP § I, static test 33). The new
   function matches the SQL convention; the web literal is deliberately unchanged because changing
   it would be a visible web change and the difference cannot be observed.
4. **No company field beyond the name exists to show.** A richer company screen needs schema
   work and a web surface first, in that order.
5. **The web still assembles `/users` in TypeScript** (four reads). `list_vendor_users()` exists;
   migrating the web onto it remains a separate, deferred change.

---

## 10. Performance

**Current web read pattern for the two displayed values:** one RPC
(`get_vendor_super_admin_context()`), memoized per request by React `cache()` so the `(admin)`
layout and a page that calls it again share one result. Both header values come from that single
row. There is no per-field call, no full-table read, no client-side join and no signed-URL
generation anywhere in this surface.

**New contract:** one round trip. Identity and Vendor are resolved **once**, at the top; the
permission is checked **once**; then a single statement produces the row.

**Access paths — MEASURED, and reported as measured rather than as assumed.**
`EXPLAIN (ANALYZE, BUFFERS)` on a local reset with 5,000 profiles, 5,000 memberships split across
two Vendors and 5,000 role assignments, with the caller's JWT claim set:

| Relation | Measured path |
| --- | --- |
| `organization_members` | `Index Scan using organization_members_user_id_idx` on `(user_id)`, with `organization_id = v_vendor` applied as a **filter** on the single row returned |
| `profiles` | `Index Scan using profiles_pkey` |
| `member_roles` | `Index Only Scan using member_roles_pkey` (leads on `organization_member_id`), Heap Fetches: 1 |
| `roles` | `Seq Scan` of the single-digit catalogue, filtered on `status` |

Total: **10 shared buffers, 0.16 ms execution.** Nested Loop throughout; no sort of any relation,
no hash join, no parallel plan, no sequential scan of any table that grows.

**The membership index chosen is *not* the one the predicate pair suggests, and that is correct.**
One would expect the unique `organization_members_unique_membership (organization_id, user_id)`
key. The planner prefers the single-column `organization_members_user_id_idx` because `auth.uid()`
already selects exactly one row, so leading on `organization_id` would scan a whole tenant to find
it. Both indexes ship in `20260716124419`; this is what was actually chosen, not what was assumed.
The `roles` seq scan is likewise the planner being right — reading six rows through
`roles_status_idx` is worse than reading them directly.

**No index was added.** Every predicate is served by an existing index and the measured cost is a
fraction of a millisecond, so a speculative index would be a write cost paid on every membership
and role change for no read benefit.

The function also cannot be used to enumerate: it returns one row about one person, with no
count, no aggregate over people, and no second membership reference (asserted statically).

---

## 11. Logo / avatar decision

**Excluded, because there is nothing to include.**

1. **No table or column stores an image reference.** `public.organizations` has eight columns
   (`id`, `name`, `organization_type`, `status`, `country_code`, `default_currency`,
   `created_at`, `updated_at`); `public.profiles` has seven (`id`, `first_name`, `last_name`,
   `mobile_number`, `status`, `created_at`, `updated_at`). No `logo`, `logo_path`, `avatar`,
   `avatar_url` or `image` column exists anywhere in the schema.
2. **The only Storage bucket in the project is `receipts`** (`20260726090000`): private, with
   **zero** Storage policies, reachable only by the service role, and unrelated to identity.
3. **RLS/Storage policies:** `storage.objects` and `storage.buckets` have RLS enabled with no
   policies at all, so no browser client can read any object.
4. **Public URL / raw path / signed URL:** none of the three, for any identity image — there is
   no identity image.
5. **Expiry / fallback:** not applicable. Both clients already render **initials** derived from a
   name (`components/ui/avatar.tsx`, `getOrganizationInitials` in `admin-header.tsx`), which is
   the shipped fallback and needs no backend.
6. **Mobile reuse:** Flutter should compute initials from the two values it already has — the
   PortalContext organization name and this function's `administrator_display_name`.

No raw private storage path is returned as a user-facing URL, and **no Edge Function is
introduced for an image the product does not display**.

---

## 12. Expected Flutter loading sequence

```
1. Sign in (supabase.auth)
2. get_my_portal_context()          -> portal_kind == "VENDOR_SUPER_ADMIN"
                                       vendor.organization_name   <-- THE COMPANY NAME
                                       (cache for the session; it is the boot contract)
3. Open the company/profile screen:
   get_my_vendor_profile()          -> administrator_display_name  <-- THE PERSON
                                       administrator_role_names    <-- THEIR ROLE(S)
```

**Composition rules for the screen:**

| Rendered as | Value | Source | Note |
| --- | --- | --- | --- |
| Company section heading / name | `vendor.organization_name` | **PortalContext** — required, not optional | Do **not** look for it in `get_my_vendor_profile()`; it is not there |
| Company avatar | initials derived from that name | client-side | No image exists |
| Administrator name | `administrator_display_name` | the new RPC | Already composed — do not re-join name parts in Dart |
| Administrator avatar | initials derived from that name | client-side | |
| Role | `administrator_role_names.join(", ")` | the new RPC | **Preserve the array order as received** — it is fixed in SQL (`order by r.name, r.id`, i.e. role display name ascending under the database collation, membership-stable). Do not re-sort in Dart, or the mobile order will drift from the web's. Empty array → "No active role" as a defensive branch only: it is **unreachable** for an authorized caller (§ 8, pgTAP § J) |
| Any status badge | — | — | **Do not render one.** A successful read already means "active administrator of an active Vendor"; there is no status field, and none should be inferred into three separate badges |

**Error behaviour:**

| Condition | Client behaviour |
| --- | --- |
| `42501` from `get_my_vendor_profile()` | Not (or no longer) an authorized Vendor administrator → the ordinary access-denied path. Do **not** render a blank profile |
| Transport / operational failure | "Unavailable, retry" — keep the session. This is distinguishable from `42501` |
| `portal_kind != "VENDOR_SUPER_ADMIN"` | Do not open the screen at all |
| PortalContext raises | Unavailable (operational), **not** unauthorized — PortalContext expresses denial as the value `"NONE"`. The two contracts express denial differently **by design**; pgTAP asserts both behaviours. Never collapse one into the other |

---

## 13. Web compatibility

**No visible web behaviour changes.** No route, page, layout, component, label, form,
validation, write, navigation item, profile menu, organization header, storage behaviour,
invitation behaviour or authorization rule was touched. The function is additive and has **no
caller in this repository** — asserted by a static test that walks `lib/`, `app/` and
`components/` for any reference to it.

`lib/auth/vendor-admin-access.ts` keeps `get_vendor_super_admin_context()` as the web's single
source for the header identity; `components/admin/nav-items.tsx` keeps Settings
`disabled: true`; `app/(admin)/users/page.tsx` keeps its four-read TypeScript assembly. Static
tests pin all three.

---

## 14. Tests

| Suite | File | Count | Result |
| --- | --- | --- | --- |
| pgTAP (behavioural) | `supabase/tests/database/vendor_company_profile_reads_test.sql` | **132 assertions** | PASS |
| Static contract guards | `lib/portal/vendor-company-profile-reads-contract.test.ts` | **34 tests** | PASS |

**pgTAP sections:** A — signature, zero arguments, exact output order and types,
forbidden-field-name rules, `SECURITY DEFINER`, `STABLE`, empty `search_path`, grants
(`authenticated` yes; `anon`, `PUBLIC`, `service_role` no), function owner. B — the authorized
row, name composition including whitespace trimming, the ACTIVE-role filter, names-not-codes,
cross-organization role exclusion. C — every denial, including the four organization/role status
mutations, plus proof that both the SQLSTATE **and** the message are identical across eight
failing callers and that the message names nothing. D — self isolation between two administrators
of the same Vendor, tenant isolation across two Vendors, catalogue proof that no overload or
parameter exists, and the lowest-organization-id multi-Vendor rule verified against
PortalContext's own choice. E — `RBAC_READ` required, `ORGANIZATION_MEMBERS_READ` and
`AUDIT_LOGS_READ` deliberately not, refusal parity with `list_vendor_users()`, and byte-identical
agreement with the caller's own directory row. F — the statuses really are conditions.
G — PortalContext non-duplication in both directions. H — nothing was written, including no
audit row. **I** — the full display-name shape matrix (nine cases, including null propagation
through `||`) plus six proofs that every fallback-triggering shape is rejected by the schema on
INSERT and UPDATE, and that all three SQL reads share the `'Member'` literal. **J** — an empty
role array is unreachable (removing the authorizing assignment *denies* rather than emptying the
array) and a duplicate `(membership, role)` assignment is refused by `member_roles_pkey` with the
array unchanged. **K** — the function is **strictly narrower than RLS**: with `RBAC_READ`
withdrawn, the `authenticated` role under the real policies still reads the roles catalogue (the
policy's second branch is the `VENDOR_SUPER_ADMIN` *role*) while the function refuses; and with
**every** role→permission mapping deleted, the caller still reads their own profile, membership and
role-assignment rows — which is the evidence that requiring `ORGANIZATION_MEMBERS_READ` would be
untrue. **L** — a caller whose `auth.users` row is deleted cascades to no profile and is denied,
never handed a fallback name.

---

## 15. Next Flutter milestone

**Backend work for this screen is complete.** The Flutter milestone is:

1. Add a `VendorProfile` entity + repository over `get_my_vendor_profile()` (two fields).
2. Reuse the existing `PortalContext` session entity for the company name — do **not** add a
   second source for it.
3. Build the read-only Vendor company/profile screen: company name + initials, administrator name
   + initials, role line. **No status badges, no timestamps, no image, no edit affordance.**
4. Replace the current Settings placeholder entry with this screen, or add it as an entry from the
   Vendor drawer. Everything else under Settings stays "Coming soon".

**Not next, and not implemented anywhere:** company editing, profile editing, email/password/
phone/address changes, legal or registration changes, logo or avatar upload, image deletion, user
invitations, activation/deactivation, role assignment, permission assignment, organization
switching, billing, API keys, session management, MFA, or notification/localization/theme
preferences. Several of those have **no backend at all** in this product, not merely no mobile
contract.
