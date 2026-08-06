# Claim Reviewer receipt queue (Phase 1C-B)

The Web queue that reads the database foundation deployed in Phase 1C-A. **Queue
only.** Opening a receipt, streaming its image and recording a decision are Phase
1C-C.

## What it depends on

Migration `20260819090000` (deployed, parity 60/60) plus the follow-up migration
`20260819210000` (pending). Three functions in total:

| Function | Migration | Used for |
|---|---|---|
| `list_claim_review_queue(...)` | 20260819090000 | the page of receipts |
| `count_claim_review_queue(...)` | 20260819090000 | the pending total |
| `list_claim_review_filter_options()` | **20260819210000** | the Retailer/shop picker choices |

Nothing else. `get_claim_review_detail`, `decide_claim_receipt` and
`get_claim_review_object_reference` are **not called** in this milestone.

The reviewer's `RECEIPT_REVIEW_READ` permission is what makes all three return rows.
The follow-up adds **no** new permission and **no** new role mapping.

## Image-only, and the page says so

A receipt carries a stored image, a shop, a submitter and file metadata — and **no
transaction data at all**. `receipt_confirmations` (Retailer-entered) and
`receipt_extractions` (OCR) are both empty, extraction is `DISABLED`, and no
receipt-to-product link exists anywhere in the schema.

So the page shows no amount, currency, merchant, sale date, product, campaign or
reward eligibility, and its description says plainly that they are unavailable.
Displaying any of them would mean inventing them.

The **image itself is also not shown**. The `receipts` bucket is private with zero
storage policies, and the only function that resolves a bucket and path is
`service_role`-only. Streaming it safely is Phase 1C-C's work.

## Queue eligibility and order

A receipt appears when it is `SUBMITTED`, has a real stored object, belongs to a
Retailer with an **ACTIVE** `vendor_retailers` link to the reviewer's Vendor, and has
no decision yet. All four conditions are enforced in SQL, not here.

Order is `submitted_at ASC, receipt_submission_id ASC` — oldest first so nothing
starves, with the id as a total tiebreak.

A receipt whose shop or submitting staff member has since been **deactivated stays in
the queue**; their current state is shown as a badge so the reviewer has context. It
was a valid submission, and hiding it would strand a real claim.

## Pagination

Keyset, page size **25**, no OFFSET and no page numbers.

The adapter asks for **26** rows. If a 26th comes back a further page exists, so the
"Load older receipts" link appears carrying both `cursorSubmittedAt` and
`cursorReceiptId` from the last row rendered, plus every active filter. When fewer
than 26 return, no control appears — the link is never shown pointing nowhere.

A **half-supplied cursor** never reaches the RPC (which would raise `22023`). The page
resets to the first page and says so, rather than silently skipping or repeating rows.

## Filters

Submitted-from and submitted-to are live. Both bounds are **inclusive** and read in
**UTC**: the form submits plain dates, so `from` widens to `T00:00:00.000Z` and `to`
to `T23:59:59.999Z` — otherwise an inclusive "to" of 2 August would stop at midnight
and exclude the whole day. The times shown on each card are UTC for the same reason.

The filter form is a plain `method="get"` HTML form. All state lives in the query
string, so every filtered view is linkable and back-button friendly with no client
JavaScript. Changing a filter deliberately drops the cursor and returns to page one.

### Retailer and shop pickers, and the function that made them possible

`list_claim_review_queue` types its Retailer and shop parameters as `uuid`, but its
**return type carries only display names** — there is no `retailer_id` or `shop_id`
column. So picker options could not be derived from queue rows, and no
reviewer-authorized function listed the permitted Retailers and shops. The first cut
of this milestone therefore shipped the date filters only.

The approved follow-up adds **one** function, `list_claim_review_filter_options()`,
rather than widening every queue row. Putting the two ids on every receipt would have
sent tenant identifiers to the browser once per row for a need that arises once per
render, and would have blurred two different questions: the queue answers *what should
I review next*; this answers *what may I narrow by*.

**Safe ids only.** It returns `retailer_organization_id` and `retailer_shop_id`
because those are exactly the values the queue's filters require, plus the name, code
and status needed to label a choice. No receipt id, profile id, membership id, bucket,
path, hash, email or phone.

**Reviewer- and Vendor-scoped.** It takes no arguments at all, requires
`RECEIPT_REVIEW_READ`, and resolves the Vendor from `auth.uid()` through the same
Phase 1B resolver the queue uses. An unauthorized caller gets zero rows, not an error.

**Derived from currently pending receipts only.** It repeats the queue's eligibility
predicates exactly — `SUBMITTED`, `submitted_at` present, an ACTIVE `vendor_retailers`
link, a real stored object, no decision row. A Retailer with nothing pending never
appears, and deciding a shop's last receipt removes it from the picker, because a
filter that can only return nothing is not a useful choice. A deactivated shop *does*
still appear while its receipt is pending (decision D7), labelled with its state.

The two functions repeat their predicates rather than sharing a helper: a shared SQL
function would have to take the Vendor as an argument, creating an executable surface
that bypasses the permission check. The duplication is pinned instead by a test that
compares the option set against the queue's own output, so drift fails loudly.

**Dependent behaviour.** Choosing a Retailer narrows the shop list to that Retailer,
server-side. A shop that does not belong to the selected Retailer is dropped before
either value reaches the RPC.

**Foreign or stale ids are ignored safely.** If a selected Retailer or shop is not in
the authorized option set — hand-typed, from another Vendor, or simply decided since
the link was made — the page drops it and redirects to a corrected URL, keeping the
dates and dropping the cursor. Nothing distinguishes "not yours" from "nothing
pending": both revert to *All*, so the behaviour cannot be used to probe. This is
presentation honesty, not a security boundary — the database already refuses foreign
data, and an unknown id would have matched nothing regardless.

**No Vendor identity is exposed or accepted** anywhere in the chain.

**If the options fail to load**, the two pickers are *disabled* with retry copy while
the date filters keep working. They are never rendered empty: an empty picker and a
broken one look identical, and only one of them is true.

## What reaches the browser

Shown: Retailer name, shop name and code, shop status, submitter display name,
submitter membership status, submitted time, MIME type (humanized), file size
(humanized), original filename, and a duplicate badge when the same bytes appear more
than once.

Never: storage bucket, object path, `file_sha256`, email, phone, or any profile or
membership id. The queue RPC does not return them, and the adapter maps each row
**field by field** rather than spreading it, so a column added later cannot reach a
page by accident.

Three identifiers do cross, each for a stated reason and none of them personal:

- the **receipt submission id**, on each row, for the Phase 1C-C deep link;
- **`retailer_organization_id`** and **`retailer_shop_id`**, in the filter options
  only, because the queue's filters are typed `uuid` and a picker cannot work without
  them. They are form values, never rendered, and never appear on a receipt row.

## Loading, empty and error states

**Loading** — a skeleton matching the real geometry (header, a four-control filter
panel, three cards). Every placeholder is a neutral block: no fabricated count, name or badge,
because a plausible-looking skeleton value is briefly indistinguishable from real
receipt data.

**Empty, unfiltered** — "No receipts are waiting for review."
**Empty, filtered** — "No receipts match these filters", with a Clear filters action.

**Failed read** — an alert, never an empty state. `rows === null` means the query
failed; rendering that as "nothing waiting" would tell a reviewer their work is done
when it is not. The count chip is also withheld rather than showing a misleading `0`.
No SQLSTATE, table name, function name or provider message reaches the browser, and
only fixed strings are logged server-side.

`unauthorized` and `unavailable` are kept apart: a revoked reviewer goes to the denial
page, a transient fault gets a retry message.

## Tenant isolation

None of the three RPCs accepts a Vendor, and neither does this page. The Vendor is
derived in SQL from `auth.uid()` through the Phase 1B resolver. There is no `vendor`
query parameter and no code that could produce one.

A hand-supplied foreign Retailer or shop id is not rejected — it is passed through and
matches nothing, because the candidate set is already constrained to this reviewer's
Vendor. Refusing it would be an existence oracle; matching nothing is the truth.

No service-role client, no Admin client, and no direct table query appears anywhere in
this milestone. All the receipt tables have RLS enabled with zero policies, so
`authenticated` could not read them even if the code tried.

## No reward, no OCR

Nothing here creates or reads a reward, coin, balance or payout — none of those
objects exist. Extraction remains `DISABLED` and is not referenced.

## Opening a receipt

**Phase 1C-C shipped**, so the queue's "Review receipt" action is now a real link to
`/review/[receiptSubmissionId]` rather than the disabled "Soon" placeholder it was
here. Its accessible name includes the Retailer and the submitted time, because
"Review receipt" repeated down a list tells a screen-reader user nothing about which
receipt they are opening.

The link carries the receipt id **alone** — no filters, no cursor and no return URL
— and the detail page returns to the bare `/review`. Nothing about the queue's
filters, count or pagination changed, and the shell's prefix match already kept this
section highlighted on the nested route.

See `docs/claim-reviewer-receipt-detail-and-decision.md` for the detail page, the
private image route and the immutable decision workflow.
