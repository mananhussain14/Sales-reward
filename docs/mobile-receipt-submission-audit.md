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
`supabase/config.toml`) and by the function's own `auth.getUser()` call, which revalidates
with the Auth server rather than trusting the token's claims.

---

## What this milestone deliberately does not do

No OCR, no receipt parsing, no product or SKU matching, no reviewer queue, no approval or
rejection state, no incentive, campaign, reward, coin or payout object, and no Vendor
reporting. No receipt image retrieval. No change to the web UI. No storage policy. No
change to any deployed table, function, permission mapping or RLS posture.

## Two supporting changes

Neither is part of the contract, but both were required and are worth stating plainly.

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

| Check | Result |
| --- | --- |
| `npm run lint` | ✅ clean |
| `npm run build` | ✅ compiled, typechecked |
| `npm test` | ✅ **726 passed, 0 failed** (182 suites; 21 new assertions) |
| Deno typecheck of the Edge Function | ❌ **not run** — no Deno binary in this environment |
| Edge Function deploy / local serve | ❌ **not run** — requires Docker and a linked project |
| Migration applied against a database | ❌ **not run** — no database in this environment |
| pgTAP behavioural suite for the new RPCs | ❌ **not written** — see below |

The last four are real gaps in this milestone's verification. Before merge:

```bash
# 1. Typecheck the Edge Function under the runtime it actually runs in.
deno check supabase/functions/submit-receipt/index.ts

# 2. Apply the migration and serve the function locally (needs Docker).
supabase db reset
supabase functions serve submit-receipt

# 3. Deploy.
supabase functions deploy submit-receipt
```

**The bundling assumption to confirm on first deploy.** The Edge Function imports
`lib/receipts/receipt-file.ts` and `lib/receipts/receipt-submission-flow.ts` through relative
paths *outside* `supabase/functions`, with the explicit `.ts` extensions Deno requires. The
Supabase CLI bundler walks the module graph from the entrypoint and should include them.
That path has not been exercised here. If a deploy cannot resolve them, the fallback is to
move both modules to `supabase/functions/_shared/` and have `lib/receipts/` re-export from
there — keeping one definition, which is the property that matters. **Do not** solve it by
copying the magic-byte sniffing into the function; the safety test will fail, and correctly.

**A pgTAP suite for the two new RPCs is not included.** `supabase/tests/database/` holds the
behavioural suites for this schema (e.g. `portal_context_test.sql`, 58 assertions), and the
new `list_my_receipt_products()` and `get_my_receipt_submission(uuid)` deserve the same
treatment — in particular the tenant-isolation and "another person's id returns zero rows"
cases, which are exactly the properties source-level tests cannot prove. Writing them
requires Docker and was out of reach here. This is the single largest outstanding item.
