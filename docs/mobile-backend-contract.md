# Mobile Backend Contract — SalesReward

**Status:** originally an audit. **Updated 2026-07-25** for the backend changes made since
it was first written:

| Migration | Added | See |
| --- | --- | --- |
| `20260729090000_shared_portal_context.sql` | `public.get_my_portal_context()` | **AUTH-05** |
| `20260730090000_sales_staff_receipt_product_and_submission_reads.sql` | `public.list_my_receipt_products()`, `public.get_my_receipt_submission(uuid)` | `docs/mobile-receipt-submission-audit.md` |
| `20260731090000_mobile_vendor_retailer_reads.sql` | `public.list_vendor_retailers()`, `public.get_vendor_retailer_detail(uuid)`, `public.list_vendor_retailer_shops(uuid)`, and the internal `public.vendor_retailer_owner_state(uuid)` | **V-05**, **V-06**, and `docs/mobile-vendor-retailer-reads-audit.md` |

Everything else below still describes the schema as audited: no other migration, RPC, RLS
policy, grant, Storage policy, environment variable, or application file was created or
changed. In particular **no existing function was edited, dropped, or replaced by any of
the three**, and no web page changed behaviour.

**Purpose.** Establish which parts of the existing SalesReward backend can be shared, as-is,
between the current Next.js web application and a future Flutter mobile application against
the *same* Supabase project — and which parts cannot, and why.

**Audit basis.** All 32 applied migrations under `supabase/migrations/` (31 at the time of
the original audit, plus `20260729090000`), every Server Action
and Route Handler under `app/`, and every server module under `lib/`. There are **no Supabase
Edge Functions in this repository** (`supabase/` contains only `config.toml`, `migrations/`
and `templates/`).

---

## 0. How to read this document

Every operation carries the same eighteen fields:

| Field | Meaning |
| --- | --- |
| Feature | The user-visible capability |
| Role | Which role(s) may perform it |
| Permission | The `public.permissions.code` the database checks |
| Web route | The Next.js route that hosts it today |
| Server Action / handler | The `"use server"` function or Route Handler |
| Existing RPC / table op | What actually touches Postgres or Storage |
| Inputs | Parameters the client supplies |
| Backend-resolved | Values the database derives and the client can never supply |
| Returns | Shape returned to the caller |
| Errors | SQLSTATE / failure modes |
| RLS & authorization | How the decision is made and enforced |
| Tables | Tables read or written |
| Storage bucket | Bucket touched, if any |
| Idempotency | Duplicate protection |
| Flutter direct? | Yes / No, with the blocking reason |
| Classification | One of the six categories below |
| Backend change needed | What must be built, if anything |
| Tests | Existing coverage |

### Classification categories

| Code | Category |
| --- | --- |
| **A** | Flutter can call the existing authenticated Postgres RPC directly |
| **B** | Flutter can use existing RLS-protected table or Storage access |
| **C** | Flutter requires a new shared Postgres RPC |
| **D** | Flutter requires a Supabase Edge Function or another trusted server endpoint |
| **E** | Web-interface-only; must be recreated as Flutter UI |
| **F** | Needs a product decision before mobile implementation |

---

## 1. The security model this backend already has

This is the single most important finding, and it is favourable.

**Authorization is resolved from `auth.uid()`, never from client input.** Every
`SECURITY DEFINER` function in the schema is declared `set search_path = ''` with fully
qualified references, and derives the acting tenant internally through one of four resolvers:

| Resolver | Returns | Used by |
| --- | --- | --- |
| `public.get_vendor_super_admin_context()` | Vendor org id + caller's name (0 args) | Every Vendor-side write and read RPC |
| `public.resolve_retailer_owner_organization(text)` | Retailer org id, `RETAILER_OWNER` only | Retailer Owner portal reads |
| `public.resolve_retailer_member_organization(text)` | Retailer org id, any retailer role holding the named permission | Staff, receipts, retailer product reads |
| `public.has_organization_permission(uuid, text)` | boolean | RLS policies and in-function permission gates |

None of these accepts a user id, and neither `resolve_*` helper is granted to `authenticated`
— they are internal to definer functions.

**Client-supplied ids are addresses, never authorization.** `p_relationship_id`,
`p_product_id`, `p_shop_id`, `p_invitation_id` are all re-verified against the internally
derived tenant with a two-column filter (`id = $1 AND <tenant column> = <derived id>`) before
use. A foreign id selects zero rows and yields the same generic `42501` as "not authorized",
so no function is an existence oracle.

**Tables are default-deny for writes, everywhere.** `authenticated` holds `SELECT` and
nothing else on ten tables, and **no privilege at all** on `retailer_invitations`,
`retailer_staff_invitations`, `retailer_invitation_shop_assignments`,
`retailer_shop_members`, `receipt_submissions`, `vendor_products`,
`vendor_product_retailer_assignments`, and `iso_country_codes`. There is not one
`INSERT`/`UPDATE`/`DELETE` RLS policy in the entire schema.

**Storage is fully server-mediated.** The `receipts` bucket is `public = false`, and
`storage.objects` / `storage.buckets` carry RLS with **zero policies** — deliberately. Only
the service-role key can read or write an object.

**Consequence for Flutter.** Everything a mobile client needs to *authorize* already works
identically over the Supabase Dart SDK, because the decision is made in Postgres from the
JWT. Flutter does not need — and must not be given — any tenant, role, or permission
knowledge it could tamper with.

---

## 2. The service-role / secret surface

Everything in this section is **unreachable from Flutter by design** and must stay that way.
This is the definitive list required by audit item 6.

### 2.1 The only service-role client

`lib/supabase/admin.ts` is the single service-role client in the codebase. It has a
module-scope browser guard, is constructed lazily, disables session persistence/refresh/URL
detection, and reads `SUPABASE_SERVICE_ROLE_KEY` (deliberately *not* via
`lib/env/supabase.ts`, which is imported by browser code).

### 2.2 Functions granted to `service_role` only

| Function | Why it cannot be client-callable |
| --- | --- |
| `finalize_retailer_owner_invitation(uuid, uuid)` | Provisions a profile + membership + `RETAILER_OWNER` role for an **arbitrary** auth user id. It has no `auth.uid()` to check because the invitee has no session yet. |
| `prepare_existing_user_retailer_owner_invitation(uuid, text)` | Writes the invitation `token_hash`. |
| `record_existing_user_retailer_owner_invitation_sent(uuid)` | Asserts an email was delivered. |
| `record_retailer_owner_invitation_failure(uuid, text)` | Writes a failure classification. |
| `prepare_retailer_staff_invitation(uuid, text)` | Writes `token_hash` **and returns the invitee's email, name, retailer name and role** — a recipient-identity read. |
| `record_retailer_staff_invitation_sent(uuid, text)` | Delivery assertion + audit write. |
| `record_retailer_staff_invitation_failure(uuid, text)` | Delivery-failure assertion + audit write. |
| `get_retailer_staff_registration_context(text)` | Given only a token hash, returns the **invited email address** and whether an auth account exists. Anonymous-equivalent identity disclosure. |
| `finalize_receipt_submission_upload(uuid, text, text, text, bigint)` | Asserts a Storage object exists; must only be callable by whoever performed the upload. |
| `record_receipt_submission_upload_failure(uuid, text)` | Same. |

### 2.3 Auth Admin API usage

| Call site | API | Purpose |
| --- | --- | --- |
| `lib/invitations/retailer-owner-invitations.ts` | `auth.admin.inviteUserByEmail` | Mint an auth user for a new Retailer Owner |
| `lib/staff/staff-registration.ts` | `auth.admin.createUser({ email_confirm: true })` | Activate an invited staff account against the invitation-derived email |

Both are inherently service-role. **The second one is security-critical**: the email is taken
from `get_retailer_staff_registration_context()` — it is *never* accepted from the client —
which is what stops an attacker registering someone else's invited address.

### 2.4 Resend (third-party email)

`lib/invitations/resend-email.ts` and `lib/staff/staff-invitation-email.ts` POST to
`https://api.resend.com/emails` with `RESEND_API_KEY` and `RESEND_FROM`. Server-only.

### 2.5 Invitation tokens and hashes

- Raw token: `randomBytes(32).toString("base64url")`, generated in
  `lib/invitations/existing-user-token.ts`.
- Only the **SHA-256 hex hash** is stored (`token_hash`, constrained `^[0-9a-f]{64}$`, with a
  partial unique index). The raw token exists only in the email body.
- Web handoff: `/invitations/existing/enter` and `/invitations/staff/enter` accept
  `?token=`, hash it server-side, set an `HttpOnly` cookie, redirect to a clean path, and set
  `Referrer-Policy: no-referrer`. **The raw token never reaches a rendered page or an RSC
  payload.**
- Acceptance RPCs (`get_pending_existing_user_retailer_invitation`,
  `accept_existing_user_retailer_owner_invitation`,
  `get_retailer_staff_invitation_for_recipient`, `accept_retailer_staff_invitation`) take the
  **hash**, are granted to `authenticated`, and additionally require
  `auth.users.email_confirmed_at IS NOT NULL` **and** `lower(btrim(email)) = invitation.email`.

**Mobile consequence.** A Flutter client *can* safely call the hash-taking acceptance RPCs,
because the hash is useless without a confirmed matching session. It must compute the SHA-256
itself from the deep-link token and must never persist the raw token.

### 2.6 Emails used for identity verification

`finalize_retailer_owner_invitation`, `accept_existing_user_retailer_owner_invitation`,
`get_retailer_staff_invitation_for_recipient`, `accept_retailer_staff_invitation` and
`get_retailer_staff_registration_context` all read `auth.users.email` inside a definer
function. No client anywhere supplies an email for an identity check.

### 2.7 Storage service access

`admin.storage.from("receipts").upload(...)` and `.remove(...)` in
`lib/receipts/receipt-submissions.ts`. There is **no signed-URL or download path anywhere in
the codebase** — no receipt image can currently be read back by anyone through the
application.

### 2.8 Future OCR credentials

None exist yet. When they arrive they belong on the same side of the boundary as Resend:
server-only, invoked from an Edge Function that the mobile client calls with its own JWT.

### 2.9 Private environment variables

`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `APP_ORIGIN`,
`RETAILER_OWNER_INVITATIONS_ENABLED`, `RETAILER_OWNER_EXISTING_USER_INVITATIONS_ENABLED`,
`RETAILER_STAFF_INVITATIONS_ENABLED`. Only `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are public — those two are the only values a Flutter
build may embed.

**Note on the three feature flags:** they are read server-side per request and are *not*
observable by any client. A Flutter app that calls a shared Edge Function inherits them
automatically; a Flutter app that reimplements a flow would silently bypass the kill switch.
This is an argument for Edge Functions over reimplementation.

---

## 3. Operation inventory

### 3.1 Authentication (all roles)

---

#### AUTH-01 — Sign in with password

| Field | Value |
| --- | --- |
| Feature | Email + password sign-in |
| Role | All |
| Permission | none |
| Web route | `/login` |
| Server Action | `signIn` — `app/login/actions.ts` |
| Existing RPC / table op | `supabase.auth.signInWithPassword`, then `resolveAuthenticatedLanding()` |
| Inputs | `email`, `password`, optional `next` |
| Backend-resolved | Session, JWT claims |
| Returns | Redirect to a landing route, or `{ error }` |
| Errors | Generic `"Unable to sign in with those credentials."` — never distinguishes unknown user from wrong password |
| RLS & authorization | Supabase Auth; landing then calls the two authorization resolvers |
| Tables | via RPC only |
| Storage bucket | — |
| Idempotency | n/a |
| Flutter direct? | **Yes** for the auth call. **No** for the landing decision. |
| Classification | **A** (auth) + **E** (landing) |
| Backend change | None. The landing precedence lives in `lib/auth/landing-decision.ts`, a pure module — port it to Dart, or better, derive it in Flutter from the same two RPCs (see § 4.1). |
| Tests | `lib/auth/landing-decision.test.ts` (19), `lib/auth/safe-next-path.test.ts` (3), `lib/auth/unified-login-activation.test.ts` (41) |

**Note.** `resolveSafeNextPath` guards against open redirects for a browser `?next=`
parameter. Flutter has no equivalent surface; it should use typed routes and ignore this.

---

#### AUTH-02 — Sign out

| Field | Value |
| --- | --- |
| Feature | Sign out |
| Role | All |
| Permission | none |
| Web route | any (header button) |
| Server Action | `signOut` — `app/auth/actions.ts` |
| Existing RPC / table op | `supabase.auth.signOut({ scope: "local" })` |
| Inputs | none |
| Backend-resolved | Session teardown |
| Returns | Redirect to `/login` |
| Errors | `{ error }` on failure |
| RLS & authorization | n/a |
| Tables | — |
| Storage bucket | — |
| Idempotency | Naturally idempotent |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None |
| Tests | — |

---

#### AUTH-03 — Resolve Vendor Super Admin context

| Field | Value |
| --- | --- |
| Feature | "Am I a Vendor Super Admin, and of which org?" |
| Role | Vendor Super Admin |
| Permission | role `VENDOR_SUPER_ADMIN` (role-based, not permission-based) |
| Web route | `app/(admin)/layout.tsx` |
| Server Action | `getVendorSuperAdminAccess()` — `lib/auth/vendor-admin-access.ts` |
| Existing RPC | `public.get_vendor_super_admin_context()` — **0 args**, `authenticated` |
| Inputs | none |
| Backend-resolved | Everything: `auth.uid()` → ACTIVE profile → ACTIVE membership → ACTIVE `VENDOR` org → ACTIVE `VENDOR_SUPER_ADMIN` role |
| Returns | `setof (user_id, first_name, last_name, organization_id, organization_name)`, ordered by `organization_id`; **0 rows = not authorized** |
| Errors | Never raises. Fails closed to zero rows. |
| RLS & authorization | `SECURITY DEFINER`, hard-filtered to `auth.uid()` |
| Tables | `profiles`, `organization_members`, `organizations`, `member_roles`, `roles` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None. Flutter should replicate the web client's defence-in-depth check that `row.user_id == session.user.id`. |
| Tests | — (indirectly via `landing-decision.test.ts`) |

---

#### AUTH-04 — Resolve Retailer portal access (owner / reader / submitter)

| Field | Value |
| --- | --- |
| Feature | Which retailer-side experience the caller qualifies for |
| Role | Retailer Owner, Retailer Manager, Sales Staff |
| Permission | `RETAILER_PORTAL_READ` / `RETAILER_STAFF_READ` / `RECEIPT_SUBMIT` |
| Web route | `app/(retailer)/retailer/layout.tsx` |
| Server Action | `getRetailerPortalAccess()` — `lib/staff/retailer-staff-access.ts` |
| Existing RPC | Probes in order: `get_retailer_owner_portal_context()` → `list_retailer_staff_members()` → `list_my_assigned_receipt_shops()` |
| Inputs | none |
| Backend-resolved | Retailer org id, role, permission |
| Returns | `owner` / `reader` / `submitter` / `unauthenticated` / `unauthorized` / `unavailable` |
| Errors | Each probe collapses `42501` → denied; transport → unavailable |
| RLS & authorization | Three definer RPCs, each `auth.uid()`-scoped |
| Tables | via RPC only |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes**, but only by re-running the same three-probe sequence — the *composition* is TypeScript-only |
| Classification | **A** (the probes) + **C** (the composition) — **the composition is now DELIVERED, see AUTH-05** |
| Backend change | **DONE.** `public.get_my_portal_context()` was added in migration `20260729090000_shared_portal_context.sql`. See AUTH-05 for its contract. The three-probe sequence above is still what the *web* does today; the web migration is deliberately deferred (see AUTH-05's integration note). |
| Tests | `lib/staff/portal-access-decision.test.ts` (23) |

---

#### AUTH-05 — Resolve the caller's application context (shared, both clients)

| Field | Value |
| --- | --- |
| Feature | One trusted answer to "who is this caller, and which experience do they get?" |
| Role | All four — Vendor Super Admin, Retailer Owner, Retailer Manager, Sales Staff |
| Permission | None of its own. It **reports** the decisions the existing resolvers make. |
| Web route | Not yet consumed by the web — see the integration note below |
| Server Action | — |
| Existing RPC | **`public.get_my_portal_context()`** (migration `20260729090000`) |
| Inputs | **none** — zero arguments, by design |
| Backend-resolved | Everything: vendor org, retailer org, experience kind, and seven capability hints |
| Returns | A single `jsonb` value, never SQL NULL. See the shape below. |
| Errors | **Raises nothing.** Denial is a value (`portal_kind: "NONE"`), so an exception can only mean an operational failure — which is exactly what makes `unavailable` distinguishable from `unauthorized`. |
| RLS & authorization | `SECURITY DEFINER`, `search_path = ''`, fully qualified. Delegates every decision to `get_vendor_super_admin_context()`, `resolve_retailer_owner_organization()` and `resolve_retailer_member_organization()` — it reimplements no part of the membership/role/permission chain. |
| Tables | `public.organizations`, and only for the display name, addressed by an id a resolver already authorized |
| Storage bucket | — |
| Idempotency | Read-only, `STABLE` |
| Flutter direct? | **Yes.** This is the intended first call after sign-in. |
| Classification | **A** |
| Backend change | None outstanding |
| Tests | `supabase/tests/database/portal_context_test.sql` (pgTAP, behavioural) + `lib/portal/portal-context-contract.test.ts` (24, static contract guards) |

**Result shape** (additive — new keys may appear without a version bump):

```jsonc
{
  "context_version": 1,
  "portal_kind": "VENDOR_SUPER_ADMIN" | "RETAILER_OWNER" | "RETAILER_MANAGER"
                 | "SALES_STAFF" | "NONE",
  "vendor":   null | { "organization_id": uuid, "organization_name": text },
  "retailer": null | {
    "kind": "RETAILER_OWNER" | "RETAILER_MANAGER" | "SALES_STAFF",
    "organization_id": uuid,
    "organization_name": text,
    "capabilities": {
      "view_retailer_overview": bool, "view_shops": bool, "view_staff": bool,
      "manage_staff": bool, "assign_staff_shops": bool,
      "view_assigned_products": bool, "submit_receipts": bool
    }
  }
}
```

Four things a client must get right:

1. **`portal_kind` is vendor-first**, reproducing `selectLanding()`. But `vendor` and
   `retailer` are resolved **independently**, so a caller holding both roles receives
   both blocks — the Retailer portal shell reads `retailer` and ignores precedence,
   matching what `getRetailerPortalAccess()` does today.
2. **Denial is a value, not an error.** `portal_kind: "NONE"` → unauthorized. A raised
   exception → unavailable. Never collapse one into the other.
3. **`capabilities` are presentation hints, never authorization.** Each is computed by
   calling the *same resolver with the same permission code* that the operation it
   describes calls, so a hint cannot drift from its gate — but the database still decides
   again on every call.
4. **`view_shops` is `false` for a Retailer Manager** even though a Manager *holds*
   `RETAILER_SHOPS_READ`, because `list_retailer_owner_portal_shops()` resolves through
   the **owner** resolver, which hard-filters `r.code = 'RETAILER_OWNER'`. This is why the
   capabilities are resolver-derived and not permission-derived; a
   `has_organization_permission()` implementation would have reported `true` and sent both
   clients to a screen the database refuses.

**Web integration is deliberately NOT done in the same change.** Migrating
`getRetailerPortalAccess()` / `resolveAuthenticatedLanding()` onto this RPC would collapse
up to four round trips into one, but it would also change two shipped behaviours: a
Retailer Manager's header would begin showing their Retailer name (it is `null` today,
because no installed RPC could supply it), and the `unavailable` signal would come from one
call failing rather than from three probes failing independently. Both are improvements;
neither is behaviour-preserving, so they belong in their own reviewable change.

---

### 3.2 Vendor Super Admin

---

#### V-01 — Vendor dashboard summary

| Field | Value |
| --- | --- |
| Feature | Member / role / permission / audit counts |
| Role | Vendor Super Admin |
| Permission | `ORGANIZATION_MEMBERS_READ`, `RBAC_READ`, `AUDIT_LOGS_READ` (via RLS) |
| Web route | `/` |
| Server Action | `lib/dashboard/vendor-admin-summary.ts` |
| Existing table op | Four `head: true, count: "exact"` reads on `organization_members`, `roles`, `permissions`, `audit_logs` |
| Inputs | none |
| Backend-resolved | `organizationId` from AUTH-03 |
| Returns | Four counts |
| Errors | Any read failure → `null` counts, page still renders |
| RLS & authorization | Migration-5 SELECT policies; counts are already permission-filtered by RLS |
| Tables | `organization_members`, `roles`, `permissions`, `audit_logs` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes, but four round trips.** Technically B; practically poor on mobile. |
| Classification | **B** → recommend **C** |
| Backend change | **Recommended:** `public.get_vendor_admin_dashboard_summary()` returning one row of four `bigint`s. |
| Tests | — |

---

#### V-02 — Organization members directory

| Field | Value |
| --- | --- |
| Feature | List Vendor org members with their roles |
| Role | Vendor Super Admin |
| Permission | `ORGANIZATION_MEMBERS_READ`, `RBAC_READ` |
| Web route | `/users` |
| Server Action | `lib/members/vendor-organization-members.ts` |
| Existing table op | Four sequential reads: `organization_members` → `profiles` → `member_roles` → `roles`, joined in TypeScript |
| Inputs | none |
| Backend-resolved | `organizationId` from AUTH-03 |
| Returns | Member rows with display name, status, role names |
| Errors | Fails to `null` list |
| RLS & authorization | Migration-5 policies enforce both the org scope and the permission |
| Tables | `organization_members`, `profiles`, `member_roles`, `roles` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes**, but it would duplicate a four-query client-side join |
| Classification | **B** → recommend **C** |
| Backend change | **Recommended:** `public.list_vendor_organization_members()`. The join is business shape, not presentation, and duplicating it in Dart is exactly the drift risk this audit exists to prevent. |
| Tests | — |

---

#### V-03 — Roles & permissions catalogue

| Field | Value |
| --- | --- |
| Feature | View the RBAC catalogue |
| Role | Vendor Super Admin |
| Permission | `RBAC_READ` |
| Web route | `/roles` |
| Server Action | `lib/rbac/vendor-rbac-catalog.ts` |
| Existing table op | `roles`, `permissions`, `role_permissions` selects, joined in TypeScript |
| Inputs | none |
| Backend-resolved | Visibility, by RLS |
| Returns | Roles with their mapped permissions |
| Errors | Fails to null |
| RLS & authorization | Global catalogue, visible only to a caller holding `RBAC_READ` in one of their own orgs |
| Tables | `roles`, `permissions`, `role_permissions` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes** |
| Classification | **B** |
| Backend change | None required. `list_vendor_rbac_catalog()` optional, low priority — the catalogue is small and static. |
| Tests | — |

---

#### V-04 — Audit log feed

| Field | Value |
| --- | --- |
| Feature | Latest 100 audit records with actor names |
| Role | Vendor Super Admin |
| Permission | `AUDIT_LOGS_READ` |
| Web route | `/audit-logs` |
| Server Action | `lib/audit/vendor-audit-logs.ts` |
| Existing table op | `audit_logs` (limit 100, desc) then `profiles` for actor names |
| Inputs | none |
| Backend-resolved | `organizationId` |
| Returns | `occurredAt`, `actorDisplayName`, `action`, `entityType` |
| Errors | Fails to null |
| RLS & authorization | `audit_logs_select_authorized` — note it **excludes null-organization rows** in both branches, deliberately |
| Tables | `audit_logs`, `profiles` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes**, at the cost of the actor-name join and the label formatting |
| Classification | **B** → recommend **C** |
| Backend change | **Recommended:** `public.list_vendor_audit_logs(p_limit int default 100, p_before timestamptz default null)` — mobile needs cursor pagination, which the current fixed 100-row read does not offer. |
| Tests | — |

---

#### V-05 — Retailers directory

| Field | Value |
| --- | --- |
| Feature | List managed Retailers with shop counts |
| Role | Vendor Super Admin |
| Permission | `RETAILERS_READ` |
| Web route | `/retailers` |
| Server Action | `lib/retailers/vendor-retailers.ts` |
| Existing table op | `vendor_retailers` → `organizations` (`in`) → `retailer_shops` (`in`), counted and sorted in TypeScript |
| Inputs | none |
| Backend-resolved | Vendor org id |
| Returns | `relationshipId`, `retailerName`, `retailerStatus`, `relationshipStatus`, `shopCount` |
| Errors | Fails to null list |
| RLS & authorization | `vendor_retailers_select_vendor_authorized` (own-vendor column), `organizations_select_vendor_managed_retailers` and `retailer_shops_select_vendor_authorized` (via `has_vendor_retailer_permission`) |
| Tables | `vendor_retailers`, `organizations`, `retailer_shops` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes**, but it fetches every shop row purely to count them — poor on a mobile connection |
| Classification | **B** → **C, delivered** |
| Backend change | **DONE.** `public.list_vendor_retailers()` was added in migration `20260731090000_mobile_vendor_retailer_reads.sql`. Zero arguments; `authenticated`; permission `RETAILERS_READ`. Returns `(relationship_id, retailer_organization_id, retailer_name, retailer_status, relationship_status, relationship_created_at, shop_count, active_shop_count, owner_state)`, ordered by `retailer_name, relationship_id`. Counts are computed with `count(*)` / `count(*) filter (…)` in a `LEFT JOIN LATERAL`, so **one row per Retailer** crosses the wire instead of one row per shop, and the whole directory is **one round trip** instead of four. An unauthorized caller gets `42501`; a Vendor with no Retailers gets an **empty set**. `retailer_organization_id` is returned to close the two-address-space problem in § 6.8. The multi-query TypeScript assembly above is still what the *web* does — the web migration is deliberately deferred. |
| Tests | pgTAP `supabase/tests/database/vendor_retailer_reads_test.sql` (127); static `lib/retailers/vendor-retailer-reads-contract.test.ts` (33) |

---

#### V-06 — Retailer detail

| Field | Value |
| --- | --- |
| Feature | One Retailer: org fields, relationship status, shop list, owner status |
| Role | Vendor Super Admin |
| Permission | `RETAILERS_READ` |
| Web route | `/retailers/[relationshipId]` |
| Server Action | `lib/retailers/vendor-retailer-detail.ts` + `lib/retailers/vendor-retailer-owner-status.ts` |
| Existing ops | Three table reads + `public.get_vendor_retailer_owner_status(p_relationship_id uuid)` |
| Inputs | `relationshipId` (uuid) |
| Backend-resolved | Vendor org id; the relationship row is matched on `(id, vendor_organization_id)` |
| Returns | Detail object + owner status (`ACTIVE`/`PENDING`/`DELIVERY_FAILED`/`EXPIRED`/`NONE`, names, email, timestamps, `failure_code`, `invitation_kind`) |
| Errors | `42501` from the owner-status RPC for a foreign or unknown relationship id — identical to "not authorized" |
| RLS & authorization | Table reads under the migration-9 policies; the RPC re-derives the vendor and re-checks `RETAILERS_READ` |
| Tables | `vendor_retailers`, `organizations`, `retailer_shops`, `retailer_invitations`, `organization_members`, `member_roles`, `roles`, `profiles` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Partly.** Owner status = yes (A). The detail body = three more reads. |
| Classification | **A** + **B** → **C, delivered** |
| Backend change | **DONE.** `public.get_vendor_retailer_detail(p_relationship_id uuid)` was added in migration `20260731090000_mobile_vendor_retailer_reads.sql`, alongside the companion `public.list_vendor_retailer_shops(p_relationship_id uuid)`. Both `authenticated`, permission `RETAILERS_READ`.<br><br>Detail returns **one fixed-size row**: the nine list columns plus `country_code` and `default_currency`. Shops are **not nested** — a shop list is unbounded, so it is a separate call returning `(shop_id, shop_name, shop_code, city, country_code, shop_status)` ordered by `shop_name, shop_id`. `shop_id` is included, closing § 6.3 for this surface.<br><br>**A foreign, unknown, or null relationship id returns ZERO ROWS, not an error** — deliberately unlike `get_vendor_retailer_owner_status`, which raises `42501` for the same input. That function is **unchanged** and remains the only source of the owner card (name, email, `sent_at`/`expires_at`/`accepted_at`, `failure_code`, `invitation_kind`); the new reads carry only a coarse `owner_state` badge whose precedence is asserted equal to it. § 6.1's stability problem is therefore **not** made worse, and **not** fixed. |
| Tests | `lib/retailers/owner-status-normalization.test.ts` (69); pgTAP `supabase/tests/database/vendor_retailer_reads_test.sql` (127); static `lib/retailers/vendor-retailer-reads-contract.test.ts` (33) |

---

#### V-07 — Onboard a Retailer

| Field | Value |
| --- | --- |
| Feature | Create Retailer org + relationship + first shop + audit, atomically |
| Role | Vendor Super Admin |
| Permission | `RETAILERS_CREATE` |
| Web route | `/retailers/new` |
| Server Action | `onboardRetailer` — `app/(admin)/retailers/new/actions.ts` |
| Existing RPC | `public.onboard_vendor_retailer(text, text, text, text, text, text)` — `authenticated` |
| Inputs | `p_retailer_name`, `p_shop_name`, `p_country_code?`, `p_default_currency?`, `p_shop_code?`, `p_shop_city?` |
| Backend-resolved | **Everything identity-bearing**: vendor org id, actor profile id, all four statuses, all four generated uuids |
| Returns | `void` — ids are deliberately not returned |
| Errors | `42501` (generic, covers unauthenticated / not-a-vendor / lacks permission), `23514` for name/country/currency shape |
| RLS & authorization | `get_vendor_super_admin_context()` → `has_organization_permission(vendor, 'RETAILERS_CREATE')` |
| Tables | `organizations`, `vendor_retailers`, `retailer_shops`, `audit_logs` |
| Storage bucket | — |
| Idempotency | **None.** Two submits create two Retailers. Guarded only by the web form's redirect. |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None required. Server Action is a thin adapter: it validates ISO country codes client-side for a better message (`lib/reference/iso-country-codes.ts`, byte-equivalent to `public.iso_country_codes`) and maps the RPC result to form state. Flutter must ship its own copy of that list or accept the round-trip error. |
| Tests | — |

---

#### V-08 — Add a shop to an existing Retailer

| Field | Value |
| --- | --- |
| Feature | Add one shop + audit, atomically |
| Role | Vendor Super Admin |
| Permission | `RETAILER_SHOPS_CREATE` |
| Web route | `/retailers/[relationshipId]/shops/new` |
| Server Action | `addVendorRetailerShop` |
| Existing RPC | `public.add_vendor_retailer_shop(uuid, text, text, text, text)` — `authenticated` |
| Inputs | `p_relationship_id`, `p_shop_name`, `p_shop_code?`, `p_shop_city?`, `p_country_code?` |
| Backend-resolved | Vendor org id, retailer org id (read out of the verified relationship row), actor, shop id, status |
| Returns | `void` |
| Errors | `42501` generic; `55000`-equivalent `23514` for inactive relationship/retailer; `23505` for a duplicate shop code |
| RLS & authorization | Context → permission → ownership (`vr.id = $1 AND vr.vendor_organization_id = <derived>`) → active-write gate |
| Tables | `retailer_shops`, `audit_logs` |
| Storage bucket | — |
| Idempotency | Duplicate *code* protected by `retailer_shops_org_code_unique_idx`; duplicate *name* is not |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None. Adapter maps `23505` → a field error on shop code. |
| Tests | — |

---

#### V-09 — Invite the first Retailer Owner (new-user flow)

| Field | Value |
| --- | --- |
| Feature | Invite an owner who has no SalesReward account |
| Role | Vendor Super Admin |
| Permission | `RETAILER_OWNERS_INVITE` |
| Web route | `/retailers/[relationshipId]/owner/invite` |
| Server Action | `inviteRetailerOwnerAction` → `inviteRetailerOwner()` — `lib/invitations/retailer-owner-invitations.ts` |
| Existing ops | 1. `reserve_retailer_owner_invitation(uuid,text,text,text)` — **authenticated**<br>2. `admin.auth.admin.inviteUserByEmail(email, { redirectTo })` — **service role**<br>3. `finalize_retailer_owner_invitation(uuid, uuid)` — **service_role**<br>4. `record_retailer_owner_invitation_failure(uuid, text)` on any failure — **service_role** |
| Inputs | `relationshipId`, `email`, `firstName`, `lastName` |
| Backend-resolved | Vendor org, retailer org, role id (`RETAILER_OWNER`, by code), inviter profile id, expiry (`now() + 24h`), canonical email |
| Returns | `{ invitation_id, normalized_email, is_resend }` from step 1; the Server Action returns a UI status |
| Errors | `23505` "already has an owner", `55000` inactive, `23514` invalid input, `42501` refused. Auth failures classify to `EXISTING_ACCOUNT` / `AUTH_DISPATCH_FAILED` / `FINALIZATION_FAILED`. |
| RLS & authorization | Step 1 under the caller's token. Steps 2–4 carry no `auth.uid()` — their authorization is the *durable evidence* the reservation wrote. |
| Tables | `retailer_invitations`, `profiles`, `organization_members`, `member_roles`, `audit_logs`, `auth.users` |
| Storage bucket | — |
| Idempotency | Yes, throughout: partial unique index on `(retailer_organization_id, email) WHERE status='PENDING'`; `is_resend`; `ON CONFLICT DO NOTHING` on membership and role; audit guarded on `sent_at` |
| Flutter direct? | **No.** Steps 2–4 require the service-role key. |
| Classification | **D** |
| Backend change | **Edge Function `invite-retailer-owner`.** It must verify the caller's JWT, then run the identical 4-step sequence. It must not accept an org id or actor id. Also gated by `RETAILER_OWNER_INVITATIONS_ENABLED`. |
| Tests | `lib/retailers/owner-status-normalization.test.ts` (69) covers the plan/classification logic |

**Server Action verdict (audit item 5): NOT a thin adapter.** `inviteRetailerOwnerAction`
contains real business logic Flutter would otherwise duplicate:
- the feature-flag kill switch,
- a **pre-flight owner-status read** (`getVendorRetailerOwnerStatus`) feeding
  `planInvitationSubmit()`, which decides whether this submit is a fresh invite or a resend
  and blocks `blocked-active` / `blocked-existing-account` / `blocked-finalization` states,
- on a resend, it **substitutes the stored email** and ignores the typed one,
- error-code → field mapping.

None of that lives in SQL. It belongs in the Edge Function, not in Dart.

---

#### V-10 — Invite an existing account as Retailer Owner

| Field | Value |
| --- | --- |
| Feature | Invite an owner who already has a SalesReward account |
| Role | Vendor Super Admin |
| Permission | `RETAILER_OWNERS_INVITE` |
| Web route | same page |
| Server Action | `sendExistingUserRetailerOwnerInvitationAction` → `sendExistingUserRetailerOwnerInvitation()` |
| Existing ops | 1. `reserve_retailer_owner_invitation` — **authenticated**<br>2. `generateInvitationToken()` (Node crypto) — **server**<br>3. `prepare_existing_user_retailer_owner_invitation(uuid,text)` — **service_role**<br>4. Resend HTTP POST — **server secret**<br>5. `record_existing_user_retailer_owner_invitation_sent(uuid)` / `record_retailer_owner_invitation_failure(uuid,'EXISTING_USER_EMAIL_FAILED')` — **service_role** |
| Inputs | `relationshipId` only — the email, first and last name are read from the existing invitation row |
| Backend-resolved | Everything, including the recipient email |
| Returns | UI status |
| Errors | `sent` / `email-failed` / `blocked-active` / `blocked` / `misconfigured` / `unavailable` |
| RLS & authorization | Step 1 under the caller's token; the rest is post-authorization execution |
| Tables | `retailer_invitations`, `organizations` |
| Storage bucket | — |
| Idempotency | `token_hash` is unique and rotated on each prepare; `expires_at` reset to +24h; resend detected via `is_resend` |
| Flutter direct? | **No** — token generation, Resend, and three service-role RPCs |
| Classification | **D** |
| Backend change | **Edge Function `send-existing-user-owner-invitation`.** Gated by `RETAILER_OWNER_EXISTING_USER_INVITATIONS_ENABLED`. |
| Tests | `lib/invitations/existing-user-token.test.ts` (10), `lib/invitations/resend-email.test.ts` (12), `lib/features/existing-user-invitations.test.ts` (6) |

**Server Action verdict: NOT a thin adapter.** It gates on the flag, reads the retailer detail
+ owner status, runs `classifyOwnerAction()` / `isExistingUserActionPlan()` to decide
eligibility, and only then dispatches.

---

#### V-11 — Revoke a Retailer Owner invitation

| Field | Value |
| --- | --- |
| Feature | Withdraw a pending owner invitation |
| Role | Vendor Super Admin |
| Permission | `RETAILER_OWNERS_INVITE` (deliberately the same permission as issuing) |
| Web route | **none — not wired into the UI** |
| Server Action | **none** |
| Existing RPC | `public.revoke_retailer_owner_invitation(uuid)` — `authenticated` |
| Inputs | `p_invitation_id` |
| Backend-resolved | Vendor org id; invitation matched on `(id, vendor_organization_id)` |
| Returns | `void` |
| Errors | `42501` for unknown / foreign / non-`PENDING` alike |
| RLS & authorization | Context → permission → ownership |
| Tables | `retailer_invitations`, `organization_members`, `audit_logs` |
| Storage bucket | — |
| Idempotency | `WHERE status = 'PENDING'` on both updates |
| Flutter direct? | **Yes** |
| Classification | **A** (backend) + **F** (product) |
| Backend change | None. **But note:** this is a fully built, granted, audited capability with *no caller anywhere in the codebase*. Confirm whether mobile should surface it — and if so, whether web should too. |
| Tests | — |

---

#### V-12 — List Vendor products

| Field | Value |
| --- | --- |
| Feature | Product catalogue with active-assignment counts |
| Role | Vendor Super Admin |
| Permission | `PRODUCTS_READ` |
| Web route | `/products` |
| Server Action | `getVendorProducts()` — `lib/products/vendor-products.ts` |
| Existing RPC | `public.list_vendor_products()` — `authenticated`, 0 args |
| Inputs | none |
| Backend-resolved | Vendor org id |
| Returns | `setof (product_id, product_code, barcode, product_name, brand, description, status, active_assignment_count, created_at, updated_at)` |
| Errors | `42501` |
| RLS & authorization | Context → `PRODUCTS_READ`; tables are default-deny |
| Tables | `vendor_products`, `vendor_product_retailer_assignments` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None. `normalizeVendorProducts` is defensive shape validation, easily ported. |
| Tests | `lib/products/product-normalization.test.ts` (20), `lib/products/product-source-safety.test.ts` (20) |

---

#### V-13 — Create a product

| Field | Value |
| --- | --- |
| Feature | Add a product to the Vendor catalogue |
| Role | Vendor Super Admin |
| Permission | `PRODUCTS_MANAGE` |
| Web route | `/products` |
| Server Action | `createProductAction` |
| Existing RPC | `public.create_vendor_product(text, text, text, text, text)` — `authenticated` |
| Inputs | `p_product_code`, `p_product_name`, `p_barcode?`, `p_brand?`, `p_description?` |
| Backend-resolved | Vendor org, `created_by_profile_id`, status `ACTIVE`, id |
| Returns | `uuid` (the new product id) |
| Errors | `42501`; `23514` for each field rule; `23505` with **message-discriminated** duplicate code vs barcode |
| RLS & authorization | Context → permission |
| Tables | `vendor_products`, `audit_logs` |
| Storage bucket | — |
| Idempotency | `vendor_products_code_unique_idx`, `vendor_products_barcode_unique_idx` (partial) |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None functionally, but see § 6.4 — the duplicate discrimination relies on English message substrings. |
| Tests | `lib/products/product-input.test.ts` (24) |

---

#### V-14 — Update a product

Same shape as V-13. RPC `public.update_vendor_product(uuid, text, text, text, text)`,
`authenticated`. `product_code`, `vendor_organization_id` and `created_by_profile_id` are
**immutable by trigger**. No-op when nothing changed (returns early, writes no audit row).
**Classification: A.** Tests: `product-input.test.ts`.

---

#### V-15 — Activate / deactivate a product

RPC `public.set_vendor_product_status(uuid, text)`, `authenticated`. `p_status` is
normalized `upper(btrim(...))` and must be `ACTIVE`/`INACTIVE`. No-op when unchanged.
Audits `PRODUCT_ACTIVATED` / `PRODUCT_DEACTIVATED`. **Classification: A.**

---

#### V-16 — List a product's Retailer assignments

RPC `public.list_vendor_product_retailer_assignments(uuid)`, `authenticated`, permission
`PRODUCT_RETAILER_ASSIGN`. Returns **every** Retailer the Vendor manages with a LEFT JOIN to
the assignment — so an unassigned Retailer appears with `assignment_status = null`. Web route
`/products/[productId]`. **Classification: A.**

---

#### V-17 — Assign a product to a Retailer

RPC `public.assign_vendor_product_to_retailer(uuid, uuid)`, `authenticated`, permission
`PRODUCT_RETAILER_ASSIGN`. Requires the product to be `ACTIVE` (`55000` otherwise) and the
relationship *and* Retailer org to be `ACTIVE`. Re-activates an `INACTIVE` assignment rather
than inserting a duplicate; returns silently if already `ACTIVE`. Returns `void`.
**Classification: A.** See § 6.6 — `void` + silent no-op is a weak contract for a client that
wants to know whether anything changed.

---

#### V-18 — Withdraw a product from a Retailer

RPC `public.unassign_vendor_product_from_retailer(uuid, uuid)`, `authenticated`. Sets the
assignment `INACTIVE`; never deletes. Silent no-op if absent or already `INACTIVE`.
**Classification: A.**

---

### 3.3 Retailer Owner

---

#### RO-01 — Portal overview

| Field | Value |
| --- | --- |
| Feature | Retailer name/status/country/currency + shop counts |
| Role | Retailer Owner |
| Permission | `RETAILER_PORTAL_READ` |
| Web route | `/retailer` |
| Server Action | `getRetailerOwnerPortalAccess()` |
| Existing RPC | `public.get_retailer_owner_portal_context()` — `authenticated`, 0 args |
| Inputs | none |
| Backend-resolved | Retailer org id via `resolve_retailer_owner_organization('RETAILER_PORTAL_READ')` |
| Returns | `setof (retailer_name, retailer_status, country_code, default_currency, membership_status, total_shop_count, active_shop_count)`; **0 rows = unauthorized** |
| Errors | Never raises |
| RLS & authorization | Definer; requires ACTIVE profile + membership + `RETAILER` org + ACTIVE `RETAILER_OWNER` role holding the permission |
| Tables | `organizations`, `organization_members`, `retailer_shops`, `member_roles`, `roles`, `role_permissions`, `permissions`, `profiles` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None |
| Tests | `lib/retailer-portal/portal-normalization.test.ts` (35) |

**Important behaviour:** `resolve_retailer_owner_organization` returns `NULL` when the caller
qualifies in **more than one** Retailer (`where (select count(*) from qualifying) = 1`). See
§ 7 Q2.

---

#### RO-02 — Own shops list

RPC `public.list_retailer_owner_portal_shops()`, `authenticated`, 0 args, permission
`RETAILER_SHOPS_READ`. Route `/retailer/shops`. Returns
`(shop_name, shop_code, city, country_code, shop_status)`.
**Classification: A.** ⚠️ **It returns no `shop_id`** — see § 6.3.

---

#### RO-03 — Assigned products

RPC `public.list_retailer_assigned_products()`, `authenticated`, 0 args, permission
`RETAILER_PRODUCTS_READ` (granted to `RETAILER_OWNER` **and** `RETAILER_MANAGER`). Route
`/retailer/products`. Returns only `ACTIVE` assignments of `ACTIVE` products.
**Classification: A.**

---

#### RO-04 — Staff roster

| Field | Value |
| --- | --- |
| Feature | List staff with roles and shop assignments |
| Role | Retailer Owner, Retailer Manager |
| Permission | `RETAILER_STAFF_READ` (+ `RETAILER_STAFF_MANAGE` widens visibility) |
| Web route | `/retailer/staff` |
| Server Action | `getRetailerStaffMembers()` |
| Existing RPC | `public.list_retailer_staff_members()` — `authenticated`, 0 args |
| Inputs | none |
| Backend-resolved | Retailer org id; **and `v_can_manage`** — a caller without `RETAILER_STAFF_MANAGE` sees only `ACTIVE` members |
| Returns | `(membership_id, first_name, last_name, role_code, role_name, membership_status, shop_ids[], shop_names[], joined_at, created_at)` |
| Errors | `42501` |
| RLS & authorization | `resolve_retailer_member_organization('RETAILER_STAFF_READ')` then an in-function permission probe |
| Tables | `organization_members`, `profiles`, `member_roles`, `roles`, `retailer_shop_members`, `retailer_shops` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None. This is a model contract: the *role difference* is resolved in SQL, so Flutter gets the correct rows without knowing the rule. |
| Tests | `lib/staff/staff-normalization.test.ts` (23), `lib/staff/staff-source-safety.test.ts` (19) |

---

#### RO-05 — Staff invitations list

RPC `public.list_retailer_staff_invitations()`, `authenticated`, 0 args, permission
`RETAILER_STAFF_MANAGE`. Returns a server-computed `derived_state`
(`REVOKED`/`ACCEPTED`/`EXPIRED`/`DELIVERY_FAILED`/`PENDING`/`RESERVED`) plus timestamps,
`failure_code` and `shop_ids[]`. **Classification: A.** ⚠️ See § 6.2 — the `CASE` has no
`ELSE`, so `derived_state` can be `NULL`.

---

#### RO-06 — Assignable shops

RPC `public.list_retailer_staff_assignable_shops()`, `authenticated`, 0 args, permission
`RETAILER_STAFF_SHOP_ASSIGN`. Returns `(shop_id, shop_name, shop_code, city)` for `ACTIVE`
shops. **Classification: A.**

---

#### RO-07 — Invite a staff member

| Field | Value |
| --- | --- |
| Feature | Invite a Retailer Manager or Sales Staff member |
| Role | Retailer Owner |
| Permission | `RETAILER_STAFF_MANAGE` (+ `RETAILER_STAFF_SHOP_ASSIGN` for the shop list) |
| Web route | `/retailer/staff` |
| Server Action | `inviteStaffAction` → `sendRetailerStaffInvitation()` → `runStaffInviteFlow()` |
| Existing ops | 1. `reserve_retailer_staff_invitation(text,text,text,text,uuid[])` — **authenticated**<br>2. `generateInvitationToken()` — server<br>3. `prepare_retailer_staff_invitation(uuid,text)` — **service_role**, returns recipient identity<br>4. Resend POST — **server secret**<br>5. `record_retailer_staff_invitation_sent(uuid,text)` / `record_retailer_staff_invitation_failure(uuid,text)` — **service_role** |
| Inputs | `email`, `firstName`, `lastName`, `roleCode`, `shopIds[]` |
| Backend-resolved | Retailer org, actor, role id (by code, restricted to `RETAILER_MANAGER`/`SALES_STAFF`), expiry, canonical email, `token_hash` |
| Returns | `{ invitation_id, normalized_email, is_resend }`, then a UI status |
| Errors | `42501` refused; `55000` retailer not active; `23514` for shape, role/shop mismatch, existing membership, suspended recipient; message-discriminated conflict |
| RLS & authorization | Step 1 under the caller's token; steps 3–5 are post-authorization execution |
| Tables | `retailer_staff_invitations`, `retailer_invitation_shop_assignments`, `retailer_shops`, `organizations`, `organization_members`, `profiles`, `roles`, `auth.users`, `audit_logs` |
| Storage bucket | — |
| Idempotency | Partial unique index on `(retailer_organization_id, email) WHERE status='PENDING'`; an in-function `unique_violation` handler re-selects and treats it as a resend; role/shop changes are **refused**, not silently applied |
| Flutter direct? | **No** — steps 2–5 |
| Classification | **D** |
| Backend change | **Edge Function `send-staff-invitation`.** Gated by `RETAILER_STAFF_INVITATIONS_ENABLED`. |
| Tests | `lib/staff/staff-invite-flow.test.ts` (18), `lib/staff/staff-invite-input.test.ts` (20), `lib/staff/staff-invitation-email.test.ts` (18), `lib/features/retailer-staff-invitations.test.ts` (6) |

**Server Action verdict: mixed.** `runStaffInviteFlow` (`lib/staff/staff-invite-flow.ts`) is
pure orchestration behind a ports interface and is genuinely portable. But
`inviteStaffAction` above it holds real logic: the feature flag, and
`validateStaffInviteInput(values, assignableShopIds)` — which **validates the submitted shop
ids against the caller's assignable list before calling the RPC**. The database also enforces
this (`23514`), so it is defence in depth rather than the only guard, but the *messages* are
client-side. Flutter would produce worse errors without it.

---

#### RO-08 — Resend a staff invitation

`resendStaffInvitationAction`. Reads the invitation list, finds the row, checks
`canResendInvitation(state)` **in TypeScript**, then re-runs the same five-step flow with the
**stored** email/name/role/shops — never the client's. **Classification: D.** The
`canResendInvitation` predicate is a business rule that must move into the shared Edge
Function or into SQL, otherwise Flutter will define "resendable" differently from web.

---

#### RO-09 — Revoke a staff invitation

RPC `public.revoke_retailer_staff_invitation(uuid)`, `authenticated`, permission
`RETAILER_STAFF_MANAGE`. Sweeps stale invitations first, then matches on
`(id, retailer_organization_id, status='PENDING')`. Clears `token_hash`. Audits
`STAFF_INVITATION_REVOKED`. **Deliberately not gated by the feature flag** — a kill switch
must never strand an owner mid-correction. **Classification: A.**

---

### 3.4 Retailer Manager

The Retailer Manager holds `RETAILER_PORTAL_READ`, `RETAILER_SHOPS_READ` and
`RETAILER_STAFF_READ` — and **not** `RETAILER_STAFF_MANAGE` or `RETAILER_STAFF_SHOP_ASSIGN`.

| Op | Feature | RPC | Class |
| --- | --- | --- | --- |
| RM-01 | Landing at `/retailer/staff` | via AUTH-04 | A + C |
| RM-02 | Staff roster, read-only, **ACTIVE members only** | `list_retailer_staff_members()` | **A** |
| RM-03 | Assigned products | `list_retailer_assigned_products()` | **A** |

RM-02 is worth calling out: the same RPC serves Owner and Manager, and the visibility
difference is decided by `has_organization_permission(v_retailer, 'RETAILER_STAFF_MANAGE')`
*inside* the function. A Flutter client needs no role logic at all.

⚠️ **`get_retailer_owner_portal_context()` will return zero rows for a Retailer Manager**,
because `resolve_retailer_owner_organization` hard-filters `r.code = 'RETAILER_OWNER'`. Mobile
must not treat that as an error. See § 7 Q3 — a Manager currently has **no** way to read their
own Retailer's name.

---

### 3.5 Sales Staff

---

#### SS-01 — List my assigned shops

RPC `public.list_my_assigned_receipt_shops()`, `authenticated`, 0 args, permission
`RECEIPT_SUBMIT`. Resolves the retailer, then joins `organization_members` →
`retailer_shop_members` (live rows only) → `retailer_shops` (`ACTIVE` only), filtered to
`m.user_id = auth.uid()`. Returns `(shop_id, shop_name, shop_code)`.
**Classification: A.** This is the cleanest mobile-ready contract in the schema.

---

#### SS-02 — Submit a receipt

| Field | Value |
| --- | --- |
| Feature | Photograph/select a receipt and submit it for an assigned shop |
| Role | Sales Staff |
| Permission | `RECEIPT_SUBMIT` |
| Web route | `/retailer/receipts` |
| Server Action | `submitReceiptAction` → `submitReceipt()` → `runReceiptSubmissionFlow()` |
| Existing ops | 1. `reserve_receipt_submission(uuid,text,text,bigint,text)` — **authenticated**<br>2. `admin.storage.from('receipts').upload(path, bytes)` — **service role**<br>3. `finalize_receipt_submission_upload(uuid,text,text,text,bigint)` — **service_role**<br>on failure: `admin.storage.remove([path])` + `record_receipt_submission_upload_failure(uuid,text)` — **service_role** |
| Inputs | `p_shop_id`, `p_original_file_name`, `p_mime_type`, `p_file_size_bytes`, `p_file_sha256` |
| Backend-resolved | Retailer org, membership, submitter profile, submission id, **and the entire Storage object path**: `<retailer>/<user>/<submission>/<random>.<ext>` |
| Returns | `(submission_id, storage_bucket, storage_object_path)` |
| Errors | `42501` not authorized / shop not assigned; `23514` bad file metadata; `23505` **"You have already submitted this receipt"** |
| RLS & authorization | Definer resolves retailer + membership + *live shop assignment*; the shop is locked `FOR SHARE` |
| Tables | `receipt_submissions`, `organization_members`, `retailer_shop_members`, `retailer_shops` |
| Storage bucket | **`receipts`** — private, 10 MiB limit, `image/jpeg|png|webp` only |
| Idempotency | `receipt_submissions_active_hash_unique_idx` on `(retailer_organization_id, submitted_by_profile_id, file_sha256) WHERE status <> 'UPLOAD_FAILED'` — the same photo cannot be submitted twice by the same person |
| Flutter direct? | **No.** Step 1 yes; steps 2–3 require the service-role key because Storage has zero policies. |
| Classification | **D** |
| Backend change | **Edge Function `submit-receipt`** (recommended) — accepts multipart, verifies the JWT, and runs reserve → upload → finalize with the service key. See § 4.4 for the alternative. |
| Tests | `lib/receipts/receipt-file.test.ts`, `lib/receipts/receipt-normalization.test.ts` (15), `lib/receipts/receipt-submission-flow.test.ts` (14), `lib/receipts/receipt-source-safety.test.ts` (18) |

**Server Action verdict: NOT a thin adapter — and this one is security-relevant.**
`lib/receipts/receipt-file.ts` performs **magic-byte sniffing** (`FF D8 FF`, PNG 8-byte
signature, `RIFF`+`WEBP`), computes the SHA-256, and sanitizes the filename (strips path
segments, control characters, collapses whitespace, caps at 255). The MIME type sent to the
database is the **sniffed** one, never the browser's declared `Content-Type`. If Flutter
computed its own MIME type from the file extension, a client could store a mislabelled object
— which matters once OCR consumes these files. `runReceiptSubmissionFlow` is also responsible
for **deleting the orphaned Storage object** when finalization fails; a client-side upload
cannot do that.

---

#### SS-03 — My receipt history

RPC `public.list_my_receipt_submissions()`, `authenticated`, 0 args, permission
`RECEIPT_SUBMIT`. Filtered to `submitted_by_profile_id = auth.uid()`. Returns
`(submission_id, shop_name, shop_code, status, original_file_name, mime_type,
file_size_bytes, submitted_at, created_at)`. **Classification: A.**

⚠️ **No image is retrievable.** There is no signed-URL path in the codebase and no Storage
policy. Mobile users will expect to tap a submission and see the photo. See § 7 Q1.

---

### 3.6 Invitation recipient flows

---

#### INV-01 — Retailer Owner accepts (new-user flow)

| Field | Value |
| --- | --- |
| Feature | Set a password and become the Retailer Owner |
| Role | invitee (no role yet) |
| Permission | none — the invitation *is* the authorization |
| Web route | `/invitations/accept` (Route Handler) → `/invitations/complete` |
| Handlers | `app/invitations/accept/route.ts` (GET), `completeInvitation` action |
| Existing ops | `auth.verifyOtp({ type: 'invite', token_hash })` → `auth.updateUser({ password })` → `public.accept_retailer_owner_invitation()` — **authenticated, 0 args** |
| Inputs | `token_hash` + `type=invite` in the URL; then `password`, `confirmPassword` |
| Backend-resolved | Everything. The RPC resolves the invitation **solely by `auth_user_id = auth.uid()`** |
| Returns | `void`; page reads `get_my_pending_retailer_invitation()` beforehand for display |
| Errors | One generic `42501` for every failure: no pending invitation, expired, revoked, retailer suspended, membership not `INVITED` |
| RLS & authorization | Zero arguments — there is no id a caller could substitute. A unique partial index guarantees at most one `PENDING` invitation per auth user. |
| Tables | `retailer_invitations`, `organization_members`, `profiles`, `vendor_retailers`, `organizations`, `audit_logs` |
| Storage bucket | — |
| Idempotency | Already-`ACCEPTED` for this user returns success (and repairs an `INVITED` profile to `ACTIVE`) |
| Flutter direct? | **Yes** — `verifyOtp`, `updateUser` and the RPC are all client-callable |
| Classification | **A** |
| Backend change | None. Requires deep-link handling for the emailed `redirectTo` URL. |
| Tests | `lib/auth/password-policy.test.ts` (15) |

---

#### INV-02 — Retailer Owner accepts (existing-account flow)

| Field | Value |
| --- | --- |
| Feature | An existing account accepts an owner invitation |
| Role | invitee |
| Permission | none |
| Web route | `/invitations/existing/enter` (GET) → `/invitations/existing` |
| Handlers | `app/invitations/existing/enter/route.ts`, `acceptExistingUserInvitationAction` |
| Existing ops | `hashInvitationToken(rawToken)` (server) → cookie → `public.get_pending_existing_user_retailer_invitation(text)` → `public.accept_existing_user_retailer_owner_invitation(text)` — both **authenticated** |
| Inputs | `?token=` (raw, base64url ≥43 chars) → SHA-256 hex hash |
| Backend-resolved | Invitation row by `token_hash`; identity by `auth.uid()`; **email equality against `auth.users.email` and `email_confirmed_at IS NOT NULL`** |
| Returns | `get_pending…` → `(retailer_name, expires_at, email_matches)`; `accept…` → `void` |
| Errors | `get_pending…` returns `(null,null,false)` on mismatch and zero rows if the token is unknown — it never raises. `accept…` raises one generic `42501`. |
| RLS & authorization | The hash alone is insufficient: a confirmed session whose email equals the invitation's is required |
| Tables | `retailer_invitations`, `auth.users`, `profiles`, `organization_members`, `member_roles`, `organizations`, `vendor_retailers`, `audit_logs` |
| Storage bucket | — |
| Idempotency | `token_hash` cleared on acceptance; `ON CONFLICT DO NOTHING` on membership and role |
| Flutter direct? | **Yes for the RPCs.** **No for the cookie handoff.** |
| Classification | **A** (RPCs) + **E** (link handoff) |
| Backend change | None. Flutter replaces the `/enter` route with a deep link: parse `token`, SHA-256 it in Dart, hold the **hash only** in secure storage, discard the raw token. |
| Tests | `lib/invitations/existing-user-token.test.ts` (10), `lib/invitations/existing-user-cookie-options.test.ts` (9) |

---

#### INV-03 — Staff member opens an invitation link

Route Handler `app/invitations/staff/enter/route.ts`: validates the raw token shape, hashes
it, sets an `HttpOnly` cookie, redirects to `/invitations/staff`, sets
`Referrer-Policy: no-referrer`. **Classification: E** — a browser-specific mechanism. Flutter
uses a deep link + `flutter_secure_storage`. Tests:
`lib/staff/staff-invite-cookie-options.test.ts` (6),
`lib/auth/staff-invitation-same-browser.test.ts` (30).

---

#### INV-04 — Decide "register" vs "sign in" for an invited staff address

| Field | Value |
| --- | --- |
| Feature | Show a password-creation form or a sign-in prompt |
| Role | invitee (may have no auth account) |
| Permission | none |
| Web route | `/invitations/staff` |
| Server module | `getStaffRegistrationView()` — `lib/staff/staff-registration.ts` |
| Existing RPC | `public.get_retailer_staff_registration_context(text)` — **`service_role` ONLY** |
| Inputs | `p_token_hash` |
| Backend-resolved | Invitation validity, retailer/role/shop consistency |
| Returns | `(invited_email, has_auth_account, expires_at)` |
| Errors | `23514` "This invitation is not available" for every invalid state |
| RLS & authorization | **None from a session** — the caller may be anonymous. The token hash is the only credential, which is exactly why it is `service_role`-only. |
| Tables | `retailer_staff_invitations`, `retailer_invitation_shop_assignments`, `retailer_shops`, `organizations`, `roles`, `auth.users` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **No** |
| Classification | **D** |
| Backend change | **Edge Function `staff-invitation-context`.** It must return only `{ mode: "register" \| "sign-in", expiresAt }` and **must not return `invited_email`** to the client — the web app deliberately keeps that server-side. |
| Tests | `lib/auth/unified-login-activation.test.ts` (41) |

---

#### INV-05 — Activate an invited staff account (create user + password)

| Field | Value |
| --- | --- |
| Feature | Create the auth account for an invited address and sign in |
| Role | invitee |
| Permission | none |
| Web route | `/invitations/staff` |
| Server Action | `activateStaffAccountAction` → `activateInvitedStaffAccount()` |
| Existing ops | `get_retailer_staff_registration_context` (**service_role**) → `auth.admin.createUser({ email: <derived>, password, email_confirm: true })` (**service role**) → `auth.signInWithPassword` |
| Inputs | `password`, `confirmPassword` — **and nothing else** |
| Backend-resolved | **The email address**, derived from the invitation token hash |
| Returns | `activated` / `already-registered` / `unavailable` |
| Errors | Generic; `email_exists` / 422 → `already-registered` → shows a sign-in prompt |
| RLS & authorization | The token hash is the credential. `email_confirm: true` is safe **only** because the address is server-derived and never client-supplied. |
| Tables | `auth.users` |
| Storage bucket | — |
| Idempotency | `already-registered` is a first-class outcome |
| Flutter direct? | **No** |
| Classification | **D** |
| Backend change | **Edge Function `activate-staff-account`** taking `{ tokenHash, password }` and returning a session or `already-registered`. **This is the single most security-sensitive endpoint to port** — if the email ever becomes a parameter, anyone can claim any invited address. |
| Tests | `lib/auth/unified-login-activation.test.ts` (41), `lib/auth/password-policy.test.ts` (15) |

---

#### INV-06 — View and accept a staff invitation

| Field | Value |
| --- | --- |
| Feature | Show what is being offered, then accept it |
| Role | invitee with a confirmed matching session |
| Permission | none |
| Web route | `/invitations/staff` |
| Server Action | `acceptStaffInvitationAction` → `acceptStaffInvitation()` |
| Existing RPCs | `public.get_retailer_staff_invitation_for_recipient(text)` and `public.accept_retailer_staff_invitation(text)` — both **`authenticated`** |
| Inputs | `p_token_hash` |
| Backend-resolved | Everything: retailer, role, shops, membership, profile activation |
| Returns | resolve → `(invitation_id, first_name, last_name, email, retailer_name, role_code, role_name, shop_names[], expires_at)`; accept → `void` |
| Errors | resolve returns **zero rows** for every failure; accept raises one generic `42501` |
| RLS & authorization | Requires `email_confirmed_at IS NOT NULL` **and** `lower(btrim(auth.users.email)) = invitation.email`; refuses if the caller already belongs to that Retailer; re-validates role/shop consistency and shop `ACTIVE` state under `FOR SHARE` |
| Tables | `retailer_staff_invitations`, `retailer_invitation_shop_assignments`, `retailer_shops`, `organizations`, `roles`, `profiles`, `organization_members`, `member_roles`, `retailer_shop_members`, `auth.users`, `audit_logs` |
| Storage bucket | — |
| Idempotency | `WHERE status='PENDING'` + `get diagnostics row_count = 1`; `token_hash` cleared |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | None |
| Tests | `lib/staff/staff-normalization.test.ts` (23), `lib/auth/staff-invitation-same-browser.test.ts` (30) |

---

### 3.7 Web-only surfaces (category E)

| Surface | Why it is web-only |
| --- | --- |
| `app/(admin)/*` and `app/(retailer)/*` layouts, shells, sidebars, nav, skeletons | Presentation |
| `proxy.ts` + `lib/supabase/proxy-routing.ts` | Cookie refresh + optimistic redirects. Flutter's SDK refreshes tokens itself; route guarding is a navigator concern. **Not a security boundary** — every layout re-verifies. Tests: `lib/supabase/proxy-routing.test.ts` (28) |
| `lib/auth/safe-next-path.ts` | Open-redirect guard for a browser query parameter |
| `/invitations/*/enter` Route Handlers + cookie modules | Token → hash → `HttpOnly` cookie handoff |
| `revalidatePath` calls throughout | Next.js cache invalidation |
| `lib/reference/iso-country-codes.ts` | A bundled copy of `public.iso_country_codes`, for a pre-flight message. Flutter may ship its own copy or accept the round trip. |
| Feature-flag reads (`lib/features/*`) | Server-only env vars; must move behind Edge Functions to remain effective |

---

## 4. Recommended shape for each server-only operation (audit item 7)

### 4.1 Keep as Postgres RPC — new

| Proposed RPC | Replaces | Why RPC and not Edge Function |
| --- | --- | --- |
| `get_my_portal_context()` | AUTH-04's three-probe sequence | Pure authorization read; no secret involved |
| `get_vendor_admin_dashboard_summary()` | V-01's four counts | Pure aggregate |
| `list_vendor_organization_members()` | V-02's four-query join | Pure join |
| `list_vendor_audit_logs(p_limit, p_before)` | V-04 | Pure read; adds pagination mobile needs |
| ~~`list_vendor_retailers()`~~ ✅ **shipped** — `20260731090000` | V-05 | Pure aggregate |
| ~~`get_vendor_retailer_detail(p_relationship_id)`~~ ✅ **shipped** — `20260731090000` | V-06's three reads | Pure read, already-proven ownership pattern |
| `list_vendor_retailer_shops(p_relationship_id)` ✅ **shipped** — `20260731090000` | V-06's shop list | Justified companion: a shop list is unbounded and must not be nested in a detail payload |

All are read-only, need no secret, and are enforceable by the existing resolvers. Putting
them in SQL means **one definition for both clients** — which is the whole point.

**Three of the six are delivered** (`get_my_portal_context`, `list_vendor_retailers`,
`get_vendor_retailer_detail`), plus the one companion read above. None is consumed by the
web yet: each shipped RPC is additive, and migrating a web page to it is a separate change
with its own review.

### 4.2 Must become a Supabase Edge Function

| Proposed function | Covers | Secrets it holds |
| --- | --- | --- |
| `invite-retailer-owner` | V-09 | service role, `APP_ORIGIN`, flag |
| `send-existing-user-owner-invitation` | V-10 | service role, Resend, `APP_ORIGIN`, flag |
| `send-staff-invitation` | RO-07, RO-08 | service role, Resend, `APP_ORIGIN`, flag |
| `staff-invitation-context` | INV-04 | service role |
| `activate-staff-account` | INV-05 | service role |
| `submit-receipt` | SS-02 | service role (Storage) |
| `get-receipt-image-url` *(new capability)* | SS-03 follow-up | service role (signed URL) — **pending § 7 Q1** |

**Rules for every one of them.** Verify the caller's JWT with the *publishable* client first
(`auth.getUser()`); derive tenant context from the database, never from the request body;
accept only the same parameters the current Server Actions accept; return the same
discriminated statuses; never echo a token, hash, email, or service key.

**Migration path.** Each Edge Function should become the single implementation, and the
existing Next.js Server Action should be reduced to calling it. That is what makes "shared"
real rather than aspirational — otherwise the two implementations drift the first time a rule
changes.

### 4.3 Remain a Next.js-only adapter

Form state shaping, `revalidatePath`, `redirect`, cookie handoff, and the `?next=` guard.
None of these have a mobile analogue and none carry business rules.

### 4.4 The one genuine architecture choice: receipt upload

Two viable designs.

**Option A — Edge Function proxy (recommended).** Flutter POSTs the image to
`submit-receipt`. The function sniffs the magic bytes, hashes, reserves, uploads with the
service key, finalizes, and cleans up orphans on failure. *Pros:* zero change to Storage
policies; magic-byte sniffing and orphan cleanup stay server-side and shared; identical to
today's web behaviour. *Cons:* image bytes traverse the function (Edge Functions cap request
bodies; the 10 MiB limit fits comfortably).

**Option B — signed upload URL.** Extend `reserve_receipt_submission` to also mint a signed
upload URL. *This is not possible from Postgres* — signed URLs are a Storage API concern — so
it still needs an Edge Function to mint the URL, and it moves MIME sniffing to the client,
where it is not trustworthy. **Not recommended.**

Adding an `INSERT` policy on `storage.objects` scoped to `auth.uid()` is a third option and
is **explicitly not recommended**: it would be the first write policy in the entire schema and
would weaken the "one audited door, no windows" posture this backend has maintained
throughout.

---

## 5. Which Server Actions are thin adapters (audit item 5)

| Server Action | Verdict | Logic that would be duplicated in Dart |
| --- | --- | --- |
| `onboardRetailer` | **Thin** | ISO country pre-check (message quality only) |
| `addVendorRetailerShop` | **Thin** | `23505` → field mapping |
| `createProductAction` / `updateProductAction` | **Thin** | Input normalization + duplicate-message → field mapping |
| `setProductStatusAction` / `assignProductAction` / `unassignProductAction` | **Thin** | UUID shape checks |
| `signIn` | **Thin + landing** | Landing precedence (`selectLanding`) |
| `signOut` | **Thin** | — |
| `completeInvitation` | **Thin** | Password policy; `same_password` tolerance |
| `acceptExistingUserInvitationAction` | **Thin** | Cookie read |
| `acceptStaffInvitationAction` | **Moderate** | Session probe, cookie clear, landing re-resolution |
| `inviteRetailerOwnerAction` | **THICK** | Feature flag; pre-flight owner-status read; `planInvitationSubmit` resend-vs-new decision; stored-email substitution on resend; blocked-state matrix |
| `sendExistingUserRetailerOwnerInvitationAction` | **THICK** | Feature flag; `classifyOwnerAction` eligibility |
| `inviteStaffAction` | **THICK** | Feature flag; shop-id validation against the assignable list |
| `resendStaffInvitationAction` | **THICK** | `canResendInvitation` state predicate; stored-value substitution |
| `submitReceiptAction` | **THICK (security)** | Magic-byte MIME sniffing; SHA-256; filename sanitization; single-file enforcement; assigned-shop pre-check |
| `activateStaffAccountAction` | **THICK (security)** | Server-derived email; password policy; already-registered branch |

Every **THICK** row is a category **D** operation. That correlation is not a coincidence — it
is the argument for Edge Functions: the logic and the secret belong on the same side of the
boundary.

---

## 6. Functions unsuitable as stable cross-client contracts (audit item 11)

Recommendations only. **No migration is proposed here and no function has been edited.**

### 6.1 `get_vendor_retailer_owner_status(uuid)` — dropped and recreated three times

Migrations `20260721150000`, `20260721190000` and `20260722090000` each `drop function` and
recreate it with an extra column (7 → 8 → 9). Postgres `RETURNS TABLE` is positional for
some clients; a pinned mobile build that cannot be force-updated will break on the next
column. **Recommend:** freeze the signature and make future additions purely additive, or
return a single `jsonb` payload with named keys, or version the name
(`get_vendor_retailer_owner_status_v2`).

**Still open.** Migration `20260731090000` deliberately did **not** touch this function — it
neither recreates it nor re-grants it, and a static test forbids the migration from even
naming it, so V-06 gained a mobile contract without a fourth breaking recreation. The new
reads mirror its five-state precedence in `public.vendor_retailer_owner_state(uuid)` (granted
to nobody) and expose only the state word; the pgTAP suite asserts the two agree row for row,
so the mirror cannot drift silently. That contains the problem. It does not solve it.

### 6.2 `list_retailer_staff_invitations().derived_state` can be `NULL`

The `CASE` expression has no `ELSE`. A `PENDING`, unexpired row with `sent_at IS NULL` **and**
a non-null `failure_code` matches no branch and yields `NULL`. Constraint
`retailer_staff_invitations_sent_or_failure` makes that unreachable today, but the contract
does not say so. **Recommend:** add an explicit `ELSE 'UNKNOWN'` and document the closed enum.

### 6.3 `list_retailer_owner_portal_shops()` returns no `shop_id`

It returns `(shop_name, shop_code, city, country_code, shop_status)`. Sibling functions
`list_retailer_staff_assignable_shops()` and `list_my_assigned_receipt_shops()` both return
`shop_id`. A mobile list cannot navigate to a detail screen, deduplicate, or key a widget
without a stable id. **Recommend:** add `shop_id`.

**Still open for `list_retailer_owner_portal_shops()` itself.** The new Vendor-side
`list_vendor_retailer_shops()` (`20260731090000`) returns `shop_id` from the start, so the
Vendor shop list does not repeat the mistake — but the Retailer Owner portal function is
unchanged and still returns none.

### 6.4 Errors discriminated by English message text

- `reserve_retailer_staff_invitation` signals a role/shop conflict only through the message
  `"Revoke and re-issue this invitation to change its role or shops"`, string-matched in
  `lib/staff/retailer-staff-invitations.ts`.
- `create_vendor_product` / `update_vendor_product` distinguish duplicate **code** from
  duplicate **barcode** by substring, in `lib/products/vendor-products.ts`.

Message text is not an API. Any rewording silently breaks both clients.
**Recommend:** distinct SQLSTATEs (e.g. `55000` for the conflict) or an `errcode` + stable
machine code carried in `USING detail = '…'`.

### 6.5 `resolve_retailer_member_organization` / `resolve_retailer_owner_organization` return `NULL` for multi-membership

`where (select count(*) from qualifying) = 1` means a user who legitimately qualifies at two
Retailers is silently treated as having **no** access — indistinguishable from a denial. This
is the direct blocker for "secure account switching" on mobile. **Recommend:** a companion
`list_my_retailer_memberships()` and an explicit selection mechanism (§ 7 Q2).

### 6.6 `void` returns that hide the outcome

`assign_vendor_product_to_retailer`, `unassign_vendor_product_from_retailer`,
`update_vendor_product` and `set_vendor_product_status` all return `void` and silently no-op
when the state already matches. A client cannot tell "changed" from "already so".
**Recommend:** return a `boolean` (changed) or a small status enum.

### 6.7 `setof` for logically singleton contexts

`get_vendor_super_admin_context()`, `get_retailer_owner_portal_context()`,
`get_my_pending_retailer_invitation()`, `get_pending_existing_user_retailer_invitation()` all
return a set where at most one row is meaningful. Every client must index `[0]`.
**Recommend:** keep as-is for backward compatibility, but document "at most one row" in the
contract so Dart wrappers are written the same way.

### 6.8 Naming and addressing inconsistency

- Three different prefixes for the same intent: `get_…_context`, `list_…`, `list_my_…`.
- Vendor operations are addressed by `vendor_retailers.id` (`p_relationship_id`) while
  `list_vendor_product_retailer_assignments` returns `retailer_organization_id` and
  `assign_vendor_product_to_retailer` takes `p_retailer_organization_id`. **Two address
  spaces for the same tenant**, and nothing in the API maps between them. A Flutter product
  screen and a Flutter retailer screen therefore cannot cross-link.
  ✅ **Closed for the Retailer surface.** `list_vendor_retailers()` and
  `get_vendor_retailer_detail()` (`20260731090000`) both return `relationship_id` **and**
  `retailer_organization_id`, so a Flutter Retailer screen can now cross-link to
  `list_vendor_product_retailer_assignments()` and `assign_vendor_product_to_retailer()`.
  Note the direction: the Retailer organization id is an **output only** — neither function
  accepts one, because `vendor_retailers.id` is the narrower selector (it names one Vendor's
  view of one Retailer, so a foreign value matches nothing). The naming inconsistency in the
  first bullet is unchanged.

### 6.9 `expire_stale_retailer_invitations` is a hidden write inside a read-ish path

It is invoked by `reserve_*` and `revoke_retailer_staff_invitation`. Correctness does not
depend on it (every liveness check re-reads `expires_at`), so this is acceptable — but a
mobile client that calls `revoke` will also mutate unrelated rows. Worth documenting rather
than changing.

---

## 7. Open product questions

These block implementation and are listed again in the summary.

**Q1. Can a Sales Staff member view a receipt they submitted?**
There is no read path at all — no signed URL, no Storage policy, no RPC. On web nobody has
noticed; on mobile, tapping a history row and seeing nothing is a bug report. If yes, an
Edge Function `get-receipt-image-url` must mint a short-lived signed URL after verifying
`submitted_by_profile_id = auth.uid()`.

**Q2. What happens to a user who belongs to two Retailers?**
Today both resolvers return `NULL` and the user loses all portal access. "Secure account
switching" cannot be designed until this is decided: (a) forbid it, (b) add explicit
selection persisted server-side, or (c) pass a retailer id and verify it — option (c) means
accepting a client-supplied tenant id, which every function in this schema currently refuses.

**Q3. Should a Retailer Manager be able to read their own Retailer's name?**
`get_retailer_owner_portal_context()` hard-filters `RETAILER_OWNER`, so a Manager holding
`RETAILER_PORTAL_READ` gets zero rows. On web this is invisible (they land on the staff
page). A mobile app has an app bar that wants the tenant name.

**Q4. Is Vendor Super Admin in scope for mobile at all?**
Vendor operations are catalogue and tenant administration — desk work. Excluding them removes
~18 of 43 operations and four of the six new RPCs from phase 1.

**Q5. Offline receipt capture?**
The duplicate guard is `sha256`-based and server-side, so a queue-and-retry design is safe.
But `reserve_receipt_submission` requires connectivity, so an offline queue must store bytes
locally and reserve on reconnect. Confirm whether this is in scope.

**Q6. Deep-link scheme and domain for invitations.**
Emails currently build `${APP_ORIGIN}/invitations/staff/enter?token=…`. Mobile needs either
universal links / app links on the same origin (preferred — the web page can then hand off),
or a second link in the email. This changes `lib/invitations/resend-email.ts` and
`lib/staff/staff-invitation-email.ts`.

**Q7. Should the three feature flags apply to mobile?**
They are server-only today. If mobile calls the Edge Functions it inherits them for free. If
any flow is reimplemented in Dart, the kill switch stops working for that client.

**Q8. Should `revoke_retailer_owner_invitation` be surfaced?**
Built, granted, audited — and called by nothing (§ V-11).

**Q9. Minimum-supported-version policy.**
An unversioned shared RPC surface plus an app-store client means the backend must stay
backward-compatible indefinitely, or the app must be force-updatable. Decide before the first
release, because § 6.1 shows this schema has already made three breaking function changes.

---

## 8. Coverage summary

| Category | Operations | Share |
| --- | --- | --- |
| **A** — existing authenticated RPC, callable as-is | 26 | ~60 % |
| **B** — existing RLS-protected table access | 5 (all also candidates for C) | ~12 % |
| **C** — new shared RPC recommended | 6 — **3 delivered** (`get_my_portal_context`, `list_vendor_retailers`, `get_vendor_retailer_detail`), 3 outstanding | ~14 % |
| **D** — Edge Function required | 7 | ~16 % |
| **E** — web-only UI to recreate | 7 surfaces | — |
| **F** — needs a product decision | 9 questions | — |

Counted against the ~43 user-facing operations in § 3. Several operations appear in more than
one category (e.g. V-06 is A + B and would become C).
