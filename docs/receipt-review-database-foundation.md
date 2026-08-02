# Receipt review — database foundation (Phase 1C-A)

The database layer that lets a Claim Reviewer see submitted receipts and record one
immutable verdict on each. **Database only.** No Web UI exists yet; Phase 1C-B builds
the queue page and Phase 1C-C the detail and decision page.

## Why review is image-only — decision D1

`public.receipt_submissions` carries a stored image, a shop, a submitter and file
metadata. It carries **no transaction data at all** — no sale date, amount, currency,
merchant or product.

Those values live elsewhere, and both places are empty:

- `public.receipt_confirmations` — entered by the **Retailer**. Zero rows.
- `public.receipt_extractions` — OCR. Zero rows, and `receipt_extraction_runtime.mode`
  is `DISABLED`.

There is also **no receipt-to-product association anywhere in the schema**.

So a reviewer can honestly answer *"is this a legible, plausible receipt?"* and cannot
answer *"does it match a campaign, product or amount?"*. The rejection vocabulary is cut
to exactly the questions the data can answer, rather than offering reasons a reviewer
would have to guess at.

## Why `receipt_confirmations` is not the decision

It is the **Retailer's** statement about their own receipt: `confirmed_by_profile_id` is
the submitting side, `entry_mode` is `MANUAL`/`EXTRACTED`/`MIXED`, and `changed_fields`
records what they edited.

A Vendor's verify/reject is a different fact, asserted by a different party, at a
different trust level. Merging them would make *"the shop says this is the total"* and
*"the Vendor accepts this claim"* indistinguishable — and the existing unique-per-
submission constraint would force them to collide.

A new table, `public.receipt_review_decisions`, holds the verdict.

## Queue eligibility — decisions D6 and D7

A receipt appears in the active queue when **all** of these hold:

1. `status = 'SUBMITTED'` — `RESERVED` has no uploaded file and `UPLOAD_FAILED` has no
   usable one.
2. A row exists in `storage.objects` for its bucket and path.
3. Its Retailer has an **ACTIVE** `vendor_retailers` link to the reviewer's Vendor.
4. No row exists for it in `receipt_review_decisions`.

**D7:** the submitting staff member and the shop are deliberately **not** required to
still be active. A receipt validly submitted by someone who has since left is still a
real claim, and hiding it would strand it forever. Their current state is returned as
context so the UI can label it.

Ordering is `submitted_at ASC, id ASC` (**D2**) — oldest first so nothing starves, with
the id as a total tiebreak so keyset pages cannot repeat or skip a row. Pagination is
keyset with a default page size of 25 and a hard ceiling of 100 (**D9**).

## Tenant isolation

`receipt_submissions` has **no Vendor column**. The only path from a receipt to a Vendor
is:

```
auth.uid()  →  resolve_claim_reviewer_organization(<permission>)  →  vendor_organization_id
            →  vendor_retailers (status = 'ACTIVE')               →  retailer_organization_id
            →  receipt_submissions
```

No function accepts a Vendor id. It is always derived from `auth.uid()` server-side, so
a caller cannot nominate a tenant. The boundary is enforced three times over: in the
resolver, in every query's join, and again by a `BEFORE INSERT` trigger on the decision
table — so even a future bug in a function cannot record a cross-Vendor verdict.

A filter naming a foreign Retailer or shop simply matches nothing; it never reveals
whether that id exists.

## Decision immutability — decision D5

One final decision per receipt, enforced by `UNIQUE (receipt_submission_id)`.

The table is append-only: an unqualified `BEFORE UPDATE OR DELETE` row trigger refuses
both, and a `BEFORE TRUNCATE` statement trigger closes the gap row triggers cannot see.
`TRUNCATE` is additionally revoked from `service_role`, because it bypasses row triggers.

There is **no reopening, correction or superseding in Phase 1C**, and no administrative
update path. A future correction milestone can relax the unique constraint to a partial
index over a `superseded_at IS NULL` predicate without rewriting a single row of
history — which is why the columns already read as an event rather than a mutable
record.

## Rejection reasons — decision D3

| Reason | Note required? |
|---|---|
| `UNREADABLE_RECEIPT` | no |
| `MISSING_REQUIRED_INFORMATION` | no |
| `INVALID_RECEIPT` | **yes** |
| `DUPLICATE_RECEIPT` | **yes** |
| `OTHER` | **yes** |

Deliberately absent: `WRONG_VENDOR_OR_PRODUCT`, `AMOUNT_MISMATCH` and
`RECEIPT_OUTSIDE_ALLOWED_PERIOD`. The data required to judge them does not exist, and
offering them would invite guessing.

Encoded as `text` + `CHECK`, matching every other vocabulary in this schema — not an
enum (painful to extend) and not a reference table (a join for five values).

## Reviewer notes — decision D4

Optional in general, trimmed, at most 500 characters, and **mandatory** for the three
subjective reasons above — those are judgements another person cannot reconstruct from
the code alone, and for `DUPLICATE_RECEIPT` the note is the only place the other receipt
can be identified.

Whitespace-only input is normalised to absent *before* the mandatory-note check, so a
reviewer cannot satisfy the rule with a space bar. A `VERIFIED` decision may carry an
optional note; it is Vendor-internal and never shown to the Retailer.

## Concurrency and idempotency

The whole decision is one transaction inside `decide_claim_receipt`:

1. `SELECT … FOR UPDATE` on the **receipt** — the object two reviewers contend for.
2. Re-check authorization, tenancy and status inside the lock.
3. `INSERT … ON CONFLICT (receipt_submission_id) DO NOTHING`, then read the real
   `ROW_COUNT`. That count is the only signal used — a read-then-write check would have
   a window.

| Situation | Outcome | `changed` | Audit event |
|---|---|---|---|
| First decision | `DECIDED` | true | **1** |
| Same reviewer, identical request repeated | `ALREADY_DECIDED` | false | none |
| Different verdict, reason, note — or a different reviewer | `CONFLICT` | false | none |

`CONFLICT` returns the **original** decision as a row rather than raising, because it is
the expected result of a stale detail page and the UI needs to render "already decided
as X" — which it cannot do from an error. The original is never touched.

The same-reviewer requirement on `ALREADY_DECIDED` matters: without it, a second
reviewer who happened to choose the identical verdict would be told "already decided" as
though it were their own, quietly attributing to them a call they did not make.

## Audit Log

Exactly one event per real decision, written in the same transaction, gated on the real
`ROW_COUNT`.

```
action      : RECEIPT_VERIFIED | RECEIPT_REJECTED
entity_type : RECEIPT_SUBMISSION
entity_id   : receipt_submissions.id::text
organization_id  : the reviewer's Vendor
actor_profile_id : the reviewer's profile
metadata    : { decision, rejection_reason, note_present }
```

The note's **text** is never logged — only whether one exists — because a note can quote
a customer, a name or an amount, and the audit log is readable by anyone holding
`AUDIT_LOGS_READ`. No image URL, bucket, storage path, file hash, submitter identity or
UUID appears in metadata either.

## The private image boundary

The `receipts` bucket is private and `storage.objects` has **zero policies**. This
migration adds none, creates no signed URL, and does not make the bucket public.

`get_claim_review_object_reference(uuid)` is the one place a bucket and path are
returned, and it is **`service_role` only** — revoked from `PUBLIC`, `anon` and
`authenticated`. Phase 1C-C will add a Web Route Handler that authorizes the signed-in
reviewer through the authenticated detail function first, and only then calls this
function through a server-only client to stream the bytes. The browser receives image
data and never a path it could replay.

A signed URL was rejected: it is a bearer capability that outlives the authorization
check and lands in browser history and referrer headers.

## No reward is created

A decision is a decision. It creates no coin, balance, payout, verified sale or reward
contribution — **none of those objects exist**, and this migration creates none.

`receipt_review_decisions` does carry `vendor_organization_id` and `decided_at` so a
later reward engine can join verified claims to campaign versions through the Phase 0
temporal foundation without a schema change. That engine is a separate milestone.

## OCR stays off

`receipt_extraction_runtime` is not touched, so `mode` remains `DISABLED`. No extraction
row is created and no provider is contacted. Phase 1C has no OCR work in it.

## What later milestones own

- **Phase 1C-B** — the queue page: enable the nav item, render the list, loading, empty
  and error states, keyset "load more".
- **Phase 1C-C** — the detail page: the image proxy Route Handler, receipt metadata, the
  verify/reject form with reason and note, conflict handling, post-decision navigation.

Both consume the functions here. Neither needs a schema change.

## Rollback and kill switch

Forward-only, as always: never delete a migration-history row, never edit an applied
migration.

Because everything here is additive and gated behind two new permissions, the fastest
safe kill switch is a reviewed corrective migration deleting the two `role_permissions`
rows. That stops every read and every decision immediately from every path — the
functions resolve through the permission, and the tenant-assert trigger re-checks
`RECEIPT_REVIEW_DECIDE` at the table itself. Decisions already recorded, and their audit
events, survive untouched.
