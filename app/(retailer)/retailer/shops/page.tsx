import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getRetailerOwnerPortalAccess,
  getRetailerOwnerPortalShops,
} from "@/lib/retailer-portal/retailer-owner-portal";
import { buildShopKey } from "@/lib/retailer-portal/portal-normalization";
import { StatusBadge } from "@/components/admin/status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { cardClasses } from "@/components/ui/card";
import { LocationIcon, ShopIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Shops · Retailer Owner Portal",
  description: "Read-only list of your Retailer organization's shops.",
};

/**
 * Read-only shop list for the authorized Retailer.
 *
 * Calls exactly one data function, which calls exactly one RPC:
 * public.list_retailer_owner_portal_shops(). That RPC takes no arguments and
 * resolves its own scope from auth.uid(), so this page cannot — and does not —
 * tell the database which Retailer to list. There is no dynamic segment, no
 * search parameter, and no prop through which a tenant could be nominated.
 *
 * NO IDENTIFIERS ANYWHERE. The RPC returns no shop id, so none reaches the
 * markup, a DOM attribute, a URL, a React key, the serialized RSC payload, or a
 * browser log. React keys are built from shopCode plus array index — see
 * buildShopKey — precisely because there is no id to key on and shopCode is not
 * unique in the schema.
 *
 * READ-ONLY. No create, edit, delete, activate, deactivate, row menu, or row
 * link. Rows are not interactive at all: with no shop-detail route in this
 * milestone, a clickable row would have nowhere to go and would need an id to
 * get there.
 */

/** Renders a nullable text column without printing an empty cell. */
function OptionalCell({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <span className="text-slate-400" aria-label="Not recorded">
        —
      </span>
    );
  }

  return <>{value}</>;
}

export default async function RetailerShopsPage() {
  // Authorization first, and at this page's own server boundary — it is directly
  // addressable, so it must not depend on the layout having run.
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }

  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const shopsResult = await getRetailerOwnerPortalShops();

  // A failed READ is not a failed authorization. The caller is a verified,
  // authorized Retailer Owner — the check above established that — so this
  // renders a retry-safe error region inside the portal rather than redirecting
  // them to an access-denied page that would misattribute a transport or schema
  // fault to their permissions.
  if (shopsResult.status === "unavailable") {
    return (
      <div className="mx-auto w-full max-w-6xl">
        <ShopsHeader />

        {/* Generic by design. The underlying cause — a transport fault, an RPC
            error, or a malformed row — was logged server-side as a sanitized
            category. No SQL, RPC name, schema name, policy, id, or stack
            trace reaches the browser. */}
        <Alert tone="warning" role="alert" title="Shops could not be loaded" className="mt-8">
          Something went wrong while loading your shops. Please try again in a
          moment.
        </Alert>
      </div>
    );
  }

  const { shops } = shopsResult;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <ShopsHeader shopCount={shops.length} />

      {shops.length === 0 ? (
        /* Empty state. Worded so it cannot be mistaken for a permission
           problem: the caller IS authorized — that is why they can see this
           page — and their Retailer simply has no shops recorded yet. No "Add
           shop" action: this milestone is read-only, and shop creation is a
           Vendor Admin capability. */
        <EmptyState
          className="mt-8"
          icon={<ShopIcon className="h-6 w-6" />}
          title="No shops to show"
          description="There are no shops recorded for your organization yet. Shops added by SalesReward will appear here automatically."
        />
      ) : (
        <>
          {/* Desktop: a real table. Horizontally scrollable rather than
              wrapping, so narrow viewports never squash the columns. */}
          <div className={cardClasses("standard", "mt-8 hidden overflow-hidden sm:block")}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Shops belonging to your Retailer organization
                </caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Shop
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Code
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      City
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Country
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {/* Rendered in the RPC's own order (name, code NULLS LAST,
                      id). Nothing is re-sorted here — a second, locale-dependent
                      ordering could disagree with the database's. */}
                  {shops.map((shop, index) => (
                    <tr
                      key={buildShopKey(shop, index)}
                      className="transition-colors hover:bg-slate-50"
                    >
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {shop.shopName}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <OptionalCell value={shop.shopCode} />
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <OptionalCell value={shop.city} />
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <OptionalCell value={shop.countryCode} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={shop.shopStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: stacked cards. A five-column table is unreadable below
              `sm`, and horizontal scrolling for primary content is worse than
              restacking it. */}
          <ul className="mt-8 flex flex-col gap-3 sm:hidden">
            {shops.map((shop, index) => (
              <li
                key={buildShopKey(shop, index)}
                className={cardClasses("standard", "p-4")}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"
                    >
                      <LocationIcon className="h-4 w-4" />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                      {shop.shopName}
                    </p>
                  </div>
                  <StatusBadge status={shop.shopStatus} />
                </div>

                <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Code</dt>
                    <dd className="text-slate-700">
                      <OptionalCell value={shop.shopCode} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">City</dt>
                    <dd className="text-slate-700">
                      <OptionalCell value={shop.city} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Country</dt>
                    <dd className="text-slate-700">
                      <OptionalCell value={shop.countryCode} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Page title block. Shared by the loaded, empty, and error renders. */
function ShopsHeader({ shopCount }: { shopCount?: number }) {
  return (
    <PageHeader
      title="Shops"
      description={
        shopCount === undefined
          ? "Shops recorded for your Retailer organization."
          : shopCount === 1
            ? "1 shop recorded for your Retailer organization."
            : `${shopCount.toLocaleString("en-US")} shops recorded for your Retailer organization.`
      }
    />
  );
}
