// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access, this must never be imported into a Client
// Component. It transitively imports `next/headers` (via @/lib/supabase/server),
// which throws at build time if it ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";

/**
 * Read-only Retailer directory for the authorized Vendor organization.
 *
 * Authorization is delegated in full to getVendorSuperAdminAccess() — not
 * re-implemented — and this function takes no arguments, so no caller can
 * nominate which Vendor's retailers are listed, which Retailer is read, or whose
 * relationships are shown. The only organization id that reaches a query is
 * access.organizationId, which the authorization chain derived from the caller's
 * own verified token. A Vendor organization id, Retailer id, user id, email, URL
 * parameter, form value, or anything else the browser could set would let a
 * caller choose whose directory they see, which is precisely the vulnerability
 * the no-argument shape exists to prevent.
 *
 * RLS remains the database enforcement boundary. Every read below goes through
 * the ordinary authenticated Supabase server client under the caller's own
 * token, so the Retailer RLS read policies — organizations_select_vendor_
 * managed_retailers, vendor_retailers_select_vendor_authorized, and
 * retailer_shops_select_vendor_authorized — decide what is readable at all.
 * service_role is not used here or anywhere in this codebase: it would bypass
 * RLS entirely and make this module, rather than the database, the thing
 * standing between one Vendor and another Vendor's retailers. The explicit
 * vendor_organization_id filter below narrows within what the policies already
 * permit; it is not what makes the read safe.
 *
 * The rows this returns are display-only projections plus EXACTLY ONE id: the
 * vendor_retailers row's own primary key, carried as `relationshipId` so the
 * directory can link each Retailer to its detail route. Every other internal id
 * — the Retailer organization id, the Vendor organization id, shop ids — is
 * still used to join on the server and then dropped, and none reaches the RSC
 * payload.
 *
 * That one exception is deliberate and narrow. A detail route needs some
 * addressable handle, so the question is which id to expose, not whether. The
 * relationship id is the least consequential one available: it is referenced by
 * no other table, it means nothing outside this Vendor's own view, and it keeps
 * the Retailer organization's primary key — the id that products, campaigns,
 * claims, coins, and the Retailer's own future portal will all join on — out of
 * URLs, logs, referrers, and screenshots entirely.
 *
 * `relationshipId` IS NOT AUTHORIZATION AND MUST NEVER BE TREATED AS ANY. It is
 * an address, not a capability: holding one grants nothing. The detail loader
 * that receives it back must still resolve the caller's own Vendor through
 * getVendorSuperAdminAccess(), still filter the relationship row by that
 * Vendor's organization id, and still read under RLS — exactly as this module
 * does. A relationship id belonging to another Vendor must read as not-found,
 * not as access.
 *
 * Two failure kinds stay strictly apart, as in the member directory and the
 * audit history:
 *
 *   - Authorization failure -> a non-authorized status for the WHOLE directory.
 *   - Data query failure    -> `retailers: null`, still authorized.
 */

/** The organization type a row must hold to be a Retailer. */
const RETAILER_ORGANIZATION_TYPE = "RETAILER";

/**
 * One rendered directory row. Carries exactly one id — the relationship's own —
 * and no other, for the reasons set out in the module comment above.
 */
export type VendorRetailer = {
  /**
   * public.vendor_retailers.id: the opaque handle for this Vendor's relationship
   * to this Retailer. Its ONLY purpose is to address /retailers/[relationshipId].
   * It is never an authorization token, and it is never rendered as text.
   */
  relationshipId: string;
  retailerName: string;
  /** The Retailer organization's own lifecycle state. */
  retailerStatus: string;
  /** The vendor->retailer relationship's lifecycle state — a separate fact. */
  relationshipStatus: string;
  shopCount: number;
};

export type VendorRetailersResult =
  | {
      status: "authorized";
      organizationName: string;
      /**
       * `[]` means the Vendor genuinely manages no Retailers.
       * `null` means the directory could not be loaded — never treat it as empty.
       */
      retailers: VendorRetailer[] | null;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

// Shapes of the columns read from each table, matching the migrations exactly.
// Selected narrowly: no timestamps, no shop names, codes, or addresses. A column
// that is never read cannot leak from a page, a payload, a log, or a future
// refactor of this file.
//
// The relationship id is now read — it is the one id this module returns — while
// retailer_organization_id remains join-only and is dropped during assembly.
type VendorRetailerRow = { id: string; retailer_organization_id: string; status: string };
type RetailerOrganizationRow = { id: string; name: string; status: string };
type RetailerShopRow = { retailer_organization_id: string };

/**
 * Thrown when a read returns a PostgREST error, so the single catch below can
 * treat reported errors and thrown errors identically. The Supabase error is
 * deliberately NOT attached: it can name tables, columns, and policies, and
 * nothing here may reach a browser.
 */
class RetailerDirectoryUnavailableError extends Error {}

/** Rejects a reported PostgREST error; otherwise yields the rows (never null). */
function unwrap<Row>(result: { data: Row[] | null; error: unknown }): Row[] {
  if (result.error || !result.data) throw new RetailerDirectoryUnavailableError();
  return result.data;
}

/**
 * Loads and assembles the directory. THREE queries TOTAL, regardless of Retailer
 * count — never one per Retailer, and never one per shop.
 *
 * Each is a set-based read keyed by the ids collected from the previous step, and
 * the joining happens in memory here with Maps. The alternative — reading a
 * Retailer's organization row or counting its shops inside a loop — would issue
 * one round trip per Retailer, so a directory of fifty Retailers would cost a
 * hundred and one queries and get slower with every Retailer onboarded. Three
 * set-based reads cost three either way.
 */
async function loadRetailers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
): Promise<VendorRetailer[]> {
  // ---------------------------------------------------------------------------
  // 1. Relationships owned by the authorized Vendor — every lifecycle state.
  // ---------------------------------------------------------------------------
  // Deliberately NOT filtered by status. ACTIVE, SUSPENDED, and DEACTIVATED
  // relationships are all still stored, and a directory that hid the paused and
  // ended ones would misrepresent what the Vendor actually has on record — the
  // Vendor would have no way to see, let alone resume, a Retailer they suspended.
  // The status is shown per row instead, which is why relationshipStatus exists
  // at all. This matches the member directory's treatment of memberships.
  //
  // vendor_retailers_select_vendor_authorized independently confines this to
  // Vendor organizations the caller may read; the filter narrows to the one
  // organization the caller was authorized for.
  const relationships = unwrap<VendorRetailerRow>(
    await supabase
      .from("vendor_retailers")
      // `id` is the relationship's own primary key, returned to the page as
      // relationshipId. The vendor_organization_id is a FILTER only and is never
      // selected: the page already knows which Vendor it is looking at, and a
      // Vendor id in the payload is one a form or link could later echo back.
      .select("id, retailer_organization_id, status")
      .eq("vendor_organization_id", organizationId),
  );

  // No Retailers is a legitimate answer. It also means both `.in()` calls below
  // would receive an empty array, which PostgREST would turn into a match-nothing
  // filter: two wasted round trips to learn what is already known.
  if (relationships.length === 0) return [];

  // Deduplicated because `.in()` takes a set. vendor_retailers_unique_pair makes
  // duplicate retailer ids for one Vendor impossible today — this simply does not
  // depend on that constraint holding.
  const retailerIds = [
    ...new Set(relationships.map((relationship) => relationship.retailer_organization_id)),
  ];

  // ---------------------------------------------------------------------------
  // 2 + 3. Retailer organizations and their shops — independent, so concurrent.
  // ---------------------------------------------------------------------------
  // Both are keyed by the ids gathered above, so each is a single set-based read.
  // Neither needs the other's result, so they run together rather than in
  // sequence. Promise.all is safe against rejection here because the whole
  // function is wrapped in one try/catch by the caller: a failure of either means
  // the directory as a whole is unavailable, which is exactly the intended
  // outcome.
  const [retailerOrganizations, shops] = await Promise.all([
    // organization_type is required as well as the id set: `id` alone would admit
    // any organization the caller can read, and this directory renders Retailers.
    // Organization STATUS is deliberately not filtered, for the same reason the
    // relationship status is not — a SUSPENDED or DEACTIVATED Retailer company is
    // still a Retailer this Vendor manages, and hiding it would erase it from the
    // directory rather than describe it. retailerStatus carries the state instead.
    supabase
      .from("organizations")
      .select("id, name, status")
      .in("id", retailerIds)
      .eq("organization_type", RETAILER_ORGANIZATION_TYPE)
      .then(unwrap<RetailerOrganizationRow>),
    // Only the owning id is selected — the count is computed here, so no shop
    // name, code, or address is ever read. Shop status is deliberately not
    // filtered: SUSPENDED and DEACTIVATED shops remain stored and visible, so a
    // count that omitted them would contradict the shop list a Vendor will later
    // see for the same Retailer.
    supabase
      .from("retailer_shops")
      .select("retailer_organization_id")
      .in("retailer_organization_id", retailerIds)
      .then(unwrap<RetailerShopRow>),
  ]);

  // ---------------------------------------------------------------------------
  // 4. Assemble — join ids are used here and then discarded; only the
  //    relationship id survives into the returned rows.
  // ---------------------------------------------------------------------------
  const retailerOrganizationsById = new Map(
    retailerOrganizations.map((organization) => [organization.id, organization]),
  );

  // One pass over the shop rows, so counting does not scale with Retailer count.
  // A Retailer with no shops simply never appears here and reads back as 0 below.
  const shopCountsByRetailerId = new Map<string, number>();
  for (const shop of shops) {
    const existing = shopCountsByRetailerId.get(shop.retailer_organization_id) ?? 0;
    shopCountsByRetailerId.set(shop.retailer_organization_id, existing + 1);
  }

  const retailers: VendorRetailer[] = [];
  for (const relationship of relationships) {
    const organization = retailerOrganizationsById.get(relationship.retailer_organization_id);

    // A relationship whose Retailer organization is not returned cannot be
    // rendered truthfully — there is no name and no retailer status to show, and
    // inventing either would be worse than omitting the row. The FK is NOT NULL
    // and the organizations policy admits the Retailers a Vendor manages, so this
    // is an anomaly rather than an expected branch: a hard-deleted organization
    // (which RESTRICT forbids), a row whose type is not RETAILER, or a policy
    // change. Whatever the cause, the honest response is to say nothing about a
    // row we cannot read.
    if (!organization) continue;

    retailers.push({
      // From the relationship row this query returned under RLS for the
      // authorized Vendor — never from a parameter, a URL, or the organizations
      // read. An id assembled from anywhere else would be an id the caller could
      // influence.
      relationshipId: relationship.id,
      retailerName: organization.name,
      retailerStatus: organization.status,
      relationshipStatus: relationship.status,
      shopCount: shopCountsByRetailerId.get(relationship.retailer_organization_id) ?? 0,
    });
  }

  // Sorted by Retailer name for a stable, predictable directory. Fixed locale so
  // ordering does not vary by host.
  return retailers.sort((a, b) => a.retailerName.localeCompare(b.retailerName, "en"));
}

export async function getVendorRetailers(): Promise<VendorRetailersResult> {
  // ---------------------------------------------------------------------------
  // Authorization — the single source of truth, not repeated here.
  // ---------------------------------------------------------------------------
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // Propagated unchanged so the page maps "unauthenticated" -> /login and
    // "unauthorized" -> /access-denied. No directory query runs on this path.
    return access;
  }

  const supabase = await createClient();

  try {
    return {
      status: "authorized",
      organizationName: access.organizationName,
      // The ONLY organization id used: from the authorized result, never from a
      // parameter, URL, form field, or browser state.
      retailers: await loadRetailers(supabase, access.organizationId),
    };
  } catch {
    // One catch for every failure mode — a reported PostgREST error (rethrown as
    // RetailerDirectoryUnavailableError above) and a genuine throw (fetch-level
    // TypeError, aborted request, DNS or TLS failure) alike. The value is not
    // bound or logged: it may carry request URLs, headers, or token material.
    //
    // Still `status: "authorized"` — a data failure must never read as a denial,
    // and can never grant access either, since authorization was settled above.
    // It is never converted to `[]`: "we could not read the directory" and "this
    // Vendor manages no Retailers" are opposite claims, and confusing them would
    // tell a Vendor they have no Retailers at the exact moment the database is
    // unreachable.
    return {
      status: "authorized",
      organizationName: access.organizationName,
      retailers: null,
    };
  }
}
