/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Validates the only two things a browser may send when finalizing a sale.
 *
 * ============================================================================
 * THE BROWSER SUPPLIES A JUDGEMENT, NOT A FACT
 * ============================================================================
 * Every figure in a verified sale is copied from the immutable Sales Staff
 * proposal by the database. There is no form field for an amount, a date, a
 * currency, a merchant, a timezone or a resolved instant — not because they are
 * filtered out here, but because `finalize_claim_receipt_sale_header` has no
 * parameter for any of them and the reviewer cannot edit values in this release.
 *
 * So this module validates exactly two inputs: which receipt, and — when the
 * printed local time is genuinely ambiguous — which of the two real instants was
 * meant.
 *
 * ============================================================================
 * THE DATABASE DECIDES WHETHER A CHOICE IS *NEEDED*
 * ============================================================================
 * This validator checks only the VOCABULARY. Whether a choice is required,
 * unnecessary or stale depends on the shop's zone and on state that can change
 * between render and submit, so only the database can answer it — and it does,
 * under the receipt row lock. A client that decided for itself would be wrong
 * the moment a shop's timezone was corrected.
 */

/** The two words the database accepts for an ambiguous local time. */
export const DST_AMBIGUITY_CHOICES = ["FIRST", "SECOND"] as const;

export type DstAmbiguityChoice = (typeof DST_AMBIGUITY_CHOICES)[number];

export function isDstAmbiguityChoice(
  value: unknown,
): value is DstAmbiguityChoice {
  return (
    typeof value === "string" &&
    (DST_AMBIGUITY_CHOICES as readonly string[]).includes(value)
  );
}

export type SaleFinalizationFieldErrors = {
  dstAmbiguityChoice?: string;
};

/** Exactly what the write adapter forwards, beyond the receipt id. */
export type NormalizedSaleFinalization = {
  /** `null` when the reviewer made no daylight-saving selection. */
  dstAmbiguityChoice: DstAmbiguityChoice | null;
};

export type SaleFinalizationValidationResult =
  | { ok: true; value: NormalizedSaleFinalization }
  | { ok: false; fieldErrors: SaleFinalizationFieldErrors };

/**
 * A single string from a form, trimmed, or null when absent or blank.
 *
 * A repeated field arrives as an array and a file as an object; neither is a
 * meaningful choice, so both become null rather than being coerced into a string
 * that might accidentally match a valid word.
 */
function single(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates one submitted finalization.
 *
 * An absent choice is VALID here — it is the normal case for a date-only sale and
 * for an ordinary unambiguous time, and it is also the correct first attempt on a
 * time the reviewer has not yet been told is ambiguous. The database answers
 * `AMBIGUOUS_TIME_REQUIRES_CHOICE` in that last case, which is a prompt rather
 * than an error.
 */
export function validateSaleFinalizationInput(raw: {
  dstAmbiguityChoice?: unknown;
}): SaleFinalizationValidationResult {
  const fieldErrors: SaleFinalizationFieldErrors = {};

  const choiceRaw = single(raw.dstAmbiguityChoice);
  let dstAmbiguityChoice: DstAmbiguityChoice | null = null;

  if (choiceRaw !== null) {
    if (!isDstAmbiguityChoice(choiceRaw)) {
      fieldErrors.dstAmbiguityChoice =
        "Choose either the first or the second interpretation of that time.";
    } else {
      dstAmbiguityChoice = choiceRaw;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, value: { dstAmbiguityChoice } };
}
