# Mobile Feature Matrix — SalesReward

Companion to [`mobile-backend-contract.md`](./mobile-backend-contract.md), which holds the
full per-operation detail. This is the at-a-glance planning view.

**Status:** originally audit only. Since then, purely additive read RPCs have been shipped
(migrations `20260729090000` … `20260806090000`). **No table, RLS policy, grant on a table,
existing RPC, seed row or application file has been changed by any of them**, and no web page
changed behaviour — every row below marked ✅ **shipped** refers to a new function and nothing
else.

**One exception, `20260807090000`:** the Vendor Product *write* milestone added **no** RPC. It
`CREATE OR REPLACE`d two existing ones — `create_vendor_product` and `update_vendor_product` —
to close a confirmed normalization defect, keeping their signatures, return types, grants and
semantics identical. Still no table, policy, grant, seed row or application file changed, and
no web behaviour changed. Rows marked ✅ **reused verbatim** refer to functions this repository
adopted for mobile without altering their contract.

## Legend

**Backend readiness**
- 🟢 **Ready** — an authenticated RPC or RLS-protected read already exists and is sufficient
- 🟡 **Partial** — works, but would force Flutter to duplicate a multi-query join or a
  TypeScript rule
- 🔴 **Blocked** — completion requires the service-role key, a third-party secret, or a
  capability that does not exist

**Flutter readiness**
- 🟢 **Now** — buildable today against the Supabase Dart SDK, no backend change
- 🟡 **After backend work** — needs the listed RPC or Edge Function first
- 🔴 **Blocked on a decision** — see the security-concern column and § 7 of the contract

**Phase**
- **1** — Sales Staff mobile MVP
- **2** — Retailer Owner / Manager management
- **3** — Vendor administration (if in scope at all — see Q4)
- **—** — web-only; not a mobile feature

---

## 1. Authentication and session

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Email + password sign-in | Shipped | 🟢 Ready | 🟢 Now | — (`supabase.auth`) | No | None. Generic error text must be preserved — never reveal whether an address exists. | **1** |
| Sign out | Shipped | 🟢 Ready | 🟢 Now | — | No | Use `scope: 'local'` as web does, so other sessions survive. | **1** |
| Token refresh / session persistence | Shipped (`proxy.ts`) | 🟢 Ready | 🟢 Now | — | No | Dart SDK handles it. Store the session in `flutter_secure_storage`, never `SharedPreferences`. | **1** |
| Resolve Vendor Super Admin context | Shipped | 🟢 Ready | 🟢 Now | `get_vendor_super_admin_context()` | No | Re-assert `row.user_id == session.user.id`, as the web client does. | **3** |
| Resolve retailer portal role (owner/reader/submitter) | Shipped | 🟢 Ready | 🟢 Now | `get_my_portal_context()` ✅ **delivered** | No | Was inferred from *which list RPC returns 42501*. Now one trusted call. The web still probes — its migration is deferred, see AUTH-05. | **1** |
| Role-based landing / first screen | Shipped (`selectLanding`) | 🟢 Ready | 🟢 Now | `get_my_portal_context().portal_kind` ✅ **delivered** | No | Vendor-first precedence now has one definition, in SQL. `vendor` and `retailer` are resolved independently so a dual-role caller gets both. | **1** |
| Password policy | Shipped | 🟢 Ready | 🟢 Now | — | No | Port `lib/auth/password-policy.ts` verbatim; Supabase Auth is the real authority. | **1** |
| Account switching (multi-Retailer user) | **Not supported** | 🔴 Blocked | 🔴 Blocked on decision | TBD | TBD | `resolve_retailer_*_organization` returns `NULL` when the caller qualifies at >1 Retailer — total silent denial. **Q2.** | **2** |

---

## 2. Sales Staff

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List my assigned shops | Shipped | 🟢 Ready | 🟢 Now | `list_my_assigned_receipt_shops()` | No | None. Cleanest contract in the schema. | **1** |
| Submit a receipt photo | Shipped | 🔴 Blocked | 🟡 After backend work | `reserve_receipt_submission()` (step 1 only) | **Yes — `submit-receipt`** | Storage has **zero policies**; upload needs the service key. Magic-byte MIME sniffing and orphan-object cleanup are server-side and must stay so. | **1** |
| Camera capture | n/a (file input) | 🟢 Ready | 🟢 Now | — | No | Downscale before upload; the bucket caps at 10 MiB and only `image/jpeg\|png\|webp` pass. | **1** |
| Duplicate-receipt protection | Shipped | 🟢 Ready | 🟢 Now | enforced by unique index | No | SHA-256 must be computed over the **exact bytes uploaded**; re-encoding after hashing breaks the guard. | **1** |
| My receipt history | Shipped | 🟢 Ready | 🟢 Now | `list_my_receipt_submissions()` | No | Scoped to `auth.uid()` in SQL. | **1** |
| View a submitted receipt image | **Does not exist** | 🔴 Blocked | 🔴 Blocked on decision | — | **Yes — `get-receipt-image-url`** | No read path exists anywhere. Any signed URL must be short-lived and issued only after `submitted_by_profile_id = auth.uid()` is verified. **Q1.** | **2** |
| Offline capture / retry queue | **Does not exist** | 🟡 Partial | 🔴 Blocked on decision | — | via `submit-receipt` | Reservation needs connectivity. Queued bytes on-device are unencrypted customer data unless deliberately protected. **Q5.** | **2** |

---

## 3. Retailer Owner

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Portal overview (retailer + shop counts) | Shipped | 🟢 Ready | 🟢 Now | `get_retailer_owner_portal_context()` | No | Returns 0 rows for a Manager — do not render as an error. | **2** |
| Own shops list | Shipped | 🟡 Partial | 🟢 Now | `list_retailer_owner_portal_shops()` | No | **Returns no `shop_id`** — cannot key a list or navigate to detail. | **2** |
| Assigned products | Shipped | 🟢 Ready | 🟢 Now | `list_retailer_assigned_products()` | No | None. Filtered to ACTIVE×ACTIVE in SQL. | **2** |
| Staff roster | Shipped | 🟢 Ready | 🟢 Now | `list_retailer_staff_members()` | No | Visibility difference between Owner and Manager is decided **in SQL**. Never re-implement it client-side. | **2** |
| Staff invitations list | Shipped | 🟡 Partial | 🟢 Now | `list_retailer_staff_invitations()` | No | `derived_state` has no `ELSE` branch and can be `NULL`. Handle it. | **2** |
| Assignable shops (for invites) | Shipped | 🟢 Ready | 🟢 Now | `list_retailer_staff_assignable_shops()` | No | None. | **2** |
| Invite a staff member | Shipped | 🟢 Ready | 🟢 Now | ✅ **shipped** `send-retailer-staff-invitation` (named for the RPC family it wraps, not the planned `send-staff-invitation`) | Uses it | Send `{firstName, lastName, email, roleCode, shopIds}` and **nothing else** — an unknown key is a 400. `shopIds` is required: `[]` for a Manager, ≥1 for Sales Staff. Token generation, the Resend key and the 3 `service_role` RPCs stay inside the function; none is ever returned. Enforces `RETAILER_STAFF_INVITATIONS_ENABLED` itself. Read `outcome` before `code`, and **never auto-retry a 2xx** — `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` (202) means re-read the invitation history, not resend. Full contract: `docs/retailer-staff-invitation-delivery-audit.md` § L. | **2** |
| Re-send a staff invitation | Shipped | 🟢 Ready | 🟢 Now | same function | Uses it | There is no separate resend call: re-submitting the same address, role and shops reuses the live invitation and the reply's `outcome` is `RESENT`. The token is **rotated** on every send, so a resend invalidates the previous link. `canResendInvitation` remains a web-only presentation predicate and is not part of this contract. | **2** |
| Revoke a staff invitation | Shipped | 🟢 Ready | 🟢 Now | `revoke_retailer_staff_invitation()` | No | Deliberately **not** flag-gated — a kill switch must not strand an owner. Preserve that. | **2** |
| Accept an owner invitation (new account) | Shipped | 🟢 Ready | 🟡 After backend work | `accept_retailer_owner_invitation()` | No | Needs deep-link handling of the Supabase `verifyOtp` URL. **Q6.** | **2** |
| Accept an owner invitation (existing account) | Shipped | 🟢 Ready | 🟡 After backend work | `get_pending_existing_user_retailer_invitation()`, `accept_existing_user_retailer_owner_invitation()` | No | Flutter must SHA-256 the deep-link token itself and store **only the hash**. Never persist the raw token. **Q6.** | **2** |

---

## 4. Retailer Manager

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Staff roster, read-only (ACTIVE members only) | Shipped | 🟢 Ready | 🟢 Now | `list_retailer_staff_members()` | No | Same RPC as the Owner; the narrowing is a permission check inside the function. | **2** |
| Assigned products | Shipped | 🟢 Ready | 🟢 Now | `list_retailer_assigned_products()` | No | `RETAILER_PRODUCTS_READ` is mapped to `RETAILER_MANAGER`. | **2** |
| Read own Retailer name / branding | **Does not work** | 🔴 Blocked | 🔴 Blocked on decision | TBD | No | `get_retailer_owner_portal_context()` hard-filters `RETAILER_OWNER`. A Manager cannot read their own tenant name. **Q3.** | **2** |
| Manage staff / invite | Correctly denied | 🟢 Ready | 🟢 Now | — | No | Denial is enforced by permission mapping, not by UI. Flutter hides the affordance; SQL enforces it. | **2** |

---

## 5. Invited-recipient flows (pre-membership)

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Open a staff invitation link | Shipped (cookie handoff) | 🟢 Ready | 🟡 After backend work | — | No | Web uses an `HttpOnly` cookie + `Referrer-Policy: no-referrer`. Flutter needs an app-link equivalent. **Q6.** | **1** |
| Decide how to onboard (register / sign in / recover / blocked) | Shipped | 🔴 Blocked | 🟡 After backend work | `get_retailer_staff_registration_context()` (`service_role`) | **Yes — `staff-invitation-context`** | **Repaired by migration `20260808090000`.** The RPC no longer returns the invited email at all — it returns `{ account_state, expires_at }`, so the Edge Function should pass `{ state, expiresAt }` straight through. There are **five** states, not two: `NO_ACCOUNT` and `ACTIVATION_REQUIRED` → first-password activation; `SIGN_IN` → ordinary login; `RECOVERY_REQUIRED` → **emailed reset link only, never a password field** (the row may already carry a provisioned identity, so setting its password from an invitation token would turn that token into a credential); `ACCOUNT_BLOCKED` → neutral support copy with no reason. Treat an unrecognized state as "unavailable", never as activation. The address is resolved by a separate `service_role`-only RPC and must never reach a client. Full rationale: `docs/retailer-staff-account-recovery-audit.md`. | **1** |
| Activate an invited staff account | Shipped | 🔴 Blocked | 🟡 After backend work | — | **Yes — `activate-staff-account`** | **Highest-risk endpoint.** The email is derived server-side from the token hash. If it ever becomes a parameter, anyone can claim any invited address. | **1** |
| View invitation details before accepting | Shipped | 🟢 Ready | 🟢 Now | `get_retailer_staff_invitation_for_recipient()` | No | Requires a confirmed session whose email matches. Zero rows on any failure. | **1** |
| Accept a staff invitation | Shipped | 🟢 Ready | 🟢 Now | `accept_retailer_staff_invitation()` | No | Email equality + `email_confirmed_at` checked in SQL. | **1** |

---

## 6. Vendor Super Admin

Every row here is phase **3** and is conditional on **Q4** — whether Vendor administration
belongs on mobile at all.

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard summary counts | Shipped (four real counts — no mocked, static or placeholder card anywhere on the page) | 🟢 Ready | 🟢 Now | ✅ **shipped** `get_vendor_admin_dashboard_summary()` — migration `20260805090000` | No | Was **five** round trips (1 auth RPC + 4 parallel counts), each re-walking the authorization chain through its RLS policy; now **one**. Zero arguments; requires the Vendor Super Admin role **and** all three of `ORGANIZATION_MEMBERS_READ`, `RBAC_READ`, `AUDIT_LOGS_READ` — deliberately **non-partial**, so a caller missing one is denied the whole summary. Returns exactly one row of four **non-null** `bigint`s; zero rows is unreachable for an authorized caller, and a denial is `42501`, **never** a row of zeros. **Two of the four counts are GLOBAL catalogue figures, not Vendor metrics** — `roles` and `permissions` carry no `organization_id`, so every Vendor sees the same number; the fields are named `catalog_active_role_count` / `catalog_permission_count` for that reason and must **not** be labelled "your roles". `audit_event_count` is **all-time and unwindowed** — do not label it "recent". No Retailer, Product, shop, assignment or invitation count is returned, because no such card exists on the web. Full audit: `docs/mobile-vendor-dashboard-summary-audit.md`. | **3** |
| Organization members directory | Shipped | 🟡 Partial | 🟡 After backend work | **New:** `list_vendor_organization_members()` | No | Four-query join currently done in TypeScript. | **3** |
| Roles & permissions catalogue **+ role detail** | Shipped (list only — there is no web role-detail page, and no role write surface at all) | 🟢 Ready | 🟢 Now | ✅ **shipped** `list_vendor_roles()`, `get_vendor_role_detail(p_role_id)`, `list_vendor_role_permissions(p_role_id)` — migration `20260802090000` | No | Global catalogue gated on `RBAC_READ`; the two counting reads also require `ORGANIZATION_MEMBERS_READ`. The catalogue carries **no `organization_id`**, so every Vendor sees the same six roles (including the three Retailer roles) — the only tenant-scoped value is `assigned_member_count`. | **3** |
| Audit log feed | Shipped (list only — **no detail view of any kind exists on the web**) | 🟢 Ready | 🟢 Now | ✅ **shipped** `list_vendor_audit_logs(p_limit, p_before_occurred_at, p_before_audit_log_id)` — migration `20260804090000` | No | Was fixed 100 rows with no pagination — record 101 was unreachable forever. Now keyset on `(created_at, id)`; both cursor parts required together; limit default 50, hard max 100. Actor resolves to `USER` / `SYSTEM` / `UNKNOWN`, scoped to the audit row's **own** Vendor membership so no foreign name can appear. **`SYSTEM` = “no actor identity remains”, not “a system process acted”** — render it as *“System or unavailable actor”*. Entity named from a **closed** metadata snapshot whitelist; raw `metadata`, `entity_id`, `ip_address`, `user_agent` and `actor_profile_id` are never returned. Action and entity codes are **raw** — no DB label map exists. Null-organization rows are still excluded, exactly as RLS intends. | **3** |
| Retailers directory | Shipped | 🟡 Partial | 🟡 After backend work | **New:** `list_vendor_retailers()` | No | Currently fetches every shop row just to count them. | **3** |
| Retailer detail + owner status | Shipped | 🟡 Partial | 🟡 After backend work | `get_vendor_retailer_owner_status()` + **new** `get_vendor_retailer_detail()` | No | The owner-status function has been **dropped and recreated three times** with a growing column list. Not yet a stable pinned-client contract. | **3** |
| Onboard a Retailer | Shipped | 🟢 Ready | 🟢 Now | `onboard_vendor_retailer()` | No | **No idempotency** — a double submit creates two Retailers. Mobile must disable the button on submit. | **3** |
| Add a shop | Shipped | 🟢 Ready | 🟢 Now | `add_vendor_retailer_shop()` | No | Duplicate shop code → `23505`; duplicate name is allowed. | **3** |
| Invite a Retailer Owner (new account) | Shipped | 🔴 Blocked | 🟡 After backend work | `reserve_retailer_owner_invitation()` (step 1) | **Yes — `invite-retailer-owner`** | Auth Admin API + `service_role` finalization. The resend-vs-new decision is TypeScript-only today. | **3** |
| Invite a Retailer Owner (existing account) | Shipped | 🔴 Blocked | 🟡 After backend work | same | **Yes — `send-existing-user-owner-invitation`** | Token + Resend + 3 `service_role` RPCs. | **3** |
| Revoke an owner invitation | **Built but unwired** | 🟢 Ready | 🔴 Blocked on decision | `revoke_retailer_owner_invitation()` | No | Granted, audited, and called by nothing anywhere in the codebase. **Q8.** | **3** |
| Product catalogue list | Shipped | 🟢 Ready | 🟢 Now | `list_vendor_products()` ✅ **reused verbatim** (`20260803090000` added no second list) | No | None. Already SQL-aggregated, zero-argument, and free of tenant internals — the one Vendor list that needed no work. | **3** |
| Product detail | **Web has none** — it `Array.find()`s the whole catalogue in TypeScript | 🟢 Ready | 🟢 Now | `get_vendor_product_detail()` ✅ **shipped** (`20260803090000`) | No | List columns **plus `assignment_count`**; both counts `bigint`. Unknown, foreign and null ids all return **zero rows**, never an error. | **3** |
| A product's assigned Retailers (read-only) | **New** | 🟢 Ready | 🟢 Now | `list_vendor_product_assigned_retailers()` ✅ **shipped** (`20260803090000`) | No | Returns `relationship_id`, closing the two-address-space gap for the product surface. Requires `PRODUCTS_READ` **and** `RETAILERS_READ`. `relationship_id` is nullable. | **3** |
| Create / update a product | Shipped (real forms, not placeholders — create is inline on `/products`, edit inline on `/products/[productId]`; there is **no** `/products/new` or `/edit` route, and **no delete anywhere**) | 🟢 Ready | 🟢 Now | `create_vendor_product()`, `update_vendor_product()` ✅ **reused verbatim — no new write RPC**, signatures unchanged; **repaired** by `20260807090000` | No | The web already writes through these SECURITY DEFINER RPCs — the Server Actions add no rule of their own, so there was **no shared-contract gap to close**. One defect was found and fixed: normalization ran `btrim` (U+0020 **only**) *before* collapsing whitespace, so a leading/trailing tab, newline, CR, form feed, vertical tab or Unicode space separator became an untrimmed space and hit a table `CHECK`, returning PostgreSQL's **raw error naming `vendor_products` and the constraint**. The web never hit it because `product-input.ts` trims in JS first — a **TypeScript-only rule a second client bypasses**. Now collapse-then-trim over an explicit class equal to JavaScript's `\s`, asserted equal in both directions by a static test. **No input can reach a constraint any more.** `product_code` is **immutable** and not a parameter; create takes **no** initial-status and **no** organization argument; a no-op edit is a silent success and writes no audit row. Duplicate code vs barcode is still discriminated by **English message substring**, but both literals are now pinned by tests. Full audit: `docs/mobile-vendor-product-writes-audit.md`. | **3** |
| Activate / deactivate a product | Shipped | 🟢 Ready | 🟢 Now | `set_vendor_product_status()` ✅ **reused verbatim — NOT modified** by `20260807090000` | No | Returns `void`; silent no-op when already in that state (no write, no `updated_at` movement, **no audit row** — which is what stops a mobile double-tap producing two audit rows for one decision). Gated on **`PRODUCTS_MANAGE`, the same permission as create and edit** — verified by removing the seeded mapping in pgTAP, not assumed. Both transitions permitted both ways. **Deactivation does not touch assignment rows**, not even their `updated_at`; it blocks *new* assignments (`55000`) and hides the product from the Retailer-facing list. It is **not** deletion — the row, its `created_at` and all assignment history survive, and an INACTIVE product stays editable. Needed no repair: its only normalization feeds a closed `in ('ACTIVE','INACTIVE')` test, so it has no path to a raw constraint error. | **3** |
| List a product's Retailer assignments (**editor** matrix) | Shipped | 🟢 Ready | 🟢 Now | `list_vendor_product_retailer_assignments()` | No | Returns `retailer_organization_id` and **every** managed Retailer, assigned or not, under `PRODUCT_RETAILER_ASSIGN`. Unchanged — the web assign/withdraw matrix depends on it. Use the read-only row above for a mobile read. | **3** |
| Assign / withdraw a product | Shipped | 🟢 Ready | 🟢 Now | ✅ **reused verbatim — NO migration and NO new RPC added** `assign_vendor_product_to_retailer(p_product_id, p_retailer_organization_id)`, `unassign_vendor_product_from_retailer(...)` | No | The audit traced the whole web path — page → Server Action → `lib/products/vendor-products.ts` → RPC — and found **no direct table write, no service-role client, no caller-supplied tenant id and no TypeScript-only validation rule**. Both writes accept **no text input at all**, so unlike the product record writes they have no normalization path to a raw constraint error and needed no repair. **Gated on `PRODUCT_RETAILER_ASSIGN`, which is genuinely distinct from `PRODUCTS_MANAGE`** — verified by removing each seeded mapping in turn in pgTAP: `PRODUCTS_MANAGE` alone does **not** grant assignment, and `PRODUCT_RETAILER_ASSIGN` alone **is** sufficient. **Assign and reactivate are ONE call**; withdraw is separate, and **deliberately weaker** — it requires **no** status to be `ACTIVE`, so a product can still be withdrawn from a suspended Retailer. **Withdrawal never deletes**: one row per (product, Retailer) **for all time** under an unpartial unique index, and there is no `DELETE` in either function. **`assigned_at` is OVERWRITTEN on reactivation** — it is the current assignment's start, not the pairing's first — while withdrawal preserves it; do not label it "first assigned". `void` return hides "changed" vs "already so", so **treat a no-op as success** and re-read `get_vendor_product_detail()` + `list_vendor_product_assigned_retailers()`. Addressed by `retailer_organization_id`; both reads carry it alongside `relationship_id`, so no second lookup is needed. All four concurrency races serialize with zero duplicate rows. Audit is transactional — an audit failure rolls the mutation back. Full audit: `docs/mobile-vendor-product-assignment-writes-audit.md`. | **3** |
| Vendor company & signed-in administrator profile (read-only) | **Placeholder** — no `/settings`, `/company`, `/organization`, `/profile` or `/account` route exists; Settings is a `disabled: true` nav item. The only real surface is the admin **header** (organization name + caller name) | 🟢 Ready | 🟢 Now | `get_my_portal_context()` for the company name (**reused verbatim, nothing added**) + ✅ **shipped** `get_my_vendor_profile()` — migration `20260806090000` | No | **The company half needed no backend at all.** The entire Vendor company surface in the product is one field, `organizations.name`, which PortalContext already returns as `vendor.organization_name` — so the new RPC returns **no company field** and Flutter **must** read the name from PortalContext. `status`, `country_code`, `default_currency` and the timestamps are never shown for the caller's own Vendor, and **no legal-name, registration, tax, website, phone, address or logo column exists anywhere in the schema**. The real gap was **self-identification**: `list_vendor_users()` returns everyone's roles but marks no row as the caller, so "your role" meant downloading the directory and guessing by name. The new zero-argument read returns exactly `administrator_display_name` + `administrator_role_names text[]` (ACTIVE definitions only, same type/filter/order as the directory). **No status and no timestamp** — an authorized caller is ACTIVE in profile, membership and organization *by construction*, so such a field could only say `ACTIVE`; do not render three badges or one "Account status". Requires `RBAC_READ` and deliberately **not** `ORGANIZATION_MEMBERS_READ` (own rows are gated by ownership under RLS). Full audit: `docs/mobile-vendor-company-profile-reads-audit.md`. | **3** |

---

## 7. Web-only — not mobile features

| Surface | Reason |
| --- | --- |
| Admin and portal shells, sidebars, nav, loading skeletons | Presentation |
| `proxy.ts` + `lib/supabase/proxy-routing.ts` | Cookie refresh + optimistic redirects. Not a security boundary — every layout re-verifies. |
| `lib/auth/safe-next-path.ts` | Open-redirect guard for a browser `?next=` parameter |
| `/invitations/existing/enter`, `/invitations/staff/enter` | Raw-token → hash → `HttpOnly` cookie handoff |
| `revalidatePath` calls | Next.js cache invalidation |
| `lib/reference/iso-country-codes.ts` | Bundled copy of `public.iso_country_codes` for a pre-flight message |
| `lib/features/*` flag reads | Server-only env vars |

---

## 8. Backend work items, ordered

### New Postgres RPCs — read-only, no secret

**All 8 delivered**, plus four justified companion reads.

| # | RPC | Unblocks | Priority |
| --- | --- | --- | --- |
| 1 | ~~`get_my_portal_context()`~~ ✅ **shipped** — migration `20260729090000` | Role-based mobile navigation | ~~High — phase 1~~ **done** |
| 2 | ~~`get_vendor_admin_dashboard_summary()`~~ ✅ **shipped** — migration `20260805090000` | V-01 | ~~Low — phase 3~~ **done** |
| 3 | ~~`list_vendor_organization_members()`~~ → shipped as **`list_vendor_users()`** ✅ — migration `20260801090000` | V-02 | ~~Low — phase 3~~ **done** |
| 3a | `get_vendor_user_detail(p_membership_id)` ✅ **shipped** — migration `20260801090000` | A Vendor user detail screen — a companion, because **no web detail route exists** | **done** |
| 3b | ~~`list_vendor_rbac_catalog()`~~ → shipped as **`list_vendor_roles()`** ✅ — migration `20260802090000` | V-03 | ~~Optional, low~~ **done** |
| 3c | `get_vendor_role_detail(p_role_id)` ✅ **shipped** — migration `20260802090000` | A Vendor role detail screen — a companion, because **no web detail route exists** | **done** |
| 3d | `list_vendor_role_permissions(p_role_id)` ✅ **shipped** — migration `20260802090000` | V-03's per-role permission list — a companion rather than an unbounded nested payload | **done** |
| 4 | ~~`list_vendor_audit_logs(p_limit, p_before)`~~ ✅ **shipped** as `list_vendor_audit_logs(p_limit, p_before_occurred_at, p_before_audit_log_id)` — migration `20260804090000` | V-04 + keyset pagination. **No detail companion**, because the web exposes no audit detail to share (audit § 6). | ~~Low — phase 3~~ **done** |
| 5 | ~~`list_vendor_retailers()`~~ ✅ **shipped** — migration `20260731090000` | V-05, cross-linking | ~~Low — phase 3~~ **done** |
| 6 | ~~`get_vendor_retailer_detail(p_relationship_id)`~~ ✅ **shipped** — migration `20260731090000` | V-06 | ~~Low — phase 3~~ **done** |
| 6a | `list_vendor_retailer_shops(p_relationship_id)` ✅ **shipped** — migration `20260731090000` | V-06's shop list — a companion rather than an unbounded nested payload | **done** |
| 7 | `get_my_vendor_profile()` ✅ **shipped** — migration `20260806090000` | V-17 (Vendor company & administrator profile). **Only the personal half**: PortalContext already supplies the company name, so no company RPC was created and none was justified | **done** |

Item 7 detail: `docs/mobile-vendor-company-profile-reads-audit.md` — note that its audit conclusion
was **partly "no gap"**: the Vendor company name is served by item 1 (`get_my_portal_context()`)
and no second source for it was created.
Item 5/6 detail: `docs/mobile-vendor-retailer-reads-audit.md`. Item 3/3a detail:
`docs/mobile-vendor-user-reads-audit.md`. Item 3b/3c/3d detail:
`docs/mobile-vendor-role-reads-audit.md`. Item 4 detail:
`docs/mobile-vendor-audit-log-reads-audit.md`. Item 2 detail:
`docs/mobile-vendor-dashboard-summary-audit.md`. **All eight read RPCs are now delivered.**
Vendor user *writes* —
inviting, editing, activating, role assignment — are out of scope, and Vendor user
invitations have no backend at all (both invitation tables are Retailer-scoped). Role
*writes* — create, edit, delete, activate, duplicate, permission assignment, role assignment
— are likewise out of scope and have **no backend anywhere in the product**, not merely no
mobile contract.

### New Edge Functions (7)

| # | Function | Unblocks | Priority |
| --- | --- | --- | --- |
| 1 | `submit-receipt` | Sales Staff MVP | **Critical — phase 1** |
| 2 | `activate-staff-account` | Staff onboarding | **Critical — phase 1** |
| 3 | `staff-invitation-context` | Staff onboarding | **Critical — phase 1** |
| 4 | `get-receipt-image-url` | Receipt viewing (**pending Q1**) | High — phase 2 |
| 5 | ~~`send-staff-invitation`~~ ✅ **shipped as `send-retailer-staff-invitation`** | Owner staff management | ~~High — phase 2~~ done |
| 6 | `invite-retailer-owner` | Vendor onboarding | Low — phase 3 |
| 7 | `send-existing-user-owner-invitation` | Vendor onboarding | Low — phase 3 |

### Contract-stability fixes (no behaviour change)

| # | Change | Why |
| --- | --- | --- |
| 1 | Add `shop_id` to `list_retailer_owner_portal_shops()` | Mobile lists cannot navigate without it. *(The new `list_vendor_retailer_shops()` returns one; the Owner-portal function is unchanged.)* |
| 2 | Add `ELSE` to `list_retailer_staff_invitations().derived_state` | Closes a `NULL` in a documented enum |
| 3 | Replace message-substring error discrimination with distinct SQLSTATEs | Message text is not an API. **Still open, and now scoped to exactly one site**: `reserve_retailer_staff_invitation()` raises the role/shop conflict with `23514`, the same SQLSTATE as ordinary validation, so `send-retailer-staff-invitation` must compare one literal from migration `20260723210000` to tell `INVITATION_CONFLICT` from `INVALID_REQUEST`. It degrades safely to the generic code if the wording changes. Every other refusal is already separated by SQLSTATE (`42501`, `55000`, `23514`). |
| 4 | Freeze / version `get_vendor_retailer_owner_status` | Three breaking recreations already. **Still open** — `20260731090000` deliberately did not touch it, so there is no fourth |
| 5 | Return `boolean` instead of `void` from the four idempotent product writes | Clients cannot tell "changed" from "already so" |
| 6 | ~~Have `list_vendor_retailers()` return both `relationship_id` and `retailer_organization_id`~~ ✅ **done** — migration `20260731090000` | Two address spaces today |

---

## 9. Recommended phasing

| Phase | Scope | Backend prerequisites |
| --- | --- | --- |
| **1 — Sales Staff MVP** | Sign in, my shops, capture + submit receipt, my history, staff invitation acceptance & activation | ~~1 RPC (`get_my_portal_context`)~~ ✅ **done** + 3 Edge Functions (`submit-receipt`, `staff-invitation-context`, `activate-staff-account`) |
| **2 — Retailer management** | Owner/Manager portal, staff roster, invitations, assigned products, receipt image viewing, owner-invitation acceptance | 2 Edge Functions (`send-staff-invitation`, `get-receipt-image-url`) + contract fixes 1–2 + answers to Q1–Q3 |
| **3 — Vendor administration** *(optional)* | Dashboard summary, Users directory & detail, Roles catalogue & role detail, Retailer directory & detail, onboarding, shops, products, assignments, audit logs, owner invitations, company & administrator profile | ~~5 RPCs~~ **0 RPCs remaining** — the Retailer directory and detail reads are ✅ **shipped** in `20260731090000`, the Users list and detail reads in `20260801090000`, the Roles list, role detail and role-permission reads in `20260802090000`, the Product detail and assigned-Retailers reads in `20260803090000`, the paginated audit log read in `20260804090000`, the dashboard summary in `20260805090000`, and the company/administrator profile self-read in `20260806090000` — + 2 Edge Functions + contract fixes 4–5 + answer to Q4 |
