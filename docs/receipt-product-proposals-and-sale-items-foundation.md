# Receipt product proposals and authoritative sale items (Phase 1D-B)

The database foundation for **what was sold**. Phase 1D-A gave a receipt an
authoritative sale header — when, in which currency, for how much. It said
nothing about the products, because until now nothing in the schema could: no
table anywhere related a receipt to a product.

Database only. No Web UI, no Flutter, no OCR. **Migration 64
(`20260822090000_receipt_product_proposals_and_sale_items.sql`) is not deployed.**

## Three tables, not two

| Table | Holds |
|---|---|
| `receipt_confirmation_products` | the immutable Sales Staff proposal — which products, how many |
| `receipt_product_review_decisions` | one immutable whole-list Claim Reviewer decision |
| `verified_sale_items` | the authoritative lines, created only on acceptance |

### Why the decision table is required

A rejected proposal creates **zero** authoritative items. If the decision lived
only in the item table, "rejected" and "never reviewed" would be the same
observable state — an empty set — and the only record that a reviewer had looked
at all would be an Audit Log.

Audit Logs are evidence. They are not queried for business state anywhere in this
system, and reconstructing a financial decision from them would make the log
load-bearing. So the decision gets its own immutable row, and it is the single
source of truth for accepted, rejected, or never judged.

## The reviewer accepts or declines. They do not edit.

The reviewer cannot add a line, remove a line, change a product or change a
quantity. **One wrong line rejects the whole list.** That is the same shape as the
sale header, for the same reason: a reviewer who can assemble a line set can
assemble a sale, and then the "authoritative" record is an assertion by whoever
reviewed it rather than a finding about what the staff proposed.

There is **no corrected re-proposal** in this milestone. A rejected receipt stays
rejected; a correction would be a separate, separately-audited event that does not
exist yet.

## The rules on a proposal

| Rule | Value |
|---|---|
| Quantity | whole numbers only, **1–100** |
| Lines per receipt | **1–50** |
| Duplicate product | **refused**, never merged |
| Empty list | **refused** |
| Ordering | array order becomes `line_number`, starting at 1 |

Quantity is an `integer`, not `numeric`. These are discrete barcoded SKUs, and an
integer removes every rounding and float-equality argument from later campaign
arithmetic. A decimal, a string, a boolean, `0` and `101` are all refused.

Duplicates are refused rather than summed because two lines for one product is a
mistake worth surfacing — silently merging them would rewrite what the staff
actually asserted.

## Snapshots are copied server-side, never supplied

The browser sends exactly `product_id` and `quantity`. Every piece of product text
on these rows — code, name, barcode, brand, status — is read out of
`vendor_products` by the database. The RPC has no parameter for any of it, an
unknown JSON key is **refused rather than ignored**, and the table's insert
assertion re-reads the catalogue and refuses a row whose snapshot does not match.

The product id stays a real `RESTRICT` foreign key, so identity is never lost; the
text is frozen, so a later rename, rebrand, barcode reassignment or deactivation
cannot rewrite what was sold.

### Proposal-time eligibility, and what happens afterwards

A line may only be created for a product that is **ACTIVE and actively assigned to
the submitting Retailer at proposal time**, checked with the already-deployed
`vendor_product_eligible_for_retailer_at(product, retailer, now())`.

A product deactivated or unassigned **later** does not invalidate the line, and
does not block acceptance. The sale already happened. The authoritative item keeps
`product_status_at_proposal`, and the reviewer's context read returns the frozen
status and the **current** status as separate fields so the divergence is legible
rather than confusing.

## Submission is atomic

`confirm_receipt_with_products` locks the receipt row, validates every line
**before** anything is written, then creates the confirmation, all proposal lines
and the Audit Log in one transaction. One invalid line rolls the header back with
it.

`confirm_receipt_extraction` is **not replaced**. The new function calls it inside
the outer transaction, so its authorization, normalization, changed-field
derivation and `ALREADY_CONFIRMED` behaviour are reused rather than
reimplemented — under a distinct name, never an overload, because two same-named
functions previously broke `regprocedure`-pinned assertions in Phase 1D-A.

### Old header-only confirmations

A confirmation created through the header-only RPC has no proposal and **cannot be
topped up** with one later: the proposal is part of the same immutable staff
assertion, not an afterthought. Attempting it returns `CONFLICT`. Such a receipt
simply never becomes campaign-eligible. (There are zero hosted confirmations
today, so no existing record is affected.)

| Outcome | Meaning |
|---|---|
| `CONFIRMED` | this call created the confirmation and the proposal |
| `ALREADY_CONFIRMED` | the exact same header and the exact same ordered list already exist |
| `CONFLICT` | a different header, a different list, a different order, or a header-only confirmation |

## The decision

| Outcome | Meaning |
|---|---|
| `ACCEPTED` | one decision, and every proposal line copied into `verified_sale_items` |
| `REJECTED` | one decision, and **zero** items |
| `ALREADY_ACCEPTED` / `ALREADY_REJECTED` | same reviewer, same normalized answer |
| `CONFLICT` | a different answer, or a different reviewer — no identity is disclosed |

**Rejection reasons:** `PRODUCT_NOT_ON_RECEIPT`, `WRONG_PRODUCT`,
`QUANTITY_MISMATCH`, `ILLEGIBLE` ("Receipt too unclear to verify products"),
`OTHER`.

**Note rules:** an acceptance carries no reason and no note; a rejection requires a
reason; `OTHER` additionally requires a non-empty note; the note is trimmed and
capped at 500 characters. The note is stored on the decision and is deliberately
**not** copied into Audit Log metadata.

Rejecting the products does **not** change the receipt's `VERIFIED` image
decision, and does not remove its authoritative sale header. Those are separate
questions about the same receipt.

## The header may exist without items

A verified sale header with no accepted items is a **legal intermediate state**. It
is simply not campaign-eligible.

`receipt_has_finalized_sale_items(p_submission_id)` is the only correct way to ask
whether a receipt has a complete accepted item set. It returns true only when an
`ACCEPTED` decision exists, at least one item exists, and every proposal line has
exactly one item and nothing beyond them. It is **internal only** — no browser role
may execute it.

It deliberately does **not** evaluate exclusion. A future campaign engine must
check **both**:

```
receipt_has_finalized_sale_items(id)  AND  NOT receipt_qualification_is_excluded(id)
```

Folding the two together would let a future caller forget one of them.

## Active exclusion fails closed

An active qualification exclusion blocks the proposal, blocks acceptance and
blocks rejection — checked under the receipt row lock **and** again in each table's
insert assertion, so a direct insert cannot bypass it either.

A later exclusion **never deletes or mutates** an existing decision or item. Those
records stay exactly as they were; eligibility is re-evaluated by whoever asks the
question, not by rewriting history. The hosted `TEST_DATA` receipt is the standing
test of this rule and must never qualify.

## Authorization

| Permission | Module | Role |
|---|---|---|
| `RECEIPT_PRODUCT_PROPOSE` | `RECEIPTS` | `SALES_STAFF` only |
| `RECEIPT_SALE_ITEMS_FINALIZE` | `CLAIM_REVIEW` | `CLAIM_REVIEWER` only |

Reviewer reads reuse the existing `RECEIPT_REVIEW_READ`. `RECEIPT_EXTRACTION_REVIEW`
is **not** overloaded — it means "review OCR output", a Sales Staff act in a
disabled subsystem.

Holding `RECEIPT_PRODUCT_PROPOSE` alone grants nothing: the combined RPC still
enforces the existing header-confirmation authorization, so the new permission can
never become a back door to writing a transaction date, time or amount.

Every Vendor and Retailer identity is derived in SQL from `auth.uid()`. No browser
input carries a Vendor, Retailer, shop, actor, reviewer, sale, confirmation or
decision id. A historical inactive shop and a departed submitting staff member
both remain decidable — refusing them would strand exactly the records most likely
to need judging.

**Oracle safety:** missing, foreign, unauthorized, inactive Vendor link, rejected
image, missing confirmation, missing proposal, missing header and active exclusion
all raise the same refusal or return zero rows. None of them can be used to
discover whether a receipt exists.

## Storage posture

All three tables have RLS **enabled with zero policies**, and every direct
privilege is revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`.
The only path to these rows is the SECURITY DEFINER functions, each with
`search_path = ''` and no dynamic SQL. Every table carries a row-level
UPDATE/DELETE guard, a statement-level TRUNCATE guard and an insert assertion.

## Concurrency

The **`receipt_submissions` row** is the serialization point, the same one
`decide_claim_receipt`, `record_claim_receipt_qualification` and
`finalize_claim_receipt_sale_header` already lock. Verified with genuine
two-session harnesses against a disposable database:

| Race | Result |
|---|---|
| Same staff, same input | `CONFIRMED` + `ALREADY_CONFIRMED`; one confirmation, one proposal, one Audit Log |
| Same receipt, different line sets | `CONFIRMED` + `CONFLICT`; one winning proposal |
| Same reviewer accepting twice | `ACCEPTED` + `ALREADY_ACCEPTED`; one decision, one item set, one Audit Log |
| Two reviewers | `ACCEPTED` + `CONFLICT`; one decision, one item set, one Audit Log |
| Exclusion commits first | finalization refused; zero decisions, zero items, zero Audit Log |
| Acceptance commits first | decision and items stand; the later exclusion is a separate immutable event |
| Product deactivated mid-review | acceptance still succeeds; the frozen status stays `ACTIVE` while the catalogue reads `INACTIVE` |

## Audit Logs

Exactly three actions, each written once per real state change and never on an
idempotent retry or a conflict:

| Action | Organization | Actor | Metadata |
|---|---|---|---|
| `RECEIPT_PRODUCTS_PROPOSED` | Retailer | Sales Staff | `line_count`, `total_quantity`, `distinct_product_count` |
| `SALE_ITEMS_ACCEPTED` | Vendor | Claim Reviewer | `line_count`, `total_quantity` |
| `SALE_ITEMS_REJECTED` | Vendor | Claim Reviewer | `rejection_reason`, `line_count` |

Entity type is `RECEIPT_SUBMISSION` and entity id is the receipt id, matching the
existing convention. Metadata carries **no** product UUID or code list, no amount,
merchant, document number, filename, storage path, hash, email, free-form note,
campaign data or reward data.

## What this milestone does not do

No campaign is evaluated. No reward, coin, ledger, balance or payout exists or is
referenced. No OCR is involved and receipt extraction remains **DISABLED**. No Web
or Flutter code was written.

## Next

Independent review and merge of the migration-64 PR. After merge: a fresh hosted
backup, a rehearsal of migration 64 in a disposable PostgreSQL 17 restore, then
deployment and parity 64/64 — each a separate, separately-approved step.

The Flutter staff flow (turning the existing read-only eligible-products section
into a selection surface with quantities) and the Claim Reviewer Web panel both
depend on that deployment and are separate milestones afterwards. **No hosted
proposal, decision or sale item may be created without separate operator
approval.**
