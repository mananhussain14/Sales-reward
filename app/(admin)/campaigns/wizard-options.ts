// SERVER-ONLY MODULE.
//
// The selectable options the campaign wizard needs, gathered once so the create page and
// the edit page cannot offer different sets.
//
// EVERY LIST COMES FROM AN RPC THAT DERIVES THE VENDOR FROM auth.uid(). None of the three
// takes a tenant argument, so nothing here can be widened by a URL, a form field or a
// cookie. `optionsReady` is false when any of them failed, and the wizard then refuses to
// submit — a READ failure must never be converted into a write that silently drops a
// selection the operator could not see.
import { getVendorRetailers } from "@/lib/retailers/vendor-retailers";
import { getVendorProducts } from "@/lib/products/vendor-products";
import { getRetailerGroups } from "@/lib/campaigns/retailer-groups";
import type {
  SelectableGroup,
  SelectableProduct,
  SelectableRetailer,
} from "@/app/(admin)/campaigns/campaign-wizard";

export type WizardOptions = {
  retailers: SelectableRetailer[];
  groups: SelectableGroup[];
  products: SelectableProduct[];
  optionsReady: boolean;
  timeZones: string[];
};

/**
 * The IANA zones offered by the time-zone picker.
 *
 * Resolved from the RUNTIME'S OWN zone database via Intl, never from a list committed to
 * this repository — a hard-coded array would start disagreeing with the server the first
 * time a zone was added or renamed, and the database validates the chosen name against
 * pg_timezone_names regardless.
 *
 * `supportedValuesOf` is available on every Node version this project runs. The fallback
 * is a deliberately small, honest set rather than a long guess: if the runtime cannot
 * enumerate zones, offering it a hundred names it may not know would produce a submit
 * that fails in SQL for a reason the operator cannot act on.
 */
function availableTimeZones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;

  if (typeof supported === "function") {
    try {
      return supported("timeZone");
    } catch {
      // Falls through to the minimal set below.
    }
  }
  return ["UTC", "Asia/Dubai", "Europe/London", "America/New_York"];
}

/**
 * Everything the wizard's three selection steps need.
 *
 * The three reads run CONCURRENTLY: they are independent, each is authorized on its own,
 * and running them in sequence would pay three round trips for no additional safety.
 */
export async function getWizardOptions(): Promise<WizardOptions> {
  const [retailerResult, groupResult, productResult] = await Promise.all([
    getVendorRetailers(),
    getRetailerGroups(),
    getVendorProducts(),
  ]);

  // `retailers: null` means the directory could not be loaded — never treat it as empty.
  const retailerRows =
    retailerResult.status === "authorized" && retailerResult.retailers !== null
      ? retailerResult.retailers
      : null;

  const retailers: SelectableRetailer[] = (retailerRows ?? []).map((retailer) => {
    // A Retailer whose relationship or organization is not ACTIVE stays selectable, but
    // is labelled: publication will exclude it, and an operator who cannot see why would
    // read the resulting eligibility count as a bug.
    const suspended =
      retailer.relationshipStatus !== "ACTIVE" || retailer.retailerStatus !== "ACTIVE";
    return {
      vendorRetailerId: retailer.relationshipId,
      retailerName: retailer.retailerName,
      isSelectable: !suspended,
      statusNote: suspended ? "Inactive — excluded when published" : null,
    };
  });

  const groups: SelectableGroup[] =
    groupResult.status === "ok"
      ? groupResult.groups.map((group) => ({
          groupId: group.groupId,
          name: group.name,
          memberCount: group.memberCount,
          // An archived group can still be shown for an existing draft that already
          // references it, but it is marked so nobody picks one by accident.
          isSelectable: group.status === "ACTIVE",
        }))
      : [];

  const products: SelectableProduct[] =
    productResult.status === "ok"
      ? productResult.products.map((product) => ({
          productId: product.productId,
          productCode: product.productCode,
          productName: product.productName,
          brand: product.brand,
          // An INACTIVE product is never resolved into an eligibility snapshot.
          isSelectable: product.status === "ACTIVE",
        }))
      : [];

  const optionsReady =
    retailerRows !== null && groupResult.status === "ok" && productResult.status === "ok";

  return { retailers, groups, products, optionsReady, timeZones: availableTimeZones() };
}
