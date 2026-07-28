# Mobile Backend Contract — SalesReward

**Status:** originally an audit. **Updated 2026-07-25** for the backend changes made since
it was first written:

| Migration | Added | See |
| --- | --- | --- |
| `20260729090000_shared_portal_context.sql` | `public.get_my_portal_context()` | **AUTH-05** |
| `20260730090000_sales_staff_receipt_product_and_submission_reads.sql` | `public.list_my_receipt_products()`, `public.get_my_receipt_submission(uuid)` | `docs/mobile-receipt-submission-audit.md` |
| `20260731090000_mobile_vendor_retailer_reads.sql` | `public.list_vendor_retailers()`, `public.get_vendor_retailer_detail(uuid)`, `public.list_vendor_retailer_shops(uuid)`, and the internal `public.vendor_retailer_owner_state(uuid)` | **V-05**, **V-06**, and `docs/mobile-vendor-retailer-reads-audit.md` |
| `20260801090000_mobile_vendor_user_reads.sql` | `public.list_vendor_users()`, `public.get_vendor_user_detail(uuid)` | **V-02**, and `docs/mobile-vendor-user-reads-audit.md` |
| `20260802090000_mobile_vendor_role_reads.sql` | `public.list_vendor_roles()`, `public.get_vendor_role_detail(uuid)`, `public.list_vendor_role_permissions(uuid)` | **V-03**, and `docs/mobile-vendor-role-reads-audit.md` |
| `20260803090000_mobile_vendor_product_reads.sql` | `public.get_vendor_product_detail(uuid)`, `public.list_vendor_product_assigned_retailers(uuid)` | **V-13**, and `docs/mobile-vendor-product-reads-audit.md` |
| `20260804090000_mobile_vendor_audit_log_reads.sql` | `public.list_vendor_audit_logs(integer, timestamptz, uuid)` | **V-04**, and `docs/mobile-vendor-audit-log-reads-audit.md` |
| `20260805090000_mobile_vendor_dashboard_summary.sql` | `public.get_vendor_admin_dashboard_summary()` | **V-01**, and `docs/mobile-vendor-dashboard-summary-audit.md` |
| `20260806090000_mobile_vendor_company_profile_reads.sql` | `public.get_my_vendor_profile()` | **V-19**, and `docs/mobile-vendor-company-profile-reads-audit.md` |
| `20260809090000_retailer_staff_shop_assignment_management.sql` | `public.set_retailer_staff_shop_assignments(uuid, uuid[])` — the first **write** in this series | **RO-10**, and `docs/retailer-staff-shop-assignment-management-audit.md` |
| `20260810090000_retailer_staff_membership_lifecycle.sql` | `public.set_retailer_staff_membership_status(uuid, text)` and `public.get_my_lifecycle_access_state()` | **RO-11**, **AUTH-06**, and `docs/retailer-staff-membership-lifecycle-audit.md` |

**The Vendor Product-to-Retailer assignment-writes milestone added NO migration and NO RPC.**
It audited `public.assign_vendor_product_to_retailer(uuid, uuid)` and
`public.unassign_vendor_product_from_retailer(uuid, uuid)` (both shipped in
`20260727210000_vendor_product_catalog_operations.sql`), found them already safe for a second
client, and **reused them unchanged** — adding only a behavioural pgTAP suite, static contract
guards and documentation. See **V-17**, **V-18**, § 6.6, § 6.8, and
`docs/mobile-vendor-product-assignment-writes-audit.md`.

Everything else below still describes the schema as audited: no other migration, RPC, RLS
policy, grant, Storage policy, environment variable, or application file was created or
changed. In particular **no existing function was edited, dropped, or replaced by any of
them** — `get_my_portal_context()` above is consumed by later migrations' *documentation*, never
altered by them — and no web page changed behaviour. No role seed, permission seed, or
role→permission mapping was altered by any of them either.

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

#### AUTH-06 — Why is my access refused? (self-only lifecycle diagnostic)  *(new)*

| Field | Value |
| --- | --- |
| Feature | Tell the **signed-in caller, and only them**, why their own access is currently refused |
| Role | Any authenticated caller |
| Permission | none — the subject is `auth.uid()` and the answer is about themselves |
| Web route | **none yet — backend-only milestone** |
| RPC | `public.get_my_lifecycle_access_state()` — `authenticated`, `SECURITY DEFINER`, **`STABLE`**, empty `search_path`, **zero arguments** |
| Inputs | **none at all.** No tenant selector, no identifier, no filter. |
| Backend-resolved | everything, from `auth.uid()` |
| Returns | one row, one column: `(access_state text)` |
| Errors | `42501` when unauthenticated. There is no other error path. |
| RLS & authorization | reads only the caller's own `profiles` row and their own `organization_members` rows. Deliberately **does not** call the resolvers. |
| Tables | `profiles`, `organization_members`, `organizations`, `member_roles`, `roles` — all read-only |
| Idempotency | N/A — it writes nothing at all, not even an audit row |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Tests | `supabase/tests/database/retailer_staff_membership_lifecycle_test.sql` (252), `lib/staff/staff-membership-lifecycle-contract.test.ts` (65) |

**Why it exists.** Every protected RPC refuses an inactive user with the same generic `42501`
that a wrong-role caller gets. That uniformity is a security property and is **preserved** —
it is what stops a caller probing the schema — but it leaves the application unable to write
honest copy. "You do not have access to this page" is the wrong sentence for someone whose
account was deactivated this morning. This RPC supplies the right one.

**The vocabulary is closed. Treat an unrecognised value as "unknown" and fall back to the
generic copy** — a future migration may add a word this build predates.

| `access_state` | Meaning |
| --- | --- |
| `ACTIVE` | Exactly one supported Retailer context, everything about it ACTIVE. No lifecycle reason explains a refusal. |
| `PROFILE_INACTIVE` | The caller's own profile is not ACTIVE — they are blocked everywhere. |
| `MEMBERSHIP_INACTIVE` | Their one Retailer is ACTIVE, but their membership of it is not. **This is the state RO-11 creates.** |
| `ORGANIZATION_INACTIVE` | Their one Retailer organization is not ACTIVE. |
| `NO_SUPPORTED_ACCESS` | No supported Retailer membership context exists (a Vendor-only user, a role-less membership, or an Auth row never provisioned a profile). |
| `AMBIGUOUS` | More than one qualifying Retailer context. No single story can be told, and none is invented. |

Supported Retailer roles for interpretation are `RETAILER_OWNER`, `RETAILER_MANAGER` and
`SALES_STAFF`. **Precedence: profile → organization → membership.** `ORGANIZATION_INACTIVE`
wins when both the organization and the membership are non-ACTIVE, because the Retailer-wide
block is the broader cause — telling a Sales Staff member "your membership was deactivated"
when their whole Retailer is suspended would send them to an Owner who is themselves locked
out.

**⚠️ IT IS A DIAGNOSTIC, NEVER AN AUTHORIZATION GATE.** The resolvers remain the only things
that decide whether an operation may proceed, and every protected RPC calls them for itself,
server-side, on every request. `ACTIVE` here is **not** permission to do anything — it is a
description of why the real gate said no, computed *after* the real gate said no. Call it on
the **refusal path**, to choose a sentence. A client that branched on this value *instead of*
calling the operation would be trusting a read to authorize a write. The pgTAP suite states
this as a test: a Sales Staff member reads `ACTIVE` and is still refused the Owner's write.

**It returns no identifier or personal information.** No profile id, membership id,
organization id, organization name, email, role code, raw status, timestamp or database
message — every return statement in the body is a bare vocabulary literal.

**It is separate from AUTH-05 on purpose, and does not change it.** `get_my_portal_context()`
decides **routing** and its contract is consumed by shipped clients; this explains **denial**.
Merging them would have meant editing a live read contract to carry a field only the error path
uses, and making every application boot pay for a computation only a refusal needs.
`get_my_portal_context()` keeps its signature, its `jsonb` return, `context_version` 1 and its
generic-denial behaviour, unchanged. The independence is the point: the portal reports `NONE`
for both an inactive profile and a Vendor-only user, and only this RPC can tell them apart.

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
| Classification | **B** → **C, delivered** |
| Backend change | **DONE.** `public.get_vendor_admin_dashboard_summary()` was added in migration `20260805090000_mobile_vendor_dashboard_summary.sql`. **Zero arguments**; `authenticated` only (never `anon`, `PUBLIC` or `service_role`); `SECURITY DEFINER`, `STABLE`, empty `search_path`. Requires the Vendor Super Admin role **AND all three** of `ORGANIZATION_MEMBERS_READ`, `RBAC_READ`, `AUDIT_LOGS_READ` — the union of what the four counted relations already require under the migration-5 policies, so **the summary can never be more permissive than the screens it summarises**. Deliberately **non-partial**: a Vendor Super Admin missing any one permission is denied the whole summary with `42501`, where the web would still render all four cards (narrower than RLS, which is an `OR` — safe by construction).<br><br>Returns `(active_member_count, catalog_active_role_count, catalog_permission_count, audit_event_count)`, all `bigint`, all **non-null**. **Exactly one row** for an authorized Vendor — structurally, because the body is a single `select` with **no from-clause** and four scalar aggregate subqueries; a Vendor with no data gets one row of zeros, and zero rows is unreachable. A denial is `42501` and is **never** a row of zeros. **One round trip replaces five** (1 auth RPC + 4 parallel counts, each of which re-walked the authorization chain through its RLS policy).<br><br>**THE KEY FINDING: two of the four counts are GLOBAL, not Vendor metrics.** `public.roles` and `public.permissions` carry **no `organization_id`**, so "Active Roles" and "Permissions" show the **same number to every Vendor**. That leaks nothing (they count catalogue definitions written by migrations, not tenant data) but it is a semantic trap for a second client, so the contract names it: the two global fields carry a `catalog_` prefix and must **not** be labelled as belonging to the Vendor. `audit_event_count` is **all-time and unwindowed** — the product defines no "today"/"this week"/"last 30 days", so none was invented; do not label it "recent". `active_member_count` requires `status='ACTIVE'` on the membership and deliberately does **not** join `profiles`, exactly as the web query does. No Retailer, Product, shop, assignment or invitation count is returned, because **no such card exists on the web**. The four direct reads above are still what the *web* does — the web migration is deliberately deferred. |
| Tests | pgTAP `supabase/tests/database/vendor_dashboard_summary_test.sql` (80); static `lib/dashboard/vendor-dashboard-summary-contract.test.ts` (32) |

> **Two dashboard card labels are semantically inaccurate, and this milestone did not change
> them.** "Active Roles" and "Permissions" are deployment-wide RBAC catalogue figures rendered
> on a page described as an overview of *"your organization's members, access control, and
> recorded activity"*. Changing a visible web label is out of scope for a read-only backend
> milestone, so the finding is recorded here and encoded in the RPC's field names instead. See
> `docs/mobile-vendor-dashboard-summary-audit.md` § 3.1.

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
| Classification | **B** → **C, delivered** |
| Backend change | **DONE.** `public.list_vendor_users()` was added in migration `20260801090000_mobile_vendor_user_reads.sql` — the name supersedes the `list_vendor_organization_members()` recommendation so that the pair below reads as one feature. Zero arguments; `authenticated`; requires **both** `ORGANIZATION_MEMBERS_READ` **and** `RBAC_READ`. Returns `(membership_id, display_name, profile_status, membership_status, membership_created_at, joined_at, role_names text[])`, ordered by `display_name, membership_id`. Roles come from a correlated `array_agg` filtered to **ACTIVE role definitions**, so a multi-role user is **one row** and no `DISTINCT` is needed; a user with no role gets an **empty array**, never `NULL` and never a default. One round trip instead of five. Unauthorized → `42501`; the caller's own row is always present, so the list is never truly empty (a Vendor with one administrator returns exactly one row). No email, `auth.users` id, role code, permission row, or invitation field is returned. The multi-query TypeScript assembly above is still what the *web* does — the web migration is deliberately deferred.<br><br>**Companion:** `public.get_vendor_user_detail(p_membership_id uuid)`, same grant and same permissions, returns the list columns **plus `deactivated_at`** for one user. It has **no web counterpart** — `app/(admin)/users/` has no detail route — so it is specified rather than translated. A foreign, Retailer-owned, unknown or `null` membership id returns **zero rows**, never a distinguishable refusal. The selector is the `organization_members` row id and never a profile or auth user id: a membership names one person *in one organization*, so tenant scoping is a predicate on the same row. |
| Tests | pgTAP `supabase/tests/database/vendor_user_reads_test.sql` (106); static `lib/members/vendor-user-reads-contract.test.ts` (34) |

> **There are no Vendor user invitations.** Both invitation tables in the schema are
> Retailer-scoped by trigger (`retailer_invitations`, `retailer_staff_invitations`), so
> nothing invites a user into a VENDOR organization. A Vendor user's "invited" state is
> `organization_members.status = 'INVITED'` / `profiles.status = 'INVITED'` — ordinary column
> data on rows this list already returns. There is therefore no combined typed list, no
> second id address space, no invitation-detail companion, and no invitation token or hash
> that could leak. See `docs/mobile-vendor-user-reads-audit.md` § 3.

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
| Flutter direct? | **Yes**, but it would duplicate a three-query client-side join and would receive **no id** |
| Classification | ~~**B**~~ → **C, delivered** |
| Backend change | **DONE.** `public.list_vendor_roles()` was added in migration `20260802090000_mobile_vendor_role_reads.sql` — the name supersedes the `list_vendor_rbac_catalog()` recommendation, which was scoped as "optional, low priority". Zero arguments; `authenticated`; requires **both** `RBAC_READ` **and** `ORGANIZATION_MEMBERS_READ`. Returns `(role_id, role_name, role_description, role_status, role_created_at, permission_count, assigned_member_count)`, ordered by `role_name, role_id`. Both counts are **scalar aggregates**, so a role with twelve permissions or forty holders is still **one row** and no `DISTINCT` is needed; both are `0` rather than `NULL` when empty. Four round trips become one. **No role status filter** — an `INACTIVE` definition is listed and marked, exactly as the web does not hide it. Unauthorized → `42501`. No role code, permission row, permission code, module, organization id, or member personal field is returned. The multi-query TypeScript assembly above is still what the *web* does — the web migration is deliberately deferred.<br><br>**Companions:** `public.get_vendor_role_detail(p_role_id uuid)`, same grant and permissions, returns the **identical column set** for one role (`public.roles` has nothing further to show: its remaining columns are `code`, refused, and `updated_at`, which the seed upsert rewrites on every run). It has **no web counterpart** — `app/(admin)/roles/` has no detail route, and there is no role write surface anywhere in the product. And `public.list_vendor_role_permissions(p_role_id uuid)`, which requires **only `RBAC_READ`** because it reads no membership table, returning `(permission_name, permission_description)` ordered by name. An unknown, foreign-table or `null` role id returns **zero rows / an empty list**, indistinguishable from a real role that grants nothing — the detail read is the authoritative existence check. |
| Tests | pgTAP `supabase/tests/database/vendor_role_reads_test.sql` (164); static `lib/rbac/vendor-role-reads-contract.test.ts` (36) |

> **The role catalogue is GLOBAL, and this contract does not pretend otherwise.**
> `roles`, `permissions` and `role_permissions` carry **no `organization_id`**, so every
> authorized Vendor reads the same six role definitions — including the three Retailer roles,
> exactly as `/roles` shows them today. There is no Vendor-scoped subset to return and no
> "other Vendor's role" to leak. The one tenant-scoped value is `assigned_member_count`, which
> counts only the **calling** Vendor's own memberships (no membership-, profile- or
> role-status filter, matching the Vendor Users directory). There is likewise **no
> system/custom kind** (no such column), **no permission status** and therefore **no
> `active_permission_count`**, and **no permission code or module** in the payload. See
> `docs/mobile-vendor-role-reads-audit.md` §§ 1, 8, 9.
>
> **On permission status specifically:** an inactive assigned permission is
> **unrepresentable** — neither `permissions` nor `role_permissions` has a status column, and
> no migration adds one. What *can* make a mapped permission ineffective is the **role's**
> status: `has_organization_permission()` gates on `r.status = 'ACTIVE'` and carries no
> permission-status predicate, so an `INACTIVE` role grants nothing however many permissions
> remain mapped to it. `list_vendor_role_permissions()` still lists those mappings, exactly as
> `/roles` does; `role_status` is the field that makes the list truthful, and a client must
> render it alongside. Audit § 8.1.

---

#### V-04 — Audit log feed

| Field | Value |
| --- | --- |
| Feature | Latest 100 audit records with actor names |
| Role | Vendor Super Admin |
| Permission | `AUDIT_LOGS_READ` |
| Web route | `/audit-logs` (two files: `page.tsx`, `loading.tsx` — **no detail view of any kind**) |
| Server Action | `lib/audit/vendor-audit-logs.ts` |
| Existing table op | `audit_logs` (limit 100, desc) then `profiles` for actor names — **2 reads, batched, not N+1** |
| Inputs | none |
| Backend-resolved | `organizationId` |
| Returns | `occurredAt`, `actorDisplayName`, `action`, `entityType` |
| Errors | Fails to null (`null` ≠ `[]`, deliberately) |
| RLS & authorization | `audit_logs_select_authorized` — note it **excludes null-organization rows** in both branches, deliberately |
| Tables | `audit_logs`, `profiles` |
| Storage bucket | — |
| Idempotency | Read-only |
| Flutter direct? | **No** — see the audit § 8.1: `SELECT *` would carry `metadata`, `entity_id`, `ip_address`, `user_agent` and `actor_profile_id` (**the auth user id**); the actor join and the tie-break would become client responsibilities. |
| Classification | **B** → **C, shipped** |
| Backend change | **DONE.** Added in `20260804090000_mobile_vendor_audit_log_reads.sql` as `public.list_vendor_audit_logs(p_limit integer default 50, p_before_occurred_at timestamptz default null, p_before_audit_log_id uuid default null)`. Three gaps closed: **(1) no pagination at all** — record 101 was unreachable forever, now keyset on `(created_at, id)`, both cursor parts required together; **(2) the actor join lived in TypeScript** and resolved a caller-dependent subset — now one SQL join scoped to the audit row's *own* Vendor membership, yielding `actor_type ∈ {USER, SYSTEM, UNKNOWN}` — note **`SYSTEM` means “no actor identity remains”, not “a system process acted”**: `ON DELETE SET NULL` makes a deleted user byte-identical to a genuine system event, so clients must render neutral wording such as *“System or unavailable actor”* (audit § 5.5); **(3) the affected entity was typed but never named** — now a **closed whitelist** of metadata name snapshots (`product_name` / `retailer_name` / `shop_name`), type-guarded to `jsonb_typeof = 'string'`. Action and entity codes are returned **raw** — no DB label map exists, so clients map known codes and humanize unknown ones neutrally. **List-only by decision:** the web exposes no detail surface to share, so adding one would invent a new, more sensitive capability rather than share an existing one. Limit default 50, hard max 100, out-of-range → `22023`. No index added (measured: 51 rows read to return 50, at any depth). |
| Tests | `supabase/tests/database/vendor_audit_log_reads_test.sql` (130 pgTAP assertions), `lib/audit/vendor-audit-log-reads-contract.test.ts` (26 static tests) |

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
| Classification | **A** — **reused verbatim** |
| Backend change | **None, deliberately.** This is the one Vendor list in the schema that was already doing the right thing: zero arguments, Vendor derived from `auth.uid()`, the assignment count aggregated in SQL (a correlated `count(*)`, not transferred rows), no identity or tenant internals, `authenticated` only. The `20260803090000` milestone **reuses it unchanged** rather than adding a second catalogue read, which would be a second definition of "this Vendor's products". `normalizeVendorProducts` is defensive shape validation, easily ported. Its `active_assignment_count` semantics are now depended on by `get_vendor_product_detail()` and are asserted equal to it. |
| Tests | `lib/products/product-normalization.test.ts` (20), `lib/products/product-source-safety.test.ts` (20); pgTAP `supabase/tests/database/vendor_product_reads_test.sql` (180) |

---

#### V-12a — Vendor product detail  *(new)*

| Field | Value |
| --- | --- |
| Feature | One product: identity, identifiers, status and both assignment counts |
| Role | Vendor Super Admin |
| Permission | `PRODUCTS_READ` |
| Web route | `/products/[productId]` |
| Server Action | *(none — the web has no detail read; see below)* |
| New RPC | `public.get_vendor_product_detail(p_product_id uuid)` — `authenticated` |
| Inputs | `p_product_id` (uuid) — an address, never authorization |
| Backend-resolved | Vendor org id; the product is matched on `(id, vendor_organization_id)` |
| Returns | `(product_id, product_code, barcode, product_name, brand, description, status, assignment_count, active_assignment_count, created_at, updated_at)` |
| Errors | `42501` for an unauthorized caller. **Zero rows** — never an error — for an unknown, foreign or null product id |
| RLS & authorization | Context → `PRODUCTS_READ`; both product tables remain default-deny with zero policies |
| Tables | `vendor_products`, `vendor_product_retailer_assignments` |
| Storage bucket | — (**no product image exists anywhere** — no column, no bucket, no rendering) |
| Idempotency | Read-only, `STABLE` |
| Flutter direct? | **Yes** |
| Classification | **C, delivered** |
| Backend change | **DONE.** Added in `20260803090000_mobile_vendor_product_reads.sql`. The gap it closes: the web detail page has **no detail read at all** — it calls `list_vendor_products()` and then finds the row with `Array.find()` in TypeScript, so opening one product transfers the whole catalogue. The column set is the V-12 list set **plus `assignment_count`** and nothing else, byte-identical in name and type (`bigint` both sides). **Two Flutter entities, not one** — the list does *not* return `assignment_count`, and making it nullable to share an entity would collapse "zero assignments" with "never asked for"; share a mapper for the 10 common fields instead (audit § 5.1). `assignment_count` counts **every** assignment row, `active_assignment_count` only the `ACTIVE` ones — reproducing V-12's number predicate-for-predicate. Both come from **one** `LEFT JOIN LATERAL`, so the detail is one round trip and one row. |
| Tests | pgTAP `supabase/tests/database/vendor_product_reads_test.sql` (180); static `lib/products/vendor-product-reads-contract.test.ts` (40) |

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
| Backend change | **REPAIRED** in `20260807090000_repair_vendor_product_write_normalization.sql` — signature, return type, grants and semantics all unchanged. The function normalized with `btrim` (which removes **only U+0020**) *before* collapsing whitespace, so a leading or trailing tab, newline, CR, form feed, vertical tab or Unicode space separator survived, became a plain space, and was never trimmed — hitting a table `CHECK` constraint and returning PostgreSQL's raw error text, naming `vendor_products` and the constraint, to the caller. The web never triggered it because `product-input.ts` trims in JavaScript first, which made the rule **TypeScript-only in practice**. Normalization is now collapse-then-trim over an explicit character class equal to JavaScript's `\s`, so web and Flutter cannot disagree about what a value means. **No input can reach a constraint any more** — proved as a property of the whole input space in pgTAP. Full audit: `docs/mobile-vendor-product-writes-audit.md`. |
| Normalization (exact) | code → trim + collapse + **upper**; name → trim + collapse; brand → trim + collapse, `''` → null; description → **trim only** (internal formatting preserved), `''` → null; barcode → strip whitespace **and hyphens**, `''` → null. Lengths counted in **characters**, not bytes. |
| Tests | pgTAP `supabase/tests/database/vendor_product_writes_test.sql` (211); static `lib/products/vendor-product-writes-contract.test.ts` (50); `lib/products/product-input.test.ts` (24) |

---

#### V-14 — Update a product

Same shape as V-13. RPC `public.update_vendor_product(uuid, text, text, text, text)`,
`authenticated`. `product_code`, `vendor_organization_id` and `created_by_profile_id` are
**immutable by trigger**, and the code is not even a parameter. No-op when nothing changed
(returns early, does not move `updated_at`, writes no audit row) — and because normalization
runs first, a **whitespace-only difference is also a no-op**. A no-op is a *success*: a client
must not have to distinguish it from a failed write. The target row is taken `FOR UPDATE` and
matched on **both** its id and the derived Vendor, so unknown, foreign and null ids are all
refused with a byte-identical `42501`. A failed edit rolls back **completely** — a call that
renames the product *and* duplicates another's barcode leaves the name unchanged and writes no
audit row. **Classification: A.** **REPAIRED by `20260807090000`** — same defect and same fix
as V-13. Tests: `vendor_product_writes_test.sql`, `vendor-product-writes-contract.test.ts`,
`product-input.test.ts`.

---

#### V-15 — Activate / deactivate a product

RPC `public.set_vendor_product_status(uuid, text)`, `authenticated`, permission
`PRODUCTS_MANAGE` — the **same** permission as create and edit; verified, not assumed.
`p_status` is normalized `upper(btrim(...))` and must be `ACTIVE`/`INACTIVE`; anything else is
`23514` "Choose a valid product status". Both transitions are permitted in both directions.
No-op when unchanged — no write, no `updated_at` movement, no audit row, which is what stops a
mobile double-tap producing two audit rows for one decision. Audits `PRODUCT_ACTIVATED` /
`PRODUCT_DEACTIVATED`.

**Deactivation does not touch assignment rows**, not even their `updated_at`. It makes the
product ineligible for a *new* assignment (V-17 raises `55000`) and removes it from the
Retailer-facing list, which is exactly "unavailable for future matching". It is **not** a
deletion: the product row, its `created_at` and all assignment history survive, and an
INACTIVE product remains editable.

**Classification: A. NOT modified by `20260807090000`** — its only normalization feeds a closed
`in ('ACTIVE','INACTIVE')` test, so it has no path to a raw constraint error and needed no
repair. Tests: `vendor_product_writes_test.sql`, `vendor-product-writes-contract.test.ts`.

---

#### V-16 — List a product's Retailer assignments (the assign/withdraw **editor** matrix)

RPC `public.list_vendor_product_retailer_assignments(uuid)`, `authenticated`, permission
`PRODUCT_RETAILER_ASSIGN`. Returns **every** Retailer the Vendor manages with a LEFT JOIN to
the assignment — so an unassigned Retailer appears with `assignment_status = null`. Web route
`/products/[productId]`. **Classification: A.** **Unchanged by `20260803090000`** — the web
matrix depends on exactly this behaviour, including its `42501` for a foreign product id and
its `retailer_organization_id`-only addressing.

It is **not** a read contract, for three reasons the `20260803090000` audit proved: it demands
the permission to *change* assignments in order to read them; it answers "which Retailers
could hold this product" rather than "which hold it"; and it returns no relationship id, so it
cannot cross-link to the Retailer screens (§ 6.8). See V-16a.

---

#### V-16a — A product's assigned Retailers (read-only)  *(new)*

| Field | Value |
| --- | --- |
| Feature | The Retailers one product is actually assigned to, with their statuses |
| Role | Vendor Super Admin |
| Permission | `PRODUCTS_READ` **and** `RETAILERS_READ` |
| Web route | *(none — mobile-first; the web uses the V-16 editor matrix)* |
| New RPC | `public.list_vendor_product_assigned_retailers(p_product_id uuid)` — `authenticated` |
| Inputs | `p_product_id` (uuid) — the **same** selector V-12a takes, so the two cannot drift into two address spaces |
| Backend-resolved | Vendor org id; ownership proved once against the derived Vendor |
| Returns | `(relationship_id, retailer_organization_id, retailer_name, retailer_status, relationship_status, assignment_status, assigned_at, assignment_updated_at)`, ordered by `retailer_name, retailer_organization_id` |
| Errors | `42501` for an unauthorized caller. **Zero rows** for an unknown, foreign or null product — identical to a genuinely unassigned product |
| RLS & authorization | Context → both permissions; the relationship is matched on the derived Vendor |
| Tables | `vendor_product_retailer_assignments`, `organizations`, `vendor_retailers` |
| Storage bucket | — |
| Idempotency | Read-only, `STABLE` |
| Flutter direct? | **Yes** |
| Classification | **C, delivered** |
| Backend change | **DONE.** Added in `20260803090000`. Driven **from the assignment table**, so it returns one row per *existing* assignment: a never-assigned Retailer is **absent** rather than a null-status row, and `assignment_status` is never null. Withdrawn (`INACTIVE`) assignments **are** returned and marked — withdrawal never deletes. Its row count **equals** V-12a's `assignment_count` by construction (pgTAP-asserted). **`relationship_id` closes § 6.8 for this surface**: it is the same `vendor_retailers.id` that `list_vendor_retailers()` / `get_vendor_retailer_detail()` use, so an assignment row opens the shipped Vendor Retailer detail screen with no second lookup. It is **nullable** (the relationship join is `LEFT`, so a missing relationship surfaces as a null rather than as a silently shorter list that would contradict the count). The permission requirement is **split**: this read returns Retailer identity and therefore also needs `RETAILERS_READ`; V-12a returns only counts and does not. |
| Tests | pgTAP `supabase/tests/database/vendor_product_reads_test.sql` (180); static `lib/products/vendor-product-reads-contract.test.ts` (40) |

Full audit: `docs/mobile-vendor-product-reads-audit.md`.

---

#### V-17 — Assign a product to a Retailer (**and reactivate a withdrawn one — one operation**)

| Field | Value |
| --- | --- |
| Feature | Make an `ACTIVE` product visible to one of this Vendor's `ACTIVE` Retailers |
| Role | Vendor Super Admin |
| Permission | **`PRODUCT_RETAILER_ASSIGN`** — **distinct from `PRODUCTS_MANAGE`**, which neither grants nor is required |
| Web route | `/products/[productId]` — the only assignment surface in the product |
| Server Action | `assignProductAction` |
| Existing RPC | `public.assign_vendor_product_to_retailer(p_product_id uuid, p_retailer_organization_id uuid)` — `authenticated` |
| Inputs | exactly two opaque addresses. **No** status, note, date, relationship id, assignment id or idempotency key; **no** defaults |
| Backend-resolved | Vendor org (from `auth.uid()` → `get_vendor_super_admin_context()`, lowest org id), `assigned_by_profile_id`, `assigned_at`, status |
| Returns | `void` — see § 6.6 |
| Errors | `55000` ineligible product · `42501` for everything else, **one identical message** for unauthorized / unknown / foreign / suspended / deactivated · `23505` under a race (unreachable in practice) |
| RLS & authorization | Context → permission → product matched on **id AND derived Vendor** → Retailer reached only through the derived Vendor's own `vendor_retailers` row |
| Tables | `vendor_product_retailer_assignments`, `audit_logs` |
| Idempotency | `vendor_product_retailer_assign_unique_idx (vendor_product_id, retailer_organization_id)` — **UNIQUE and UNPARTIAL**: one row per pairing **for all time** |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | **None. Reused unchanged** by the assignment-writes milestone, which added **no migration and no RPC**. The audit traced the whole web path and found no direct table write, no service-role client, no caller-supplied tenant id and **no TypeScript-only validation rule** — the function accepts no text input at all, so unlike V-13/V-14 it has no normalization path to a raw constraint error and needed no repair. Full audit: `docs/mobile-vendor-product-assignment-writes-audit.md`. |
| Semantics (exact) | **Create and reactivate are ONE call.** Inserts when no row exists; flips an existing `INACTIVE` row back to `ACTIVE`. Assigning an already-`ACTIVE` pairing is a **silent no-op — no row version written, no audit row**. Requires product `ACTIVE` **and** relationship `ACTIVE` **and** Retailer org `ACTIVE`; reactivation goes through the same gate. **`assigned_at` is OVERWRITTEN with `now()` on reactivation** — it is the *current* assignment's start, **not** the pairing's first-ever assignment; `assigned_by_profile_id` becomes the current caller. Audit: `PRODUCT_ASSIGNED_TO_RETAILER` / `VENDOR_PRODUCT` / product id, five whitelisted display-only metadata keys, **in the same transaction** (an audit failure rolls the mutation back — proved, not asserted). |
| Tests | pgTAP `supabase/tests/database/vendor_product_assignment_writes_test.sql` (196, shared with V-18); static `lib/products/vendor-product-assignment-writes-contract.test.ts` (47, shared) |

---

#### V-18 — Withdraw a product from a Retailer

| Field | Value |
| --- | --- |
| Feature | End an assignment. **Not deletion** — the row survives as the record that this product was once available at this Retailer |
| Role | Vendor Super Admin |
| Permission | **`PRODUCT_RETAILER_ASSIGN`** — the same gate as V-17, and again not `PRODUCTS_MANAGE` |
| Web route | `/products/[productId]` |
| Server Action | `unassignProductAction` |
| Existing RPC | `public.unassign_vendor_product_from_retailer(p_product_id uuid, p_retailer_organization_id uuid)` — `authenticated` |
| Inputs | the same two addresses, and nothing else |
| Backend-resolved | Vendor org, status, `updated_at` |
| Returns | `void` |
| Errors | `42501` only — unauthorized, unknown, foreign or not-this-Vendor's, **all one message** |
| RLS & authorization | as V-17 |
| Tables | `vendor_product_retailer_assignments`, `audit_logs` |
| Flutter direct? | **Yes** |
| Classification | **A** |
| Backend change | **None. Reused unchanged.** |
| Semantics (exact) | **Deliberately weaker than V-17: withdrawal requires NO status to be `ACTIVE`** — not the product's, not the relationship's, not the Retailer organization's. A Vendor must be able to withdraw a product from a Retailer it has since suspended, which is exactly when withdrawal matters most. Sets `status = 'INACTIVE'`; **there is no `DELETE` in either function**, and neither browser role holds `DELETE` on the table. **`assigned_at` is PRESERVED**; `updated_at` moves. Withdrawing an already-`INACTIVE` pairing — or one that never existed — is a **silent no-op that does not create a row**, so "no row" and "`INACTIVE` row" stay distinct. Audit: `PRODUCT_UNASSIGNED_FROM_RETAILER`, same entity, same five keys, same transaction. |
| Tests | as V-17 |

**Read-after-write for both.** The `void` return means a client re-reads canonically:
`get_vendor_product_detail(id)` (V-12a) and `list_vendor_product_assigned_retailers(id)`
(V-16a). After a withdrawal `assignment_count` is **unchanged** while
`active_assignment_count` drops, and the withdrawn row is **still listed**, marked `INACTIVE` —
which is how a client tells ending an assignment apart from erasing one. **Treat a no-op as
success.**

**Concurrency.** `assign` locks the product row `FOR UPDATE` before it decides, and both writes
lock the assignment row `FOR UPDATE`, so all four races (create/create, create/withdraw,
withdraw/create, withdraw/withdraw) serialize with **zero errors, zero duplicate rows, and an
audit-row count equal to the number of *real* transitions**. Run against a live two-session
database; recorded in the audit § 9. No client idempotency key is needed or added.

---

#### V-19 — Vendor company & signed-in administrator profile (read-only)

| Field | Value |
| --- | --- |
| Feature | "Which company am I administering, and who am I in it?" |
| Role | Vendor Super Admin |
| Permission | `RBAC_READ` (and **not** `ORGANIZATION_MEMBERS_READ` — see below) |
| Web route | **NONE EXISTS.** There is no `/settings`, `/company`, `/organization`, `/profile` or `/account` route. Settings is a `disabled: true` nav placeholder |
| Server Action | — (the header values come from `getVendorSuperAdminAccess()`, `lib/auth/vendor-admin-access.ts`) |
| Existing table op | None for the company. The web reads nothing from its own `organizations` row anywhere |
| Inputs | **none** — zero arguments |
| Backend-resolved | Everything: the caller from `auth.uid()`, the Vendor from `get_vendor_super_admin_context()` |
| Returns | `(administrator_display_name text, administrator_role_names text[])` — exactly one row, both fields **non-null** |
| Errors | One generic `42501` for every denial. Never zero rows, never a placeholder row |
| RLS & authorization | `SECURITY DEFINER`, `STABLE`, empty `search_path`. Delegates the whole chain to `get_vendor_super_admin_context()` and the permission to `has_organization_permission()`; reimplements neither |
| Tables | `organization_members`, `profiles`, `member_roles`, `roles` |
| Storage bucket | — (**no logo or avatar column exists anywhere in the schema**) |
| Idempotency | Read-only; no audit row |
| Flutter direct? | **Yes**, composed with `get_my_portal_context()` |
| Classification | **E → C, delivered** (the web surface is a placeholder; the contract is specified, not translated) |
| Backend change | **DONE.** `public.get_my_vendor_profile()` was added in migration `20260806090000_mobile_vendor_company_profile_reads.sql`. **Zero arguments**; `authenticated` only (never `anon`, `PUBLIC` or `service_role`).<br><br>**THE COMPANY HALF OF THE SCREEN NEEDED NO NEW BACKEND.** The audit found that the *entire* Vendor company surface in the shipped web application is one field — `organizations.name` — and `get_my_portal_context()` already returns it as `vendor.organization_name`, resolved through the same authorization chain. This function therefore returns **no company field at all**, and Flutter **must** take the company name from PortalContext. `organizations.status`, `country_code`, `default_currency`, `created_at` and `updated_at` are never displayed for the caller's own Vendor by any web surface, so none is returned. There is **no legal name, trading name, registration id, tax id, website, business phone, business email, postal address or logo column anywhere in the schema** — nothing was withheld, because nothing is stored.<br><br>**THE GAP WAS SELF-IDENTIFICATION.** `list_vendor_users()` already returns every Vendor user's roles, but carries no marker for which row is the caller — so rendering "your role" would have meant downloading the whole directory and guessing by display name. Two fields close that: the caller's own composed display name (PortalContext returns no caller name; `get_vendor_super_admin_context()` returns only raw name *parts*, and composing them in Dart would be the third implementation of that rule) and the caller's own **ACTIVE** role names as a `text[]`, byte-identical in type, filter and ordering to `list_vendor_users().role_names`.<br><br>**NO STATUS AND NO TIMESTAMP IS RETURNED, DELIBERATELY.** An authorized caller has an ACTIVE profile, ACTIVE membership and ACTIVE organization **by construction**, so such a column could only ever hold `'ACTIVE'`. This follows `get_vendor_super_admin_context()`'s own convention — *"the statuses are CONDITIONS here, not output"*. Clients must not render three status badges, and must never combine the three into one "Account status". No timestamp is returned because no web surface shows one for the caller.<br><br>**`RBAC_READ` ONLY.** The role *name* comes from the global `roles` catalogue, whose policy requires it. `ORGANIZATION_MEMBERS_READ` is deliberately **not** required: the migration-5 policies admit a caller's own `profiles`, `organization_members` and `member_roles` rows unconditionally, so demanding the directory permission to read your own name would assert something untrue. Requiring the role **and** `RBAC_READ` is narrower than the RLS `OR`s, so this read can never be more permissive than `list_vendor_users()`. Never returned: the auth user id, profile id, membership id, organization id, email, mobile number, role or permission codes, raw metadata, tokens, or any other member's data. Full audit: `docs/mobile-vendor-company-profile-reads-audit.md`. |
| Tests | pgTAP `supabase/tests/database/vendor_company_profile_reads_test.sql` (132); static `lib/portal/vendor-company-profile-reads-contract.test.ts` (34) |

> **There is no company or profile WRITE path anywhere in this product** — on web or mobile.
> No route edits an organization or a profile; no RPC updates `organizations.name`,
> `profiles.first_name`, `profiles.last_name` or `mobile_number`; there is no Vendor user
> invitation table (both invitation tables are Retailer-scoped); and there is no avatar or logo
> upload of any kind. Company editing, profile editing, and image upload are therefore not
> "deferred to mobile" — they do not exist yet at all.

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
**stored** email/name/role/shops — never the client's.

**Update — shared delivery shipped.** The five-step flow now lives in the
`send-retailer-staff-invitation` Edge Function, which both clients call, so web and Flutter
execute one sequence and receive one vocabulary of outcomes. See
`docs/retailer-staff-invitation-delivery-audit.md`.

There is **no separate resend call**: re-submitting the same address, role and shops reuses
the live invitation and the reply's `outcome` is `RESENT`. `canResendInvitation` is
therefore no longer a gate on the shared path — it is a web-only *presentation* predicate
deciding whether to show the resend button. The authoritative decision has always been
`reserve_retailer_staff_invitation()`, which refuses a terminal invitation itself; a client
that skips the predicate gets a correct refusal rather than a wrong send. **The residual
divergence risk is cosmetic** (Flutter may offer a button that the database then refuses),
not a correctness one.

---

#### RO-09 — Revoke a staff invitation

RPC `public.revoke_retailer_staff_invitation(uuid)`, `authenticated`, permission
`RETAILER_STAFF_MANAGE`. Sweeps stale invitations first, then matches on
`(id, retailer_organization_id, status='PENDING')`. Clears `token_hash`. Audits
`STAFF_INVITATION_REVOKED`. **Deliberately not gated by the feature flag** — a kill switch
must never strand an owner mid-correction. **Classification: A.**

---

#### RO-10 — Change an existing Sales Staff member's shops  *(new)*

| Field | Value |
| --- | --- |
| Feature | Replace the ACTIVE shop assignments of an already-accepted Sales Staff member |
| Role | Retailer Owner only |
| Permission | `RETAILER_STAFF_SHOP_ASSIGN` (mapped to `RETAILER_OWNER` alone) |
| Web route | **none yet — this is a backend-only milestone; no UI exists** |
| Server Action | none yet |
| RPC | `public.set_retailer_staff_shop_assignments(p_membership_id uuid, p_shop_ids uuid[])` — `authenticated`, `SECURITY DEFINER`, `VOLATILE`, empty `search_path` |
| Inputs | the canonical **membership id** (`organization_members.id`, exactly as `list_retailer_staff_members().membership_id` returns it) and the **complete** requested shop set |
| Backend-resolved | Retailer org id, acting profile, target role, target membership status, current assignments — **all** from `auth.uid()` and the tables. No organization id, actor id, role code, permission code, status, timestamp, current-assignment list or add/remove pair is accepted. |
| Returns | one row: `(shops_added integer, shops_removed integer, shops_unchanged integer)` — counts only, never an id, name, timestamp or hidden assignment |
| Errors | `42501` (unauthenticated / wrong role / unknown, foreign, inactive or non-Sales-Staff target — all **one** message), `23514` (empty or null shop list, null element, unknown/inactive/foreign shop), `55000` (Retailer suspended between resolve and lock), `22P02` (malformed UUID, raised before the body runs) |
| RLS & authorization | `resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN')`. `retailer_shop_members` keeps RLS on, **zero** policies and `REVOKE ALL` — this RPC is the only way in. |
| Tables | `organization_members`, `member_roles`, `roles`, `profiles`, `organizations`, `retailer_shops`, `retailer_shop_members`, `audit_logs` |
| Idempotency | **Yes.** An identical request writes nothing — no row, no `removed_at`, **no audit row** — and returns `(0, 0, n)`. |
| Flutter direct? | **Yes.** No text input, no secret, no service-role step, no recipient identity — nothing an Edge Function would add. |
| Classification | **A** |
| Tests | `supabase/tests/database/retailer_staff_shop_assignment_writes_test.sql` (163), `lib/staff/staff-shop-assignment-contract.test.ts` (33) |

**Complete replacement, not add/remove.** The caller asserts the whole desired set; the
diff is computed server-side. `{A,B}` → `{B,C}` is one atomic call that retires A, keeps B
and adds C. There is deliberately no second entry point: the zero-shop rule and the
active-projection rule are properties of the *final set*, and a `remove_shop(x)` could only
guess at them.

**Duplicates are canonicalized, not rejected.** `[A, A, B]` means `[A, B]` — same as
`reserve_retailer_staff_invitation`. A `NULL` *element* is still rejected (`23514`).

**At least one shop, always.** An empty or null `p_shop_ids` is refused with `23514`. This
milestone provides **no "stand this person down" operation**; staff activation/deactivation
is a separate future milestone.

**⚠️ THE ONE BEHAVIOUR A CLIENT MUST UNDERSTAND — replacement is scoped to shops that are
currently `ACTIVE`.** `list_retailer_staff_members()` filters `shop_ids`/`shop_names` to
`s.status = 'ACTIVE'`, so a live assignment to a SUSPENDED or DEACTIVATED shop is
**invisible** to every client. Omitting it from a request therefore carries no intent, and
the backend treats it accordingly:

- a live assignment whose shop is **not** `ACTIVE` is **preserved untouched**, and is
  counted in **none** of `shops_added` / `shops_removed` / `shops_unchanged`;
- consequently `shops_unchanged + shops_added` is the size of the **visible** set after the
  write, which may be **fewer** rows than the table actually holds for that member;
- a client must **not** present the three counts as "this person's total shops", and must
  re-read `list_retailer_staff_members()` for display.

Without this scoping, a client faithfully round-tripping what it read would silently
destroy assignments its user never saw — and `retailer_shop_members` has no restore.

**Atomicity and concurrency.** One transaction. The target membership is locked
`FOR UPDATE` — the serialization point, so two concurrent calls against the same member
queue and the second diffs against the first's committed state. Requested shops are locked
`FOR SHARE` in ascending UUID order (the `accept_retailer_staff_invitation` pattern), so
overlapping requests cannot deadlock and a shop cannot be deactivated mid-write. One
invalid shop refuses the **whole** request before anything is written. There are **no**
client-supplied versions, ETags or timestamps: last write wins, which is the correct
semantics for a set editor.

**Retirement, never deletion.** A dropped assignment gets `removed_at = now()` and stays on
record. Re-adding a previously removed shop **INSERTS A NEW ROW**; the retired one is never
resurrected, so the fact that the person was off that shop survives.

**Audit.** One row per *changing* call: `action = 'STAFF_SHOP_ASSIGNMENTS_UPDATED'`,
`entity_type = 'RETAILER_STAFF_MEMBER'`, `entity_id` = the membership id,
`organization_id` = the **Retailer's** (so it is invisible to `list_vendor_audit_logs`,
which filters on the caller's Vendor). Metadata carries exactly seven keys —
`retailer_name`, `role_code`, `membership_status`, `shop_count_before`, `shop_count_after`,
`shops_added`, `shops_removed` — with shop **names**, never ids. No uuid, email, token or
hash appears anywhere in it.

---

#### RO-11 — Deactivate / reactivate an existing staff member  *(new)*

| Field | Value |
| --- | --- |
| Feature | Stand an existing Retailer Manager or Sales Staff member down, and put them back |
| Role | Retailer Owner only |
| Permission | `RETAILER_STAFF_MANAGE` — the **existing** one. **No new staff permission was created.** |
| Web route | **none yet — this is a backend-only milestone; no UI exists** |
| Server Action | none yet |
| RPC | `public.set_retailer_staff_membership_status(p_membership_id uuid, p_status text)` — `authenticated`, `SECURITY DEFINER`, `VOLATILE`, empty `search_path` |
| Inputs | the canonical **membership id** (`organization_members.id`, exactly as `list_retailer_staff_members().membership_id` returns it) and the requested state, exactly `ACTIVE` or `DEACTIVATED` |
| Backend-resolved | Retailer org id, acting profile, target role set, target's user id (for the self check), current membership status — **all** from `auth.uid()` and the tables. No organization id, actor id, profile id, Auth user id, role code, permission code, current status, audit action or timestamp is accepted. |
| Returns | one row: `(membership_id uuid, membership_status text, role_code text, status_changed boolean)` |
| Errors | `42501` (unauthenticated / wrong role / unresolved Retailer / null, unknown, foreign, **self**, **Owner**, multi-role, role-less, `INVITED` or `SUSPENDED` target — all **one** SQLSTATE **and one message**), `23514` (`p_status` not exactly `ACTIVE` or `DEACTIVATED`), `55000` (acting Retailer not ACTIVE at lock time — defence in depth, see below), `22P02` (malformed UUID, raised before the body runs) |
| RLS & authorization | `resolve_retailer_member_organization('RETAILER_STAFF_MANAGE')`. `organization_members` keeps RLS on, its one **read** policy, and `SELECT`-only browser privilege — this RPC is the only way a browser session can change a membership status. |
| Tables | `organization_members` (the only one written), `member_roles` (read), `roles` (read), `profiles` (read), `organizations` (read + `FOR SHARE`), `audit_logs` (appended) |
| Idempotency | **Yes.** An identical requested status writes nothing — no row, no moved `deactivated_at`, **no audit row** — and returns `status_changed = false`. |
| Flutter direct? | **Yes.** No text input, no secret, no service-role step, no recipient identity. |
| Classification | **A** |
| Tests | `supabase/tests/database/retailer_staff_membership_lifecycle_test.sql` (252), `lib/staff/staff-membership-lifecycle-contract.test.ts` (65) |

**The status vocabulary is exactly two words.** `ACTIVE` and `DEACTIVATED`, compared exactly
and case-sensitively — `active`, `' ACTIVE'`, `''` and `NULL` are all `23514`, never coerced.
`INVITED` and `SUSPENDED` are column values but **not** this RPC's vocabulary, in either
direction: a membership becomes `ACTIVE` by the recipient **accepting** their invitation (the
only place consent is recorded and Shop rows are created), and `SUSPENDED` has no owner in this
milestone. Permitted **current** states are likewise `ACTIVE` and `DEACTIVATED` only.

**Eligible targets are exact role sets: `{RETAILER_MANAGER}` or `{SALES_STAFF}`.** The whole
ACTIVE role set is compared, not tested for membership, which refuses **every**
`RETAILER_OWNER` target, every multi-role target and every role-less target in one comparison.
Owners are excluded because an Owner is the tenant's root of authority — deactivating one can
strand a Retailer with nobody able to reactivate anybody. Owner lifecycle belongs to the
Vendor-side milestone, whose actor sits outside the tenant.

**The caller may not address their own membership.** A separate rule from the Owner rule,
compared on user ids, so it still holds if `RETAILER_STAFF_MANAGE` is ever granted to
`RETAILER_MANAGER`.

**⚠️ WHAT A CLIENT MUST UNDERSTAND — `auth.users` IS NOT TOUCHED, SO A DEACTIVATED PERSON CAN
STILL SIGN IN.** They are not banned, not deleted and not updated. What they lose is *context*:
`get_my_portal_context()` reports `NONE` and every protected RPC refuses. This takes effect on
an **already-issued session**, with no sign-out and no token revocation, because every
protected RPC re-derives authorization from `auth.uid()` on each call — the session is not the
authority, the membership row is. A client must therefore **not** assume a successful login
implies access, and must handle a mid-session loss of context gracefully.

**Nothing is destroyed, so reactivation restores everything automatically.** The whole change
is `organization_members.status` plus `deactivated_at`, written in one statement so the pair
can never disagree. `member_roles`, live **and** retired `retailer_shop_members`, `profiles`
(including `profiles.status`), receipt history, invitation history and audit history all
survive untouched. There is **no DELETE anywhere on this path**. Reactivation therefore needs
no role or Shop assignment to be recreated — a property the pgTAP suite asserts directly.

**Refusals are uniform.** All seven disclosure-sensitive target causes share one SQLSTATE
**and one literal message**, so an unknown id is indistinguishable from another Retailer's
Owner. The message carries no uuid, email, role code, status or organization name.
Authorization is decided **before** input validation, so a stranger with a malformed status is
refused as a stranger. **Rendered clients must never surface the raw SQLSTATE or the
PostgreSQL message.**

**`55000` is currently unreachable** — the resolver already requires an ACTIVE organization and
sees the same snapshot, so the observable answer today is `42501`. The branch exists for the
Vendor-side Retailer lifecycle write (a **later milestone**), which is what will make it
reachable. Handle it now; expect `42501` in practice.

**Audit.** One row per *changing* call: `action = 'STAFF_MEMBERSHIP_DEACTIVATED'` or
`'STAFF_MEMBERSHIP_REACTIVATED'`, `entity_type = 'RETAILER_STAFF_MEMBER'`, `entity_id` = the
membership id, `organization_id` = the **Retailer's** (so it is invisible to
`list_vendor_audit_logs`). Metadata carries exactly three keys — `role_code`,
`membership_status_before`, `membership_status_after` — all proved server-side. No uuid, email,
token, hash, Shop, invitation or receipt reference appears anywhere in it.

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
| ~~`get_vendor_admin_dashboard_summary()`~~ ✅ **shipped** — `20260805090000` | V-01's four counts | Pure aggregate |
| ~~`list_vendor_organization_members()`~~ → shipped as **`list_vendor_users()`** ✅ — `20260801090000` | V-02's four-query join | Pure join |
| `list_vendor_audit_logs(p_limit, p_before)` | V-04 | Pure read; adds pagination mobile needs |
| ~~`list_vendor_retailers()`~~ ✅ **shipped** — `20260731090000` | V-05 | Pure aggregate |
| ~~`get_vendor_retailer_detail(p_relationship_id)`~~ ✅ **shipped** — `20260731090000` | V-06's three reads | Pure read, already-proven ownership pattern |
| `list_vendor_retailer_shops(p_relationship_id)` ✅ **shipped** — `20260731090000` | V-06's shop list | Justified companion: a shop list is unbounded and must not be nested in a detail payload |
| `get_vendor_user_detail(p_membership_id)` ✅ **shipped** — `20260801090000` | A Vendor user detail screen | Justified companion: **no web counterpart exists**, so it is specified rather than translated |
| ~~`list_vendor_rbac_catalog()`~~ → shipped as **`list_vendor_roles()`** ✅ — `20260802090000` | V-03's three-query join | Pure join + two aggregates; the web emits no id at all |
| `get_vendor_role_detail(p_role_id)` ✅ **shipped** — `20260802090000` | A Vendor role detail screen | Justified companion: **no web counterpart exists**, and it is the authoritative existence check for the permission list below |
| `list_vendor_role_permissions(p_role_id)` ✅ **shipped** — `20260802090000` | V-03's per-role permission list | Justified companion: a permission is a **pair** (name, description), so it cannot be a typed `text[]`, and the catalogue grows with every module — nesting it would make the detail row unbounded |

All are read-only, need no secret, and are enforceable by the existing resolvers. Putting
them in SQL means **one definition for both clients** — which is the whole point.

**All seven are delivered** (`get_my_portal_context`, `get_vendor_admin_dashboard_summary`,
`list_vendor_users`, `list_vendor_audit_logs`, `list_vendor_retailers`,
`get_vendor_retailer_detail`, `list_vendor_roles`), plus the four companion reads above. **None
is consumed by the web yet:** each shipped RPC is additive, and migrating a web page to it is a
separate change with its own review.

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

**The same defect existed on the web Vendor Users list, and is closed for mobile.**
`lib/members/vendor-organization-members.ts` returns rows carrying **no id at all** — every
membership, profile and role id is used to join on the server and then dropped, and
`app/(admin)/users/page.tsx` keys its rows by array index as a result. `list_vendor_users()`
(`20260801090000`) returns `membership_id`, which is both the widget key and the detail
selector. The web page is unchanged.

**And on the web Vendor Roles page, twice over — also closed for mobile.**
`lib/rbac/vendor-rbac-catalog.ts` selects `roles.id`, `permissions.id` and both
`role_permissions` columns purely to join in memory, then **drops every one of them**, so
`app/(admin)/roles/page.tsx` keys *both* its role list and each permission list by array
index (with a comment saying so). `list_vendor_roles()` (`20260802090000`) returns `role_id`,
which is the widget key and the selector for both companion reads. Permission rows are
deliberately still id-free — they are never navigated to, only rendered — so the fix is
applied where a client actually needs it and nowhere else. The web page is unchanged.

### 6.4 Errors discriminated by English message text

- `reserve_retailer_staff_invitation` signals a role/shop conflict only through the message
  `"Revoke and re-issue this invitation to change its role or shops"`, string-matched in
  `lib/staff/retailer-staff-invitations.ts`.
- `create_vendor_product` / `update_vendor_product` distinguish duplicate **code** from
  duplicate **barcode** by substring, in `lib/products/vendor-products.ts`.
  **Mitigated, not solved:** `lib/products/vendor-product-writes-contract.test.ts` now pins the
  exact allowlist of messages those two functions may raise, and
  `vendor_product_writes_test.sql` asserts both literals by value. A rewording therefore fails
  a test instead of silently breaking a client — but the discrimination is still by text, and
  the recommendation below stands.

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

**Deliberately left as-is by the product-writes milestone.** Changing a return type needs a
`DROP` + re-`CREATE` of a function the web calls, which is not an additive change, and the
information is recoverable: `get_vendor_product_detail(id)` returns the authoritative row
after any write, on a primary-key lookup. Both no-ops are *successes*, so a client that treats
them as such loses nothing today. See `docs/mobile-vendor-product-writes-audit.md` § 11.

**Reaffirmed by the assignment-writes milestone, for the two assignment functions.** Same
reasoning, plus one that is specific to them: the no-op branch is what makes a **double-tap
harmless** — it writes no row version *and no audit row*, so a repeated request cannot produce
two audit entries for one decision. A `boolean` return would be nice to have; an audit trail
whose entries do not correspond to changes would not. Canonical state after either write comes
from `get_vendor_product_detail(id)` and `list_vendor_product_assigned_retailers(id)`. See
`docs/mobile-vendor-product-assignment-writes-audit.md` § 11.

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
  ✅ **Closed for the Product surface too.**
  `list_vendor_product_assigned_retailers()` (`20260803090000`) returns `relationship_id`
  alongside `retailer_organization_id`, so a Flutter *product* screen can now open the shipped
  Vendor Retailer detail screen directly. Same direction rule: `relationship_id` is an output,
  never an input — both new product reads take only `p_product_id`. It is **nullable**, because
  the relationship join is `LEFT` so that no assignment row can be dropped from a list whose
  length must equal `get_vendor_product_detail().assignment_count`; treat a null as "not
  cross-linkable", not as an error. The **old** `list_vendor_product_retailer_assignments()` is
  unchanged and still returns no relationship id — it is the assign/withdraw editor matrix and
  the web depends on it as it is.
  ✅ **Settled for the assignment WRITES, with no change to them.** The assignment-writes
  audit examined whether V-17/V-18 should be re-addressed by `p_relationship_id` and concluded
  **no**: `vendor_product_retailer_assignments` stores `retailer_organization_id` directly and
  has **no relationship_id column**, so a relationship-id parameter would need a translation
  step whose failure modes have no correct answer; and `relationship_id` is **nullable** in the
  read contract, which would make the write un-callable for exactly the historical rows that
  most need withdrawing. The two address spaces are reconciled **by the reads** instead —
  `list_vendor_retailers()` and `list_vendor_product_assigned_retailers()` each carry **both**
  ids on the same row, so a client opens the Retailer screen by `relationship_id` and calls the
  write with `retailer_organization_id` without a second lookup. The Retailer organization id is
  not authorization: the same Retailer may legitimately be managed by two Vendors, and the write
  reaches it only through the **derived** Vendor's own relationship row.

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
| **B** — existing RLS-protected table access | 4 (all also candidates for C; V-03 has since moved to C) | ~10 % |
| **C** — new shared RPC recommended | 8 — **all 8 delivered** (`get_my_portal_context`, `list_vendor_retailers`, `get_vendor_retailer_detail`, `list_vendor_users`, `list_vendor_roles`, `get_vendor_product_detail` + `list_vendor_product_assigned_retailers`, `list_vendor_audit_logs`, `get_vendor_admin_dashboard_summary`), plus **V-19** `get_my_vendor_profile` — a surface the web has only as a placeholder, so it was specified rather than translated | ~18 % |
| **D** — Edge Function required | 7 | ~16 % |
| **E** — web-only UI to recreate | 7 surfaces | — |
| **F** — needs a product decision | 9 questions | — |

Counted against the ~43 user-facing operations in § 3. Several operations appear in more than
one category (e.g. V-06 is A + B and would become C).
