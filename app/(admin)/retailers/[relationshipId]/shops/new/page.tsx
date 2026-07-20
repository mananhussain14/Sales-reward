import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getVendorRetailerDetail } from "@/lib/retailers/vendor-retailer-detail";
import { ShopForm } from "@/app/(admin)/retailers/[relationshipId]/shops/new/shop-form";

/**
 * Static, and deliberately generic — the same reasoning as the detail page it
 * sits under. Naming the Retailer in the title would mean calling the loader a
 * second time from generateMetadata(), and would put a Retailer's name into
 * history entries and window titles.
 */
export const metadata: Metadata = {
  title: "Add Shop · SalesReward Admin",
};

/**
 * `params` is a Promise in this version of Next.js and must be awaited before any
 * value is read. The segment is inherited from the parent detail route.
 */
type PageProps = {
  params: Promise<{
    relationshipId: string;
  }>;
};

const ACTIVE_STATUS = "ACTIVE";

/** Returns to the Retailer. Present in every state this page can render. */
function BackToRetailerLink({ relationshipId }: { relationshipId: string }) {
  return (
    <Link
      href={`/retailers/${relationshipId}`}
      className="inline-flex items-center gap-1.5 rounded-sm text-sm text-zinc-500 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:text-zinc-400 dark:hover:text-indigo-400 dark:focus-visible:ring-offset-zinc-950"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M15.75 19.5L8.25 12l7.5-7.5" />
      </svg>
      Back to Retailer
    </Link>
  );
}

/** Neutral panel, used for the unavailable and inactive states alike. */
function NoticePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
    </div>
  );
}

/**
 * Add Shop page for one Vendor-managed Retailer. A Server Component: the queries,
 * the organization id, and the session all stay on the server, and only display
 * strings plus the routing address reach the browser.
 *
 * The guard is repeated here rather than inherited from the (admin) layout, for
 * the same stated reason as every other admin route: the rule must hold for this
 * module regardless of the route tree it is composed into. The Server Action
 * behind the form repeats it a third time, and the RPC a fourth — because a form
 * rendered behind a guard says nothing about who can call the action.
 *
 * The relationship id from the URL is used for exactly three things: passing to
 * the loader, building the back/cancel links, and populating the form's hidden
 * routing field. It is never rendered as text, never placed in metadata or a data
 * attribute, and never logged.
 */
export default async function AddShopPage({ params }: PageProps) {
  const { relationshipId } = await params;
  const detail = await getVendorRetailerDetail(relationshipId);

  if (detail.status === "unauthenticated") {
    redirect("/login");
  }

  if (detail.status === "unauthorized") {
    redirect("/access-denied");
  }

  // A malformed id, an unknown id, another Vendor's id, and an id whose row RLS
  // declines to return all arrive here identically — the loader does not
  // distinguish them, and neither does this page.
  if (detail.status === "not-found") {
    notFound();
  }

  if (detail.status === "unavailable") {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <BackToRetailerLink relationshipId={relationshipId} />
        {/*
          Deliberately generic and reason-free: the only cause is a database or
          network failure, whose detail must never reach a browser.
        */}
        <NoticePanel
          title="Retailer unavailable"
          body="Retailer details are temporarily unavailable. Please try again."
        />
        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          Signed in to{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {detail.organizationName}
          </span>
        </p>
      </div>
    );
  }

  const { organizationName, retailer } = detail;

  // The same gate the RPC enforces, rendered rather than merely refused. Showing
  // the reason is safe here — and only here — because the caller has already
  // proven they manage this Retailer: the loader returned it, which means the
  // relationship is theirs, and both statuses are already visible to them on the
  // detail page. Nothing is disclosed that they did not already have.
  //
  // The form is not rendered at all in this state, rather than rendered and
  // disabled: a form that cannot succeed is an invitation to waste a submission,
  // and the action and the RPC would both refuse it anyway.
  const canAddShop =
    retailer.retailerStatus === ACTIVE_STATUS &&
    retailer.relationshipStatus === ACTIVE_STATUS;

  return (
    // A narrower column than the 6xl detail page: a single-column form is harder
    // to scan when its labels and inputs are stretched across a wide screen. This
    // matches /retailers/new.
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <BackToRetailerLink relationshipId={relationshipId} />

        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Add Shop
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Add one more shop location to{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {retailer.retailerName}
          </span>
          , the Retailer managed by{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          . This creates a single additional shop and does not change anything
          else about the Retailer.
        </p>
      </div>

      {canAddShop ? (
        <ShopForm relationshipId={relationshipId} />
      ) : (
        <NoticePanel
          title="Shops cannot be added right now"
          body={
            retailer.relationshipStatus !== ACTIVE_STATUS
              ? "This Vendor–Retailer relationship is not active. Shops can be added once the relationship is active again."
              : "This Retailer organization is not active. Shops can be added once the Retailer is active again."
          }
        />
      )}
    </div>
  );
}
