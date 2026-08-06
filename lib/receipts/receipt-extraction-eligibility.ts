/**
 * PURE MODULE — no imports, no I/O, no environment, no side effects.
 *
 * WHICH SUBMITTED RECEIPTS MAY BE HANDED TO THE DOCUMENT SERVICE AT ALL, decided in the
 * web process BEFORE an extraction attempt is requested.
 *
 * WHY THIS GATE EXISTS, AND WHY IT IS NOT COSMETIC
 *   The receipt upload policy and the document service's input policy are NOT the same
 *   policy, and they were never going to be: the product accepts JPEG, PNG and WebP up
 *   to 10 MiB (lib/uploads/upload-policy.ts, lib/receipts/receipt-file.ts) because that
 *   is what a phone camera produces, while the document service accepts JPEG and PNG
 *   only, up to 4 MiB on the current tier.
 *
 *   A receipt outside the narrower set is not a failed upload — it is stored, private,
 *   valid and reviewable exactly like any other. What it cannot do is be read
 *   automatically. Requesting an attempt for one anyway would take one of the THREE
 *   attempts a receipt gets in its whole lifetime and spend it on a refusal that was
 *   knowable here, for free, before anything was sent. That is the entire reason this
 *   module runs before the request and not after it.
 *
 * WHY THE NUMBERS ARE RESTATED RATHER THAN IMPORTED
 *   The values the adapter enforces live in lib/receipts/receipt-extraction-azure-provider.ts,
 *   which is written for the Edge runtime — its imports carry explicit `.ts` extensions
 *   and its graph exists to talk to a provider. Pulling that graph into the Next.js
 *   bundle to read two constants would be the wrong dependency in the wrong direction.
 *
 *   So the values appear in two places on purpose, and DIVERGENCE IS MADE IMPOSSIBLE BY
 *   TEST rather than by import: ./receipt-extraction-eligibility.test.ts asserts these
 *   constants equal the adapter's own AZURE_DOCUMENT_SUPPORTED_MIME_TYPES and
 *   DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES. This is the same arrangement, for the same
 *   reason, that lib/uploads/upload-policy.ts uses for the 10 MiB file maximum.
 *
 * THIS MODULE IS NOT AUTHORIZATION AND NOT VALIDATION. The file has already been
 * validated from its own bytes by @/lib/receipts/receipt-file, and the request is
 * authorized in PostgreSQL from auth.uid(). This decides one thing only: whether asking
 * is worth an attempt.
 */

/**
 * The document types the reader accepts.
 *
 * WebP is deliberately absent: the product accepts it for storage and it is a perfectly
 * good receipt photograph, but the reader does not take it.
 */
export const EXTRACTION_ELIGIBLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const;

export type ExtractionEligibleMimeType =
  (typeof EXTRACTION_ELIGIBLE_MIME_TYPES)[number];

/**
 * The largest document the reader accepts, in bytes. 4 MiB.
 *
 * Pinned by test to the adapter's DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES. It is well
 * BELOW the 10 MiB the product accepts for storage, and that gap is the normal case
 * rather than an error — see the module header.
 */
export const MAX_EXTRACTION_INPUT_BYTES = 4 * 1024 * 1024;

/** The same number expressed for display, so no component divides by 1024 twice. */
export const MAX_EXTRACTION_INPUT_MEGABYTES = 4;

/**
 * Why a stored receipt cannot be read automatically.
 *
 * A closed set, and both members are ordinary outcomes rather than faults: each names a
 * property of the image that the person can act on by taking a different photograph.
 */
export type ExtractionIneligibilityReason = "unsupported-type" | "too-large";

export type ExtractionEligibility =
  | { readonly status: "eligible" }
  | { readonly status: "ineligible"; readonly reason: ExtractionIneligibilityReason };

/**
 * Decides whether a stored receipt may be offered to the reader.
 *
 * Takes the SERVER-DERIVED facts — the MIME type sniffed from the file's own leading
 * bytes and the size measured from the bytes themselves — never the browser's declared
 * `File.type` or a form field. The caller holds both because
 * @/lib/receipts/receipt-file produced them.
 *
 * THE TYPE IS CHECKED FIRST, deliberately: an over-sized WebP is reported as an
 * unsupported type, because converting it would still leave it unreadable, and telling
 * someone to shrink a file that would be refused anyway is advice that wastes their time.
 */
export function classifyExtractionEligibility(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): ExtractionEligibility {
  if (
    !(EXTRACTION_ELIGIBLE_MIME_TYPES as readonly string[]).includes(input.mimeType)
  ) {
    return { status: "ineligible", reason: "unsupported-type" };
  }

  // Non-finite and negative sizes are refused rather than trusted. They cannot arise from
  // the validated path, and a size this module cannot reason about is not one it should
  // wave through into an attempt.
  if (
    !Number.isFinite(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > MAX_EXTRACTION_INPUT_BYTES
  ) {
    return { status: "ineligible", reason: "too-large" };
  }

  return { status: "eligible" };
}
