import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { getRetailerAssignedProducts } from "@/lib/products/retailer-products";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { cardClasses } from "@/components/ui/card";
import { ProductsIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Products · Retailer Portal",
  description: "The products your Vendor has assigned to your Retailer.",
};

/**
 * The Retailer's READ-ONLY view of the products assigned to them.
 *
 * NO MANAGEMENT CONTROLS OF ANY KIND. There is no form, no button that mutates, and no
 * Server Action imported by this route — creating, editing, activating, assigning and
 * withdrawing are Vendor capabilities, and the Retailer roles hold none of the
 * permissions behind them. The single read is gated on RETAILER_PRODUCTS_READ, mapped
 * to RETAILER_OWNER and RETAILER_MANAGER only.
 *
 * WHY SALES STAFF DO NOT SEE THIS PAGE. They hold no RETAILER_PRODUCTS_READ mapping, so
 * `list_retailer_assigned_products()` refuses them and the page redirects. The portal
 * navigation does not offer them the link either. A future receipt-matching step will
 * need its own narrowly-scoped operation rather than this broad catalog read.
 *
 * WHAT IS NEVER RENDERED: the Vendor's identity or organization id, the product's
 * creator, the assignment id, assignment timestamps, audit metadata, or any other
 * Retailer's data. The RPC returns none of them.
 */

const thClasses = "px-4 py-3 font-semibold";
const tdClasses = "px-4 py-3 text-slate-600";

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

export default async function RetailerProductsPage() {
  const access = await getRetailerPortalAccess();

  // The layout has already handled these, but this page is directly addressable and
  // must not depend on that.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const result = await getRetailerAssignedProducts();

  // A Sales Staff member (or anyone else without the mapping) is refused by the RPC and
  // sent to the same generic denial as every other portal denial. Fails closed.
  if (result.status === "denied") {
    redirect("/retailer-access-denied");
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Products"
        description="The products currently available to your Retailer. This list is maintained by your Vendor."
      />

      {result.status !== "ok" ? (
        <Alert
          tone="warning"
          role="alert"
          title="Products could not be loaded"
          className="mt-8"
        >
          Something went wrong while loading your products. Please try again in a
          moment.
        </Alert>
      ) : result.products.length === 0 ? (
        /* Worded so it cannot be mistaken for a permission problem: the reader IS
           authorized — that is why they can see this page — their Vendor simply has not
           assigned anything yet. */
        <EmptyState
          className="mt-8"
          icon={<ProductsIcon className="h-6 w-6" />}
          title="No products yet"
          description="Products your Vendor assigns to your Retailer will appear here automatically."
        />
      ) : (
        <>
          {/* Desktop table. Horizontally scrollable rather than wrapping. */}
          <div className={cardClasses("standard", "mt-8 hidden overflow-hidden sm:block")}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Products assigned to your Retailer
                </caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className={thClasses}>
                      Code
                    </th>
                    <th scope="col" className={thClasses}>
                      Product
                    </th>
                    <th scope="col" className={thClasses}>
                      Brand
                    </th>
                    <th scope="col" className={thClasses}>
                      Barcode
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {/* Rendered in the RPC's own order (name, code, id). Nothing is
                      re-sorted here — a second, locale-dependent ordering could
                      disagree with the database's. Rows are not interactive: there is
                      no product-detail route for a Retailer, and this milestone gives
                      them nothing to do with a product. */}
                  {result.products.map((product) => (
                    <tr key={product.productId} className="transition-colors hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-700">
                        {product.productCode}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-900">
                          {product.productName}
                        </span>
                        {product.description && (
                          <span className="mt-0.5 block max-w-md text-xs text-slate-500">
                            {product.description}
                          </span>
                        )}
                      </td>
                      <td className={`whitespace-nowrap ${tdClasses}`}>
                        <OptionalCell value={product.brand} />
                      </td>
                      <td className={`whitespace-nowrap font-mono ${tdClasses}`}>
                        <OptionalCell value={product.barcode} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: stacked cards. */}
          <ul className="mt-8 flex flex-col gap-3 sm:hidden">
            {result.products.map((product) => (
              <li key={product.productId} className={cardClasses("standard", "p-4")}>
                <p className="text-sm font-medium text-slate-900">{product.productName}</p>
                <p className="font-mono text-xs text-slate-500">{product.productCode}</p>
                {product.description && (
                  <p className="mt-2 text-xs text-slate-500">{product.description}</p>
                )}
                <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Brand</dt>
                    <dd className="text-slate-700">
                      <OptionalCell value={product.brand} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Barcode</dt>
                    <dd className="font-mono text-slate-700">
                      <OptionalCell value={product.barcode} />
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
