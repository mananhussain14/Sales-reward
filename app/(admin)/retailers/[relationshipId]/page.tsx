import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import { isRetailerOwnerInvitationsEnabled } from "@/lib/features/retailer-owner-invitations";
import { isExistingUserInvitationsEnabled } from "@/lib/features/existing-user-invitations";
import {
  getVendorRetailerDetail,
  type VendorRetailerDetail,
  type VendorRetailerShopDetail,
} from "@/lib/retailers/vendor-retailer-detail";
import type { VendorRetailerOwnerStatusResult } from "@/lib/retailers/vendor-retailer-owner-status";
import {
  buildOwnerStatusView,
  classifyOwnerAction,
  formatOwnerDisplayName,
  formatOwnerTimestamp,
  isExistingUserActionKind,
  resolveOwnerInvitedMessage,
  type VendorRetailerOwnerStatus,
} from "@/lib/retailers/owner-status-normalization";
import { BackLink } from "@/components/ui/page-header";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { PlusIcon, RetailersIcon, ShopIcon, UsersIcon } from "@/components/ui/icons";

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
    <span className="text-slate-400">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}

/** Renders a nullable stored string, falling back to the absent marker. */
function OptionalValue({ value }: { value: string | null }) {
  return value === null ? <NotRecorded /> : <>{value}</>;
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
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-900">{children}</dd>
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
    <section aria-label="Retailer summary" className={cardClasses("standard", "p-6")}>
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
    <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card md:block">
      <table className="w-full border-collapse text-left text-sm">
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
          {shops.map((shop, index) => (
            // The shop payload deliberately carries no id, and two shops may
            // legitimately share every visible field — name, code, city, country,
            // and status alike — so a key built from those fields could collide
            // and would silently break rendering the moment it did. The index is
            // safe here for the same reason it was in the directory before
            // relationship ids arrived: this list is server-rendered once, in the
            // loader's fixed alphabetical order, and is never reordered,
            // filtered, paginated, or mutated on the client.
            <tr key={index} className="transition-colors hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-900">{shop.name}</td>
              <td className="px-4 py-3 text-slate-600">
                <OptionalValue value={shop.code} />
              </td>
              <td className="px-4 py-3 text-slate-600">
                <OptionalValue value={shop.city} />
              </td>
              <td className="px-4 py-3 text-slate-600">
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
        <li key={index} className={cardClasses("standard", "p-4")}>
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-slate-900">{shop.name}</p>
            <StatusBadge status={shop.status} />
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="text-slate-500">Code</dt>
              <dd className="text-slate-700">
                <OptionalValue value={shop.code} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500">City</dt>
              <dd className="text-slate-700">
                <OptionalValue value={shop.city} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500">Country</dt>
              <dd className="text-slate-700">
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
  icon,
  title,
  body,
  tone,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  tone?: "slate" | "indigo" | "emerald" | "amber";
  action?: React.ReactNode;
}) {
  return (
    <EmptyState icon={icon} title={title} description={body} tone={tone} action={action} />
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
    <Alert tone="success" role="status">
      Shop added successfully.
    </Alert>
  );
}

/**
 * Confirmation shown once, immediately after an owner invitation is sent, resent,
 * retried, or replaced, when the action redirects here with `?ownerInvited=<code>`.
 *
 * The message is chosen from a FIXED vocabulary by resolveOwnerInvitedMessage():
 * the URL carries only a short code (`sent`, `resent`, `new`, or the legacy `1`),
 * never free text, so no arbitrary string from the query can be rendered here. An
 * unknown code resolves to null and no banner is shown at all.
 *
 * The code carries no invitation id, Auth user id, email, Retailer id, or
 * organization id — nothing from the database travels in the URL, so there is
 * nothing here to leak, tamper with, or address a row by. A forged code therefore
 * shows one of the fixed messages (or none) and changes nothing else. This mirrors
 * the `?shopCreated=1` and `?created=1` banners.
 *
 * The invitee's email is deliberately NOT echoed back, even though the admin just
 * typed it: it would put an address into a URL, into browser history, and into any
 * referrer this page generates, for no benefit the admin does not already have.
 *
 * role="status" rather than "alert": this is a confirmation, announced politely,
 * not something demanding interruption.
 */
function OwnerInvitedBanner({ message }: { message: string }) {
  return (
    <Alert tone="success" role="status">
      {message}
    </Alert>
  );
}

/** The Retailer Owner glyph, shared by the owner-management card's controls. */
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
 * The single owner-management action. One route serves every state — the invite
 * page re-reads the owner status server-side and renders the correct form (invite,
 * retry, resend, or new) — so the label varies while the destination does not.
 *
 * The label comes from buildOwnerStatusView(); this component never invents one.
 * `relationshipId` is a routing address, not authorization: the invite page and
 * the Server Action both re-derive the Vendor from the caller's own token.
 */
function OwnerActionLink({
  relationshipId,
  label,
}: {
  relationshipId: string;
  label: string;
}) {
  return (
    <Link
      href={`/retailers/${relationshipId}/owner/invite`}
      className={buttonClasses({ variant: "outline" }, "shrink-0")}
    >
      <InviteOwnerIcon />
      {label}
    </Link>
  );
}

/**
 * The paused stand-in for the owner action, rendered while the feature flag is
 * disabled.
 *
 * A <span>, not a disabled <button> or a styled <Link>. There is nothing here to
 * press and nowhere to go, so it carries no href, no click target, and no tab
 * stop. `aria-disabled` announces the state; the visible wording carries it for
 * everyone else. Nothing here names the environment variable, SMTP, the template,
 * or the project. The route stays reachable by URL and the Server Action refuses
 * regardless — this is the affordance, not the enforcement.
 */
function OwnerActionPaused() {
  return (
    <span
      aria-disabled="true"
      className={buttonClasses(
        { variant: "outline" },
        "shrink-0 cursor-not-allowed border-dashed bg-slate-50 text-slate-400 hover:bg-slate-50 hover:text-slate-400",
      )}
    >
      <InviteOwnerIcon />
      Owner invitations paused
    </span>
  );
}

/** One labelled fact inside the owner card. Hidden when the value is absent. */
function OwnerDetail({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  );
}

/**
 * The owner-management card — the single, state-aware home for everything about
 * this Retailer's owner. It replaces the previous generic "Invite Retailer Owner"
 * button.
 *
 * The card shows the human-readable state, whatever recipient/owner details are
 * safely available, and exactly one primary action (or none, for ACTIVE). The
 * action is offered only when the database would actually accept it: both the
 * Retailer and its relationship must be ACTIVE (`canInvite`), and invitations must
 * not be paused. When paused, a non-interactive stand-in is shown instead.
 *
 * An `unavailable` owner-status read renders a generic, retry-safe notice — never
 * the NONE state, which would falsely claim the Retailer has no owner.
 */
function OwnerManagementCard({
  ownerStatusResult,
  relationshipId,
  canInvite,
  invitationsEnabled,
  existingUserInvitationsEnabled,
}: {
  ownerStatusResult: VendorRetailerOwnerStatusResult;
  relationshipId: string;
  canInvite: boolean;
  invitationsEnabled: boolean;
  existingUserInvitationsEnabled: boolean;
}) {
  return (
    <section aria-labelledby="owner-heading" className="space-y-3">
      <h3 id="owner-heading" className="text-lg font-semibold tracking-tight text-slate-900">
        Retailer Owner
      </h3>

      {ownerStatusResult.status === "unavailable" ? (
        // Fail closed: a read that could not complete is NOT NONE. Generic and
        // reason-free — the only cause is a database or network failure, whose
        // detail must never reach a browser.
        <EmptyState
          icon={<UsersIcon className="h-6 w-6" />}
          title="Owner status unavailable"
          description="The Retailer Owner status is temporarily unavailable. Please try again."
        />
      ) : (
        <OwnerManagementBody
          ownerStatus={ownerStatusResult.ownerStatus}
          relationshipId={relationshipId}
          canInvite={canInvite}
          invitationsEnabled={invitationsEnabled}
          existingUserInvitationsEnabled={existingUserInvitationsEnabled}
        />
      )}
    </section>
  );
}

/** The card body for a successfully read owner status. */
function OwnerManagementBody({
  ownerStatus,
  relationshipId,
  canInvite,
  invitationsEnabled,
  existingUserInvitationsEnabled,
}: {
  ownerStatus: VendorRetailerOwnerStatus;
  relationshipId: string;
  canInvite: boolean;
  invitationsEnabled: boolean;
  existingUserInvitationsEnabled: boolean;
}) {
  const view = buildOwnerStatusView(ownerStatus);

  // Which rollout flag gates THIS state's action. An existing-user action (the
  // token + Resend flow) is gated on its own switch; every other action is gated on
  // the new-user invitation switch. The action label and route are identical either
  // way — the invite page renders the correct confirm/form — only the pause gate
  // differs.
  const plan = classifyOwnerAction(ownerStatus);
  const featureEnabled = isExistingUserActionKind(plan.kind)
    ? existingUserInvitationsEnabled
    : invitationsEnabled;
  const displayName = formatOwnerDisplayName(
    ownerStatus.firstName,
    ownerStatus.lastName,
  );
  const hasName = ownerStatus.firstName !== null || ownerStatus.lastName !== null;

  // Which recipient/owner facts to surface per state. Absent values render nothing
  // (OwnerDetail returns null), so a state with no accepted date simply omits it.
  const showRecipient = ownerStatus.state !== "NONE";
  const showSentAt =
    ownerStatus.state === "PENDING" || ownerStatus.state === "EXPIRED";
  const showExpiresAt =
    ownerStatus.state === "DELIVERY_FAILED" ||
    ownerStatus.state === "PENDING" ||
    ownerStatus.state === "EXPIRED";
  const showAcceptedAt = ownerStatus.state === "ACTIVE";

  return (
    <div className={cardClasses("standard", "p-6")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">{view.heading}</p>
          <p className="mt-1 text-sm text-slate-500">{view.description}</p>
        </div>

        {/*
          The action is offered only when the database would accept it: an ACTIVE
          owner offers none (view.action is null), an inactive Retailer/relationship
          offers none (canInvite is false — the reserve RPC would refuse), and a
          paused feature shows the non-interactive stand-in. Direct-URL entry to the
          route is still gated server-side by the invite page and the Server Action.
        */}
        {view.action &&
          canInvite &&
          (featureEnabled ? (
            <OwnerActionLink relationshipId={relationshipId} label={view.action.label} />
          ) : (
            <OwnerActionPaused />
          ))}
      </div>

      {(showRecipient || showAcceptedAt) && (
        <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {showRecipient && (
            <OwnerDetail
              label={ownerStatus.state === "ACTIVE" ? "Owner" : "Recipient"}
              value={hasName ? displayName : null}
            />
          )}
          {showRecipient && <OwnerDetail label="Email" value={ownerStatus.email} />}
          {showSentAt && (
            <OwnerDetail label="Sent" value={formatOwnerTimestamp(ownerStatus.sentAt)} />
          )}
          {showExpiresAt && (
            <OwnerDetail
              label={ownerStatus.state === "EXPIRED" ? "Expired" : "Expires"}
              value={formatOwnerTimestamp(ownerStatus.expiresAt)}
            />
          )}
          {showAcceptedAt && (
            <OwnerDetail
              label="Accepted"
              value={formatOwnerTimestamp(ownerStatus.acceptedAt)}
            />
          )}
        </dl>
      )}
    </div>
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
  return (
    <Link
      href={`/retailers/${relationshipId}/shops/new`}
      className={buttonClasses({ variant: emphasis === "primary" ? "primary" : "outline" }, "shrink-0")}
    >
      <PlusIcon className="h-4 w-4" />
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
        <BackLink href="/retailers">Back to Retailers</BackLink>
        {/*
          Deliberately generic and reason-free: the only cause is a database or
          network failure, whose detail must never reach a browser. No query,
          table, policy, identifier, or error text appears here.
        */}
        <NoticePanel
          icon={<RetailersIcon className="h-6 w-6" />}
          title="Retailer unavailable"
          body="Retailer details are temporarily unavailable. Please try again."
        />
        <p className="text-center text-sm text-slate-500">
          Signed in to{" "}
          <span className="font-medium text-slate-700">{detail.organizationName}</span>
        </p>
      </div>
    );
  }

  const { organizationName, retailer, ownerStatus } = detail;

  // A repeated parameter arrives as an array, so the value is compared only when
  // it is a single string. Anything else — absent, repeated, or any other value —
  // simply means no banner. Same treatment as the directory's `created` flag.
  const justCreatedShop = resolvedSearchParams.shopCreated === "1";

  // The success banner text is chosen from a FIXED vocabulary by the URL's short
  // code — `sent`, `resent`, `new`, or the legacy `1`. Any other value (arbitrary
  // text, a repeated parameter, an inherited key) resolves to null, so no
  // attacker-supplied string can ever be rendered as a success message.
  const ownerInvitedMessage = resolveOwnerInvitedMessage(
    resolvedSearchParams.ownerInvited,
  );

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

  // The existing-user (token + Resend) flow's own rollout flag, read here in the
  // Server Component and used only to choose which markup to emit for an
  // existing-user action. Never passed to a Client Component; the browser receives
  // finished HTML. The Server Action gates itself independently.
  const existingUserInvitationsEnabled = isExistingUserInvitationsEnabled();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BackLink href="/retailers">Back to Retailers</BackLink>

      {justCreatedShop && <ShopCreatedBanner />}
      {ownerInvitedMessage && <OwnerInvitedBanner message={ownerInvitedMessage} />}

      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
          {retailer.retailerName}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
          A read-only view of this Retailer organization and its shops, as managed
          by <span className="font-medium text-slate-700">{organizationName}</span>.
        </p>
      </div>

      <RetailerSummary retailer={retailer} />

      {/*
        The owner-management card sits between the Retailer summary and the Shops
        section: it is an action on the ORGANIZATION, not on its shop list. It is
        state-aware — no owner, delivery failed, pending, expired, or active — and
        offers exactly one primary action per state, gated so an admin is never
        shown a control the database would refuse.
      */}
      <OwnerManagementCard
        ownerStatusResult={ownerStatus}
        relationshipId={relationshipId}
        canInvite={canInviteOwner}
        invitationsEnabled={invitationsEnabled}
        existingUserInvitationsEnabled={existingUserInvitationsEnabled}
      />

      <section aria-labelledby="shops-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h3 id="shops-heading" className="text-lg font-semibold tracking-tight text-slate-900">
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
            icon={<ShopIcon className="h-6 w-6" />}
            tone="indigo"
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
