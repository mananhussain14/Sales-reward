# Claim Reviewer receipt detail and decisions (Phase 1C-C)

Opening a receipt from the queue, seeing its private image, and recording one
immutable Verify or Reject decision.

**Web only.** This milestone adds no migration, no database object and no SQL
change. Everything it needs was deployed in migrations 60 and 61.

## What it depends on

| Function | Migration | Used by |
|---|---|---|
| `get_claim_review_detail(uuid)` | 20260819090000 | the detail page **and** the image route's authorization |
| `decide_claim_receipt(uuid, text, text, text)` | 20260819090000 | the decision Server Action |
| `get_claim_review_object_reference(uuid)` | 20260819090000 | the image route, service-role only |
| `list_claim_review_queue`, `count_claim_review_queue` | 20260819090000 | the queue (unchanged) |
| `list_claim_review_filter_options()` | 20260819210000 | the queue filters (unchanged) |

## Still image-only, and the page says so

A receipt carries a stored image, a shop, a submitter and file metadata — and **no
transaction data at all**. Every receipt has zero Retailer confirmations and zero
extractions, and extraction is `DISABLED`.

So the page shows no amount, currency, merchant, sale date, product, campaign or
reward eligibility, and it says plainly that these are not recorded for this
receipt and are not part of the decision. It reports extraction availability and
Retailer-confirmation availability as facts rather than rendering an empty
"Transaction details" table — a blank table implies the data should be there and
is merely missing.

## The protected detail route

`/review/[receiptSubmissionId]` — a Server Component.

The id shape is validated **before** any RPC, because PostgREST would otherwise
reject the whole call on the uuid cast. Then one RPC, `get_claim_review_detail`,
called with the ordinary authenticated reviewer client and passed the receipt id
and nothing else. No Vendor, reviewer or membership id is accepted from anywhere;
the database resolves the tenant from `auth.uid()` through the Phase 1B resolver.

**Missing, foreign and unauthorized are one answer.** The RPC returns zero rows
for a receipt that does not exist, one belonging to another Vendor, one whose
Retailer link is no longer `ACTIVE`, and one requested by somebody who is not a
reviewer. All four become `notFound()`, and no Retailer or shop name renders in
any of them. There is nothing here to tell a caller which receipt ids are real.

A **decided** receipt still opens. Decisions live in their own table, so the
receipt keeps `status = 'SUBMITTED'` and the RPC keeps returning it with the
decision columns filled. The page branches on the decision, never on whether a row
came back.

## The protected image route

`GET /review/[receiptSubmissionId]/image` — a Route Handler.

### Authorization before service role, in that order

1. Validate the id's shape.
2. Authorize as the **ordinary signed-in reviewer** via `get_claim_review_detail`.
3. Only on `authorized`, use the service-role client to resolve the object
   reference and read the bytes.

**This ordering is the entire boundary, and it is load-bearing.**
`get_claim_review_object_reference` performs no reviewer check of its own — its
whole body selects the bucket and path for any submitted receipt in any Vendor. It
is safe only because it is granted to `service_role` alone and because it is never
reached until the authenticated check has already passed. Reversing the two calls,
or reaching for bytes on a `not-found`, would be a cross-tenant disclosure.

Every non-authorized status returns before the service-role helper is even
imported into the execution path. A test pins the ordering by source position, and
another pins that the helper has exactly one caller in the whole repository.

### Nothing is taken from the browser but the id

No bucket, object path, MIME type, filename, size, Vendor or reviewer. The id in
the path is an **address the server re-validates**, never a capability.

### Why there is no signed URL

A signed URL is a bearer token in a link. It works for anyone holding it, from any
browser, until it expires — so it survives sign-out, revocation, a copied address
bar and a shared screenshot, and it is invisible to every check this application
makes. Streaming through a route means every byte is served behind a fresh
reviewer authorization, and revoking a reviewer takes effect on the next request
rather than at some future expiry.

That is also why the bucket **stays private with zero storage policies**, and why
no `SELECT` policy was added.

### Response headers

| Header | Value | Why |
|---|---|---|
| `Content-Type` | the **stored** MIME type | server-authoritative; constrained to the three the upload flow accepts, so no stored string is reflected |
| `Cache-Control` | `private, no-store, max-age=0` | per-tenant private data must not outlive the authorization that produced it, in any cache |
| `X-Content-Type-Options` | `nosniff` | without it a browser may sniff bytes as HTML, turning an upload into script on this origin |
| `Content-Disposition` | `inline`, **no filename** | the stored filename is attacker-influenced text; reflecting it invites header injection |
| `X-Frame-Options` | `DENY` | this response is never a document |

The MIME type is checked **before** the download, so an object whose stored type is
not one of `image/jpeg`, `image/png`, `image/webp` is never even read. The read is
bounded by the upload size limit.

### Refusals disclose nothing

Malformed, nonexistent, another Vendor's, not-a-reviewer, object-missing and
unsupported-type all return the **same bare 404 with no body**. `401` is the single
exception, and only because it tells a signed-out browser something it already
knows about itself. No storage error text, object path, bucket name, SQLSTATE or
stack trace ever reaches a response.

`<img>` is used rather than `next/image`: the optimizer caches derivative files on
disk keyed by URL, which would turn a private receipt into a cached artifact served
without any reviewer check.

## What the detail page shows

Retailer name, shop name and code, shop status, submitter display name, submitter
status, submitted time (UTC), filename, humanized MIME type, humanized file size, a
duplicate badge when the same bytes appear more than once, extraction availability,
and Retailer-confirmation availability.

**Never**: Vendor id, Retailer id, shop id, profile id, membership id, Auth id, role
id, storage bucket, object path, `file_sha256`, email, phone or a signed URL. The
RPC does not return most of them, and the adapter maps every row **field by field**
rather than spreading it, so a column added later cannot reach a page by accident.

The only identifier that crosses is the receipt submission id — which is already in
the URL the reviewer is looking at.

## Verify and Reject

The decision is a **radio group**, not two submit buttons: two submits in one form
would let a stray Enter pick whichever the browser considers default, and the
reviewer could never see which. Nothing submits from the main form at all — the
only submit button lives inside the confirmation dialog.

### Rejection reasons

Exactly five: `UNREADABLE_RECEIPT`, `MISSING_REQUIRED_INFORMATION`,
`INVALID_RECEIPT`, `DUPLICATE_RECEIPT`, `OTHER`.

### Reviewer note

Trimmed; whitespace-only is absent, not an empty string; at most 500 characters
measured after trimming, matching the RPC's `nullif(btrim(...), '')` exactly.

| Case | Note |
|---|---|
| `VERIFIED` | optional |
| `UNREADABLE_RECEIPT` | optional |
| `MISSING_REQUIRED_INFORMATION` | optional |
| `INVALID_RECEIPT` | **required** |
| `DUPLICATE_RECEIPT` | **required** |
| `OTHER` | **required** |

The three that require a note each make a factual claim the reviewer cannot support
from the image alone, so the note is where the evidence goes. The requirement is
stated in words next to the field, not signalled by an asterisk alone, and the
character count is shown against the limit.

Web-side validation reproduces the RPC's rules so the reviewer gets a field-level
message. **It is not the gate.** Every rule is enforced again in SQL, and a value
this layer lets through still has to survive the database.

### Confirmation

An accessible dialog (`role="dialog"`, `aria-modal`, labelled and described,
focus moved in on open and back to the trigger on close, Escape closes but never
mid-submit) that names the decision, names the reason, shows the note, and states
that the decision is permanent and cannot be edited, reopened or deleted.

While submitting, every control is disabled, progress is announced, and the single
submit button is disabled by its own loading state so a double click cannot send a
second request.

## Immutability and the three outcomes

`decide_claim_receipt` never overwrites. It inserts `ON CONFLICT DO NOTHING`
against a `UNIQUE` constraint on the receipt, checks the affected row count, and
reports one of three outcomes. All three are **successful calls describing
different truths**, so all three are returned as data, not as errors.

| Outcome | What happened | What the UI does |
|---|---|---|
| `DECIDED` | this call wrote the decision | success message; revalidates `/review` and the detail path; offers Back to queue |
| `ALREADY_DECIDED` | the same reviewer already recorded the identical decision | reported as an idempotent no-op — **not** a failure, and no second decision is created |
| `CONFLICT` | a decision already exists that this call did not make | "This receipt was already decided by another reviewer." Nothing is overwritten, nothing is retried, and the other reviewer's internal id is never exposed |

A transport failure is the fourth case and the only one that is an error: it shows a
retryable message, does **not** mark the form settled, and never implies the
decision succeeded. An outcome the adapter cannot read is treated the same way —
reporting "decided" on an unreadable answer would be the worst available lie.

Revalidation happens **only after an authoritative outcome**. Nothing is rendered
optimistically as final, and the form removes its submit control on `settled`, which
is set only by the database's answer.

### Exactly one Audit Log event, written by the database

The RPC inserts one `RECEIPT_VERIFIED` / `RECEIPT_REJECTED` row in the same
transaction as the decision, guarded by `GET DIAGNOSTICS ROW_COUNT` so a losing
concurrent caller writes none. **The Web writes no audit event.** A second write
would be a duplicate on the happy path and a lie on the conflict path.

## The decided view

Once a decision exists, the form is replaced by a read-only panel: a badge whose
**text** carries the verdict, the rejection reason as a human label, the reviewer
note, the decided time, the deciding reviewer's display name, and a statement that
the decision is final. There is no Edit, Reopen, Delete or Change action anywhere in
this milestone, and a test pins their absence by name.

## Queue integration

The queue's "Review receipt" action is now a real link to
`/review/[receiptSubmissionId]`, with an accessible name that includes the Retailer
and the submitted time so a screen-reader user moving by link knows which receipt
they are opening. The "Soon" badge is gone.

The link carries the receipt id **alone** — no filters, no cursor, no return URL —
and the detail page's Back to queue goes to the bare `/review`. There is no
caller-supplied destination anywhere in the flow, so an open redirect is impossible.

Filters, the pending count and keyset pagination are unchanged. Navigation stays
highlighted on the nested route, which the shell's prefix match already handled.

## No reward, no OCR

Nothing here creates or reads a reward, coin, balance or payout — none of those
objects exist. Extraction remains `DISABLED` and no extraction control was added.

## A VERIFIED decision is not reward eligibility

Phase 1D-0 added a **separate** append-only qualification exclusion, so a receipt
whose image was verified may still be barred from ever becoming a sale — for
example a development screenshot that a reviewer legitimately accepted as legible.
That exclusion never changes the decision recorded here: the verdict on this page
stays exactly as the reviewer left it, and the qualification panel below it answers
the different question of whether the record may proceed. See
`docs/receipt-qualification-exclusions.md`.

## Next

An independent review and merge, then **one separately approved controlled
real-receipt decision** to verify end to end that the decision is immutable, that
exactly one Audit Log event is written, and that the receipt leaves the active
queue. No real receipt was reviewed to completion in this milestone.
