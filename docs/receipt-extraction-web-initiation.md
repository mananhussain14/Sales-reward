# Receipt extraction — web initiation

How the web Sales Staff receipt page asks that a stored receipt be read, what it
deliberately does not do, and what has to be true in a hosted project for any of it to
work.

---

## 1. The defect this closed

The reading milestone shipped the provider adapter, both Edge Functions, the schema and
the SQL contract — and no client. The web Server Action ended at `finalize`, so
`request-receipt-extraction` was never called by anything in `app/`, `components/` or
`lib/`. Receipts uploaded successfully, `receipt_extractions` stayed empty, and both
functions reported zero invocations. Nothing was broken; the integration had never been
written.

The Flutter app was, and still is, the only client with a complete path.

---

## 2. The call graph

```
submit-receipt-form.tsx  (Client Component)
  └─ submitReceiptAction                      app/(retailer)/retailer/receipts/actions.ts
       ├─ portal access, assigned shops, file validated from its own bytes
       ├─ submitReceipt                       lib/receipts/receipt-submissions.ts
       │    └─ runReceiptSubmissionFlow       reserve → upload → finalize
       │         └─ { status: "submitted", submissionId }      ← the DATABASE's id
       └─ runReceiptSubmissionOutcome         lib/receipts/receipt-submission-extraction-flow.ts
            ├─ classifyExtractionEligibility  lib/receipts/receipt-extraction-eligibility.ts
            └─ requestReceiptExtraction       lib/receipts/receipt-extraction-request.ts
                 └─ POST {SUPABASE_URL}/functions/v1/request-receipt-extraction
                        Authorization: Bearer <the caller's own session token>
                        body: { "submission_id": "<uuid>" }
```

From there the shared Edge Function does what it already did: revalidates the token,
authorizes the receipt under the caller's own RPCs, creates the attempt, claims it,
downloads the private object, submits the document and stops at `PROCESSING`.

**Properties, all asserted by test:**

| Property | Where it is proven |
|---|---|
| The id is the one `reserve_receipt_submission()` returned | `receipt-submission-extraction-flow.test.ts` 2, `receipt-submission-flow.test.ts` 13a |
| No client-supplied id can reach it — the form carries `shopId` and `receipt`, nothing else | `receipt-submission-extraction-wiring.test.ts` 5 |
| The caller's session JWT is forwarded; no service-role key is on this path | wiring 4 |
| Exactly one request per submission, and no retry | flow 1/14, wiring 7 |
| The request is **awaited** — a detached promise may be abandoned when the action responds | wiring 7 |
| The body is one key, matching the endpoint's allowlist | wiring 3 |
| No web module names `receipt_extractions`, its line items, or any worker RPC | wiring 8 |
| Nothing from the reader — value, confidence, provider or error text — reaches the web app | wiring 9 |
| The id never reaches the browser: it is not in `SubmitReceiptState` and is not rendered | wiring 6 |

---

## 3. Storing and reading are separate operations

The receipt is committed before anything above asks for a reading, and **nothing on this
path deletes, rolls back or re-marks a stored receipt** when the request fails.

| Outcome | What the person is told |
|---|---|
| Stored, reading requested | `Receipt submitted from <file>.` |
| Stored, request could not be made | `Receipt submitted successfully, but automatic data extraction could not be started.` |
| Stored, image the reader does not accept | `Receipt submitted successfully. Automatic data extraction was not started because it needs a JPEG or PNG photo of 4 MB or smaller.` |

All three are **successes** and render in the success slot. None of them is reported as an
upload failure, and none of them claims a reading began when it did not.

Re-submitting after a partial success does not help and is not suggested: the same file is
refused as a duplicate by design. Retrying a reading is a deliberate act that this
milestone does not yet offer a control for — see §5.

---

## 4. The eligibility gate, and why it is not a copy-paste of the upload policy

The product stores JPEG, PNG **and WebP** up to **10 MiB**. The reader accepts JPEG and
PNG only, up to **4 MiB**. Those are different policies for different reasons and neither
is wrong.

A receipt outside the narrower set is checked in the web process **before** a request is
made, because a receipt gets only **three** extraction attempts in its whole lifetime and
asking anyway would spend one on a refusal that was knowable for free.

The two constants are restated in `receipt-extraction-eligibility.ts` rather than imported
from the Edge-runtime adapter, and `receipt-extraction-eligibility.test.ts` asserts them
equal to `AZURE_DOCUMENT_SUPPORTED_MIME_TYPES` and
`DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES`. A tier upgrade that raises the document limit
fails that test until the web gate is raised with it.

**Not changed by this milestone:** the upload policy itself. WebP and 10 MiB photographs
are still accepted, still stored, still reviewable. Narrowing what a person may upload to
match what a reader takes is a product decision, not a defect fix.

---

## 5. Deliberately not in this milestone

**Polling, and extraction status in the web UI.** The web page shows submission status
(`SUBMITTED` / `UPLOAD_FAILED`) and nothing about the reading. Extraction runs, results
are stored, and the web application does not yet display them. `get-receipt-extraction` is
called by no web module, and `receipt-submission-extraction-wiring.test.ts` asserts that,
so adding polling is a visible change rather than a quiet one.

Doing it properly needs more than a fetch loop: Flutter puts it on a per-submission review
page (`ReceiptReviewCubit` — a single bounded loop, stopped on terminal status, on
confirmation, on backgrounding and on disposal), and the web application has no equivalent
route. A follow-up milestone should add:

1. a per-submission review route under `/retailer/receipts`;
2. a bounded poll of `get-receipt-extraction` with an explicit "check again";
3. extraction state on the history rows;
4. a deliberate retry control, which is also the only honest answer to a partial success;
5. the confirmation flow (`confirm_receipt_extraction`), which the database already has.

---

## 6. What a hosted project needs

Both gates must be open, and they are independent by design:

| Gate | Where | Required value |
|---|---|---|
| Database | `public.receipt_extraction_runtime.mode` | `AZURE` — a deliberate operator `UPDATE`; no function at any privilege level writes it |
| Edge runtime | `RECEIPT_EXTRACTION_MODE` secret on both functions | exactly `azure` — the comparison is a literal, so `AZURE`, `" azure"` and `true` all fail closed |

Plus `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY`, `AZURE_DI_API_VERSION` and `AZURE_DI_MODEL` as
Edge Function secrets. **They stay there** — not in `.env.local`, not in the browser, not
in Vercel, not in Flutter, not in git.

With `RECEIPT_EXTRACTION_MODE` absent, the endpoint answers `EXTRACTION_UNAVAILABLE`
before its first mutation: the invocation is recorded, no attempt row is created, and the
person sees the partial-success sentence. That is the correct behaviour, and it is
indistinguishable from an outage on purpose.
