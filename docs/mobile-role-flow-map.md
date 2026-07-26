# Mobile Role Flow Map — SalesReward

## Backend source version

| Field | Value |
| --- | --- |
| Repository | `salesreward-admin` (Next.js 16.2.10 + Supabase) |
| Branch | `main` |
| Commit (original audit) | `510331e5fed8293f6af95c339fee8c082b4ea458` |
| Latest migration | `supabase/migrations/20260806090000_mobile_vendor_company_profile_reads.sql` |
| Date of audit | 2026-07-24 |
| Last updated | 2026-07-26 — for `get_my_vendor_profile()` (§ 3.1 V-18) |

Companion documents: [`mobile-backend-contract.md`](./mobile-backend-contract.md) (per-RPC
detail), [`mobile-feature-matrix.md`](./mobile-feature-matrix.md) (readiness and phasing),
[`mobile-architecture-recommendation.md`](./mobile-architecture-recommendation.md) (layering),
[`mobile-ui-design-handoff.md`](./mobile-ui-design-handoff.md) (visual identity).

**Status:** originally an audit and specification. Backend changes have since been made, all
of them purely additive read RPCs — `20260729090000_shared_portal_context.sql`
(`get_my_portal_context()`, resolving **D-1** and D-6 for Flutter), then the mobile Vendor read
migrations `20260731090000` … `20260806090000`. **No RLS policy, no existing RPC, no seed row,
and no application code was changed by any of them**, and no web page changed behaviour.

---

## 0. The architectural rule

This is the constraint every decision below is measured against.

| Layer | Sharing rule |
| --- | --- |
| **Domain entities** | May be shared when they represent the same business data. |
| **Repository contracts** | May be shared when they represent the same business data. |
| **Data sources** | May be shared when they call the same backend contract. |
| **Presentation (widgets, screens)** | **Separate** when role behaviour differs. |
| **Navigation** | **Separate** when role behaviour differs. |
| **BLoCs / state** | **Separate** when role behaviour differs. |

Two absolute rules, stated three separate times in the web source and repeated here
because they are the easiest thing to lose in a port:

> **Flutter must never infer authorization from the visible UI.**
> **The backend remains the final authorization authority.**

The web says it plainly in `components/retailer-portal/retailer-nav-items.tsx`:

> *"NAVIGATION IS NOT AUTHORIZATION. Which items appear is presentation. … Hiding a link
> removes an accident, never a capability."*

Concretely, for Flutter:

- Never store a role string and branch security on it. Store it, if at all, only to pick
  a widget tree.
- Never assume a screen is reachable because its nav entry rendered. Every screen
  re-resolves its own access on open.
- Never convert a `42501` permission denial into a crash or a generic error toast. It is
  a first-class, expected outcome with its own presentation.
- Never treat "zero rows" as "error". Several RPCs return zero rows *as* the denial, and
  at least one (`get_retailer_owner_portal_context()`) returns zero rows to a legitimately
  authorized Manager.

---

## 1. Classification legend

Every feature in § 3–§ 6 carries exactly one class.

| Class | Meaning | Flutter consequence |
| --- | --- | --- |
| **A — Shared domain + shared presentation** | Same business data, and every role that can see it sees it the same way. | One entity, one repository, one data source, one widget. |
| **B — Shared domain, role-specific presentation** | Same entity and same backend contract, but the screen differs by role. | Shared entity + repository + data source. **Separate BLoC and widgets per role.** |
| **C — Completely role-specific** | The capability exists for one role only. | Everything separate, in that role's feature module. |
| **D — Not ready for Flutter** | Blocked on a missing Edge Function, a missing RPC, or a contract defect. | Do not build the screen yet. Listed with its blocker. |
| **E — Requires a product decision** | Buildable, but the right behaviour is not established. | Listed in § 8 with a recommendation. |

---

## 2. Roles, landing, and the authorization source

### 2.1 The four roles

| Role | Organization | Code | Portal |
| --- | --- | --- | --- |
| **Vendor Super Admin** | `VENDOR` | `VENDOR_SUPER_ADMIN` | Vendor Admin |
| **Retailer Owner** | `RETAILER` | `RETAILER_OWNER` | Retailer Portal |
| **Retailer Manager** | `RETAILER` | `RETAILER_MANAGER` | Retailer Portal |
| **Sales Staff** | `RETAILER` | `SALES_STAFF` | Retailer Portal |

### 2.2 Permissions actually held

From `docs/mobile-backend-contract.md` and the migrations:

| Role | Permissions |
| --- | --- |
| Vendor Super Admin | Authorized by **role**, not by permission — `auth.uid()` → ACTIVE profile → ACTIVE membership → ACTIVE `VENDOR` org → ACTIVE `VENDOR_SUPER_ADMIN` role. Plus `RETAILER_OWNERS_INVITE`, `RBAC_READ`, product and audit permissions. |
| Retailer Owner | `RETAILER_PORTAL_READ`, `RETAILER_SHOPS_READ`, `RETAILER_STAFF_READ`, `RETAILER_STAFF_MANAGE`, `RETAILER_STAFF_SHOP_ASSIGN`, `RETAILER_PRODUCTS_READ` |
| Retailer Manager | `RETAILER_PORTAL_READ`, `RETAILER_SHOPS_READ`, `RETAILER_STAFF_READ`, `RETAILER_PRODUCTS_READ` — and **not** `RETAILER_STAFF_MANAGE` or `RETAILER_STAFF_SHOP_ASSIGN` |
| Sales Staff | `RETAILER_PORTAL_READ`, `RECEIPT_SUBMIT` |

**Holding a permission is not the same as passing an operation's gate**, and two cases in
this table prove it. Both were verified against the seed migrations
(`20260722210000`, `20260726090000`, `20260727090000`):

- **Sales Staff hold `RETAILER_PORTAL_READ`** — seeded "so the portal shell renders" — yet
  they are still refused the Overview screen, because
  `get_retailer_owner_portal_context()` resolves through
  `resolve_retailer_owner_organization()`, which hard-filters `r.code = 'RETAILER_OWNER'`.
- **Retailer Managers hold `RETAILER_SHOPS_READ`** yet cannot list shops, because
  `list_retailer_owner_portal_shops()` uses that same owner-only resolver.

They *do* correctly lack `RETAILER_STAFF_READ` and `RETAILER_PRODUCTS_READ`, so the roster
and catalogue refuse them by mapping alone.

The consequence for Flutter is concrete: **never derive a capability from a permission
code.** Derive it from the resolver the operation actually calls — which is exactly what
`get_my_portal_context().retailer.capabilities` does, and why `view_shops` is `false` for a
Manager who holds the permission.

### 2.3 How the landing screen is resolved — `lib/auth/landing-decision.ts`

The web resolves the landing **on the server**, from two authorization statuses, with
**vendor-first precedence**. The function is pure and takes no organization, membership,
role, or permission id — and no caller-supplied destination, so an open redirect is
impossible by construction.

```
vendor == authorized       → /                      (Vendor Admin dashboard)
vendor == unauthenticated  → /login
vendor == unauthorized     → consult the retailer portal resolver:
    owner            → /retailer            (Retailer Owner overview)
    reader           → /retailer/staff      (Retailer Manager roster)
    submitter        → /retailer/receipts   (Sales Staff receipts)
    unavailable      → NO destination — operational failure, not a denial
    unauthenticated  → /login
    unauthorized     → /access-denied
```

A user who legitimately holds both a Vendor and a Retailer role keeps the Vendor landing;
the portal stays reachable directly.

The retailer side is resolved by **probing**, in `lib/staff/portal-access-decision.ts`:

```
owner   == authorized      → owner
owner   == unauthenticated → unauthenticated
roster  == ok              → reader          (probed only if not owner)
roster  == unavailable     → unavailable
roster  == denied → submitter probe:
    ok          → submitter
    unavailable → unavailable
    denied      → unauthorized  (or unavailable, if the owner probe was unavailable)
```

> ✅ **RESOLVED — `public.get_my_portal_context()` now exists** (migration
> `20260729090000_shared_portal_context.sql`). The probe sequence above is what the **web**
> still does; it is no longer what a client *has* to do. Flutter must build against the new
> RPC and must not reproduce the probe at all.
>
> One call returns `portal_kind` (vendor-first, reproducing `selectLanding()`) plus
> independently-resolved `vendor` and `retailer` blocks and seven capability hints. Denial
> is a **value** (`portal_kind: "NONE"`), so a raised exception still means `unavailable`
> and the two stay distinguishable. Full contract: `mobile-backend-contract.md` AUTH-05.
>
> The web migration is deliberately deferred — see D-1 in § 8.

**Classification: B** (shared domain — one identity and one landing decision; role-specific
presentation — four different first screens).

`unavailable` deserves emphasis: it carries **no destination**. An operational failure is
not a place to send someone. The web keeps the just-established session intact and shows a
retry-safe message rather than redirecting. Flutter must do the same and must **not**
collapse it into "access denied" — telling a user they lack access when the database was
merely unreachable is both wrong and alarming.

### 2.4 Authorization source, per role

| Role | Source | Fail mode |
| --- | --- | --- |
| Vendor Super Admin | `get_vendor_super_admin_context()` | **Fail-closed**: a database, RPC, or transport failure returns `unauthorized`, not a distinct error. There is no vendor-`unavailable` state. A transient failure is indistinguishable from "not a Vendor" and falls through to the Retailer check. |
| Retailer Owner | `get_retailer_owner_portal_context()` → `resolve_retailer_owner_organization(...)`, hard-filtered to `r.code = 'RETAILER_OWNER'` | Distinguishes `unauthorized` from `unavailable`. |
| Retailer Manager | `list_retailer_staff_members()` succeeding (the "roster probe") | `42501` → denied. |
| Sales Staff | `list_my_assigned_receipt_shops()` succeeding (the "submitter probe") | `42501` → denied. |

Flutter must re-assert `row.user_id == session.user.id` on the Vendor context, exactly as
the web client does.

---

## 3. Vendor Super Admin

**Default landing:** `/` — the Vendor Admin dashboard.

**Navigation:** a drawer, per `mobile-ui-design-handoff.md` § 4.1 — six active
destinations plus six deliberate "Coming soon" placeholders. The placeholders sketch a
roadmap to an **internal** audience and should be kept; the Retailer portal has none by
design, because advertising unbuilt modules to an external customer sets an expectation
this milestone cannot meet.

| Destination | Route | Active |
| --- | --- | --- |
| Dashboard | `/` | ✅ |
| Retailers | `/retailers` | ✅ |
| Users | `/users` | ✅ |
| Roles | `/roles` | ✅ |
| Products | `/products` | ✅ |
| Audit Logs | `/audit-logs` | ✅ |
| Campaigns · Claims · Coins · Payouts · Reports · Settings | — | ⬜ "Soon" |

The **Settings** placeholder is where the Vendor company & administrator profile screen (V-18)
belongs on mobile. It is the only one of the six whose backend read now exists; the other five
have no backend at all.

### 3.1 Screens and actions

| ID | Feature | RPC(s) | Class | Notes |
| --- | --- | --- | --- | --- |
| V-01 | Dashboard summary counts | `get_vendor_admin_dashboard_summary()` ✅ **shipped** (`20260805090000`) | **C** | Was **D**: **five** round trips per dashboard load (1 auth RPC + 4 parallel counts), each count re-walking the profile → membership → organization → role → permission chain through its own RLS policy. Now **one** call, zero arguments, one statement. The audit confirmed the web dashboard is **fully real** — four database-backed counts, **no mocked, static or zero-placeholder card anywhere**; the three "Quick actions" tiles are plain navigation links carrying no data. Returns exactly one row of four **non-null** `bigint`s; a Vendor with no data gets one row of **zeros**, and zero rows is structurally unreachable (a `select` with no from-clause, four scalar aggregate subqueries). A denial is `42501` and is **never** a row of zeros. Requires the Vendor Super Admin role **and all three** of `ORGANIZATION_MEMBERS_READ`, `RBAC_READ`, `AUDIT_LOGS_READ` — **non-partial** by design, so a caller missing one is refused the whole summary (narrower than the RLS `OR`s, and therefore safe). **Two of the four counts are GLOBAL, not Vendor metrics**: `roles` and `permissions` carry no `organization_id`, so "Active Roles" and "Permissions" show the **same number to every Vendor** — hence the `catalog_` prefix on those fields, and clients must **not** label them "your roles". `audit_event_count` is **all-time and unwindowed** — do not render it as "recent" or "today". `active_member_count` is `status='ACTIVE'` memberships only and deliberately does **not** join `profiles`, matching the web exactly. No Retailer, Product, shop, assignment or invitation count is returned, because no such card exists on the web. Full audit: `docs/mobile-vendor-dashboard-summary-audit.md`. |
| V-02 | Vendor users directory **+ user detail** | `list_vendor_users()` + `get_vendor_user_detail(p_membership_id)` ✅ **shipped** (`20260801090000`) | **C** | Was **D**: the web joins four tables in TypeScript and returns rows carrying **no id**, so a mobile list could key nothing and navigate nowhere. The new reads do the join in SQL — one round trip, one row per user, roles as a `text[]` of **ACTIVE** role names (empty array when none; never a default). Detail has **no web counterpart** and returns the list columns plus `deactivated_at`; a foreign, Retailer-owned, unknown or null membership id returns **zero rows**, never an error. **No email** is returned, because the web page does not show one. **There are no Vendor user invitations** — both invitation tables are Retailer-scoped, so "invited" is just `status = 'INVITED'` on the membership and profile. |
| V-03 | Roles catalogue **+ role detail + role permissions** | `list_vendor_roles()` + `get_vendor_role_detail(p_role_id)` + `list_vendor_role_permissions(p_role_id)` ✅ **shipped** (`20260802090000`) | **C** | Was **B**: the web joins three whole-table reads in TypeScript and returns rows carrying **no id**, keying both its role list and every permission list by array index — so a mobile list could key nothing and open nothing. The new reads do the join and both counts in SQL — one round trip, one row per role, `permission_count` and `assigned_member_count` as scalar aggregates that cannot duplicate a role. **The catalogue is GLOBAL**: `roles`/`permissions`/`role_permissions` carry no `organization_id`, so every authorized Vendor sees the same six roles (including the three Retailer roles), exactly as `/roles` shows them today; the only tenant-scoped value is `assigned_member_count`, which counts the **calling** Vendor's memberships alone. `INACTIVE` definitions are listed and **marked**, not hidden. No role code, permission code or module is returned — those are the literals the RLS policies match on. Detail and permissions are addressed by the opaque `role_id`; unknown, foreign-table and null ids return **zero rows**, never an error. There is **no role write backend at all**, on web or mobile. |
| V-04 | Audit log feed | `list_vendor_audit_logs(p_limit, p_before_occurred_at, p_before_audit_log_id)` ✅ **shipped** (`20260804090000`) | **C** | Was **D**: a fixed `LIMIT 100` with no cursor, so record 101 was unreachable **forever**; the actor name was a `Map` join written in TypeScript whose resolved subset depended on the `profiles` policy per caller; and the affected entity was *typed* but never *named*, though the name snapshot was already sitting in `metadata`. The new read is **keyset-paginated on `(created_at, id)`** — both columns, because `now()` is the *transaction* timestamp, so two rows written in one transaction tie exactly and a timestamp-only cursor would duplicate or skip both. Cursor parts must be supplied **together or not at all** (`22023` otherwise); limit default **50**, hard max **100**, out-of-range refused rather than clamped. Actor resolves to `USER` / `SYSTEM` / `UNKNOWN`, joined **through the audit row's own Vendor membership** — the privacy boundary that stops a `SECURITY DEFINER` join printing a foreign organization's person onto the screen; a `DEACTIVATED` membership and a `SUSPENDED` profile both still keep their name, because revoking access must not rewrite history. **`SYSTEM` means "no actor identity remains", NOT "a system process acted"** — `profiles.id` cascades from `auth.users` and `actor_profile_id` is `ON DELETE SET NULL`, so a deleted user is byte-identical to a genuine system event (verified). Clients must use neutral wording such as *"System or unavailable actor"*, never a bare *"System"*. Entity named from a **closed** metadata whitelist (`product_name` / `retailer_name` / `shop_name`), type-guarded so a non-string value can never be stringified into raw JSON. Action and entity codes are **raw** — no DB label map exists, so clients map known codes and humanize unknown ones neutrally, and an unknown code stays visible. **No detail companion**, because the web exposes no audit detail surface to share. Never returned: raw `metadata`, `entity_id`, `ip_address`, `user_agent`, `actor_profile_id` (**the auth user id**), `organization_id`. Full audit: `docs/mobile-vendor-audit-log-reads-audit.md`. |
| V-05 | Retailers directory | `list_vendor_retailers()` ✅ **shipped** (`20260731090000`) | **C** | Was **D**: the web fetches every shop row just to count them. The new RPC aggregates in SQL — one round trip, one row per Retailer. Returns both `relationship_id` and `retailer_organization_id`, so Retailer and product screens can finally cross-link. Empty set for a Vendor with no Retailers; `42501` for anyone else. |
| V-06 | Retailer detail + owner status | `get_vendor_retailer_detail()` + `list_vendor_retailer_shops()` ✅ **shipped** (`20260731090000`), alongside the existing `get_vendor_retailer_owner_status()` | **C** | Was **D**. Detail is one fixed-size row; shops are a separate call because a shop list is unbounded. A foreign, unknown or null relationship id returns **zero rows**, never an error. The owner card still comes from `get_vendor_retailer_owner_status()`, which is **unchanged** — it has been dropped and recreated three times and this milestone deliberately did not add a fourth, so § 6.1's stability problem is contained but not fixed. |
| V-07 | Onboard a Retailer | `onboard_vendor_retailer()` | **C** | Ready. **No idempotency** — a double submit creates two Retailers. Disable the button on submit and keep it disabled until the response lands. |
| V-08 | Add a shop | `add_vendor_retailer_shop()` | **C** | Ready. Duplicate shop code → `23505`; duplicate **name is allowed**. |
| V-09 | Invite a Retailer Owner (new account) | `reserve_retailer_owner_invitation()` (step 1 only) | **D** | Needs Edge Function `invite-retailer-owner`. Auth Admin API + `service_role` finalization. |
| V-10 | Invite a Retailer Owner (existing account) | same | **D** | Needs Edge Function `send-existing-user-owner-invitation`. |
| V-11 | Revoke an owner invitation | `revoke_retailer_owner_invitation()` | **E** | Granted and audited, but **called by nothing anywhere in the codebase**. See Q8 / D-8. |
| V-12 | Product catalogue list | `list_vendor_products()` ✅ **reused verbatim** | **B** | Same entity a Retailer reads; different screen. The `20260803090000` audit found nothing to fix and added no second list. |
| V-12a | Product detail | `get_vendor_product_detail()` ✅ **shipped** (`20260803090000`) | **C** | The web has **no** detail read — it downloads the whole catalogue and `Array.find()`s one row. The RPC returns the list columns plus `assignment_count`, in one round trip. Unknown, foreign and null ids are indistinguishable **zero rows**. |
| V-12b | A product's assigned Retailers | `list_vendor_product_assigned_retailers()` ✅ **shipped** (`20260803090000`) | **C** | Read-only companion to V-15. Only rows that exist, so `assignment_status` is never null; withdrawn assignments are returned and marked. Returns `relationship_id`, so a product row can open the shipped Vendor Retailer detail screen. Requires `PRODUCTS_READ` **and** `RETAILERS_READ`. |
| V-13 | Create / update a product | `create_vendor_product()`, `update_vendor_product()` ✅ **reused verbatim — no new write RPC**; **repaired** by `20260807090000` | **C** | The web writes through these SECURITY DEFINER RPCs already — the Server Actions hold no rule of their own — so there was **no shared-contract gap**, and adding a mobile twin would have been a second definition of "create a product". Both were **repaired in place** (identical signature, return type, grants and semantics): normalization ran `btrim`, which strips **only U+0020**, *before* collapsing whitespace, so a leading/trailing tab, newline, CR, form feed, vertical tab or Unicode space separator became an untrimmed space and hit a table `CHECK` — returning PostgreSQL's **raw error naming `vendor_products` and the constraint**. The web never hit it because `product-input.ts` trims in JavaScript first, which made it a **TypeScript-only rule a second client bypasses**. Now collapse-then-trim over an explicit class equal to JavaScript's `\s`. Send **no** organization, tenant, user, role or permission value — there is no parameter for one. `product_code` is **immutable** and is not a parameter on update; create takes **no** initial status. A no-op edit (including a whitespace-only difference) is a **silent success** that writes no audit row. Map by **SQLSTATE**, not message: `23514` → field error, `23505` → duplicate, `42501` → one generic refusal covering unknown, foreign and null ids alike. Duplicate code-vs-barcode is still discriminated by an **English message substring** — do not re-implement that matching; both literals are now pinned by tests. Full audit: `docs/mobile-vendor-product-writes-audit.md`. |
| V-14 | Activate / deactivate a product | `set_vendor_product_status()` ✅ **reused verbatim — NOT modified** by `20260807090000` | **C** | Returns `void` — a silent **no-op** when already in that state: no write, no `updated_at` movement, **no audit row**, which is what stops a double-tap producing two audit rows for one decision. Treat a no-op as success. Gated on **`PRODUCTS_MANAGE`, the same permission as V-13** — verified by removing the seeded mapping in pgTAP, not assumed. Both transitions permitted both ways; `p_status` is `upper(btrim(...))`-normalized, so `'  inactive  '` is understood and anything outside `ACTIVE`/`INACTIVE` is `23514`. **Deactivation does not touch assignment rows**, not even their `updated_at`; it blocks *new* assignments (V-16 → `55000`) and hides the product from the Retailer-facing list. It is **not** deletion — the row, its `created_at` and all assignment history survive, and an INACTIVE product remains editable. Needed no repair: its only normalization feeds a closed status test, so it has no path to a raw constraint error. After any write, refresh through `get_vendor_product_detail(id)` (V-12a) — the writes deliberately return no row. |
| V-15 | List a product's Retailer assignments (**editor** matrix) | `list_vendor_product_retailer_assignments()` | **C** | Returns `retailer_organization_id`, while Retailer screens are addressed by `vendor_retailers.id`. **Two address spaces** — do not cross-link from this one. **Unchanged**; the web assign/withdraw matrix depends on it exactly as it is. ✅ For a mobile *read*, use V-12b, which returns `relationship_id` and needs no write permission. |
| V-16 | Assign / withdraw a product | `assign_vendor_product_to_retailer()`, `unassign_…()` | **C** | `void` return hides "changed" from "already so". **Deferred milestone — not adopted yet.** The V-13/V-14 audit confirmed there is **no coupling** to product record writes: these are separate functions on a **separate permission** (`PRODUCT_RETAILER_ASSIGN`, not `PRODUCTS_MANAGE`), and product create/edit/status neither creates, reads nor mutates an assignment row (proved by a full lifecycle producing **zero** assignment rows). Assigning requires an **ACTIVE** product, relationship and Retailer organization; withdrawing requires none of those, so a product can still be withdrawn from a suspended Retailer. Withdrawal sets `INACTIVE` and **never deletes**. Addressed by `retailer_organization_id`, while the read companion V-12b returns `relationship_id` — reconcile the two address spaces when planning that milestone. |
| V-17 | Receipt review | — | **E** | **Does not exist.** No approve/reject RPC, no reviewer permission, no review screen. See D-7. |
| V-18 | Vendor company & signed-in administrator profile (read-only) | `get_my_portal_context()` for the company name (**reused verbatim**) + `get_my_vendor_profile()` ✅ **shipped** (`20260806090000`) | **C** | Was **E**: the web has **no** company or profile surface — no `/settings`, `/company`, `/organization`, `/profile` or `/account` route exists, and Settings is a `disabled: true` nav placeholder. The only real surface is the admin **header**: the organization name plus the caller's name, both from `getVendorSuperAdminAccess()`. **The company half needed no backend at all** — the entire Vendor company surface in the product is one field, `organizations.name`, and `get_my_portal_context()` already returns it as `vendor.organization_name` through the same authorization chain, so the new RPC returns **no company field** and Flutter **must** read the name from PortalContext. `organizations.status`, `country_code`, `default_currency` and every timestamp are never displayed for the caller's own Vendor, and **no legal-name, trading-name, registration, tax, website, business-phone, business-email, address or logo column exists anywhere in the schema** — nothing was withheld, because nothing is stored. The real gap was **self-identification**: `list_vendor_users()` returns every user's roles but marks no row as the caller, so rendering "your role" meant downloading the whole directory and guessing by display name. The new zero-argument read returns exactly `administrator_display_name` (composed in SQL, so Dart never re-joins name parts) and `administrator_role_names text[]` (ACTIVE definitions only, names never codes, same type/filter/ordering as the directory row). **No status and no timestamp**: an authorized caller has an ACTIVE profile, membership and organization *by construction*, so such a field could only ever say `ACTIVE` — clients must render neither three badges nor one combined "Account status". Requires `RBAC_READ` (the role *name* comes from the global catalogue) and deliberately **not** `ORGANIZATION_MEMBERS_READ`, because a caller's own rows are gated by ownership under RLS. Multi-Vendor callers get the **lowest-organization-id** Vendor, the same one PortalContext picks. Full audit: `docs/mobile-vendor-company-profile-reads-audit.md`. |

### 3.2 Data the Vendor can view

Everything within their own `VENDOR` organization and its Retailer relationships:
organization members, the global role/permission catalogue, audit events scoped to the
organization (null-organization rows are correctly excluded by RLS — **keep it that
way**), the Retailer directory and per-Retailer detail including owner-invitation status,
the full product catalogue, and each product's Retailer assignments.

The Vendor does **not** see: any Retailer's staff roster, any Retailer's shop members, or
any receipt submission. There is no RPC that would return them.

### 3.3 Shared with other roles

- **Authentication and session** — class A, identical for all four roles.
- **Product entity** — class B. `list_vendor_products()` and
  `list_retailer_assigned_products()` return the same business object. Share the `Product`
  entity and repository contract; the data sources call different RPCs and the screens are
  entirely different (management vs. read-only reference).
- **Retailer / shop entities** — class B. The Vendor sees them as records it administers;
  the Retailer Owner sees its own. Same entity, different repositories.

### 3.4 Behavioural states

| State | Presentation |
| --- | --- |
| Loading | Route skeletons (`SkeletonPageHeader` + `SkeletonStatGrid` / `SkeletonTable`), `aria-busy`, generic "Loading…" label. |
| Empty | `EmptyState` — "No Retailers yet" (+ onboard action), "No products yet", "No shops yet". |
| Could not load | `EmptyState` with **reason-free** copy, or a warning `Alert`. The section fails; the page still renders. |
| Denied | Redirect to `/access-denied` — the shared role-neutral card. |
| Unauthenticated | Redirect to `/login`. |

Note the Vendor resolver's fail-closed design: a transient database failure presents as
"not a Vendor" and falls through to the Retailer check, ending at `/access-denied`. That
is intentional and Flutter should reproduce it rather than adding a Vendor-specific
"unavailable" path that the backend cannot actually produce.

> **Whether Vendor administration belongs on mobile at all is open (Q4).** Every row in
> § 3.1 is phase 3 in `mobile-feature-matrix.md`. Five new RPCs and two Edge Functions
> stand between here and a good Vendor mobile experience, and the web already serves this
> internal audience well on a desktop.

---

## 4. Retailer Owner

**Default landing:** `/retailer` — the portal overview.

**Navigation:** four destinations → a bottom navigation bar.

| Destination | Route | Notes |
| --- | --- | --- |
| Overview | `/retailer` | Owner-only |
| Shops | `/retailer/shops` | Owner-only |
| Staff | `/retailer/staff` | Shared route with Manager, different content |
| Products | `/retailer/products` | Read-only, shared with Manager |

**Receipts is deliberately absent.** `RECEIPT_SUBMIT` is mapped to `SALES_STAFF` alone,
so every receipt RPC refuses an Owner. Showing the entry would advertise a capability the
database will not grant — exactly the "Owner navigation accidentally exposes a
Sales-Staff-only action" mistake this milestone must avoid. **Do not add it to the Flutter
bottom bar.**

Likewise, Products is the **read-only assigned list**. Managing the catalogue is a Vendor
capability on a different surface entirely.

### 4.1 Screens and actions

| ID | Feature | RPC | Class | Notes |
| --- | --- | --- | --- | --- |
| RO-01 | Portal overview (retailer name + counts) | `get_retailer_owner_portal_context()` | **C** | Hard-filters `RETAILER_OWNER`. Returns **zero rows for a Manager** — that is a denial, not an error. |
| RO-02 | Own shops list | `list_retailer_owner_portal_shops()` | **D** | **Returns no `shop_id`.** A Flutter list cannot key rows or open a detail screen. Render non-tappable until contract fix #1. |
| RO-03 | Assigned products | `list_retailer_assigned_products()` | **A** | Identical for Owner and Manager. Filtered to ACTIVE × ACTIVE in SQL. |
| RO-04 | Staff roster | `list_retailer_staff_members()` | **B** | Same RPC as the Manager. The Owner sees **all** members; the Manager sees **ACTIVE only**. The narrowing is decided **inside the function** by `has_organization_permission(v_retailer, 'RETAILER_STAFF_MANAGE')`. |
| RO-05 | Staff invitations list | `list_retailer_staff_invitations()` | **C** | Requires `RETAILER_STAFF_MANAGE`. `derived_state` has **no `ELSE` branch and can be `NULL`** — handle it (contract fix #2). |
| RO-06 | Assignable shops (for invites) | `list_retailer_staff_assignable_shops()` | **C** | Requires `RETAILER_STAFF_SHOP_ASSIGN`. |
| RO-07 | Invite a staff member | `reserve_retailer_staff_invitation()` (step 1) | **D** | Needs Edge Function `send-staff-invitation`. Token generation, Resend key, and three `service_role` RPCs. `prepare_*` returns the recipient's email — **never expose it**. Feature-flag gated. |
| RO-08 | Re-send a staff invitation | same | **D** | `canResendInvitation` is a **TypeScript-only predicate**. It must move into the shared path or into SQL, or the two clients will disagree about what is resendable. |
| RO-09 | Revoke a staff invitation | `revoke_retailer_staff_invitation()` | **C** | Ready today. Deliberately **not** flag-gated — a kill switch must not strand an owner. Preserve that. |
| RO-10 | Accept an owner invitation (new account) | `accept_retailer_owner_invitation()` | **D** | Needs deep-link handling of the Supabase `verifyOtp` URL (Q6). |
| RO-11 | Accept an owner invitation (existing account) | `get_pending_existing_user_retailer_invitation()`, `accept_existing_user_retailer_owner_invitation()` | **D** | Flutter must SHA-256 the deep-link token itself and store **only the hash**. Never persist the raw token. (Q6) |

### 4.2 Data the Owner can view

Their own Retailer's name and shop counts; their own shops; the products assigned to them
by the Vendor; the **full** staff roster including non-ACTIVE members; all staff
invitations with their derived lifecycle state; and the shops available for assignment.

The Owner does **not** see: any other Retailer, the Vendor's catalogue beyond their own
assignments, any receipt submission (including their own staff's), audit logs, or the
role/permission catalogue.

### 4.3 Shared with other roles

- **Authentication** — class A.
- **Staff roster** — class B, and this is the textbook case. **One entity, one repository
  contract, one data source, one RPC.** The Owner and Manager screens differ (the Owner
  gets invitation management and an invite form; the Manager gets a read-only list), so
  the **BLoC and widgets are separate**. Critically: *the visibility difference is a
  permission check inside the SQL function.* Flutter must never re-implement it
  client-side — just render what came back.
- **Assigned products** — class A. Identical RPC, identical screen, identical result for
  Owner and Manager. Share everything.
- **Shop entity** — class B, shared with the Vendor's shop administration.

### 4.4 Role-specific differences vs. the Manager

| Capability | Owner | Manager |
| --- | --- | --- |
| Portal overview / retailer name | ✅ | ❌ (zero rows — see Q3) |
| Shops list | ✅ | ❌ (resolver requires `RETAILER_OWNER`) |
| Staff roster | ✅ all members | ✅ **ACTIVE only** |
| Staff invitations list | ✅ | ❌ |
| Invite / resend / revoke staff | ✅ | ❌ |
| Assigned products | ✅ | ✅ |
| Receipts | ❌ | ❌ |

The web drives all three staff-page sections from
`lib/staff/portal-access-decision.ts` predicates — `showsInvitationSection`,
`showsInviteSection`, `showsInviteForm` — which take a **status returned by the backend**
(`ok` / `denied` / `unavailable`), not a locally-known role:

```
denied      → hide the section entirely
unavailable → show the section, with a warning
ok          → show it fully
```

`showsInviteForm` additionally requires exactly `ok` — a section can be visible while its
form is not. Port this shape. It is the mechanism that keeps "what the UI offers" tied to
"what the backend actually allowed", rather than to a client's belief about a role.

### 4.5 Behavioural states

| State | Presentation |
| --- | --- |
| Loading | Route skeletons per screen. |
| Empty | "No staff yet", "No invitations yet", "No shops to show". |
| Could not load | Warning `Alert` — "Shops could not be loaded" — or a reason-free empty state. Never a Postgres code or exception text. |
| Denied (whole portal) | `/retailer-access-denied` — **the identical card** the Vendor route renders, deliberately, so the two are indistinguishable to a hostile account. |
| Denied (one section) | Section hidden, page renders. |
| Unauthenticated | `/login`. |

---

## 5. Retailer Manager

**Default landing:** `/retailer/staff` — the staff roster, the only portal page they may
read in full.

Sending them to `/retailer` instead would bounce them straight off it, because that page
requires `RETAILER_OWNER`.

**Navigation:** two destinations → a two-item bottom bar (or, at this size, arguably an
app-bar-only layout with a single switch; the bottom bar is recommended for consistency
with the Owner).

| Destination | Route |
| --- | --- |
| Staff | `/retailer/staff` |
| Products | `/retailer/products` |

Overview, Shops and Receipts are all omitted because SQL refuses the Manager on each —
linking any of them would advertise dead ends.

### 5.1 Screens and actions

| ID | Feature | RPC | Class | Notes |
| --- | --- | --- | --- | --- |
| RM-01 | Landing at `/retailer/staff` | via the portal probe | **B** | Same landing decision, different destination. |
| RM-02 | Staff roster, read-only, **ACTIVE members only** | `list_retailer_staff_members()` | **B** | Same RPC as the Owner. Narrowing decided in SQL. **A Flutter client needs no role logic at all here.** |
| RM-03 | Assigned products | `list_retailer_assigned_products()` | **A** | `RETAILER_PRODUCTS_READ` is mapped to `RETAILER_MANAGER`. Identical to the Owner's screen. |
| RM-04 | Read own Retailer name / branding | — | **D / E** | **Does not work.** `get_retailer_owner_portal_context()` hard-filters `RETAILER_OWNER`, so a Manager cannot read their own tenant name. See Q3 / D-6. |
| RM-05 | Manage staff / invite | — | **C (denied)** | Correctly refused. The denial is enforced by permission mapping, not by UI. Flutter hides the affordance; SQL enforces it. |

### 5.2 Data the Manager can view

The ACTIVE members of their own Retailer, and the products assigned to that Retailer.
That is the complete list.

They cannot read their own organization's name. On the web this is invisible — they land
on the staff page and the header simply omits the name, with the caption "Retailer staff"
carrying the context instead (`retailerName` is typed `string | null` in
`RetailerShell` precisely for this case, and the source documents why: *"Rather than
fabricate a name or guess one, the header omits it."*).

> **On mobile this omission is much more visible**, because the app bar is a larger share
> of the screen and there is no sidebar to carry context. See D-6.

### 5.3 Shared with other roles

- **Authentication** — class A.
- **Staff roster** — class B with the Owner. Shared entity, repository, data source and
  RPC; **separate BLoC and widgets**, because the Owner's screen carries invitation
  management the Manager's must not.
- **Assigned products** — class A with the Owner. Share the entire vertical slice
  including the screen.

### 5.4 Role-specific differences

The Manager is best understood as *"the Owner's roster page, minus everything else"*. The
only genuinely Manager-shaped concern is the missing tenant name (RM-04). Everything else
is a subset.

This is exactly why the staff feature is class **B** and not class **A**: the *data* is
shared and the *contract* is shared, but the *screen* is not, and merging them into one
widget with `if (isOwner)` branches would put a role check in the presentation layer —
the thing this architecture forbids.

### 5.5 Behavioural states

As § 4.5, with one addition: the Manager's staff screen renders the roster section only.
The invitation and invite sections are hidden by `showsInvitationSection` /
`showsInviteSection` returning false on a `denied` status. The **empty** roster and the
**denied** invitation section must look different — one is an `EmptyState` card, the other
is simply absent.

---

## 6. Sales Staff

**Default landing:** `/retailer/receipts`.

**Navigation:** **none.** One destination. Per `mobile-ui-design-handoff.md` § 4.1, a
single-tab bottom bar is noise — ship the screen with an app bar and no navigation chrome.

A Sales Staff member holds neither `RETAILER_PORTAL_READ` through the owner role, nor
`RETAILER_STAFF_READ`, nor `RETAILER_PRODUCTS_READ`. Overview, Shops, Staff and Products
are all refused to them **in SQL**, and none is offered in the UI.

### 6.1 Screens and actions

| ID | Feature | RPC | Class | Notes |
| --- | --- | --- | --- | --- |
| SS-01 | List my assigned shops | `list_my_assigned_receipt_shops()` | **C** | Ready. The cleanest contract in the schema — `(shop_id, shop_name, shop_code)`, filtered to `m.user_id = auth.uid()`, live rows and ACTIVE shops only. |
| SS-02 | Submit a receipt photo | `reserve_receipt_submission()` (step 1 only) | **D** | **Blocked.** Storage has **zero policies**; the upload needs the service key, which must never reach a device. Needs Edge Function `submit-receipt`. Magic-byte MIME sniffing and orphan-object cleanup are server-side and must stay so. |
| SS-03 | Camera capture | — | **C** | Ready today, and the single biggest genuine mobile improvement over the web's `<input type="file">`. Downscale before upload: the bucket caps at 10 MiB and accepts only `image/jpeg\|png\|webp`. |
| SS-04 | Duplicate-receipt protection | enforced by a unique index | **C** | The SHA-256 must be computed over the **exact bytes uploaded**. Re-encoding after hashing breaks the guard. |
| SS-05 | My receipt history | `list_my_receipt_submissions()` | **C** | Ready. Scoped to `auth.uid()` in SQL. |
| SS-06 | View a submitted receipt image | — | **D / E** | **No read path exists anywhere.** Needs Edge Function `get-receipt-image-url`; any signed URL must be short-lived and issued only after verifying `submitted_by_profile_id = auth.uid()`. (Q1) |
| SS-07 | Offline capture / retry queue | — | **E** | Reservation needs connectivity. Queued bytes on-device are unencrypted customer data unless deliberately protected. (Q5) |

### 6.2 Data the Sales Staff member can view

Their own assigned shops, and their own receipt submissions. Nothing else — not other
staff members' submissions, not the roster, not the product catalogue, not the retailer's
name.

**Never rendered, and this must hold in Flutter**: the storage bucket, the object path,
the file hash, any profile / membership / organization id, any failure code, and any other
person's data.

### 6.3 Shared with other roles

- **Authentication** — class A.
- **Shop entity** — class B. A Sales Staff member's "assigned shop" and an Owner's "my
  shop" are the same business object from different RPCs with different projections
  (notably, the Sales Staff RPC returns `shop_id` and the Owner's does **not** — see
  RO-02). Share the entity; keep the repositories separate.
- **Receipt entity** — currently class **C**, because Sales Staff is the only role that
  can touch a receipt at all. It becomes class **B** the moment receipt review exists
  (D-7): the same `Receipt` entity, a submitter screen and a reviewer screen.

### 6.4 Role-specific differences

Sales Staff is the only role whose entire experience is a **write** flow. Every other role
is predominantly read. This shapes the port:

- the submit form is the landing screen, not a sub-page;
- the history list is secondary context beneath it;
- the biggest UX risks are camera handling, image size, and network failure mid-upload —
  none of which the web has to solve.

### 6.5 Behavioural states

| State | Presentation |
| --- | --- |
| Loading | Skeleton form section + skeleton table. |
| Empty (no shops assigned) | `EmptyState` — "No shops assigned yet". The submit card is **replaced**, not disabled. |
| Empty (no history) | `EmptyState` — "No receipts yet". |
| Validation error | Field error under the control (shop, receipt), `role="alert"`. |
| Submit failure | Red `Alert` at the top of the form. The file picker is cleared after **every** attempt — a browser cannot repopulate a file input, and Flutter should match the behaviour so the two clients agree about what is still selected. |
| Success | Green `Alert` with `sr-animate-fade-in`; the form resets. |
| Denied | `/retailer-access-denied`. |

---

## 7. Cross-role feature classification summary

| Feature | Vendor | Owner | Manager | Sales Staff | Class |
| --- | --- | --- | --- | --- | --- |
| Sign in / sign out / session | ✅ | ✅ | ✅ | ✅ | **A** |
| Password policy | ✅ | ✅ | ✅ | ✅ | **A** — port `lib/auth/password-policy.ts` verbatim; Supabase Auth remains the real authority |
| Landing resolution | ✅ | ✅ | ✅ | ✅ | **B** |
| Access-denied surface | ✅ | ✅ | ✅ | ✅ | **A** — role-neutral by design; the two routes are deliberately indistinguishable |
| Invitation acceptance surface | — | ✅ | ✅ | ✅ | **B** — one shell, role-specific flows |
| Profile / account | — | — | — | — | **E** — does not exist (D-5 in the design handoff) |
| Product entity | ✅ manage | ✅ read | ✅ read | ❌ | **B** |
| Retailer / shop entity | ✅ admin | ✅ own | ❌ | ✅ assigned | **B** |
| Staff roster | ❌ | ✅ all | ✅ ACTIVE | ❌ | **B** |
| Staff invitations | ❌ | ✅ | ❌ | ❌ | **C** |
| Receipt submission | ❌ | ❌ | ❌ | ✅ | **C** → **B** once review exists |
| Receipt review | ⬜ future | ❌ | ❌ | ❌ | **E** (D-7) |
| Dashboard | ✅ | ✅ overview | ❌ | ❌ | **B** — presentation is role-specific by definition |
| Audit logs | ✅ | ❌ | ❌ | ❌ | **C** |
| Roles & permissions | ✅ | ❌ | ❌ | ❌ | **C** |

### 7.1 What this means for the Flutter module layout

Following `mobile-architecture-recommendation.md`:

```
core/            auth, session, error mapping, design system, shared widgets
domain/
  entities/      User, Organization, Retailer, Shop, Product, StaffMember,
                 Invitation, Receipt            ← SHARED (class A/B)
  repositories/  contracts                       ← SHARED where the backend contract is shared
data/
  datasources/   one per RPC group               ← SHARED when the RPC is shared
features/
  auth/                                          ← shared presentation (class A)
  vendor/        dashboard, retailers, products, users, roles, audit
  retailer_owner/  overview, shops, staff, invitations, products
  retailer_manager/ staff, products              ← separate BLoC + widgets, shared data
  sales_staff/   receipts (submit + history)
```

The `staff` feature is the one that most tempts a shortcut. Resist it: `retailer_owner`
and `retailer_manager` must have **separate BLoCs and separate widget trees**, both
talking to the **same** `StaffRepository` and the **same** `list_retailer_staff_members()`
data source. An `if (role == owner)` inside a shared staff widget is precisely the
UI-inferred-authorization anti-pattern this map exists to prevent.

---

## 8. Unresolved product decisions

Backend questions Q1–Q8 are defined in `mobile-backend-contract.md` § 7. The
decisions below are the role-flow consequences.

| # | Decision | Depends on | Recommendation |
| --- | --- | --- | --- |
| **D-1** | ✅ **RESOLVED.** `get_my_portal_context()` shipped in migration `20260729090000`. Flutter builds against it and must not reproduce the probe. **Still open:** when to migrate the *web* resolver onto it. | — | Defer the web swap to its own change. It collapses up to four round trips into one, but it is not behaviour-preserving: a Manager's header would start showing their Retailer name (`null` today), and `unavailable` would come from one call failing rather than three probes failing independently. Both are improvements; both deserve their own review. |
| **D-2** | Can a user hold roles at more than one Retailer? | Q2 | Today `resolve_retailer_*_organization` returns `NULL` when the caller qualifies at more than one Retailer — a **total silent denial**. Either forbid it explicitly or design an account switcher. Do not leave it silent. |
| **D-3** | Does the Vendor portal belong on mobile at all? | Q4 | **Defer to phase 3.** Five new RPCs and two Edge Functions stand in the way, and the audience is internal desktop users. Build Sales Staff and Retailer first. |
| **D-4** | Sales Staff: is offline capture in scope? | Q5 | **Not for the MVP.** The reservation step needs connectivity, and queued bytes are unencrypted customer data unless deliberately protected. Ship online-only, then revisit. |
| **D-5** | Can a Sales Staff member view a receipt they submitted? | Q1 | **Yes, and it needs `get-receipt-image-url`.** A history list whose rows cannot be opened is a poor mobile experience. Short-lived signed URL, issued only after verifying ownership. |
| **D-6** | ✅ **RESOLVED for Flutter.** `get_my_portal_context().retailer.organization_name` is returned for **all three** retailer kinds, including a Manager and a Sales Staff member. Safe: the id came from a resolver that already proved ACTIVE membership, so a caller only ever learns the name of the tenant they demonstrably belong to. **Still open:** whether the web adopts it (that is the user-visible half of D-1). | Q3 | Adopt it in Flutter now. Adopt it in the web with the D-1 swap. |
| **D-7** | Who reviews receipts, and where? | — | Nothing exists: no reviewer permission, no approve/reject RPC, no screen. The brief anticipates *"receipt review will belong to an authorized Vendor reviewer"* — that role, its permission, and its RPCs all need to be designed. Until then, receipt review is **class E**, not a Flutter task. |
| **D-8** | Should owner-invitation revoke be wired up? | Q8 | `revoke_retailer_owner_invitation()` is granted and audited but **called by nothing anywhere**. Either wire it (web and Flutter together) or remove the grant. A live, audited, unreachable mutation is a latent risk. |
| **D-9** | Where does `canResendInvitation` live? | — | It is a **TypeScript-only predicate** today (RO-08). Move it into SQL or into the shared Edge Function before Flutter reimplements it, or the two clients will disagree about which invitations are resendable. |

---

## 9. Verification checklist for the Flutter port

- [ ] Landing comes from the backend, never from a locally-cached role string.
- [ ] `unavailable` is presented as a retry-safe operational failure with the session
      intact — **never** as access denied.
- [ ] Zero rows from `get_retailer_owner_portal_context()` is treated as a denial for a
      Manager, not as an error.
- [ ] `42501` is a first-class expected outcome with dedicated presentation per screen.
- [ ] `list_retailer_staff_invitations().derived_state` handles `NULL`.
- [ ] Section visibility is driven by backend-returned status
      (`ok` / `denied` / `unavailable`), reproducing `showsInvitationSection`,
      `showsInviteSection`, `showsInviteForm`.
- [ ] Receipts appears for Sales Staff only — never in Owner or Manager navigation.
- [ ] The Owner's staff screen and the Manager's staff screen are separate widget trees
      over one shared repository.
- [ ] No screen renders a storage path, object key, file hash, or any internal id.
- [ ] The raw invitation token is hashed on device and **only** the hash is persisted.
- [ ] Vendor `onboard_vendor_retailer()` submits are guarded against double-tap — there is
      no server-side idempotency.
- [ ] Every screen re-resolves its own access on open; navigation is never the gate.
