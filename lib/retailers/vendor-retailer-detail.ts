// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access and @/lib/retailers/vendor-retailers, this
// must never be imported into a Client Component. It transitively imports
// `next/headers` (via @/lib/supabase/server), which throws at build time if it
// ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  getVendorRetailerOwnerStatus,
  type VendorRetailerOwnerStatusResult,
} from "@/lib/retailers/vendor-retailer-owner-status";

/**
 * Read-only detail view of ONE Retailer managed by the authorized Vendor.
 *
 * THE RELATIONSHIP ID IS AN ADDRESS, NOT AUTHORIZATION.
 *
 * Unlike getVendorRetailers(), this function takes an argument — and that
 * difference is the thing to be careful about, so it is worth stating exactly
 * what the argument may and may not do. `relationshipId` selects WHICH row,
 * among the rows the caller is already entitled to read, is rendered. It never
 * decides WHETHER the caller may read anything. Holding one grants nothing:
 *
 *   - The Vendor is derived internally, from getVendorSuperAdminAccess(), which
 *     resolves it from the caller's own cryptographically verified token. The
 *     only organization id that reaches a query is access.organizationId.
 *   - No Vendor organization id, Retailer organization id, user id, or email is
 *     accepted as an argument, ever. Any of those would let a caller nominate
 *     whose data they see, which is precisely the vulnerability the directory's
 *     no-argument shape exists to prevent and which this shape must not reopen.
 *   - The relationship row is fetched under BOTH `id = relationshipId` AND
 *     `vendor_organization_id = access.organizationId`. A relationship id
 *     belonging to another Vendor matches nothing.
 *
 * RLS remains the database enforcement boundary, exactly as in the directory.
 * Every read below goes through the ordinary authenticated Supabase server
 * client under the caller's own token, so the Retailer RLS read policies —
 * vendor_retailers_select_vendor_authorized,
 * organizations_select_vendor_managed_retailers, and
 * retailer_shops_select_vendor_authorized — decide what is readable at all.
 * service_role is not used here or anywhere in this codebase: it would bypass
 * RLS entirely and make this module, rather than the database, the thing
 * standing between one Vendor and another Vendor's retailers. The explicit
 * vendor_organization_id filter narrows within what the policies already permit;
 * it is not what makes the read safe.
 *
 * FOREIGN AND NONEXISTENT IDS PRODUCE THE SAME ANSWER — DELIBERATELY.
 *
 * A malformed id, an id no row owns, an id owned by another Vendor, an id whose
 * row RLS declines to return, and an id whose Retailer organization cannot be
 * read all return `not-found`, indistinguishably. Separating them would turn
 * this route into an oracle: a caller could learn that a relationship they may
 * not read nevertheless EXISTS, and by sweeping ids, roughly how many. "I will
 * not tell you whether that exists" is the only safe answer, so it is the only
 * answer given.
 *
 * Three failure kinds stay strictly apart:
 *
 *   - Authorization failure -> unauthenticated / unauthorized.
 *   - Addressing failure    -> not-found (the five cases above).
 *   - Data query failure    -> unavailable, still authorized.
 *
 * NO PARTIAL DATA. The three reads compose one view, so it is all-or-nothing: a
 * Retailer rendered with a name but no shop list, or with shops but no
 * organization row, would be a half-truth presented as a fact. `unavailable` is
 * its own status rather than a nullable field for that reason, which also lets
 * `shops: []` mean, unambiguously, that this Retailer has no shops on record.
 */

/** The organization type a row must hold to be a Retailer. */
const RETAILER_ORGANIZATION_TYPE = "RETAILER";

/**
 * Canonical UUID form: 8-4-4-4-12 hexadecimal. Matched case-insensitively —
 * PostgreSQL emits lowercase, but a hand-retyped or upper-cased URL addresses the
 * same row and there is no reason to reject it.
 *
 * Version and variant nibbles are deliberately NOT constrained. This check exists
 * to keep a malformed value out of the query, not to audit UUID generation; a
 * well-formed id that names no row already lands on not-found, which is the same
 * place a stricter regex would send it.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One shop of the Retailer. Deliberately carries no ids. */
export type VendorRetailerShopDetail = {
  name: string;
  code: string | null;
  city: string | null;
  countryCode: string | null;
  status: string;
};

/**
 * The rendered detail. Carries NO ids at all — not the relationship id it was
 * addressed by, and not the Retailer organization id used to join. The page
 * already has the former from its own route params, and the latter is exactly
 * the id this milestone keeps out of the browser.
 */
export type VendorRetailerDetail = {
  retailerName: string;
  /** The Retailer organization's own lifecycle state. */
  retailerStatus: string;
  countryCode: string | null;
  defaultCurrency: string | null;
  /** The vendor->retailer relationship's lifecycle state — a separate fact. */
  relationshipStatus: string;
  /** `[]` means the Retailer genuinely has no shops on record. */
  shops: VendorRetailerShopDetail[];
};

export type VendorRetailerDetailResult =
  | {
      status: "authorized";
      organizationName: string;
      retailer: VendorRetailerDetail;
      /**
       * The Vendor-authorized owner status for this relationship, from the
       * SECURITY DEFINER RPC that authorizes independently of the reads above.
       * `unavailable` here degrades ONLY the owner card — the retailer detail
       * still renders — and must never be shown as, or coerced to, NONE.
       */
      ownerStatus: VendorRetailerOwnerStatusResult;
    }
  | { status: "not-found" }
  | { status: "unavailable"; organizationName: string }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

// Shapes of the columns read from each table, matching the migrations exactly.
// Selected narrowly: no timestamps, no audit metadata, no addresses beyond city.
// A column that is never read cannot leak from a page, a payload, a log, or a
// future refactor of this file.
//
// EXACTLY ONE id is selected: RelationshipRow.retailer_organization_id. It is a
// temporary server-side join value — read from the Vendor-scoped relationship
// row (already filtered by both the requested id and the Vendor derived from the
// verified token), used to key queries 2 and 3, and then dropped during
// assembly. It is never returned.
//
// The returned VendorRetailerDetail payload therefore contains NO id of any
// kind: no relationship id, no Retailer organization id, no Vendor organization
// id, no shop id. Queries 2 and 3 do not select an id at all.
type RelationshipRow = { retailer_organization_id: string; status: string };
type RetailerOrganizationRow = {
  name: string;
  status: string;
  country_code: string | null;
  default_currency: string | null;
};
type RetailerShopRow = {
  name: string;
  code: string | null;
  city: string | null;
  country_code: string | null;
  status: string;
};

/**
 * Thrown when a read returns a PostgREST error, so the single catch below can
 * treat reported errors and thrown errors identically. The Supabase error is
 * deliberately NOT attached: it can name tables, columns, and policies, and
 * nothing here may reach a browser.
 */
class RetailerDetailUnavailableError extends Error {}

/**
 * Thrown when the requested Retailer cannot be addressed. Carries no detail —
 * not the id, not which of the five causes applied — because the whole point is
 * that the causes are indistinguishable to the caller.
 */
class RetailerDetailNotFoundError extends Error {}

/** Rejects a reported PostgREST error; otherwise yields the rows (never null). */
function unwrapRows<Row>(result: { data: Row[] | null; error: unknown }): Row[] {
  if (result.error || !result.data) throw new RetailerDetailUnavailableError();
  return result.data;
}

/**
 * Unwraps a maybeSingle() read, keeping the two outcomes apart: a reported error
 * is a failure to READ (unavailable), while a null row is a definite answer that
 * no matching row is visible (not-found). Collapsing them would either report an
 * outage for a mistyped URL or a mistyped URL for an outage.
 */
function unwrapRow<Row>(result: { data: Row | null; error: unknown }): Row {
  if (result.error) throw new RetailerDetailUnavailableError();
  if (!result.data) throw new RetailerDetailNotFoundError();
  return result.data;
}

/**
 * Loads and assembles the detail. THREE queries TOTAL, fixed — never one per
 * shop, and never one per anything else. The shop read is a single set-based
 * query keyed by the verified Retailer id, so a Retailer with two shops and a
 * Retailer with two hundred cost exactly the same number of round trips.
 */
async function loadDetail(
  supabase: Awaited<ReturnType<typeof createClient>>,
  relationshipId: string,
  organizationId: string,
): Promise<VendorRetailerDetail> {
  // ---------------------------------------------------------------------------
  // 1. The relationship — the only query that consults caller-supplied input.
  // ---------------------------------------------------------------------------
  // Filtered on BOTH the requested id and the Vendor derived from the verified
  // token. The vendor_organization_id filter is what makes another Vendor's
  // relationship id inert here; vendor_retailers_select_vendor_authorized
  // independently confines the row set to Vendor organizations the caller may
  // read, so the two must both admit the row.
  //
  // vendor_retailers_unique_pair and the primary key together guarantee at most
  // one row, so maybeSingle() is exact rather than optimistic. Status is not
  // filtered: a SUSPENDED or DEACTIVATED relationship is still one this Vendor
  // has on record, and hiding it would make suspension look like deletion — the
  // same rule the directory, the RLS policies, and the helper all follow.
  const relationship = unwrapRow<RelationshipRow>(
    await supabase
      .from("vendor_retailers")
      .select("retailer_organization_id, status")
      .eq("id", relationshipId)
      .eq("vendor_organization_id", organizationId)
      .maybeSingle(),
  );

  // Read off the verified row above — never from the URL, a parameter, or a form
  // value. Past this point no caller-supplied value influences any query.
  const retailerOrganizationId = relationship.retailer_organization_id;

  // ---------------------------------------------------------------------------
  // 2 + 3. The Retailer organization and its shops — independent, so concurrent.
  // ---------------------------------------------------------------------------
  // Neither needs the other's result. Promise.all is safe against rejection here
  // because the whole function is wrapped in one try/catch by the caller: a
  // failure of either means the detail as a whole cannot be shown, which is
  // exactly the intended outcome — there is no half-rendered state.
  const [organization, shops] = await Promise.all([
    // organization_type is required as well as the id: `id` alone would admit any
    // organization the caller can read, and this page renders a Retailer. It is
    // belt and braces over the migration-7 trigger, which already forbids a
    // non-RETAILER from appearing as retailer_organization_id.
    //
    // Organization STATUS is deliberately not filtered, for the same reason as
    // the relationship above — retailerStatus carries the state instead.
    supabase
      .from("organizations")
      .select("name, status, country_code, default_currency")
      .eq("id", retailerOrganizationId)
      .eq("organization_type", RETAILER_ORGANIZATION_TYPE)
      .maybeSingle()
      .then(unwrapRow<RetailerOrganizationRow>),
    // One set-based read for every shop. Only the five displayed columns are
    // selected: no shop id, no address lines, no region, no postal code, no
    // timestamps. Lifecycle status is not filtered — a SUSPENDED or DEACTIVATED
    // shop remains stored and visible, and omitting it would contradict the shop
    // COUNT the directory shows for the same Retailer.
    supabase
      .from("retailer_shops")
      .select("name, code, city, country_code, status")
      .eq("retailer_organization_id", retailerOrganizationId)
      .then(unwrapRows<RetailerShopRow>),
  ]);

  // ---------------------------------------------------------------------------
  // 4. Assemble — the join id is used above and never returned.
  // ---------------------------------------------------------------------------
  // Nullable columns are passed through as null rather than coerced to "" or a
  // placeholder: "no city recorded" and "city recorded as empty" are different
  // facts, and rendering the distinction is the page's job, not this module's.
  return {
    retailerName: organization.name,
    retailerStatus: organization.status,
    countryCode: organization.country_code,
    defaultCurrency: organization.default_currency,
    relationshipStatus: relationship.status,
    // Sorted by name for a stable, predictable list. Fixed locale so ordering
    // does not vary by host, matching the directory.
    shops: shops
      .map((shop) => ({
        name: shop.name,
        code: shop.code,
        city: shop.city,
        countryCode: shop.country_code,
        status: shop.status,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en")),
  };
}

export async function getVendorRetailerDetail(
  relationshipId: string,
): Promise<VendorRetailerDetailResult> {
  // ---------------------------------------------------------------------------
  // Authorization — the single source of truth, not repeated here.
  // ---------------------------------------------------------------------------
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // Propagated unchanged so the page maps "unauthenticated" -> /login and
    // "unauthorized" -> /access-denied. No detail query runs on this path, and
    // the supplied id is never even parsed: an unauthorized caller learns
    // nothing about it, not even whether it was well-formed.
    return access;
  }

  // ---------------------------------------------------------------------------
  // Input validation — before any query, and not merely for tidiness.
  // ---------------------------------------------------------------------------
  // PostgREST rejects a malformed uuid comparison with a cast error, which the
  // catch below would faithfully report as "unavailable" — telling an authorized
  // Vendor the database is down because someone mistyped a URL. Screening the
  // shape here keeps a bad address an addressing failure.
  if (!UUID_PATTERN.test(relationshipId)) {
    return { status: "not-found" };
  }

  try {
    // Created INSIDE the try. createClient() reads cookies and constructs the
    // Supabase client, and a throw from it is a runtime failure of exactly the
    // kind the catch below exists for — outside the try it would escape this
    // module and surface as an unhandled error rather than the "unavailable"
    // state the page knows how to render.
    const supabase = await createClient();

    // The retailer detail and the owner status are fetched CONCURRENTLY but with
    // deliberately different failure semantics. loadDetail() throws on any read
    // failure, which the catch below turns into the whole-page `unavailable`
    // state — the detail is all-or-nothing. getVendorRetailerOwnerStatus() never
    // throws: it returns its own { status: "unavailable" } on failure, so an
    // owner-status problem degrades ONLY the owner card and cannot take the rest
    // of the Retailer down with it. Both authorize the Vendor independently — the
    // reads under RLS, the RPC inside the database — so neither trusts the other.
    const [retailer, ownerStatus] = await Promise.all([
      loadDetail(
        supabase,
        relationshipId,
        // The ONLY organization id used: from the authorized result, never from
        // a parameter, URL, form field, or browser state.
        access.organizationId,
      ),
      getVendorRetailerOwnerStatus(relationshipId),
    ]);

    return {
      status: "authorized",
      organizationName: access.organizationName,
      retailer,
      ownerStatus,
    };
  } catch (error) {
    // One catch for every failure mode below the authorization boundary. The
    // error is inspected ONLY for its type — never its message, and it is never
    // logged: a Supabase error can name tables, columns, and policies, and a
    // thrown fetch error can carry request URLs, headers, or token material.
    // Nothing about the submitted id is recorded either.
    if (error instanceof RetailerDetailNotFoundError) {
      return { status: "not-found" };
    }

    // Everything else: a reported PostgREST error (rethrown as
    // RetailerDetailUnavailableError above) and a genuine throw (fetch-level
    // TypeError, aborted request, DNS or TLS failure) alike.
    //
    // Still authorized — a data failure must never read as a denial, and can
    // never grant access either, since authorization was settled above. It is
    // never converted to not-found: "we could not read this Retailer" and "this
    // Retailer is not yours to read" are opposite claims, and confusing them
    // would tell a Vendor their own Retailer does not exist at the exact moment
    // the database is unreachable.
    return {
      status: "unavailable",
      organizationName: access.organizationName,
    };
  }
}
