/**
 * ISO 3166-1 alpha-2 country codes — the 249 currently assigned entries.
 *
 * BROWSER-SAFE AND DEPENDENCY-FREE. This module imports nothing, reads no
 * environment, touches no network, and has no side effects, so it is safe in a
 * Client Component, a Server Component, a Server Action, and a test alike. It is
 * deliberately a plain array rather than a package: a runtime dependency for a
 * fixed list of 249 two-letter strings would be a supply-chain surface in
 * exchange for nothing.
 *
 * NO NETWORK LOOKUP, EVER. The list is baked in at build time. Fetching country
 * codes from an external API at runtime would make form validation depend on a
 * third party being reachable, and would leak that a form was being filled in.
 *
 * SCOPE — what "currently assigned" means here:
 *   * Included: the 249 codes ISO 3166-1 presently assigns, i.e. the set the
 *     standard marks "officially assigned".
 *   * Excluded: transitionally reserved codes retired from use, such as DD (the
 *     former German Democratic Republic).
 *   * Excluded: the user-assigned and indeterminate ranges, such as II and ZZ,
 *     which the standard sets aside for private use and never assigns.
 *   * Excluded: XK (Kosovo). It is widely used in practice but is NOT an
 *     officially assigned ISO 3166-1 alpha-2 code — it sits in the user-assigned
 *     range. This is a deliberate, reviewed exclusion rather than an oversight.
 *     If the project later needs to record Kosovo, that is a product decision to
 *     admit an explicitly non-ISO code, not a bug in this list.
 *
 * This list is duplicated, by necessity, in the database: public.iso_country_codes
 * seeds exactly the same 249 codes, and both country_code columns carry NOT VALID
 * foreign keys to it. The DATABASE is the enforcement boundary; this module
 * exists so an admin gets a clear per-field message instead of a generic failure
 * after a round trip. The two must stay in step — both were generated from one
 * source list, and any change to either must be mirrored and re-verified.
 */

/** The 249 currently assigned ISO 3166-1 alpha-2 codes, sorted, uppercase. */
export const ISO_COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
  "QA",
  "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VI", "VN", "VU",
  "WF", "WS",
  "YE", "YT",
  "ZA", "ZM", "ZW",
] as const;

/** A code known to be in the list above. Narrowed by isIsoCountryCode(). */
export type IsoCountryCode = (typeof ISO_COUNTRY_CODES)[number];

/**
 * O(1) membership set, built once at module load rather than scanning the array
 * on every call. The annotation widens the tuple's literal element type to plain
 * strings, so `has()` accepts any string — which is what a validator taking
 * unknown input needs.
 */
const ISO_COUNTRY_CODE_SET: ReadonlySet<string> = new Set(
  ISO_COUNTRY_CODES as readonly string[],
);

/**
 * True only for an exactly-matching, UPPERCASE, currently assigned code.
 *
 * CASE IS NOT NORMALIZED HERE, deliberately: "ae" returns false. Normalization is
 * the caller's job and must happen before this is called, because the caller is
 * also the one that echoes the canonical value back into the form — if this
 * function quietly accepted "ae", the admin would be told their input was fine
 * while a different string went to the database. Both Server Actions therefore
 * trim and upper-case first, which is the same canonical form the RPCs apply with
 * `upper(nullif(btrim(...), ''))`.
 *
 * Whitespace is likewise not trimmed here: " AE " is false.
 */
export function isIsoCountryCode(value: string): value is IsoCountryCode {
  return ISO_COUNTRY_CODE_SET.has(value);
}
