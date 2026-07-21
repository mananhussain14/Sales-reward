import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  isRetailerOwnerInvitationsEnabled,
  RETAILER_OWNER_INVITATIONS_PAUSED_MESSAGE,
} from "@/lib/features/retailer-owner-invitations";
import { getVendorRetailerDetail } from "@/lib/retailers/vendor-retailer-detail";
import { buildInviteFormModel } from "@/lib/retailers/owner-status-normalization";
import { InviteOwnerForm } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/invite-owner-form";

/**
 * Static, and deliberately generic — the same reasoning as the Retailer detail
 * page. Naming the Retailer in the title would mean calling the loader a second
 * time from generateMetadata(), and would put a Retailer's name into browser
 * history and window titles for a page whose whole design keeps identifiers out of
 * view. The heading names the Retailer; the tab does not.
 */
export const metadata: Metadata = {
  title: "Invite Retailer Owner · SalesReward Admin",
};

type PageProps = {
  /** `params` is a Promise in this version of Next.js and must be awaited. */
  params: Promise<{ relationshipId: string }>;
};

/** The status a Retailer and its relationship must both hold to accept an owner. */
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
 * Invite the first Retailer Owner for one Vendor-managed Retailer.
 *
 * A Server Component: the queries, the organization id, and the session all stay
 * on the server, and only display strings reach the browser.
 *
 * Authorization is delegated entirely to getVendorRetailerDetail(), which calls
 * getVendorSuperAdminAccess() itself and filters the relationship by BOTH the
 * requested id and the Vendor derived from the caller's verified token. This page
 * does not repeat those queries, so it cannot disagree with the directory, the
 * detail page, or the Server Action.
 *
 * The relationship id from the URL is used for exactly three things: passing to
 * the loader, building the back/cancel links, and populating the form's hidden
 * routing field. It is never rendered as visible text, never placed in metadata or
 * a data attribute, and never logged.
 */
export default async function InviteRetailerOwnerPage({ params }: PageProps) {
  const { relationshipId } = await params;

  const detail = await getVendorRetailerDetail(relationshipId);

  // As on every other admin route, this page does not assume the layout already
  // guarded it — the rule must hold for this module regardless of the route tree
  // it is composed into. All of them call the same authorization function, so they
  // cannot disagree.
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
      <div className="mx-auto max-w-2xl space-y-6">
        <BackToRetailerLink relationshipId={relationshipId} />
        {/*
          Deliberately generic and reason-free: the only cause is a database or
          network failure, whose detail must never reach a browser.
        */}
        <NoticePanel
          title="Retailer unavailable"
          body="Retailer details are temporarily unavailable. Please try again."
        />
      </div>
    );
  }

  const { organizationName, retailer, ownerStatus } = detail;

  // The same gate public.reserve_retailer_owner_invitation() enforces. Rendering
  // the form only when it can succeed means an admin is never sent to a form the
  // database will refuse.
  const canInvite =
    retailer.retailerStatus === ACTIVE_STATUS &&
    retailer.relationshipStatus === ACTIVE_STATUS;

  // Read in this Server Component and NEVER in the form, which is a Client
  // Component. The disabled path does not render InviteOwnerForm at all, so no
  // flag value, variable name, or configuration detail crosses to the browser —
  // only the finished paused panel does.
  //
  // Checked BEFORE `canInvite` because it is the broader condition: while
  // invitations are paused, no Retailer can be invited for regardless of its
  // status, and reporting the Retailer's status instead would send an admin to
  // fix something that is not the obstacle.
  const invitationsEnabled = isRetailerOwnerInvitationsEnabled();

  if (!invitationsEnabled) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Deliberately still usable. Navigating away is the only useful action
            on this page right now, and taking it away would strand the admin. */}
        <BackToRetailerLink relationshipId={relationshipId} />

        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Invite Retailer Owner
          </h2>
          {/*
            The heading is kept so the page still identifies itself, but the
            enabled state's "They will receive an email inviting them to set a
            password" sentence is NOT rendered here — describing an email that
            cannot currently be delivered would be the one misleading thing this
            panel could say.
          */}
        </div>

        {/*
          The FORM IS NOT RENDERED — not disabled, not hidden, not present. There
          is therefore no submit button to re-enable from a devtools console and
          no input to repopulate. That is a convenience, not the protection: the
          Server Action refuses independently, so a POST crafted without this page
          is refused too.
        */}
        <NoticePanel
          title="Invitations paused"
          body={RETAILER_OWNER_INVITATIONS_PAUSED_MESSAGE}
        />
      </div>
    );
  }

  // The heading and lead-in adapt to the current owner state so a resend does not
  // read as a first invitation. The state itself comes from the same authorized
  // loader; the Server Action re-reads it before dispatch, so this is presentation
  // only. When the Retailer is inactive or the status could not be read, the state
  // is not consulted — those blocks take over below.
  const headingByState: Record<string, { title: string; lead: string }> = {
    NONE: {
      title: "Invite Retailer Owner",
      lead: "Invite the first owner. They will receive an email inviting them to set a password and activate their account.",
    },
    DELIVERY_FAILED: {
      title: "Retry owner invitation",
      lead: "The previous invitation could not be sent. Retry it to the same recipient — the email address cannot be changed here.",
    },
    PENDING: {
      title: "Resend owner invitation",
      lead: "An invitation is already pending. Resending refreshes the invitation window and re-sends the email to the same recipient.",
    },
    EXPIRED: {
      title: "Send a new owner invitation",
      lead: "The previous invitation expired. You can send a new one, to the same person or a different email address.",
    },
    ACTIVE: {
      title: "Retailer Owner",
      lead: "This Retailer already has an active owner.",
    },
  };

  // Resolve the copy and, for a live state, the form model. `state` is only read
  // on the authorized, active, readable path — the guarded branches below never
  // reach it.
  const state = ownerStatus.status === "ok" ? ownerStatus.ownerStatus.state : "NONE";
  const heading = headingByState[state] ?? headingByState.NONE;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackToRetailerLink relationshipId={relationshipId} />

      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {heading.title}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          For{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {retailer.retailerName}
          </span>
          , managed by{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          . {heading.lead}
        </p>
      </div>

      {!canInvite ? (
        // Reachable by typing the URL directly, since the detail page hides the
        // entry point in this state. The message names the rule rather than the
        // database, and is safe to be specific about: ownership has already been
        // proven by the loader, so the admin can see both statuses on the detail
        // page anyway.
        <NoticePanel
          title="This Retailer is not active"
          body="An owner can only be invited while both the Retailer and its relationship are active."
        />
      ) : ownerStatus.status === "unavailable" ? (
        // Fail closed: the owner status could not be read, so no form is rendered
        // — sending without knowing the current state could produce the wrong
        // action. Generic and reason-free, matching the detail page.
        <NoticePanel
          title="Owner status unavailable"
          body="The Retailer Owner status is temporarily unavailable. Please try again."
        />
      ) : ownerStatus.ownerStatus.state === "ACTIVE" ? (
        // No form: an active owner is not re-invited in this milestone. The back
        // link is the only useful action, and it is always present above.
        <NoticePanel
          title="Retailer Owner already active"
          body="This Retailer already has an active owner, so there is no invitation to send."
        />
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <InviteOwnerForm
            relationshipId={relationshipId}
            model={buildInviteFormModel(ownerStatus.ownerStatus)}
          />
        </div>
      )}
    </div>
  );
}
