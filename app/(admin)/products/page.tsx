import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { getVendorProducts } from "@/lib/products/vendor-products";
import {
  productStatusLabel,
  type VendorProduct,
} from "@/lib/products/product-normalization";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import {
  CreateProductForm,
  ProductStatusForm,
} from "@/app/(admin)/products/product-forms";

export const metadata: Metadata = {
  title: "Products · SalesReward Admin",
  description: "The Vendor product catalog and its Retailer assignments.",
};

/**
 * The Vendor product catalog.
 *
 * AUTHORIZATION IS RESOLVED HERE, AT THIS PAGE'S OWN SERVER BOUNDARY, and again by the
 * RPC behind the list. The page is directly addressable, so its state must come from
 * the verified session rather than from how the caller arrived. React `cache` makes the
 * repeat resolution free — the layout and this page share one.
 *
 * WHAT IS NEVER RENDERED: the Vendor organization id, the creator's profile or Auth
 * metadata, any membership internal, any audit metadata, and any other Vendor's
 * product. `list_vendor_products()` returns none of them, so there is nothing of that
 * kind here to withhold. Nor is there any price, incentive, campaign, reward, coin or
 * payout field — none exists.
 */

/** A neutral status pill. Two states only. */
function StatusPill({ product }: { product: VendorProduct }) {
  const tone =
    product.status === "ACTIVE"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {productStatusLabel(product.status)}
    </span>
  );
}

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

/** Reads as prose so "1 Retailer" never renders as "1 Retailers". */
function AssignmentCount({ count }: { count: number }) {
  return (
    <span>
      {count} {count === 1 ? "Retailer" : "Retailers"}
    </span>
  );
}

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const tdClasses = "px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400";

export default async function ProductsPage() {
  const access = await getVendorSuperAdminAccess();

  // The layout has already handled these, but this page is directly addressable and
  // must not depend on that. The branches are identical, so the two cannot disagree.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  const result = await getVendorProducts();

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Products
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Your product catalog, and which of your Retailers can see each product.
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Catalog                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="catalog-heading" className="mt-8">
        <h3
          id="catalog-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Catalog
        </h3>

        {result.status !== "ok" ? (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/40"
          >
            <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Products could not be loaded
            </h4>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
              Something went wrong while loading your catalog. Please try again in a
              moment.
            </p>
          </div>
        ) : result.products.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              No products yet
            </h4>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              Add your first product below. You can assign it to your Retailers once it
              exists.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table. Horizontally scrollable rather than wrapping. */}
            <div className="mt-3 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                  <caption className="sr-only">Your product catalog</caption>
                  <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                    <tr>
                      <th scope="col" className={thClasses}>
                        Code
                      </th>
                      <th scope="col" className={thClasses}>
                        Product
                      </th>
                      <th scope="col" className={thClasses}>
                        Barcode
                      </th>
                      <th scope="col" className={thClasses}>
                        Assigned to
                      </th>
                      <th scope="col" className={thClasses}>
                        Status
                      </th>
                      <th scope="col" className={thClasses}>
                        Updated
                      </th>
                      <th scope="col" className={thClasses}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {/* Rendered in the RPC's own order (newest first). The product id is
                        the stable key and appears only in the href, never as text. */}
                    {result.products.map((product) => (
                      <tr key={product.productId}>
                        <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-zinc-700 dark:text-zinc-300">
                          {product.productCode}
                        </td>
                        <td className="px-5 py-3.5 text-sm">
                          <Link
                            href={`/products/${product.productId}`}
                            className="rounded-sm font-medium text-zinc-900 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:text-zinc-50 dark:hover:text-indigo-400 dark:focus-visible:ring-offset-zinc-950"
                          >
                            {product.productName}
                          </Link>
                          {product.brand && (
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                              {product.brand}
                            </span>
                          )}
                        </td>
                        <td className={`whitespace-nowrap font-mono ${tdClasses}`}>
                          <OptionalCell value={product.barcode} />
                        </td>
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          <AssignmentCount count={product.activeAssignmentCount} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <StatusPill product={product} />
                        </td>
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          {formatOwnerTimestamp(product.updatedAt ?? product.createdAt)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <ProductStatusForm
                            productId={product.productId}
                            productName={product.productName}
                            currentStatus={product.status}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: stacked cards. A seven-column table is unreadable below `sm`. */}
            <ul className="mt-3 flex flex-col gap-3 sm:hidden">
              {result.products.map((product) => (
                <li
                  key={product.productId}
                  className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/products/${product.productId}`}
                        className="rounded-sm text-sm font-medium text-zinc-900 underline-offset-4 hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-zinc-50 dark:hover:text-indigo-400"
                      >
                        {product.productName}
                      </Link>
                      <span className="block font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {product.productCode}
                      </span>
                    </div>
                    <StatusPill product={product} />
                  </div>
                  <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Barcode</dt>
                      <dd className="font-mono text-zinc-700 dark:text-zinc-300">
                        <OptionalCell value={product.barcode} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Assigned to</dt>
                      <dd className="text-zinc-700 dark:text-zinc-300">
                        <AssignmentCount count={product.activeAssignmentCount} />
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3">
                    <ProductStatusForm
                      productId={product.productId}
                      productName={product.productName}
                      currentStatus={product.status}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Add a product                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="create-heading" className="mt-10">
        <h3
          id="create-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Add a product
        </h3>
        <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <CreateProductForm />
        </div>
      </section>
    </div>
  );
}
