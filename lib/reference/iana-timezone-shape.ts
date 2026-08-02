/**
 * IANA time-zone SHAPE validation — the browser-side mirror of the database's
 * `retailer_shops_timezone_name_shape` CHECK.
 *
 * BROWSER-SAFE AND DEPENDENCY-FREE. Imports nothing, reads no environment,
 * touches no network, has no side effects — safe in a Client Component, a Server
 * Component, a Server Action and a test alike.
 *
 * ============================================================================
 * WHY A SHAPE TEST RATHER THAN A BAKED LIST OF ZONE NAMES
 * ============================================================================
 * lib/reference/iso-country-codes.ts bakes in all 249 country codes, because that
 * list is small, fixed, and changes roughly never. The IANA time-zone database is
 * the opposite: ~600 names, revised several times a year as governments change
 * their rules. A baked copy would drift from whatever tzdata the PostgreSQL host
 * actually carries, and the failure would be silent and one-directional — the
 * form would happily accept a name the database then rejects, or refuse a newly
 * added zone the database knows perfectly well.
 *
 * So this module validates only the FORM of an identifier, which is stable, and
 * leaves existence to the one component that can answer it authoritatively:
 * `public.retailer_shops_assert_timezone()`, which looks the name up in
 * `pg_catalog.pg_timezone_names`.
 *
 * ============================================================================
 * THE DATABASE IS THE ENFORCEMENT BOUNDARY
 * ============================================================================
 * Nothing here is a security control, and nothing here may be relied on. Its only
 * job is to tell an operator that "UTC+3" will not be accepted before they wait
 * for a round trip. Every rule below is enforced again, independently, by:
 *
 *   * `retailer_shops_timezone_name_shape` — trimmed, 3..64 chars, Region/City
 *     form, and not an `Etc/` entry; and
 *   * `retailer_shops_assert_timezone()`   — the name exists in pg_timezone_names.
 *
 * Both were added by migration 20260817210000 and are the sole authority. This
 * module deliberately does NOT restate the catalogue rule, and must never be
 * "improved" into a second definition of what a valid zone is.
 *
 * ============================================================================
 * WHY FIXED OFFSETS ARE REFUSED
 * ============================================================================
 * A shop is a physical place, and a fixed offset cannot follow the daylight-saving
 * rules of the place it stands in — a summer sale would resolve to the wrong
 * instant, which moves it relative to a campaign window. `UTC+3` and `GMT+3` are
 * not IANA names at all; `UTC`, `EST` and `Etc/GMT+3` are names PostgreSQL knows
 * but are still fixed offsets. All of them are refused, here and in the database.
 */

/**
 * Region/City, with at least one `/` and no empty segment. The second and later
 * segments admit `.`, `_` and `-` so real names pass:
 *
 *   Asia/Dubai · Asia/Kuwait · Europe/London · Europe/Paris
 *   America/New_York · America/Argentina/Buenos_Aires · America/Port-au-Prince
 *
 * and these do not:
 *
 *   UTC · UTC+3 · GMT+3 · +04:00 · EST · Etc/GMT+3 · Etc/UTC · Europe/ · /London
 *
 * Byte-for-byte the same expression the database CHECK applies under COLLATE "C".
 */
const IANA_REGION_CITY_PATTERN = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+._-]+)+$/;

/** The `Etc/*` family: real IANA names, but fixed offsets rather than places. */
const ETC_PREFIX = "Etc/";

/** Matching the database CHECK's `length(timezone_name) between 3 and 64`. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 64;

/**
 * True when `value` has the shape of a region/city IANA identifier that the
 * database's CHECK will accept.
 *
 * Returning true does NOT mean the zone exists — only the database can say that.
 * Returning false DOES mean the database would refuse it, so the form can say so
 * immediately.
 *
 * The value is compared exactly as given: an untrimmed string is rejected rather
 * than silently trimmed, because the stored form must be the identifier itself
 * and the CHECK asserts `timezone_name = btrim(timezone_name)`. Trimming here
 * would let the form accept something it then sends unchanged and the database
 * refuses — the worst of both.
 */
export function hasIanaTimeZoneShape(value: string): boolean {
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) return false;
  if (value !== value.trim()) return false;
  if (value.startsWith(ETC_PREFIX)) return false;
  return IANA_REGION_CITY_PATTERN.test(value);
}
