# Vendor → Retailer Lifecycle — backend audit and contract

**Milestone:** Vendor Super Admin can deactivate and reactivate a connected Retailer.
**Migration:** `supabase/migrations/20260811090000_vendor_retailer_lifecycle.sql`
**Scope:** backend contract, permission, tests and documentation **only**. No Web UI, no
Server Action, no React component, no Flutter code, no Edge Function change, no hosted
deployment.

Companion documents: [`mobile-backend-contract.md`](./mobile-backend-contract.md) § V-20 and
[`mobile-feature-matrix.md`](./mobile-feature-matrix.md).
Predecessor: [`retailer-staff-membership-lifecycle-audit.md`](./retailer-staff-membership-lifecycle-audit.md),
whose closing note named this milestone as the one still missing.

---

## 1. The gap this closes

`20260810090000` gave a **Retailer Owner** the power to stand **one staff member** down. It
deliberately refused every `RETAILER_OWNER` target, and said why: an Owner is the tenant's root
of authority, so deactivating one from inside the tenant can strand a Retailer with nobody able
to reactivate anybody. Owner-level and Retailer-level lifecycle needed an actor **outside** the
tenant.

Until this milestone the Vendor had no such operation at all. The alternatives were each wrong
in a different way:

| Alternative | Why it fails |
| --- | --- |
| Revoke outstanding invitations | Does nothing to Owners and staff who already accepted |
| Deactivate the Owner's membership | Unreachable (the staff RPC refuses Owner targets) **and** insufficient — the Manager and every Sales Staff member keep working |
| Set `vendor_retailers.status = 'SUSPENDED'` by hand | **Blocks nobody on the Retailer side.** See § 2 |
| Delete rows | Destroys receipt history, Shop history, invitation history and the audit trail |

---

## 2. Why BOTH lifecycle rows must move together

A suspended Retailer is expressed by **two** rows, and both are required.

```
public.vendor_retailers.status      ACTIVE <-> SUSPENDED     (the Vendor-side fact)
public.organizations.status         ACTIVE <-> SUSPENDED     (the Retailer organization)
```

### `vendor_retailers.status` alone is not enough

The relationship row is a **Vendor-side** fact. It gates the Vendor's own writes —
`add_vendor_retailer_shop`, `reserve_retailer_owner_invitation` and
`assign_vendor_product_to_retailer` all require `vr.status = 'ACTIVE'` — but **nothing on the
Retailer side consults it**.

`resolve_retailer_owner_organization` and `resolve_retailer_member_organization`, the two
resolvers every Retailer Owner, Manager and Sales Staff request passes through, join
`profiles`, `organization_members`, `organizations`, `member_roles`, `roles` and
`role_permissions` — and never touch `vendor_retailers`. Neither does
`accept_retailer_staff_invitation`, nor `retailer_staff_invitation_gate`, nor the receipt path.

A Vendor that wrote only the relationship row would have "suspended" a Retailer whose entire
staff carried on submitting receipts.

### `organizations.status` **is** the block

Every one of those resolvers already requires `o.status = 'ACTIVE'`. Flipping this single
column refuses every Retailer Owner, Manager and Sales Staff request — **including requests
carrying an already-issued, still-valid session, on their very next call**. The membership and
organization rows are the authority, not the JWT; nobody has to be signed out and nothing has
to expire.

### The relationship row still has to move with it

Otherwise a Vendor could keep building out a Retailer it had just switched off — new Shops, new
Owner invitations, new product assignments into an organization nobody can sign in to.

### So both are written atomically

One transaction, each `UPDATE` carrying a compare-and-set predicate against the value read under
its own `FOR UPDATE` lock, each row count checked. Any drift aborts the whole thing. **There is
no ordering in which a caller observes one row moved and the other not.** See § 7.

---

## 3. `ACTIVE` ↔ `SUSPENDED`, and why the UI says *Inactive*

Both columns already permit `ACTIVE` / `SUSPENDED` / `DEACTIVATED`. This function owns exactly
two of those three words.

| Stored value | Meaning | Written here? |
| --- | --- | --- |
| `ACTIVE` | Trading normally | ✅ |
| `SUSPENDED` | Paused by the Vendor, expected to resume | ✅ |
| `DEACTIVATED` | Permanently ended, retained for history | ❌ never set, never cleared |

`DEACTIVATED` is **not requestable** (`23514`) and a current row already holding it is
**refused** (`55000`). A function that could write it would be inventing an offboarding
decision nobody has made; a function that could clear it would be quietly resurrecting a
relationship somebody ended deliberately.

### User-facing terminology is deliberately different from the stored value

Clients (Web first, Flutter later) will say **Deactivate / Inactive / Reactivate**, because
"suspend" reads as an accusation to a Retailer who is simply paused between contracts. The
stored word stays `SUSPENDED` because it is the word both `CHECK` constraints, every existing
status filter and every existing audit row already use — and because `DEACTIVATED` already
means something else, and stronger, in this schema.

The mapping is one-to-one and belongs in the client:

```
stored SUSPENDED  <->  shown "Inactive"    (verb: "Deactivate")
stored ACTIVE     <->  shown "Active"      (verb: "Reactivate")
```

A client must **not** send the word `INACTIVE`. It is not a stored value and is rejected with
`23514`.

---

## 4. What is preserved, and why nothing is cascaded

### Memberships are not cascaded

`SUSPENDED` is **not** pushed down into `organization_members`. Not one membership row is
touched.

* `organization_members.status` is the **Retailer Owner's** instrument. `20260810090000` gave
  the Owner deactivate/reactivate over their own Manager and Sales Staff, and each of those rows
  records a decision **the Owner made**. Overwriting them from the Vendor side would destroy
  that record, and reactivation would then have to *guess* which staff were deactivated by the
  Owner before the suspension and which by the suspension itself. No column could tell them
  apart afterwards.
* It is also **unnecessary**. The `organizations` row alone blocks every Retailer request. A
  cascade would add a second authority that can disagree with the first, in exchange for
  nothing.

### `auth.users` is never touched

No ban, no delete, no update, no metadata write. The reasoning is `20260810090000`'s, and is
stronger here because this operation is Retailer-*wide*:

1. `auth.users` is **global**. A person may be Sales Staff here and an Owner elsewhere; banning
   their Auth row would apply one Vendor's decision about one tenant everywhere.
2. It is not this schema's authorization model. The membership/organization rows decide every
   protected request.
3. It is unrecoverable in practice — and this operation is explicitly expected to be reversed.
4. `auth` is not ours to write. No function in this schema writes `auth.users`.

**The consequence a client must understand:** everyone at a suspended Retailer **can still sign
in**. They simply have no Retailer context.

### The complete preservation list

Deactivation preserves, byte for byte:

* the Retailer `organizations` row (its `status` changes; nothing else does)
* the `vendor_retailers` relationship row
* `profiles`
* `organization_members`, including their own `status` and `deactivated_at`
* `member_roles`
* `retailer_shops`
* `retailer_shop_members` — **live rows stay live, retired rows stay retired**
* `vendor_products` and `vendor_product_retailer_assignments`
* `receipt_submissions`
* `retailer_staff_invitations`
* `retailer_invitations` (Retailer Owner invitations)
* `audit_logs` history
* Supabase Auth identities

**Reactivation therefore restores access automatically, because nothing was ever removed.** It
is a one-word write, not a rebuild — proven in the pgTAP suite by comparing **primary keys**
before, during and after, so a row that had been deleted and re-inserted would fail the
comparison even though the counts matched.

### Pending invitations

Not one invitation row is read for modification. They keep their status, their token hash and
their expiry.

* **While suspended they are unusable.** `retailer_staff_invitation_gate` and
  `accept_retailer_staff_invitation` both require `o.status = 'ACTIVE'`;
  `accept_retailer_owner_invitation` requires both `vr.status = 'ACTIVE'` **and**
  `o.status = 'ACTIVE'`.
* **After reactivation any invitation that has not meanwhile expired simply works again.**

Revoking them on the way down would be irreversible (there is no un-revoke), would send mail to
nobody, and would destroy the Owner's outstanding hiring decisions on the Vendor's authority.

---

## 5. Existing sessions, and the diagnostic that already explains this

Nothing signs anybody out. A Retailer user holding a valid JWT is refused on their **very next
protected request**, because every RPC re-derives authorization from `auth.uid()` server-side.

**No diagnostic change was required.** `get_my_lifecycle_access_state()` — added by
`20260810090000` and **not modified here** — already returns the right word for this state:

```
ORGANIZATION_INACTIVE
```

That value was written for this milestone before this milestone existed. Its precedence rule
(organization before membership) was chosen for exactly this case: telling a Sales Staff member
"your membership was deactivated" when their whole Retailer is suspended would send them to an
Owner who is themselves locked out.

`get_my_portal_context()` is likewise **unchanged**: it reports `portal_kind = 'NONE'` and a
null `retailer` block, keeping `context_version` 1 and its generic-denial behaviour.

⚠️ The diagnostic remains a **diagnostic, never an authorization gate**. Call it on the
*refusal* path to choose a sentence; never instead of calling the operation.

---

## 6. The contract

### Permission

| Field | Value |
| --- | --- |
| Code | `RETAILERS_MANAGE` |
| Name | Manage Retailer Lifecycle |
| Description | Deactivate and reactivate a connected Retailer. |
| Module | `RETAILERS` |
| Mapped to | `VENDOR_SUPER_ADMIN` — **and no other role** |

`RETAILERS_READ` is **not** reused: it is consumed verbatim by three RLS `SELECT` policies, and
widening it would silently turn every holder of a read permission into someone who can switch a
Retailer off. `RETAILERS_CREATE` is not reused either: onboarding a new Retailer and suspending
an existing one are different decisions with different blast radii.

No Retailer-side role may ever hold `RETAILERS_MANAGE` — that would let a tenant suspend or
un-suspend itself, which is the one thing a Vendor-side control exists to prevent.

### RPC

```sql
public.set_vendor_retailer_status(
  p_relationship_id uuid,
  p_status          text          -- 'ACTIVE' | 'SUSPENDED', case-sensitive
)
returns table (
  relationship_id     uuid,
  retailer_status     text,       -- the committed organizations.status
  relationship_status text,       -- the committed vendor_retailers.status
  status_changed      boolean     -- false on an idempotent no-op
)
```

`LANGUAGE plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `SET search_path = ''`, every object
fully qualified. Ordinary authenticated caller; **no service-role dependency and no
service-role grant**.

Grants: `REVOKE ALL … FROM public`, `REVOKE EXECUTE … FROM anon`,
`GRANT EXECUTE … TO authenticated`.

### The canonical identifier is the relationship id

`vendor_retailers.id`, and nothing else.

* It is already in the Vendor's read contract (`list_vendor_retailers.relationship_id`) and is
  what `add_vendor_retailer_shop` and `reserve_retailer_owner_invitation` already accept, so
  this introduces no new address space and no new disclosure.
* `vendor_retailers` is `UNIQUE (vendor_organization_id, retailer_organization_id)`, so a
  relationship id names exactly one Retailer **as seen by exactly one Vendor** — which is what
  makes the single `vr.vendor_organization_id = <derived Vendor>` predicate a complete
  cross-tenant boundary.
* A **Retailer organization id could not do this**: the schema permits several Vendors to manage
  one Retailer, so an organization id does not identify whose relationship is meant.

### Authorization

1. `auth.uid()` must be present.
2. The acting Vendor is derived internally through `get_vendor_super_admin_context()` —
   the established chain (ACTIVE profile, ACTIVE membership, ACTIVE `VENDOR` organization,
   ACTIVE `VENDOR_SUPER_ADMIN` role), with `order by organization_id limit 1` as the
   deterministic tie-break every other Vendor write uses.
3. `has_organization_permission(<derived Vendor>, 'RETAILERS_MANAGE')` must hold.

**There is no role-name check in the executable write path.** The permission is the gate and
the `role_permissions` mapping is the authority, so a future mapping change moves behaviour
without editing this function.

### Idempotency

If both rows already equal the requested status: **no `UPDATE`, no audit row, no `updated_at`
movement**, and `status_changed = false` with the current values returned. A double-tap cannot
destroy the record of when the Retailer was actually suspended.

---

## 7. Locking, concurrency and atomicity

One deterministic lock order, used everywhere in the function:

1. the verified `vendor_retailers` relationship row, `FOR UPDATE`;
2. the corresponding `organizations` row, `FOR UPDATE`.

Two concurrent callers therefore queue at the **same first row in the same order** and
serialize, rather than each holding half of what the other needs. Reversing this order in a
future edit is the one change that turns two safe concurrent callers into a deadlock, and both
test suites assert the order explicitly.

After **both** rows are locked, in this order:

1. validate `organization_type = 'RETAILER'`;
2. validate the multi-Vendor guard;
3. validate the current lifecycle pair;
4. perform the transition.

The transition is: compare-and-set `vendor_retailers.status` → verify exactly one row changed →
compare-and-set `organizations.status` → verify exactly one row changed → write **exactly one**
audit row. All in one PostgreSQL transaction. If any later step fails, every earlier one rolls
back with it — proven in pgTAP by injecting both failures that can reach that path (a suppressed
second `UPDATE`, and a blocked audit `INSERT`).

Unexpected row-count drift is `55000` with the generic lifecycle message, **not** `42501`. The
caller's authorization was established and has not changed; reporting an internal consistency
failure as an authorization denial would send an operator to audit permissions for a problem
that is not there.

### Valid current pairs

Only these two:

```
relationship ACTIVE     + organization ACTIVE
relationship SUSPENDED  + organization SUSPENDED
```

Anything else — a mismatch in either direction, `DEACTIVATED` on either row, or any other
unexpected state — is refused with `55000`. **Mismatched rows are never silently reconciled.**
Quietly "repairing" them would overwrite whatever the other writer intended and erase the only
evidence that a second writer exists; repairing them is a deliberate, investigated operation,
not a side effect of a button press.

---

## 8. The multi-Vendor safety guard

Before any transition, in **both** directions, the function refuses if another relationship
exists for the same Retailer where:

```
retailer_organization_id = <the target Retailer>
vendor_organization_id  <> <the derived acting Vendor>
status                  <> 'DEACTIVATED'
```

### Why

The schema permits several Vendors to manage one Retailer. But the block this function performs
is **tenant-wide**: `organizations.status` is a single column on a single row shared by every
Vendor that manages that Retailer. If two Vendors both had live relationships, either could
switch the Retailer off underneath the other, and the second Vendor's reactivation would
silently override the first Vendor's suspension. Neither would ever see the other in any read
contract they hold.

Rather than pick a winner, the operation refuses.

A **`DEACTIVATED`** foreign relationship does **not** block: a relationship that has ended is
retained for history only, and must not freeze an ordinary single-Vendor Retailer forever.

### The refusal discloses nothing

It is an `EXISTS` test — never a count, never an id — and it raises the **same `55000` with the
same generic message** as an inconsistent current pair. A caller cannot learn from it that
another Vendor exists, which Vendor it is, how many there are, what state their relationship is
in, **or even that the reason is multi-Vendor at all**. That matters: the other Vendor's
identity is another tenant's data, and this caller holds no read contract that would ever show
it to them.

### ⚠️ This is a stopgap, not a multi-Vendor architecture

The guard is the **safe** answer, not a good one: it makes the operation unavailable to both
Vendors rather than letting either act on a shared row. It is correct today because no shipped
flow creates a second live relationship — the Vendor Admin is single-tenant by design and
`onboard_vendor_retailer` only ever creates the acting Vendor's own row — so the guard is
expected never to fire in production.

**Before this product supports more than one active Vendor relationship per Retailer, tenant
blocking must be redesigned.** Extending this function is not enough and must not be attempted.
The problem is that "is this Retailer blocked?" is currently a **single shared column**, so it
cannot express "blocked by Vendor A but not by Vendor B". A real design has to:

1. decide what a Retailer's staff may do when one of several Vendors has suspended them (it is
   not obviously all-or-nothing);
2. move the block to something **per-relationship** that every Retailer-side resolver consults.

That is a change to the resolvers, the receipt path and the invitation path — **not** to this
file. Until it is done, the guard is the honest boundary of what this operation can promise.

---

## 9. SQLSTATE taxonomy

| SQLSTATE | Meaning | Client-visible message |
| --- | --- | --- |
| `42501` | Unauthenticated; lacks `RETAILERS_MANAGE`; null, unknown, foreign or cross-Vendor target; wrong organization type | `Not authorized to change this Retailer's status` — **one identical literal for all seven paths** |
| `23514` | The requested status is not exactly `ACTIVE` or `SUSPENDED` (includes `null`, `''`, lowercase, `DEACTIVATED`, `INVITED`, `INACTIVE`) | `That Retailer status is not valid` |
| `55000` | Inconsistent current pair; either row `DEACTIVATED`; another non-`DEACTIVATED` Vendor relationship exists; compare-and-set row-count drift | `This Retailer cannot be changed right now` — **one identical literal for all four causes** |
| `22P02` | Malformed UUID — PostgreSQL rejects it while parsing the argument, before the body runs | PostgreSQL's own |

**The `42501` class is deliberately indistinguishable.** "That relationship does not exist",
"it exists but is not yours", "you are not signed in" and "you lack the permission" all read
alike, so a caller cannot sweep relationship ids to learn which exist or how many there are.

**The `55000` causes are deliberately indistinguishable too.** A client should render them as
*"this Retailer cannot be changed right now — contact support"* and nothing more specific.

Validation order is **authorization → requested status → target → locks → guards → transition**,
so an unauthorized caller sending nonsense receives `42501`, never `23514`. Bad input is not an
oracle.

---

## 10. Audit

Written **only** for a real transition — never for an idempotent no-op.

| Field | Value |
| --- | --- |
| `action` | `RETAILER_DEACTIVATED` (→ `SUSPENDED`) / `RETAILER_REACTIVATED` (→ `ACTIVE`) |
| `entity_type` | `RETAILER_ORGANIZATION` |
| `entity_id` | the **Retailer organization** id, as text |
| `organization_id` | the **acting Vendor** organization |
| `actor_profile_id` | `auth.uid()` |

The action names the **direction in the product's words**, not the column's, so an operator
reading the trail sees the decision that was made. `organization_id` is the Vendor's, so the
entry lands in the Vendor's own feed and is readable through `list_vendor_audit_logs` — and is
therefore **invisible to the Retailer**, which is correct for a Vendor decision about a
Retailer.

`metadata` carries **exactly six keys**, every one a value the function proved:

```
retailer_name
relationship_id
retailer_status_before
retailer_status_after
relationship_status_before
relationship_status_after
```

Deliberately absent: every email address, Auth user id, profile id (the actor is
`actor_profile_id` and the target is `entity_id` — neither belongs in free-form metadata),
invitation id, Shop id, product id, receipt id, **other Vendor id**, other relationship id,
relationship count, token, hash, provider message, raw database message and client-supplied
value.

Two audit vocabulary entries are added. Neither needs a catalogue row: `audit_logs.action` and
`.entity_type` are free text with only a not-empty check.

---

## 11. Grants and table posture

* Function: `PUBLIC` and `anon` revoked, `authenticated` granted, **`service_role` granted
  nothing** — the whole authority of this function is `auth.uid()`, which a service-role
  connection does not have.
* **No** `authenticated` `UPDATE` on `organizations`.
* **No** `authenticated` `UPDATE` on `vendor_retailers`.
* **No** browser-write RLS policy, and no `INSERT`/`UPDATE`/`DELETE` policy on either table.
  Both keep read-only policies and nothing else.
* **No** `DELETE` anywhere on this path.

**Existing Vendor reads remain available for inactive Retailers.** `list_vendor_retailers`,
`get_vendor_retailer_detail` and `list_vendor_retailer_shops` deliberately do not filter on
status, so a suspended Retailer stays visible — and therefore stays reactivatable — from
exactly the listing a Vendor already has. Nothing here narrows them.

### One contract that deliberately did NOT change

`unassign_vendor_product_from_retailer` requires the relationship to **exist** but explicitly
**not** to be `ACTIVE` ("The relationship must exist … but it need not be ACTIVE"), because
withdrawing something is a de-escalation. This milestone did not change that, and the pgTAP
suite asserts that withdrawal still works while a Retailer is suspended — recorded as a
contract rather than left to look like an oversight. Product **assignment** is blocked, as its
own contract already required.

---

## 12. What is downstream-blocked while a Retailer is suspended

All verified behaviourally, by callers holding the sessions they held **before** the suspension:

| Caller | Operation | Result |
| --- | --- | --- |
| Retailer Owner | `get_my_portal_context()` | `portal_kind = 'NONE'`, null `retailer` |
| Retailer Owner | `list_retailer_staff_members()` | `42501` |
| Retailer Owner | `list_retailer_owner_portal_shops()` | zero rows |
| Retailer Manager | `list_retailer_staff_members()` | `42501` |
| Sales Staff | `list_my_assigned_receipt_shops()` | `42501` |
| Sales Staff | `reserve_receipt_submission(…)` | `42501` |
| Sales Staff | `list_my_receipt_submissions()` | `42501` |
| Owner / Manager / Staff | `get_my_lifecycle_access_state()` | `ORGANIZATION_INACTIVE` |
| Retailer Owner | `reserve_retailer_staff_invitation(…)` | `42501` |
| Invitee | `retailer_staff_invitation_gate(…)` | `23514` |
| Invitee | `accept_retailer_staff_invitation(…)` | `42501` |
| Vendor | `reserve_retailer_owner_invitation(…)` | `55000` |
| Invitee | `accept_retailer_owner_invitation()` | `42501` |
| Vendor | `add_vendor_retailer_shop(…)` | `23514` |
| Vendor | `assign_vendor_product_to_retailer(…)` | `42501` |
| Vendor | `unassign_vendor_product_from_retailer(…)` | **still permitted** — see § 11 |

**No receipt Edge Function change was required.** The Edge Function fronts
`reserve_receipt_submission` / `finalize_receipt_submission_upload`, both of which resolve the
Retailer through `resolve_retailer_member_organization` and therefore already refuse a
suspended organization. No portal-context, diagnostic, access-denied, invitation or read
contract change was required either, for the same reason: they all already consult
`organizations.status`.

---

## 13. Tests

| Suite | Location | Assertions |
| --- | --- | --- |
| pgTAP (behavioural) | `supabase/tests/database/vendor_retailer_lifecycle_test.sql` | 292 |
| Node (static contract) | `lib/retailers/vendor-retailer-lifecycle-contract.test.ts` | 65 |

The pgTAP suite runs in one transaction and is rolled back. It signs in as eight different
callers by setting `request.jwt.claims` transaction-locally, which is what makes the
"already-issued session" assertions meaningful — nothing about the session is re-established
between the pre-suspension and post-suspension calls.

### One limitation, stated where it is relevant

`pg_prove` runs each file in **one session inside one transaction**, so it cannot open a second
connection and watch it block. **True cross-session serialization is therefore not directly
observable**, and the suite does not pretend otherwise. It proves the two things that are
observable and that together are what serialization is made of:

* the relationship row is genuinely row-locked by the calling transaction afterwards (asserted
  from the tuple header);
* the installed body takes `FOR UPDATE` — not `FOR SHARE`, not nothing — on **both** rows, in
  one fixed order.

The `organizations` tuple is deliberately **not** asserted on this way, and the reason is worth
recording: the relationship's own foreign key already takes a `KEY SHARE` row lock on the
referenced organization when the relationship is inserted, so its `xmax` is non-zero before this
function is ever called and cannot distinguish the two locks. The organization `FOR UPDATE` is
asserted from the installed function body instead, which is exact.

---

## 14. Later milestones

* **Vendor Web UI** — the Retailers list and detail page gain a Deactivate / Reactivate control
  using the *Inactive* vocabulary from § 3. **Not begun here:** this milestone adds no Server
  Action, component, route or client call site of any kind, and the Node suite asserts that no
  Web call site exists yet.
* **Flutter** — out of scope entirely. No Flutter file exists anywhere in the repository.
* **Multi-Vendor tenant blocking** — see § 8. A hard prerequisite before any second active
  Vendor relationship is permitted.
