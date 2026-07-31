/**
 * PURE MODULE — no imports, no I/O, no environment, no side effects.
 *
 * TURNS PRINTED AMOUNT TEXT INTO AN EXACT INTEGER NUMBER OF MINOR UNITS.
 *
 * NO FLOATING POINT, ANYWHERE. There is no `parseFloat`, no `Number(text)` on a decimal,
 * and no `Math.round(value * 100)` in this file, and receipt-amount-parsing.test.ts fails
 * the build if one appears. The minor-unit integer is assembled by STRING CONCATENATION —
 * the integer digits followed by the fraction digits — so `19.99` becomes the characters
 * "1999" and then the integer 1999, never the double 19.99 multiplied by 100. That
 * multiplication is wrong for a long tail of ordinary values (0.29 * 100 is
 * 28.999999999999996 in IEEE-754), and a receipt total that is one minor unit out is a
 * reconciliation defect nobody will find for months.
 *
 * IT NEVER ROUNDS, AND CANNOT. A fraction is only ever read when it has EXACTLY as many
 * digits as the currency's minor unit; every other shape is refused or treated as
 * grouping. So there is no path where digits are discarded, and no rounding rule to get
 * wrong.
 *
 * WHEN IT CANNOT BE SURE, IT RETURNS NOTHING. An amount whose decimal separator cannot be
 * resolved is refused with AMBIGUOUS_AMOUNT_FORMAT rather than guessed at. Guessing wrong
 * between a decimal point and a thousands separator changes the value by 1000x, silently.
 * The source text is preserved on the extraction row either way, so the reviewer sees
 * exactly what was printed and types the value themselves — which is the correct outcome
 * for an amount a machine could not read with certainty.
 *
 * THE RULE ORDER IS LOAD-BEARING. Rule 1 is tried before rule 2, and that single ordering
 * is what makes `KWD 12.500` mean twelve and a half dinars (3 minor digits) while
 * `JPY 1,000` means one thousand yen (grouping). Reversing them breaks one or the other.
 */

import {
  MAX_MINOR_AMOUNT,
  type ExtractionWarningCode,
} from "./receipt-extraction-vocabulary.ts";

/** The minor-unit exponents this project supports, matching iso_currency_codes. */
export type MinorUnit = 0 | 2 | 3 | 4;

export type AmountRejectionReason =
  /** The separator could not be resolved as decimal or grouping. The value is NOT guessed. */
  | "ambiguous-separator"
  /** The provider produced a negative amount. Out of scope for Milestone A. */
  | "negative"
  /** Above the 10^12 minor-unit ceiling — almost certainly a barcode read as a total. */
  | "out-of-range"
  /** No digits at all. */
  | "no-digits"
  /** The caller supplied a minor unit this project does not support. */
  | "unsupported-minor-unit";

export type AmountParseResult =
  | { readonly status: "ok"; readonly minor: number }
  | {
      readonly status: "rejected";
      readonly reason: AmountRejectionReason;
      /** The closed warning code to attach to the extraction, or null when none applies. */
      readonly warning: ExtractionWarningCode | null;
    };

const SUPPORTED_MINOR_UNITS: readonly number[] = [0, 2, 3, 4];

/**
 * The largest number of digits a minor-unit integer may have before it certainly exceeds
 * the ceiling. 10^12 has 13 digits, so anything longer is out of range without needing to
 * be parsed — which is also what keeps the eventual parseInt inside Number.MAX_SAFE_INTEGER.
 */
const MAX_MINOR_DIGITS = 13;

/**
 * Whitespace that appears inside printed amounts as a GROUPING separator.
 *
 * Ordinary space, no-break space, figure space, thin space, narrow no-break space and word
 * joiner. French and several other locales group with one of these rather than with a
 * comma or a point, and a receipt printed as `1 234,56` must not be read as two numbers.
 */
const GROUPING_WHITESPACE = /[\s    ⁠]/g;

/**
 * Arabic-Indic and Extended Arabic-Indic digits, mapped to ASCII.
 *
 * This project's first market prints in AED and receipts in the region are routinely
 * typeset with these digits. Mapping them is a lossless, unambiguous substitution — each
 * code point has exactly one ASCII digit meaning — so it happens before any structural
 * decision and changes no value.
 */
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * The Arabic decimal separator (U+066B) and thousands separator (U+066C).
 *
 * Unlike `.` and `,` these are NOT ambiguous — the standard assigns each exactly one role —
 * so they are folded onto their ASCII counterparts before the rules run.
 */
const ARABIC_DECIMAL_SEPARATOR = "٫";
const ARABIC_THOUSANDS_SEPARATOR = "٬";

/** Digits with interior `.`/`,` only. Must begin and end with a digit. */
const NUMERIC_CORE = /\d[\d.,]*\d|\d/;

/**
 * Isolates the numeric token, keeping the distinction between a separator that belonged to a
 * CURRENCY SYMBOL and one that was written against the digits themselves.
 *
 * Removed characters become spaces rather than vanishing, which is the whole point. In
 * `د.إ 1,234.56` the point belongs to the symbol and a letter stood between it and the
 * digits, so it lands in a different token and is correctly discarded. In `.56` nothing
 * stood between, so the leading point is part of the number — and reading it as "56 major
 * units" instead of "fifty-six hundredths" would be a hundredfold error of exactly the kind
 * rule 4 exists to prevent. That case is reported as ambiguous below.
 */
function isolateNumericToken(
  digitsSpacesAndSeparators: string,
): { token: string; hadLeadingSeparator: boolean } | null {
  for (const candidate of digitsSpacesAndSeparators.split(" ")) {
    if (!/\d/.test(candidate)) continue;
    const core = NUMERIC_CORE.exec(candidate);
    if (core === null) continue;
    const start = candidate.indexOf(core[0]);
    const preceding = start > 0 ? candidate[start - 1] : "";
    return {
      token: core[0],
      hadLeadingSeparator: preceding === "." || preceding === ",",
    };
  }
  return null;
}

function rejected(
  reason: AmountRejectionReason,
  warning: ExtractionWarningCode | null,
): AmountParseResult {
  return { status: "rejected", reason, warning };
}

/**
 * Folds Arabic-Indic digits and Arabic separators onto ASCII. Lossless.
 */
export function normalizeAmountDigits(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
      out += String(code - EXTENDED_ARABIC_INDIC_ZERO);
    } else if (character === ARABIC_DECIMAL_SEPARATOR) {
      out += ".";
    } else if (character === ARABIC_THOUSANDS_SEPARATOR) {
      out += ",";
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * True when the printed text denotes a negative amount.
 *
 * Both conventions are recognised: a leading or trailing minus sign, and the accounting
 * convention of wrapping the figure in parentheses. Recognising them is what lets a
 * negative be REFUSED explicitly rather than silently parsed as its absolute value — the
 * dangerous failure mode, since a refund read as a purchase is a reward paid out wrongly.
 */
export function looksNegative(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/^\(.*\)$/.test(trimmed)) return true;
  return /^[^\d]*-/.test(trimmed) || /-\s*$/.test(trimmed);
}

/**
 * Parses printed amount text into an exact integer number of minor units.
 *
 * @param rawText   the text exactly as the provider read it
 * @param minorUnit the currency's minor-unit exponent, from public.iso_currency_codes
 */
export function parseAmountToMinor(rawText: unknown, minorUnit: number): AmountParseResult {
  if (!SUPPORTED_MINOR_UNITS.includes(minorUnit)) {
    return rejected("unsupported-minor-unit", null);
  }
  if (typeof rawText !== "string") {
    return rejected("no-digits", null);
  }

  const folded = normalizeAmountDigits(rawText);

  if (looksNegative(folded)) {
    // Refused before anything is computed, so no negative value can reach a stored column
    // even by an arithmetic accident.
    return rejected("negative", "NEGATIVE_AMOUNT_REJECTED");
  }

  // Grouping whitespace is removed first, so `1 234,56` and `1234,56` are the same input by
  // the time any structural decision is made.
  const withoutSpaces = folded.replace(GROUPING_WHITESPACE, "");

  // Everything that is not a digit or a separator becomes a SPACE — a separator, not a
  // deletion — so that a point belonging to a currency symbol ends up in a different token
  // from the digits. See isolateNumericToken.
  const tokenised = withoutSpaces.replace(/[^\d.,]/g, " ");
  const isolated = isolateNumericToken(tokenised);

  if (isolated === null) {
    return rejected("no-digits", null);
  }

  if (isolated.hadLeadingSeparator) {
    // `.56` and `,56`. Written against the digits with nothing between, so the separator is
    // part of the number — but whether it is a decimal point or a stray mark cannot be
    // decided, and guessing "56 major units" would be a hundredfold error.
    return rejected("ambiguous-separator", "AMBIGUOUS_AMOUNT_FORMAT");
  }

  const value = isolated.token;
  const separators = [...value].filter((character) => character === "." || character === ",");

  let integerDigits: string;
  let fractionDigits: string;

  if (separators.length === 0) {
    // ---- Rule 3: no separator at all. An integer number of major units. ----------------
    integerDigits = value;
    fractionDigits = "";
  } else {
    const lastIndex = Math.max(value.lastIndexOf("."), value.lastIndexOf(","));
    const lastSeparator = value[lastIndex];
    const digitsAfter = value.length - lastIndex - 1;

    if (minorUnit > 0 && digitsAfter === minorUnit) {
      // ---- Rule 1: the last separator is the DECIMAL separator. ------------------------
      // Checked FIRST, and that is what makes `KWD 12.500` (minorUnit 3) twelve and a half
      // dinars rather than twelve thousand five hundred. Under the opposite order rule 2
      // would claim it, because it also ends in three digits.
      integerDigits = value.slice(0, lastIndex).replace(/[.,]/g, "");
      fractionDigits = value.slice(lastIndex + 1);
    } else if (
      digitsAfter === 3 &&
      isPureGrouping(value, lastSeparator)
    ) {
      // ---- Rule 2: every separator is a GROUPING mark. ---------------------------------
      // `JPY 1,000` (minorUnit 0) and `USD 1,234` both land here: one separator character
      // throughout, each followed by exactly three digits, so there is no decimal part.
      integerDigits = value.replace(/[.,]/g, "");
      fractionDigits = "";
    } else {
      // ---- Rule 4: refuse. ------------------------------------------------------------
      // `AED 12.5` reaches here (one digit after the separator, minor unit 2), as does
      // `JPY 1000.00`. Both could be read more than one way by a rule that tried harder,
      // and a rule that tries harder is a rule that is sometimes 1000x wrong. The source
      // text survives on the row; the reviewer types the value.
      return rejected("ambiguous-separator", "AMBIGUOUS_AMOUNT_FORMAT");
    }
  }

  if (!/^\d*$/.test(integerDigits) || !/^\d*$/.test(fractionDigits)) {
    return rejected("ambiguous-separator", "AMBIGUOUS_AMOUNT_FORMAT");
  }
  if (integerDigits.length === 0 && fractionDigits.length === 0) {
    return rejected("no-digits", null);
  }

  // The fraction is either empty or exactly `minorUnit` digits long — rule 1 is the only
  // branch that produces one, and it requires that length. So padding here only ever adds
  // zeros to a whole number, and nothing is ever truncated or rounded.
  const paddedFraction = fractionDigits.padEnd(minorUnit, "0");
  if (paddedFraction.length !== minorUnit) {
    return rejected("ambiguous-separator", "AMBIGUOUS_AMOUNT_FORMAT");
  }

  const minorDigits = `${integerDigits}${paddedFraction}`.replace(/^0+(?=\d)/, "");

  if (minorDigits.length > MAX_MINOR_DIGITS) {
    return rejected("out-of-range", "AMBIGUOUS_AMOUNT_FORMAT");
  }

  // Safe: the length check above bounds this well inside Number.MAX_SAFE_INTEGER, and the
  // string is known to be digits only, so the radix-10 parse is exact.
  const minor = Number.parseInt(minorDigits, 10);

  if (!Number.isSafeInteger(minor) || minor < 0) {
    return rejected("out-of-range", "AMBIGUOUS_AMOUNT_FORMAT");
  }
  if (minor > MAX_MINOR_AMOUNT) {
    return rejected("out-of-range", "AMBIGUOUS_AMOUNT_FORMAT");
  }

  return { status: "ok", minor };
}

/**
 * True when every separator in `value` is the same character as `lastSeparator` and each is
 * followed by exactly three digits — the shape of pure thousands grouping.
 */
function isPureGrouping(value: string, lastSeparator: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "." && character !== ",") continue;
    if (character !== lastSeparator) return false;
    const following = value.slice(index + 1, index + 4);
    if (!/^\d{3}$/.test(following)) return false;
    const afterGroup = value[index + 4];
    if (afterGroup !== undefined && afterGroup !== "." && afterGroup !== ",") return false;
  }
  // A leading group of one to three digits must precede the first separator.
  const firstSeparator = value.search(/[.,]/);
  return firstSeparator >= 1 && firstSeparator <= 3;
}

/**
 * True when subtotal + tax does not equal total, and all three are present.
 *
 * A REVIEW HINT AND NOTHING MORE. Real receipts round their lines independently of their
 * total, so `subtotal + tax = total` is not a fact about receipts. There is deliberately no
 * CHECK constraint asserting it, this never blocks a confirmation, and the backend never
 * derives one figure from the other two.
 */
export function hasSubtotalTaxTotalMismatch(
  subtotalMinor: number | null,
  taxTotalMinor: number | null,
  totalMinor: number | null,
): boolean {
  if (subtotalMinor === null || taxTotalMinor === null || totalMinor === null) return false;
  return subtotalMinor + taxTotalMinor !== totalMinor;
}
