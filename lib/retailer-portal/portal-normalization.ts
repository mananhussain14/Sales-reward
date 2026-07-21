/**
 * PURE MODULE — no Supabase client, no `next/headers`, no I/O, no imports at all.
 *
 * This is the single place where the two portal RPCs' snake_case output becomes
 * the application's camelCase types, and the single place where their runtime
 * shape is validated. It is deliberately free of side effects so it can be
 * exercised directly by the unit tests in ./portal-normalization.test.ts — the
 * server module that calls the RPCs cannot be tested that way, because importing
 * it pulls in `next/headers`.
 *
 * WHY VALIDATE AT ALL. `supabase.rpc()` is untyped in this project (there are no
 * generated database types — see the note in ./retailer-owner-portal.ts), so its
 * result is `any`. A type assertion would be a claim about the SQL, not a check
 * of it, and TypeScript erases it at runtime. Everything below is therefore a
 * real check: if the migration is ever edited, or a column is renamed, or a
 * count comes back as a string, this layer refuses the row rather than rendering
 * `undefined` or `NaN` into a Retailer Owner's dashboard.
 *
 * FAIL CLOSED. Every function here returns a discriminated result, never throws
 * and never returns a partially-populated object. A row that does not fully
 * satisfy the contract is rejected outright — there is no coercion, no default
 * substitution, and no "best effort" path. A malformed shop list is not shown as
 * a shorter shop list.
 */

/**
 * The Retailer context the portal shell and overview render.
 *
 * Contains NO identifiers. The RPC does not return an organization id,
 * membership id, profile id, role id, permission id, or the caller's auth user
 * id, and nothing here reconstructs one. `retailerStatus` and `membershipStatus`
 * are display values; the authorization decision they reflect was already made
 * in SQL.
 */
export type RetailerOwnerPortalContext = {
  retailerName: string;
  retailerStatus: string;
  /** ISO 3166-1 alpha-2, or null — public.organizations.country_code is nullable. */
  countryCode: string | null;
  /** ISO 4217 alpha-3, or null — public.organizations.default_currency is nullable. */
  defaultCurrency: string | null;
  membershipStatus: string;
  totalShopCount: number;
  activeShopCount: number;
};

/**
 * One row of the read-only shop list. Carries NO shop id, by design: this
 * milestone has no shop-detail route, so there is nothing to address, and
 * emitting an id would create a client contract a later milestone has to keep.
 */
export type RetailerOwnerPortalShop = {
  shopName: string;
  /** public.retailer_shops.code is nullable. */
  shopCode: string | null;
  /** public.retailer_shops.city is nullable. */
  city: string | null;
  /** public.retailer_shops.country_code is nullable. */
  countryCode: string | null;
  shopStatus: string;
};

/**
 * The outcome of normalizing an RPC result.
 *
 * "malformed" carries a short, non-sensitive reason for SERVER LOGS ONLY. It
 * names the offending field so a genuine schema drift is diagnosable, and it
 * never contains a value read from the database — a reason string must never
 * become a channel through which row data reaches a log or a browser.
 */
export type NormalizationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Rejects anything that is not a genuine, finite, non-negative integer.
 *
 * `typeof NaN === "number"` and `typeof Infinity === "number"`, so a bare
 * typeof check would admit both — and `NaN.toLocaleString()` renders the string
 * "NaN" into a dashboard card. PostgREST returns bigint counts as JSON numbers,
 * but a driver or schema change could deliver a string, which `>= 0` would
 * happily coerce and compare. Nothing is coerced here.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/**
 * Requires a non-empty string after trimming.
 *
 * The database already constrains these columns to be NOT NULL and non-empty
 * after trimming, so a whitespace-only value should be unreachable. It is
 * checked anyway: the alternative to checking is trusting, and a blank retailer
 * name would render an anonymous header rather than an obvious fault.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Accepts a nullable text column: either null/undefined (normalized to null), or
 * a non-empty string. A present-but-blank value is a fault, not an absence —
 * it would render an empty table cell that looks like data rather than a gap.
 */
function readNullableText(value: unknown): NormalizationResult<string | null> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }

  if (isNonEmptyString(value)) {
    return { ok: true, value: value.trim() };
  }

  return { ok: false, reason: "nullable text field was present but not a non-empty string" };
}

/** Narrows an unknown value to an indexable object without using `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes ONE row of public.get_retailer_owner_portal_context().
 *
 * Exported for the tests; the server module goes through
 * normalizeContextResult() below, which also enforces the row-count rule.
 */
export function normalizeContextRow(
  row: unknown,
): NormalizationResult<RetailerOwnerPortalContext> {
  if (!isRecord(row)) {
    return { ok: false, reason: "context row was not an object" };
  }

  if (!isNonEmptyString(row.retailer_name)) {
    return { ok: false, reason: "retailer_name missing or empty" };
  }

  if (!isNonEmptyString(row.retailer_status)) {
    return { ok: false, reason: "retailer_status missing or empty" };
  }

  if (!isNonEmptyString(row.membership_status)) {
    return { ok: false, reason: "membership_status missing or empty" };
  }

  if (!isNonNegativeInteger(row.total_shop_count)) {
    return { ok: false, reason: "total_shop_count was not a non-negative integer" };
  }

  if (!isNonNegativeInteger(row.active_shop_count)) {
    return { ok: false, reason: "active_shop_count was not a non-negative integer" };
  }

  // An active count exceeding the total is arithmetically impossible against the
  // same organization — the SQL computes both from the same scoped subquery. If
  // it ever happens, the two counts did not come from the same place, and
  // showing them side by side would present a contradiction as fact.
  if (row.active_shop_count > row.total_shop_count) {
    return { ok: false, reason: "active_shop_count exceeded total_shop_count" };
  }

  const countryCode = readNullableText(row.country_code);
  if (!countryCode.ok) {
    return { ok: false, reason: `country_code invalid: ${countryCode.reason}` };
  }

  const defaultCurrency = readNullableText(row.default_currency);
  if (!defaultCurrency.ok) {
    return { ok: false, reason: `default_currency invalid: ${defaultCurrency.reason}` };
  }

  return {
    ok: true,
    value: {
      retailerName: row.retailer_name.trim(),
      retailerStatus: row.retailer_status.trim(),
      countryCode: countryCode.value,
      defaultCurrency: defaultCurrency.value,
      membershipStatus: row.membership_status.trim(),
      totalShopCount: row.total_shop_count,
      activeShopCount: row.active_shop_count,
    },
  };
}

/**
 * Normalizes the FULL result of the context RPC, enforcing the row-count rule.
 *
 * The SQL guarantees at most one row: zero for every unauthorized case, and zero
 * again for the ambiguous multi-retailer case, which fails closed in the
 * database rather than picking arbitrarily. This layer therefore treats:
 *
 *   0 rows -> "no-context"  (the caller is not an authorized Retailer Owner)
 *   1 row  -> normalize it
 *   2+     -> MALFORMED, not "pick the first"
 *
 * The 2+ branch should be unreachable. It is handled explicitly because the one
 * thing this application must never do is choose a tenant on the user's behalf:
 * if the SQL ever loses its guard, silently rendering rows[0] would show one
 * Retailer's data to an owner who qualifies for two, which is precisely the
 * failure the database's ambiguity rule exists to prevent.
 */
export type ContextResult =
  | { status: "ok"; context: RetailerOwnerPortalContext }
  | { status: "no-context" }
  | { status: "malformed"; reason: string };

export function normalizeContextResult(rows: unknown): ContextResult {
  if (!Array.isArray(rows)) {
    return { status: "malformed", reason: "context result was not an array" };
  }

  if (rows.length === 0) {
    return { status: "no-context" };
  }

  if (rows.length > 1) {
    return {
      status: "malformed",
      reason: `context result returned ${rows.length} rows; expected at most 1`,
    };
  }

  const normalized = normalizeContextRow(rows[0]);

  if (!normalized.ok) {
    return { status: "malformed", reason: normalized.reason };
  }

  return { status: "ok", context: normalized.value };
}

/** Normalizes ONE row of public.list_retailer_owner_portal_shops(). */
export function normalizeShopRow(
  row: unknown,
): NormalizationResult<RetailerOwnerPortalShop> {
  if (!isRecord(row)) {
    return { ok: false, reason: "shop row was not an object" };
  }

  if (!isNonEmptyString(row.shop_name)) {
    return { ok: false, reason: "shop_name missing or empty" };
  }

  if (!isNonEmptyString(row.shop_status)) {
    return { ok: false, reason: "shop_status missing or empty" };
  }

  const shopCode = readNullableText(row.shop_code);
  if (!shopCode.ok) {
    return { ok: false, reason: `shop_code invalid: ${shopCode.reason}` };
  }

  const city = readNullableText(row.city);
  if (!city.ok) {
    return { ok: false, reason: `city invalid: ${city.reason}` };
  }

  const countryCode = readNullableText(row.country_code);
  if (!countryCode.ok) {
    return { ok: false, reason: `country_code invalid: ${countryCode.reason}` };
  }

  return {
    ok: true,
    value: {
      shopName: row.shop_name.trim(),
      shopCode: shopCode.value,
      city: city.value,
      countryCode: countryCode.value,
      shopStatus: row.shop_status.trim(),
    },
  };
}

/**
 * Normalizes the FULL shop-list result.
 *
 * An empty array is a valid, successful answer: a Retailer genuinely may have no
 * shops on record. That is why the shop list and the authorization decision are
 * kept strictly apart — "no shops" must never be presented as, or confused with,
 * "not allowed".
 *
 * ALL-OR-NOTHING. One malformed row rejects the whole list rather than being
 * skipped. Dropping it would silently show an incomplete estate to the person
 * who most needs it to be complete, and the omission would be invisible.
 *
 * The RPC's ORDER BY (name, code NULLS LAST, id) is the display order. Nothing
 * here re-sorts: re-sorting in JavaScript would introduce a second, locale- and
 * host-dependent ordering that could disagree with the database's.
 */
export type ShopsResult =
  | { status: "ok"; shops: RetailerOwnerPortalShop[] }
  | { status: "malformed"; reason: string };

export function normalizeShopsResult(rows: unknown): ShopsResult {
  if (!Array.isArray(rows)) {
    return { status: "malformed", reason: "shop result was not an array" };
  }

  const shops: RetailerOwnerPortalShop[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const normalized = normalizeShopRow(rows[index]);

    if (!normalized.ok) {
      // The INDEX is named, never the row's contents.
      return {
        status: "malformed",
        reason: `shop row at index ${index} invalid: ${normalized.reason}`,
      };
    }

    shops.push(normalized.value);
  }

  return { status: "ok", shops };
}

/**
 * A stable React key for a shop row.
 *
 * The RPC returns no id, deliberately, so there is no natural key. shopCode is
 * NOT unique — public.retailer_shops has no unique constraint on `code`, and it
 * is nullable — so it cannot be used alone. Combining it with the array index
 * yields a key that is unique within one render and derived entirely from data
 * already on screen.
 *
 * This is safe here specifically because the list is READ-ONLY and its order is
 * fixed by the database: there is no insertion, reordering, filtering, or
 * client-side mutation for an index-based key to break. If this list ever gains
 * interactivity, this function is the thing to revisit.
 */
export function buildShopKey(shop: RetailerOwnerPortalShop, index: number): string {
  return `${shop.shopCode ?? "no-code"}-${index}`;
}
