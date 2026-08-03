/**
 * PURE MODULE — the only import is the static ISO 4217 catalogue, which is data.
 *
 * Formats the values a reviewer reads on the sale-header panel.
 *
 * ============================================================================
 * MINOR UNITS ARE LOOKED UP, NEVER GUESSED
 * ============================================================================
 * `total_minor` is an integer in a currency's smallest unit, and the number of
 * decimal places is a property of the CURRENCY, not of the number. JPY has none,
 * AED has two, KWD has three. Dividing by 100 would silently render ¥1,000 as
 * ¥10.00 and KWD 12.500 as KWD 125.00.
 *
 * `lib/reference/iso-currency-codes.ts` is a static catalogue generated from the
 * same ISO source that seeds `public.iso_currency_codes` — verified to agree with
 * it row for row. It needs no round trip and no new database field.
 *
 * The receipt-side RPC that returns a minor unit, `get_receipt_currency_minor_unit`,
 * is gated on RECEIPT_EXTRACTION_REVIEW, which belongs to Sales Staff. A Claim
 * Reviewer cannot call it, so the catalogue is the correct boundary here.
 *
 * If a currency is somehow not in the catalogue, the amount is shown as integer
 * minor units with an explicit label rather than being scaled by a guess.
 */
import { isoCurrencyMinorUnit } from "../reference/iso-currency-codes.ts";

/**
 * A monetary amount, ready to render.
 *
 * `exact` is false when the minor unit was unknown, so the panel can say so
 * instead of showing a number that looks decimal-correct and is not.
 */
export type FormattedAmount = {
  text: string;
  exact: boolean;
};

export function formatMinorAmount(
  minor: number | null,
  currencyCode: string | null,
): FormattedAmount | null {
  if (minor === null || !Number.isFinite(minor)) return null;
  if (currencyCode === null || currencyCode.length === 0) return null;

  const unit = isoCurrencyMinorUnit(currencyCode);

  if (unit === null) {
    // Honest fallback: no scaling, and the unit is named so nobody reads it as a
    // major-unit figure.
    return { text: `${currencyCode} ${minor} (minor units)`, exact: false };
  }

  if (unit === 0) {
    return { text: `${currencyCode} ${minor.toLocaleString("en-US")}`, exact: true };
  }

  const divisor = 10 ** unit;
  const whole = Math.trunc(minor / divisor);
  const fraction = Math.abs(minor % divisor)
    .toString()
    .padStart(unit, "0");

  return {
    text: `${currencyCode} ${whole.toLocaleString("en-US")}.${fraction}`,
    exact: true,
  };
}

/**
 * A UTC instant, rendered deterministically.
 *
 * A Server Component renders this page, so a locale- or timezone-dependent string
 * would differ between the server and client renders. Matches formatUtc in the
 * qualification panel and formatSubmittedAt in the queue filters module.
 */
export function formatUtcInstant(iso: string | null): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-` +
    `${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:` +
    `${pad(parsed.getUTCMinutes())} UTC`
  );
}

/** The printed local date and time, exactly as the receipt showed them. */
export function formatLocalPrinted(
  date: string | null,
  time: string | null,
): string | null {
  if (date === null) return null;
  if (time === null) return date;
  // Times arrive as HH:MM:SS from PostgreSQL; seconds are always zero by CHECK.
  return `${date} ${time.slice(0, 5)}`;
}

/** How the Sales Staff proposal came to be. Server-derived, never computed here. */
export function entryModeLabel(mode: string | null): string {
  switch (mode) {
    case "MANUAL":
      return "Typed in by Sales Staff";
    case "EXTRACTED":
      return "Read from the receipt image";
    case "MIXED":
      return "Read from the image, with staff corrections";
    default:
      return "Recorded";
  }
}

/** The eight field names `receipt_confirmations.changed_fields` may contain. */
export function changedFieldLabel(field: string): string {
  switch (field) {
    case "currency_code":
      return "Currency";
    case "document_number":
      return "Receipt number";
    case "merchant_name":
      return "Shop name";
    case "subtotal_minor":
      return "Subtotal";
    case "tax_total_minor":
      return "Tax";
    case "total_minor":
      return "Total";
    case "transaction_date":
      return "Date";
    case "transaction_time":
      return "Time";
    default:
      return "Another detail";
  }
}

/** What the stored precision means, in words a reviewer can check. */
export function precisionLabel(precision: string | null): string | null {
  switch (precision) {
    case "DATE_ONLY":
      return "Date only — no time was printed on the receipt";
    case "MINUTE":
      return "Date and time, to the minute";
    default:
      return null;
  }
}

/** What a persisted daylight-saving selection means. */
export function dstChoiceLabel(choice: string | null): string | null {
  switch (choice) {
    case "FIRST":
      return "First occurrence (the earlier instant)";
    case "SECOND":
      return "Second occurrence (the later instant)";
    default:
      return null;
  }
}
