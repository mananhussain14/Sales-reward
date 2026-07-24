# Mobile Feature Matrix — SalesReward

Companion to [`mobile-backend-contract.md`](./mobile-backend-contract.md), which holds the
full per-operation detail. This is the at-a-glance planning view.

**Status:** audit only. Nothing in the database or application was changed.

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
| Invite a staff member | Shipped | 🔴 Blocked | 🟡 After backend work | `reserve_retailer_staff_invitation()` (step 1) | **Yes — `send-staff-invitation`** | Token generation, Resend key, and 3 `service_role` RPCs. `prepare_*` returns the recipient's email — never expose it. Feature-flag gated. | **2** |
| Re-send a staff invitation | Shipped | 🔴 Blocked | 🟡 After backend work | same | **Yes — same function** | `canResendInvitation` is a TypeScript-only predicate. Must move into the shared path or SQL. | **2** |
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
| Decide "register" vs "sign in" | Shipped | 🔴 Blocked | 🟡 After backend work | `get_retailer_staff_registration_context()` (`service_role`) | **Yes — `staff-invitation-context`** | The RPC returns the **invited email**. The function must return only `{ mode, expiresAt }`. | **1** |
| Activate an invited staff account | Shipped | 🔴 Blocked | 🟡 After backend work | — | **Yes — `activate-staff-account`** | **Highest-risk endpoint.** The email is derived server-side from the token hash. If it ever becomes a parameter, anyone can claim any invited address. | **1** |
| View invitation details before accepting | Shipped | 🟢 Ready | 🟢 Now | `get_retailer_staff_invitation_for_recipient()` | No | Requires a confirmed session whose email matches. Zero rows on any failure. | **1** |
| Accept a staff invitation | Shipped | 🟢 Ready | 🟢 Now | `accept_retailer_staff_invitation()` | No | Email equality + `email_confirmed_at` checked in SQL. | **1** |

---

## 6. Vendor Super Admin

Every row here is phase **3** and is conditional on **Q4** — whether Vendor administration
belongs on mobile at all.

| Feature | Web status | Backend readiness | Flutter readiness | Shared RPC | Edge Function needed | Security concern | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard summary counts | Shipped | 🟡 Partial | 🟡 After backend work | **New:** `get_vendor_admin_dashboard_summary()` | No | Four round trips today. | **3** |
| Organization members directory | Shipped | 🟡 Partial | 🟡 After backend work | **New:** `list_vendor_organization_members()` | No | Four-query join currently done in TypeScript. | **3** |
| Roles & permissions catalogue | Shipped | 🟢 Ready | 🟢 Now | RLS reads (`roles`, `permissions`, `role_permissions`) | No | Global catalogue gated on `RBAC_READ`. | **3** |
| Audit log feed | Shipped | 🟡 Partial | 🟡 After backend work | **New:** `list_vendor_audit_logs(p_limit, p_before)` | No | Fixed 100 rows, no pagination. Null-organization rows are correctly excluded by RLS — keep it that way. | **3** |
| Retailers directory | Shipped | 🟡 Partial | 🟡 After backend work | **New:** `list_vendor_retailers()` | No | Currently fetches every shop row just to count them. | **3** |
| Retailer detail + owner status | Shipped | 🟡 Partial | 🟡 After backend work | `get_vendor_retailer_owner_status()` + **new** `get_vendor_retailer_detail()` | No | The owner-status function has been **dropped and recreated three times** with a growing column list. Not yet a stable pinned-client contract. | **3** |
| Onboard a Retailer | Shipped | 🟢 Ready | 🟢 Now | `onboard_vendor_retailer()` | No | **No idempotency** — a double submit creates two Retailers. Mobile must disable the button on submit. | **3** |
| Add a shop | Shipped | 🟢 Ready | 🟢 Now | `add_vendor_retailer_shop()` | No | Duplicate shop code → `23505`; duplicate name is allowed. | **3** |
| Invite a Retailer Owner (new account) | Shipped | 🔴 Blocked | 🟡 After backend work | `reserve_retailer_owner_invitation()` (step 1) | **Yes — `invite-retailer-owner`** | Auth Admin API + `service_role` finalization. The resend-vs-new decision is TypeScript-only today. | **3** |
| Invite a Retailer Owner (existing account) | Shipped | 🔴 Blocked | 🟡 After backend work | same | **Yes — `send-existing-user-owner-invitation`** | Token + Resend + 3 `service_role` RPCs. | **3** |
| Revoke an owner invitation | **Built but unwired** | 🟢 Ready | 🔴 Blocked on decision | `revoke_retailer_owner_invitation()` | No | Granted, audited, and called by nothing anywhere in the codebase. **Q8.** | **3** |
| Product catalogue list | Shipped | 🟢 Ready | 🟢 Now | `list_vendor_products()` | No | None. | **3** |
| Create / update a product | Shipped | 🟢 Ready | 🟢 Now | `create_vendor_product()`, `update_vendor_product()` | No | Duplicate code vs barcode is discriminated by **English message substring**. Reword the message and both clients break. | **3** |
| Activate / deactivate a product | Shipped | 🟢 Ready | 🟢 Now | `set_vendor_product_status()` | No | Returns `void`; silent no-op when unchanged. | **3** |
| List a product's Retailer assignments | Shipped | 🟢 Ready | 🟢 Now | `list_vendor_product_retailer_assignments()` | No | Returns `retailer_organization_id`, while Retailer screens are addressed by `vendor_retailers.id`. Two address spaces. | **3** |
| Assign / withdraw a product | Shipped | 🟢 Ready | 🟢 Now | `assign_vendor_product_to_retailer()`, `unassign_…()` | No | `void` return hides "changed" vs "already so". | **3** |

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

**1 of 6 delivered.**

| # | RPC | Unblocks | Priority |
| --- | --- | --- | --- |
| 1 | ~~`get_my_portal_context()`~~ ✅ **shipped** — migration `20260729090000` | Role-based mobile navigation | ~~High — phase 1~~ **done** |
| 2 | `get_vendor_admin_dashboard_summary()` | V-01 | Low — phase 3 |
| 3 | `list_vendor_organization_members()` | V-02 | Low — phase 3 |
| 4 | `list_vendor_audit_logs(p_limit, p_before)` | V-04 + pagination | Low — phase 3 |
| 5 | `list_vendor_retailers()` | V-05, cross-linking | Low — phase 3 |
| 6 | `get_vendor_retailer_detail(p_relationship_id)` | V-06 | Low — phase 3 |

### New Edge Functions (7)

| # | Function | Unblocks | Priority |
| --- | --- | --- | --- |
| 1 | `submit-receipt` | Sales Staff MVP | **Critical — phase 1** |
| 2 | `activate-staff-account` | Staff onboarding | **Critical — phase 1** |
| 3 | `staff-invitation-context` | Staff onboarding | **Critical — phase 1** |
| 4 | `get-receipt-image-url` | Receipt viewing (**pending Q1**) | High — phase 2 |
| 5 | `send-staff-invitation` | Owner staff management | High — phase 2 |
| 6 | `invite-retailer-owner` | Vendor onboarding | Low — phase 3 |
| 7 | `send-existing-user-owner-invitation` | Vendor onboarding | Low — phase 3 |

### Contract-stability fixes (no behaviour change)

| # | Change | Why |
| --- | --- | --- |
| 1 | Add `shop_id` to `list_retailer_owner_portal_shops()` | Mobile lists cannot navigate without it |
| 2 | Add `ELSE` to `list_retailer_staff_invitations().derived_state` | Closes a `NULL` in a documented enum |
| 3 | Replace message-substring error discrimination with distinct SQLSTATEs | Message text is not an API |
| 4 | Freeze / version `get_vendor_retailer_owner_status` | Three breaking recreations already |
| 5 | Return `boolean` instead of `void` from the four idempotent product writes | Clients cannot tell "changed" from "already so" |
| 6 | Have `list_vendor_retailers()` return both `relationship_id` and `retailer_organization_id` | Two address spaces today |

---

## 9. Recommended phasing

| Phase | Scope | Backend prerequisites |
| --- | --- | --- |
| **1 — Sales Staff MVP** | Sign in, my shops, capture + submit receipt, my history, staff invitation acceptance & activation | ~~1 RPC (`get_my_portal_context`)~~ ✅ **done** + 3 Edge Functions (`submit-receipt`, `staff-invitation-context`, `activate-staff-account`) |
| **2 — Retailer management** | Owner/Manager portal, staff roster, invitations, assigned products, receipt image viewing, owner-invitation acceptance | 2 Edge Functions (`send-staff-invitation`, `get-receipt-image-url`) + contract fixes 1–2 + answers to Q1–Q3 |
| **3 — Vendor administration** *(optional)* | Retailer directory & detail, onboarding, shops, products, assignments, audit logs, owner invitations | 5 RPCs + 2 Edge Functions + contract fixes 4–6 + answer to Q4 |
