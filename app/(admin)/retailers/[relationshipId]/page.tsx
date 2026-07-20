import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import { isRetailerOwnerInvitationsEnabled } from "@/lib/features/retailer-owner-invitations";
import {
  getVendorRetailerDetail,
  type VendorRetailerDetail,
  type VendorRetailerShopDetail,
} from "@/lib/retailers/vendor-retailer-detail";

/**
 * Static, and deliberately generic. Naming the Retailer in the title would mean
 * calling the loader a second time from generateMetadata() — the same three
 * queries again, for a browser tab label — and would put a Retailer's name in
 * history entries and window titles for a page whose whole design keeps its
 * identifiers out of view. The heading names the Retailer; the tab does not.
 */
export const metadata: Metadata = {
  title: "Retailer · SalesReward Admin",
};

/**
 * Both `params` and `searchParams` are Promises in this version of Next.js and
 * must be awaited before any value is read — the same shape the directory uses.
 */
type PageProps = {
  params: Promise<{
    relationshipId: string;
  }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** The status a Retailer and its relationship must both hold to accept new shops. */
const ACTIVE_STATUS = "ACTIVE";

/**
 * A stored value that is absent. The dash is decorative, so it is hidden from
 * assistive technology and paired with real text — a screen reader announcing
 * "em dash" says nothing about the data, while "Not recorded" does.
 */
function NotRecorded() {
  return (
    <span className="text-zinc-400 dark:text-zinc-500">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}

/** Renders a nullable stored string, falling back to the absent marker. */
function OptionalValue({ value }: { value: string | null }) {
  return value === null ? <NotRecorded /> : <>{value}</>;
}

/** Returns to the directory. Present in every state this page can render. */
function BackToRetailersLink() {
  return (
    <Link
      href="/retailers"
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
      Back to Retailers
    </Link>
  );
}

/** One labelled fact in the summary list. */
function SummaryItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">{children}</dd>
    </div>
  );
}

/**
 * The Retailer's own facts, as a description list: each value is genuinely a
 * term/definition pair, which a table would only imitate.
 *
 * The two statuses are separate facts and are labelled as such — a Retailer
 * company can be Active while this Vendor has Suspended its relationship with
 * it, and one badge could not say that.
 */
function RetailerSummary({ retailer }: { retailer: VendorRetailerDetail }) {
  return (
    <section
      aria-label="Retailer summary"
      className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryItem label="Retailer status">
          <StatusBadge status={retailer.retailerStatus} />
        </SummaryItem>
        <SummaryItem label="Relationship status">
          <StatusBadge status={retailer.relationshipStatus} />
        </SummaryItem>
        <SummaryItem label="Country code">
          <OptionalValue value={retailer.countryCode} />
        </SummaryItem>
        <SummaryItem label="Default currency">
          <OptionalValue value={retailer.defaultCurrency} />
        </SummaryItem>
      </dl>
    </section>
  );
}

/** Wide-screen shop presentation. Hidden below `md`, where the cards take over. */
function ShopTable({ shops }: { shops: VendorRetailerShopDetail[] }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Shop
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Code
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              City
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Country
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {shops.map((shop, index) => (
            // The shop payload deliberately carries no id, and two shops may
            // legitimately share every visible field — name, code, city, country,
            // and status alike — so a key built from those fields could collide
            // and would silently break rendering the moment it did. The index is
            // safe here for the same reason it was in the directory before
            // relationship ids arrived: this list is server-rendered once, in the
            // loader's fixed alphabetical order, and is never reordered,
            // filtered, paginated, or mutated on the client.
            <tr key={index}>
              <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                {shop.name}
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <OptionalValue value={shop.code} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <OptionalValue value={shop.city} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <OptionalValue value={shop.countryCode} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={shop.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Small-screen shop presentation. A five-column table cannot stay readable at
 * phone widths, so each shop becomes a labelled card rather than a horizontally
 * scrolling row. The card carries its own labels because it has no column
 * headers to inherit them from.
 */
function ShopCards({ shops }: { shops: VendorRetailerShopDetail[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {shops.map((shop, index) => (
        // Index key for the same reason as the table above: the payload has no
        // id, the visible fields are not guaranteed unique, and the order is
        // fixed and server-rendered.
        <li
          key={index}
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-zinc-900 dark:text-zinc-50">{shop.name}</p>
            <StatusBadge status={shop.status} />
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Code</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                <OptionalValue value={shop.code} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">City</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                <OptionalValue value={shop.city} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Country</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                <OptionalValue value={shop.countryCode} />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/**
 * Neutral panel, used for the empty-shops and unavailable states alike.
 *
 * `action` is optional and used only by the empty state: when a Retailer has no
 * shops, the panel is the most natural place to offer adding one, and putting the
 * control there means the page still shows exactly ONE Add Shop control rather
 * than repeating it beside the heading.
 */
function NoticePanel({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * Confirmation shown once, immediately after a shop is added, when the action
 * redirects here with `?shopCreated=1`.
 *
 * The flag is the entire message. It carries no shop id, Retailer id,
 * organization id, or name — nothing from the database travels in the URL, so
 * there is nothing here to leak, tamper with, or address a row by. A forged
 * `?shopCreated=1` therefore shows a banner and changes nothing else, which is
 * the whole reason the flag is allowed to be this dumb. This mirrors the
 * directory's `?created=1` banner exactly.
 *
 * role="status" rather than "alert": this is a confirmation, announced politely,
 * not something demanding interruption.
 */
function ShopCreatedBanner() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      >
        <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p>Shop added successfully.</p>
    </div>
  );
}

/**
 * Confirmation shown once, immediately after an owner invitation is sent, when the
 * action redirects here with `?ownerInvited=1`.
 *
 * The flag is the entire message. It carries no invitation id, Auth user id,
 * email, Retailer id, or organization id — nothing from the database travels in
 * the URL, so there is nothing here to leak, tamper with, or address a row by. A
 * forged `?ownerInvited=1` therefore shows a banner and changes nothing else,
 * which is the whole reason the flag is allowed to be this dumb. This mirrors the
 * `?shopCreated=1` and `?created=1` banners exactly.
 *
 * The invitee's email is deliberately NOT echoed back, even though the admin just
 * typed it: it would put an address into a URL, into browser history, and into any
 * referrer this page generates, for no benefit the admin does not already have.
 *
 * role="status" rather than "alert": this is a confirmation, announced politely,
 * not something demanding interruption.
 */
function OwnerInvitedBanner() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      >
        <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p>Retailer Owner invitation sent.</p>
    </div>
  );
}

/**
 * The one Invite Retailer Owner control.
 *
 * Rendered only when both the Retailer and its relationship are ACTIVE — the same
 * gate public.reserve_retailer_owner_invitation() enforces — so an admin is never
 * offered an action the database will refuse.
 *
 * This milestone deliberately ships no invitation directory and no invitation
 * management UI, so the control does not know whether an invitation is already
 * pending. Submitting a second time for the same person is safe and idempotent:
 * the reservation resolves the existing live invitation and re-sends it rather
 * than creating a duplicate. Submitting for a Retailer that already has an owner
 * is refused by the database and surfaced as a field error on the form.
 */
function InviteOwnerLink({ relationshipId }: { relationshipId: string }) {
  return (
    <Link
      href={`/retailers/${relationshipId}/owner/invite`}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950"
    >
      <InviteOwnerIcon />
      Invite Retailer Owner
    </Link>
  );
}

/** The Invite Retailer Owner glyph, shared by the active and paused controls. */
function InviteOwnerIcon() {
  return (
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
      <path d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
    </svg>
  );
}

/**
 * The paused stand-in for the Invite Retailer Owner control, rendered wherever
 * the link would have been while the feature flag is disabled.
 *
 * A <span>, not a disabled <button> or a styled <Link>. There is nothing here to
 * press and nowhere to go, so it carries no href, no click target, and no tab
 * stop — a disabled button would still be a control an admin tries to click, and
 * a `pointer-events-none` link would still be reachable by keyboard and by
 * copying its address. Rendering non-interactive markup is the honest shape for a
 * capability that is not currently available.
 *
 * `aria-disabled` announces the state to assistive technology, and the visible
 * "paused" wording carries it for everyone else. Nothing here names the
 * environment variable, the flag's value, SMTP, the email template, or the
 * Supabase project, and nothing implies that invitations currently work.
 *
 * The route itself stays reachable by URL, and the Server Action refuses
 * regardless — see lib/features/retailer-owner-invitations.ts. This is the
 * affordance, not the enforcement.
 */
function InviteOwnerPaused() {
  return (
    <span
      aria-disabled="true"
      className="inline-flex shrink-0 cursor-not-allowed items-center justify-center gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500"
    >
      <InviteOwnerIcon />
      Owner invitations paused
    </span>
  );
}

/**
 * The one Add Shop control, rendered in exactly one place per state — beside the
 * Shops heading when the Retailer has shops, inside the empty panel when it does
 * not.
 *
 * `emphasis` distinguishes the two: the empty state gets the solid indigo button
 * because it is the page's primary next step, while the heading variant is a
 * quieter outlined control so it does not compete with the content beneath it.
 */
function AddShopLink({
  relationshipId,
  emphasis,
}: {
  relationshipId: string;
  emphasis: "primary" | "secondary";
}) {
  const base =
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950";

  const variant =
    emphasis === "primary"
      ? "bg-indigo-600 text-white hover:bg-indigo-500"
      : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <Link href={`/retailers/${relationshipId}/shops/new`} className={`${base} ${variant}`}>
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
        <path d="M12 4.5v15m7.5-7.5h-15" />
      </svg>
      Add Shop
    </Link>
  );
}

/**
 * Read-only detail view of one Vendor-managed Retailer. A Server Component: the
 * queries, the organization id, and the session all stay on the server, and only
 * display strings reach the browser.
 *
 * The relationship id from the URL is used for exactly one thing — passing to
 * the loader, which treats it as an address and not as authorization. It is
 * never rendered, never placed in metadata or a data attribute, and never
 * logged. Every authorization decision belongs to the loader's own call to
 * getVendorSuperAdminAccess().
 */
export default async function RetailerDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { relationshipId } = await params;

  const [detail, resolvedSearchParams] = await Promise.all([
    getVendorRetailerDetail(relationshipId),
    searchParams,
  ]);

  // As on the directory, the dashboard, and the users page, this page does not
  // assume the layout already guarded it — the rule must hold for this module
  // regardless of the route tree it is composed into. All of them call the same
  // authorization function, so they cannot disagree.
  if (detail.status === "unauthenticated") {
    redirect("/login");
  }

  if (detail.status === "unauthorized") {
    redirect("/access-denied");
  }

  // A malformed id, an unknown id, another Vendor's id, and an id whose row RLS
  // declines to return all arrive here identically — the loader does not
  // distinguish them, and neither does this page. The standard 404 is the right
  // response to every one of them.
  if (detail.status === "not-found") {
    notFound();
  }

  if (detail.status === "unavailable") {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <BackToRetailersLink />
        {/*
          Deliberately generic and reason-free: the only cause is a database or
          network failure, whose detail must never reach a browser. No query,
          table, policy, identifier, or error text appears here.
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

  // A repeated parameter arrives as an array, so the value is compared only when
  // it is a single string. Anything else — absent, repeated, or any other value —
  // simply means no banner. Same treatment as the directory's `created` flag.
  const justCreatedShop = resolvedSearchParams.shopCreated === "1";

  // Same treatment as the shop flag above: a repeated parameter arrives as an
  // array, so the value is compared only when it is a single string.
  const justInvitedOwner = resolvedSearchParams.ownerInvited === "1";

  // The same gate public.add_vendor_retailer_shop() enforces. Offering the action
  // only when it can succeed means an admin is never sent to a form that the
  // database will refuse — and a suspended or deactivated Retailer shows no Add
  // Shop control at all, rather than one that fails on submit.
  const canAddShop =
    retailer.retailerStatus === ACTIVE_STATUS &&
    retailer.relationshipStatus === ACTIVE_STATUS;

  // The same two conditions gate inviting an owner. They are computed separately
  // rather than reusing `canAddShop` because the two capabilities are governed by
  // different permissions (RETAILER_SHOPS_CREATE and RETAILER_OWNERS_INVITE) and
  // will diverge the moment a role holds one without the other — at which point a
  // shared boolean would silently show the wrong control.
  const canInviteOwner =
    retailer.retailerStatus === ACTIVE_STATUS &&
    retailer.relationshipStatus === ACTIVE_STATUS;

  // Read HERE, in a Server Component, and used only to choose which of two
  // pre-rendered pieces of markup to emit. The boolean itself is never passed to
  // a Client Component from this page and process.env is never read in one — the
  // browser receives finished HTML and learns nothing about the configuration
  // beyond the fact that the control says "paused".
  //
  // This is presentation only. The Server Action gates itself independently, so a
  // forged POST is refused whether or not this page ever rendered.
  const invitationsEnabled = isRetailerOwnerInvitationsEnabled();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BackToRetailersLink />

      {justCreatedShop && <ShopCreatedBanner />}
      {justInvitedOwner && <OwnerInvitedBanner />}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {retailer.retailerName}
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            A read-only view of this Retailer organization and its shops, as managed
            by{" "}
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {organizationName}
            </span>
            .
          </p>
        </div>

        {/*
          The owner invitation sits beside the Retailer heading rather than inside
          the Shops section: it is an action on the ORGANIZATION, not on its shop
          list, and putting it next to Add Shop would imply the two are peers.
        */}
        {canInviteOwner &&
          (invitationsEnabled ? (
            <InviteOwnerLink relationshipId={relationshipId} />
          ) : (
            <InviteOwnerPaused />
          ))}
      </div>

      <RetailerSummary retailer={retailer} />

      <section aria-labelledby="shops-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h3
            id="shops-heading"
            className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            Shops
          </h3>

          {/*
            Only when there ARE shops. With none, the empty panel below carries
            the action instead, so the page never shows two Add Shop controls.
          */}
          {canAddShop && retailer.shops.length > 0 && (
            <AddShopLink relationshipId={relationshipId} emphasis="secondary" />
          )}
        </div>

        {retailer.shops.length === 0 ? (
          // Not an error, and deliberately worded so it cannot be mistaken for
          // one: a Retailer with no shops yet is an ordinary, expected state, and
          // this is a different claim from "we could not load the shops".
          <NoticePanel
            title="No shops yet"
            body="This Retailer has no shops recorded."
            action={
              canAddShop ? (
                <AddShopLink relationshipId={relationshipId} emphasis="primary" />
              ) : undefined
            }
          />
        ) : (
          <>
            <ShopTable shops={retailer.shops} />
            <ShopCards shops={retailer.shops} />
          </>
        )}
      </section>
    </div>
  );
}
