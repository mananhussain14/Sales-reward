import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  getProductRetailerAssignments,
  getVendorProducts,
} from "@/lib/products/vendor-products";
import {
  canAssignToRetailer,
  productStatusLabel,
} from "@/lib/products/product-normalization";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  AssignRetailerForm,
  EditProductForm,
  ProductStatusForm,
  UnassignRetailerForm,
} from "@/app/(admin)/products/product-forms";

export const metadata: Metadata = {
  title: "Product · SalesReward Admin",
};

/**
 * One product: its display details, its status, and which of this Vendor's Retailers
 * can see it.
 *
 * THE PRODUCT ID IN THE URL IS AN ADDRESS, NOT AUTHORIZATION. It is never used to look
 * anything up directly: the catalog is read through list_vendor_products(), which
 * returns only this Vendor's own products, and the product is then FOUND IN THAT LIST.
 * An id belonging to another Vendor is therefore simply absent and renders the ordinary
 * not-found page — it can never select a foreign row, and the assignment RPC re-checks
 * the same ownership independently in SQL.
 *
 * WHAT IS NEVER RENDERED: the Vendor organization id, the creator's identity, audit
 * metadata, membership internals, and any Retailer that is not this Vendor's. The two
 * RPCs return none of them.
 */
export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { productId } = await params;
  const normalizedId = productId.trim().toLowerCase();

  const catalog = await getVendorProducts();

  if (catalog.status === "denied") {
    redirect("/access-denied");
  }
  if (catalog.status !== "ok") {
    throw new Error("The product catalog is temporarily unavailable.");
  }

  const product = catalog.products.find((entry) => entry.productId === normalizedId);

  // Not this Vendor's product, or not a product at all — reported identically.
  if (!product) {
    notFound();
  }

  const assignments = await getProductRetailerAssignments(product.productId);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href="/products"
          className="rounded-sm text-zinc-500 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-zinc-400 dark:hover:text-indigo-400"
        >
          ← Products
        </Link>
      </nav>

      <header className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {product.productName}
          </h2>
          <p className="mt-1 font-mono text-sm text-zinc-500 dark:text-zinc-400">
            {product.productCode}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {productStatusLabel(product.status)}
          </span>
          <ProductStatusForm
            productId={product.productId}
            productName={product.productName}
            currentStatus={product.status}
          />
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Details                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="details-heading" className="mt-8">
        <h3
          id="details-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Details
        </h3>
        <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <EditProductForm product={product} />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Retailer assignments                                                */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="assignments-heading" className="mt-10">
        <h3
          id="assignments-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Retailer assignments
        </h3>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Assigned Retailers see this product while it is active. Withdrawing keeps the
          record and can be reversed.
        </p>

        {assignments.status !== "ok" ? (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/40"
          >
            <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Assignments could not be loaded
            </h4>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
              Something went wrong. Please try again in a moment.
            </p>
          </div>
        ) : assignments.assignments.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              No Retailers yet
            </h4>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              Once you onboard a Retailer, you can assign products to them here.
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                <caption className="sr-only">
                  Your Retailers, and whether this product is assigned to each
                </caption>
                <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                  <tr>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      Retailer
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      Retailer status
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      This product
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {assignments.assignments.map((row) => {
                    const isAssigned = row.assignmentStatus === "ACTIVE";
                    // The database refuses a new assignment for an inactive product, an
                    // inactive Retailer, or a suspended relationship. The control is
                    // disabled for exactly those cases rather than offering a button
                    // that fails.
                    const assignable =
                      canAssignToRetailer(row) && product.status === "ACTIVE";

                    return (
                      <tr key={row.retailerOrganizationId}>
                        <td className="px-5 py-3.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {row.retailerName}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <StatusBadge status={row.retailerStatus} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400">
                          {isAssigned ? (
                            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                              Assigned
                            </span>
                          ) : (
                            <span className="text-zinc-400 dark:text-zinc-600">
                              Not assigned
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          {isAssigned ? (
                            <UnassignRetailerForm
                              productId={product.productId}
                              retailerId={row.retailerOrganizationId}
                              retailerName={row.retailerName}
                            />
                          ) : (
                            <AssignRetailerForm
                              productId={product.productId}
                              retailerId={row.retailerOrganizationId}
                              retailerName={row.retailerName}
                              disabled={!assignable}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
