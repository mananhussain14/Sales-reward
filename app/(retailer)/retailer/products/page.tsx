import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { getRetailerAssignedProducts } from "@/lib/products/retailer-products";

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

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const tdClasses = "px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400";

function OptionalCell({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <span className="text-zinc-400 dark:text-zinc-600" aria-label="Not recorded">
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
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Products
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          The products currently available to your Retailer. This list is maintained by
          your Vendor.
        </p>
      </header>

      {result.status !== "ok" ? (
        <div
          role="alert"
          className="mt-8 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/40"
        >
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Products could not be loaded
          </h3>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            Something went wrong while loading your products. Please try again in a
            moment.
          </p>
        </div>
      ) : result.products.length === 0 ? (
        /* Worded so it cannot be mistaken for a permission problem: the reader IS
           authorized — that is why they can see this page — their Vendor simply has not
           assigned anything yet. */
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-950">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            No products yet
          </h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            Products your Vendor assigns to your Retailer will appear here
            automatically.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table. Horizontally scrollable rather than wrapping. */}
          <div className="mt-8 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                <caption className="sr-only">
                  Products assigned to your Retailer
                </caption>
                <thead className="bg-zinc-50 dark:bg-zinc-900/50">
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
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {/* Rendered in the RPC's own order (name, code, id). Nothing is
                      re-sorted here — a second, locale-dependent ordering could
                      disagree with the database's. Rows are not interactive: there is
                      no product-detail route for a Retailer, and this milestone gives
                      them nothing to do with a product. */}
                  {result.products.map((product) => (
                    <tr key={product.productId}>
                      <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-zinc-700 dark:text-zinc-300">
                        {product.productCode}
                      </td>
                      <td className="px-5 py-3.5 text-sm">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {product.productName}
                        </span>
                        {product.description && (
                          <span className="mt-0.5 block max-w-md text-xs text-zinc-500 dark:text-zinc-400">
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
              <li
                key={product.productId}
                className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
              >
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {product.productName}
                </p>
                <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {product.productCode}
                </p>
                {product.description && (
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {product.description}
                  </p>
                )}
                <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Brand</dt>
                    <dd className="text-zinc-700 dark:text-zinc-300">
                      <OptionalCell value={product.brand} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Barcode</dt>
                    <dd className="font-mono text-zinc-700 dark:text-zinc-300">
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
