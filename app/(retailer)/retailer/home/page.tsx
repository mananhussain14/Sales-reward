import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { listMyStaffCampaigns } from "@/lib/campaigns/staff-campaigns";
import {
  getMyCampaignEarningsSummary,
  getMyCampaignTargetProgress,
} from "@/lib/earnings/staff-earnings";
import {
  getMyAssignedReceiptShops,
  getMyReceiptSubmissions,
} from "@/lib/receipts/receipt-data";
import { receiptStatusLabel } from "@/lib/receipts/receipt-normalization";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import {
  buildOpportunities,
  remainingOpportunities,
  selectHeroOpportunity,
  MAX_OPPORTUNITY_CARDS,
} from "@/lib/sales-staff/home-presentation";
import {
  CAMPAIGNS_DID_NOT_LOAD_BODY,
  CAMPAIGNS_DID_NOT_LOAD_TITLE,
  GREETING,
  GREETING_LINE,
  GREETING_LINE_NO_CAMPAIGNS,
  HERO_EMPTY_BODY,
  HERO_EMPTY_TITLE,
  LATEST_RECEIPT_ACTION,
  LATEST_RECEIPT_EMPTY_BODY,
  LATEST_RECEIPT_EMPTY_TITLE,
  LATEST_RECEIPT_TITLE,
  OPPORTUNITIES_HINT,
  OPPORTUNITIES_TITLE,
  VIEW_ALL_CAMPAIGNS,
  showingSome,
} from "@/lib/sales-staff/home-copy";
import {
  NO_CAMPAIGNS_MESSAGE,
  progressByCampaignId,
} from "@/lib/earnings/earnings-presentation";
import { NextRewardHero } from "@/components/sales-staff/next-reward-hero";
import { CoinsPanel } from "@/components/sales-staff/coins-panel";
import { OpportunityCard } from "@/components/sales-staff/opportunity-card";
import {
  AddReceiptAction,
  AddReceiptFloatingAction,
  RESERVED_BOTTOM_SPACE,
} from "@/components/sales-staff/add-receipt";
import { Reveal, IconDisc, SoftBackdrop } from "@/components/ui/surfaces";
import { cardClasses } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  CampaignsIcon,
  ChevronRightIcon,
  DocumentIcon,
  InboxIcon,
} from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Home · Retailer Portal",
  description: "Your campaigns, your progress and your next receipt.",
};

/**
 * The Sales Staff landing screen.
 *
 * ============================================================================
 * WHY THIS ROUTE EXISTS AT ALL
 * ============================================================================
 * The portal used to land a seller on /retailer/receipts — a file picker. The redesign
 * asks for two things that cannot share one screen: a landing that answers "what should I
 * do next?", and a prominent call to action that OPENS the submission flow. A call to
 * action cannot open the screen it is already on.
 *
 * So one destination was added IN FRONT of the existing ones. /retailer/receipts keeps its
 * route, its Server Action, its validation, its history table and its place in the
 * navigation; nothing moved. The landing path now points here, and submitting is still one
 * click away — it is a nav item AND the pinned action on this screen.
 *
 * ============================================================================
 * IT COMPOSES READS; IT MAKES NO NEW ONE
 * ============================================================================
 * Every figure comes from a contract that already had a screen:
 *
 *   list_my_staff_campaigns()             what is offered
 *   get_my_campaign_target_progress()     how far along each target is
 *   get_my_campaign_earnings_summary()    what has already been earned
 *   list_my_receipt_submissions()         the latest submission
 *   list_my_assigned_receipt_shops()      which shop this seller sells for
 *
 * There is no home RPC, no dashboard aggregate and no client-side roll-up. NOTHING ON
 * THIS SCREEN IS SUMMED, RANKED, AVERAGED, PROJECTED OR COMPARED AGAINST A PREVIOUS
 * PERIOD, because no contract returns the inputs for any of that. Every read is `cache`d,
 * so the repeat resolutions the access check already performed are free.
 *
 * ============================================================================
 * AUTHORIZATION IS RE-RESOLVED HERE
 * ============================================================================
 * The layout has already decided, but this page is directly addressable, so its state must
 * come from the verified session rather than from how the caller arrived. Every RPC decides
 * again in SQL regardless. A portal member who is not a receipt submitter is sent to the
 * same generic denial every other portal refusal uses, and the page never says which
 * condition failed.
 *
 * ============================================================================
 * FOUR INDEPENDENT REGIONS, AND NONE CAN BLANK ANOTHER
 * ============================================================================
 * The hero, the coins panel, the opportunity strip and the latest receipt are driven by
 * separate contracts under two permissions. A failed earnings read leaves the campaigns on
 * screen; a failed campaign read leaves the coins. Neither is ever rendered as an EMPTY
 * state, because "could not read" and "you have none" are opposite claims.
 */

/** The one greeting line, chosen so encouragement never contradicts an empty screen. */
function greetingLine(hasCampaigns: boolean): string {
  return hasCampaigns ? GREETING_LINE : GREETING_LINE_NO_CAMPAIGNS;
}

export default async function SalesStaffHomePage() {
  const access = await getRetailerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }

  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  // Fails closed: an Owner or a Manager holds no RECEIPT_SUBMIT mapping, so every read
  // below would refuse them anyway.
  if (access.kind !== "submitter") {
    redirect("/retailer-access-denied");
  }

  // Concurrent: no read depends on another's result.
  const [campaignsResult, progressResult, summaryResult, historyResult, shopsResult] =
    await Promise.all([
      listMyStaffCampaigns(),
      getMyCampaignTargetProgress(),
      getMyCampaignEarningsSummary(),
      getMyReceiptSubmissions(),
      getMyAssignedReceiptShops(),
    ]);

  if (campaignsResult.status === "denied") {
    redirect("/retailer-access-denied");
  }

  const campaigns =
    campaignsResult.status === "ok" ? campaignsResult.campaigns : [];

  // A FAILED PROGRESS READ DOES NOT HIDE THE CAMPAIGNS. The offer is still true and still
  // worth showing; only the gauges are missing.
  const progressById =
    progressResult.status === "ok"
      ? progressByCampaignId(progressResult.progress)
      : new Map();

  const opportunities = buildOpportunities(campaigns, progressById);
  const hero = selectHeroOpportunity(opportunities);
  const rest = remainingOpportunities(opportunities, hero);
  const shown = rest.slice(0, MAX_OPPORTUNITY_CARDS);

  const summary = summaryResult.status === "ok" ? summaryResult.summary : null;
  const latestReceipt =
    historyResult.status === "ok" ? (historyResult.submissions[0] ?? null) : null;

  /**
   * The Retailer context line.
   *
   * NOT the Retailer's name: no RPC in the installed schema returns it to a Sales Staff
   * member, and fabricating one is exactly what this codebase refuses to do elsewhere. The
   * shop assignment IS an authorized read for this caller, and it is the context a seller
   * standing in a shop actually needs.
   */
  const shops = shopsResult.status === "ok" ? shopsResult.shops : [];
  const shopContext =
    shops.length === 1
      ? `Selling at ${shops[0].shopName}`
      : shops.length > 1
        ? `Selling across ${shops.length} shops`
        : null;

  return (
    <SoftBackdrop>
      <div className={`mx-auto w-full max-w-5xl ${RESERVED_BOTTOM_SPACE}`}>
        {/* -- Greeting ------------------------------------------------------ */}
        <Reveal>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                {GREETING}
              </h1>
              {shopContext !== null && (
                <p className="mt-1 truncate text-sm font-medium text-slate-600">
                  {shopContext}
                </p>
              )}
              <p className="mt-1 text-sm text-slate-500">
                {greetingLine(campaigns.length > 0)}
              </p>
            </div>

            {/* From `lg` up the sidebar is permanent and there is no bottom chrome for
                a floating pill to sit above, so the action belongs in the header. */}
            <div className="hidden shrink-0 lg:block">
              <AddReceiptAction compact />
            </div>
          </div>
        </Reveal>

        {/* -- Hero and coins ------------------------------------------------
            The hero takes the main column and the coins strip sits alongside it
            where there is room; below `lg` they stack in the order the questions
            are asked. */}
        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          <Reveal index={1} className="lg:col-span-2">
            {campaignsResult.status === "unavailable" ? (
              <Alert
                tone="warning"
                role="alert"
                title={CAMPAIGNS_DID_NOT_LOAD_TITLE}
              >
                {CAMPAIGNS_DID_NOT_LOAD_BODY}
              </Alert>
            ) : hero === null ? (
              <div className={cardClasses("standard", "p-6 sm:p-8")}>
                <IconDisc
                  tone="slate"
                  size={48}
                  icon={<CampaignsIcon className="h-6 w-6" />}
                />
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">
                  {HERO_EMPTY_TITLE}
                </h2>
                <p className="mt-1 text-sm text-slate-600">{HERO_EMPTY_BODY}</p>
              </div>
            ) : (
              <NextRewardHero opportunity={hero} />
            )}
          </Reveal>

          <Reveal index={2}>
            <CoinsPanel
              summary={summary}
              unavailable={summaryResult.status !== "ok"}
            />
          </Reveal>
        </div>

        {/* A failed progress read is stated once, here, rather than as a gap where each
            gauge would have been. */}
        {progressResult.status === "unavailable" && (
          <Alert
            tone="warning"
            role="status"
            title="Target progress unavailable"
            className="mt-5"
          >
            Campaigns are shown below, but progress towards their targets could not be
            loaded. Refresh to try again.
          </Alert>
        )}

        {/* -- Opportunities -------------------------------------------------- */}
        {campaigns.length === 0 && campaignsResult.status === "ok" ? (
          <Reveal index={3} className="mt-8 block">
            <EmptyState
              icon={<CampaignsIcon className="h-6 w-6" />}
              title="No campaigns right now"
              description={NO_CAMPAIGNS_MESSAGE}
            />
          </Reveal>
        ) : shown.length > 0 ? (
          <section aria-labelledby="opportunities-heading" className="mt-8">
            <Reveal index={3}>
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <h2
                    id="opportunities-heading"
                    className="text-lg font-semibold tracking-tight text-slate-900"
                  >
                    {OPPORTUNITIES_TITLE}
                  </h2>
                  <p className="text-sm text-slate-500">
                    {/* Stated so a truncated strip is never mistaken for the whole
                        list. */}
                    {rest.length > shown.length
                      ? showingSome(shown.length, rest.length)
                      : OPPORTUNITIES_HINT}
                  </p>
                </div>
                <Link
                  href="/retailer/my-campaigns"
                  className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                >
                  {VIEW_ALL_CAMPAIGNS}
                  <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </Reveal>

            {/* A scrolling strip on a phone — where a card is visibly cut off at the
                edge, which is what tells a reader it scrolls — and a grid from `sm` up,
                where there is room to see them all at once. */}
            <ul className="mt-4 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:pb-0 lg:grid-cols-3">
              {shown.map((opportunity, index) => (
                <Reveal
                  as="li"
                  key={opportunity.campaign.campaignId}
                  index={index}
                  className="flex"
                >
                  <OpportunityCard opportunity={opportunity} />
                </Reveal>
              ))}
            </ul>
          </section>
        ) : null}

        {/* -- Latest receipt -------------------------------------------------
            One row rather than a list: it answers "did that actually go through?" —
            the question a person asks straight after submitting — and the receipts
            screen owns everything beyond it. */}
        <section aria-labelledby="latest-receipt-heading" className="mt-8">
          <Reveal index={4}>
            <div className="flex items-end justify-between gap-4">
              <h2
                id="latest-receipt-heading"
                className="text-lg font-semibold tracking-tight text-slate-900"
              >
                {LATEST_RECEIPT_TITLE}
              </h2>
              <Link
                href="/retailer/receipts"
                className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
              >
                {LATEST_RECEIPT_ACTION}
                <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>

            <div className="mt-4">
              {historyResult.status !== "ok" ? (
                <Alert tone="warning" role="status" title="Submissions unavailable">
                  Your recent submissions could not be loaded. Refresh to try again.
                </Alert>
              ) : latestReceipt === null ? (
                <EmptyState
                  icon={<InboxIcon className="h-6 w-6" />}
                  tone="indigo"
                  title={LATEST_RECEIPT_EMPTY_TITLE}
                  description={LATEST_RECEIPT_EMPTY_BODY}
                  action={<AddReceiptAction compact />}
                />
              ) : (
                <div
                  className={cardClasses(
                    "standard",
                    "flex items-center gap-4 p-4",
                  )}
                >
                  <IconDisc
                    tone={
                      latestReceipt.status === "SUBMITTED"
                        ? "emerald"
                        : latestReceipt.status === "UPLOAD_FAILED"
                          ? "amber"
                          : "slate"
                    }
                    size={40}
                    icon={<DocumentIcon className="h-5 w-5" />}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {latestReceipt.originalFileName}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {latestReceipt.shopName} ·{" "}
                      {formatOwnerTimestamp(
                        latestReceipt.submittedAt ?? latestReceipt.createdAt,
                      )}
                    </p>
                  </div>
                  <Badge
                    tone={
                      latestReceipt.status === "SUBMITTED"
                        ? "emerald"
                        : latestReceipt.status === "UPLOAD_FAILED"
                          ? "amber"
                          : "slate"
                    }
                  >
                    {receiptStatusLabel(latestReceipt.status)}
                  </Badge>
                </div>
              )}
            </div>
          </Reveal>
        </section>
      </div>

      {/* The pinned primary action, below `lg` only. */}
      <AddReceiptFloatingAction />
    </SoftBackdrop>
  );
}
