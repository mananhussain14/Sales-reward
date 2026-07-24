# Sales Staff receipt submission — audit and mobile contract

**Milestone:** `feature/mobile-receipt-submission-backend`
**Scope:** the smallest complete, secure backend contract that lets an authenticated
Sales Staff user submit a receipt from the Flutter client.
**Status of the Flutter repository in this milestone:** not modified.

This document is in two halves. **Part A is the audit** — what already exists, verified
against the installed migrations, before anything was changed. **Part B is the delta** —
the three additions this milestone makes and the reasoning behind each.

---

## Part A — the installed end-to-end flow

```text
authenticated Sales Staff
  └─ get_my_portal_context()                      [20260729090000]  authenticated
     └─ trusted Retailer and membership resolution
        └─ resolve_retailer_member_organization('RECEIPT_SUBMIT')
                                                  [20260723090000]  internal only
           └─ shop assignment validation
              ├─ list_my_assigned_receipt_shops() [20260726210000]  authenticated
              └─ re-proven inside reserve, FOR SHARE
                 └─ allowed product resolution
                    └─ ✗ NOTHING EXISTS          ← GAP 1
                       └─ storage object ownership
                          └─ path generated in SQL by reserve; bucket private,
                             storage.objects RLS on with ZERO policies
                             → service_role is the only writer  ← GAP 2
                             └─ receipt record creation
                                ├─ reserve_receipt_submission(…)   authenticated
                                ├─ upload                          service role
                                └─ finalize_receipt_submission_upload(…)
                                                                   service_role
                                   └─ initial status
                                      RESERVED → SUBMITTED | UPLOAD_FAILED
                                      └─ view own result
                                         list_my_receipt_submissions()
                                                                   authenticated
```

### A.1 Trusted context

`public.get_my_portal_context()` (migration `20260729090000`) returns `jsonb`, is granted
to `authenticated` only, and resolves everything from `auth.uid()`. For a Sales Staff
member it yields:

```json
{
  "context_version": 1,
  "portal_kind": "SALES_STAFF",
  "vendor": null,
  "retailer": {
    "kind": "SALES_STAFF",
    "organization_id": "…",
    "organization_name": "…",
    "capabilities": { "submit_receipts": true, … }
  }
}
```

`capabilities.submit_receipts` is literally `resolve_retailer_member_organization(
'RECEIPT_SUBMIT') is not null` — the same fact the submission RPC re-derives when called,
so the hint and the operation cannot disagree. **Nothing was missing here.**

### A.2 Retailer and membership resolution

`public.resolve_retailer_member_organization(text)` (`20260723090000`) evaluates the whole
chain in one SQL statement: ACTIVE profile owned by `auth.uid()`, ACTIVE membership, ACTIVE
`RETAILER` organization, ACTIVE role reached through that membership, and the named
permission. It **fails closed** — `where (select count(*) from qualifying) = 1` returns
`NULL` for zero *and* for more than one qualifying Retailer.

It is granted to no browser role; it is reachable only from `SECURITY DEFINER` functions
that run as its owner.

> Carried forward unchanged: the multi-membership fail-closed behaviour is the documented
> blocker for account switching (`docs/mobile-backend-contract.md` § 6.5). It is a product
> question, not a defect, and this milestone does not touch it.

### A.3 The authorization root

`RECEIPT_SUBMIT` (`20260726090000`) is mapped to `SALES_STAFF` **and to no other role**.
That single mapping is what makes receipt submission a Sales Staff capability: a Retailer
Owner or Manager resolves `NULL` and is refused. No receipt operation anywhere names a role
code.

### A.4 Shop assignment validation

`public.list_my_assigned_receipt_shops()` — `authenticated`, **zero arguments**. There is
no Retailer id, membership id or profile id to pass, so nothing in a request can nominate
whose shops are returned. Joins `organization_members` → `retailer_shop_members`
(`removed_at is null`) → `retailer_shops` (`status = 'ACTIVE'`), all scoped to the resolved
Retailer.

An unauthorized caller gets an exception (`42501`), not an empty list — "denied" and
"you have no shops yet" are different facts.

The same four conditions are re-proven inside `reserve_receipt_submission`, which
additionally takes `FOR SHARE` on the shop row so it cannot be deactivated between the
check and the insert. Every addressing failure — unassigned, inactive, another Retailer's,
or nonexistent — raises one byte-identical message, so the RPC cannot be used to probe
another Retailer's estate one id at a time.

### A.5 Allowed product resolution — **GAP 1**

There is nothing. `public.list_retailer_assigned_products()` (`20260727210000`) requires
`RETAILER_PRODUCTS_READ`, which `20260727090000` maps to `RETAILER_OWNER` and
`RETAILER_MANAGER` only. Sales Staff was excluded deliberately, and that migration says so
in a comment:

> *"SALES_STAFF is absent, so a Sales Staff member cannot enumerate the catalog assigned to
> their Retailer. A future receipt-matching operation will need its own narrowly-scoped
> access, and giving it this broad read now would be exactly the over-exposure to avoid."*

This milestone is that future operation. See § B.1.

### A.6 Storage object ownership — **GAP 2**

The object path is generated **in SQL**, by `reserve_receipt_submission`:

```text
<retailer_organization_id>/<auth.uid()>/<submission_id>/<random uuid>.<ext>
```

Every segment is derived; none is supplied. The extension is mapped from the *validated*
MIME type, never from the uploaded filename. `receipt_submissions_object_path_unique_idx`
makes a collision impossible rather than merely unlikely.

The `receipts` bucket is `public = false`, capped at 10 MiB, and restricted to
`image/jpeg | image/png | image/webp`. **`storage.objects` has RLS enabled with zero
policies**, so `anon` and `authenticated` can neither read nor write an object — only a
service-role client can.

That is the correct posture and this milestone preserves it. It is also precisely why a
Flutter client cannot complete a submission on its own: steps 2 and 3 of the sequence need
a key that must never reach a device. See § B.2.

### A.7 Receipt record creation and initial status

`public.receipt_submissions` (`20260726090000`) is metadata only — no `bytea`, no base64,
no large-object reference. RLS is on with **zero policies** and no privilege is granted to
`anon` or `authenticated`, so every read and write goes through a definer RPC.

| State | Meaning |
| --- | --- |
| `RESERVED` | the row exists; it claims nothing about an object |
| `SUBMITTED` | the object is in the bucket and every reserved fact still matches |
| `UPLOAD_FAILED` | the upload did not complete; the same file may be retried immediately |

Guarantees already in place, all verified in the migration source:

- **Immutability.** `receipt_submissions_assert_immutable()` refuses any update that moves a
  row to another Retailer, shop, submitter, file hash, bucket or path.
- **Cross-tenant shop check.** `receipt_submissions_assert_shop_retailer()` fires `BEFORE`
  the foreign keys, so it can deny an id no row owns.
- **Duplicate protection.** `receipt_submissions_active_hash_unique_idx` on
  `(retailer_organization_id, submitted_by_profile_id, file_sha256) WHERE status <>
  'UPLOAD_FAILED'` — scoped to the submitter deliberately, because a global hash index would
  turn any upload into an oracle for whether a stranger had submitted the same image.
- **Finalize is `service_role`-only.** Reachable by a browser role it would let anyone who
  learned a submission id mark a receipt complete without uploading anything.
- **No provider text is ever stored.** `record_receipt_submission_upload_failure` takes no
  error string; the classification is a fixed literal chosen inside the function.

### A.8 Viewing the result

`public.list_my_receipt_submissions()` — `authenticated`, zero arguments, filtered on both
`submitted_by_profile_id = auth.uid()` **and** the resolved Retailer. It deliberately
withholds `storage_bucket`, `storage_object_path`, `file_sha256`,
`submitted_by_profile_id`, `retailer_organization_id` and `failure_code`.

The submitter's own history is therefore already readable. There is **no single-row read**,
and **no image retrieval path anywhere in the codebase** — no signed URL, no download RPC,
no storage policy.

### A.9 Audit verdict

The installed receipt operations are **not incomplete**. They are complete and sound for a
server-mediated web client. Exactly two things block the Flutter client, and one thing is a
mobile ergonomics gap:

| # | Finding | Severity |
| --- | --- | --- |
| 1 | No Sales Staff-scoped product read exists | blocking (goal item 2) |
| 2 | Upload + finalize require the service-role key; no mobile-reachable entry point | blocking (goal items 3–5) |
| 3 | No single-submission read; the client must fetch the whole history after each submit | ergonomics (goal item 6) |

**No security or correctness defect was found in the deployed receipt schema.** Nothing in
Part B alters an existing table, column, constraint, index, trigger, policy, permission,
role mapping or function. No previously applied migration is edited.

---

## Part B — the delta

### B.1 `list_my_receipt_products()` — the scoped product read

Migration `20260730090000`. Adds permission `RECEIPT_PRODUCTS_READ`, mapped to
`SALES_STAFF` **alone**, and one function:

```sql
public.list_my_receipt_products()
returns table (product_id uuid, product_code text, barcode text,
               product_name text, brand text)
-- authenticated, 0 arguments
```

**Why a new permission rather than adding `SALES_STAFF` to `RETAILER_PRODUCTS_READ`.**
Adding the role to the existing mapping would widen `list_retailer_assigned_products()` —
an already-deployed function that also returns `description` and `assignment_status` — for
every Sales Staff member at once, silently, as a side effect of a mapping change. A separate
permission means the two reads can never drift into each other, and revoking one does not
touch the other.

**Why the columns are narrower than the Owner/Manager read.** `description` and
`assignment_status` are catalogue-administration data. A receipt submitter needs to
recognise and identify a product, which `product_code`, `barcode`, `product_name` and
`brand` do completely.

**Both sides must be live:** an `INACTIVE` product and a withdrawn assignment are each
enough to hide a row — identical to the Owner/Manager read.

**Nothing about the Vendor is returned:** no Vendor organization id, no Vendor name, no
creator, no audit metadata, no assignment id, and no other Retailer's data.

**`receipt_submissions` is unchanged.** No product is attached to a submission. Receipts and
products are related only in the future OCR/matching step, and inventing the link table now
would fix a shape before the requirement is known.

**`get_my_portal_context()` is not modified.** `RECEIPT_PRODUCTS_READ` and `RECEIPT_SUBMIT`
are both mapped to `SALES_STAFF` alone, so the existing `capabilities.submit_receipts` hint
already tells the client both facts. Adding a key would change a deployed function's output
for no new information.

### B.2 `get_my_receipt_submission(uuid)` — the single-row read

Same migration. Signature, column names, column order and withheld fields are **byte-identical
to `list_my_receipt_submissions()`**, so one Dart model class deserializes both:

```sql
public.get_my_receipt_submission(p_submission_id uuid)
returns table (submission_id uuid, shop_name text, shop_code text, status text,
               original_file_name text, mime_type text, file_size_bytes bigint,
               submitted_at timestamptz, created_at timestamptz)
-- authenticated
```

Filtered on `submitted_by_profile_id = auth.uid()` **and** the resolved Retailer, exactly
as the list is. An id belonging to somebody else returns **zero rows** — not an error —
because a distinguishable refusal would confirm that the id exists.

No image, no signed URL, no object path. `docs/mobile-backend-contract.md` § 7 Q1 ("can a
Sales Staff member view a receipt they submitted?") remains open and is **not** answered
here.

### B.3 Edge Function `submit-receipt` — the mobile entry point

`supabase/functions/submit-receipt/index.ts`. This is § 4.4 Option A of the backend
contract, chosen over a signed upload URL (which would move MIME sniffing to the untrusted
client) and over a `storage.objects` INSERT policy (which would be the first write policy in
the entire schema and would make orphan cleanup impossible).

```text
POST /functions/v1/submit-receipt
  Authorization: Bearer <user access token>
  Content-Type: multipart/form-data
  fields: shop_id (uuid), file (one image)

→ auth.getUser()                      publishable key + caller's token
→ validateReceiptFile()               magic bytes, size, SHA-256, filename
→ reserve_receipt_submission()        CALLER'S token — this is the authorization step
→ storage.upload()                    service role
→ finalize_receipt_submission_upload()service role
  on failure: storage.remove() + record_receipt_submission_upload_failure()

200 { "status": "submitted", "submission_id": "…" }
```

**It re-uses the web implementation rather than restating it.** The function imports
`validateReceiptFile` from `lib/receipts/receipt-file.ts` and `runReceiptSubmissionFlow`
from `lib/receipts/receipt-submission-flow.ts` — the same two modules the Next.js Server
Action uses, already covered by 47 unit tests. Both were written dependency-free for exactly
this (`receipt-submission-flow.ts` has no imports at all; `receipt-file.ts` imports only
`node:crypto`, which Deno 2 supports). A second Deno implementation of magic-byte sniffing
is precisely the drift `docs/mobile-backend-contract.md` § 4.2 warns about, and
`lib/receipts/receipt-edge-function-safety.test.ts` fails the build if one appears.

**The response body is a closed set of statuses plus, on success, the submission id.**

| HTTP | `status` | Meaning |
| --- | --- | --- |
| 200 | `submitted` | stored; `submission_id` is present |
| 400 | `invalid` | file or `shop_id` refused; `reason` names the file problem |
| 401 | `unauthenticated` | no or invalid token |
| 403 | `denied` | not Sales Staff, or the shop is not theirs / not active |
| 409 | `duplicate` | this person already has a live submission of this exact file |
| 502 | `upload-failed` | reserved, but the object did not land; retryable |
| 503 | `unavailable` | configuration or transport failure |

The storage bucket, the object path and the file hash are consumed inside the function and
appear in **no** response and **no** log line. Neither key is ever echoed.

**JWT verification is enforced twice**: by the gateway (`verify_jwt = true` in
`supabase/config.toml`) and by the function's own `auth.getUser(accessToken)` call, which
revalidates with the Auth server rather than trusting the token's claims. The token is passed
explicitly because `persistSession: false` leaves the client with no stored session for the
argument-less form to find.

### B.4 The three test layers, and what only each one can prove

| Layer | File | Proves |
| --- | --- | --- |
| Database | `supabase/tests/database/sales_staff_receipt_reads_test.sql` (pgTAP, 76 assertions) | what the DATABASE enforces regardless of any client: grants, tenant isolation, fail-closed resolution, returned shape |
| Source | `lib/receipts/receipt-edge-function-safety.test.ts` (21 assertions) | what the function's SOURCE may not become: no re-implemented sniffing, no secret in a log or a response, the right key in the right client |
| Runtime | `scripts/receipt-submission-integration-test.mjs` (84 assertions) | what the served function actually DOES with a real JWT, a real multipart body, a real bucket and a real service-role key |

None of the three subsumes another. The source test cannot know whether the function runs;
the pgTAP suite cannot see the Edge Function at all; and the integration test, which sees
everything, cannot prevent a later edit from quietly duplicating the sniffing logic — only
the source test fails on that.

---

## What this milestone deliberately does not do

No OCR, no receipt parsing, no product or SKU matching, no reviewer queue, no approval or
rejection state, no incentive, campaign, reward, coin or payout object, and no Vendor
reporting. No receipt image retrieval. No change to the web UI. No storage policy. No
change to any deployed table, function, permission mapping or RLS posture.

## Three supporting changes

None is part of the contract, but all three were required and are worth stating plainly.

**`package.json` gains one script.** `test:receipts:integration` runs the local integration
test. It is deliberately NOT wired into `npm test`, which must stay runnable without Docker
and without a served function.

**`supabase/functions` is excluded from `tsconfig.json` and `eslint.config.mjs`.** The Edge
Function is Deno: it uses `Deno.serve`, `Deno.env` and an `npm:` import specifier, none of
which resolve under this project's Node/bundler settings. Left included, `next build` fails
with `Cannot find module 'npm:@supabase/supabase-js@2.110.6'`. It is not thereby unchecked —
`lib/receipts/receipt-edge-function-safety.test.ts` (21 assertions) covers its structural and
security properties, and Deno typechecks it at bundle time.

**One assertion in `lib/portal/portal-context-contract.test.ts` was corrected.** It asserted
that `20260729090000_shared_portal_context.sql` is the *newest* migration in the directory.
That is the right intent — its own failure message says "an out-of-order timestamp would apply
before its dependencies" — but the wrong test: "newest overall" is a property of the
repository at a moment in time, not of that migration, so it forbade *every* future migration
rather than the defect it was aiming at. It now asserts what it meant: that the migration
sorts strictly after each of the four migrations its header declares as dependencies. No
production code was touched.

## Verification performed

Everything below was **executed** against a local Supabase stack (Docker) on this branch.
Nothing was deployed to the hosted project: no `supabase db push`, no
`supabase functions deploy`.

### Executed and passing

| Check | Command | Result |
| --- | --- | --- |
| Migration applies after every historical migration | `npx supabase db reset` | ✅ all 33 migrations applied in order, `20260730090000` last |
| pgTAP behavioural suite | `npx supabase test db` | ✅ **PASS — 2 files, 134 assertions, 0 failed** |
| Edge Function bundles and serves | `npx supabase functions serve submit-receipt` | ✅ started on `supabase-edge-runtime-1.74.2` (Deno 2.1.4) and **executed a real request** |
| Edge Function local integration test | `npm run test:receipts:integration` | ✅ **84 passed, 0 failed** |
| Unit + source-safety suite | `npm test` | ✅ **726 passed, 0 failed** (182 suites) |
| TypeScript | `npx tsc --noEmit` | ✅ clean |
| ESLint | `npm run lint` | ✅ clean |
| Production build | `npm run build` | ✅ compiled |
| Whitespace / conflict markers | `git diff --check` | ✅ clean |

### pgTAP — what was proven in the database

`supabase/tests/database/sales_staff_receipt_reads_test.sql` — **76 assertions**, all
passing (the pre-existing `portal_context_test.sql` contributes the other 58). One
transaction, rolled back; every organization, product, shop and submission is created by the
file, so nothing depends on ambient data.

It covers, for `list_my_receipt_products()`: the zero-argument signature; `authenticated`
holds EXECUTE while `anon` and `service_role` do not; SECURITY DEFINER, STABLE, empty
`search_path`; `RECEIPT_PRODUCTS_READ` is mapped to `SALES_STAFF` **and to no other role**;
a signed-out caller, a Vendor Super Admin, a Retailer Owner, a Retailer Manager and a
member-less account are each refused with `42501`; a SUSPENDED profile, a DEACTIVATED
profile, a SUSPENDED membership and a two-Retailer ambiguity all fail closed; an ACTIVE Sales
Staff member sees exactly the ACTIVE products actively assigned to their own Retailer, with
the INACTIVE product, the withdrawn assignment, another Retailer's product and another
Vendor's product all absent; a duplicate `(product, Retailer)` assignment is impossible; a
member holding two roles still sees each product exactly once; and the returned shape is
exactly the five declared columns.

And for `get_my_receipt_submission(uuid)`: the exact one-uuid signature and the same grant
matrix; the submitter reads their own row; **another Sales Staff member in the same Retailer
gets zero rows**, as does a same-role member of another Retailer, an unknown uuid and a null
id — and all of those are proven *indistinguishable from each other*, so there is no
existence oracle; a Vendor, an Owner and a Manager are refused outright; and the returned
shape is exactly nine columns, byte-identical to `list_my_receipt_submissions()`, exposing no
bucket, object path, hash, profile id, organization id or failure code.

It also re-asserts that this migration changed nothing already deployed: all five original
receipt operations still exist, `finalize` and `record-failure` are still `service_role`-only,
the three tables still carry zero policies and no browser-role privilege, `storage.objects`
still has zero policies, and the `receipts` bucket is still private.

### Edge Function — bundling confirmed, not assumed

The previous revision of this document flagged the cross-directory import as an unexercised
assumption. **It has now been exercised and it works.** `npx supabase functions serve
submit-receipt` starts the runtime, and a real request returns this function's own body
(`{"status":"unauthenticated"}`) — which is only reachable after
`../../../lib/receipts/receipt-file.ts`, `../../../lib/receipts/receipt-submission-flow.ts`
and `npm:@supabase/supabase-js@2.110.6` have all resolved and the module has executed. The
documented `_shared/` fallback was **not needed and was not implemented**; one definition of
the magic-byte sniffing, hashing and orphan cleanup is shared by the web and mobile paths.

### Integration test — what was proven over real HTTP

`scripts/receipt-submission-integration-test.mjs`, run with `npm run
test:receipts:integration` — **84 assertions**, all passing, exiting non-zero on any failure.
It drives the served function with real password-grant JWTs and asserts against the real
database and the real Storage bucket. Local keys are read at runtime from `supabase status
-o json`; fixture passwords are generated per run; **no secret is in the file**. Fixtures are
applied with `psql` inside the local database container because `service_role` holds no table
privileges in this schema — a REST insert as `service_role` returns `42501`, which is the
posture the design wants and was not weakened to make testing easier.

| Group | What it proves |
| --- | --- |
| 1. Unauthenticated | no header → 401 at the gateway; a malformed token → 401; a structurally valid JWT with no user (the anon key) → 401 `unauthenticated` from the function itself |
| 2. Wrong role | Vendor Super Admin, Retailer Owner, Retailer Manager and a SUSPENDED-profile Sales Staff member all → 403 `denied` |
| 3. Shop scoping | unassigned shop, another Retailer's shop and a nonexistent shop → 403, and all three responses are **byte-identical**; a malformed shop id → 400 `invalid-shop` |
| 4. Product scoping | Sales Staff see only their own Retailer's product; the other Retailer's product is absent; no Vendor id, assignment status or catalogue prose is exposed; Vendor/Owner/Manager are refused |
| 5. File validation | no file → `missing`; empty → `empty`; **PDF bytes declared `image/jpeg` and named `.jpg` → `unsupported-type`**; two file parts → `too-many-files` |
| 6. Valid submission | 200 `submitted`; response carries **exactly** `status` and `submission_id`; row reaches `SUBMITTED` with `submitted_at` set; **the recorded MIME type is the sniffed `image/png`, not the declared `image/jpeg`**; `submitted_by_profile_id` is the token's user; Retailer derived server-side; path is `<retailer>/<user>/<submission>/<random>` with nothing from the filename (`../../etc/My Receipt.png`) shaping it; the object is in the private `receipts` bucket; `storage.objects` still has zero policies; the response contains neither the object path, nor the bucket prefix, nor the service-role key |
| 7. Reading it back | the submitter gets one row exposing no storage location, hash, profile or organization; a colleague and a cross-tenant member get **zero rows**, indistinguishable from an unknown uuid; Vendor/Owner/Manager are refused |
| 8. Duplicate / replay | the same person resubmitting the same bytes → 409 `duplicate` with no second row; a **different** staff member may submit the identical photo, because the index is per-submitter |
| 9. Upload failure | a deterministic post-reserve Storage rejection → 502 `upload-failed`; the row is `UPLOAD_FAILED` with the fixed `STORAGE_UPLOAD_FAILED` code and no `submitted_at`; **no orphan object is left in the bucket**; the same file is then retryable; nothing is stranded in `RESERVED`; the response reveals nothing about why Storage refused |
| 10. Transport | `GET` is refused; a JSON body is refused, and a `submitted_by` field in it changes nothing |

### Genuinely still unverified

| Item | Why |
| --- | --- |
| `deno check` on the Edge Function | No Deno binary is installed on this machine. The function is nevertheless *executed* under Deno 2.1.4 by the local edge runtime above, which is a stronger signal than a typecheck — but a static check would still catch an unexecuted branch. |
| Behaviour against the hosted project | Out of scope by instruction: nothing was pushed or deployed. The migration and the function have only ever run locally. |
| Real device / Flutter client integration | The Flutter repository was not modified and no mobile client has called this endpoint. |
| Image retrieval | Still absent by design — no signed URL, no download RPC, no storage policy. `docs/mobile-backend-contract.md` § 7 Q1 remains open. |
| Multi-Retailer account switching | `resolve_retailer_member_organization` still fails closed for a member of two Retailers (§ 6.5). Proven by test, unchanged by choice. |
