# Post-acceptance Shop management for existing Retailer Sales Staff — backend audit

**Status:** ~~audit only~~ → **AUDIT COMPLETE AND IMPLEMENTED.** The audit below is preserved verbatim as the record of what was found and why; §0 states what was built and where the decisions landed.
**Scope:** changing the assigned Shops of an **already-accepted, active Sales Staff member**. Nothing else.

---

## 0. Implementation outcome

The audit's recommendations were accepted with the five open questions decided as follows.

| Item | Decision | Where |
| --- | --- | --- |
| Migration | `supabase/migrations/20260809090000_retailer_staff_shop_assignment_management.sql` — **one function, nothing else** | §16 |
| RPC | `public.set_retailer_staff_shop_assignments(p_membership_id uuid, p_shop_ids uuid[])` → `(shops_added integer, shops_removed integer, shops_unchanged integer)` | §11, §12 |
| Permission | `RETAILER_STAFF_SHOP_ASSIGN`, **existing**; no new permission, role or mapping | §7 |
| **O-1** zero shops | **Rejected** (`23514`). An active Sales Staff member keeps ≥1 requested ACTIVE shop. No "stand down" operation in this milestone. | §8.4 |
| **O-2** duplicates | **Canonicalized**, matching `reserve_retailer_staff_invitation`. `[A,A,B]` ≡ `[A,B]`. A `NULL` *element* is still `23514`. | §10.6 |
| **O-3** concurrency | **No** client versions/ETags/timestamps. `FOR UPDATE` on the membership + ascending-UUID `FOR SHARE` on shops. Last write wins. | §15 |
| **O-4** name | `set_retailer_staff_shop_assignments` (rank 1) | §11 |
| **O-5** return | The three counts (rank 1) | §10.5 |
| **R-1** hidden shops | **Replacement scoped to the ACTIVE-shop projection.** Live assignments to non-ACTIVE shops are preserved and counted in none of the three totals. | §10.3 |
| Read contracts | **Unchanged.** No new read RPC. `list_retailer_staff_members()` already returns the canonical `membership_id` the write accepts — asserted in both suites. | §9 |
| Tests | `supabase/tests/database/retailer_staff_shop_assignment_writes_test.sql` (163 assertions), `lib/staff/staff-shop-assignment-contract.test.ts` (33) | §17 |
| Docs | `docs/mobile-backend-contract.md` **RO-10**, `docs/mobile-feature-matrix.md` Retailer Owner row | §18, §19 |

**THIS MILESTONE SHIPS NO UI.** There is no web page, no Server Action, no Flutter screen,
and no client wrapper module. The RPC is reachable only by a direct authenticated call.
Web and Flutter integration are specified in §18/§19 and are deliberately *not* built.

---

## 1. Repository state

| Item | Value |
| --- | --- |
| Branch | `main` |
| HEAD | `cb5c301` (Merge PR #39 — retailer staff invitation delivery) |
| Working tree | clean (`git status --short` empty) |
| `git pull --ff-only origin main` | already up to date |
| Migrations on disk | 42, `20260716124419` … `20260808090000` |
| Branch created for this audit | none |

Verified with `git fetch origin && git switch main && git pull --ff-only origin main && git status --short && git --no-pager log --oneline -8`.

---

## 2. Relevant schema and migration locations

| Concern | File | Where |
| --- | --- | --- |
| `organizations`, `profiles`, `organization_members`, `set_updated_at()` | `20260716124419_core_identity_tables.sql` | whole file |
| `roles`, `permissions`, `role_permissions`, `member_roles` | `20260716125559_vendor_admin_rbac.sql` | whole file |
| `audit_logs` | `20260716130351_vendor_admin_audit_logs.sql` | whole file |
| `has_organization_permission(uuid, text)` | `20260716131104_vendor_admin_authorization_helpers.sql` | L105–135 |
| `retailer_shops` (+ `retailer_shops_status_allowed`) | `20260717094520_retailer_core_tables.sql` | L323–328 |
| **`retailer_shop_members`**, its indexes, tenant trigger, RLS | `20260722210000_retailer_staff_role_permission_shop_assignment_foundation.sql` | Parts D–G, L311–517 |
| Staff roles + the three `RETAILER_STAFF_*` permissions + mappings | same file | Parts A–C, L85–297 |
| **`resolve_retailer_member_organization(text)`** | `20260723090000_retailer_staff_invitation_storage_foundation.sql` | §14, L595–632 |
| `reserve_retailer_staff_invitation`, `revoke_…`, `list_retailer_staff_invitations` | `20260723210000_retailer_staff_invitation_owner_operations.sql` | whole file |
| **`accept_retailer_staff_invitation(text)`**, **`list_retailer_staff_members()`** | `20260724210000_retailer_staff_invitation_acceptance.sql` | L~300–678, L735–819 |
| **`list_retailer_staff_assignable_shops()`** | `20260725090000_retailer_staff_assignable_shops.sql` | L80–121 |
| Receipt eligibility consuming live assignments | `20260726210000_receipt_submission_operations.sql` | L~100–120, L~240–260 |
| Portal capability flags (`view_staff`, `assign_staff_shops`) | `20260729090000_shared_portal_context.sql` | L172–174, L401 |
| Vendor audit reads (tenant scoping + metadata whitelist) | `20260804090000_mobile_vendor_audit_log_reads.sql` | L165–176, L512–540 |

Application layer:

| Concern | File |
| --- | --- |
| Server-only read wrappers for the three staff RPCs | `lib/staff/retailer-staff-data.ts` |
| Runtime shape validation / camelCase mapping | `lib/staff/staff-normalization.ts` |
| Staff page (roster + invite form) | `app/(retailer)/retailer/staff/page.tsx` |
| Invite Server Action + shop-id re-validation | `app/(retailer)/retailer/staff/actions.ts`, `lib/staff/staff-invite-input.ts` |

---

## 3. Existing assignment lifecycle

### 3.1 `public.retailer_shop_members` — exact shape

```
id                     uuid        PK  default gen_random_uuid()
organization_member_id uuid        NOT NULL  -> organization_members(id)  ON DELETE CASCADE
retailer_shop_id       uuid        NOT NULL  -> retailer_shops(id)        ON DELETE RESTRICT
assigned_by            uuid        NULL      -> profiles(id)              ON DELETE SET NULL
assigned_at            timestamptz NOT NULL  default now()
removed_at             timestamptz NULL          -- NULL = live, timestamp = retired
created_at             timestamptz NOT NULL  default now()
updated_at             timestamptz NOT NULL  default now()
```

There is **no `status` column and no `organization_id` column**. Tenancy is derived through the member and the shop, and enforced by trigger.

**Indexes**

- `retailer_shop_members_live_unique_idx` — **UNIQUE** `(organization_member_id, retailer_shop_id)` **WHERE `removed_at IS NULL`**
- `retailer_shop_members_member_active_idx` — `(organization_member_id)` WHERE `removed_at IS NULL`
- `retailer_shop_members_shop_active_idx` — `(retailer_shop_id)` WHERE `removed_at IS NULL`

**Triggers**

- `retailer_shop_members_assert_same_retailer_on_insert` — BEFORE INSERT
- `retailer_shop_members_assert_same_retailer_on_update` — BEFORE UPDATE **OF** `organization_member_id, retailer_shop_id`, with a `WHEN` clause that fires only if one actually changes. **An ordinary `removed_at` write performs no extra lookups and cannot be blocked by it.**
- `set_updated_at_on_retailer_shop_members` — BEFORE UPDATE

`public.retailer_shop_members_assert_same_retailer()` is SECURITY DEFINER, `search_path = ''`, and raises:
- `foreign_key_violation` — referenced member or shop does not exist;
- `check_violation` — *"Staff member and shop must belong to the same Retailer"*.

It deliberately does **not** check membership lifecycle, shop lifecycle, or any minimum-shop rule — those are stated as policy for the assignment RPCs, where the full multi-row final state is visible.

**RLS / privileges**

`ALTER TABLE … ENABLE ROW LEVEL SECURITY` with **zero policies** (default-deny), plus `REVOKE ALL` from `public`, `anon`, `authenticated`. `postgres` and `service_role` are untouched (`service_role` additionally has `BYPASSRLS`). The browser cannot read or write one byte of this table by any route; the only path is a SECURITY DEFINER RPC.

### 3.2 Answers to the schema questions

| # | Question | Finding |
| --- | --- | --- |
| 1 | Columns/keys/constraints | As above. Three FKs, three indexes, three triggers, no status column. |
| 2 | Removal pattern | **Soft: `removed_at = now()`.** Not a hard delete, not a status update, not an active flag, not an effective-date range. The header states rows are *"RETIRED BY `removed_at` AND NEVER DELETED in normal operation"*. |
| 3 | Duplicate active assignments prevented? | **Yes** — by `retailer_shop_members_live_unique_idx`. Any number of *retired* rows for the same pair may coexist. Duplicates **within an input array** are not prevented by anything in the DB and must be handled by the RPC. |
| 4 | Inactive historical assignments retained? | **Yes.** Never deleted; `ON DELETE RESTRICT` on the shop FK means a shop with assignment history cannot be hard-deleted and must be deactivated instead. |
| 5 | Which function creates assignments at acceptance | `public.accept_retailer_staff_invitation(text)`, step 7 — a single `INSERT … SELECT` over the invitation's immutable `retailer_invitation_shop_assignments` rows, with `assigned_by = invitation.invited_by_profile_id`. |
| 6 | Acceptance retried | **Not idempotent-success.** A second call is refused generically (`42501`): step 2 rejects any existing membership of that Retailer in any status, and the finalizing `UPDATE … WHERE status = 'PENDING'` would affect zero rows. Nothing partial is written — the whole function is one transaction. |
| 7 | Acceptance requires ≥1 shop? | **Yes for `SALES_STAFF`**, enforced twice: `reserve_retailer_staff_invitation` (`23514`, *"Sales Staff invitations require at least one shop"*) and `accept_retailer_staff_invitation` (`42501`). `RETAILER_MANAGER` must have **exactly zero**. |
| 8 | Can an active Sales Staff membership have zero active shops? | **No database constraint forbids it.** See §8 — it is reachable today only indirectly, via shop deactivation. |
| 9 | Shop status making it assignable | **`ACTIVE` only.** `retailer_shops.status ∈ {ACTIVE, SUSPENDED, DEACTIVATED}`; all three of `list_retailer_staff_assignable_shops`, `reserve_retailer_staff_invitation` and `accept_retailer_staff_invitation` filter on `= 'ACTIVE'`. |
| 10 | Membership status making a member manageable | `organization_members.status ∈ {INVITED, ACTIVE, SUSPENDED, DEACTIVATED}`. Every authorization helper requires `ACTIVE`. The roster shows non-ACTIVE rows to a `RETAILER_STAFF_MANAGE` holder, so the client can *display* a suspended member — but no existing write operates on one. **Recommendation: the write requires `ACTIVE`.** |
| 11 | Do Managers have org-wide access without assignment rows? | **Yes, explicitly.** *"RETAILER_OWNER and RETAILER_MANAGER are retailer-wide by role and receive NO explicit `retailer_shop_members` rows."* `reserve_…` and `accept_…` both refuse a non-zero shop set for `RETAILER_MANAGER`. |
| 12 | Canonical staff target identifier | **`organization_members.id`**, surfaced as `membership_id`. See §6. |

### 3.3 Re-assignment semantics — new row, not un-retire

The table header states: *"Reassignment creates a NEW row, so history is preserved by accumulation rather than by a status enum this edge does not need."*

So the intended pattern for re-adding a previously removed shop is **`INSERT` a fresh row**, not `UPDATE … SET removed_at = NULL`. Un-retiring would erase the fact that the person was ever off that shop, which is exactly the history this design accumulates. The partial unique index permits this: it constrains only live rows.

---

## 4. Existing invitation-acceptance behavior (summary)

`accept_retailer_staff_invitation(p_token text)` is one transaction that: authorizes `auth.uid()`; refuses SUSPENDED/DEACTIVATED profiles and any existing membership of that Retailer; verifies the Retailer is `ACTIVE`/`RETAILER` and the role is `ACTIVE` and in `{RETAILER_MANAGER, SALES_STAFF}`; reads the invitation's immutable shop set and locks each shop `FOR SHARE` in ascending UUID order, requiring each to be `ACTIVE` and same-Retailer (**refuses outright rather than narrowing to survivors**); creates or promotes the profile; inserts exactly one `ACTIVE` membership; inserts exactly one `member_roles` edge; copies the shop set into `retailer_shop_members`; finalizes the invitation in one `UPDATE … WHERE status='PENDING'` with a checked row count; writes exactly one `STAFF_INVITATION_ACCEPTED` audit row.

Two patterns the new write must reuse verbatim:
- **ascending-UUID `FOR SHARE` shop locking** (deadlock avoidance);
- **all-or-nothing shop validation** — never silently drop an invalid shop.

---

## 5. Existing read RPC contracts

### 5.1 `public.list_retailer_staff_members()` — zero args, STABLE, SECURITY DEFINER, `authenticated`

Permission: `RETAILER_STAFF_READ` (Owner **and** Manager). Visibility widens for a `RETAILER_STAFF_MANAGE` holder, who additionally sees non-`ACTIVE` memberships; a `READ`-only Manager sees the `ACTIVE` roster only. Unauthorized ⇒ `42501`, never an empty list.

```
membership_id     uuid          -- organization_members.id
first_name        text
last_name         text
role_code         text          -- RETAILER_OWNER | RETAILER_MANAGER | SALES_STAFF
role_name         text
membership_status text
shop_ids          uuid[]        -- live assignments to ACTIVE, same-Retailer shops
shop_names        text[]        -- positionally aligned with shop_ids
joined_at         timestamptz
created_at        timestamptz
```

One row per `(membership, Retailer role)` edge. Ordered `p.last_name, p.first_name, m.id, r.code`. Deliberately **not** returned: email, auth user id, role UUID, organization id, token/hash, delivery state, audit metadata, any other Retailer's data.

> **⚠ Finding R-1 — `shop_ids` is an ACTIVE-shop *projection*, not the live assignment set.**
> The subqueries filter `sm.removed_at is null` **AND** `s.status = 'ACTIVE'` **AND** `s.retailer_organization_id = v_retailer`. A live assignment to a shop that was later **SUSPENDED or DEACTIVATED** still exists in `retailer_shop_members` but is **invisible** in this contract. This is the single most consequential fact for the write design — see §10.3.

### 5.2 `public.list_retailer_staff_assignable_shops()` — zero args, STABLE, SECURITY DEFINER, `authenticated`

Permission: **`RETAILER_STAFF_SHOP_ASSIGN`** (Owner only under current mappings). Unauthorized ⇒ `42501`.

```
shop_id   uuid
shop_name text
shop_code text
city      text
```

`status = 'ACTIVE'` only, `retailer_organization_id = v_retailer`, ordered `s.name, s.code nulls last, s.id`. Its header records that this is **the only source of shop ids in the application**.

### 5.3 Is a new read RPC required? **No.**

| Requirement | Already satisfied by |
| --- | --- |
| staff display name | `list_retailer_staff_members.first_name/last_name` |
| role | `role_code` / `role_name` |
| membership status | `membership_status` |
| current assigned Shops | `shop_ids` + `shop_names` |
| assignable Shops | `list_retailer_staff_assignable_shops()` |
| canonical target id | `membership_id` |

Both RPCs are **already called on the same page** (`app/(retailer)/retailer/staff/page.tsx` fetches the roster and, for a `SHOP_ASSIGN` holder, the assignable shops for the invite form). A staff-assignment detail RPC would add a third round trip and a second definition of the same projection, for nothing.

### 5.4 Additive-field safety and parser strictness

`lib/staff/staff-normalization.ts` is **strict on the fields it names and tolerant of unknown keys**: it iterates rows, reads named keys off a `Record<string, unknown>`, and returns `{status:"malformed", reason}` when a *required* field is missing or blank. It never enumerates keys and never rejects extras. `normalizeStaffMembers` requires `membership_id`, `first_name`, `last_name`, `role_code`, `membership_status`; everything else degrades to `null`/`[]`.

**Conclusion:** adding a column to either RPC's `RETURNS TABLE` is **safe for the web client**. Two caveats:
1. `PostgREST` returns whatever the function declares — a **removed or renamed** column fails the read closed (by design). Additive only.
2. `STAFF_INVITATION_STATES` is a **closed** set for the *invitation* normalizer; an unrecognized `derived_state` fails the read. Nothing analogous exists on the member normalizer, so member fields are the safer place to extend.

Flutter: `docs/mobile-feature-matrix.md` lists "Assignable shops (for invites)" as shipped/Ready with no Flutter usage yet, and the staff roster is consumed only as an authorization probe in `getRetailerPortalAccess()` (§ mobile-backend-contract L315). **No Flutter parser is currently bound to these column lists.**

**Do not change either existing contract for convenience.** Neither needs to change for this milestone; see §10.3 for the one field worth considering, additively.

---

## 6. Canonical staff target identifier

**Recommendation: `organization_members.id`, exposed as `membership_id` / `membershipId`.**

Reasons, in order of weight:

1. It is **the exact FK target** of `retailer_shop_members.organization_member_id`. Every other candidate requires a lookup that could resolve to the wrong tenant.
2. It is **already in the read contract** and already crosses to the browser (`list_retailer_staff_members.membership_id` → `StaffMember.membershipId`), released only to a holder of `RETAILER_STAFF_READ`. No new disclosure.
3. It is **tenant-scoped by construction**: `organization_members` is `UNIQUE(organization_id, user_id)`, so a membership id names exactly one person *in exactly one organization*. A single `AND m.organization_id = v_retailer` predicate is the complete cross-tenant boundary — the same one-predicate shape `revoke_retailer_staff_invitation` already uses.
4. It is **already the React key** the roster renders against.

Rejected candidates:

| Candidate | Why not |
| --- | --- |
| auth user id | Not in any Retailer-facing read contract. `list_retailer_staff_members` explicitly excludes Auth ids. Introducing one would be a new disclosure and would still need a membership lookup. |
| profile id | Same value as the auth user id (`profiles.id = auth.uid()`), same objections; additionally it is **not tenant-scoped** — one profile may be staff at several Retailers, so it cannot address a membership on its own. |
| organization membership id | ✅ This *is* the recommendation. |
| member-role id | `member_roles.id` is not returned by any read, and the roster emits one row per `(membership, role)` edge — addressing the role edge would make the target ambiguous the day someone holds two roles. |
| email | Not returned by the roster at all (deliberately). Recipient-identity disclosure, mutable, and requires an `auth.users` read inside the definer. |

---

## 7. Authorization findings

### 7.1 The permission already exists — do not invent one

**`RETAILER_STAFF_SHOP_ASSIGN`**, seeded in `20260722210000`:

> *"Assign Retailer Staff to Shops — Add and remove staff-to-shop assignments within one's own Retailer organization."*

That description is a verbatim statement of this milestone. Current mappings:

| Role | `RETAILER_STAFF_READ` | `RETAILER_STAFF_MANAGE` | `RETAILER_STAFF_SHOP_ASSIGN` |
| --- | --- | --- | --- |
| `RETAILER_OWNER` | ✅ | ✅ | ✅ |
| `RETAILER_MANAGER` | ✅ | ✗ | ✗ |
| `SALES_STAFF` | ✗ | ✗ | ✗ |
| Vendor roles | ✗ | ✗ | ✗ |

**No new permission, role, or mapping is needed.** The write gates on `resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN')`, and the mapping — not the function — remains the authority.

### 7.2 The authorization root

`public.resolve_retailer_member_organization(target_permission_code text)` → `uuid | NULL`. It requires, all simultaneously: `auth.uid() IS NOT NULL`; `profiles.status = 'ACTIVE'`; `organization_members.status = 'ACTIVE'`; `organizations.status = 'ACTIVE'`; `organizations.organization_type = 'RETAILER'`; `roles.status = 'ACTIVE'`; the role holds the permission. It returns the id **only when exactly one distinct Retailer qualifies** — zero or two-or-more resolve to `NULL` (fail closed; there is no organization switcher). It is granted to **no browser role** and is reachable only from a SECURITY DEFINER function that owns it.

### 7.3 Verification matrix

| Caller / condition | Behavior under the proposed gate | Mechanism |
| --- | --- | --- |
| Retailer **Owner**, active, single Retailer | **Allowed** | holds `RETAILER_STAFF_SHOP_ASSIGN` |
| Retailer **Manager** | **Denied `42501`** | mapping omits `SHOP_ASSIGN`; already true for `list_retailer_staff_assignable_shops()` — a Manager cannot even obtain a shop id |
| **Sales Staff** | **Denied `42501`** | holds only `RETAILER_PORTAL_READ` — cannot change their own assignments |
| **Vendor** (any Vendor role) | **Denied `42501`** | resolver admits only `organization_type = 'RETAILER'`; no Vendor role holds any `RETAILER_STAFF_*` code |
| **Anonymous** | **Denied `42501`** | `auth.uid()` null → resolver NULL; `anon` also has no `EXECUTE` grant |
| **Cross-Retailer** target (staff or shop of another Retailer) | **Denied `42501` / `23514`**, indistinguishable from "not found" | `AND m.organization_id = v_retailer` on the target; `AND s.retailer_organization_id = v_retailer` on each shop; plus the table trigger as defence in depth |
| **Inactive Retailer** (SUSPENDED/DEACTIVATED org) | Resolver returns NULL → `42501`. Additionally re-verify under `FOR SHARE` and raise `55000` (`object_not_in_prerequisite_state`), matching `reserve_retailer_staff_invitation` | |
| **Inactive caller membership** | **Denied `42501`** | resolver requires `m.status = 'ACTIVE'` |
| **Inactive target membership** | Must be denied by the new function — the resolver constrains the *caller* only. Recommend `42501` | new check |
| **Inactive shop** | Must be denied by the new function — `= 'ACTIVE'` only, matching `reserve`/`accept` | new check |
| **`service_role`** | **No grant recommended.** Every peer read/write in this family grants `service_role` nothing; this write's entire authority is `auth.uid()`, and a service-role path would let assignments be rewritten with no session at all. `service_role` retains `BYPASSRLS` at the table, which is the existing, accepted posture. | |
| **Direct table access under RLS** | **Denied for every browser role.** RLS enabled with zero policies **and** `REVOKE ALL` from `public`/`anon`/`authenticated` on `retailer_shop_members`, `retailer_shops`, `retailer_staff_invitations`, `retailer_invitation_shop_assignments`. `retailer_shops` has exactly one policy and it is Vendor-scoped, so a Retailer Owner selecting it gets zero rows. | |

---

## 8. Zero-Shop business-rule analysis

**Do not silently choose — here is the evidence and a recommendation.**

### 8.1 Current database behavior

- **No constraint of any kind** forbids an `ACTIVE` `SALES_STAFF` membership with zero live `retailer_shop_members` rows. The foundation migration states this explicitly: the minimum-shop rule *"is deliberately NOT enforced by this table — a single-row BEFORE trigger cannot validate a multi-row final state — and belongs to the future staff-invitation/assignment RPCs."*
- The rule is enforced **only at the two invitation choke points** (`reserve` → `23514`, `accept` → `42501`), and only for `SALES_STAFF`.
- Today, **zero *live rows* is unreachable** for an accepted Sales Staff member: acceptance guarantees ≥1, and no other write touches the table.
- However, **zero *effective* shops is already reachable** — deactivate or suspend every shop a member is assigned to. The live rows survive, but `list_retailer_staff_members.shop_ids` returns `{}` and `list_my_assigned_receipt_shops()` returns zero rows. **An unusable-but-active Sales Staff account is therefore already a producible state**, with no operator warning anywhere.

### 8.2 What depends on assignment

`20260726210000_receipt_submission_operations.sql`:
- `list_my_assigned_receipt_shops()` joins `retailer_shop_members … removed_at is null` and `retailer_shops.status = 'ACTIVE'` — a zero-shop member gets an **empty selector**.
- `reserve_receipt_submission(...)` re-verifies the chosen shop against that same live-assignment join and raises `42501` *"Select one of your assigned shops"*.

So receipt submission — the entire Sales Staff product surface — is **hard-gated on live assignment**. A zero-shop Sales Staff member can sign in and see the portal shell (`RETAILER_PORTAL_READ`) and nothing else.

### 8.3 Consequences

**Allowing zero:**
- ✅ Lets an Owner park a member (leave of absence, shop closure) without a deactivate operation — and **deactivation is explicitly out of scope for this milestone**, so refusing zero leaves the Owner with *no* way to express "not currently working anywhere".
- ✅ Simpler contract: the write is a pure set-replacement with no cardinality special case.
- ❌ Creates an active account with no capability and no signal — an ambiguous state indistinguishable from a misconfiguration.
- ❌ Diverges from the invitation path, where zero is refused. Two rules for the same predicate.

**Requiring at least one:**
- ✅ Keeps one rule across invite and update: *an active Sales Staff member always has at least one shop*.
- ✅ Makes "stop this person working" an explicit, auditable decision rather than a side effect of emptying a list.
- ✅ Matches the strictness posture of every existing write in this family (all-or-nothing, never silently narrowed).
- ❌ The Owner's only way to fully unassign is to wait for staff deactivation to ship. This is a **real product gap**, but it is a gap that already exists and that this milestone was explicitly told not to close.
- ❌ Does **not** actually prevent the unusable state, because shop deactivation still empties the effective set (§8.1).

### 8.4 Recommendation

> **Require at least one shop.** Reject an empty requested list for a `SALES_STAFF` target with `23514` and a message in the existing register — e.g. *"Sales Staff must be assigned to at least one shop"*.

Rationale: the rule already exists and is already enforced twice; a third enforcement point makes it an invariant of the system rather than a property of one code path. Allowing zero here would make this milestone the *only* way to produce a state the rest of the system treats as impossible, and would do so without an audit-worthy "this person is stood down" intent — the audit row would read as an ordinary shop change.

Two things this recommendation explicitly does **not** claim:
1. It does not make the invariant true — §8.1 shows shop deactivation already breaks it. Closing that requires either cascading to assignments on shop deactivation or a periodic report, both **out of scope**.
2. It does not remove the product need for "stand this person down". **Open question O-1** (§20): the staff-deactivation milestone should own it, and until then the Owner's workaround is to leave one shop assigned.

---

## 9. Recommended shared read contract

**No new read RPC. Reuse both existing ones, unchanged.**

```
list_retailer_staff_members()           -> current assignments (shop_ids, shop_names)
                                           + display name, role_code, membership_status
list_retailer_staff_assignable_shops()  -> the pickable universe (shop_id, shop_name, shop_code, city)
```

The editor's initial state is `roster.shopIds ∩ assignable.shopId`; the options are `assignable`. Both are already fetched by the staff page for the Owner, so **the read cost of this milestone is zero additional round trips**.

This satisfies every "must display" item in the brief and violates none of the "must not expose" items: no auth user id, no email, no token, no invitation hash, no audit value, no other Retailer's data crosses either contract.

**One additive change worth considering (not required):** see §10.3 / Finding R-1. If the decision is that the write should be able to *report* hidden assignments, add a **count** — never ids — to the roster, e.g. `inactive_shop_assignment_count integer`. Additive, tolerated by the strict-on-named-fields parser, exposes no id and no other tenant's data. **Recommendation: defer**; the write can enforce the safe behavior without the client knowing.

---

## 10. Recommended atomic write contract

### 10.1 Shape

**Complete replacement semantics, one call, one transaction.**

```sql
public.set_retailer_staff_shop_assignments(
  p_membership_id uuid,
  p_shop_ids      uuid[]
)
```

Accepts **exactly two arguments and nothing else**. Every item the brief forbids is absent and derived instead:

| Forbidden input | Derived from |
| --- | --- |
| Retailer organization id | `resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN')` |
| caller user id / actor profile id | `auth.uid()` (which *is* the profile PK) |
| target auth user id | never needed — `p_membership_id` addresses the membership directly |
| role code | read from `member_roles` → `roles.code` for the target |
| permission code | a literal inside the function |
| current assignments | read from `retailer_shop_members` under lock |
| additions / removals as separate claims | computed inside, from current vs requested |
| audit actor | `auth.uid()` |
| status values, timestamps | `now()` and literals inside |

### 10.2 Why replacement, not add/remove endpoints

1. **It matches the user's mental model and the UI.** The Owner edits a checkbox set and saves; "A,B → B,C" is one intent, not three operations.
2. **Atomicity is free.** Separate add/remove endpoints make the A→B,C transition a multi-request sequence with observable intermediate states (a moment with zero shops, or with three) — each of which a concurrent receipt submission could act on. Replacement has no intermediate state.
3. **Idempotency is natural.** Re-sending the same set is a no-op by construction. With add/remove, retry safety must be built per endpoint.
4. **It makes the minimum-shop rule checkable.** §8's rule is a property of the *final set*. Only a call that sees the whole final set can enforce it; `remove_shop(x)` can only guess.
5. **Precedent is mixed but non-binding.** `assign_vendor_product_to_retailer` / `unassign_…` are a pair — but that edge has no cardinality rule, no ordering constraint, and no UI that edits a set. The closer precedent is `accept_retailer_staff_invitation`, which applies a whole shop set atomically.

### 10.3 ⚠ The decision Finding R-1 forces

`list_retailer_staff_members.shop_ids` hides live assignments to non-`ACTIVE` shops (§5.1). Under naive replacement — *"retire every live row not in the request"* — a client that faithfully round-trips what it read would **silently retire an assignment it was never shown**, e.g.:

> Member assigned to Shop A (ACTIVE) and Shop S (SUSPENDED). Roster shows `{A}`. Owner adds C and saves `{A, C}`. Naive replacement retires the Shop S assignment the Owner never saw and did not intend to touch. If Shop S is later reactivated, the assignment is gone — destroyed by a UI the Owner used correctly.

**Recommendation: scope replacement to the ACTIVE-shop projection.**

```
retire  := live rows WHERE shop.status = 'ACTIVE' AND shop_id NOT IN requested
create  := requested shop_ids with no live row
preserve:= live rows whose shop is NOT 'ACTIVE'   -- untouched, invisible, intact
```

This makes the pair *(roster `shop_ids`, `list_retailer_staff_assignable_shops`)* a **complete and honest basis for the edit**: everything the client can see is exactly everything the write can change. Nothing the client cannot see can be destroyed by it. It is also self-consistent with §8's rule — which should likewise be evaluated over the **requested (ACTIVE) set**, since that is the set that confers receipt capability.

The alternative — retire *all* live rows not requested — is simpler to state but silently destroys history the Owner has no way to inspect or restore. **Reject it.**

### 10.4 Algorithm

```
1  v_actor := auth.uid();                     null -> 42501
2  v_retailer := resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN');
                                              null -> 42501
3  re-assert profiles(v_actor).status = 'ACTIVE'   -> 42501     [assigned_by must be a valid ACTIVE actor]
4  SELECT organizations FOR SHARE; type='RETAILER' AND status='ACTIVE'
                                              else -> 55000
5  normalize p_shop_ids: NULL -> '{}'; any NULL element -> 23514;
   array_agg(DISTINCT s ORDER BY s)           [see §10.6 on duplicates]
6  SELECT the target membership FOR UPDATE
     WHERE m.id = p_membership_id AND m.organization_id = v_retailer AND m.status = 'ACTIVE'
                                              null -> 42501     [covers null/unknown/foreign/inactive, indistinguishably]
7  target role: exactly one ACTIVE member_roles edge, code = 'SALES_STAFF'
                                              else -> 42501     [Manager and Owner targets refused here]
8  if array_length = 0 -> 23514               [§8 minimum-shop rule]
9  lock requested shops in ascending UUID order FOR SHARE:
     s.id = ANY(v_shop_ids) AND s.retailer_organization_id = v_retailer AND s.status = 'ACTIVE'
   counted; count <> requested count -> 23514 [all-or-nothing; never narrowed to survivors]
10 read current live set (member_active_idx), partitioned by shop status
11 UPDATE ... SET removed_at = now()          -- retire: live ∧ ACTIVE ∧ ∉ requested
12 INSERT ...                                  -- create: requested ∧ ∉ live   (assigned_by = v_actor)
13 if (11 affected 0 rows AND 12 affected 0 rows) -> return, NO audit row      [§15]
14 INSERT one audit_logs row                   [§14]
```

Steps 6 and 9 establish the two tenant predicates that are the entire cross-tenant boundary. The table trigger re-checks the member/shop pairing at step 12 as defence in depth.

### 10.5 Return shape

```sql
returns table (
  shops_added     integer,
  shops_removed   integer,
  shops_unchanged integer
)
```

Exactly one row. All non-null, all ≥ 0. Rationale: counts (not ids) match the audit-metadata convention already in use (`shop_count`), give the UI honest "Nothing to save" / "2 added, 1 removed" feedback without a re-read, and give the pgTAP suite a directly assertable idempotency signal. Nothing sensitive crosses — the caller already supplied the requested set and already saw the current one.

`void` (matching `revoke_…` / `assign_vendor_product_to_retailer`) is an acceptable alternative if the milestone prefers the minimal surface; the counts would then have to be inferred from a roster re-read.

### 10.6 Duplicate shop ids — a deliberate deviation from the brief

The brief lists *"duplicate Shop IDs are rejected"* as a required invariant. **The existing precedent does the opposite:** `reserve_retailer_staff_invitation` canonicalizes with `array_agg(DISTINCT s ORDER BY s)` and rejects only a **NULL element**.

**Recommendation: canonicalize (dedupe) rather than reject**, matching that precedent. Under set-replacement semantics `{A,A,B}` and `{A,B}` denote the same final state — there is no ambiguity for the caller to resolve and no unsafe outcome to prevent, and a form that posts a repeated checkbox value would fail for a reason the Owner cannot act on. A NULL element is still rejected (`23514`), because that is a malformed input, not a redundant one.

This is flagged rather than assumed: it is a one-line difference (`if array_length(v_shop_ids,1) <> array_length(p_shop_ids,1) then raise …`) and the milestone owner should confirm. **Open question O-2.**

---

## 11. Suggested RPC name

Repository verb conventions: `list_*`, `get_*` (reads); `reserve_*`, `revoke_*`, `accept_*`, `assign_*`/`unassign_*`, `record_*`, `expire_*`, `resolve_*` (writes/internal). Nouns are fully qualified (`retailer_staff_…`).

| Rank | Name | Notes |
| --- | --- | --- |
| **1** | **`set_retailer_staff_shop_assignments(uuid, uuid[])`** | 35 bytes. `set_` states replacement semantics plainly and is the only verb that does. Noun matches `retailer_shop_members` / `RETAILER_STAFF_SHOP_ASSIGN`. |
| 2 | `replace_retailer_staff_shop_assignments(uuid, uuid[])` | 39 bytes. Even more explicit; `replace_` is unused in the repo. |
| 3 | `update_retailer_staff_shop_assignments(uuid, uuid[])` | Weakest — `update_` does not distinguish replacement from a partial patch. |

Caution on rank 1: the repo already has `public.set_updated_at()`, a trigger helper. The `set_` prefix is therefore not unprecedented but is currently associated with internals. If that association is unwelcome, take rank 2. All three are well under the 63-byte identifier limit.

---

## 12. Exact proposed signature

```sql
create function public.set_retailer_staff_shop_assignments(
  p_membership_id uuid,
  p_shop_ids      uuid[]
)
returns table (
  shops_added     integer,
  shops_removed   integer,
  shops_unchanged integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$ … $$;

revoke all     on function public.set_retailer_staff_shop_assignments(uuid, uuid[]) from public;
revoke execute on function public.set_retailer_staff_shop_assignments(uuid, uuid[]) from anon;
grant  execute on function public.set_retailer_staff_shop_assignments(uuid, uuid[]) to authenticated;
-- service_role: deliberately no grant.
```

No dynamic SQL. Every reference schema-qualified. Identifier lengths ≤ 63.

---

## 13. Failure / error taxonomy

Matches the SQLSTATE register already in use across this family. **Message text is never an API** — the web client reads only the code (`lib/staff/retailer-staff-data.ts` binds only `error.code`).

| SQLSTATE | Condition | Message register |
| --- | --- | --- |
| `42501` `insufficient_privilege` | not authenticated; caller lacks `RETAILER_STAFF_SHOP_ASSIGN`; caller resolves to zero or ≥2 Retailers; caller profile/membership not ACTIVE; **target null / unknown / foreign / inactive / not Sales Staff** | *"Not authorized to update shop assignments"* — one message for all of them, so a caller cannot probe another tenant's estate one id at a time |
| `55000` `object_not_in_prerequisite_state` | Retailer organization not `ACTIVE` or not type `RETAILER` | *"This Retailer is not active"* (verbatim from `reserve_…`) |
| `23514` `check_violation` | NULL element in `p_shop_ids`; empty set for a Sales Staff target (§8); one or more requested shops unknown / inactive / another Retailer's | *"Sales Staff must be assigned to at least one shop"*, *"One or more selected shops are invalid for this Retailer"* (verbatim from `reserve_…`) |
| `22P02` `invalid_text_representation` | malformed UUID — raised by PostgreSQL/PostgREST **before** the function body runs | not ours to phrase |
| `23505` `unique_violation` | concurrent duplicate live assignment — last-resort guard | re-raise as `42501` on the generic path, matching `accept_…` step 7 |

Deliberately: a foreign shop id and an inactive shop id produce the **same** `23514`; a foreign membership and a deactivated membership produce the **same** `42501`.

> **Finding E-1.** `docs/mobile-feature-matrix.md` open item #3 records that `reserve_retailer_staff_invitation` overloads `23514` for both ordinary validation and the role/shop conflict, forcing the Edge Function to compare message literals. **Do not repeat that.** This function has no conflict case, so its three `23514` uses are all genuine input validation and need no discrimination.

---

## 14. Audit-log design

One row, in the same transaction as the assignment writes, only when something actually changed (§15).

```
organization_id  = v_retailer                        -- the Retailer's own activity feed
actor_profile_id = auth.uid()                        -- the Owner
action           = 'STAFF_SHOP_ASSIGNMENTS_UPDATED'  -- NEW code
entity_type      = 'RETAILER_STAFF_MEMBER'           -- NEW code
entity_id        = p_membership_id::text
metadata         = jsonb_build_object(
  'retailer_name',     v_retailer_name,
  'role_code',         'SALES_STAFF',
  'membership_status', 'ACTIVE',
  'shop_count_before', v_before_count,
  'shop_count_after',  v_after_count,
  'shops_added',       v_added_names,     -- text[] of shop NAMES
  'shops_removed',     v_removed_names    -- text[] of shop NAMES
)
```

Design notes:

- **`action` and `entity_type` are both new.** Existing actions are `STAFF_INVITATION_{RESERVED,REVOKED,ACCEPTED}`, `RETAILER_OWNER_{INVITED,…}`, `RETAILER_ONBOARDED`, `RETAILER_SHOP_ADDED`, `PRODUCT_{CREATED,UPDATED,ASSIGNED_TO_RETAILER,UNASSIGNED_FROM_RETAILER}`; existing entity types are `RETAILER_STAFF_INVITATION`, `RETAILER_INVITATION`, `RETAILER_ORGANIZATION`, `RETAILER_SHOP`, `VENDOR_PRODUCT`. Neither register has an entry for a membership, so both must be added. `<NOUN>_<PAST-PARTICIPLE>` matches the action convention exactly.
- **Before/after without secrets.** Counts plus name arrays. **No shop UUIDs**, no membership id inside metadata (the id is `entity_id`, which the reader already has authority over), no email, no auth id, no token, no hash. Shop names are display values the Owner already reads on the roster.
- **Names, not ids** is also what keeps this consistent with `list_vendor_audit_logs`' closed metadata whitelist (`product_name` / `retailer_name` / `shop_name`). New keys are not whitelisted, so they are invisible to that reader by construction.
- **No cross-tenant exposure.** `list_vendor_audit_logs` filters `a.organization_id = v_vendor`; these rows carry the **Retailer's** organization id and are therefore invisible to every Vendor.
- **Finding A-1 — the trail is currently write-only from the Retailer side.** No Retailer-facing audit read RPC exists. This row is durable and correct but nobody can read it in-product today. That is acceptable for this milestone (the Vendor-side reader shipped first) but should be recorded as a known limitation.

---

## 15. Concurrency and idempotency design

**Locking (in this order, to keep lock order total across all callers):**

1. `organizations` row — `FOR SHARE` (step 4). Blocks a concurrent Retailer deactivation.
2. **`organization_members` target row — `FOR UPDATE`** (step 6). **This is the serialization point.** Two concurrent calls against the same staff member queue; the second sees the first's committed state and computes its diff against reality, not against a stale snapshot. It also blocks a concurrent membership status change.
3. `retailer_shops` requested rows — `FOR SHARE`, **ascending UUID order** (step 9). Same discipline as `accept_…` and `reserve_…`; prevents lock-order deadlock between two Owners editing overlapping shop sets, and holds each shop against deactivation mid-transaction.
4. `retailer_shop_members_live_unique_idx` is the last-resort guard; a `23505` from it is re-raised on the generic path.

**Optimistic concurrency: not recommended.**

- Contention is structurally near-zero: `RETAILER_STAFF_SHOP_ASSIGN` is mapped to `RETAILER_OWNER` alone, and the resolver admits a caller only when **exactly one** Retailer qualifies. In practice one person per Retailer can call this.
- The `FOR UPDATE` membership lock already makes each call atomic and serialized; there is no torn write to protect against.
- Last-write-wins is the **correct** semantics for a set editor: the Owner is asserting a complete desired state, and the second Owner's assertion is the newer intent.
- The residual risk is a genuine **lost update** — Owner 1 adds C while Owner 2 (from a stale form) saves `{A,B}`, erasing C. A version token (`organization_members.updated_at`, or a hash of the current set) would turn that into a `40001`-style retry prompt. **Recommendation: do not add it now.** It costs a required client round-trip and a new failure mode the UI must explain, to protect against a race that requires two simultaneous Owners of one Retailer — a configuration the resolver currently refuses to authorize at all. Revisit if and when multi-Owner Retailers ship. **Open question O-3.**

**Idempotency.** An identical request computes an empty diff, executes **zero** `UPDATE`s and **zero** `INSERT`s, writes **no audit row**, and returns `(0, 0, n)`. This mirrors the resend path in `reserve_retailer_staff_invitation`, which deliberately writes no second `RESERVED` audit event. A no-op is not an event.

**Atomicity.** The whole function is one transaction (PostgREST runs each RPC in one). Any raise rolls back every `INSERT`/`UPDATE`, leaving **no partial assignment state**. The all-or-nothing shop validation at step 9 runs *before* any write, so the common invalid-shop case never begins mutating.

---

## 16. Migration plan

One migration, function-only.

**File:** `supabase/migrations/2026XXXXYYYYYY_retailer_staff_shop_assignment_management.sql`
(timestamp to be assigned at implementation time, after `20260808090000`, following the existing `YYYYMMDDHHMMSS` convention)

**Contains, and only contains:**
- `create function public.set_retailer_staff_shop_assignments(uuid, uuid[])` — plain `CREATE`, no `IF NOT EXISTS`, no `CREATE OR REPLACE`, so a conflicting object fails the migration;
- its three privilege statements (`revoke all` / `revoke execute from anon` / `grant execute to authenticated`);
- a header stating dependencies and everything it does not do, matching the register of every migration in this repo.

**Explicitly does NOT:**
- create, alter or drop any table, column, constraint, index, trigger, policy, role, permission, or role-permission mapping — `RETAILER_STAFF_SHOP_ASSIGN` and its `RETAILER_OWNER` mapping already exist;
- touch `list_retailer_staff_members()`, `list_retailer_staff_assignable_shops()`, or any invitation/acceptance function;
- grant any table privilege to any browser role;
- grant anything to `service_role`;
- add an `action`/`entity_type` catalogue row — `audit_logs.action` and `.entity_type` are free `text` with only a not-empty check; the new codes need no seeding.

**Dependencies to name in the header:** `20260716124419`, `20260716125559`, `20260716130351`, `20260717094520`, `20260722210000`, `20260723090000`.

**Rollback:** `drop function public.set_retailer_staff_shop_assignments(uuid, uuid[]);` — no data change, no schema change, so rollback is total. Assignment rows written before a rollback remain valid and readable through the existing roster.

---

## 17. Test plan

### 17.1 pgTAP — `supabase/tests/database/retailer_staff_shop_assignment_writes_test.sql`

Following `vendor_product_assignment_writes_test.sql`. Fixture: two Retailers (R1 active, R2 active, R3 inactive), each with Owner / Manager / Sales Staff, R1 with shops A, B, C (ACTIVE) and S (SUSPENDED).

**Structural / privilege assertions (no session needed)**
1. `has_function('public','set_retailer_staff_shop_assignments', ARRAY['uuid','uuid[]'])`
2. `is_definer(...)`, `volatility = 'v'`, `proconfig` contains `search_path=`
3. `function_privs_are(..., 'authenticated', ARRAY['EXECUTE'])`
4. `function_privs_are(..., 'anon', ARRAY[]::text[])` and same for `public` and **`service_role`**
5. `retailer_shop_members` still RLS-enabled with **zero** policies; `authenticated` still has **no** table privilege

**Behavioral matrix**

| # | Case | Expected |
| --- | --- | --- |
| B1 | Owner: `{A}` → `{A,B,C}` | `(2,0,1)`; three live rows; A's row **untouched** (`assigned_at` unchanged) |
| B2 | Owner: `{A,B,C}` → `{A,C}` | `(0,1,2)`; B's row has `removed_at` set, is **not deleted** |
| B3 | Owner: `{A,B}` → `{B,C}` (full replace) | `(1,1,1)`; A retired, B untouched, C created |
| B4 | Identical request repeated | `(0,0,n)`; **zero** new rows, **zero** `removed_at` changes, **zero** new audit rows |
| B5 | Duplicate ids `{A,A,B}` | canonicalized to `{A,B}` — §10.6/**O-2**; assert whichever the milestone confirms |
| B6 | Empty array `{}` for Sales Staff | `23514` (§8 recommendation) |
| B7 | Malformed staff identifier (`NULL`) | `42501`, indistinguishable from "not yours" |
| B8 | Unknown/random membership uuid | `42501` |
| B9 | Malformed shop identifier (`NULL` element) | `23514` |
| B10 | Target is a `RETAILER_MANAGER` | `42501`; **no** row written |
| B11 | Target is a suspended/deactivated Sales Staff membership | `42501` |
| B12 | Requested shop is SUSPENDED (shop S) | `23514`; **no** row written |
| B13 | Requested shop belongs to R2 | `23514`; and the trigger message never reaches the caller |
| B14 | Target staff belongs to R2 | `42501` |
| B15 | Caller is a Manager | `42501` |
| B16 | Caller is Sales Staff (targeting self) | `42501` |
| B17 | Caller is Vendor Super Admin | `42501` |
| B18 | Caller is anonymous (`auth.uid()` null) | `42501` |
| B19 | Caller's Retailer is SUSPENDED | `42501` (resolver) — assert it is **not** `55000`, since the resolver fires first |
| B20 | **Rollback on one invalid shop:** `{A, <R2 shop>}` | `23514` **and** the live set is byte-identical to before — no partial application |
| B21 | **Preserved hidden assignment (§10.3):** member on `{A, S}` (S suspended), request `{A,B}` | S's live row **still live**; only the ACTIVE-shop projection changed |
| B22 | Audit row | exactly **one** row; `action='STAFF_SHOP_ASSIGNMENTS_UPDATED'`, `entity_type='RETAILER_STAFF_MEMBER'`, `entity_id=membership_id`, `organization_id=R1`, `actor_profile_id=owner`; metadata contains **no** uuid, no email, no token |
| B23 | Re-add after removal | a **new** row is inserted; the old retired row survives with its original `assigned_at`/`removed_at` (§3.3) |
| B24 | Direct table write as `authenticated` | denied (`INSERT`/`UPDATE`/`DELETE` on `retailer_shop_members` all fail) |
| B25 | Membership changed during operation | with the `FOR UPDATE` lock held by a concurrent session, assert serialization rather than a torn set |

B25 requires two sessions; if the harness is single-session, assert the lock clause's presence via `pg_get_functiondef` and cover the outcome in the integration script instead — **and say so in the file**, rather than letting a skipped case read as coverage.

### 17.2 Node / static — `lib/staff/staff-shop-assignment-contract.test.ts`

Runs under the existing `npm test` (`node --experimental-strip-types --test "lib/**/*.test.ts"`). Source-level assertions, in the style of `vendor-product-assignment-writes-contract.test.ts`:

1. The migration declares exactly the two parameters, in order, and no more.
2. The migration contains `security definer`, `set search_path = ''`, and no `execute` / dynamic SQL.
3. `grant execute … to authenticated` is present; **no** `grant … to service_role`; **no** `grant … to anon`.
4. The function body contains no `organization_id` **parameter** and derives the Retailer via `resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN')`.
5. Audit metadata construction contains no `::text` cast of any uuid other than `entity_id`, and no `email` / `token` / `hash` key.
6. Any new server wrapper contains zero `.from(` calls and never constructs a service-role client.
7. The wrapper maps `42501` → `denied` and every other error → `unavailable`, never surfacing an error object or message.

---

## 18. Web integration impact

**Backend-only milestone; no UI is in scope.** For the record, when the UI does land:

- `app/(retailer)/retailer/staff/page.tsx` **already** fetches both required reads for a `SHOP_ASSIGN` holder and already renders `member.shopNames` as chips (`ShopBadges`, L113–125) in both the table and the stacked layout. The editor's data is on the page today.
- The write belongs in `app/(retailer)/retailer/staff/actions.ts` as a Server Action, calling through a new server-only wrapper beside `lib/staff/retailer-staff-data.ts` — under the **caller's own token**, never `service_role`, with the same `42501 → denied` / anything-else → `unavailable` discipline.
- Re-validate submitted shop ids against a fresh `getRetailerStaffAssignableShops()` before the RPC, exactly as `lib/staff/staff-invite-input.ts` already does for the invite form. That is defence in depth, **not** the security boundary — the RPC re-checks everything.
- `lib/staff/staff-normalization.ts` needs a small normalizer for the three returned counts if the table return shape (§10.5) is adopted.
- **No existing read contract changes, so no existing web code breaks.**

---

## 19. Flutter integration impact

**None in this milestone.** The Flutter repository is not touched.

- Neither existing read contract changes, so no shipped Flutter parser is affected. Per `docs/mobile-feature-matrix.md`, `list_retailer_staff_assignable_shops()` is "Shipped / Ready" with **no Flutter consumer yet**, and `list_retailer_staff_members()` is used only as one probe inside `getRetailerPortalAccess()`.
- The new RPC would be **directly callable from Flutter under the user's own token** with no Edge Function: it takes no text input, holds no secret, needs no service-role step, and returns no recipient identity. That is the property that made `assign_vendor_product_to_retailer` reusable unchanged (audit outcome B), and it holds here for the same reasons.
- Documentation owed **when the function ships**, not now: a row in `docs/mobile-backend-contract.md`, a line in `docs/mobile-feature-matrix.md`, and the Owner flow in `docs/mobile-role-flow-map.md`.
- Flutter clients must read the SQLSTATE, not the message (§13), and must treat `42501` as "denied", never as "empty".

---

## 20. Risks, open questions, limitations

**Findings carried forward**

| Id | Finding |
| --- | --- |
| **R-1** | `list_retailer_staff_members.shop_ids` is an ACTIVE-shop projection, not the live assignment set. Naive replacement would silently destroy invisible assignments. Mitigated by §10.3. |
| **E-1** | Do not repeat `reserve_…`'s `23514` overloading; this function's three `23514` uses need no message-literal discrimination. |
| **A-1** | The Retailer-side audit trail is write-only in-product — no Retailer-facing audit read RPC exists. |

**Open questions — all five now decided (see §0)**

| Id | Question | Audit's recommendation | Decision |
| --- | --- | --- | --- |
| **O-1** | With the zero-shop rule (§8.4), the Owner has no way to stand a member down until staff deactivation ships. Accept the gap? | Accept; it predates this milestone and closing it is explicitly out of scope. | **Accepted.** Empty list refused (`23514`). |
| **O-2** | Duplicate shop ids — **reject** (as the brief's invariant list states) or **canonicalize** (as `reserve_…` does)? | Canonicalize. One-line change either way; confirm before implementation. | **Canonicalize.** |
| **O-3** | Add optimistic concurrency (version token)? | No, not now. Revisit with multi-Owner Retailers. | **Not added.** |
| **O-4** | RPC name: `set_` (rank 1) vs `replace_` (rank 2)? | `set_retailer_staff_shop_assignments`. | **`set_…`.** |
| **O-5** | Return `(added, removed, unchanged)` or `void`? | The counts — better UX feedback and a directly assertable idempotency signal. | **The counts.** |

**Risks and limitations**

1. **The minimum-shop invariant is not actually enforceable system-wide.** Shop deactivation still empties a member's effective set with no guard and no notification (§8.1). §8.4 makes the rule consistent at every *write* choke point; it does not make it true. A cascade-on-shop-deactivation rule or an operator report is a separate, unscoped piece of work.
2. **Two new audit vocabulary entries** (`STAFF_SHOP_ASSIGNMENTS_UPDATED`, `RETAILER_STAFF_MEMBER`) enter a register with no catalogue table and no validation. A typo would be permanently persisted and silently wrong. The pgTAP assertion B22 is the only guard — keep it.
3. **Lost updates are possible but structurally improbable** (§15). Documented, not defended against.
4. ~~**This audit read source, not a live database.**~~ **Closed at implementation.** The audit itself was source-only; the pgTAP suite now executes the whole contract against a real Postgres, and the migration was applied to the hosted development project with its signature and grants re-verified there. What remains untested by machine is genuine multi-session concurrency — see limitation 7.
5. **No Flutter source was read** — the Flutter repository is out of scope by instruction. §19's conclusions rest on this repository's contract documentation (`docs/mobile-backend-contract.md`, `docs/mobile-feature-matrix.md`), which the Flutter work is documented as tracking.
6. **Multi-role staff.** `list_retailer_staff_members` emits one row per `(membership, role)` edge, and step 7 of §10.4 requires *exactly one* ACTIVE role edge, code `SALES_STAFF`. A person who somehow holds two Retailer roles is refused rather than handled — correct and fail-closed, but it is a state the roster can display and the write cannot act on.
7. **Genuine concurrency is asserted structurally, not exercised.** A pgTAP file runs inside one transaction, so two simultaneous sessions cannot be created to prove the `FOR UPDATE` lock *blocks*. Section A asserts the locking clauses are present in the installed body and Section L asserts the observable consequence — every call recomputes its diff from committed state, so a sequence of requests yields the last one and never a merge or a partial application. The suite says so in its own header rather than letting the gap read as coverage.
8. **The three returned counts describe the visible set only.** `shops_unchanged + shops_added` can be smaller than the number of live rows the member actually holds, because preserved non-ACTIVE assignments are in no count (§10.3). A client that renders the counts as "total shops" will be wrong for exactly those members. RO-10 in the mobile contract states this in bold; there is no way to make it safe *and* keep hidden assignments hidden.
