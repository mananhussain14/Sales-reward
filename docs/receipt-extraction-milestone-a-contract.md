# Receipt Extraction and Confirmation — Milestone A

The provider-neutral backend foundation for reading a submitted receipt and confirming its
values. **There is no OCR in this milestone.** The only provider is a deterministic fake, and
the schema enforces that as an invariant rather than a promise.

---

## 1. What this milestone is, and what it is not

Extraction is **strictly additive** and begins only after a receipt is already `SUBMITTED`.
Nothing in `public.receipt_submissions`, its five RPCs, the `submit-receipt` Edge Function,
the `receipts` bucket, the storage path convention, the image-hash duplicate rule or the
MIME/size validation is touched.

**Not in this milestone:** any real document service; raw provider payloads; product matching;
rewards, incentives, campaigns, claims, coins or payouts; a Vendor or Retailer review queue;
PDF or multi-page receipts; offline capture; semantic duplicate signals; automatic image
deletion or erasure.

---

## 2. Provider-neutral architecture

```
request-receipt-extraction ──► request_receipt_extraction   (caller's token)
                           ──► claim_receipt_extraction_job (service role)
                           ──► download object              (service role)
                           ──► provider.submit()            ── the PORT
                           ──► record_receipt_extraction_operation
                           ──► STOPS. The attempt is PROCESSING.

get-receipt-extraction     ──► get_my_receipt_extraction    (caller's token)
                           ──► get_receipt_extraction_worker_state (service role)
                           ──► provider.poll()              ── the PORT, once
                           ──► record_receipt_extraction_success / _failure
```

Everything downstream of `ReceiptExtractionProvider`
(`lib/receipts/receipt-extraction-provider.ts`) is written against the **port**, never against
a concrete provider. Milestone A ships one implementation of it. A later milestone adds a
second and changes nothing else.

**The two-step submit/poll shape is deliberate even though the fake is instant.** A real
document service is submit-then-poll, so modelling the fake as one synchronous call would
leave the `PENDING` branch, the `PROCESSING` state, the claim deadline and the reaper as
untested scaffolding — discovered broken on the day a real provider arrived.
`RECEIPT_EXTRACTION_FAKE_PENDING_MS` therefore defaults to **1500**, not 0: the request
function *never* completes an attempt, and the asynchronous path is the only path there is.

---

## 3. Production is disabled by construction — two independent gates

| Gate | Where | Default | Who can change it |
|---|---|---|---|
| **Database** | `public.receipt_extraction_runtime.mode` | `DISABLED` | a deliberate operator `UPDATE`. **No function at any privilege level writes this column.** |
| **Edge runtime** | `RECEIPT_EXTRACTION_MODE` | absent ⇒ disabled | whoever deploys the function's environment |

`isFakeExtractionEnabled` is an **exact literal comparison** against `"fake"`. Absent, `""`,
`"FAKE"`, `" fake"`, `"1"`, `"true"` and every non-string all fail closed, matching
`isStaffInvitationSendingEnabled` in the shipped invitation function.

**One gate is not a boundary.** `request_receipt_extraction` is granted to `authenticated`, so
a client with a valid session reaches it through PostgREST whether or not any Edge Function is
deployed — which is why the database gate exists. And a database row is one `UPDATE` from
wrong — which is why the Edge gate does too.

**No client input participates in either decision:** no request-body field, query parameter,
header, JWT claim, role, permission, submission id, file hash, filename or MIME type. The
request-body allowlist is exactly `["submission_id"]`, and an unknown key is a **400**, not an
ignored extra.

### Deployment rule

| Artefact | Hosted project | Local / CI |
|---|---|---|
| The four migrations | **deployable** — inert, because the runtime row ships `DISABLED` | applied by `supabase db reset` |
| `receipt_extraction_runtime.mode` | stays `DISABLED` for all of Milestone A | set to `FAKE` by the local harness |
| All three Edge Functions | **not deployed** | served locally |
| `RECEIPT_EXTRACTION_MODE` and friends | never set | set by the local harness |

The Edge Functions are the only component that can manufacture fixture values, so they are
**absent** from the hosted project rather than merely switched off. Consequence: **no Milestone
A UI ships to production**; the Flutter work is built against the local stack and released with
the real-provider milestone.

---

## 4. Five tables

| Table | Purpose |
|---|---|
| `iso_currency_codes` | 165 active ISO 4217 codes and their minor units. Integrity reference for both `currency_code` columns. |
| `receipt_extraction_runtime` | The single-row database gate. Seeded `DISABLED`. |
| `receipt_extractions` | One row per provider attempt. Terminal rows immutable; never deleted. |
| `receipt_extraction_line_items` | Informational, worker-written, written once. |
| `receipt_confirmations` | One immutable confirmation per receipt. |

**`receipt_extraction_payloads` does not exist.** Milestone A stores the normalized extraction,
its line items, per-field source text and confidence, closed failure codes and provider-neutral
operational metadata — and nothing else. No raw payload, no provider HTTP response, no provider
error string, no unstructured receipt-text blob. A retention table without a working purge job
is a liability, and the fake produces nothing worth retaining.

All five: **RLS enabled, zero policies, and every privilege revoked from `public`, `anon`,
`authenticated` *and* `service_role`.** The `service_role` revoke goes one step beyond the
posture the older tables were left in, deliberately: Supabase's default privileges grant `ALL`
on a new `public` table to `service_role`, and revoking only from the browser roles leaves
`REFERENCES`, `TRIGGER` and **`TRUNCATE`** behind. `TRUNCATE` bypasses row triggers, so on these
tables it would defeat the never-delete and immutability guards outright. Every access is
through a `SECURITY DEFINER` function, which runs as the owner and is unaffected.

### Storage

Unchanged. The `receipts` bucket stays private with its existing size and MIME limits. **No new
bucket, no storage policy, no public URL, no listing, no deletion.**

---

## 5. Permission

`RECEIPT_EXTRACTION_REVIEW` (module `RECEIPTS`), mapped to **`SALES_STAFF` and to nothing else**.
Not to Vendor Super Admin, Retailer Owner, Retailer Manager, Claim Reviewer or Finance Admin.

A new code rather than reusing `RECEIPT_SUBMIT` because reuse would couple two lifecycles, and
because **image preview is a genuinely new capability** — reading the object bytes of a stored
receipt is something `RECEIPT_SUBMIT` never implied.

It grants a **capability**, never a **row**. Three independent conditions must hold:

1. `resolve_retailer_member_organization('RECEIPT_EXTRACTION_REVIEW')` resolves — ACTIVE
   profile, membership, role and RETAILER organization, and exactly one qualifying Retailer;
2. `submitted_by_profile_id = auth.uid()` — so a *different* Sales Staff member at the same
   Retailer, holding this identical permission, still sees zero rows;
3. the receipt belongs to the resolved Retailer.

No function in this milestone names a role code. Deactivating the `SALES_STAFF` role revokes the
whole feature with no code change, and the pgTAP suite asserts it.

---

## 6. Thirteen RPCs

**Authenticated (6)** — `authenticated` only; `anon` revoked; **not** granted to `service_role`.

| Function | Returns |
|---|---|
| `assert_my_receipt_extraction_access(uuid)` | `boolean` — the shared authorization predicate |
| `request_receipt_extraction(uuid)` | outcome + attempt counters |
| `get_my_receipt_extraction(uuid)` | the safe client projection |
| `list_my_receipt_extraction_line_items(uuid)` | informational line items |
| `confirm_receipt_extraction(uuid, date, text, bigint, …)` | outcome + derived entry mode |
| `get_my_receipt_confirmation(uuid)` | the confirmation |

**Service-role (7)** — `service_role` only; `public`, `anon` *and* `authenticated` revoked.

`claim_receipt_extraction_job` · `record_receipt_extraction_operation` ·
`record_receipt_extraction_success` · `record_receipt_extraction_failure` ·
`expire_stale_receipt_extraction_claims` · `get_receipt_object_reference` ·
`get_receipt_extraction_worker_state`

All thirteen are `SECURITY DEFINER` with `set search_path = ''`, fully schema-qualified, no
dynamic SQL.

### One authorization predicate

`assert_my_receipt_extraction_access` is the single definition of "may this caller act on this
receipt", and the other five authenticated functions open by calling it. It returns a **bare
boolean**, so no organization id, profile id, shop id, extraction id, bucket or path can leave
it — a structural guarantee rather than a reviewed omission, and the reason the preview path can
prove ownership under the caller's own token while keeping storage coordinates inside
`service_role` entirely.

| Situation | Result |
|---|---|
| unauthenticated, or not an authorized Sales Staff member, or inactive profile/membership/role/Retailer | **42501** |
| unknown id, another member's receipt, another Retailer's, `RESERVED`, `UPLOAD_FAILED`, `null` | **`false`** — byte-identical to each other |
| owned `SUBMITTED` receipt | `true` |

---

## 7. The non-circular worker sequence

A worker cannot supply a provider operation identifier before it has claimed the job, received
the storage reference, downloaded the object and submitted it — so a claim demanding one would
be impossible to call. `claim_receipt_extraction_job` has **no `provider_operation_id`
parameter**, and pgTAP asserts that against the catalogue.

```
claim(extraction, provider, model) → PROCESSING + claim token + storage coordinates
record_operation(extraction, token, operation)      → PROCESSING → PROCESSING, ONCE
record_success / record_failure(extraction, token, operation, …)
```

**Why a token and not re-asserted facts.** `finalize_receipt_submission_upload` defends a stale
callback by re-asserting the hash and path the reservation recorded, which works because that
sequence has no rival. Extraction's threat model *is* a rival: a second worker. Any caller able
to read the row can restate its facts, so re-assertion identifies the **row**, not the
**worker**. Only a nonce issued at claim time does that, and it is generated inside PostgreSQL
by `gen_random_uuid()` — there is no parameter through which a worker could propose one.

**A lost claim is zero rows, not an error.** Losing a race is normal; raising would make every
loser log a fault. An **invalid token raises 23514** — a worker that believes it holds a job
must not proceed on a false belief.

**Status is checked alongside the token, never instead of it.** Every mutating predicate
requires `status = 'PROCESSING'` as well as the matching token. That is what makes a late worker
harmless: after the reaper closes a job, a correct token *and* a correct operation id still
match zero rows and still raise.

### Five permitted transitions, and nothing else

| | Transition | May change — and nothing else |
|---|---|---|
| A | `QUEUED → PROCESSING` | status, provider, provider_model, worker_claim_token, started_at, expires_at, updated_at |
| B | `PROCESSING → PROCESSING` | provider_operation_id, updated_at — **operation registration, exactly once** |
| C | `PROCESSING → SUCCEEDED` | status, completed_at, updated_at, the 24 normalized columns, warning_codes |
| D | `PROCESSING → FAILED` | status, failure_code, completed_at, updated_at |
| E | `QUEUED → FAILED` | status, failure_code = `NEVER_CLAIMED`, completed_at, updated_at — **reaper only** |

"And nothing else" is enforced by a **`to_jsonb` difference over the whole row minus the mutable
set**, so a column added by a future migration is protected automatically rather than only if
somebody remembers to list it.

**Terminal is total.** Once `SUCCEEDED` or `FAILED`, *every* `UPDATE` raises — including an
`updated_at`-only update — and every `DELETE` raises.

That is possible only because `public.set_updated_at()` is **not attached to this table**:
`updated_at` is written explicitly inside each transition. With the trigger attached the guard
would have to tolerate an `updated_at` change on a terminal row, and its correctness would then
depend on alphabetical trigger ordering. Two mechanisms replace that dependency:

- the `to_jsonb` diff is taken against the **final** `NEW`, so whatever ran *before* the guard is
  visible to it and is rejected unless permitted;
- a pgTAP assertion pins the trigger inventory of `receipt_extractions` at **exactly three**
  triggers, one of them this `BEFORE UPDATE` trigger **with no column list** (a column-scoped
  trigger would not fire for `SET updated_at = now()` at all).

---

## 8. Attempt lifecycle and factual counters

```
attempts_used      = count(*) of every persisted row for the submission
attempts_remaining = greatest(0, 3 - attempts_used)
```

**Every persisted row consumes one attempt**, whatever its status or failure code, including
`WORKER_ABANDONED` and `NEVER_CLAIMED`. There is no second counter and no exempt failure, so
`attempt_number` is a dense `1..3` sequence and `check (attempt_number between 1 and 3)` is the
sole structural maximum — a fourth row cannot be inserted at all.

**These two values are facts and are never adjusted to communicate availability.** A disabled
gate, a dead provider and a reaped claim all leave them exactly as the persisted rows make them.
Reporting "0 remaining" for a receipt that has consumed nothing would tell a staff member their
capacity was spent and would be permanently wrong the moment the gate re-opened.

`retry_allowed` is the **only** field that carries availability:

```
database_retry_allowed =
      a latest attempt exists
  AND its status is FAILED
  AND attempts_remaining > 0
  AND no QUEUED attempt exists
  AND no PROCESSING attempt exists
  AND no SUCCEEDED extraction exists
  AND no confirmation exists
  AND receipt_extraction_runtime.mode = 'FAKE'
```

The Edge layer may then only **narrow** it:
`response.retry_allowed = rpc.retry_allowed && isFakeExtractionEnabled(env)`. There is no branch
anywhere that assigns `true`, and the source-safety test asserts it.

### Request branch order

```
1. authorization            → 42501 / zero rows
2. an existing confirmation → ALREADY_CONFIRMED
3. an active attempt        → ACTIVE   (returns the extraction id)
4. a succeeded attempt      → SUCCEEDED (the provider is NOT charged again)
5. three attempts used      → EXHAUSTED
6. runtime mode DISABLED    → EXTRACTION_UNAVAILABLE, nothing written
7. insert                   → QUEUED
```

Steps 2–5 report **existing state** and create nothing, so answering them with the gate shut
leaks no configuration — each is identical either way. Putting the gate above them would mean
that disabling the mode while an attempt was open returned `EXTRACTION_UNAVAILABLE` *without*
the extraction id, leaving the caller unable to scope the reaper and the row stranded against
the active-attempt unique index forever.

### The reaper

`expire_stale_receipt_extraction_claims(p_extraction_id uuid default null)` — the only writer of
`WORKER_ABANDONED` (a stale `PROCESSING` row) and `NEVER_CLAIMED` (a stale `QUEUED` row).

Both open states can strand: a crash between the request and the claim leaves `QUEUED`; a crash
between the claim and completion leaves `PROCESSING`. Either holds the active-attempt index and
would otherwise block that receipt forever. One `expires_at` column serves both — 15 minutes at
insert, reset to 5 minutes at claim, both RPC-controlled literals and never parameters.

**The hot path always passes one exact extraction id**, obtained from a caller-authorized read.
The `NULL` (all-rows) form is reserved for an explicit operator call and a future scheduled
worker: a user-triggered global sweep would be an unbounded write on a request path. The
source-safety test asserts no Edge Function passes `NULL`.

---

## 9. Confirmation

**Required:** `transaction_date`, `currency_code`, `total_minor`.
**Optional:** `merchant_name`, `document_number`, `transaction_time`, `subtotal_minor`,
`tax_total_minor`.

Nine parameters in total. There is **no** parameter for an organization id, shop id, profile id,
membership id, extraction id, entry mode, changed-fields list or duplicate signal — every one is
derived.

**One rule blocks confirmation**, not five: an attempt that is `QUEUED` or `PROCESSING` yields
`EXTRACTION_IN_PROGRESS`, because confirming mid-flight would race the success write. Everything
else confirms — a success, a failure, exhausted attempts, a disabled gate, and no extraction at
all. **Manual confirmation never consults either mode gate.**

| Condition | `entry_mode` |
|---|---|
| no successful extraction | `MANUAL` |
| a successful extraction, every compared value matches | `EXTRACTED` |
| a successful extraction, at least one differs | `MIXED` |

### Comparison rules — `changed_fields` means "a human corrected this"

| Field | Rule |
|---|---|
| `merchant_name` | whitespace-collapsed, compared **case-insensitively**; blank ≡ NULL |
| `document_number` | non-alphanumerics stripped, upper-cased — `INV-2026/004512` ≡ `inv2026004512` |
| `transaction_date` | exact; a `date`, never a `timestamptz` — a printed date is a civil date |
| `transaction_time` | **minute precision** both sides — a provider's `:00` seconds is not a correction |
| `currency_code` | upper-cased, trimmed, FK-checked |
| the three amounts | exact integer equality; **`NULL` is not `0`** — zero tax is a fact, unknown tax is not |

Counting OCR casing or punctuation would make nearly every confirmation `MIXED` and render the
signal useless. `changed_fields` is sorted, so two identical confirmations produce identical
arrays.

**Immutable.** One confirmation per receipt (the unique constraint is the concurrency
authority); no `UPDATE`, no `DELETE`, no revision. A duplicate call returns `ALREADY_CONFIRMED`
with the existing row and **does not compare** the resubmitted values — returning "ok" when they
differ would be a lie, and replacing them is forbidden.

**No duplicate signal.** Deferred: there is no review queue, no reward calculation and no Vendor
or Retailer visibility in this milestone, so a "likely duplicate" flag would be an immutable
claim computed by a rule nobody has agreed, frozen into a table with no correction path. The
existing exact image-hash rule is unchanged and remains the only duplicate protection.

---

## 10. The safe client projection

`get_my_receipt_extraction` returns the latest attempt with per-field value, **source text** and
confidence, plus `currency_minor_unit`, `warning_codes` and `line_item_count`.

**Never returned:** `provider`, `provider_model`, `provider_operation_id`, `worker_claim_token`,
`expires_at`, `storage_bucket`, `storage_object_path`, `file_sha256`, the internal failure code,
`retailer_organization_id`, `requested_by_profile_id`.

The Edge layer builds every response from an **explicit key allowlist**, never a spread, so a
column added by a future migration cannot reach a client until somebody adds it deliberately.

**Source text may exist when the normalized value is NULL** — and that is the important case, not
an edge case. An amount whose decimal separator could not be resolved is stored as a NULL value
with its printed text intact and `AMBIGUOUS_AMOUNT_FORMAT` warned, so the reviewer sees exactly
what was printed and types the figure themselves. No constraint requires a normalized
counterpart to be non-null. Every OCR-derived text column is bounded; none is unlimited.

### Ten stored failure codes, three client codes

| Client code | From |
|---|---|
| `IMAGE_NOT_A_RECEIPT` | `PROVIDER_REJECTED_DOCUMENT` |
| `IMAGE_UNUSABLE` | `UNSUPPORTED_IMAGE` |
| `EXTRACTION_UNAVAILABLE` | the other eight |

Two stored codes describe **the caller's own file** and are actionable — retake the photo. The
other eight describe our infrastructure, where the action is identical in every case, so a finer
distinction buys the caller nothing while telling them whether our provider is healthy, whether a
billing quota is exhausted and whether a storage read failed. That is an availability oracle on
an endpoint every Sales Staff member can call.

---

## 11. Monetary contract

Integer minor units throughout, `bigint`, non-negative, ceiling 10¹². Zero is valid (a fully
discounted receipt is real) and carries `ZERO_TOTAL`.

**No floating point anywhere.** The minor-unit integer is assembled by string concatenation, so
`19.99` becomes the characters `"1999"` and then the integer `1999` — never the double `19.99`
multiplied by 100, which is wrong for a long tail of ordinary values. The parser **never
rounds**: a fraction is only read when it has exactly as many digits as the currency's minor
unit. `receipt-amount-parsing.test.ts` reads the module's own source and fails on `parseFloat`,
`Number(`, `Math.round` or scaling by a power of ten.

**Rule order is load-bearing:**

1. last separator followed by exactly `m` digits (and `m > 0`) → decimal separator;
2. else, followed by exactly 3 digits with every separator the same character → grouping;
3. else, no separator → integer major units;
4. else → **refuse**, with `AMBIGUOUS_AMOUNT_FORMAT`.

Rule 1 before rule 2 is what makes `KWD 12.500` twelve and a half dinars while `JPY 1,000` is one
thousand yen. Guessing wrong between a decimal point and a thousands separator changes the value
by 1000×, silently — so an unresolvable amount is refused, its source text preserved.

Also handled: NBSP/thin-space grouping, Arabic-Indic and Extended Arabic-Indic digits, the Arabic
decimal (`٫`) and thousands (`٬`) separators, currency symbols containing a point, and negatives
(refused with `NEGATIVE_AMOUNT_REJECTED`, never absolute-valued).

**`subtotal + tax = total` is not enforced, not derived, and has no CHECK constraint.** Real
receipts round their lines independently. `SUBTOTAL_TAX_TOTAL_MISMATCH` is a review hint and
never blocks anything.

### ISO 4217 provenance

`iso_currency_codes` and `lib/reference/iso-currency-codes.ts` are **generated from one pinned
input in one run** by `scripts/generate-iso-currency-codes.mjs`.

| | |
|---|---|
| Source | SIX Group, the ISO 4217 Maintenance Agency — the official **active** list (`list-one.xml`) |
| Publication date | **2026-01-01** (the `Pblshd` attribute of the source) |
| Source SHA-256 | `838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9` |
| Entries read | 280 |
| Codes seeded | **165** (0 minor: 17 · 2 minor: 139 · 3 minor: 7 · 4 minor: 2) |
| Excluded | 16 — 13 with a non-numeric (`N.A.`) minor unit, 3 with no currency code |

**The inclusion rule is mechanical:** a code is seeded iff it appears in the active list, is
exactly three uppercase ASCII letters, and its minor unit parses as 0, 2, 3 or 4. There is **no
hand-maintained exclusion list** and **no code is excluded for beginning with X** — `XCD`, `XOF`,
`XAF` and `XPF` are real circulating currencies and are seeded like any other. The metals, fund
and bond codes, `XXX` and the testing code fall out because their minor unit is `N.A.`, without
anyone naming them. Historic entries are never read. The downloaded file is **not** in the
repository; the URL lives in generation documentation only.

---

## 12. Image preview

`receipt-image-preview`, POST, `verify_jwt = true`. Returns exactly
`{status, url, expires_in_seconds}` with `Cache-Control: no-store` and `Pragma: no-cache` —
the body carries a live capability, and a cached copy would outlive the window that bounds it.

**Signed URL, not a byte proxy.** A proxy would push up to 10 MB per view through the runtime,
hold the service-role key on the busiest path in the feature, and defeat the client's image
cache. **TTL: 120 seconds** — long enough for a 10 MB photograph on a poor in-store connection,
short enough that a URL leaked through a log or a screenshot is dead almost immediately.

**The URL is a fetch credential, not a display credential.** The client fetches the bytes once
inside the window and holds the decoded image for the review screen, so expiry is invisible in
normal use. On any fetch failure — or when the app resumes and the image is no longer in memory —
it calls the endpoint again. It must **never** persist the URL to disk, to logs, to an
image-cache key, or to any state that outlives the screen.

**Two RPCs, deliberately split**, so no object path is reachable by `authenticated`:
`assert_my_receipt_extraction_access` runs under the **caller's** token and returns a boolean;
`get_receipt_object_reference` runs under `service_role` and is not executable by any browser
role. This is stricter than the existing `reserve_receipt_submission` precedent, which does
return a bucket and path to `authenticated`.

**Known and accepted:** a Supabase signed URL *addresses* the object, so the bucket and object
path are inside the URL string by construction. That is inherent to the mechanism and is the one
thing the proxy alternative would have avoided. What the contract requires and the tests assert
is that no **separate** bucket, path, MIME or hash field is returned, and that the only
occurrence anywhere in the body is the URL itself. The disclosure is bounded: the path is
`<retailer>/<profile>/<submission>/<random>` — all the caller's own identifiers — and the bucket
is private, so the path alone grants nothing to anyone.

No `getPublicUrl`, no listing, no deletion, no storage policy, no new bucket. `denied` (403) is
reserved for 42501; every unreadable id is `not-found` (404).

---

## 13. Edge Function order — a security property

```
1. method / CORS
2. required server configuration
3. bearer-token extraction
4. auth.getUser() revalidation          ← revalidates with the Auth server
5. strict body parsing
6. assert_my_receipt_extraction_access  ← under the CALLER'S token
7. 42501 → 403 denied  |  false → 404 not-found
8. read existing state, scope-expire, re-read
9. report existing state (no gate consulted)
10. evaluate RECEIPT_EXTRACTION_MODE
11. the first mutation
```

An unauthenticated caller gets **401**, a malformed body **400**, an unauthorized role **403**
and an unreadable receipt **404** — every one of them *before* the mode is consulted. Disabled
mode is indistinguishable from infrastructure unavailability **only** for a caller who has
already proven they may see that specific receipt.

`get-receipt-extraction` returns a `SUCCEEDED` or `FAILED` result **regardless of the gate**:
disabling execution must never hide stored evidence. The gate is consulted only when the attempt
is still open, and only to decide whether to claim, poll or complete.

Every response is built by **re-reading through the caller's own RPC**, never by echoing a
service-role result. No `new Response(` anywhere — the shared `lib/receipts/receipt-cors.ts` is
imported unmodified. Timeouts: 5 s per RPC, 15 s per download. **No automatic retry anywhere** —
retry is the caller's explicit act, the only path that respects the three-attempt cap.

---

## 14. Audit

| Action | Actor |
|---|---|
| `RECEIPT_EXTRACTION_REQUESTED` | the requesting profile |
| `RECEIPT_CONFIRMED` | the confirming profile |
| `RECEIPT_EXTRACTION_CLAIMED` / `_SUCCEEDED` / `_FAILED` | **NULL**, with `"actor_kind": "SYSTEM_WORKER"` |

`audit_logs.actor_profile_id` is nullable, so service work is never falsely attributed to a
person. The metadata discriminator is what makes the null actor *provably* a machine rather than
merely an absent identity.

**Never in metadata:** merchant name, document number, any amount, currency code, receipt text,
object path, file hash, provider operation id, provider error text. Only field **names**, counts
and closed codes. pgTAP asserts the metadata keys against a closed allowlist and that no
fixture's values appear anywhere.

`record_receipt_extraction_operation` writes **no** audit event: its only new fact is the
operation id, which is forbidden metadata.

Two honest limitations: these rows carry the **Retailer** organization id, and
`list_vendor_audit_logs` filters on the **Vendor** — so they do not appear in the Vendor feed in
Milestone A (correct: there is no Vendor review queue). And `list_vendor_audit_logs` already
renders a null actor as `SYSTEM` while noting that value does not prove a machine acted; these
worker rows are the first for which it is literally true.

---

## 15. Local verification

```bash
npx supabase start -x edge-runtime       # the stack, WITHOUT its built-in Edge Runtime
npx supabase db reset                    # 49 migrations
npm test                                 # unit + source-safety tests
npx tsc --noEmit
npm run lint
npm run build
npx supabase test db                     # 18 pgTAP suites
npm run test:extraction:integration      # end-to-end + harness self-checks
npx supabase stop                        # preserves the local volume
```

### `-x edge-runtime` is required, not optional

The integration script **manages `functions serve` itself**, restarting it with different
environments between phases — because the feature is gated by an environment variable, and a
test that could only observe one configuration could not test the thing most likely to be got
wrong. It runs the gate open and shut, the success path, the rejected-document path, retry,
exhaustion, preview, expiry and cross-user denial.

That means the harness must **own** the local `/functions/v1` route. A plain
`npx supabase start` also brings up `supabase_edge_runtime_<project>`, which serves those same
routes; two servers cannot share them. `--exclude` / `-x` is the CLI's supported mechanism for
leaving a service out (`npx supabase start --help` lists `edge-runtime` among the valid names),
so the stack comes up with the database, Auth, Storage, the API gateway and everything else —
just not the function runtime the harness is about to provide.

If something is already answering that route, the script **fails immediately** with a fixed
diagnostic naming the command above. It does not wait out a timeout, does not stop anybody's
container, and does not silently reuse a function server whose environment it did not set — a
run against such a server would report green while testing nothing.

### Restart settling — a property of the local harness, not of the product

Restarting `functions serve` between phases leaves the local API gateway briefly with no
function upstream attached, and a request that lands in that window is answered by the
**gateway**, not by a function. Two harness-only mechanisms absorb it.

**Readiness covers all three routes.** `startServe` waits until `request-receipt-extraction`,
`get-receipt-extraction` *and* `receipt-image-preview` all answer a CORS preflight, on **two
consecutive rounds**, separated by a short pause and bounded by a fixed deadline. A preflight
on one route is not evidence that the others are attached, and a single sample is not evidence
that the one it probed will still be attached a moment later. If the child process this
harness started exits, the wait fails at once rather than timing out against whatever else
might answer.

**One read after a restart may be retried.** Exactly one call — the first request in the
"stays readable with the Edge gate shut" phase, the only application request issued with no
fixture-building between it and the restart — is made through a narrow retry:

| | |
|---|---|
| Retried | a thrown transport error; HTTP **502**, **503**, **504** |
| Never retried | HTTP **500**; 400, 401, 403, 404, 409, 422, 429; any other status; a malformed 2xx; an application error carried on a 2xx |
| Bound | **3 attempts total** (at most 2 retries), fixed 250 ms then 750 ms backoff, no jitter |

502/503/504 are produced by the gateway when no function is attached; the functions themselves
answer 200/400/401/403/404 and nothing else, so retrying those three statuses cannot paper over
a product outcome. **500 is deliberately excluded** — a function that has genuinely broken is
exactly what this suite exists to catch. The retried request is byte-identical on every
attempt: no token is refreshed, no body rebuilt.

**No mutating call is retried.** The retry is applied only to a read whose effect is provably
idempotent in that exact state: the attempt is already `SUCCEEDED` (asserted against the
database in the preceding phase) and the Edge gate is shut, so the function reports stored
state and stops, and the single-id scope-expire it performs matches only `QUEUED` or
`PROCESSING` rows and therefore matches nothing terminal. `request-receipt-extraction` is
never retried, because a second attempt could consume a second of the three.

When one of these assertions does fail, the harness prints a fixed detail — HTTP status, a
closed category (`transport-error`, `transient-gateway`, `application-response`,
`invalid-json`) and the attempt number. Never a body, an id, a token, a key or a URL. The
retry policy itself is proved by self-checks that drive it with an injected fake fetch and
open no socket.

**This is local test-harness resilience and nothing more. The deployed Edge Functions retry
nothing** — no provider call, no database call, no storage read. As §13 states, retry is the
caller's explicit act, the only path that respects the three-attempt cap.

### CLI telemetry is disabled for every harness invocation

The harness runs every `supabase` command with `SUPABASE_TELEMETRY_DISABLED=1` and
`DO_NOT_TRACK=1`. This is a correctness requirement, not a preference. The CLI uploads
analytics to an external endpoint as it exits, and when that upload times out it returns a
**non-zero status even though the command succeeded**:

```
Timeout while shutting down PostHog. Some events may not have been sent.
```

Measured at roughly **one invocation in 120**. Because `psql()` cannot distinguish a failed
statement from a successful one reported badly, it correctly treated that as a failure and
aborted the run with `a database statement failed` — on a statement that had actually run. The
external call is removed rather than the exit status second-guessed, which also means the
suite needs no network access beyond the local stack.

### What the harness guarantees on the way out

On **every** exit path — success, assertion failure, thrown error, `SIGINT`, `SIGTERM` — a
single idempotent cleanup runs before the process ends. It stops the function server **it
started** (and only that: it signals its own child's process group, never a Docker container
and never an unrelated process), restores `public.receipt_extraction_runtime.mode` to
`DISABLED`, and then **reads the row back to verify it**. If that verification fails the script
prints a fixed redacted message and exits non-zero rather than claiming the environment is
safe; the statement to run by hand in that case is:

```sql
update public.receipt_extraction_runtime set mode = 'DISABLED' where id;
```

The mode is always restored to `DISABLED` — never to whatever it happened to be beforehand.
`DISABLED` is the milestone's fail-closed contract, and a local run must not leave the gate
open. Section 9 of the script proves all of this by re-running itself as a child with a fault
injected and with a `SIGINT` delivered mid-run, then inspecting the route and the gate.

Local-only environment, never set in a hosted project:

```
RECEIPT_EXTRACTION_MODE=fake                # absent or anything else = disabled
RECEIPT_EXTRACTION_FIXTURE=CLEAN_AED_2      # one of eight; unknown = refuse, never fall back
RECEIPT_EXTRACTION_FAKE_PENDING_MS=1500     # default; 0 collapses the async shape
```

The eight fixtures: `CLEAN_AED_2`, `JPY_0_MINOR`, `KWD_3_MINOR`, `EUR_DECIMAL_COMMA`,
`MISSING_MERCHANT`, `MISSING_DOCUMENT_NUMBER`, `ROUNDING_MISMATCH`, `REJECTED_DOCUMENT`. A fixture
holds only **source text**; the assembler runs it through the production amount parser, so the
fixtures exercise the real grammar rather than bypassing it.

Unit tests select a fixture by **dependency injection**; integration tests by the environment
variable. Neither grinds an image hash. In Milestone A the file hash is deliberately not plumbed
to the worker, so the hash-bucket fallback in `resolveFakeFixtureKey` is inactive in the Edge
Functions and the default fixture applies when the variable is unset.

---

## 16. Milestone B review items

1. **Infrastructure-failure attempt accounting.** Every persisted row consumes an attempt today,
   including `WORKER_ABANDONED` and `NEVER_CLAIMED`. That is defensible against a free fake
   provider and may not be against a billed one. Revisit **before** real charges are enabled.
2. **The five-minute claim deadline, and the absence of a heartbeat.** Calibrated to a fake that
   resolves in-process. A real asynchronous analyze can legitimately exceed it under load, and a
   fixed deadline would then reap healthy jobs. Re-derive from the real p99, and consider a
   worker heartbeat (`claim_renewed_at`) instead — transition B deliberately cannot extend
   `expires_at` today.
3. **Raw payload retention** and its purge job, together, or not at all.
4. **Semantic duplicate signals**, with the milestone that consumes them.
5. **Vendor and Retailer review access.**
6. **Widening `receipt_extractions_provider_allowed`** beyond `'FAKE'` — a visible, reviewable
   migration, and the moment the no-real-provider invariant is deliberately given up.
