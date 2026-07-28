# Retailer Staff Membership Lifecycle — backend contracts

**Milestone:** `20260810090000_retailer_staff_membership_lifecycle.sql`
**Status:** backend only. **THIS MILESTONE SHIPS NO UI.** No Web page, Server Action, React
component, or Flutter code was created or changed.

**What it adds:** exactly two functions, and nothing else.

| Function | Kind | Purpose |
| --- | --- | --- |
| `public.set_retailer_staff_membership_status(p_membership_id uuid, p_status text)` | write | A Retailer Owner deactivates or reactivates one eligible staff membership. |
| `public.get_my_lifecycle_access_state()` | read | A signed-in caller asks why *their own* access is refused. Zero arguments, self-only. |

No table, column, constraint, index, trigger, RLS policy, role, permission, or
role→permission mapping was created, altered, or dropped, and **no existing function was
touched**.

---

## 1. Why this exists

Until now a Retailer Owner had no way to stand a staff member down. The recorded alternatives
were each wrong in a different way:

- **Revoking the invitation** does nothing to someone who has already accepted it.
- **Emptying the shop list** is refused by `set_retailer_staff_shop_assignments`, and was
  refused there *deliberately* — its migration names this milestone as the operation that
  would own the case.
- **Deleting the membership** would destroy the person's receipt history, their Shop history,
  their invitation record and their audit trail, none of which has a restore path.

So an Owner whose Sales Staff member left the business had two real options: leave a working
account in the hands of someone who no longer works there, or ask the Vendor to intervene out
of band. This milestone is the missing operation.

### The second gap: refusals that cannot be explained

The activation/deactivation audit found that the existing protected RPCs block an inactive
user **correctly but indistinguishably**. `resolve_retailer_member_organization` returns
`NULL` for a deactivated membership, an inactive Retailer, a wrong-role caller *and* a caller
who was never provisioned — and every one of those becomes the same generic `42501`.

That uniformity is a security property and is **preserved**: it is what stops a caller
probing the schema. But it left the application unable to write honest copy. "You do not have
access to this page" is the wrong sentence for someone whose account was deactivated this
morning. `get_my_lifecycle_access_state()` closes that gap without weakening anything — see
§ 6.

---

## 2. Business rules

### Eligible targets

A target is eligible only when its **complete ACTIVE role set** is exactly one of:

- `{RETAILER_MANAGER}`
- `{SALES_STAFF}`

The comparison is against the whole set, not a membership test. That single rule refuses, in
one comparison:

| Refused target | Why |
| --- | --- |
| **Every `RETAILER_OWNER`** | An Owner is the tenant's root of authority: their membership is what `resolve_retailer_owner_organization` resolves, so deactivating one can strand a Retailer with **no one** able to reactivate anybody — including the person just deactivated. Owner lifecycle belongs to the Vendor-side milestone, whose actor is *outside* the tenant and therefore can never lock the tenant out of itself. |
| **Multi-role** (e.g. `SALES_STAFF` + `RETAILER_MANAGER`) | Not described by the single `role_code` the function returns and audits. "Deactivate the Sales Staff half of someone" is not a shape this schema models. |
| **Role-less** | A membership with no ACTIVE role is a half-built or partially-revoked state, not a staff member. |

Note that `RETAILER_OWNER` **does not appear in the executable body at all**. The exclusion is
achieved by requiring an exact one-element set, which is why it also holds for any role a
future migration invents.

### The caller may not address themselves

Under today's mapping this is belt and braces: `RETAILER_STAFF_MANAGE` is mapped to
`RETAILER_OWNER` alone, and every Owner target is already refused. It is written explicitly
anyway, because the role rule answers *who may be a target* and this answers *who is asking* —
two different questions that happen to have the same answer today and would stop having it the
moment `RETAILER_STAFF_MANAGE` were granted to `RETAILER_MANAGER`. On that day a Manager could
deactivate themselves, be locked out mid-request, and need a second person to undo it.

The check compares **user ids**, so it holds regardless of how the caller's own membership was
addressed. The pgTAP suite proves it in isolation by granting the permission to
`RETAILER_MANAGER` for the length of one block, so the self rule — and not the Owner rule — is
what does the refusing.

### The status vocabulary

`p_status` is accepted only as exactly `ACTIVE` or `DEACTIVATED`. The comparison is exact and
case-sensitive: `active`, `' ACTIVE'`, `''` and `NULL` are all rejected rather than coerced,
because the value is written verbatim into a case-sensitive CHECK constraint and into an audit
row a human reads later.

`INVITED` and `SUSPENDED` are members of the *column's* vocabulary but deliberately not of
this *function's*, in both directions:

- **`INVITED` is not a state an Owner may confer.** A membership becomes `ACTIVE` by the
  recipient **accepting** their invitation, which is the only place consent is recorded and
  the only place Shop rows are created. Promoting an `INVITED` membership here would
  manufacture an accepted employment the person never accepted, with no Shop assignments and
  no acceptance audit row.
- **`SUSPENDED` is reserved** for a punitive/administrative state this milestone defines no
  owner for. Nothing here may set it, and nothing here may clear it.

Permitted **current** states are likewise `ACTIVE` and `DEACTIVATED` only.

### Authorization

`public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE')` — the **existing**
permission. **No new staff permission was created.** The resolver independently requires an
ACTIVE profile, an ACTIVE membership, an ACTIVE organization of type `RETAILER`, and an ACTIVE
role, and fails closed on zero or on more than one qualifying Retailer.

No caller role code appears in the body: if a future migration grants
`RETAILER_STAFF_MANAGE` to another role, that role gains this operation without this file
being edited.

---

## 3. Preservation semantics

**Deactivation is a membership fact, not an identity fact.** The entire change is one row and
one column pair:

```
organization_members.status         'ACTIVE' <-> 'DEACTIVATED'
organization_members.deactivated_at  now()   <-> null
```

Both move in the same statement, so the pair can never disagree — there is no window in which
a row is `DEACTIVATED` with a null timestamp or `ACTIVE` with a stale one.

Everything below survives, byte for byte:

| Preserved | Consequence |
| --- | --- |
| `auth.users` identity | Not banned, not deleted, not updated. See § 4. |
| `profiles` (including `profiles.status`) | A profile is the **person**; a membership is their **employment at one Retailer**. The same person may be Sales Staff at two Retailers, and one Owner standing them down must not sign them out of the other. |
| the `organization_members` row | Status change, never a delete. |
| `member_roles` rows | This is what makes reactivation a one-column write rather than a rebuild. |
| `retailer_shop_members` rows | Live **and** retired, including live assignments to non-ACTIVE shops that no roster shows. |
| receipt history | `receipt_submissions` is neither read nor written. |
| invitation history | `retailer_staff_invitations` is neither read nor written. |
| audit history | Only appended to. |

**Reactivation therefore restores everything automatically, because nothing was ever
removed.** That is not a convenience; it is the reason the operation is safe to expose to a
Retailer Owner at all. An operation that deleted roles and Shop assignments on the way down
would be unrecoverable in the hands of someone who clicked it by mistake, and neither
`member_roles` nor `retailer_shop_members` has a restore path.

There is **no DELETE and no TRUNCATE anywhere in the migration.**

---

## 4. Why `auth.users` is not banned or deleted

Supabase offers `banned_until` and a soft delete on `auth.users`. Both are the wrong
instrument here:

1. **`auth.users` is global; a membership is per-tenant.** Banning the Auth row would take
   effect at every Retailer the person works for *and* at the Vendor, from a button pressed by
   one Retailer Owner. That is a cross-tenant action wearing a single-tenant label.
2. **It is not this schema's authorization model.** Every protected RPC already refuses an
   inactive membership through the resolvers, so a deactivated member is blocked on their
   **very next protected request** even though their JWT is still valid and unexpired — the
   session is not the authority, the membership row is. Banning would add a second, redundant
   authority that could disagree with the first.
3. **It is unrecoverable in practice.** `20260808090000` and the account-recovery work exist
   precisely because half-built and blocked `auth.users` rows are hard to reason about after
   the fact. This milestone does not create more of them.
4. **`auth` is not ours to write.** No function in this schema writes `auth.users`.

### The consequence a client must understand

**A deactivated person can still sign in.** They will simply have no Retailer context:
`get_my_portal_context()` reports `NONE`, every protected RPC refuses, and
`get_my_lifecycle_access_state()` tells them why in words that are safe to render.

### Existing-session behaviour

A status change takes effect on an **already-issued session** with no sign-out and no token
revocation, because every protected RPC re-derives authorization from `auth.uid()` on every
call. The pgTAP suite proves exactly this: the Sales Staff member signs in **once**, reserves a
receipt successfully, is deactivated by their Owner, and is refused on the very next call
**using the same session** — the only thing that changed is one column on one row. Reactivation
then restores receipt eligibility immediately, with no role and no Shop assignment recreated.

---

## 5. Contract 1 — the status write

```sql
public.set_retailer_staff_membership_status(
  p_membership_id uuid,
  p_status        text
)
returns table (
  membership_id     uuid,
  membership_status text,
  role_code         text,
  status_changed    boolean
)
```

`SECURITY DEFINER`, `VOLATILE`, `set search_path = ''`, fully qualified references.
`REVOKE ALL` from `PUBLIC`, `REVOKE EXECUTE` from `anon`, `GRANT EXECUTE` to `authenticated`.
**No `service_role` grant** — the function's entire authority is `auth.uid()`, which a
service-role connection does not have.

### Inputs, and what is deliberately absent

The signature accepts a membership to address and a state to put it in. There is **no**
Retailer id, organization id, actor id, profile id, Auth user id, role code, permission code,
current status, audit action, or timestamp — so no URL segment, form field, header or cookie
can nominate whose staff are changed, on whose authority, or from what assumed starting state.

**The target is a membership id**, and that is the canonical safe identifier: it is already in
the roster contract (`list_retailer_staff_members().membership_id`), and
`organization_members` is `UNIQUE (organization_id, user_id)`, so a membership id names exactly
one person **in exactly one organization**. That is what makes the single
`m.organization_id = v_retailer` predicate a complete cross-tenant boundary. A profile id or an
Auth user id could not do this — one person may be staff at several Retailers, so neither
addresses a membership on its own.

### Returns

`status_changed` is what lets a client tell **"saved"** from **"already in that state"**
without a second read, and without treating a double-tap as an error. `role_code` is the value
the function *proved* from the target's own ACTIVE role set — there is no argument that could
have supplied it.

### Idempotency

An identical requested status performs **no UPDATE**, writes **no audit row**, and returns
`status_changed = false`. This matters beyond tidiness: re-running the UPDATE "harmlessly"
would silently advance `deactivated_at` and destroy exactly the fact that column exists to
hold.

### Locking

1. The acting Retailer's `organizations` row is pinned `FOR SHARE` — **before** the target is
   read, so a suspended Retailer cannot be used as an oracle for which membership ids live
   inside it.
2. The target `organization_members` row is locked `FOR UPDATE` — the serialization point. Two
   concurrent calls against the same member queue there, so the second reads the first's
   *committed* status. It also blocks a concurrent `set_retailer_staff_shop_assignments`
   against the same member, so a Shop edit and a lifecycle change cannot interleave.
3. The UPDATE is a **compare-and-set** (`and m.status = v_current`) and its row count is
   checked with `GET DIAGNOSTICS`. Under the lock it cannot fail; if it ever does, the
   assumption the function is built on has been broken by something outside it, and the only
   safe response is to abort the whole transaction rather than write an audit row describing a
   change that did not happen.

There are **no** client-supplied versions, ETags or expected-state arguments.

### Error taxonomy

Classification is by **stable SQLSTATE**, never by message matching.

| SQLSTATE | Condition | Raised for |
| --- | --- | --- |
| `42501` | `insufficient_privilege` | Unauthenticated; lacks `RETAILER_STAFF_MANAGE`; unresolved (zero or several) Retailer; inactive actor profile; null, unknown, foreign or cross-tenant target; **self** target; **Owner** target; multi-role or role-less target; `INVITED` or `SUSPENDED` current state; unexpected UPDATE drift. |
| `23514` | `check_violation` | `p_status` is not exactly `ACTIVE` or `DEACTIVATED`. |
| `55000` | `object_not_in_prerequisite_state` | The **already-authorized** acting Retailer is not ACTIVE when its lifecycle row is locked. |

**Every disclosure-sensitive `42501` uses one identical literal message.** An unknown id is
byte-identical to another Retailer's Owner, which is what stops a caller sweeping membership
ids to learn what exists elsewhere. The message contains no uuid, email, role code,
organization name or status, and is a fixed literal — never a formatted string.

Authorization is decided **before** input validation, so a stranger with a malformed status is
refused as a stranger (`42501`), not told that their status was the problem.

**Rendered clients must never surface the raw SQLSTATE or the PostgreSQL message.** This
milestone is backend-only, but the contract is fixed now for the later Web and Flutter
consumers: map `42501` → the generic refusal copy, `23514` → "that status is not valid",
`55000` → "this Retailer is not active", and everything else → a generic failure.

#### An honest note on `55000`

It is **defence in depth and currently unreachable**. The resolver already requires an ACTIVE
organization, and both reads see the same snapshot — so an organization that is inactive when
the lock is taken was inactive when the resolver ran, and the caller was refused with `42501`
long before. The pgTAP suite asserts the branch **structurally** (that it exists, that it is
the right SQLSTATE, and that it is taken before any target is resolved) and asserts the `42501`
a client actually observes today **behaviourally**.

It becomes reachable only when a Vendor-side Retailer lifecycle write exists and suspends the
organization *between* the resolver's read and this function's lock. That write is a later
milestone, and its behavioural coverage arrives with it. Deleting the check because it cannot
be exercised yet would mean the Vendor milestone silently inherits a function that writes into
a suspended Retailer.

### Audit

One row per **changing** call. A no-op writes none — a double-tap is not two decisions.

| Field | Value |
| --- | --- |
| `action` | `STAFF_MEMBERSHIP_DEACTIVATED` or `STAFF_MEMBERSHIP_REACTIVATED` |
| `entity_type` | `RETAILER_STAFF_MEMBER` (the type `20260809090000` already established) |
| `entity_id` | `organization_members.id::text` |
| `organization_id` | the derived **Retailer** — so the entry lands in the tenant's own feed and is invisible to `list_vendor_audit_logs`, which filters on the caller's Vendor |
| `actor_profile_id` | `auth.uid()` |
| `metadata` | exactly `role_code`, `membership_status_before`, `membership_status_after` |

Every metadata value is one the function **proved**: the role set was read from
`member_roles`, the before status was read under lock, and the after status was validated
against the closed vocabulary. Deliberately absent: every email address, Auth user id, profile
id, Shop id, invitation id, receipt id, token, hash, provider message, and every
caller-supplied value.

The two new action codes need no catalogue row — `audit_logs.action` and `.entity_type` are
free text with only a not-empty check, exactly as every existing code in those columns is.

---

## 6. Contract 2 — the self-only lifecycle diagnostic

```sql
public.get_my_lifecycle_access_state()
returns table (
  access_state text
)
```

`STABLE`, `SECURITY DEFINER`, `set search_path = ''`, fully qualified references.
`REVOKE ALL` from `PUBLIC`, `REVOKE EXECUTE` from `anon`, `GRANT EXECUTE` to `authenticated`,
**no `service_role` grant**.

**Zero arguments is the whole security design**, not a convenience. A function that accepted a
profile id, an email, a membership id or an organization id would be a lookup service for
other people's lifecycle states wearing a self-service label. With no arguments at all there
is nothing to substitute, no tenant to select and no id to sweep. The subject is `auth.uid()`
and can only ever be `auth.uid()`.

### Vocabulary and precedence

| `access_state` | Meaning |
| --- | --- |
| `ACTIVE` | Exactly one supported Retailer context, and everything about it is ACTIVE. |
| `PROFILE_INACTIVE` | The caller's own profile is not ACTIVE. |
| `MEMBERSHIP_INACTIVE` | Their one Retailer is ACTIVE, but their membership of it is not. **This is the state Contract 1 creates.** |
| `ORGANIZATION_INACTIVE` | Their one Retailer organization is not ACTIVE. |
| `NO_SUPPORTED_ACCESS` | No supported Retailer membership context exists at all. |
| `AMBIGUOUS` | More than one qualifying Retailer context, so no single lifecycle story can be told. |

Evaluated in this order:

1. **Unauthenticated → `42501`.** "You are not signed in" is not a lifecycle state, and
   returning one would let an unauthenticated caller treat this as a probe.
2. **No profile row at all → `NO_SUPPORTED_ACCESS`.** An `auth.users` row with no profile is
   not a deactivated person — it is a person who was never provisioned here. Reporting
   `PROFILE_INACTIVE` would put "your account has been deactivated" in front of someone whose
   account was never activated. *(The task specification did not cover this case; it is
   recorded here as a decision.)*
3. **Profile not ACTIVE → `PROFILE_INACTIVE`.** Checked first among the lifecycle causes
   because it is the broadest: such a person is blocked everywhere, at every Retailer and at
   the Vendor, so naming a single membership would send them to fix the wrong thing.
4. **Zero qualifying contexts → `NO_SUPPORTED_ACCESS`.**
5. **More than one → `AMBIGUOUS`.** The diagnostic will not guess, exactly as the Retailer
   resolvers return `NULL` rather than choose.
6. **Organization not ACTIVE → `ORGANIZATION_INACTIVE`.**
7. **Membership not ACTIVE → `MEMBERSHIP_INACTIVE`.**
8. Otherwise **`ACTIVE`**.

**Organization takes precedence over membership when both are non-ACTIVE**, because the
Retailer-wide block is the broader cause and the one that has to be resolved first. Telling a
Sales Staff member "your membership was deactivated" when their entire Retailer is suspended
would send them to an Owner who is themselves locked out and can do nothing about it.

Supported Retailer roles for interpretation: `RETAILER_OWNER`, `RETAILER_MANAGER`,
`SALES_STAFF`. The role must itself be ACTIVE. The **membership and organization statuses are
not filtered** — they are the answer, not the filter, which is why the function reads the rows
directly rather than calling `resolve_retailer_member_organization` (that resolver requires
everything ACTIVE, so every state this function exists to distinguish would collapse into one
`NULL`).

A member holding two supported roles at **one** Retailer is one context, not an ambiguous
pair.

### What it does not return

No profile id, membership id, organization id, organization name, email address, role code,
raw profile/membership/organization status, timestamp, or database message. Every return
statement in the body is a bare vocabulary literal — asserted by both test suites.

### Why it is separate from authorization

**⚠️ This is a diagnostic, not an authorization gate, and must never become one.**

The authoritative resolvers — `resolve_retailer_member_organization`,
`resolve_retailer_owner_organization`, `get_vendor_super_admin_context` — remain the only
things that decide whether an operation may proceed, and each protected RPC calls them for
*itself*, server-side, on every request. This function returning `ACTIVE` is not permission to
do anything; it is a description of why the real gate said no, computed **after** the real gate
said no. A client that branched on this value *instead of* calling the operation would be
trusting a read to authorize a write.

The pgTAP suite states this as a test: a Sales Staff member reads `ACTIVE` from the diagnostic
and is **still** refused the Owner's write.

### Why it is separate from `get_my_portal_context()`

`get_my_portal_context()` decides **routing**, and its contract (`context_version` 1,
`portal_kind`, `vendor`, `retailer`, `capabilities`) is consumed by shipped clients. This one
explains **denial**. Merging them would have meant editing a live read contract to carry a
field only the error path uses, and would have forced every application boot to pay for a
computation only a refusal needs.

`get_my_portal_context()` is **not modified** by this milestone: same zero-argument signature,
same `jsonb` return, same `STABLE`/`SECURITY DEFINER` posture, still `context_version` 1, and
still the same generic-denial behaviour. Portal routing does not change.

The two answers are deliberately independent: the portal says `NONE` for both an inactive
profile and a Vendor-only user; the diagnostic distinguishes them. **That difference is the
milestone.**

---

## 7. Table posture

Unchanged in every respect.

- `organization_members` — RLS enabled, its one installed **read** policy, `SELECT` only for
  the browser. **No** `INSERT`/`UPDATE`/`DELETE` privilege and **no** write policy was added.
  This RPC is the only way a browser session can change a staff membership status.
- `retailer_shop_members` — RLS enabled, zero policies, no browser privilege of any kind.
- `member_roles`, `profiles`, `organizations`, `audit_logs` — `SELECT`-only for the browser,
  exactly as installed.
- No direct `authenticated` table-write privilege was granted anywhere, and no
  browser-write RLS policy was added.

---

## 8. Tests

| Suite | Count | Run with |
| --- | --- | --- |
| `supabase/tests/database/retailer_staff_membership_lifecycle_test.sql` | 252 | `npx supabase test db` |
| `lib/staff/staff-membership-lifecycle-contract.test.ts` | 65 | `npm test` |

The pgTAP suite covers both signatures and grants at catalogue level, the full caller and
target refusal matrix, disclosure uniformity (same SQLSTATE **and** same message across seven
refusal causes), idempotency in both directions, the audit row and its exact key set,
preservation of roles / live and retired Shop assignments / profile / `auth.users` / receipts /
invitations, direct-table-write denial, **atomicity under an injected post-UPDATE failure**,
the existing-session receipt block and its restoration, and every word of the `access_state`
vocabulary walked as the person it describes.

---

## 9. Future consumption

### Web

The write is ready for a Server Action wrapper on `/retailer/staff`. The client needs only the
`membership_id` it already has from `list_retailer_staff_members()`. Map the SQLSTATEs as § 5
describes and never surface the database message. Use `status_changed` to distinguish "saved"
from "already in that state".

The diagnostic belongs on the **refusal** path only — after an operation or a page guard has
already denied access — to choose the sentence shown. It must not gate navigation.

### Flutter

Both functions are **Classification A**: callable directly from the Supabase Dart SDK against
the same project. No text input, no secret, no service-role step, no recipient identity —
nothing an Edge Function would add. Flutter's most valuable use of the diagnostic is the
sign-in path, where a person whose membership was deactivated currently gets a working login
followed by an empty, unexplained app.

---

## 10. Known limitations and what comes next

1. **`55000` has no behavioural coverage yet**, and cannot until the Vendor-side Retailer
   lifecycle write exists. See § 5.
2. **A deactivated Owner cannot be reactivated by anyone inside the tenant** — and neither can
   a deactivated Owner act, since the resolver requires an ACTIVE membership. Owners are
   entirely out of scope here by design; the Vendor milestone owns them.
3. **`SUSPENDED` memberships have no owner.** Nothing in this milestone can set or clear the
   state.
4. **No bulk operation.** One membership per call, deliberately: the Owner exclusion, the self
   exclusion and the eligible role set are per-target rules, and a bulk variant would be a
   second place to state each of them.

### The Vendor Retailer lifecycle is a LATER MILESTONE

Deactivating a whole Retailer organization — and the permission and RPC that would do it — is
**explicitly not begun here**. This migration only *reads* `organizations.status`, and only to
refuse (`55000`) or to describe (`ORGANIZATION_INACTIVE`). No Vendor-side Retailer status
permission or write RPC was created.
