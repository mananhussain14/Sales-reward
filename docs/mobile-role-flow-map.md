# Mobile Role Flow Map — SalesReward

## Backend source version

| Field | Value |
| --- | --- |
| Repository | `salesreward-admin` (Next.js 16.2.10 + Supabase) |
| Branch | `main` |
| Commit | `510331e5fed8293f6af95c339fee8c082b4ea458` |
| Latest migration | `supabase/migrations/20260728090000_retailer_staff_registration_context.sql` |
| Date of audit | 2026-07-24 |

Companion documents: [`mobile-backend-contract.md`](./mobile-backend-contract.md) (per-RPC
detail), [`mobile-feature-matrix.md`](./mobile-feature-matrix.md) (readiness and phasing),
[`mobile-architecture-recommendation.md`](./mobile-architecture-recommendation.md) (layering),
[`mobile-ui-design-handoff.md`](./mobile-ui-design-handoff.md) (visual identity).

**Status: audit and specification only.** Nothing in the database, RLS, RPCs, or
application code was changed.

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
| Sales Staff | `RECEIPT_SUBMIT` — and nothing else |

Note what this means: **a Sales Staff member holds no read permission for the portal, the
staff roster, or the product catalogue.** Every one of those RPCs refuses them in SQL.
That is why their navigation has exactly one destination.

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

> ⚠️ **This is the single most important thing to fix before Flutter ships.** The role is
> currently inferred from *which list RPC returns `42501`*. That is authorization decided
> by error handling, it costs up to three round trips on every cold start, and two clients
> implementing the same probe order will drift. `mobile-feature-matrix.md` § 8 lists
> **`get_my_portal_context()`** as the #1 new RPC, high priority, phase 1. Flutter should
> be built against that contract and the probe used only as a temporary fallback.

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

### 3.1 Screens and actions

| ID | Feature | RPC(s) | Class | Notes |
| --- | --- | --- | --- | --- |
| V-01 | Dashboard summary counts | 4 separate reads | **D** | Four round trips. Needs new `get_vendor_admin_dashboard_summary()`. Buildable but wasteful on mobile. |
| V-02 | Organization members directory | 4-query join in TypeScript | **D** | Needs new `list_vendor_organization_members()`. Flutter must not re-implement the join. |
| V-03 | Roles & permissions catalogue | RLS reads on `roles`, `permissions`, `role_permissions` | **C** | Gated on `RBAC_READ`. Vendor-only concept. |
| V-04 | Audit log feed | direct read | **D** | Fixed 100 rows, no pagination. Needs `list_vendor_audit_logs(p_limit, p_before)`. |
| V-05 | Retailers directory | multi-query | **D** | Fetches every shop row just to count them. Needs `list_vendor_retailers()`. |
| V-06 | Retailer detail + owner status | `get_vendor_retailer_owner_status()` + reads | **D** | Owner-status function has been **dropped and recreated three times** with a growing column list. Not a stable pinned contract. Needs `get_vendor_retailer_detail()`. |
| V-07 | Onboard a Retailer | `onboard_vendor_retailer()` | **C** | Ready. **No idempotency** — a double submit creates two Retailers. Disable the button on submit and keep it disabled until the response lands. |
| V-08 | Add a shop | `add_vendor_retailer_shop()` | **C** | Ready. Duplicate shop code → `23505`; duplicate **name is allowed**. |
| V-09 | Invite a Retailer Owner (new account) | `reserve_retailer_owner_invitation()` (step 1 only) | **D** | Needs Edge Function `invite-retailer-owner`. Auth Admin API + `service_role` finalization. |
| V-10 | Invite a Retailer Owner (existing account) | same | **D** | Needs Edge Function `send-existing-user-owner-invitation`. |
| V-11 | Revoke an owner invitation | `revoke_retailer_owner_invitation()` | **E** | Granted and audited, but **called by nothing anywhere in the codebase**. See Q8 / D-8. |
| V-12 | Product catalogue list | `list_vendor_products()` | **B** | Same entity a Retailer reads; different screen. |
| V-13 | Create / update a product | `create_vendor_product()`, `update_vendor_product()` | **C** | Duplicate code-vs-barcode is discriminated by an **English message substring**. Do not re-implement that matching. |
| V-14 | Activate / deactivate a product | `set_vendor_product_status()` | **C** | Returns `void` — a silent no-op when unchanged. |
| V-15 | List a product's Retailer assignments | `list_vendor_product_retailer_assignments()` | **C** | Returns `retailer_organization_id`, while Retailer screens are addressed by `vendor_retailers.id`. **Two address spaces** — do not cross-link without the contract fix. |
| V-16 | Assign / withdraw a product | `assign_vendor_product_to_retailer()`, `unassign_…()` | **C** | `void` return hides "changed" from "already so". |
| V-17 | Receipt review | — | **E** | **Does not exist.** No approve/reject RPC, no reviewer permission, no review screen. See D-7. |

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
| **D-1** | Ship `get_my_portal_context()` before Flutter, or let Flutter reproduce the three-probe fallback? | — | **Ship the RPC first.** Role-by-`42501`-probe is fragile, slow on mobile, and guaranteed to drift between two clients. It is the #1 phase-1 backend item. |
| **D-2** | Can a user hold roles at more than one Retailer? | Q2 | Today `resolve_retailer_*_organization` returns `NULL` when the caller qualifies at more than one Retailer — a **total silent denial**. Either forbid it explicitly or design an account switcher. Do not leave it silent. |
| **D-3** | Does the Vendor portal belong on mobile at all? | Q4 | **Defer to phase 3.** Five new RPCs and two Edge Functions stand in the way, and the audience is internal desktop users. Build Sales Staff and Retailer first. |
| **D-4** | Sales Staff: is offline capture in scope? | Q5 | **Not for the MVP.** The reservation step needs connectivity, and queued bytes are unencrypted customer data unless deliberately protected. Ship online-only, then revisit. |
| **D-5** | Can a Sales Staff member view a receipt they submitted? | Q1 | **Yes, and it needs `get-receipt-image-url`.** A history list whose rows cannot be opened is a poor mobile experience. Short-lived signed URL, issued only after verifying ownership. |
| **D-6** | How does a Retailer Manager learn their own Retailer's name? | Q3 | Either widen `get_retailer_owner_portal_context()` (or add a minimal `get_my_retailer_identity()`), or accept the web's honest omission. **Recommend the minimal new read** — on mobile the blank app bar is far more noticeable than on the web. |
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
