# Verified sale header — database foundation (Phase 1D-A)

The first record in this system that says **"this really was a sale"**.

Migration `20260821090000`. One permission, one table, one internal time
inspector, one resolver overload, two read RPCs, one write RPC. No product line,
no campaign evaluation, no reward, coin, ledger, balance or payout — and no Web
UI, which is a separate milestone.

## Two records, two authors, two meanings

`receipt_confirmations` is what **Sales Staff** say the receipt says. It is
already immutable, already one-per-receipt, already tenant-asserted, and it is
gated by `RECEIPT_EXTRACTION_REVIEW`, which belongs to `SALES_STAFF` alone.

`verified_sales` is what a **Claim Reviewer** independently accepted as
authoritative.

Separating them is the whole point: the proposal is evidence, the sale is a
finding, and a finding that could be edited by the person who proposed it is not
a finding.

### Why `receipt_confirmations` is untouched

Three reasons, all decisive:

1. Its rows are already immutable, so a change of ownership could not be applied
   retroactively to rows that already exist.
2. The shipped Flutter Sales Staff feature writes it. Re-owning it would
   invalidate working software for no gain.
3. It is already the right shape for a proposal. What was missing was not a
   different proposal table — it was a *second* record expressing a *second*
   person's judgement.

In this first release the reviewer **accepts or declines**; there is no editing.
Every figure in `verified_sales` is copied verbatim, and the insert assertion
proves the copy field by field.

## Why there is no seller column

The seller is `receipt_submissions.submitted_by_profile_id`: `NOT NULL`, a
`RESTRICT` foreign key to `profiles`, and explicitly frozen by
`receipt_submissions_assert_immutable_on_update`, whose `BEFORE UPDATE OF` list
names `submitted_by_profile_id`, `retailer_organization_id` and
`retailer_shop_id`.

That lineage is stable and unambiguous. Copying a person id into the sale would
create a second answer to a question that already has one — and a second answer
is exactly what drifts.

## The permission

**`RECEIPT_SALE_HEADER_FINALIZE`** (module `CLAIM_REVIEW`), mapped to
**`CLAIM_REVIEWER` and nothing else**.

Not Sales Staff — the entire control is that the proposer is not the finalizer.
Not Vendor Super Admin and not Finance Admin — finalization is a claim-review
judgement about evidence somebody looked at, not an administrative or money
operation.

After this migration `CLAIM_REVIEWER` holds exactly five permissions:
`CLAIM_REVIEW_PORTAL_READ`, `RECEIPT_REVIEW_READ`, `RECEIPT_REVIEW_DECIDE`,
`RECEIPT_QUALIFICATION_CLASSIFY`, `RECEIPT_SALE_HEADER_FINALIZE`.

No separate read permission was added: `RECEIPT_REVIEW_READ` already gates opening
the receipt, and a reviewer who may see the receipt may see whether it became a
sale. That is the precedent `get_claim_receipt_qualification` already set.

## `verified_sales`

| Column | Notes |
|---|---|
| `receipt_submission_id` | **UNIQUE** — one authoritative sale per receipt |
| `receipt_review_decision_id` | lineage: which VERIFIED decision, **UNIQUE** |
| `receipt_confirmation_id` | lineage: which staff proposal, **UNIQUE** |
| `vendor_organization_id`, `retailer_organization_id`, `retailer_shop_id` | tenancy, copied from the receipt |
| `finalized_by_profile_id` | the reviewer, from `auth.uid()` |
| `transaction_date`, `transaction_time` | copied verbatim from the proposal |
| `sale_at`, `timezone_name`, `sale_time_precision`, `dst_ambiguity_choice` | the frozen time answer |
| `currency_code`, `total_minor`, `subtotal_minor`, `tax_total_minor` | copied verbatim |
| `merchant_name`, `document_number` | copied verbatim, both optional |
| `finalized_at`, `created_at` | bookkeeping |

All eight foreign keys use `ON DELETE RESTRICT`: a financial record must never
lose its provenance because a parent row was removed.

Money and text constraints are **identical** to `receipt_confirmations` — the
tests assert the constraint definitions match character for character, so a value
that table accepted can never be one this table refuses. `subtotal + tax = total`
is deliberately **not** required: rounding, discounts and multi-rate tax
legitimately break it, and a false refusal blocks a real sale.

### Lineage uniqueness

`receipt_review_decisions` and `receipt_confirmations` are each already unique per
receipt, so with the unique receipt index the decision and confirmation indexes
can only be violated by a row whose lineage is already wrong — which the insert
assertion refuses. They are added anyway because they cost one index each and they
keep the 1:1:1 lineage true *declaratively*: if a future migration ever loosened
the assertion, the schema would still refuse to attach one reviewer's decision, or
one staff proposal, to a second sale.

### Rejected columns

`qualification_status`, exclusion flag, mutable lifecycle status, campaign id,
campaign result, product id, quantity, reward amount, coin amount, balance, payout
state, `entry_mode`, `changed_fields`, `source_extraction_id`, proposal confirmer,
proposal `confirmed_at`, UTC offset, duplicate local timestamp, timezone database
version and resolution algorithm version.

Each is either derivable, belongs to another immutable object, or belongs to a
later phase. The proposal stays reachable through `receipt_confirmation_id`; the
qualification state stays reachable through `receipt_qualification_is_excluded`.
Copying either would create a second source of truth that can go stale.

## Immutability

RLS enabled with **zero policies**; the table is revoked from `PUBLIC`, `anon`,
`authenticated` **and `service_role`** — the last because Supabase's default
privileges grant `TRUNCATE`, which bypasses row triggers.

A row-level `BEFORE UPDATE OR DELETE` guard and a statement-level
`BEFORE TRUNCATE` guard both raise `check_violation`. There is no administrative
mutation path. Every insertion goes through the finalization RPC.

RLS is enabled explicitly even though the hosted project carries a
platform-managed `rls_auto_enable` event trigger, so local, rehearsal and hosted
agree rather than depending on a platform behaviour this migration does not own.

## Finalization gates

The insert assertion re-checks everything the RPC already checked, at the table,
so a future bug in that function — or a second writer nobody has written yet —
still cannot record an illegitimate sale:

receipt exists and is `SUBMITTED`; the named decision belongs to it and is
`VERIFIED`; the named confirmation belongs to it and its Retailer and shop agree;
the Vendor is an ACTIVE Vendor; an ACTIVE `vendor_retailers` link connects it to
the receipt's Retailer; the finalizer has an ACTIVE membership in that Vendor with
an ACTIVE `CLAIM_REVIEWER` role carrying the finalize permission; the shop belongs
to the receipt's Retailer; **every copied figure equals the proposal**; the frozen
zone, precision and instant are what the date, time and choice actually resolve
to; the currency exists; **there is no active qualification exclusion**; and no
sale already exists.

Deliberately **not** checked: whether the shop or the submitting staff member is
still ACTIVE. A receipt from a shop that has since closed, or a person who has
since left, is exactly the record most likely to still need finalizing, and
refusing it would strand real money.

## Fail closed on qualification

This is the first enforced consumer of the Phase 1D-0 contract.

`public.receipt_qualification_is_excluded(uuid)` is evaluated **inside the
transaction, after the receipt row lock**, in both the RPC and the insert
assertion. A receipt with an unreversed exclusion can never become a sale.

The hosted development screenshot classified as `TEST_DATA` therefore has exactly
one outcome available to it forever: refusal. That is not a policy the UI applies
— it is a condition of the row existing at all.

## Time is resolved once, here, forever

A shop's timezone can be corrected tomorrow. A sale that already happened must not
move when it is. `sale_at`, `timezone_name`, `sale_time_precision` and
`dst_ambiguity_choice` are frozen at finalization and never re-derived.

### Vocabulary

`DATE_ONLY` and `MINUTE`. There is no `DATE_TIME` — the deployed Phase 0 resolver
has always used `MINUTE`, and inventing a third word would put two vocabularies in
one schema.

- **Date only** — no printed time. Resolves to **local noon**, precision
  `DATE_ONLY`, and a DST choice is forbidden. Noon is chosen because real
  transitions happen in the small hours, so noon is never ambiguous or
  nonexistent in practice.
- **Minute** — a printed time, truncated to the minute.

### Nonexistent local times

Refused with `22007`. A local time skipped by a spring-forward transition never
existed, and **a FIRST/SECOND choice cannot rescue it** — the refusal happens
before the choice is even considered.

### Ambiguous local times

**PostgreSQL resolves an ambiguous local time silently, and it picks the LATER
instant.** For a fall-back hour that is a one-hour error in a financial record,
chosen by nobody.

So this system refuses to guess. An ambiguous local time requires an explicit
`FIRST` or `SECOND`, and the word chosen is persisted alongside the instant.

Candidates are enumerated by round-tripping candidate UTC instants back to the
same local timestamp, using the same ±30 minute / ±1 hour / ±2 hour probe set the
deployed Phase 0 resolver already uses — so one-hour transitions, Lord Howe's
30-minute transition and historical two-hour shifts are all covered.
`FIRST` is the minimum valid candidate; `SECOND` is the maximum.

Worked examples proven in the test suite:

| Zone | Local time | FIRST | SECOND | Difference |
|---|---|---|---|---|
| `America/New_York` | 2026-11-01 01:30 | 05:30 UTC | 06:30 UTC | 1 hour |
| `Australia/Lord_Howe` | 2026-04-05 01:45 | 14:45 UTC (04-04) | 15:15 UTC (04-04) | 30 minutes |

An **unnecessary** choice on an unambiguous time is **refused** (`22023`), not
ignored. Accepting it would let a stale page assert an interpretation of a time
that has only one, and a later reader could not tell the assertion was
meaningless.

A shop with no timezone refuses with `55000`. There is no fallback zone — not UTC,
not the server's, not the session's. Each would produce an instant that looks
authoritative and is silently wrong for the place the sale happened.

### The resolver

The existing three-argument `resolve_sale_instant` is **untouched** — same
signature, same body, same grants, same behaviour, same tests. Phase 1D-A adds a
four-argument overload that takes the choice. Both are internal: `PUBLIC`, `anon`
and `authenticated` cannot execute either.

Both, and the read context, ask the same internal `inspect_sale_instant` for the
classification, so they cannot disagree about the same instant. It returns `NULL`
for an unknown shop rather than raising, because a distinguishable error is how a
helper becomes an existence oracle.

## The finalization RPC

```
finalize_claim_receipt_sale_header(p_submission_id uuid,
                                   p_dst_ambiguity_choice text default null)
```

**Two arguments and not one more.** No Vendor, Retailer, shop, staff, reviewer,
membership, decision id, confirmation id, timezone, `sale_at`, timestamp, audit
action, amount, currency, merchant, document number, campaign id, reward value,
return URL or idempotency key. Every one of those is derived here, so a crafted
request cannot assert a single financial fact. The reviewer supplies only a
judgement.

### Transaction order

1. Validate the choice vocabulary.
2. Derive reviewer and Vendor from `auth.uid()` through the Phase 1B resolver.
3. **Lock `receipt_submissions` `FOR UPDATE`** — the same serialization point
   `decide_claim_receipt` and `record_claim_receipt_qualification` use.
4. Recheck receipt status, then the Vendor-to-Retailer link.
5. Recheck the final `VERIFIED` decision.
6. **Recheck the qualification exclusion under the lock.**
7. Read the staff proposal `FOR SHARE` — this function never modifies it and must
   not block a concurrent reader of the same proposal.
8. If a sale already exists, answer `ALREADY_FINALIZED` or `CONFLICT` *before*
   asking the time question, so a retry is never told its irrelevant choice was
   wrong.
9. Freeze the zone and resolve the instant.
10. Insert at most one sale.
11. Insert exactly one Audit Log row, only when the sale was created.

### Outcomes

| Outcome | Meaning |
|---|---|
| `FINALIZED` | this call created the sale (`changed = true`) |
| `ALREADY_FINALIZED` | the same reviewer, same interpretation, already done |
| `AMBIGUOUS_TIME_REQUIRES_CHOICE` | the local time is ambiguous and no choice was given |
| `CONFLICT` | another reviewer finalized it, or a different interpretation was asserted against a frozen instant |

Everything else — missing confirmation, excluded receipt, rejected receipt,
foreign receipt, inactive link, missing role, unsupported currency — raises
`42501` and is **indistinguishable**, so the RPC cannot be used to discover which
receipts exist. Time faults raise `22007`, `55000` or `22023`.

`ALREADY_FINALIZED`, `AMBIGUOUS_TIME_REQUIRES_CHOICE`, `CONFLICT` and every error
write **no sale and no Audit Log**.

## Idempotency and concurrency

Idempotency is **per-actor**, matching Phase 1D-0: the same reviewer retrying gets
`ALREADY_FINALIZED`; a different reviewer gets `CONFLICT`. Neither creates a
second sale or a second Audit Log. The unique receipt index is the backstop under
a race.

pgTAP runs in one transaction and therefore cannot prove a genuine race; the suite
says so in its own output rather than leaving the gap to a report. Four true
two-session races were run against a disposable local database:

| Race | Result |
|---|---|
| Same reviewer, simultaneous finalization | `FINALIZED` + `ALREADY_FINALIZED`; 1 sale, 1 audit |
| Two reviewers, simultaneous finalization | `FINALIZED` + `CONFLICT`; 1 sale, 1 audit |
| **Exclusion commits first** | exclusion recorded; finalization **refused**; **0 sales, 0 audit** |
| **Finalization commits first** | 1 sale, 1 audit; the later exclusion is a separate append-only event |

Both lock orders are therefore defined, and neither produces a partial or
duplicate state. For the hosted `TEST_DATA` receipt an exclusion already exists,
so every attempt fails closed regardless of ordering.

## Audit Log

Exactly one row per real finalization, in the same transaction.

- **Action** `SALE_HEADER_FINALIZED`
- **Entity type** `RECEIPT_SUBMISSION` — the deployed convention is the domain
  aggregate root, and keeping it means one `entity_id` returns a receipt's entire
  history: submission, decision, exclusion, finalization.
- **Metadata keys, exactly:** `sale_time_precision`, `dst_ambiguity_choice`,
  `currency_code`, `source_entry_mode`.

**Never logged:** total, subtotal, tax, merchant name, document number, receipt
filename, image details, bucket, object path, SHA-256, submitting staff identity,
reviewer display name, email, any UUID in metadata, customer data, tokens or
credentials. The sale row itself is the record of the figures; the audit log is
read by everyone holding `AUDIT_LOGS_READ`.

## Safe read RPCs

- **`get_claim_receipt_sale_context(uuid)`** — everything the future reviewer page
  needs *before* finalizing: whether a proposal exists, the proposed figures, the
  entry mode and changed fields, whether the receipt is excluded (and why, to an
  already-authorized reviewer), whether it is already finalized, and the time
  classification with a preview or the two candidates.
- **`get_verified_sale_header(uuid)`** — the immutable header once it exists,
  including the finalizing reviewer's display name.

Both are gated on `RECEIPT_REVIEW_READ`, derive the Vendor from `auth.uid()`,
accept no Vendor or actor argument, and return **zero rows** for missing, foreign
and unauthorized receipts alike. Neither returns a Vendor, Retailer, shop,
profile, membership, role, lineage or event id, bucket, path, hash, email or
phone.

## What Phase 1D-A does not do

No product, quantity or line item. No campaign evaluation. No reward, coin,
ledger, balance or payout. No Web UI. No change to `receipt_confirmations`,
`receipt_review_decisions` or `receipt_qualification_events`.

## Handoff

**Web — delivered.** The Claim Reviewer sale-header context and finalization UI is
built on the two read RPCs and the write RPC and follows the settlement pattern in
`docs/server-action-authoritative-settlement.md`: outcome first, refresh second, no
automatic retry, database-owned idempotency. An excluded receipt shows the excluded
state and offers no finalization action at all. See
`docs/claim-reviewer-sale-header-finalization-web.md`.

**Then (Phase 1D-B):** product items and quantities, attached to
`verified_sales.id`. The header deliberately carries no product column so that
work can add a table without reshaping this one.
