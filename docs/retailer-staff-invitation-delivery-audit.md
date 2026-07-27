# Shared Retailer Staff Invitation Delivery — Audit

**Milestone:** a shared, mobile-safe Retailer staff invitation delivery contract
**Branch:** `feature/retailer-staff-invitation-delivery`
**Base commit:** `38a05dc` (`origin/main`)
**Scope:** backend / web repository only. **No Flutter file is touched.**

---

## 0. Conclusion, stated first

**The root problem: "send a staff invitation" existed only inside the Next.js server
process.** It required the service-role key (three of its four RPCs are granted to
`service_role` alone), the Resend credential, and `APP_ORIGIN`. A Flutter client cannot be
given any of those, so mobile had exactly two options — go without the feature, or grow a
second implementation that would drift from the web's the first time either was edited.

This milestone moves the privileged half behind one door and leaves the web calling
through it.

| | |
|---|---|
| New Edge Function | **`send-retailer-staff-invitation`** |
| New migration | **None.** The four existing RPCs are reused unchanged. |
| New RPC | **None.** |
| Modified RPC | **None.** |
| New invitation table | **None.** |
| Modified Flutter file | **None.** |
| Web behaviour change | one **new** outcome (see § F), otherwise unchanged |

After the migration the web process no longer constructs a service-role client for
invitation delivery, no longer names the three service-only RPCs, no longer calls Resend,
and no longer generates or hashes an invitation token. Those four properties are asserted
as build-failing rules, not left to review — see § I.

**Flutter-only next step:** build the Invite Staff form against the contract in § B. No
backend work remains for it.

---

## 1. Files changed

### Added

| Path | What it is |
|---|---|
| `supabase/functions/send-retailer-staff-invitation/index.ts` | the Edge Function |
| `lib/staff/staff-invitation-delivery-contract.ts` | the shared request/response contract (pure) |
| `lib/staff/staff-invitation-cors.ts` | the CORS policy and the only `Response` builder (pure) |
| `lib/staff/staff-invitation-delivery-contract.test.ts` | 43 tests |
| `lib/staff/staff-invitation-cors.test.ts` | 12 tests |
| `lib/staff/staff-invitation-edge-function-safety.test.ts` | 49 source-level security rules |
| `lib/staff/staff-invitation-web-migration.test.ts` | 20 web-regression rules |
| `docs/retailer-staff-invitation-delivery-audit.md` | this document |

### Modified

| Path | Change |
|---|---|
| `lib/staff/retailer-staff-invitations.ts` | `sendRetailerStaffInvitation` now calls the Edge Function; `revokeRetailerStaffInvitation` unchanged |
| `lib/staff/staff-invite-flow.ts` | `recordSent` now reports its outcome; results are wire codes; new partial-success outcome |
| `lib/staff/staff-invitation-email.ts` | configuration is injected instead of read from `process.env`, making the module Deno-loadable |
| `lib/features/retailer-staff-invitations.ts` | the "enabled" comparison now comes from the shared contract |
| `app/(retailer)/retailer/staff/actions.ts` | handles the two new outcomes |
| `lib/staff/staff-invite-flow.test.ts` | rewritten for the new sequence contract (29 tests) |
| `lib/staff/staff-invitation-email.test.ts` | rewritten for injected configuration (23 tests) |
| `lib/staff/staff-source-safety.test.ts` | rules 14–23 updated/added for the migration |
| `supabase/config.toml` | declares the function with `verify_jwt = true` |
| `.env.example` | records where each variable now lives |

---

## A. Authentication model

Three independent checks, in this order. Removing any one of them leaves the other two
sufficient; that is the point.

1. **The gateway.** `verify_jwt = true` in `supabase/config.toml`. An unauthenticated
   `POST` is rejected before the function's code runs — confirmed against the deployed
   function in § J.
2. **The function.** `asCaller.auth.getUser(accessToken)` **revalidates** the token with
   the Auth server rather than decoding its claims, so a revoked or expired session fails
   here. `getSession()` is never called, and the JWT is never decoded locally.
3. **PostgreSQL.** `reserve_retailer_staff_invitation()` runs under the caller's own token,
   derives the Retailer from `auth.uid()`, requires `RETAILER_STAFF_MANAGE`, and locks and
   validates every submitted shop against that Retailer.

**No organization selector exists anywhere in the request.** There is no parameter for a
Retailer organization id, and an unknown top-level key is rejected rather than ignored.

### Caller client versus service client

| | `asCaller` | `asService` |
|---|---|---|
| Key | publishable / anon | service role |
| Carries the caller's token | **yes** | **never** |
| Built | before authentication | only after authentication *and* validation |
| Used for | `reserve_retailer_staff_invitation` | `prepare_…`, `record_…_sent`, `record_…_failure` |

The reservation is **never** reachable under the service client — that would bypass
`auth.uid()` and make the permission check meaningless. The three service-only RPCs are
**never** reachable under the caller client — the database revokes them from `anon` and
`authenticated` anyway (verified against the hosted project in § J).

**The invitation id used by the service client comes only from the reservation.** There is
no request field for it, and `lib/staff/staff-invite-flow.ts` is the only thing that
passes it — it reads it from the reservation result and from nowhere else.

---

## B. Request schema

```
POST /functions/v1/send-retailer-staff-invitation
Authorization: Bearer <the caller's Supabase access token>
apikey: <publishable/anon key>
Content-Type: application/json
```

```jsonc
{
  "firstName": "Ada",
  "lastName":  "Lovelace",
  "email":     "ada@example.com",
  "roleCode":  "RETAILER_MANAGER" | "SALES_STAFF",
  "shopIds":   ["11111111-1111-4111-8111-111111111111"]
}
```

Those five fields are the **entire** client-influenced surface. `shopIds` is **required
even for a Retailer Manager**, who must send `[]` explicitly: an absent array and an empty
one must not be the same request, or "I chose no shops" becomes expressible as "I forgot
the field".

### Canonicalization

| Field | Rule |
|---|---|
| `firstName`, `lastName` | trimmed; **never** case-folded ("de Silva" is not "De Silva") |
| `email` | trimmed and lower-cased — the same canonical form the database's own constraint enforces |
| `roleCode` | trimmed and upper-cased, then required to be one of exactly two codes |
| `shopIds` | trimmed, lower-cased, sorted; checkbox order cannot change the request |

### Every rejection

| Condition | Code | HTTP |
|---|---|---|
| not a `POST` (and not the `OPTIONS` preflight) | `METHOD_NOT_ALLOWED` | 405 |
| malformed JSON, or a body over 64 KiB | `INVALID_REQUEST` | 400 |
| body is not a JSON object (`null`, an array, a string) | `INVALID_REQUEST` | 400 |
| **any unknown top-level key** | `INVALID_REQUEST` | 400 |
| a missing, blank, non-string, or >200-character name | `INVALID_REQUEST` | 400 |
| a missing, non-string, malformed, or >254-character email | `INVALID_REQUEST` | 400 |
| an unsupported or non-string role code | `INVALID_REQUEST` | 400 |
| `shopIds` absent, not an array, or holding a non-string | `INVALID_REQUEST` | 400 |
| a malformed shop UUID | `INVALID_REQUEST` | 400 |
| a **duplicate** shop UUID (including a case-only duplicate) | `INVALID_REQUEST` | 400 |
| more than 200 shops | `INVALID_REQUEST` | 400 |
| shops supplied for `RETAILER_MANAGER` | `INVALID_ROLE_SHOP_COMBINATION` | 422 |
| zero shops for `SALES_STAFF` | `INVALID_ROLE_SHOP_COMBINATION` | 422 |

A duplicate is **refused, not de-duplicated**. The database would collapse it silently
(`array_agg(distinct …)`), so a client that sends one has a defect and hiding it would let
that defect reach production unnoticed.

**Client-side validation is never trusted, and this parser is not the boundary either.**
`reserve_retailer_staff_invitation()` re-applies every rule above and remains the final
authority.

---

## C. Response schema

Every reply is exactly three fields. There is no field a SQL message, a SQLSTATE, a
PostgREST payload, a provider body, a stack trace, project information, an invitation id,
an email address, a raw token, or a token hash could occupy.

```jsonc
{ "version": 1, "outcome": "…", "code": "…" }
```

### `outcome` — the safety-critical classification

A client must be able to answer **"might an email have been delivered?"** from this field
alone.

| `outcome` | Meaning |
|---|---|
| `SENT` | first delivery; the provider accepted it; the send was recorded |
| `RESENT` | the same, for an invitation that already existed |
| `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` | the provider accepted it; the recording could not be confirmed — see § F |
| `DELIVERY_FAILED` | the provider did not accept it; the invitation is live and retryable |
| `NOT_SENT` | nothing was handed to the provider; safe to repeat once `code` is addressed |

### `code` — the stable machine codes

For the four delivery outcomes, `code === outcome`. For `NOT_SENT`, `code` is the reason.

| `code` | HTTP | `outcome` |
|---|---|---|
| `SENT` | 200 | `SENT` |
| `RESENT` | 200 | `RESENT` |
| `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` | **202** | itself |
| `DELIVERY_FAILED` | 502 | itself |
| `INVALID_REQUEST` | 400 | `NOT_SENT` |
| `AUTH_REQUIRED` | 401 | `NOT_SENT` |
| `ACCESS_DENIED` | 403 | `NOT_SENT` |
| `METHOD_NOT_ALLOWED` | 405 | `NOT_SENT` |
| `INVITATION_CONFLICT` | 409 | `NOT_SENT` |
| `INVALID_ROLE_SHOP_COMBINATION` | 422 | `NOT_SENT` |
| `RETAILER_INACTIVE` | 422 | `NOT_SENT` |
| `INTERNAL_ERROR` | 500 | `NOT_SENT` |
| `FEATURE_DISABLED` | 503 | `NOT_SENT` |
| `NOT_CONFIGURED` | 503 | `NOT_SENT` |

Two invariants are asserted rather than assumed:

* **every `NOT_SENT` code has a ≥400 status**, so a naive `if (response.ok)` cannot read a
  refusal as a send;
* **every "the email may exist" code has a 2xx status**, so no HTTP client library, proxy,
  or retry policy resubmits the write on its own.

**`RATE_LIMITED` is deliberately absent.** There is no rate limiter in this system, and
advertising a code no implementation can produce would be a claim about a control that
does not exist.

### Versioning

`version` is pinned at `1`. It is bumped only for a **breaking** change — a removed field,
a changed field meaning, or a repurposed outcome. **Adding a new `code` to an existing
`outcome` is not breaking**: clients must treat an unrecognized code as its outcome's
generic case, which is why the outcome vocabulary is tiny and the code vocabulary may grow.

---

## D. Reused RPCs — exactly four, unchanged

| RPC | Client | Migration |
|---|---|---|
| `reserve_retailer_staff_invitation(text, text, text, text, uuid[])` | caller | `20260723210000` |
| `prepare_retailer_staff_invitation(uuid, text)` | service | `20260724090000` |
| `record_retailer_staff_invitation_sent(uuid, text)` | service | `20260724090000` |
| `record_retailer_staff_invitation_failure(uuid, text)` | service | `20260724090000` |

No migration was written. **No invitation table is written directly** — `.from("…")`
appears nowhere in the function, and neither does `retailer_staff_invitations`,
`retailer_shop_members`, `retailer_invitation_shop_assignments`, or `audit_logs`. All audit
behaviour stays inside the RPCs, which choose the action, the actor and the metadata
themselves; no client-supplied audit data is accepted anywhere.

`prepare_retailer_staff_invitation` returns more columns than this function reads
(`invitation_id`, `last_name`, `expires_at` are also returned). Only the four it needs are
consumed.

### SQLSTATE mapping

| From `reserve` | Code |
|---|---|
| `42501` insufficient_privilege | `ACCESS_DENIED` |
| `55000` object_not_in_prerequisite_state | `RETAILER_INACTIVE` |
| `23514` check_violation, role/shop conflict | `INVITATION_CONFLICT` |
| `23514` check_violation, anything else | `INVALID_REQUEST` |
| transport, or any other SQLSTATE | `INTERNAL_ERROR` |

**One deviation from the "never match an error message" rule, stated plainly.** Every
refusal `reserve` raises carries a distinct SQLSTATE **except** the role/shop conflict,
which shares `23514` with ordinary validation failures. Separating the two therefore needs
one comparison against the literal
`"Revoke and re-issue this invitation to change its role or shops"`, which is defined in
**this repository's own migration `20260723210000`**. It is compared rather than parsed, it
is never forwarded to a client, and it selects only between two of this contract's own
codes. **If the migration's wording ever changes, the match fails and the outcome degrades
to `INVALID_REQUEST`** — a safe generic refusal, never a wrong action — so no security
property depends on it. The alternative was a migration to give the conflict its own
SQLSTATE; this milestone has no other reason to write one, and the existing web code has
carried the same comparison since the feature shipped.

---

## E. Token generation and hash handling

The token module is **imported, not re-implemented** —
`lib/invitations/existing-user-token.ts`, the same file the acceptance intake route hashes
with. A second Deno copy would mean the value stored and the value the accept route
computes could diverge, and acceptance would silently break.

| Property | Value |
|---|---|
| Source of randomness | `crypto.randomBytes` (`node:crypto`, which Deno 2 supports). Never `Math.random`. |
| Length | 32 bytes = **256 bits** |
| Encoding | base64url, unpadded (43 characters) |
| Hash | SHA-256, **64 lowercase hex** — byte-identical to the database's `token_hash_format` CHECK |
| Stored | **the hash only** |
| Rotation | a **new** token on every attempt, including a resend and a post-failure retry |
| Expiry | `prepare` sets `expires_at = now() + 24 hours` — the database's decision, not the function's |

**The raw token never leaves the sequence.** It is minted in step 2, handed to the email
sender in step 4, and that is all: the string `rawToken` does not appear in the Edge
Function at all, it is never returned, never logged, never persisted, and the response type
has no field it could occupy. The **hash** is named only as a destructured port parameter
and as the value of an RPC argument — asserted line-by-line by rule 32 of the safety suite.

Token entropy, encoding, hash format, determinism and uniqueness are covered by the
existing `lib/invitations/existing-user-token.test.ts` (the module is unchanged); rotation
on resend and the token's absence from every result are covered by
`lib/staff/staff-invite-flow.test.ts`.

### The invitation URL, and acceptance — unchanged

```
${APP_ORIGIN}/invitations/staff/enter?token=<raw-token>
```

`app/invitations/staff/enter/route.ts` is **not modified by this milestone**. Re-confirmed
by reading it, and pinned by rule 18 of `staff-invitation-web-migration.test.ts`:

* it hashes the token **server-side** (`hashInvitationToken`, Node runtime);
* it stores the hash in a short-lived **HttpOnly**, `SameSite=Lax`, path-scoped,
  Secure-in-production cookie;
* it redirects to the clean `/invitations/staff` with the query stripped;
* it sets **`Referrer-Policy: no-referrer`** on every response, including failures;
* it logs nothing at all, and the token is never rendered.

Acceptance still requires a confirmed authenticated session whose email matches the
invitation, and still runs through `accept_retailer_staff_invitation`. **Nothing about
acceptance changed.**

---

## F. Delivery sequence and the partial success

The order lives in `lib/staff/staff-invite-flow.ts` — one pure module, no I/O — so the web
and Flutter clients cannot execute a different one.

```
1. authenticate the caller                       (gateway + getUser)
2. parse and validate                            (shared contract)
3. reserve                     CALLER client     -> invitation id, canonical email, is_resend
4. generate a fresh raw token + SHA-256 hash
5. prepare                     SERVICE client    -> stores the hash, rotates the token,
                                                    refreshes the 24h window, returns display fields
6. render the existing message
7. submit to Resend                              (exactly ONE attempt)
8a. rejected/transport failure -> record_failure -> DELIVERY_FAILED
8b. accepted                   -> record_sent    -> SENT | RESENT
                                  …or, if that write fails -> DELIVERY_ACCEPTED_STATUS_UNCONFIRMED
```

**No automatic retry, anywhere.** One `sendEmail` call, one `recordSent` call, one
`recordFailure` call, and the reservation is never repeated after a later step fails — each
asserted individually.

Every dynamic value in the message comes from `prepare` (the database), not from the
request: a client cannot redirect the email to a different address or relabel the Retailer.

### The dangerous case: Resend accepts, `record_sent` fails

**The invitation remains fully acceptable, and this was verified against the migrations
rather than assumed.** By the time the email goes out, `prepare` has already stored the
token hash, set `expires_at = now() + 24 hours` and left the row `PENDING`. Neither
`public.get_retailer_staff_invitation_for_recipient()` nor
`public.accept_retailer_staff_invitation()` reads `sent_at` at all (migration
`20260724210000`). What is unconfirmed is the **bookkeeping** — `sent_at` and the
`STAFF_INVITATION_SENT` / `STAFF_INVITATION_RESENT` audit row — not the recipient's ability
to accept.

So the response must not encourage a repeat. Repeating the whole write re-reserves, mints a
**new** token and rotates the hash, which **kills the link that was just delivered** and
sends a second email.

| Property | Decision |
|---|---|
| Outcome | `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` |
| HTTP status | **202 Accepted** — a success status, so nothing auto-retries the write |
| What the client must do | **re-read the invitation history** and show the operator its current state |
| What the client must not do | resend automatically |
| What is disclosed | nothing: no provider response, no RPC error, no invitation state |

A deliberate, human-initiated resend afterwards is fine, and is exactly what the existing
resend control already does.

The previous behaviour reported this case as a plain `sent`. That was defensible — the
email *had* gone out — but it meant the invitation history the operator was about to
re-read would silently disagree with the message they had just been shown, and no client
could explain the gap. This is the one deliberate user-facing change in this milestone.

### If `record_failure` fails

Still `DELIVERY_FAILED`. Nothing was delivered, `sent_at` is null and the token is current,
so the invitation is retryable whether or not the failure was written down. `recordFailure`
returns `void` precisely so no branch can turn the bookkeeping into a different outcome.

---

## G. Email delivery

Unchanged content, unchanged sender behaviour: the same subject, the same text and HTML
bodies, the same escaping, the same Resend REST endpoint, no `resend` npm package.

The only change to `lib/staff/staff-invitation-email.ts` is that **`RESEND_API_KEY`,
`RESEND_FROM` and `APP_ORIGIN` are now passed in instead of read from `process.env`** —
Deno has no `process.env`, and a module with no ambient configuration cannot leak
configuration it never sees. `APP_ORIGIN` is validated the same way (absolute URL, https
except on a loopback host) and reduced to its **origin**, so a stray path in the variable
cannot bend the accept URL.

Configuration is validated **at request time, before anything is reserved**, so a
deployment gap is `NOT_CONFIGURED` rather than a delivery failure against an invitation
that now exists and looks half-sent.

**Never returned, never logged:** the provider's status, body, or error; the recipient; the
API key; the accept URL; the raw token; the email HTML. A transport throw is not even bound
— it carries the request headers (which include the key) and the body (which includes the
accept URL, and therefore the token).

---

## H. CORS, feature flag, secrets, deployment

### CORS

The same policy `submit-receipt` uses, and `staff-invitation-cors.test.ts` asserts the two
header maps are **byte-identical** so the two mobile entry points cannot drift.

```
Access-Control-Allow-Origin:  *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: authorization, apikey, x-client-info, content-type,
                              x-supabase-api-version, x-region
Access-Control-Max-Age:       3600
```

* `apikey` and `x-client-info` are listed because a real Supabase client (JS **and** Dart)
  attaches them on every call, `functions.invoke` included. One unlisted header fails the
  whole preflight, and the browser then discards the real response — the function runs, the
  invitation is sent, and the client sees nothing. That exact defect shipped once already.
* **`Access-Control-Allow-Credentials` is deliberately absent.** It is the one header that
  would make the wildcard origin dangerous.
* The wildcard is safe **for this endpoint specifically** because it carries no ambient
  authority: it authenticates from `Authorization: Bearer`, which a browser will not attach
  cross-site on its own, and **it reads no cookie**. The web client sends the request with
  `credentials: "omit"`.
* This covers Flutter Web on any localhost port, the configured production web origin, and
  Flutter native (not subject to CORS) with no origin allow-list to maintain.
* **CORS changes nothing about who may send.** The gateway still verifies the JWT, the
  function still revalidates it, and PostgreSQL still decides.
* `OPTIONS` is answered **before** authentication — a preflight carries no `Authorization`
  header, so a 401 there would block every cross-origin caller. The branch contains exactly
  one statement.
* **Every** reply goes through `corsJsonResponse`, including the unexpected-throw reply.
  There is no `new Response(` in the function.

### Feature flag

`RETAILER_STAFF_INVITATIONS_ENABLED` is read in **two** places and enforced in the one that
matters:

| Where | Reads | Purpose |
|---|---|---|
| `lib/features/retailer-staff-invitations.ts` | `process.env` | keeps the portal from offering or attempting a send |
| the Edge Function | `Deno.env` | **the gate.** A hidden button is not a security boundary; a Flutter client never runs the web process, and a hand-crafted POST never renders a page |

Both compare against the **same** literal, `isStaffInvitationSendingEnabled` in the shared
contract, so the two runtimes cannot disagree. It **fails closed**: `"1"`, `"yes"`, `"on"`,
`"TRUE"`, `"True"`, `" true "` are all disabled. The function checks it **before** parsing
the body and before reserving anything.

Still deliberately **not** gated: reading the roster, reading the invitation list,
**revoking** an invitation, and **accepting** one. A kill switch must not be able to strand
a recipient mid-flow or stop an owner withdrawing an invitation.

### Required secrets, by name only

Platform-injected (present already, not set by hand):

* `SUPABASE_URL`
* `SUPABASE_PUBLISHABLE_KEY` — preferred; falls back to `SUPABASE_ANON_KEY`, which is what
  this project has
* `SUPABASE_SERVICE_ROLE_KEY`

Set for this milestone with `supabase secrets set` (values never printed, never committed):

* `RESEND_API_KEY`
* `RESEND_FROM`
* `APP_ORIGIN`
* `RETAILER_STAFF_INVITATIONS_ENABLED`

### Deployment

```
supabase secrets set --env-file <file with the four values above> --project-ref <ref>
supabase functions deploy send-retailer-staff-invitation --project-ref <ref>
```

Only this function was deployed. No migration was pushed, and no other function was
touched.

---

## I. Web migration

`sendRetailerStaffInvitation` now POSTs to the Edge Function with the signed-in operator's
own access token. Everything else about the portal is unchanged: the same form, the same
field names, the same Server Action, the same validator, the same assignable-shop subset
check, the same resend-by-id rule, the same revoke path.

### The access token, and why `getSession()` is right here

The module needs the token as a **string to forward**, not an authorization decision — so
the usual rule ("use `getUser()`, not `getSession()`") is not being bent. Nothing in the web
process trusts it: the gateway verifies it, the function revalidates it with the Auth
server, and PostgreSQL decides from `auth.uid()`. The Server Action has *also* already
resolved portal access with `getUser()` before reaching this line.

### What the web process can no longer do

| | Before | After |
|---|---|---|
| Construct a service-role client for delivery | yes | **no** |
| Name `prepare_…` / `record_…_sent` / `record_…_failure` | yes | **no** |
| Call Resend | yes | **no** |
| Generate or hash an invitation token | yes | **no** |
| Know the invitation id, raw token, or token hash | yes | **no** |

Each is a build-failing rule in `lib/staff/staff-source-safety.test.ts` (rules 14, 14b,
17–23). Rule 17 in particular now asserts that **exactly one** staff module constructs the
service-role client — `staff-registration.ts`, which needs it for an unrelated,
already-documented reason. Service-role usage elsewhere in the codebase (receipts, owner
invitations, product writes) is untouched.

### No dead duplicate implementation remains

`lib/staff/staff-invite-flow.ts` and `lib/staff/staff-invitation-email.ts` are **retained
and still live** — the Edge Function is their only caller, which is the whole point of
having written them dependency-free. Nothing was left behind that no longer has a call
site: `runStaffInviteFlow(` and `sendStaffInvitationEmail(` appear in no web module, and
that is asserted.

### Outcome mapping

`RESULT_FOR_CODE` is an exhaustive `Record<StaffInvitationCode, …>` rather than a switch
with a default, so adding a code to the contract is a **type error** until the portal
decides what it means. A silently-defaulted new code is how a successful delivery starts
being rendered as a generic failure.

| Code | Portal outcome | What the operator sees |
|---|---|---|
| `SENT` / `RESENT` | `sent` / `resent` | unchanged success message |
| `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` | `sent-unconfirmed` | **new** success message pointing at the list, not the button |
| `DELIVERY_FAILED` | `delivery-failed` | unchanged |
| `INVITATION_CONFLICT` | `conflict` | unchanged conflict copy |
| `NOT_CONFIGURED` | `misconfigured` | unchanged configuration message |
| `FEATURE_DISABLED` | `paused` | the existing paused message |
| `ACCESS_DENIED`, `RETAILER_INACTIVE`, `INVALID_REQUEST`, `INVALID_ROLE_SHOP_COMBINATION`, `AUTH_REQUIRED` | `rejected` | unchanged generic message |
| `METHOD_NOT_ALLOWED`, `INTERNAL_ERROR`, an unrecognized or unparsable reply | `unavailable` | unchanged generic message |

The collapse of the first five refusals into one message is deliberate and preserved: the
RPCs refuse most of them with a single byte-identical exception so they cannot be used as
an existence oracle, and distinguishing them in the UI would reintroduce that disclosure.

---

## J. Verification performed

### Automated

| Check | Result |
|---|---|
| `npm test` | **1232 tests, 284 suites, 0 failures** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | succeeded; all routes compiled |
| `git diff --check` | clean |

New/rewritten tests in this milestone: 43 (contract) + 12 (CORS) + 49 (Edge Function
safety) + 20 (web regression) + 29 (delivery sequence) + 23 (email) = **176**, plus 10
updated rules in the staff source-safety suite.

### Against the hosted project

Migrations: `supabase migration list --linked` — **all 41 local migrations present
remotely**, none pending.

RPC signatures and grants, checked by calling each one directly (every call raises before
any write):

| Call | Result | Proves |
|---|---|---|
| `prepare_…(null, null)` as `service_role` | `23514 Invitation could not be prepared` | exists with those parameter names; granted to `service_role` |
| `record_…_sent(null, null)` as `service_role` | `23514 Invitation send could not be recorded` | same |
| `record_…_failure(null, null)` as `service_role` | `23514 Invitation failure could not be recorded` | same |
| the same three as `anon` | `42501 permission denied for function …` | **revoked from browser roles** |
| `reserve_…(…)` as `anon` | `42501 permission denied for function …` | revoked from `anon`; granted to `authenticated` only (migration `20260723210000` line 433) |

Against the deployed Edge Function:

| Request | Result |
|---|---|
| `OPTIONS`, no auth | **204** with the exact policy from § H |
| `POST`, no `Authorization` | **401** (gateway, before the function runs) |
| `POST`, malformed bearer | **401** (gateway) |
| `GET` / `PUT` | **405** `{"version":1,"outcome":"NOT_SENT","code":"METHOD_NOT_ALLOWED"}` |

### Not performed

**Database (pgTAP) tests were not run: Docker is not running on this machine.** There is
also no existing pgTAP suite covering staff invitations — `supabase/tests/database/`
contains `portal_context`, `sales_staff_receipt_reads`, and eight `vendor_*` suites, none
of which touches this feature. No new database test was added, because no SQL changed.
**The source-static Node tests in this milestone prove structure, not runtime SQL
behaviour, and are not offered as SQL coverage.**

**The hosted Chrome verification was not performed.** Browser automation was unavailable in
this session. The dev server is running on `http://localhost:3000` (which matches the
deployed `APP_ORIGIN`, so emailed links resolve to it); § K is the checklist to work
through manually.

---

## K. Hosted verification checklist (to be run manually)

Sign in at `http://localhost:3000/login` as the existing Retailer **Owner** and open
`/retailer/staff`.

### Retailer Manager invitation

1. Enter a first name, last name and email.
2. Choose **Retailer Manager**. Confirm the shop selector is **not shown** — no shop id is
   submitted.
3. Send. Expect `Invitation sent to <address>.`
4. Confirm the invitation history below re-reads and shows the new row as
   `RETAILER_MANAGER`, pending.
5. Confirm the email arrives, and that its link is
   `http://localhost:3000/invitations/staff/enter?token=…`.
6. Open the link. Confirm the address bar lands on `/invitations/staff` with **no token in
   the URL**, and that the existing acceptance screen appears.

### Sales Staff invitation

1. Enter a first name, last name and email.
2. Choose **Sales Staff**, then tick one or more active shops.
3. Send. Expect `Invitation sent to <address>.`
4. Confirm the history shows the intended role and state.
5. Confirm the email arrives, accept it, and confirm the staff membership is created and
   the selected shop assignments appear on the roster afterwards.

### Failure cases

| Case | Expected |
|---|---|
| Sales Staff with **no** shop ticked | refused in the form before any delivery — `Select at least one shop.` |
| An invalid email | refused in the form — `Enter a valid email address.` |
| Resend a pending invitation unchanged | succeeds; `Invitation re-sent to …` |
| Resend after changing the role or shops for the same address | the stable conflict copy: *"A live invitation already exists for this email address with a different role or shops…"* |
| Provider failure (temporarily break `RESEND_API_KEY` on the function, then restore it) | the delivery-failed message only — **no provider text of any kind** |
| Sign out, then replay the invite POST | refused; no invitation created |
| Sign in as a Retailer **Manager** | the invite form and the invitation list are not available; a forged POST is refused |

**Do not paste a real invitation token into any report.**

---

## L. Flutter integration contract

Everything Flutter needs, and nothing it must not have.

```dart
final response = await supabase.functions.invoke(
  'send-retailer-staff-invitation',
  body: {
    'firstName': firstName,      // required, trimmed, 1..200 chars
    'lastName':  lastName,       // required, trimmed, 1..200 chars
    'email':     email,          // required, <= 254 chars, something@something.something
    'roleCode':  roleCode,       // 'RETAILER_MANAGER' | 'SALES_STAFF'
    'shopIds':   shopIds,        // REQUIRED. [] for a Manager; >= 1 uuid for Sales Staff.
  },                             // no duplicates; lowercase canonical uuids
);
```

**Requirements on the client**

1. **Send nothing else.** An unknown key is a 400. Never send an organization id, user id,
   profile id, membership id, permission, invitation id, token, hash, audit field,
   invitation state, expiry, or any Resend setting.
2. **Be signed in.** `functions.invoke` attaches the session's access token; the gateway
   rejects the request without it.
3. **Read `outcome` first, then `code`.** Treat an unrecognized `code` as its `outcome`'s
   generic case. Refuse a `version` other than `1`.
4. **Never auto-retry a 2xx.** In particular `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` (202)
   means *re-read the invitation history* — resending would invalidate a link that has
   already been delivered.
5. **Read the shop list from `list_retailer_staff_assignable_shops()`** and offer only
   those. It is granted to `RETAILER_STAFF_SHOP_ASSIGN` holders and derives the Retailer
   from `auth.uid()`.
6. **Render your own copy from the code.** The response carries no user-facing text, by
   design.

Suggested handling:

| `code` | Suggested client behaviour |
|---|---|
| `SENT` / `RESENT` | success; clear the form; re-read the invitation list |
| `DELIVERY_ACCEPTED_STATUS_UNCONFIRMED` | success with a caveat; **re-read the list**; do not resend |
| `DELIVERY_FAILED` | "the email could not be delivered — you can try again" |
| `INVALID_REQUEST` / `INVALID_ROLE_SHOP_COMBINATION` | a client-side bug or stale form; re-validate locally |
| `AUTH_REQUIRED` | re-authenticate |
| `ACCESS_DENIED` / `RETAILER_INACTIVE` | one generic "we couldn't send that invitation" |
| `INVITATION_CONFLICT` | "a live invitation exists with a different role or shops — revoke it, then create a replacement" |
| `FEATURE_DISABLED` | the paused message |
| `NOT_CONFIGURED` / `INTERNAL_ERROR` / `METHOD_NOT_ALLOWED` | a generic "try again later" |

---

## M. Known limitations

1. **A malformed or expired JWT is rejected by the gateway, not by this contract.** The
   client receives Supabase's own `{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT","message":…}`
   at 401, not `{version, outcome, code}`. That is correct — the request never reaches the
   function — but a client must handle a 401 whose body is not this contract's shape. The
   web module already does: an unparsable reply becomes a generic outage rather than a
   guess. `AUTH_REQUIRED` is therefore reachable mainly for a token the gateway accepted
   but the Auth server rejects (a session revoked in between), or a missing header on a
   method the gateway lets through.
2. **`INVITATION_CONFLICT` depends on one message comparison.** Fully explained in § D. It
   degrades safely to `INVALID_REQUEST`, and only a migration could make it structural.
3. **No rate limiting exists.** An authorized Retailer Owner can send invitations as fast
   as they can submit. Resend's own limits apply, and a rejection there surfaces as
   `DELIVERY_FAILED` with nothing provider-specific. There is no `RATE_LIMITED` code
   because there is no rate limiter.
4. **`NOT_CONFIGURED` discloses that the deployment lacks email configuration** — to an
   authenticated caller who has already passed the gateway. This matches the message the
   portal has always shown, and names no variable.
5. **The two feature-flag copies must be kept in step.** The Edge Function's is the gate;
   the web's only controls what the portal offers. If they disagree, the portal will either
   offer a button the function refuses, or hide one that still works for Flutter.
6. **`APP_ORIGIN` on the deployed function currently points at `http://localhost:3000`**,
   matching the local portal used for verification. It must be changed to the production
   origin before any non-development use, or emailed links will be unreachable.
7. **The delivery sequence is not transactional across the provider boundary**, and cannot
   be — that is precisely what § F exists to describe honestly rather than paper over.
8. **Database behaviour was not exercised at runtime in this milestone.** No SQL changed,
   so none was added; but the pgTAP suites were not run (no Docker), and the source-static
   tests here are not a substitute.

---

## N. Explicitly NOT in this milestone

* the Flutter **Invite Staff** UI
* Flutter invitation **acceptance**
* mobile **deep links**
* **post-acceptance shop reassignment** — adding, removing or moving a staff member's shops
  after they accept
* any **shop write**
* staff **status** changes (activate / deactivate)
* staff **role** changes
* any new invitation table, invitation lifecycle RPC, or migration
