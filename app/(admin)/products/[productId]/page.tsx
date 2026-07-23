import type { Metadata } from "next";
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
import { BackLink, SectionHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RetailersIcon } from "@/components/ui/icons";

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
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <BackLink href="/products">Products</BackLink>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-semibold tracking-tight text-slate-900">
            {product.productName}
          </h2>
          <p className="mt-1 font-mono text-sm text-slate-500">{product.productCode}</p>
        </div>
        <div className="flex shrink-0 items-start gap-3">
          <span className="text-xs text-slate-500">
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
      <SectionCard title="Details">
        <EditProductForm product={product} />
      </SectionCard>

      {/* ------------------------------------------------------------------ */}
      {/* Retailer assignments                                                */}
      {/* ------------------------------------------------------------------ */}
      <section aria-label="Retailer assignments" className="space-y-3">
        <SectionHeader
          title="Retailer assignments"
          description="Assigned Retailers see this product while it is active. Withdrawing keeps the record and can be reversed."
        />

        {assignments.status !== "ok" ? (
          <EmptyState
            icon={<RetailersIcon className="h-6 w-6" />}
            tone="amber"
            title="Assignments could not be loaded"
            description="Something went wrong. Please try again in a moment."
          />
        ) : assignments.assignments.length === 0 ? (
          <EmptyState
            icon={<RetailersIcon className="h-6 w-6" />}
            title="No Retailers yet"
            description="Once you onboard a Retailer, you can assign products to them here."
          />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Your Retailers, and whether this product is assigned to each
                </caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-3 text-left font-semibold">
                      Retailer
                    </th>
                    <th scope="col" className="px-5 py-3 text-left font-semibold">
                      Retailer status
                    </th>
                    <th scope="col" className="px-5 py-3 text-left font-semibold">
                      This product
                    </th>
                    <th scope="col" className="px-5 py-3 text-left font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {assignments.assignments.map((row) => {
                    const isAssigned = row.assignmentStatus === "ACTIVE";
                    // The database refuses a new assignment for an inactive product, an
                    // inactive Retailer, or a suspended relationship. The control is
                    // disabled for exactly those cases rather than offering a button
                    // that fails.
                    const assignable =
                      canAssignToRetailer(row) && product.status === "ACTIVE";

                    return (
                      <tr key={row.retailerOrganizationId} className="transition-colors hover:bg-slate-50">
                        <td className="px-5 py-3.5 text-sm font-medium text-slate-900">
                          {row.retailerName}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <StatusBadge status={row.retailerStatus} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-sm text-slate-600">
                          {isAssigned ? (
                            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              Assigned
                            </span>
                          ) : (
                            <span className="text-slate-400">Not assigned</span>
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
