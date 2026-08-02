# Claim Reviewer receipt queue (Phase 1C-B)

The Web queue that reads the database foundation deployed in Phase 1C-A. **Queue
only.** Opening a receipt, streaming its image and recording a decision are Phase
1C-C.

## What it depends on

Migration `20260819090000` (hosted parity 60/60) and exactly two of its functions:

| Function | Used for |
|---|---|
| `list_claim_review_queue(...)` | the page of receipts |
| `count_claim_review_queue(...)` | the pending total |

Nothing else. `get_claim_review_detail`, `decide_claim_receipt` and
`get_claim_review_object_reference` are **not called** in this milestone.

The reviewer's `RECEIPT_REVIEW_READ` permission is what makes both return rows.

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

### Why there is no Retailer or shop picker yet

`list_claim_review_queue` types its Retailer and shop parameters as `uuid`, but its
**return type carries only display names** — there is no `retailer_id` or `shop_id`
column. So picker options cannot be derived from the queue rows, and no
reviewer-authorized function lists the permitted Retailers and shops. Building one
would need either a database change (out of scope here) or a Vendor Admin RPC the
reviewer must not hold.

Rather than ship a control that cannot work, both id filters remain reachable **by
URL** — the parser validates them and the RPC keeps them tenant-safe — and the
pickers wait for a small follow-up that adds the two ids to the queue function's
output or a dedicated filter-options function.

## What reaches the browser

Shown: Retailer name, shop name and code, shop status, submitter display name,
submitter membership status, submitted time, MIME type (humanized), file size
(humanized), original filename, and a duplicate badge when the same bytes appear more
than once.

Never: storage bucket, object path, `file_sha256`, email, phone, or any profile,
membership or organization id. The RPC does not return them, and the adapter maps
each row **field by field** rather than spreading it, so a column added later cannot
reach a page by accident.

The one identifier that does cross is the receipt submission id, needed for the
Phase 1C-C deep link.

## Loading, empty and error states

**Loading** — a skeleton matching the real geometry (header, filter panel, three
cards). Every placeholder is a neutral block: no fabricated count, name or badge,
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

Neither RPC accepts a Vendor, and neither does this page. The Vendor is derived in SQL
from `auth.uid()` through the Phase 1B resolver. There is no `vendor` query parameter
and no code that could produce one.

A hand-supplied foreign Retailer or shop id is not rejected — it is passed through and
matches nothing, because the candidate set is already constrained to this reviewer's
Vendor. Refusing it would be an existence oracle; matching nothing is the truth.

No service-role client, no Admin client, and no direct table query appears anywhere in
this milestone. All the receipt tables have RLS enabled with zero policies, so
`authenticated` could not read them even if the code tried.

## No reward, no OCR

Nothing here creates or reads a reward, coin, balance or payout — none of those
objects exist. Extraction remains `DISABLED` and is not referenced.

## Next milestone

**Phase 1C-C** — the receipt detail page at `/review/[receiptSubmissionId]`, a
server-side image proxy that authorizes through `get_claim_review_detail` before
streaming from the private bucket, and the immutable verify/reject form backed by
`decide_claim_receipt`. The queue's "Review receipt" action is disabled until then,
and the shell's active-link logic already treats that future route as part of the
queue section.
