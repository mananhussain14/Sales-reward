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
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionCard } from "@/components/ui/card";
import { ProductsIcon } from "@/components/ui/icons";

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
      ? "bg-emerald-50 text-emerald-700"
      : "bg-slate-100 text-slate-600";

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
      <span className="text-slate-400" aria-label="Not recorded">
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

const thClasses = "px-5 py-3 text-left font-semibold";
const tdClasses = "px-5 py-3.5 text-sm text-slate-600";

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
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <PageHeader
        title="Products"
        description="Your product catalog, and which of your Retailers can see each product."
      />

      {/* ------------------------------------------------------------------ */}
      {/* Catalog                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section aria-label="Catalog" className="space-y-3">
        <SectionHeader title="Catalog" />

        {result.status !== "ok" ? (
          <EmptyState
            icon={<ProductsIcon className="h-6 w-6" />}
            tone="amber"
            title="Products could not be loaded"
            description="Something went wrong while loading your catalog. Please try again in a moment."
          />
        ) : result.products.length === 0 ? (
          <EmptyState
            icon={<ProductsIcon className="h-6 w-6" />}
            tone="amber"
            title="No products yet"
            description="Add your first product below. You can assign it to your Retailers once it exists."
          />
        ) : (
          <>
            {/* Desktop table. Horizontally scrollable rather than wrapping. */}
            <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card sm:block">
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Your product catalog</caption>
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
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
                  <tbody className="divide-y divide-slate-100">
                    {/* Rendered in the RPC's own order (newest first). The product id is
                        the stable key and appears only in the href, never as text. */}
                    {result.products.map((product) => (
                      <tr key={product.productId} className="transition-colors hover:bg-slate-50">
                        <td className="whitespace-nowrap px-5 py-3.5 font-mono text-sm text-slate-700">
                          {product.productCode}
                        </td>
                        <td className="px-5 py-3.5 text-sm">
                          <Link
                            href={`/products/${product.productId}`}
                            className="rounded-sm font-medium text-slate-900 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                          >
                            {product.productName}
                          </Link>
                          {product.brand && (
                            <span className="block text-xs text-slate-500">
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
            <ul className="flex flex-col gap-3 sm:hidden">
              {result.products.map((product) => (
                <li
                  key={product.productId}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/products/${product.productId}`}
                        className="rounded-sm text-sm font-medium text-slate-900 underline-offset-4 hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        {product.productName}
                      </Link>
                      <span className="block font-mono text-xs text-slate-500">
                        {product.productCode}
                      </span>
                    </div>
                    <StatusPill product={product} />
                  </div>
                  <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Barcode</dt>
                      <dd className="font-mono text-slate-700">
                        <OptionalCell value={product.barcode} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Assigned to</dt>
                      <dd className="text-slate-700">
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
      <SectionCard title="Add a product">
        <CreateProductForm />
      </SectionCard>
    </div>
  );
}
