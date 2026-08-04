# Claim Reviewer product decision (Web)

The reviewer-facing half of Phase 1D-B: how a Claim Reviewer reads the immutable
Sales Staff **product proposal** and turns it into one immutable decision —
accept the whole list, or reject the whole list.

Web only. It adds no migration and no SQL, and depends on **migration 64**
(`20260822090000_receipt_product_proposals_and_sale_items.sql`), which is merged
into `main` and deployed. Everything below was verified against local Supabase
with synthetic fixtures; **no hosted product decision or sale item was created.**

## What the reviewer is actually deciding

Four separate facts now live on the receipt-detail page, and none overwrites
another:

| Panel | Question |
|---|---|
| Final decision | Was the submitted **image** accepted or rejected? |
| Reward qualification | Is this record **excluded** from ever becoming a sale? |
| Authoritative sale | Did a reviewer accept the staff figures — **when** and **how much**? |
| Products | Did a reviewer accept the staff product list — **what** was sold? |

Receipt-photo verification stays a separate immutable decision. Accepting or
rejecting the product list never changes it, and the copy repeats that in every
terminal state.

## The whole list, or none of it

The reviewer accepts or rejects the **complete** product list. They cannot edit,
add, remove, replace or reorder a line, and they cannot change a quantity. One
incorrect line means the whole list may be rejected; there is no per-line verdict.

That is not a UI convention that could drift. The panel has exactly three form
inputs (`receiptSubmissionId`, `decision`, `rejectionReason`) and one textarea
(`reviewerNote`); the Server Action reads exactly those four fields; and
`finalize_claim_receipt_sale_items` has **no parameter** for a product, a
quantity, a line number, a snapshot, a sale, a confirmation, a decision, a Vendor,
a Retailer, a shop or an actor. Every authoritative item is copied from the
proposal by the database, and every id is derived there.

There is also no correction flow in this milestone: a rejected proposal cannot be
resubmitted by the Sales Staff member, and no decision can be reopened or
replaced.

## Frozen proposal values versus current catalogue status

Each proposal line carries the product's name, code, barcode, brand and status
**frozen at proposal time**. The panel also shows the product's status *right now*
and whether it is *currently* assigned to that Retailer.

The two are never blended. Each label names which fact it describes:

- `Status when submitted: Active`
- `Current catalogue status: Inactive`
- `Currently assigned to this retailer: No`

Current state is **informational only**. A product deactivated or unassigned after
the proposal does not block acceptance or rejection — the frozen proposal-time
values remain authoritative, the database does not re-check current status when
finalizing, and the decision gate in the panel deliberately does not consult
either field. When a line has changed, the panel says so in words and states that
this does not stop the decision.

An unreadable current assignment renders as *Not available*, never as *No* — the
latter would accuse a Retailer of something unproven.

## The state matrix

| State | Condition | What the reviewer sees | Controls offered? |
|---|---|---|---|
| **Unreadable** | context read failed | "temporarily unavailable" + one manual check | **No** |
| **No proposal** | `has_product_proposal = false` | "No product list was submitted" | **No** |
| **Blocked by exclusion** | `is_qualification_excluded` | proposal read-only + reason in words | **No** |
| **Waiting for sale details** | `has_verified_sale_header = false` | proposal read-only + "finalize the sale details first" | **No** |
| **Ready** | VERIFIED, proposal, header, no exclusion, no decision | proposal + accept and reject | **Yes** |
| **Accepted** | `already_accepted` | authoritative sale items, read-only | **No** |
| **Rejected** | `already_rejected` | reason, note, zero authoritative items | **No** |

A failed read is deliberately its own state. It is never interpreted as "no
proposal", "not excluded", "no decision yet" or "ready" — an unreadable row cannot
become a permanent decision. The parser returns `null` (which the adapter turns
into `unavailable`) whenever a vocabulary is unrecognised, whenever the decision
word and the `already_*` booleans disagree, whenever a rejection arrives without a
reason or a reason without a rejection, whenever a line cannot be read, and
whenever `proposal_line_count` disagrees with the lines actually sent. That last
rule matters most: a reviewer must never accept a list they were shown only part
of.

An unknown decision word failing *open* would be the worst outcome available here
— "not a word I know" becoming "no decision yet" is the one state that renders the
accept and reject controls, on a receipt that already has a permanent decision.

### A sale header is required first

Phase 1D-A must finish before Phase 1D-B can start. A verified sale header answers
*when* and *how much*; this decision answers *what*. Until the header exists the
proposal is shown read-only with an explanation, and no control is offered. The
database enforces the same precondition under the receipt row lock.

A sale header with no accepted products is a **legal intermediate state**. It is
simply not campaign-eligible, and Phase 2A must ask
`receipt_has_finalized_sale_items(...)` rather than infer eligibility from the
existence of a `verified_sales` row.

### A VERIFIED receipt-review decision is required

The panel is mounted only for a receipt whose image decision is `VERIFIED`, for
the same reason the qualification and sale panels are. The database re-checks it
independently and refuses anything else.

### Excluded, and the hosted TEST_DATA receipt

An active qualification exclusion shows the reason in words and offers **no
control at all** — not a disabled one, an absent one. The copy states that the
VERIFIED review decision and the sale header are unchanged and that reversing the
exclusion is a separate action in the qualification panel that does not itself
decide the product list.

The hosted development screenshot classified as `TEST_DATA` renders exactly this
blocked state. The database refuses it independently, under the receipt row lock,
so the missing buttons are a courtesy and not the control.

## Accepting

An explicit **Accept complete product list** action, offered only in the ready
state, opens a confirmation dialog that states:

- every displayed proposal line will become an authoritative sale item;
- the complete list is accepted together;
- the decision is permanent and cannot be reopened, replaced or corrected;
- products and quantities cannot be edited here;
- no campaign is evaluated and no reward or coins are created.

Acceptance submits `p_decision = ACCEPTED` with a **null** rejection reason and a
**null** note. The validator refuses an acceptance that carries either rather than
silently discarding it — quietly dropping a field a client believed in is how a
client comes to believe it set something it did not.

## Rejecting

**Reject complete product list**, also only in the ready state, opens a dialog
requiring one of exactly five approved reasons:

| Code | Label shown |
|---|---|
| `PRODUCT_NOT_ON_RECEIPT` | Product not shown on receipt |
| `WRONG_PRODUCT` | Wrong product selected |
| `QUANTITY_MISMATCH` | Quantity does not match |
| `ILLEGIBLE` | Receipt too unclear to verify products |
| `OTHER` | Other |

The note is **optional** for the four specific reasons and **required** for
`OTHER`, which by definition says nothing on its own. It is trimmed, capped at
**500 characters**, and shown with a live character count and a required/optional
hint. The client rules mirror the database exactly — including measuring length
against the *trimmed* value, so a 500-character note padded with spaces is
accepted by both and a note of 500 spaces is absent to both.

Client validation is a better error experience layered over the real check, never
a replacement for it. If the two ever disagree the database wins and the reviewer
sees the generic refusal.

Before submitting, the dialog states that the complete list will be rejected, that
the receipt-image VERIFIED decision remains separate and unchanged, that the
decision is permanent, and that no correction flow exists in this milestone. A
line-specific rejection cannot be expressed anywhere in the flow.

## Outcomes

| Outcome | Settles? | Changed? | Meaning |
|---|---|---|---|
| `ACCEPTED` | yes | yes | this call created the decision and the items |
| `REJECTED` | yes | yes | this call created the decision; zero items |
| `ALREADY_ACCEPTED` | yes | **no** | same reviewer, same answer, already done |
| `ALREADY_REJECTED` | yes | **no** | same reviewer, same answer, already done |
| `CONFLICT` | yes | **no** | the stored decision is not the one submitted |

There is no sixth successful outcome. A call that returns an unrecognised outcome
string is reported as `unavailable`, never as success — claiming a permanent
decision on an unreadable answer would be the worst lie the write adapter could
tell.

The two `ALREADY_` outcomes are **idempotent successes** and are worded so they
cannot read as a fresh write: "You had already accepted this product list. Nothing
was changed by this request, and no second decision, sale item or Audit Log event
was created."

`CONFLICT` states that the stored decision differs, that nothing was changed, that
the decision cannot be reopened or replaced, and that the panel should be
refreshed. It never names or hints at the other reviewer's identity, and it
carries no identifier.

### Uncertain results

A transport failure is neither success nor failure:

> We could not confirm whether this product decision was recorded. Check the
> product decision status below before trying again — if it already went through,
> submitting again will not create a second decision.

It never says "nothing was recorded" — a claim the client cannot support, and the
sentence most likely to produce a second attempt at a permanent record. A **Check
product decision status** button is offered instead of a retry; it performs a
read-only router refresh and calls no RPC of its own.

**There is no automatic retry and no polling anywhere in this flow.** There is
exactly one `setTimeout` in the panel — the slow-request notice — and zero
`setInterval`. The slow notice is presentation only: it cancels nothing, resubmits
nothing, re-enables nothing and claims no failure.

### Pending and slow

While a request is in flight, both actions, the reason radios, the note field,
Cancel and the submit control are disabled; Escape and backdrop dismissal are
ignored; and the dialog cannot be reopened. The live region reads *Saving the
permanent product decision…*, then after four seconds *This is taking longer than
expected. Do not submit again.*

Once an authoritative answer arrives the controls disappear immediately rather
than lingering until the refresh lands.

### Idempotency stays in the database

The client protections — a settled state that short-circuits resubmission,
disabled controls, one submit control, one form, the slow-request warning — reduce
the chance of a second attempt. None of them is the guarantee. That is
`finalize_claim_receipt_sale_items`, which locks the receipt row and answers a
repeat with `ALREADY_ACCEPTED` / `ALREADY_REJECTED` (same reviewer, same
normalized answer) or `CONFLICT` (anyone else, or any different answer), creating
no second decision, no second item set and no second Audit Log.

## The accepted state is read, not reconstructed

Once a decision is `ACCEPTED` the panel displays the rows returned by
`get_verified_sale_items` — line number, frozen name, code, barcode, brand and
proposal-time status, quantity, decision time and reviewer display name.

It deliberately does **not** rebuild that display from the proposal it was accepted
from. The two are copied byte for byte by the database and triggers forbid either
from being edited, so they will agree; but rebuilding the authoritative record
from the proposal would make the display a claim about what *should* have been
written rather than a report of what *was*.

The read is bounded: one call, issued only when the context says the decision is
accepted, with no polling and no automatic re-read.

## Authorization boundary

Three RPCs, each taking the receipt id and nothing else, each resolving the Vendor
in SQL from `auth.uid()` through the Phase 1B resolver:

| Purpose | Function |
|---|---|
| Read the context | `get_claim_receipt_product_context(p_submission_id)` |
| Record the decision | `finalize_claim_receipt_sale_items(p_submission_id, p_decision, p_rejection_reason, p_reviewer_note)` |
| Read authoritative items | `get_verified_sale_items(p_submission_id)` |

`finalize_claim_receipt_sale_items` has **exactly one production call site**. All
three are called with the ordinary authenticated client; there is no service-role
client anywhere in this milestone. `receipt_confirmation_products`,
`receipt_product_review_decisions` and `verified_sale_items` are revoked from every
browser role and are never queried directly — no `.from(...)`, no `insert`, no
`update`, no `upsert`, no `delete`, no dynamic SQL.

Missing, foreign, unauthorized and wrong-status all collapse into one silent
answer. On the read side that is zero rows and a single `not-found`; on the write
side the database raises the same `42501` for "not a reviewer", "not yours", "not
VERIFIED", "excluded", "no sale header", "no proposal" and "does not exist", and
the adapter merges every one of them into a single `refused`. Neither side can be
used to discover which receipts exist.

Only the SQLSTATE is ever read from a provider error — never `message`, `details`
or `hint`, which name schemas, tables, columns and functions. Every sentence a
reviewer can see is a fixed string from one settlement module, and no adapter logs
anything but a literal.

No Audit Log is written from the Web tier. The database writes
`SALE_ITEMS_ACCEPTED` or `SALE_ITEMS_REJECTED` inside the same transaction as the
decision.

## Accessibility

The panel heading is announced through `aria-labelledby`. Every badge carries a
word — *Products accepted*, *Products rejected*, *Blocked by exclusion*, *No
product list submitted*, *Waiting for sale details*, *Not yet decided* — so no
state depends on colour. Pending, slow, refreshing and error messages are live
regions.

The dialog has a title naming the irreversible act ("Accept the complete product
list permanently?"), a description, `aria-modal`, focus on open and focus returned
to the opener on close — guarded so the first render does not pull focus to the
bottom of the page. The rejection reasons are a labelled `fieldset` with a
`legend`; the note has a `Label`, a described-by character count and a
required/optional hint.

Long product names, codes, brands and barcodes wrap (`break-words`, and
`break-all` for barcodes); the dialog scrolls within the viewport; and the two
actions stack on narrow screens.

## What this milestone does not do

No campaign evaluation. No reward, coin, balance or payout logic of any kind, in
either the code or the copy. No product editing, no reopening, no correction flow,
no line-specific rejection. No migration, no SQL, no schema change, no Flutter
change, no dependency change.

**No hosted write was performed and nothing was deployed.** No hosted product
decision, sale item, sale header, confirmation or qualification change was made,
and no hosted write RPC was called.

## Next

Independent review and merge of this Web PR. After both Flutter PR #24 and this
Web PR are merged, campaign qualification and reward calculation begin — the first
consumer of `receipt_has_finalized_sale_items(...)`, which must be checked
together with `receipt_qualification_is_excluded(...)` rather than in place of it.
