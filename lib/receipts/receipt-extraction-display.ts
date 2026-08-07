/**
 * PURE MODULE — no imports, no I/O, no locale lookups, no side effects.
 *
 * Turns the integer minor amounts the extraction contract carries into something a person
 * can compare against a paper receipt.
 *
 * ============================================================================
 * THE MINOR UNIT IS DATA, NEVER AN ASSUMPTION
 * ============================================================================
 * Two decimal places is wrong for JPY (0), wrong for KWD (3) and wrong for CLF (4), and a
 * receipt rendered with the wrong scale is off by a factor of ten or a thousand while
 * looking entirely plausible. So the scale comes from `currency_minor_unit`, which the
 * database resolves from iso_currency_codes beside the currency the reader actually read.
 *
 * WHEN THE SCALE IS UNKNOWN, NOTHING IS RENDERED. A null minor unit returns null rather
 * than falling back to 2: showing "1234.56" for a value that might be "123456" yen is
 * worse than showing nothing, because the person has no way to tell it is wrong. The panel
 * simply omits the row.
 *
 * NO Intl.NumberFormat, AND THAT IS DELIBERATE. Its grouping and symbol placement depend
 * on a locale this application does not yet establish, so two people could see the same
 * receipt formatted differently and neither would match the paper. A plain fixed-point
 * number beside the ISO code is unambiguous everywhere.
 */

/** The largest scale worth rendering; guards a nonsense value from producing huge strings. */
const MAX_MINOR_UNIT = 4;

/**
 * Formats one integer minor amount as `CODE 1234.56`.
 *
 * @param minor the amount in minor units, exactly as stored.
 * @param currencyCode the ISO 4217 alphabetic code the reader read, or null.
 * @param minorUnit how many decimal places that currency has, or null when unresolved.
 *
 * @returns the formatted string, or null when it cannot be rendered truthfully — a missing
 *   amount, a missing currency, a missing or nonsensical scale, or a non-integer value.
 */
export function formatMinorAmount(
  minor: number | null,
  currencyCode: string | null,
  minorUnit: number | null,
): string | null {
  if (minor === null || !Number.isSafeInteger(minor)) return null;
  if (currencyCode === null || currencyCode.trim().length === 0) return null;
  if (minorUnit === null || !Number.isInteger(minorUnit)) return null;
  if (minorUnit < 0 || minorUnit > MAX_MINOR_UNIT) return null;

  const negative = minor < 0;
  const digits = Math.abs(minor).toString().padStart(minorUnit + 1, "0");

  const whole = minorUnit === 0 ? digits : digits.slice(0, digits.length - minorUnit);
  const fraction = minorUnit === 0 ? "" : `.${digits.slice(digits.length - minorUnit)}`;

  return `${negative ? "-" : ""}${currencyCode.trim().toUpperCase()} ${whole}${fraction}`;
}
