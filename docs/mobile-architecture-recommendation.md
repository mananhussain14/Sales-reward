# Mobile Architecture Recommendation — SalesReward

Companion to [`mobile-backend-contract.md`](./mobile-backend-contract.md) (per-operation
detail) and [`mobile-feature-matrix.md`](./mobile-feature-matrix.md) (planning view).

**Status:** recommendation only, with several items since delivered. No Flutter project was
created and no package installed. The backend changes made since this document was written
are:

- `20260729090000_shared_portal_context.sql` — implements the `get_my_portal_context()`
  recommendation in § 4.1 below.
- `20260730090000_sales_staff_receipt_product_and_submission_reads.sql` — the two Sales
  Staff receipt reads (`docs/mobile-receipt-submission-audit.md`).
- `20260731090000_mobile_vendor_retailer_reads.sql` — the Vendor Retailer list and detail
  reads for **V-05 / V-06** (`docs/mobile-vendor-retailer-reads-audit.md`).

**No RLS policy, table grant, or existing RPC was modified by any of them**, and no web page
changed behaviour. Each is purely additive.

---

## 1. One backend, two clients

### 1.1 The principle

Supabase is the **only** authority on identity, tenancy, and authorization. Neither client
decides anything security-relevant. Both clients are renderers.

This is not aspirational — it is already how the web app works, and the audit found no
exception. Every `SECURITY DEFINER` function derives its tenant from `auth.uid()` through one
of four resolvers, and not one of them accepts a user id. `authenticated` holds `SELECT` and
nothing else on ten tables, and no privilege at all on the other eight. There is not a single
`INSERT`/`UPDATE`/`DELETE` RLS policy in the schema.

The mobile app inherits all of that for free — **provided it does not route around it.**

### 1.2 The layering

```
┌───────────────────────┐     ┌───────────────────────┐
│  Next.js web client   │     │   Flutter mobile app   │
│  (publishable key)    │     │  (publishable key)     │
└───────────┬───────────┘     └───────────┬───────────┘
            │                             │
            │   authenticated RPCs + RLS reads (identical)
            ├─────────────────────────────┤
            │                             │
            │   Edge Functions (JWT-verified, hold every secret)
            ├─────────────────────────────┤
            │                             │
            ▼                             ▼
┌─────────────────────────────────────────────────────┐
│  Postgres: RLS, SECURITY DEFINER RPCs, constraints, │
│  triggers, audit_logs   ← the authorization authority│
│  Storage: private `receipts` bucket, zero policies   │
│  Auth (GoTrue)                                       │
└─────────────────────────────────────────────────────┘
```

Three tiers, in strict order of preference:

1. **Authenticated Postgres RPC.** Preferred for everything that needs no secret. 26 of ~43
   operations already qualify.
2. **RLS-protected table read.** Acceptable for simple reads; avoid where it forces the
   client to reassemble a multi-query join (see § 1.4).
3. **Edge Function.** *Only* where a service-role key, a third-party secret, or a Storage
   write is unavoidable. 7 operations.

### 1.3 The rule that keeps the two clients honest

> **The mobile app must never call an operation the web app does not also call, and must never
> reach a secret the web app keeps server-side.**

The concrete consequence: for each of the 7 Edge Functions, the existing Next.js Server
Action should be **reduced to a call into that function**, not left as a parallel
implementation. Otherwise the first rule change is implemented once and forgotten once.

The most important instance is `submitReceiptAction`. It performs **magic-byte MIME sniffing**
(`FF D8 FF`, the 8-byte PNG signature, `RIFF`+`WEBP`), computes the SHA-256 over the exact
bytes, sanitizes the filename, and deletes the orphaned Storage object when finalization
fails. If Flutter reimplements that in Dart, the two clients will disagree about what a valid
receipt is — and OCR will consume whatever the weaker one accepted.

### 1.4 Where "shared" quietly fails today

Five web features assemble their result from multiple direct table reads joined in
TypeScript: the dashboard counts, the members directory, the audit feed, the retailers
directory, and the retailer detail page. All five are RLS-protected and therefore *technically*
reachable from Dart. All five would mean two hand-written joins that must agree forever.

These are business shape, not presentation. **Move them into RPCs** (six are proposed in the
matrix, § 8). That is the difference between "the backend is shared" and "the queries happen
to be similar".

---

## 2. Which repository owns migrations

**Recommendation: this repository — `salesreward-admin` — remains the sole owner of
`supabase/migrations/`, `supabase/config.toml`, and (once created) `supabase/functions/`. The
Flutter repository owns no schema and applies no migration.**

Rationale:

- **The history is already here, and it is disciplined.** 31 migrations, each with a
  header explaining its scope, its dependencies, and what it deliberately does not do. Every
  seed is idempotent; several carry explicit precondition guards that `raise` rather than
  silently no-op. Splitting that across two repositories would fork a story that currently
  reads in one order.
- **Applied migrations must not be modified.** With one owner that rule is enforceable by
  review. With two, "who applied what" becomes a merge question.
- **Edge Functions belong next to the RPCs they call.** `submit-receipt` and
  `reserve_receipt_submission` are two halves of one protocol; they should not live in
  different repositories with different release cadences.

**Concretely:**

| Artifact | Owner |
| --- | --- |
| `supabase/migrations/**` | `salesreward-admin` |
| `supabase/functions/**` (new) | `salesreward-admin` |
| `supabase/config.toml` (incl. `additional_redirect_urls` for mobile deep links) | `salesreward-admin` |
| Dart models / generated types | Flutter repo, generated from a schema snapshot published by this repo |
| Contract documents (these three files) | `salesreward-admin` |

**A backend change that alters a shared RPC signature or an Edge Function response is a
breaking change for a pinned mobile build.** Adopt an additive-only policy for shared
contracts — § 6.1 of the contract document shows `get_vendor_retailer_owner_status` has
already been dropped and recreated three times with a growing column list. That was safe when
the only client shipped with the server. It stops being safe the day an app store is involved.

---

## 3. Supabase Auth in Flutter

### 3.1 Client construction

Initialize `supabase_flutter` with **only** `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — the same two values the web bundle embeds, and the
only two that may ever appear in a mobile binary. Assume anything in the binary is public: an
APK is trivially unpacked.

**Never** place `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, or future OCR
credentials in the Flutter app, its `--dart-define` flags, its `.env`, or its CI variables.
`lib/supabase/admin.ts` documents at length why the service key is equivalent to full database
access; that reasoning is unchanged on mobile.

### 3.2 Session storage

Use `flutter_secure_storage` (Keychain / EncryptedSharedPreferences) as the session store, not
the default `SharedPreferences`. The web app's tokens live in `HttpOnly` cookies that JavaScript
cannot read; plain `SharedPreferences` is world-readable on a rooted device and would be a
material downgrade.

### 3.3 Verify, never trust

The web client uses `supabase.auth.getClaims()` — which cryptographically verifies the JWT —
and **never** `getSession()`, which returns unverified cookie contents. Mirror that:
`getSession()` in Dart is fine for *is a session present*, but every authorization answer must
come from an RPC. Do not decode the JWT locally to discover a role.

### 3.4 Server is the authority; UI is a hint

Flutter may hide a button because `get_my_portal_context()` said the caller is a `submitter`.
It must still be true that pressing it would fail with `42501`. That is already the case —
`reserve_retailer_staff_invitation` re-derives everything — and no mobile shortcut should
weaken it.

### 3.5 Email confirmation must stay on

`.env.example` states this explicitly, and the audit confirms the reason: acceptance requires
`auth.users.email_confirmed_at IS NOT NULL` **and** an exact email match to the invitation. If
auto-confirm were enabled, anyone could register an invited address and claim the invitation.
Adding a mobile client does not change this; it adds a second surface that depends on it.

---

## 4. Role-based mobile navigation

### 4.1 Resolve the role once, from the server

Today the web app answers "which experience?" by probing up to three RPCs and reading whether
each threw `42501` (`lib/staff/retailer-staff-access.ts` + `portal-access-decision.ts`).
Authorization decided by error handling is workable in one client and fragile in two.

✅ **DELIVERED** as migration `20260729090000_shared_portal_context.sql`. The shipped
contract is richer than the sketch this section originally proposed, in two ways that
matter:

- it returns a single **`jsonb`** value rather than a typed row, so a new field is an
  additive change instead of the `DROP FUNCTION` + recreate that has already bitten
  `get_vendor_retailer_owner_status` three times;
- it resolves the **`vendor` and `retailer` blocks independently** rather than collapsing to
  one `kind`, so a caller holding both roles routes Vendor-first *and* still receives their
  Retailer context — which the single-`kind` sketch could not express.

It also carries seven **resolver-derived** capability hints. Full contract:
`mobile-backend-contract.md` **AUTH-05**.

One round trip, one definition of precedence, and it simultaneously fixes **Q3** — a Retailer
Manager could not read their own Retailer's name, because
`get_retailer_owner_portal_context()` hard-filters `RETAILER_OWNER`. `retailer.organization_name`
is now returned for all three retailer kinds.

### 4.2 Navigation shells

| `kind` | Mobile shell | Corresponds to |
| --- | --- | --- |
| `submitter` | Bottom nav: **Submit** · **History** · **Profile** | `/retailer/receipts` |
| `reader` | Bottom nav: **Staff** · **Products** · **Profile** | `/retailer/staff` |
| `owner` | Bottom nav: **Overview** · **Shops** · **Staff** · **Products** · **Profile** | `/retailer` |
| `vendor` | Phase 3 only, if in scope at all (**Q4**) | `/` |
| `none` | Access-denied screen with sign-out | `/access-denied` |

Preserve the web app's **vendor-first precedence** (`lib/auth/landing-decision.ts`): a user
holding both a Vendor and a Retailer role lands on the Vendor experience, with the retailer
one reachable directly. Two different precedence orders across clients would be a support
nightmare.

### 4.3 Re-resolve on resume

Roles change server-side — a membership is suspended, a role is revoked. Re-resolve
`get_my_portal_context()` on app resume and on any `42501`, and rebuild the shell if `kind`
changed. Never cache the role durably; the web client's `React.cache` is explicitly
request-scoped for exactly this reason, and its own docblock warns against making it
persistent.

---

## 5. Mobile invitation deep linking

### 5.1 What exists

Two token flows, both application-owned, plus one GoTrue flow:

| Flow | Email link today | Mechanism |
| --- | --- | --- |
| Owner, new account | `${APP_ORIGIN}/invitations/accept?token_hash=…&type=invite` | GoTrue `verifyOtp` |
| Owner, existing account | `${APP_ORIGIN}/invitations/existing/enter?token=…` | App token → SHA-256 → `HttpOnly` cookie |
| Staff | `${APP_ORIGIN}/invitations/staff/enter?token=…` | Same |

The `/enter` routes hash the raw token server-side, set an `HttpOnly` cookie, redirect to a
clean path, and set `Referrer-Policy: no-referrer`. **The raw token never reaches a rendered
page or an RSC payload** — that property must survive the move to mobile.

### 5.2 Recommendation: universal links / app links on `APP_ORIGIN`

**Do not add a second link to the emails, and do not use a custom `salesreward://` scheme as
the primary mechanism.** Custom schemes can be claimed by any installed app and offer no
verification.

Register `APP_ORIGIN` for iOS Universal Links (`apple-app-site-association`) and Android App
Links (`assetlinks.json`), scoped to `/invitations/*`. Then:

- **App installed** → the OS routes the link straight into Flutter, which parses `token`.
- **App not installed** → the existing web page handles it exactly as it does today. No
  regression, no email change, no second link to confuse recipients.

Add the deep-link callback URLs to `supabase/config.toml → auth.additional_redirect_urls`
alongside the existing web entries.

### 5.3 Token handling in Dart

1. Extract `token` from the link. Validate the shape (`^[A-Za-z0-9_-]{43,}$`) as
   `isValidRawToken` does.
2. Compute `sha256(utf8)` → lowercase hex. Match `^[0-9a-f]{64}$`.
3. **Discard the raw token immediately.** Hold only the hash, in `flutter_secure_storage`,
   with a short TTL mirroring the web cookie's `maxAge`.
4. Never log the token or the hash. Never place either in an analytics event, a crash report,
   or a navigation breadcrumb.
5. Call the hash-taking RPCs — `get_retailer_staff_invitation_for_recipient(p_token_hash)` or
   `get_pending_existing_user_retailer_invitation(p_token_hash)`.

This is safe because the hash alone is insufficient: both acceptance RPCs additionally require
a confirmed session whose email exactly equals the invitation's.

### 5.4 The one branch Flutter cannot take itself

Deciding "register" vs "sign in" needs
`public.get_retailer_staff_registration_context(p_token_hash)`, which is `service_role`-only
because it reveals the invited email address to a caller who may have no session at all.

Route it through the `staff-invitation-context` Edge Function, and have that function return
**only** `{ mode: "register" | "sign-in", expiresAt }`. **Do not return `invited_email`** —
the web app deliberately keeps it server-side, and echoing it to a mobile client would turn a
token hash into an email-disclosure oracle.

Likewise `activate-staff-account` takes `{ tokenHash, password }` and **never an email**. The
address is derived from the invitation. This is the single most security-sensitive endpoint in
the port: if the email ever becomes a parameter, any holder of a token can claim any address.

### 5.5 GoTrue invite links (owner, new account)

`inviteUserByEmail` is called with `redirectTo: ${APP_ORIGIN}/invitations/accept`. With
universal links registered, the same URL opens the app; Flutter calls
`supabase.auth.verifyOtp(type: OtpType.invite, tokenHash: …)`, then `updateUser(password:)`,
then the zero-argument `accept_retailer_owner_invitation()`. All three are client-callable.
No backend change.

---

## 6. Receipt camera and upload design

### 6.1 What must not change

- The `receipts` bucket is **private** (`public = false`, 10 MiB, `image/jpeg|png|webp`).
- `storage.objects` and `storage.buckets` have RLS with **zero policies**. Only the
  service-role key can read or write.
- The object path is **generated by the database**:
  `<retailer_org>/<user>/<submission>/<random>.<ext>`. The client never chooses it.
- The duplicate guard is a unique index on
  `(retailer_organization_id, submitted_by_profile_id, file_sha256) WHERE status <> 'UPLOAD_FAILED'`.
- MIME type is determined by **magic bytes**, never by a declared `Content-Type`.

### 6.2 Recommended flow

```
Flutter                          Edge Function `submit-receipt`         Postgres / Storage
───────                          ─────────────────────────────         ──────────────────
capture / pick
downscale ≤ 10 MiB
   │
   ├── POST multipart (JWT) ───────────►
   │                                 auth.getUser()  ← verify caller
   │                                 sniff magic bytes → MIME
   │                                 sha256(bytes)
   │                                 sanitize filename
   │                                     │
   │                                     ├── reserve_receipt_submission() ──► RESERVED row
   │                                     │      (as the caller, not service role)
   │                                     │◄── (submission_id, bucket, path)
   │                                     │
   │                                     ├── storage.upload(path, bytes) ──► object
   │                                     │      (service role)
   │                                     │
   │                                     ├── finalize_receipt_submission_upload() ──► SUBMITTED
   │                                     │
   │                                     └── on any failure:
   │                                            storage.remove([path])
   │                                            record_receipt_submission_upload_failure()
   │◄── { status: submitted | duplicate | denied | invalid | upload-failed }
```

Two details that are easy to get wrong:

- **Reserve as the caller, not as service role.** The Edge Function should create a
  publishable-key client bound to the caller's JWT for `reserve_receipt_submission`, so
  `auth.uid()` inside the RPC is the real user and the assigned-shop check actually applies.
  Only the Storage write and the two `service_role` RPCs use the secret key.
- **Hash the exact bytes uploaded.** If Flutter downscales, hash *after* downscaling. Hashing
  the original and uploading the resized file silently defeats the duplicate guard.

### 6.3 Client-side pre-checks (UX only, never authority)

Enforce ≤ 10 MiB and JPEG/PNG/WebP in Dart for a fast error, exactly as the web form does.
The Edge Function re-sniffs; `reserve_receipt_submission` re-validates; the table constraints
re-validate; Storage re-validates. Four agreeing checks, none of them the browser's word.

### 6.4 Viewing a submitted receipt

**There is no read path in the codebase at all** — no signed URL, no Storage policy, no RPC.
Mobile users will expect to tap a history row and see the photo (**Q1**).

If approved, add an Edge Function `get-receipt-image-url` that verifies
`submitted_by_profile_id = auth.uid()` before minting a short-lived signed URL (≤ 60 s), and
never caches the URL on device. **Do not** solve this by adding a `SELECT` policy to
`storage.objects` — that would be the first Storage policy in the project and would replace a
verified, auditable check with a standing grant.

### 6.5 Offline capture (Q5)

Technically safe — the duplicate guard is server-side and hash-based, so replaying a queued
submission is idempotent. But queued bytes are customer receipt images sitting in app storage;
they must be encrypted at rest and purged on sign-out. Treat as phase 2 and confirm scope.

---

## 7. Secure account switching

### 7.1 The blocker

Both retailer resolvers end with:

```sql
select q.id from qualifying q where (select count(*) from qualifying) = 1
```

A user who legitimately qualifies at **two** Retailers gets `NULL` — total, silent denial,
indistinguishable from having no access. Account switching cannot be designed around this;
it has to be decided first (**Q2**).

### 7.2 The three options, and a recommendation

| Option | Description | Assessment |
| --- | --- | --- |
| **(a) Forbid** | One person, one Retailer. Enforce it with a constraint and a clear error. | Simplest and safest. Matches today's behaviour. **Recommended for phase 1.** |
| **(b) Server-side active selection** | New `list_my_retailer_memberships()` + `set_my_active_retailer(p_retailer_organization_id)` writing a per-user active-context row; resolvers prefer it and fall back to the single-membership rule. | The right answer if multi-membership is a real requirement. Preserves the invariant that the *database* decides the tenant. **Recommended for phase 2+.** |
| **(c) Pass a retailer id per call** | Every RPC takes `p_retailer_organization_id` and verifies it. | **Not recommended.** It makes tenant a client-supplied parameter on every call — the exact pattern this schema has refused throughout. Even verified, it turns 30 call sites into 30 places to get the check right. |

### 7.3 Switching accounts (different person) on a shared device

Distinct from tenant switching, and it matters for shop-floor devices where staff share a
phone.

- Sign out with `scope: 'local'`, as both web actions do.
- **Purge on sign-out:** the secure-storage session, any cached portal context, any queued
  offline receipts, and any cached signed URLs. A queued receipt belonging to the previous
  user must never be submitted under the next user's session — the reservation would be
  attributed to the wrong `submitted_by_profile_id`.
- Do not offer a "remember multiple accounts" feature in phase 1. Multiple stored sessions on
  a shared shop-floor device is a meaningful risk with no current product requirement.

---

## 8. Error contract strategy

### 8.1 What the backend already gives you

The RPCs raise deliberate SQLSTATEs, and the web client maps them consistently:

| SQLSTATE | Meaning | Web treatment |
| --- | --- | --- |
| `42501` `insufficient_privilege` | Not authorized — **and also** unknown id, foreign id, wrong state | Generic denial. Never distinguished. |
| `23505` `unique_violation` | Duplicate (owner exists, shop code, product code/barcode, receipt hash) | Field-level message |
| `23514` `check_violation` | Input shape / business rule | Field-level message |
| `55000` `object_not_in_prerequisite_state` | Inactive relationship, retailer, or product | Actionable message |

`42501` is deliberately overloaded. `add_vendor_retailer_shop`,
`reserve_retailer_owner_invitation`, `revoke_*` and `accept_*` all emit byte-identical
messages for "you are not authorized", "that id does not exist", and "that id belongs to
someone else" — so none of them is an existence oracle. **Flutter must preserve that.** Do not
add a mobile error screen that says "invitation not found" where web says "not authorized".

### 8.2 The gap

Two places discriminate errors by **English message substring**:

- `reserve_retailer_staff_invitation` → `"Revoke and re-issue this invitation to change its
  role or shops"`, string-matched in `lib/staff/retailer-staff-invitations.ts`.
- `create_vendor_product` / `update_vendor_product` → duplicate **code** vs **barcode**,
  substring-matched in `lib/products/vendor-products.ts`.

One client can live with that. Two cannot: rewording a message silently breaks whichever
client was not updated. **Recommend distinct SQLSTATEs** (e.g. `55000` for the invitation
conflict) or a machine code carried in `USING detail = 'STAFF_INVITE_ROLE_CONFLICT'`.

### 8.3 The recommended shared contract

**One Dart sealed class, mirroring the web's discriminated unions.** The web already models
every operation as `{ status: "ok" | "denied" | "duplicate" | "invalid" | "unavailable" | … }`.
Mirror it exactly:

```dart
sealed class OpResult<T> {}
class Ok<T>          extends OpResult<T> { final T value; }
class Denied<T>      extends OpResult<T> {}                    // 42501
class Duplicate<T>   extends OpResult<T> { final String? code; } // 23505
class Invalid<T>     extends OpResult<T> { final String? field; } // 23514
class NotReady<T>    extends OpResult<T> {}                    // 55000
class Unavailable<T> extends OpResult<T> {}                    // transport / unknown
```

Rules, all of which the web layer already follows:

- **Never surface a raw Postgres message.** They can name tables, columns, functions and
  policies. Every web module logs a category (`"[receipts-submit] reserve rpc-error"`) and
  returns a discriminant.
- **Transport failure is `Unavailable`, never `Denied`.** The web app is careful never to turn
  an outage into an authorization denial, and vice versa. `lib/auth/authenticated-landing.ts`
  exists partly to preserve that distinction.
- **Fail closed.** Every `catch` in the web layer returns a non-authorized result. Do the same
  in Dart, and never let a null-safety fallback become an "allow".
- **Never log tokens, hashes, emails, session objects, or error objects.** The web client
  deliberately does not bind caught auth exceptions, because they can carry token material.

### 8.4 Edge Function responses

Each Edge Function should return the same discriminated status its Server Action returns
today — `sent` / `resent` / `delivery-failed` / `misconfigured` / `conflict` / `rejected` /
`unavailable` for invitations; `submitted` / `duplicate` / `denied` / `invalid` /
`upload-failed` for receipts. Use HTTP 200 with a status body rather than HTTP error codes,
so a `409` from an intermediary is never confused with a business conflict.

---

## 9. Shared backend testing

### 9.1 What exists

31 test files, ~570 tests, run by `node --experimental-strip-types --test "lib/**/*.test.ts"`.
The style is deliberate and worth preserving: **pure decision logic is extracted into modules
with no I/O**, then tested directly.

| Pure module | Tests | What it locks down |
| --- | --- | --- |
| `lib/auth/landing-decision.ts` | 19 | Vendor-first precedence |
| `lib/staff/portal-access-decision.ts` | 23 | owner/reader/submitter selection |
| `lib/staff/staff-invite-flow.ts` | 18 | reserve → prepare → send → record ordering |
| `lib/receipts/receipt-submission-flow.ts` | 14 | reserve → upload → finalize, incl. orphan cleanup |
| `lib/receipts/receipt-file.ts` | — | magic-byte sniffing, hashing, filename sanitization |
| `lib/*/\*-normalization.ts` | 160+ | Defensive validation of untyped `rpc()` payloads |
| `lib/*/\*-source-safety.test.ts` | 57 | **Source-level assertions that modules contain no `.from(` and no service-role import** |

That last category is unusual and genuinely valuable: `product-source-safety.test.ts`,
`receipt-source-safety.test.ts` and `staff-source-safety.test.ts` assert *architectural*
properties by reading the source. They are the cheapest possible guard against the boundary
eroding.

### 9.2 Recommended additions

**Tier 1 — pure logic, both languages.** Extract any new shared decision (e.g. the portal-kind
selection, once `get_my_portal_context()` exists) into a pure module on both sides and test it
against the **same table of cases**. Keep the case table in one place — a JSON fixture in this
repository, consumed by both suites — so a divergence is a failing test, not a support ticket.

**Tier 2 — database contract tests (the real gap).** There is currently **no test that
executes SQL**. Every authorization guarantee in this audit is asserted by reading migration
files. With two clients that is no longer enough. Add a pgTAP or `supabase test db` suite
covering, per RPC:

- an unauthenticated caller gets zero rows or `42501`;
- a wrong-tenant id gets the **same** answer as a non-existent id (no existence oracle);
- a suspended profile / membership / organization authorizes nothing;
- the idempotency guarantee holds under a repeat call;
- the audit row is written in the same transaction.

This suite is the single highest-value backend investment before mobile ships, because it
tests the contract *both* clients depend on rather than one client's use of it.

**Tier 3 — Edge Function tests.** For each of the 7 functions: JWT missing → 401; JWT valid
but unauthorized → the same discriminant the RPC would produce; secret absent → `misconfigured`
(never a stack trace); happy path; and each failure branch, especially receipt orphan cleanup.

**Tier 4 — extend source-safety to Dart.** The Flutter repo should carry an equivalent test
asserting no Dart file references a service-role key, a Resend key, or `storage.from(...).upload`.

### 9.3 Regression guard for the contract itself

Add a test that reads `docs/mobile-backend-contract.md` and asserts every RPC name it mentions
still exists in `supabase/migrations/`. Cheap, and it catches the documentation going stale
the moment a function is renamed — which, given § 6.1, is a real risk in this schema.

---

## 10. Suggested Flutter repository structure

A separate repository (`salesreward-mobile`), feature-first, with a hard boundary between
"data access" and "everything else".

```
salesreward_mobile/
├── lib/
│   ├── main.dart
│   ├── app/
│   │   ├── app.dart                  # root widget, theme
│   │   ├── router.dart               # role-gated routes
│   │   └── bootstrap.dart            # Supabase.initialize + secure storage
│   │
│   ├── core/
│   │   ├── supabase/
│   │   │   ├── client.dart           # THE ONLY SupabaseClient. Publishable key only.
│   │   │   └── rpc.dart              # typed rpc<T>() wrapper → OpResult<T>
│   │   ├── errors/
│   │   │   ├── op_result.dart        # the sealed class from § 8.3
│   │   │   └── sqlstate.dart         # 42501 / 23505 / 23514 / 55000
│   │   ├── storage/
│   │   │   └── secure_store.dart     # flutter_secure_storage wrapper
│   │   ├── logging/
│   │   │   └── safe_log.dart         # category-only; scrubs tokens/emails/hashes
│   │   └── result_guard.dart         # fail-closed helpers
│   │
│   ├── auth/
│   │   ├── data/auth_repository.dart
│   │   ├── domain/portal_context.dart      # kind + retailer id + name
│   │   ├── domain/landing_decision.dart    # PURE — mirrors lib/auth/landing-decision.ts
│   │   └── ui/{login_screen,access_denied_screen}.dart
│   │
│   ├── features/
│   │   ├── receipts/
│   │   │   ├── data/receipt_repository.dart      # submit-receipt Edge Function
│   │   │   ├── domain/receipt_file.dart          # PURE — magic bytes, sha256, filename
│   │   │   ├── domain/submission.dart
│   │   │   └── ui/{capture_screen,history_screen}.dart
│   │   ├── shops/
│   │   ├── staff/
│   │   │   ├── data/staff_repository.dart
│   │   │   ├── domain/invitation_state.dart      # PURE — mirrors staff-normalization.ts
│   │   │   └── ui/{roster_screen,invite_screen}.dart
│   │   ├── products/
│   │   ├── invitations/
│   │   │   ├── data/invitation_repository.dart
│   │   │   ├── domain/token.dart                 # PURE — sha256, shape validation
│   │   │   └── ui/{accept_screen,activate_screen}.dart
│   │   └── vendor/                               # phase 3 only
│   │
│   └── shared/
│       ├── widgets/                  # design system, mirrors components/ui
│       └── formatting/
│
├── test/
│   ├── domain/                       # pure-logic tests, mirroring lib/**/*.test.ts
│   ├── contract/                     # fixture-driven, shares JSON cases with web
│   └── security/
│       └── no_secrets_test.dart      # source-safety: no service key, no Resend, no direct upload
│
├── integration_test/
└── android/ ios/                     # assetlinks.json / apple-app-site-association
```

### Structural rules

1. **One `SupabaseClient`, in `core/supabase/client.dart`.** Nothing else constructs one.
   Mirrors this repo's discipline of a single admin client behind a documented guard.
2. **Repositories are the only layer that talks to Supabase.** UI never calls `.rpc()`. The
   source-safety test enforces it.
3. **`domain/` is pure.** No Supabase import, no I/O, no `dart:io`. That is what makes it
   testable and what makes it comparable to `lib/**/*.ts` in this repo.
4. **Every repository method returns `OpResult<T>`.** No exceptions cross the repository
   boundary; nothing throws into the widget tree.
5. **Every RPC response is validated before use.** Mirror the `*-normalization.ts` modules —
   `rpc()` is untyped on both sides, and a malformed payload must become `Unavailable`, never
   a null-dereference or a silent empty list.
6. **No role or permission string is a source of truth in Dart.** Role codes may appear in
   `switch` statements for *display*; they must never gate a write. The write is gated in SQL.
7. **Mirror the source-safety tests.** They are the cheapest defence against the boundary
   eroding under deadline pressure.

---

## 11. Recommended first milestone

**Sales Staff receipt submission, end to end.** It is the smallest slice that is genuinely
mobile-native (camera), it exercises the full authorization chain
(auth → portal context → assigned shops → reserve → upload → finalize), and it touches the
Vendor administration surface not at all.

| Deliverable | Detail |
| --- | --- |
| **Backend — 1 new RPC** | ~~`get_my_portal_context()`~~ ✅ **shipped** (`20260729090000`) |
| **Backend — 3 Edge Functions** | `submit-receipt`, `staff-invitation-context`, `activate-staff-account` |
| **Backend — refactor** | Point the corresponding Server Actions at the new Edge Functions so there is one implementation, not two |
| **Backend — tests** | pgTAP/`supabase test db` for the receipt and staff-acceptance RPCs (Tier 2, § 9.2) |
| **Mobile** | Sign in · assigned shops · capture + submit · history · staff invitation acceptance and activation via deep link |
| **Explicitly excluded** | Vendor administration, product management, staff invitation *sending*, receipt image viewing, offline queue, account switching |

**Prerequisite decisions:** Q6 (deep-link domain) must be answered before starting.
Q1 (receipt viewing), Q2 (multi-Retailer) and Q3 (Manager tenant name) can be deferred to
phase 2 without blocking this milestone.

**Why not start with the Retailer Owner portal?** It is almost entirely read-only against
RPCs that already work — which makes it easy, but it would not prove the hard parts
(Storage-through-an-Edge-Function, deep-link token handling, magic-byte parity). Proving
those first de-risks everything after.
