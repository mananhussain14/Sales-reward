# Reward Engine — Phase 0: Temporal Foundation

The historical facts the future campaign-calculation engine will need, preserved before they
are lost. **No reward, coin, balance, claim, payout, receipt-verification or OCR capability
exists in this milestone**, and nothing here computes what anybody has earned.

---

## 1. Why historical state is required

The engine that will eventually turn a verified receipt into coins must answer five questions
about a **past** instant:

| Question | Answered from |
| --- | --- |
| Which campaign version was in force at the sale instant? | `campaign_version_status_history` |
| Was it published, paused or cancelled then? | `campaign_version_status_history` |
| Was the product ACTIVE then? | `vendor_product_status_history` |
| Was the product assigned to that Retailer then? | `vendor_product_retailer_assignment_history` (already shipped, 20260814210000) |
| What UTC instant does the printed shop-local date and time correspond to? | `retailer_shops.timezone_name` + `resolve_sale_instant` |

Before this milestone, three of those five were unanswerable, and the information needed to
answer them was **being destroyed continuously**:

- `campaigns.status` is overwritten in place by `set_vendor_campaign_lifecycle`.
- `campaigns.published_version_id` is overwritten in place by `publish_vendor_campaign`.
- `vendor_products.status` is overwritten in place by `update_vendor_product`.
- `retailer_shops` had no time zone at all, so a civil receipt date could not be compared with
  a `timestamptz` campaign period.

That is why Phase 0 came first. Every pause, resume, cancellation, republish and product
deactivation that happened before these migrations is **permanently unrecoverable**; every one
after them is recorded. Delay had a cost that no other part of the plan had.

`public.audit_logs` was hardened in the same milestone because the reward trail will lean on
it to explain why a coin was credited, and "append-only by design" was a statement about how
the table was used rather than a property of the schema.

---

## 2. The half-open interval convention

Every timeline in this schema — the one shipped in 20260814210000 and both added here — uses
the same shape:

```
[valid_from, valid_to)        valid_to IS NULL means "still in force"
```

and every resolver applies the identical predicate:

```sql
valid_from <= as_of  AND  (valid_to IS NULL OR as_of < valid_to)
```

The instant an interval **begins** is inside it; the instant it **ends** is not. Two adjacent
intervals therefore partition time with no gap and no instant belonging to both. Boundaries are
stamped with `clock_timestamp()` rather than `now()`, because `now()` is frozen for the whole
transaction and two changes inside one transaction would otherwise collide on a single instant.
The maintenance triggers additionally force a strictly increasing boundary, so a zero-length
interval — which the interval `CHECK` would reject, failing an ordinary pause — cannot arise.

> **Consequence for same-transaction readers.** Because boundaries advance on the wall clock, a
> reader inside the same transaction that made a change must ask about `clock_timestamp()`, not
> `now()`. In production this never arises: the engine asks about a verified **sale** instant.

---

## 3. Explicit `as_of` timestamps, and why `now()` is forbidden

Every resolver added here takes the instant as an **explicit argument** and none reads `now()`:

| Resolver | Internal only |
| --- | --- |
| `campaign_version_status_at(campaign_version_id, as_of)` | yes |
| `campaign_versions_in_force_for_retailer_at(retailer_organization_id, as_of)` | yes |
| `vendor_product_status_at(vendor_product_id, as_of)` | yes |
| `resolve_sale_instant(retailer_shop_id, transaction_date, transaction_time)` | yes |

The display-time helpers that already existed — `campaign_derived_state()` and
`campaign_product_eligibility_as_of()` — both read `now()` and are correct for what they do,
which is answer a present-tense question for a screen. A reward must never inherit that:
`campaign_product_eligibility_as_of`'s own header says so, and this milestone supplies the
alternative it points at.

If evaluation used `now()`, the same receipt evaluated twice would produce two different
answers, and a recalculation could not reproduce a historical payment.

**`NULL` means "no authoritative record", never "no".** A resolver that finds no covering
interval returns `NULL`, and that is deliberately *not* collapsed into `INACTIVE`, `CANCELLED`
or `false`. The engine must be able to tell "we do not know" from "it was withdrawn" and
**refuse rather than guess**.

---

## 4. Conservative legacy backfill policy

Both new timelines were backfilled with **one open interval per row, starting at the migration
instant**, marked `history_source = 'BACKFILL_CURRENT_STATE'`. Rows written by the triggers
afterwards are marked `OBSERVED`.

What was deliberately **not** reconstructed:

- **Campaign pause/resume/cancel/republish history.** `campaign_versions.published_at` records
  when a version was stamped, not that the campaign stayed in that state since. A campaign
  published in July, paused in August and resumed in September has a July `published_at`, so a
  `valid_from = published_at` interval would assert a continuous `PUBLISHED` period that is
  false exactly when it matters. `audit_logs` holds a narrative of some transitions, but its
  `organization_id` is `ON DELETE SET NULL` and nothing ever guaranteed it complete.
- **Product ACTIVE/INACTIVE transitions.** `vendor_products.updated_at` records when the row
  last changed, not what it changed from. Using `created_at` would be right for a product never
  toggled and silently wrong for one that was, with nothing in the row to distinguish them.

**The consequence, stated plainly:** a sale that happened before these migrations ran cannot be
evaluated against campaign or product status, and the engine must refuse rather than guess. That
is acceptable precisely because no receipt has ever been verified, no coin has ever been
credited and no campaign result exists — whereas a fabricated interval would be wrong forever
and undetectable afterwards.

The `history_source` marker is what makes the distinction machine-readable rather than a note in
a document.

---

## 5. Confirmed business decisions

These are **approved** and are recorded here for the phases that will implement them.

### 5.1 Campaign cap — per subject

`campaign_rules.max_reward_coins` applies **per subject**, not as one campaign-wide budget:

- `performance_scope = 'INDIVIDUAL_STAFF'` → the cap applies independently to **each Sales Staff
  member**.
- `performance_scope = 'RETAILER_TEAM'` → the cap applies independently to **each Retailer**.

A single global budget would force every evaluation for a campaign to serialize on one row
across all Retailers, making the reward a race that the first receipt verified wins. If a global
budget is ever wanted, it must be a **separate, explicitly named column** with its own documented
serialization, not an overload of this one.

**Nothing in Phase 0 evaluates a cap.** No reward calculation exists yet.

### 5.2 A receipt with a date but no time resolves to noon

When a confirmed receipt carries `transaction_date` but `transaction_time IS NULL`:

- the sale instant is **12:00 local time in the shop's IANA zone**;
- the precision is reported as **`DATE_ONLY`**;
- the noon is **never** presented or stored as a printed time.

**Why noon rather than midnight:** midnight sits on the day boundary, so any offset pushes a
date-only sale into the adjacent day — the very error the civil-date storage exists to avoid.
Noon is the furthest point from both boundaries, so the sale stays on its printed day in every
zone on earth. A second, deliberate benefit: real daylight-saving transitions happen in the small
hours, so the `DATE_ONLY` path is never in a gap and never ambiguous. This is asserted, not
assumed (`sale_instant_resolution_test`, E12–E14).

`DATE_ONLY` and `MINUTE` remain distinguishable even when a receipt genuinely printed 12:00 and
therefore resolves to the same instant. Phase 1 must persist the precision alongside the instant.

### 5.3 Receipt verification is CLAIM_REVIEWER's, alone

When receipt verification is built in Phase 1, the permission is granted to **`CLAIM_REVIEWER`
and to no other role**. It is explicitly **not** granted to `SALES_STAFF`, `RETAILER_OWNER`,
`RETAILER_MANAGER`, `VENDOR_SUPER_ADMIN` or `FINANCE_ADMIN`.

This matters because today the **submitter confirms their own receipt**:
`receipt_confirmations_assert_tenant()` requires
`confirmed_by_profile_id = submitted_by_profile_id`, and `RECEIPT_EXTRACTION_REVIEW` is mapped to
`SALES_STAFF` alone. Attaching coins to a self-confirmed record would let staff mint their own
rewards, so an independent reviewer is a prerequisite for any financial phase.

`CLAIM_REVIEWER` is seeded `ACTIVE` with zero permissions and its seed migration says it "gains
its module-specific permissions only when that module is built". Phase 1 is that moment.

**Phase 0 creates no verification permission, table or workflow.**

### 5.4 Daylight-saving policy — refuse, or ask the reviewer

Approved, and set out in full in **§7**: a **nonexistent** local time refuses verification and
requires the reviewer to correct the printed time or the shop's zone; an **ambiguous** one
requires the reviewer to select the first or second occurrence explicitly, with that selection
and decision persisted. Neither is ever resolved silently.

**Phase 0 continues to fail closed for both** and implements none of the reviewer workflow.

---

## 6. Unresolved shop time zone blocks financial evaluation

`retailer_shops.timezone_name` is **nullable and stays nullable**. Nothing was backfilled:
`iso_country_codes` carries only a `code` column, and a country is not a time zone — the US,
Australia, Brazil, Mexico, Indonesia, Canada, Russia and Kazakhstan each span several. A wrong
zone moves a sale by hours and changes what somebody is paid, so **no row was guessed**.

`resolve_sale_instant` therefore **raises `55000`** for a shop with no zone. It does not fall back
to UTC, to the database server's zone, or to the caller's session zone — each would produce an
instant that looks authoritative and is silently wrong.

**Phase 1 must refuse to verify a receipt, and must refuse any financial evaluation, while the
shop's zone is unresolved**, and must surface it as the actionable operator task it is.

Two further consequences:

- **No RPC writes the column yet.** Phase 0 adds no setter and no UI, so a zone can currently be
  set only by the table owner. Phase 1 must add a Vendor-side setter alongside the reviewer
  workflow.
  **Update:** Phase 1A supplies that setter —
  `public.set_retailer_shop_timezone`, gated on the new `SHOP_TIMEZONE_MANAGE` permission
  mapped to `VENDOR_SUPER_ADMIN` alone. See
  [shop-timezone-management.md](shop-timezone-management.md). It is **not yet deployed**, and
  all four hosted shops remain unresolved.
- **Fixed offsets are refused.** Only Region/City IANA names are accepted (`Asia/Kuwait`,
  `Europe/London`, `Europe/Paris`, `America/New_York`, `America/Argentina/Buenos_Aires`).
  `UTC+3`, `GMT+3`, bare `UTC`, bare `EST` and every `Etc/*` entry are rejected, because a fixed
  offset cannot follow the daylight-saving rules of the place a shop stands.

---

## 7. Daylight saving: both bad cases are refused

PostgreSQL raises for neither problematic local time. For a **nonexistent** one (spring forward)
it silently returns the instant the pre-transition offset would have produced; for an
**ambiguous** one (autumn back) it silently picks an interpretation. Either would embed an
undocumented financial policy — an hour can move a sale across a campaign boundary.

`resolve_sale_instant` detects and refuses both:

| Case | Detection | SQLSTATE |
| --- | --- | --- |
| Nonexistent local time | round-trip `local → instant → local` and compare | `22007` |
| Ambiguous local time | probe whether a neighbouring instant maps to the same local time | `22023` |

The round-trip check is exact and independent of the size of the shift. The ambiguity probe tests
**30 minutes, 1 hour and 2 hours**, which covers every shift in current and historical IANA data
(Lord Howe uses 30 minutes; almost everywhere else uses 1 hour; 2 hours occurs historically). Both
are verified against real 2026 transitions in `Europe/London`, `America/New_York` and
`Australia/Lord_Howe`.

### Confirmed Phase 1 policy — approved

The product decision has been made. **Phase 0 continues to fail closed for both cases**; what
follows is what Phase 1 must build on top of that refusal, and it is recorded here so the
behaviour is not re-litigated later.

**Nonexistent local time (spring-forward gap).**

- **Refuse receipt verification.** There is no instant to record, so there is nothing to
  verify.
- Require the reviewer to correct **either the printed transaction time or the shop's time
  zone** — a gap almost always means one of the two is wrong.
- **Never** silently shift the time forward or backward.

**Ambiguous local time (autumn fall-back).**

- Require the reviewer to **explicitly select the first or the second occurrence**. The system
  does not choose.
- **Persist both the selection and the reviewer's decision** as part of the verification record,
  so a historical payment can be explained afterwards.
- **Never** silently pick the earlier or the later occurrence.

Note that this is deliberately *not* a "resolve by published policy" rule in either direction:
an automatic choice would be invisible in the record, and an hour can move a sale across a
campaign boundary. A reviewer decision is auditable; a default is not.

Phase 1 will therefore need a third precision value alongside `MINUTE` and `DATE_ONLY` — or an
equivalent field recording which occurrence was chosen — plus somewhere to store the reviewer's
decision. **Phase 0 adds neither**, and `resolve_sale_instant` keeps raising `22007` and `22023`
so no caller can proceed without one.

### Remaining limitation

A zone adopting a daylight-saving shift other than 30 minutes, 1 hour or 2 hours would go
undetected by the ambiguity probe and would resolve to PostgreSQL's unstated choice. No such zone
exists in current or historical IANA data; if one ever appears, the probe's interval list is the
single place to widen.

---

## 8. Audit-log append-only hardening

`public.audit_logs` is now append-only in the database.

- **DELETE** — refused for every role, including the owner.
- **TRUNCATE** — refused by a statement-level trigger *and* revoked from `service_role`. Two
  independent defences, because row triggers do not fire on `TRUNCATE` and a privilege can be
  re-granted by a future migration that does not realise what it is undoing.
- **UPDATE** — refused, including a **no-op** update, with exactly one exemption.

### The one permitted update

`audit_logs.organization_id` and `audit_logs.actor_profile_id` are both declared
`ON DELETE SET NULL`. Deleting an auth user cascades to `public.profiles`, and PostgreSQL then
performs an **ordinary UPDATE** on every audit row that named that profile. A guard refusing every
UPDATE would make deleting a user or an organization impossible, breaking a deliberate and already
tested schema decision — *"losing an actor costs the record its attribution, never its existence
or its content"*.

So the guard permits exactly:

| Transition | Permitted |
| --- | --- |
| `organization_id`: value → `NULL` | yes |
| `actor_profile_id`: value → `NULL` | yes |
| either: `NULL` → value (restore) | **no** |
| either: value → different value | **no** |
| any other column | **no** |
| an update that changes nothing | **no** |

### Final privilege matrix — `public.audit_logs`

| Role | SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER | MAINTAIN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `postgres` (owner) | yes | yes | trigger | trigger | trigger | yes | yes | yes |
| `authenticated` | yes¹ | no | no | no | no | no | no | yes² |
| `anon` | no | no | no | no | no | no | no | no |
| `service_role` | no | no | no | no | no | no | no | no |

¹ Further narrowed row by row by `audit_logs_select_authorized`, which is untouched.
² `MAINTAIN` is a PostgreSQL 17 privilege (VACUUM / ANALYZE / REINDEX / CLUSTER). It grants no
ability to read or change a row's contents and was left as-is rather than altered by a migration
whose subject is immutability.
"trigger" means the privilege is held but every statement using it is refused — **the owner is not
exempt**.

### Why the revoke is safe

Verified before writing: **39 INSERT statements across 33 functions, all `SECURITY DEFINER` and all
owned by `postgres`**, so they run with the owner's privileges and no role-level revoke can reach
them. None performs an UPDATE, DELETE or TRUNCATE of `audit_logs`. No Edge Function references the
table. `service_role` held no INSERT and no SELECT beforehand, so there was no direct service-role
audit writer to preserve. The application reads the table through the **user-scoped SSR client**
(`lib/audit/vendor-audit-logs.ts`, `lib/dashboard/vendor-admin-summary.ts`), never as
`service_role`.

---

## 9. What Phase 0 does **not** contain

No receipt-reviewer screens · no receipt-verification tables · no verified sale items · no product
matching · no campaign evaluation · no campaign contributions · no campaign awards · no coin
ledger · no balances · no claims · no payouts · no OCR · no Azure Document Intelligence · no Web
UI · no Flutter change · no Edge Function change · no hosted deployment.

**No reward calculation or coin credit exists anywhere in the system.** The receipt extraction
runtime remains seeded `DISABLED`, and the provider `CHECK` still admits only `'FAKE'`.

---

## 10. Objects added

**`20260816090000_audit_log_append_only_hardening`**
`audit_logs_guard_change()`, `audit_logs_guard_truncate()`, two triggers, one revoke.

**`20260816210000_campaign_version_status_history`**
Table `campaign_version_status_history` (`campaign_id`, `campaign_version_id`,
`lifecycle_status`, generated `is_version_in_force`, `valid_from`, `valid_to`, `recorded_at`,
`history_source`); three indexes; non-overlap and append-only guards; `campaign_status_record_history()`
on `public.campaigns` (INSERT + UPDATE OF `status`, `published_version_id`); conservative backfill;
resolvers `campaign_version_status_at` and `campaign_versions_in_force_for_retailer_at`.

**`20260817090000_vendor_product_status_history`**
Table `vendor_product_status_history` (`vendor_product_id`, `product_status`, `valid_from`,
`valid_to`, `recorded_at`, `history_source`); two indexes; non-overlap and append-only guards;
`vendor_product_record_status_history()` on `public.vendor_products` (INSERT + UPDATE OF `status`);
conservative backfill; resolver `vendor_product_status_at`.

**`20260817210000_retailer_shop_timezone_and_sale_instant`**
Column `retailer_shops.timezone_name`; shape `CHECK`; `retailer_shops_assert_timezone()` on INSERT
and UPDATE; `resolve_sale_instant(uuid, date, time)` returning `(sale_at, timezone_name,
sale_time_precision)`. No backfill, by design.

All five new tables/functions groups are RLS-enabled with **zero policies**, and every new table
revokes all privileges from `public`, `anon`, `authenticated` **and `service_role`**. Every new
resolver is `SECURITY DEFINER`, runs with an empty `search_path`, and is executable by **no browser
role**.

---

## 11. Next step

Review and merge Phase 0 before beginning the **Claim Reviewer and verified-sale** milestone
(Phase 1), which adds the independent reviewer, the canonical verified sale and its items, and
product matching — and which must implement the approved daylight-saving policy recorded in §7
and add the shop time-zone setter described in §6.
