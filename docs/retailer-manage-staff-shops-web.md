# Web — Manage Shops for existing Retailer Sales Staff

**Status:** shipped (web). Backend shipped previously in migration
`20260809090000_retailer_staff_shop_assignment_management.sql`; see
`docs/retailer-staff-shop-assignment-management-audit.md` for the database contract and
`docs/mobile-backend-contract.md` **RO-10** for the shared client contract.

**This milestone adds no migration, no RPC, and no change to any deployed RPC contract.**
It is the web client for a write that already existed.

---

## 1. Scope

A Retailer Owner opens an existing, **accepted and active Sales Staff member** and changes
which of the Retailer's **active shops** that person works in.

Deliberately **not** in scope, and not reachable from this UI: inviting staff, resending or
revoking invitations, changing anyone's role, activating or deactivating a membership,
changing credentials, assigning shops to a Retailer Manager, and anything a Vendor does.

---

## 2. Route and entry point

| | |
| --- | --- |
| Route | `/retailer/staff` — the existing Retailer Staff page. No new route. |
| Entry point | A **Manage shops** button on each eligible row of the **Active staff** roster, in both the desktop table and the mobile card list. |
| Editor | A modal dialog (bottom sheet below `sm`, centred panel above it) rendered by `app/(retailer)/retailer/staff/manage-shops-dialog.tsx`. |

The editor shows the person's name, their role label, the shop checkboxes, a live selected
count, the "at least one shop is required" rule, **Save changes**, **Cancel/Close**, a
loading state, and success or failure notices.

---

## 3. Role access

Presentation is keyed on a **backend-derived capability**, never on a role string. The page
asks `showsManageShops(assignable.status)` where `assignable` is the result of
`list_retailer_staff_assignable_shops()` — an RPC granted only to holders of
**`RETAILER_STAFF_SHOP_ASSIGN`**, which is exactly the permission the write gates on. So the
control appears if and only if the caller demonstrably holds the capability the write
requires. There is no role name in `lib/staff/portal-access-decision.ts`.

| Caller | Roster | Manage Shops | Can write? |
| --- | --- | --- | --- |
| Retailer **Owner** | full | **visible** on eligible rows | yes |
| Retailer **Manager** | unchanged, read-only | **absent** — their assignable-shop read answers `denied` | no — `42501` from the RPC even by hand-crafted POST |
| **Sales Staff** | no roster access at all | absent | no — cannot change their own or anyone's |
| **Vendor** | no Retailer portal access | absent | no — the resolver admits only RETAILER organizations |

If the assignable-shop read is **`unavailable`** (a transient fault rather than a denial),
the control is still offered and the editor shows a picker-specific failure with a
read-only retry — the same rule the Invitations and Invite sections already use. Save
cannot be enabled in that state.

**Hiding a control removes the accident, not the capability.** The Server Action
re-resolves portal access and re-reads the assignable shop list on every submission, and
the RPC re-derives everything from `auth.uid()`.

---

## 4. Eligible target

Only rows where `canManageStaffShops(member)` is true — `roleCode === "SALES_STAFF"` **and**
`membershipStatus === "ACTIVE"`.

No control is rendered for a Retailer Manager row, a Retailer Owner row, a non-ACTIVE
membership, or anything in the invitation list (a different list, with different
identifiers, that the editor has no concept of).

The target is the **canonical membership id** — `organization_members.id`, exactly as
`list_retailer_staff_members()` returns it as `membership_id`. Not an auth user id, profile
id, email, invitation id, member-role id, list index or name: none of those can address a
membership, since one person may be staff at several Retailers.

---

## 5. RPC signature

```
public.set_retailer_staff_shop_assignments(
  p_membership_id uuid,
  p_shop_ids      uuid[]
)
returns table (shops_added integer, shops_removed integer, shops_unchanged integer)
```

Called once, with exactly those two arguments, through
`lib/staff/retailer-staff-shop-assignments.ts` under the **signed-in caller's ordinary
Supabase session**. No service-role client, no service-role key, no direct database
connection, no Edge Function, no Resend credential. No Retailer organization id, caller
id, actor profile id, role code, permission code, current-assignment list, audit actor,
status or timestamp is sent — the RPC accepts nothing else, and nothing else is read from
the form.

---

## 6. Input validation

Server-side, in `app/(retailer)/retailer/staff/actions.ts` →
`updateStaffShopAssignmentsAction`, before the RPC is reached. The rules themselves live in
the pure module `lib/staff/staff-shop-assignment-input.ts`.

1. **Only two form fields are read** — `membershipId` and `shopIds`. Any other key a
   tampered POST carried is never looked at, so it cannot influence anything.
2. `membershipId` is trimmed, lower-cased and must match the canonical UUID form.
3. `shopIds` must be an array; entries are trimmed, lower-cased, **de-duplicated** and
   sorted. Blank entries are dropped; malformed ones are **kept** so they are reported
   rather than silently discarded into a shorter, valid-looking request.
4. **An empty list is rejected.**
5. A `null` element is rejected.
6. A defensive cap of 200 ids bounds the work done before the subset check.
7. **Defence in depth:** the action re-reads `list_retailer_staff_assignable_shops()` for
   this caller and accepts a submitted shop id only if it appears in that fresh result. A
   malformed id and an id outside the set are reported **identically** — distinguishing them
   would confirm whether some other shop exists.

Nothing uses a shop's name, code, city or array position as an identifier.

**The RPC is still the final authority** and re-applies every one of these rules itself.

---

## 7. ACTIVE-Shop projection behaviour ⚠️

`list_retailer_staff_members()` filters its `shop_ids` to shops that are currently
**ACTIVE**. A Sales Staff member may **also** hold a live assignment to a suspended or
deactivated shop, which no client can see.

The UI is scoped to match, exactly:

- the editor **preselects only** the member's current ACTIVE assignments from the roster;
- the preselection is **intersected** with the currently assignable shops, so a checkbox is
  never ticked for an option that is not on screen;
- selection is offered **only** from `list_retailer_staff_assignable_shops()`;
- the submitted set is the complete desired **visible ACTIVE** set.

**The backend preserves live assignments to non-ACTIVE shops.** They are untouched by this
operation and are counted in none of the three returned totals. This UI therefore never
claims that the visible selection is every row the database holds, never attempts to
remove a hidden assignment, and never presents the counts as the employee's shop count.

---

## 8. Zero-Shop rule

An active Sales Staff member must keep **at least one** requested ACTIVE shop.

- **Save is disabled** while nothing is selected, and the editor says so inline.
- The Server Action rejects an empty (or null) list before the RPC.
- The RPC rejects it independently with `23514`.

This milestone provides **no "stand this person down" operation**. Staff
activation/deactivation is a separate future milestone.

---

## 9. Duplicate canonicalization

`[Shop A, Shop A, Shop B]` is treated as `[Shop A, Shop B]` — canonicalized, never
rejected. Under complete replacement the two denote the same final state, so there is
nothing for the operator to resolve.

In the UI a duplicate is structurally impossible: the selection is a `Set`. On the server,
`normalizeShopSelection` de-duplicates. In SQL, the RPC applies
`array_agg(distinct s order by s)`. All three agree.

---

## 10. Canonical re-read

After a committed write the action calls `revalidatePath("/retailer/staff")` and then
**re-reads `list_retailer_staff_members()`**.

The roster is **never** patched from the ids that were just submitted. Those describe the
visible ACTIVE set only; the database alone can see the preserved non-ACTIVE assignments,
so it is the only honest source for what the member is now assigned to. The displayed shop
names always come from the re-read.

---

## 11. Success and refresh-failure behaviour

| Outcome | What the operator sees | Save afterwards |
| --- | --- | --- |
| Committed, roster re-read fine | *"Shop assignments updated: 1 added and 1 removed."* — a **change**, never a total | withdrawn |
| Committed, nothing to change | *"No changes were needed — these shop assignments were already up to date."* (the backend wrote no row and no audit event, so claiming an update would be false) | withdrawn |
| **Committed, roster re-read failed** | *"Shop assignments were updated, but the latest staff details could not be refreshed. Refresh the page to see them."* | **withdrawn** |

The third row is a **success**, not a failure, and is worded to stop exactly one reaction:
saving again. The Save button is unmounted once a write has committed, so no ordinary
retry can resubmit a change that has already happened. There is **no automatic retry**
anywhere on this path; the only retry offered is a **read** (`router.refresh()`) for the
shop picker.

The returned counts may appear in success copy. They must **never** be presented as
`shops_added + shops_unchanged` = the employee's total shop count.

---

## 12. Stale shops during editing

If a selected shop is no longer in the freshly-read assignable set when Save is pressed:

- **nothing is submitted** to the database;
- the action returns the refreshed shop list, and the editor re-renders its picker from it;
- the selection is re-derived from the ids currently on offer, so the unavailable one is
  dropped from the requested set rather than silently sent;
- the operator sees *"Shop availability changed while you were editing. Review the shops
  below, then save."* and must review before saving.

---

## 13. Session isolation

Each editor is mounted with `key={member.membershipId}`. A membership id is unique per
`(organization, user)`, so a different account — or a different Retailer — produces an
entirely different roster and therefore different keys: React unmounts every old instance
and all of its state (open flag, selection, target, feedback) is discarded with it. A
response from a previous instance's action cannot reach a new one, because the hook that
owned it was unmounted too.

Independently, the Server Action redirects to `/login` when the session is gone and to
`/retailer-access-denied` when the caller no longer qualifies. **No previous Retailer's
membership or shop data can remain visible in a new session.**

---

## 14. Security boundary

- **The RPC is the only shop-assignment write.** No add/remove pair, no second entry point.
- **No direct table access.** `public.retailer_shop_members` has RLS enabled with zero
  policies and `REVOKE ALL` from every browser role; nothing on this path contains a
  `.from(` call, and neither `retailer_shop_members` nor `retailer_shops` is named.
- **No service-role client or key, no Edge Function, no connection string, no token or
  hash** appears anywhere on this path.
- **A Server Action is a public endpoint.** Access is re-resolved and the assignable list
  re-read on every submission; a hidden control is never treated as a check.
- **Errors are mapped by SQLSTATE, never by message substring.** Only `error.code` is ever
  read; no message, detail or hint is bound, returned or logged.
- **No internal identifier is rendered.** Ids live only in a form control's `value` and in
  React keys. Every label the operator reads is a name.

### Error taxonomy

| SQLSTATE | Meaning | Operator sees |
| --- | --- | --- |
| `42501` | signed out; wrong role; unknown, foreign, inactive or non-Sales-Staff target — **one identical message in SQL** | *"You can't update this person's shops. Refresh the page and try again."* |
| `23514` | no shops selected; a shop that is invalid, inactive, foreign or unavailable | *"Select at least one shop…"* or *"Some of the selected shops are no longer available…"* |
| `55000` | the Retailer became unavailable mid-operation | *"Your Retailer is not available right now…"* |
| `22P02` | malformed UUID — tampered submission only | reported as a denial, so it is indistinguishable from one |
| anything else | unexpected service failure | *"We couldn't update those shop assignments. Please try again in a moment."* |

Validation, access, stale data, Retailer state and unexpected service failure are all
distinguishable. **No failure is reported as "check your connection."** No SQL message,
SQLSTATE string, PostgREST detail, UUID, table name, function internal, stack trace,
project URL, token or key can reach the UI.

---

## 15. Browser verification

Verified manually in Chrome against the hosted development project, signed in as a
Retailer Owner and then as a Retailer Manager. The checklist is in the milestone brief and
covers: the control's presence on eligible rows only; preselection; adding and removing a
shop; save and success copy; the canonical re-read; persistence across a reload; the
empty-selection block; duplicate-click safety; cancel making no change; Invite Staff and
invitation history still working; and no raw identifier, backend error or layout overflow.

*(Result recorded at the end of the milestone.)*

---

## 16. Automated coverage

| Suite | Count | What it covers |
| --- | --- | --- |
| `lib/staff/staff-shop-assignment-input.test.ts` | 46 | Every **decision** the editor makes, executed: eligibility, canonicalization, validation, the defence-in-depth subset check, preselection and intersection, the Save gate, and the success copy — including that it never states a total. |
| `lib/staff/staff-shop-assignment-web-safety.test.ts` | 50 | Source-level contract and security guards over the action, wrapper, dialog and page: RPC name and its exactly-two arguments, no privileged path, SQLSTATE-only mapping, canonical re-read, no automatic retry, no rendered identifier, dialog accessibility, presentation authority, and regression of the rest of the page. |
| `lib/staff/portal-access-decision.test.ts` | extended | `showsManageShops` / `showsShopPicker`. |
| `supabase/tests/database/retailer_staff_shop_assignment_writes_test.sql` | 163 | The RPC's own behavioural specification (unchanged by this milestone). |

---

## 17. Limitations

1. **No rendered-DOM tests.** This repository has no component-test harness — no jsdom, no
   Testing Library, no vitest/jest — and `npm test` runs `node --test` over
   `lib/**/*.test.ts` only. Adding one would mean installing packages, which `AGENTS.md`
   forbids without a request. The editor's logic is therefore extracted into a pure module
   and tested exhaustively there, with structural claims about the `.tsx` asserted
   separately; that is this repository's established pattern, but it is **not** the same as
   driving a real DOM, and interaction behaviour is confirmed by the manual Chrome pass.
2. **The three counts describe the visible set only.** `shops_added + shops_unchanged` can
   be smaller than the rows the member actually holds. The UI never presents them as a
   total, but a future contributor adding such copy would not be caught by the backend.
3. **No "stand down" path.** An Owner cannot remove a member's last shop; that awaits the
   staff activation/deactivation milestone.
4. **The roster has no search or filter** to preserve or extend — the page has never had
   either. This milestone adds none.
5. **Shop deactivation still silently empties a member's effective set.** That is a
   pre-existing backend gap recorded in the audit document, not something this UI can fix.
6. **Flutter is not implemented** for Manage Shops. The RPC is directly callable from a
   mobile client under the user's own token; nothing in this milestone touches the Flutter
   repository.
