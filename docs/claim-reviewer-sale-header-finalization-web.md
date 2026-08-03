# Claim Reviewer sale-header finalization (Web)

The reviewer-facing half of Phase 1D-A: how a Claim Reviewer reads the immutable
Sales Staff proposal and turns it into one immutable authoritative sale.

Web only. It adds no migration and no SQL, and depends on **migration 63**
(`20260821090000_verified_sale_headers.sql`), which is merged into `main` but
**not deployed to hosted**. Everything below was verified against local Supabase
with synthetic fixtures.

## What the reviewer is actually deciding

Three separate facts now live on the receipt-detail page, and none overwrites
another:

| Panel | Question |
|---|---|
| Final decision | Was the submitted **image** accepted or rejected? |
| Reward qualification | Is this record **excluded** from ever becoming a sale? |
| Authoritative sale | Did a reviewer **accept the staff figures** as a real sale? |

## Accept or decline — nothing here is editable

Every figure shown is the immutable `receipt_confirmations` proposal, rendered
read-only. There is no input for an amount, a date, a merchant or a time.

That is not a UI convention that could drift: the panel has exactly two form
inputs (`receiptSubmissionId` and `dstAmbiguityChoice`), the Server Action reads
exactly those two fields, and `finalize_claim_receipt_sale_header` has no
parameter for any figure. The database copies every value from the proposal and
refuses a row that does not match it byte for byte.

The only judgement the reviewer supplies is **which of two real instants** an
ambiguous local time meant.

## The state matrix

| State | Condition | What the reviewer sees | Finalize offered? |
|---|---|---|---|
| **Unavailable** | context read failed | "temporarily unavailable" | **No** |
| **Blocked by exclusion** | `is_qualification_excluded` | reason in words, decision unchanged | **No** |
| **Waiting for staff** | `has_confirmation = false` | "Waiting for Sales Staff transaction details" | **No** |
| **No time zone** | `time_status = NO_TIMEZONE` | proposal + blocking explanation | **No** |
| **Nonexistent time** | `time_status = NONEXISTENT` | proposal + clock-change explanation | **No** |
| **Ambiguous** | `time_status = AMBIGUOUS` | proposal + two labelled candidates | Only after a choice |
| **Date only** | `precision = DATE_ONLY` | noon-local explanation + UTC preview | Yes |
| **Ordinary minute** | `precision = MINUTE` | zone + UTC preview | Yes |
| **Finalized** | a sale exists | immutable read-only header | **No** |

A failed read is deliberately its own state. It is never interpreted as "no
proposal", "not excluded" or "finalizable" — an unreadable row cannot become an
immutable financial record. The adapter enforces this by returning `unavailable`
whenever a vocabulary is unrecognised, rather than passing an unknown value
through.

### Excluded, and the hosted TEST_DATA receipt

An active qualification exclusion shows the reason in words and offers **no
finalization control at all** — not a disabled one, an absent one. The copy states
that the VERIFIED review decision is unchanged and that reversing the exclusion
is a separate action in the qualification panel that does not itself create a
sale.

When migration 63 is eventually deployed, the hosted development screenshot
classified as `TEST_DATA` will render exactly this state. The database refuses it
independently — under the receipt row lock and again in the table's insert
assertion — so the missing button is a courtesy, not the control.

### Waiting for staff is not a failure

A receipt can be VERIFIED long before its transaction details are entered. The
copy says so plainly and calls it a normal step, because a reviewer who reads it
as a system fault will go looking for a problem that does not exist.

### Date only

Shows the date, states that no time was printed, and explains the resolution:
**12:00 local time in the shop's zone**, so the sale sits on the right day without
claiming a time nobody printed. `DATE_ONLY` is what keeps that visible forever.

### Ambiguous time — the choice that must not be made for the reviewer

PostgreSQL resolves an ambiguous local time silently and picks the **later**
instant. The database refuses to do that, and so does this UI.

Both candidates are shown as explicit UTC instants with plain labels — "First
occurrence… the earlier of the two instants, before the clocks changed" and
"Second occurrence… the later". The values persisted in `verified_sales` are the
words `FIRST` and `SECOND`; those are the only two the database accepts, and the
selection is stored alongside the frozen instant so a later reader can see which
interpretation a person chose. **Neither is preselected** (`checked` is driven by
a state value that starts `null`; there is no `defaultChecked` anywhere), neither
is described as correct, and the confirmation dialog cannot be opened until one is
chosen.

If the reviewer submits without a choice, the database answers
`AMBIGUOUS_TIME_REQUIRES_CHOICE`. That outcome deliberately **does not settle** the
form — it is a question, not an ending — and focus is returned to the choice
controls so it can be answered.

## The final confirmation

Before the immutable write, the dialog states: the reviewer is accepting the Sales
Staff figures; the VERIFIED decision will not change; the sale time and zone are
frozen permanently and a later timezone correction will not move the sale; the
header is append-only and audited and cannot be edited or deleted; an active
qualification exclusion would refuse the write; and no products, campaign, reward
or coins are created. The selected interpretation is echoed back when one applies.

Cancel is always available. There is exactly one submit control in the whole
component, and it lives inside the dialog.

## Settlement — outcome first, refresh second

This is the **second consumer** of the pattern in
`docs/server-action-authoritative-settlement.md`, and it follows it exactly.

1. Submit → controls disabled, "Finalizing sale…", Escape blocked.
2. After a short delay → "Still finalizing. Do not submit again. The result will
   be checked before another attempt." Presentation only: it cancels nothing,
   retries nothing and claims nothing.
3. The RPC returns → the action maps the outcome and **returns immediately**. It
   revalidates nothing, imports no `next/cache`, and never redirects.
4. The panel renders the authoritative sentence.
5. *Only then* it re-reads the route once, via the single allow-listed
   `router.refresh()` call.
6. The immutable header replaces the form.

| Outcome | Settles? | Meaning |
|---|---|---|
| `FINALIZED` | yes | this call created the sale |
| `ALREADY_FINALIZED` | yes | same reviewer, same interpretation, already done |
| `AMBIGUOUS_TIME_REQUIRES_CHOICE` | **no** | the database is asking a question |
| `CONFLICT` | yes | finalized elsewhere, or the selection no longer matches |

### Uncertain results

A transport failure is neither success nor failure:

> We could not confirm whether this sale was finalized. Refresh the sale status
> below before trying again — if it already went through, submitting again will
> not create a second sale.

It never says "nothing was finalized" — a claim the client cannot support, and the
sentence most likely to produce a second attempt at an immutable financial record.
A **Refresh sale status** button is offered instead of a retry.

**There is no automatic retry and no polling anywhere in this flow.**

### Idempotency stays in the database

The client protections — a settled state that short-circuits resubmission,
disabled controls, one submit control, the slow-request warning — reduce the
chance of a second attempt. None of them is the guarantee. That is
`finalize_claim_receipt_sale_header`, which locks the receipt row and answers a
repeat with `ALREADY_FINALIZED` (same reviewer, same interpretation) or `CONFLICT`
(anyone else, or a different interpretation of a frozen instant), creating no
second sale and no second Audit Log.

## Money is formatted from the currency, never guessed

`total_minor` is an integer in a currency's smallest unit, and the number of
decimal places belongs to the **currency**: JPY has none, AED two, KWD three.
Dividing by 100 would render ¥1,000 as ¥10.00.

The panel looks the exponent up in `lib/reference/iso-currency-codes.ts`, a static
ISO 4217 catalogue generated from the same source that seeds
`public.iso_currency_codes` and verified to agree with it row for row. The
receipt-side RPC that returns a minor unit is gated on `RECEIPT_EXTRACTION_REVIEW`,
which belongs to Sales Staff — a Claim Reviewer cannot call it, so the catalogue
is the correct boundary. No table is queried directly and no database field was
added.

If a currency is somehow absent from the catalogue the amount is shown as integer
minor units with an explicit label, rather than scaled by a guess.

## The finalized state

Read-only, with no correction affordance of any kind: the printed date, the frozen
instant and zone, the precision, the persisted interpretation when one applies,
the money, the optional merchant and receipt number, and who finalized it and
when. The copy repeats that the header cannot be edited or deleted, that the
instant will not move if the shop's zone changes, and that no products, campaign,
reward or coins exist for it.

## Accessibility

One live region covers the whole submit lifecycle, so "Finalizing sale…" and the
slow notice are each announced once rather than on a timer. The refresh status is
its own region and says *recorded* — it never reopens the question of the write.
The DST choices are a labelled `fieldset` with a `legend`, each candidate rendered
as a readable UTC instant. The dialog has a title and description, takes focus on
open and returns it to the opener on cancel, and Escape is blocked while
submitting. Every badge carries a word, so no state depends on colour. Long
merchant names, receipt numbers and instants wrap; choices and buttons stack on
narrow screens.

## What this milestone does not do

No product or quantity UI. No campaign evaluation. No reward or coin display. No
migration, no SQL, no Flutter change. Migration 63 remains **pending and
undeployed**, and no hosted sale, confirmation or qualification change was made.

## Next

A fresh hosted backup, a rehearsal of migration 63 in a disposable restore, then
deployment and parity 63/63. Only after that — and only under separate operator
approval — would any hosted finalization be considered.
