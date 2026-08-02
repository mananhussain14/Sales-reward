# Claim Reviewer Portal Access — Phase 1B

Access and routing only. A properly assigned Claim Reviewer can sign in, resolve one Vendor
organization, pass a dedicated server-side gate, enter `/review` and see an **authorized
empty dashboard**.

**No receipt data, verification, product matching, reward or coin capability exists**, and
no reviewer has been created. Nothing here has been deployed.

---

## 1. What this milestone grants, and what it does not

`CLAIM_REVIEW_PORTAL_READ` authorizes **one** thing: opening the reviewer portal shell.

It does **not** authorize the receipt queue, receipt detail, receipt images, verification,
rejection, product matching, or any financial data. A separate permission —
`RECEIPT_REVIEW_READ` — will be created in Phase 1C, and its absence today is asserted by
tests in both suites.

**Why two permissions rather than one.** If Phase 1B had created `RECEIPT_REVIEW_READ` and
Phase 1C's queue RPC resolved on it, then the moment that RPC deployed, every existing
reviewer would silently gain receipt-data access with nobody having decided to grant it.
Splitting them makes that a separate, visible, reviewable act, and lets "may open the
portal" be revoked without touching "may read receipt data". It is the same split the
project already makes between `PRODUCTS_READ` and `PRODUCTS_MANAGE`.

## 2. Role mapping

`CLAIM_REVIEW_PORTAL_READ` → **`CLAIM_REVIEWER` only.**

Not `VENDOR_SUPER_ADMIN`, `FINANCE_ADMIN`, `RETAILER_OWNER`, `RETAILER_MANAGER` or
`SALES_STAFF`.

**Vendor Super Admin is excluded deliberately**, and it is the exclusion most likely to be
questioned later. A Vendor Super Admin authors campaigns; a reviewer decides which sales
those campaigns pay for. One person holding both can direct rewards to a chosen Retailer.
That separation is the point of the milestone, and a pgTAP test enumerates the grantees so a
future mapping mistake fails the build.

## 3. Fails closed on zero **and** on multiple Vendors

`resolve_claim_reviewer_organization(text)` returns `NULL` when a reviewer qualifies for no
Vendor **and** when they qualify for more than one. It does not pick the lowest id, the
earliest membership, or any other tie-break.

This deliberately differs from `get_vendor_super_admin_context()`, which orders by
organization id and takes the first — an asymmetry that function's own comments call out as a
pre-existing behaviour of the shipped web application. A reviewer decides what is worth
money, and silently choosing one of their two Vendors is not a decision a resolver may make.
A multi-Vendor reviewer is refused until an explicit Vendor-context chooser is designed.

## 4. Vendor Admin access was not widened

`get_vendor_super_admin_context()` is **byte-untouched**. It gates the entire shipped Vendor
Admin and hard-codes `r.code = 'VENDOR_SUPER_ADMIN'`; admitting a second role there would
silently change who can reach every existing Vendor page, and it returns a `TABLE`, so
reshaping it would additionally require `DROP` + `CREATE`.

Phase 1B adds a **parallel** resolver instead. A pgTAP test asserts a reviewer resolves zero
Vendor Super Admin context rows, and that a Vendor Super Admin still resolves exactly one.

## 5. `get_my_portal_context()` is unchanged — a hard Flutter requirement

That function is consumed by the **Flutter** client and by nothing on the web. Its parser:

- rejects an unrecognised `portal_kind` (`PortalKind.tryParse` returns `null`, and the parser
  then throws `PortalContextFormatException`); and
- requires `context_version` to equal its supported version **exactly**.

So adding a `CLAIM_REVIEWER` portal kind, **or** incrementing the version, would break every
existing mobile build. Neither was done. The migration does not mention the function,
`portal_kind` or `context_version`, and a source-level test fails if any migration after the
original ever redefines it.

**A reviewer-only user opening Flutter receives `portal_kind = 'NONE'` → "No access", which
is already the correct answer**: there is no mobile reviewer experience. Both context blocks
stay `null`, so the parser's `NONE` coherence check still holds.

**If a mobile reviewer surface is ever built**, the safe extension is a new top-level **key**
(for example `claim_review`), never a new `portal_kind` value and never a version bump — the
function's own contract already states that adding a key is non-breaking.

## 6. Web routing

The Web does **not** use `get_my_portal_context()`. It routes through
`lib/auth/vendor-admin-access.ts`, `lib/staff/retailer-staff-access.ts` and now
`lib/review/claim-reviewer-access.ts`.

The reviewer branch is appended **last** in `selectLanding`:

| Order | Who | Lands on |
|---|---|---|
| 1 | Vendor Super Admin | `/` |
| 2 | Retailer Owner | `/retailer` |
| 3 | Retailer Manager | `/retailer/staff` |
| 4 | Sales Staff | `/retailer/receipts` |
| 5 | **Claim Reviewer** | **`/review`** |
| 6 | none of the above | `/access-denied` |

**This ordering is what makes the change provably zero-regression.** The only callers whose
destination can change are those who would previously have landed on `/access-denied`.

- A **reviewer-only** user now lands on `/review`.
- A **dual Vendor Super Admin + reviewer** still lands on `/`, and reaches `/review` directly.
  No portal chooser and no switcher were added.
- A Retailer Owner, Manager or Sales Staff member keeps their existing landing.

The `reviewer` parameter defaults to `"unauthorized"`, so every pre-existing call site and
test stands unmodified as a regression proof, and a test asserts the default reproduces the
old behaviour for all eighteen vendor × retailer combinations.

The reviewer probe is issued **only** when no earlier read authorized the caller, so no
existing login gains a round trip. A Retailer `unavailable` is passed straight through rather
than probed past: the caller may still be a Retailer, and handing them the reviewer portal
during an outage would be the wrong portal, not a safe fallback.

## 7. The route gate

`app/(review)/review/layout.tsx` is the authorization boundary — not `proxy.ts`, which is an
optimistic pre-filter.

| Access status | Behaviour |
|---|---|
| `unauthenticated` | redirect `/login` |
| `unauthorized` | redirect `/review-access-denied` |
| `unavailable` | render a retry-safe notice; **no** redirect, session preserved |
| `authorized` | render `ReviewShell` |

`/review-access-denied` sits **outside** the `(review)` group so the guard cannot loop, names
the surface ("Claim Review access") but never the missing role, permission, membership or
organization state, never mentions Vendor Super Admin, and self-corrects by redirecting an
authorized reviewer to `/review`.

## 8. The reviewer shell contains no Vendor navigation

`components/review/review-nav-items.tsx` is a **separate** list from the Vendor Admin and
Retailer ones — not a filtered view. Importing the Vendor items and hiding some would leave
Retailers, Users, Roles, Products, Campaigns, Audit Logs and the Claims/Coins/Payouts
placeholders one rendering bug away from a reviewer's sidebar. Three lists that share nothing
cannot leak into each other, and a test asserts no module under `components/review` imports
`NAV_ITEMS` or links to a Vendor or Retailer route.

Initial navigation is a **single disabled "Review queue" item marked "Soon"**.

## 9. The dashboard is intentionally empty

`/review` performs **no data access at all** — no Supabase client, no `.rpc(`, no `.from(`.

It shows no receipt count, and that omission is the subtle one: "6 receipts waiting" is
receipt data derived from a table this portal may not read, and it would leak the size of a
tenant's activity through a number. Tests assert the page contains no client, no query and no
count.

The empty state is written to look **intentional** rather than broken. The genuinely failed
case is handled separately by the layout, with different wording.

## 10. Reviewer bootstrap — after deployment, not here

**No reviewer was created**, and none can be created by this code. The migration contains no
email, no profile identifier, no bootstrap RPC and no administrative backdoor. `CLAIM_REVIEWER`
still has zero members.

After this is merged and deployed, exactly one explicitly confirmed reviewer will be added by
a **reviewed, one-off hosted SQL transaction**. Before that runs, the operator must supply:

1. the reviewer's email address (used only to locate the auth user; never committed);
2. confirmation that the person already has an Auth account and an `ACTIVE` profile;
3. the target Vendor organization;
4. **explicit confirmation that they are not the Sales Staff member used for the pilot
   receipt** — hosted has exactly one such member, so this is concrete and checkable;
5. confirmation that they should hold `CLAIM_REVIEWER` only.

There is **no Vendor member invitation flow** — every existing invitation path is
Retailer-side. Building one is its own later milestone.

## 11. Revoking access

Every link in the chain already supports deactivation, and access stops at the **next**
server check because the layout re-resolves on every render:

| Change | Effect |
|---|---|
| `profiles.status` ≠ `ACTIVE` | refused |
| `organization_members.status` ≠ `ACTIVE` | refused |
| `organizations.status` ≠ `ACTIVE` | refused |
| `roles.status` ≠ `ACTIVE` for `CLAIM_REVIEWER` | **every reviewer refused at once** — a kill switch |
| `member_roles` row deleted | that reviewer refused |
| `role_permissions` mapping removed | the whole portal disabled, with no code change |

To remove one reviewer, **delete their `member_roles` row** — never the profile, which audit
rows reference (`audit_logs.actor_profile_id` is `ON DELETE SET NULL`, so deleting a person
silently strips attribution from their history).

## 12. Still mandatory for Phase 1C/1D

The verification write path **must** carry a trigger asserting
`verified_by_profile_id <> sold_by_profile_id`. It compares **identities, not roles**, so it
holds even if someone is later mis-granted both capabilities. It is the only protection that
survives a role-mapping mistake and must not be deferred past the first verification write.
