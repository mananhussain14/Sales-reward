/**
 * ISO 4217 active alphabetic currency codes and their minor units.
 *
 * GENERATED FILE — do not edit by hand.
 *   Regenerate with scripts/generate-iso-currency-codes.mjs from the pinned source below.
 *   supabase/migrations/20260812090000_iso_currency_codes.sql is generated from the SAME
 *   input in the SAME run, and ./iso-currency-codes.test.ts fails the build if the two
 *   ever disagree by code or by minor unit.
 *
 * PROVENANCE
 *   Source:           https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 *   Maintained by:    SIX Group, the ISO 4217 Maintenance Agency
 *   Publication date: 2026-01-01   (the Pblshd attribute of the source)
 *   Source SHA-256:   838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9
 *   Fetched on:       2026-07-30
 *   Entries read:     280
 *   Codes included:   165
 *   Excluded:         16 (13 non-numeric minor unit, 0 no minor unit, 0 unsupported minor unit, 3 no currency code, 0 malformed code)
 *
 * THE MECHANICAL INCLUSION RULE
 *   A code is included if and only if it appears in the official ACTIVE list, its
 *   alphabetic code is exactly three uppercase ASCII letters, and its minor-unit value
 *   parses as exactly one of 0, 2, 3, 4.
 *
 *   Everything else is excluded BY THE RULE and not by a curated list. NO CODE IS
 *   EXCLUDED FOR STARTING WITH X — XCD, XOF, XAF and XPF are real circulating currencies
 *   and are included like any other. Historic entries are never read.
 *
 * BROWSER-SAFE AND DEPENDENCY-FREE. This module imports nothing, reads no environment,
 * touches no network and has no side effects, so it is safe in a Client Component, a
 * Server Component, a Server Action, an Edge Function and a test alike.
 *
 * THE DATABASE IS THE ENFORCEMENT BOUNDARY. public.iso_currency_codes seeds exactly these
 * rows and both currency_code columns carry a foreign key to it. This module exists so
 * the application can render a minor-unit-correct amount and produce a clear per-field
 * message without a round trip — never as a substitute for that constraint.
 */

/** One active ISO 4217 currency: its alphabetic code and its minor-unit exponent. */
export type IsoCurrency = {
  /** Three uppercase ASCII letters. */
  readonly code: string;
  /** The number of decimal places the currency subdivides into: 0, 2, 3 or 4. */
  readonly minorUnit: 0 | 2 | 3 | 4;
};

/** The active ISO 4217 currencies with a supported minor unit, sorted by code. */
export const ISO_CURRENCIES: readonly IsoCurrency[] = [
  { code: "AED", minorUnit: 2 },
  { code: "AFN", minorUnit: 2 },
  { code: "ALL", minorUnit: 2 },
  { code: "AMD", minorUnit: 2 },
  { code: "AOA", minorUnit: 2 },
  { code: "ARS", minorUnit: 2 },
  { code: "AUD", minorUnit: 2 },
  { code: "AWG", minorUnit: 2 },
  { code: "AZN", minorUnit: 2 },
  { code: "BAM", minorUnit: 2 },
  { code: "BBD", minorUnit: 2 },
  { code: "BDT", minorUnit: 2 },
  { code: "BHD", minorUnit: 3 },
  { code: "BIF", minorUnit: 0 },
  { code: "BMD", minorUnit: 2 },
  { code: "BND", minorUnit: 2 },
  { code: "BOB", minorUnit: 2 },
  { code: "BOV", minorUnit: 2 },
  { code: "BRL", minorUnit: 2 },
  { code: "BSD", minorUnit: 2 },
  { code: "BTN", minorUnit: 2 },
  { code: "BWP", minorUnit: 2 },
  { code: "BYN", minorUnit: 2 },
  { code: "BZD", minorUnit: 2 },
  { code: "CAD", minorUnit: 2 },
  { code: "CDF", minorUnit: 2 },
  { code: "CHE", minorUnit: 2 },
  { code: "CHF", minorUnit: 2 },
  { code: "CHW", minorUnit: 2 },
  { code: "CLF", minorUnit: 4 },
  { code: "CLP", minorUnit: 0 },
  { code: "CNY", minorUnit: 2 },
  { code: "COP", minorUnit: 2 },
  { code: "COU", minorUnit: 2 },
  { code: "CRC", minorUnit: 2 },
  { code: "CUP", minorUnit: 2 },
  { code: "CVE", minorUnit: 2 },
  { code: "CZK", minorUnit: 2 },
  { code: "DJF", minorUnit: 0 },
  { code: "DKK", minorUnit: 2 },
  { code: "DOP", minorUnit: 2 },
  { code: "DZD", minorUnit: 2 },
  { code: "EGP", minorUnit: 2 },
  { code: "ERN", minorUnit: 2 },
  { code: "ETB", minorUnit: 2 },
  { code: "EUR", minorUnit: 2 },
  { code: "FJD", minorUnit: 2 },
  { code: "FKP", minorUnit: 2 },
  { code: "GBP", minorUnit: 2 },
  { code: "GEL", minorUnit: 2 },
  { code: "GHS", minorUnit: 2 },
  { code: "GIP", minorUnit: 2 },
  { code: "GMD", minorUnit: 2 },
  { code: "GNF", minorUnit: 0 },
  { code: "GTQ", minorUnit: 2 },
  { code: "GYD", minorUnit: 2 },
  { code: "HKD", minorUnit: 2 },
  { code: "HNL", minorUnit: 2 },
  { code: "HTG", minorUnit: 2 },
  { code: "HUF", minorUnit: 2 },
  { code: "IDR", minorUnit: 2 },
  { code: "ILS", minorUnit: 2 },
  { code: "INR", minorUnit: 2 },
  { code: "IQD", minorUnit: 3 },
  { code: "IRR", minorUnit: 2 },
  { code: "ISK", minorUnit: 0 },
  { code: "JMD", minorUnit: 2 },
  { code: "JOD", minorUnit: 3 },
  { code: "JPY", minorUnit: 0 },
  { code: "KES", minorUnit: 2 },
  { code: "KGS", minorUnit: 2 },
  { code: "KHR", minorUnit: 2 },
  { code: "KMF", minorUnit: 0 },
  { code: "KPW", minorUnit: 2 },
  { code: "KRW", minorUnit: 0 },
  { code: "KWD", minorUnit: 3 },
  { code: "KYD", minorUnit: 2 },
  { code: "KZT", minorUnit: 2 },
  { code: "LAK", minorUnit: 2 },
  { code: "LBP", minorUnit: 2 },
  { code: "LKR", minorUnit: 2 },
  { code: "LRD", minorUnit: 2 },
  { code: "LSL", minorUnit: 2 },
  { code: "LYD", minorUnit: 3 },
  { code: "MAD", minorUnit: 2 },
  { code: "MDL", minorUnit: 2 },
  { code: "MGA", minorUnit: 2 },
  { code: "MKD", minorUnit: 2 },
  { code: "MMK", minorUnit: 2 },
  { code: "MNT", minorUnit: 2 },
  { code: "MOP", minorUnit: 2 },
  { code: "MRU", minorUnit: 2 },
  { code: "MUR", minorUnit: 2 },
  { code: "MVR", minorUnit: 2 },
  { code: "MWK", minorUnit: 2 },
  { code: "MXN", minorUnit: 2 },
  { code: "MXV", minorUnit: 2 },
  { code: "MYR", minorUnit: 2 },
  { code: "MZN", minorUnit: 2 },
  { code: "NAD", minorUnit: 2 },
  { code: "NGN", minorUnit: 2 },
  { code: "NIO", minorUnit: 2 },
  { code: "NOK", minorUnit: 2 },
  { code: "NPR", minorUnit: 2 },
  { code: "NZD", minorUnit: 2 },
  { code: "OMR", minorUnit: 3 },
  { code: "PAB", minorUnit: 2 },
  { code: "PEN", minorUnit: 2 },
  { code: "PGK", minorUnit: 2 },
  { code: "PHP", minorUnit: 2 },
  { code: "PKR", minorUnit: 2 },
  { code: "PLN", minorUnit: 2 },
  { code: "PYG", minorUnit: 0 },
  { code: "QAR", minorUnit: 2 },
  { code: "RON", minorUnit: 2 },
  { code: "RSD", minorUnit: 2 },
  { code: "RUB", minorUnit: 2 },
  { code: "RWF", minorUnit: 0 },
  { code: "SAR", minorUnit: 2 },
  { code: "SBD", minorUnit: 2 },
  { code: "SCR", minorUnit: 2 },
  { code: "SDG", minorUnit: 2 },
  { code: "SEK", minorUnit: 2 },
  { code: "SGD", minorUnit: 2 },
  { code: "SHP", minorUnit: 2 },
  { code: "SLE", minorUnit: 2 },
  { code: "SOS", minorUnit: 2 },
  { code: "SRD", minorUnit: 2 },
  { code: "SSP", minorUnit: 2 },
  { code: "STN", minorUnit: 2 },
  { code: "SVC", minorUnit: 2 },
  { code: "SYP", minorUnit: 2 },
  { code: "SZL", minorUnit: 2 },
  { code: "THB", minorUnit: 2 },
  { code: "TJS", minorUnit: 2 },
  { code: "TMT", minorUnit: 2 },
  { code: "TND", minorUnit: 3 },
  { code: "TOP", minorUnit: 2 },
  { code: "TRY", minorUnit: 2 },
  { code: "TTD", minorUnit: 2 },
  { code: "TWD", minorUnit: 2 },
  { code: "TZS", minorUnit: 2 },
  { code: "UAH", minorUnit: 2 },
  { code: "UGX", minorUnit: 0 },
  { code: "USD", minorUnit: 2 },
  { code: "USN", minorUnit: 2 },
  { code: "UYI", minorUnit: 0 },
  { code: "UYU", minorUnit: 2 },
  { code: "UYW", minorUnit: 4 },
  { code: "UZS", minorUnit: 2 },
  { code: "VED", minorUnit: 2 },
  { code: "VES", minorUnit: 2 },
  { code: "VND", minorUnit: 0 },
  { code: "VUV", minorUnit: 0 },
  { code: "WST", minorUnit: 2 },
  { code: "XAD", minorUnit: 2 },
  { code: "XAF", minorUnit: 0 },
  { code: "XCD", minorUnit: 2 },
  { code: "XCG", minorUnit: 2 },
  { code: "XOF", minorUnit: 0 },
  { code: "XPF", minorUnit: 0 },
  { code: "YER", minorUnit: 2 },
  { code: "ZAR", minorUnit: 2 },
  { code: "ZMW", minorUnit: 2 },
  { code: "ZWG", minorUnit: 2 },
];

/** Every included code, sorted, uppercase. */
export const ISO_CURRENCY_CODES: readonly string[] = ISO_CURRENCIES.map(
  (currency) => currency.code,
);

const BY_CODE: ReadonlyMap<string, IsoCurrency> = new Map(
  ISO_CURRENCIES.map((currency) => [currency.code, currency]),
);

/**
 * True when `value` is an active ISO 4217 code this project accepts.
 *
 * Case-sensitive on purpose: the database CHECK is `^[A-Z]{3}$` under the C collation, so
 * a lower-case value is not a currency code here either. Callers normalise before asking.
 */
export function isIsoCurrencyCode(value: string): boolean {
  return BY_CODE.has(value);
}

/**
 * The minor-unit exponent for `code`, or null when the code is not an accepted currency.
 *
 * Returning null rather than defaulting to 2 is deliberate: assuming two decimal places
 * for an unknown code would silently misread every JPY, KWD and BHD amount by a factor of
 * 100 or 10, and a wrong amount is worse than a refused one.
 */
export function isoCurrencyMinorUnit(code: string): 0 | 2 | 3 | 4 | null {
  return BY_CODE.get(code)?.minorUnit ?? null;
}
