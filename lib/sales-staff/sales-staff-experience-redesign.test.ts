/**
 * Tests for the Web Sales Staff experience redesign.
 *
 * Run with:  npm test
 *
 * Two kinds, matching every other suite in this repository:
 *
 *   1. REAL UNIT TESTS of the pure modules — the hero selection rule, the campaign face
 *      mapping, the qualifier set and the progress display values. Every rule is
 *      exercised by CALLING the function, never by reading its source.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the Server Components, which cannot be invoked
 *      here. What they must NOT do is still checkable, and for a presentation milestone
 *      the most valuable properties are the NEGATIVE ones: no wallet vocabulary, no
 *      verified sale id, no reward arithmetic, no new contract, no looping animation and
 *      no authorization change.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE, so no comment can satisfy a security
 * test. These files discuss at length the very identifiers the rules forbid.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  buildOpportunities,
  heroEyebrowKind,
  isRunning,
  remainingOpportunities,
  selectHeroOpportunity,
  MAX_OPPORTUNITY_CARDS,
  type SalesStaffOpportunity,
} from "./home-presentation.ts";
import {
  campaignFace,
  campaignQualifiers,
  progressSweep,
  QUALIFIER_TONES,
} from "./campaign-face.ts";
import {
  ADD_RECEIPT,
  ADD_RECEIPT_HINT,
  GREETING,
  GREETING_LINE,
  GREETING_LINE_NO_CAMPAIGNS,
  HERO_EYEBROW_NEXT,
  HERO_EYEBROW_REACHED,
  HERO_EYEBROW_RUNNING,
  HERO_EYEBROW_UPCOMING,
  showingSome,
} from "./home-copy.ts";
import {
  NOT_A_WALLET_NOTICE,
  progressFraction,
  progressHeadline,
  progressPercent,
  progressSemanticLabel,
  progressValueLabel,
  unitsRemaining,
} from "../earnings/earnings-presentation.ts";
import type { AssignedCampaign } from "../campaigns/campaign-normalization.ts";
import type { CampaignTargetProgress } from "../earnings/earnings-normalization.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Strips comments so prose describing a rule cannot satisfy the rule it describes. */
function code(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const HOME_PAGE = "app/(retailer)/retailer/home/page.tsx";
const CAMPAIGNS_PAGE = "app/(retailer)/retailer/my-campaigns/page.tsx";
const DETAIL_PAGE = "app/(retailer)/retailer/my-campaigns/[campaignId]/page.tsx";
const EARNINGS_PAGE = "app/(retailer)/retailer/my-earnings/page.tsx";
const RECEIPTS_PAGE = "app/(retailer)/retailer/receipts/page.tsx";

const REDESIGN_COMPONENTS = [
  "components/sales-staff/next-reward-hero.tsx",
  "components/sales-staff/opportunity-card.tsx",
  "components/sales-staff/campaign-list-card.tsx",
  "components/sales-staff/campaign-visuals.tsx",
  "components/sales-staff/target-progress.tsx",
  "components/sales-staff/coins-panel.tsx",
  "components/sales-staff/add-receipt.tsx",
  "components/sales-staff/receipt-steps.tsx",
  "components/ui/progress-ring.tsx",
  "components/ui/surfaces.tsx",
  "components/ui/count-up.tsx",
];

const REDESIGN_SURFACES = [
  HOME_PAGE,
  CAMPAIGNS_PAGE,
  DETAIL_PAGE,
  EARNINGS_PAGE,
  ...REDESIGN_COMPONENTS,
];

/* =========================================================================
 * Fixtures
 * ======================================================================= */

const CAMPAIGN_A = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_B = "22222222-2222-4222-8222-222222222222";

function campaign(overrides: Partial<AssignedCampaign> = {}): AssignedCampaign {
  return {
    campaignId: CAMPAIGN_A,
    campaignName: "Shampoo push",
    description: null,
    vendorName: null,
    derivedState: "ACTIVE",
    campaignStatus: "PUBLISHED",
    startsAt: "2026-06-06T00:00:00Z",
    endsAt: "2026-09-04T00:00:00Z",
    timezoneName: "Asia/Dubai",
    performanceScope: "INDIVIDUAL_STAFF",
    productScope: "SELECTED_PRODUCTS",
    productEligibilityResolution: "LIVE_TEMPORAL",
    stackingMode: "STACKABLE",
    rewardRecipientScope: "CONTRIBUTING_STAFF",
    reward: {
      ruleType: "PER_UNIT_COINS",
      metricType: "UNITS_SOLD",
      coinsPerUnit: 5,
      maxRewardCoins: null,
      thresholdUnits: null,
      rewardCoins: null,
    },
    eligibleProductCount: 3,
    ...overrides,
  };
}

function progress(
  overrides: Partial<CampaignTargetProgress> = {},
): CampaignTargetProgress {
  return {
    campaignId: CAMPAIGN_A,
    campaignVersionId: "33333333-3333-4333-8333-333333333333",
    campaignName: "Shampoo push",
    performanceScope: "INDIVIDUAL_STAFF",
    targetUnits: 50,
    configuredRewardCoins: 100,
    progressUnits: 5,
    targetReached: false,
    bonusAwardedToMe: false,
    ...overrides,
  };
}

function opportunity(
  campaignOverrides: Partial<AssignedCampaign> = {},
  progressRow: CampaignTargetProgress | null = null,
): SalesStaffOpportunity {
  return { campaign: campaign(campaignOverrides), progress: progressRow };
}

/* =========================================================================
 * 1. THE HERO SELECTION RULE
 * ======================================================================= */
describe("1. the hero selection rule", () => {
  test("nothing to show returns null", () => {
    assert.equal(selectHeroOpportunity([]), null);
  });

  test("prefers the first RUNNING campaign that has a target", () => {
    const withTarget = opportunity(
      { campaignId: CAMPAIGN_B },
      progress({ campaignId: CAMPAIGN_B }),
    );
    const hero = selectHeroOpportunity([
      opportunity({ campaignName: "Per unit, listed first" }),
      withTarget,
    ]);
    assert.equal(hero, withTarget);
  });

  test("falls back to the first running campaign when none has a target", () => {
    const first = opportunity({ campaignName: "First" });
    const hero = selectHeroOpportunity([
      first,
      opportunity({ campaignId: CAMPAIGN_B, campaignName: "Second" }),
    ]);
    assert.equal(hero, first);
  });

  test("falls back to the first visible campaign when nothing is running", () => {
    const scheduled = opportunity({ derivedState: "SCHEDULED" });
    assert.equal(selectHeroOpportunity([scheduled]), scheduled);
  });

  test("a REACHED target is not skipped in favour of an unreached one", () => {
    // Preferring an unreached target would be a judgement about which reward deserves
    // attention, and the contract gives no basis for one. First is first.
    const reached = opportunity(
      {},
      progress({ progressUnits: 5, targetUnits: 3, targetReached: true }),
    );
    const hero = selectHeroOpportunity([
      reached,
      opportunity({ campaignId: CAMPAIGN_B }, progress({ campaignId: CAMPAIGN_B })),
    ]);
    assert.equal(hero, reached);
  });

  test("a scheduled campaign never outranks a running one, even with a target", () => {
    // The first filter is "running AND has a target", not "has a target".
    const running = opportunity({ campaignId: CAMPAIGN_B, campaignName: "Running" });
    const hero = selectHeroOpportunity([
      opportunity({ derivedState: "SCHEDULED" }, progress()),
      running,
    ]);
    assert.equal(hero, running);
  });

  test("buildOpportunities joins on the campaign id, never on the name", () => {
    const row = progress({
      campaignId: CAMPAIGN_B,
      campaignName: "A completely different name",
    });
    const built = buildOpportunities(
      [campaign(), campaign({ campaignId: CAMPAIGN_B, campaignName: "Second" })],
      new Map([[CAMPAIGN_B, row]]),
    );
    assert.equal(built[0].progress, null);
    assert.equal(built[1].progress, row);
  });

  test("buildOpportunities preserves the order the backend returned", () => {
    const built = buildOpportunities(
      [
        campaign({ campaignName: "First" }),
        campaign({ campaignId: CAMPAIGN_B, campaignName: "Second" }),
      ],
      new Map(),
    );
    assert.deepEqual(
      built.map((entry) => entry.campaign.campaignName),
      ["First", "Second"],
    );
  });

  test("remainingOpportunities drops exactly the hero and keeps the order", () => {
    const a = opportunity({ campaignName: "A" });
    const b = opportunity({ campaignId: CAMPAIGN_B, campaignName: "B" });
    assert.deepEqual(remainingOpportunities([a, b], a), [b]);
    assert.deepEqual(remainingOpportunities([a], null), [a]);
  });

  test("NOTHING is scored, ranked or sorted", () => {
    const source = code("lib/sales-staff/home-presentation.ts");
    for (const forbidden of [".sort(", "localeCompare", "score", "rank", "recommend"]) {
      assert.ok(
        !source.includes(forbidden),
        `the hero rule uses ${forbidden}, which would be a recommendation`,
      );
    }
  });

  test("isRunning is the derived ACTIVE state and nothing else", () => {
    assert.equal(isRunning(campaign({ derivedState: "ACTIVE" })), true);
    assert.equal(isRunning(campaign({ derivedState: "SCHEDULED" })), false);
  });
});

/* =========================================================================
 * 2. THE HERO EYEBROW
 * ======================================================================= */
describe("2. the hero eyebrow", () => {
  test("a met target resolves to REACHED, never to 'your next reward'", () => {
    const kind = heroEyebrowKind(opportunity({}, progress({ targetReached: true })));
    assert.equal(kind, "reached");
    assert.equal(HERO_EYEBROW_REACHED, "TARGET REACHED");
    assert.notEqual(HERO_EYEBROW_REACHED, HERO_EYEBROW_NEXT);
  });

  test("an unmet target resolves to NEXT REWARD", () => {
    assert.equal(heroEyebrowKind(opportunity({}, progress())), "next");
    assert.equal(HERO_EYEBROW_NEXT, "YOUR NEXT REWARD");
  });

  test("no progress row falls back to the lifecycle state", () => {
    assert.equal(heroEyebrowKind(opportunity()), "running");
    assert.equal(
      heroEyebrowKind(opportunity({ derivedState: "SCHEDULED" })),
      "upcoming",
    );
    assert.equal(HERO_EYEBROW_RUNNING, "RUNNING NOW");
    assert.equal(HERO_EYEBROW_UPCOMING, "STARTING SOON");
  });

  test("the hero maps every eyebrow kind to copy, with no branch left out", () => {
    const hero = code("components/sales-staff/next-reward-hero.tsx");
    for (const kind of ["next", "reached", "running", "upcoming"]) {
      assert.match(hero, new RegExp(`${kind}:`), `the hero drops the ${kind} eyebrow`);
    }
  });
});

/* =========================================================================
 * 3. PROGRESS SEMANTICS — INCLUDING BEYOND 100%
 * ======================================================================= */
describe("3. progress semantics", () => {
  test("the ring's fraction is clamped; the printed values are NOT", () => {
    const over = progress({ progressUnits: 9, targetUnits: 8 });

    // The drawing saturates …
    assert.equal(progressFraction(over), 1);
    assert.equal(progressPercent(over), 100);

    // … the facts do not. 9 of 8 stays 9 of 8.
    assert.equal(progressValueLabel(over), "9 of 8 units");
    assert.match(progressSemanticLabel(over), /9 of 8 units/);
    assert.ok(
      !progressValueLabel(over).includes("8 of 8"),
      "the real numerator was truncated to fit the ring",
    );
  });

  test("a zero or negative target never divides by zero", () => {
    assert.equal(progressFraction({ progressUnits: 5, targetUnits: 0 }), 0);
    assert.equal(progressPercent({ progressUnits: 5, targetUnits: 0 }), 0);
  });

  test("unitsRemaining is floored at zero and never negative", () => {
    assert.equal(unitsRemaining({ progressUnits: 5, targetUnits: 50 }), 45);
    assert.equal(unitsRemaining({ progressUnits: 9, targetUnits: 8 }), 0);
  });

  test("the accessible label carries values, percent and state, in visual order", () => {
    const label = progressSemanticLabel(progress({ progressUnits: 5, targetUnits: 50 }));
    // "5 of 50 units, 10 percent." — the numerator and denominator FIRST, because the
    // percentage is the derived value of the two.
    assert.match(label, /5 of 50 units, 10 percent\./);
    assert.match(label, /percent/);
    assert.ok(!label.includes("%"), "the spoken form must not use the % glyph");
  });

  test("an INDIVIDUAL target speaks as the seller's own", () => {
    const label = progressSemanticLabel(progress());
    assert.match(label, /Your progress/);
    assert.match(label, /counts your own qualifying units/);
  });

  test("a RETAILER_TEAM target says the progress includes colleagues", () => {
    const label = progressSemanticLabel(
      progress({ performanceScope: "RETAILER_TEAM" }),
    );
    assert.match(label, /Team progress/);
    assert.match(label, /everyone at your Retailer, not only yours/);
    assert.ok(
      !label.includes("Your progress"),
      "a team figure was announced as a personal one",
    );
  });

  test("a team target crossed by a COLLEAGUE never claims a personal bonus", () => {
    const label = progressSemanticLabel(
      progress({
        performanceScope: "RETAILER_TEAM",
        progressUnits: 9,
        targetUnits: 8,
        targetReached: true,
        bonusAwardedToMe: false,
      }),
    );
    assert.match(label, /awarded to another team member/);
    assert.ok(!/You received/.test(label), "it claimed the reader was paid");
  });

  test("bonus_awarded_to_me is the ONLY case that says you received it", () => {
    const mine = progressSemanticLabel(
      progress({ targetReached: true, bonusAwardedToMe: true }),
    );
    assert.match(mine, /You received/);
  });

  test("the headline states what is left, and pluralises", () => {
    assert.match(
      progressHeadline(progress({ progressUnits: 49, targetUnits: 50 })),
      /1 more eligible unit to reach your target\./,
    );
    assert.match(
      progressHeadline(
        progress({ progressUnits: 40, targetUnits: 50, performanceScope: "RETAILER_TEAM" }),
      ),
      /10 more eligible units to reach the team target\./,
    );
  });

  test("counted up to the target but not recorded as reached is said plainly", () => {
    // Evaluation is the database's, and it may simply not have run yet.
    assert.match(
      progressHeadline(progress({ progressUnits: 50, targetUnits: 50 })),
      /has not been recorded as reached yet/,
    );
  });

  test("the ring's colour ramp is decided by target_reached, never by the fraction", () => {
    assert.equal(progressSweep({ targetReached: true }, 0.1), "emerald");
    assert.equal(progressSweep({ targetReached: false }, 0.9), "warm");
    assert.equal(progressSweep({ targetReached: false }, 0.2), "indigo");
  });
});

/* =========================================================================
 * 4. CAMPAIGN TYPES LOOK DIFFERENT
 * ======================================================================= */
describe("4. campaign-type faces", () => {
  test("a per-unit campaign leads with a rate glyph", () => {
    assert.deepEqual(campaignFace(campaign(), null), {
      kind: "per-unit",
      tone: "indigo",
    });
  });

  test("an individual target gets a target glyph", () => {
    assert.deepEqual(campaignFace(campaign(), progress()), {
      kind: "target-individual",
      tone: "indigo",
    });
  });

  test("a RETAILER_TEAM target gets a team glyph and its own tone", () => {
    assert.deepEqual(
      campaignFace(campaign(), progress({ performanceScope: "RETAILER_TEAM" })),
      { kind: "target-team", tone: "amber" },
    );
  });

  test("a reached target is the only emerald face", () => {
    assert.deepEqual(
      campaignFace(campaign(), progress({ targetReached: true })),
      { kind: "target-reached", tone: "emerald" },
    );
  });

  test("a scheduled campaign shows a calendar, whatever its rule", () => {
    assert.deepEqual(campaignFace(campaign({ derivedState: "SCHEDULED" }), null), {
      kind: "scheduled",
      tone: "blue",
    });
    // Even when a progress row happens to exist for it.
    assert.equal(
      campaignFace(campaign({ derivedState: "SCHEDULED" }), progress()).kind,
      "scheduled",
    );
  });

  test("a target campaign with no progress row is NOT drawn as reached", () => {
    // Emerald means "target reached" on the indicator directly below, and two meanings
    // for one hue on one card is exactly the ambiguity the tones exist to remove.
    const face = campaignFace(
      campaign({
        reward: { ...campaign().reward, ruleType: "TARGET_BONUS" },
      }),
      null,
    );
    assert.equal(face.kind, "target");
    assert.notEqual(face.tone, "emerald");
  });
});

/* =========================================================================
 * 5. THE ADDITIVE QUALIFIERS
 * ======================================================================= */
describe("5. campaign qualifiers", () => {
  const coins = (value: number) => `${value} coins`;

  test("an ordinary campaign shows no cap chip", () => {
    const kinds = campaignQualifiers(campaign(), coins).map((q) => q.kind);
    assert.ok(!kinds.includes("cap"), "an uncapped campaign advertised a cap");
    assert.deepEqual(kinds, ["products", "combinable", "live"]);
  });

  test("a CAPPED campaign states its maximum", () => {
    const qualifiers = campaignQualifiers(
      campaign({ reward: { ...campaign().reward, maxRewardCoins: 12 } }),
      coins,
    );
    const cap = qualifiers.find((q) => q.kind === "cap");
    assert.ok(cap !== undefined, "the cap chip is missing");
    assert.equal(cap.label, "Max 12 coins");
    assert.equal(QUALIFIER_TONES.cap, "amber");
  });

  test("EXCLUSIVE and combinable are distinguishable, and not by colour alone", () => {
    const exclusive = campaignQualifiers(
      campaign({ stackingMode: "EXCLUSIVE" }),
      coins,
    );
    const combinable = campaignQualifiers(campaign(), coins);

    assert.ok(exclusive.some((q) => q.kind === "exclusive" && q.label === "Exclusive"));
    assert.ok(combinable.some((q) => q.kind === "combinable" && q.label === "Combines"));
    // Each carries a word, not merely a tone.
    assert.notEqual(QUALIFIER_TONES.exclusive, QUALIFIER_TONES.combinable);
  });

  test("SNAPSHOT and LIVE_TEMPORAL eligibility are distinguishable", () => {
    const snapshot = campaignQualifiers(
      campaign({ productEligibilityResolution: "SNAPSHOT" }),
      coins,
    );
    assert.ok(snapshot.some((q) => q.kind === "snapshot" && q.label === "Snapshot"));
    assert.ok(
      campaignQualifiers(campaign(), coins).some(
        (q) => q.kind === "live" && q.label === "Live",
      ),
    );
  });

  test("the product count is singular-aware", () => {
    assert.equal(
      campaignQualifiers(campaign({ eligibleProductCount: 1 }), coins)[0].label,
      "1 product",
    );
    assert.equal(campaignQualifiers(campaign(), coins)[0].label, "3 products");
  });

  test("all four qualifiers can appear at once", () => {
    // A capped, exclusive, snapshot per-unit campaign is representable without a
    // special case, because the qualifiers are independent of the face.
    const kinds = campaignQualifiers(
      campaign({
        stackingMode: "EXCLUSIVE",
        productEligibilityResolution: "SNAPSHOT",
        reward: { ...campaign().reward, maxRewardCoins: 500 },
      }),
      coins,
    ).map((q) => q.kind);
    assert.deepEqual(kinds, ["products", "cap", "exclusive", "snapshot"]);
  });
});

/* =========================================================================
 * 6. THE HOME SCREEN
 * ======================================================================= */
describe("6. the Sales Staff Home", () => {
  const page = code(HOME_PAGE);

  test("it composes the six existing reads and introduces no new contract", () => {
    for (const read of [
      "listMyStaffCampaigns",
      "getMyCampaignTargetProgress",
      "getMyCampaignEarningsSummary",
      "getMyReceiptSubmissions",
      "getMyAssignedReceiptShops",
    ]) {
      assert.ok(page.includes(read), `the Home no longer calls ${read}`);
    }
    // No RPC is named directly: the adapters own every rpc name.
    assert.doesNotMatch(page, /\.rpc\(\s*["'`]/, "the Home calls an RPC directly");
    assert.doesNotMatch(page, /\.from\(\s*["'`]/, "the Home reads a table directly");
  });

  test("it re-resolves authorization and fails closed for a non-submitter", () => {
    assert.match(page, /getRetailerPortalAccess/);
    assert.match(page, /access\.kind !== "submitter"/);
    assert.match(page, /redirect\("\/retailer-access-denied"\)/);
    assert.match(page, /redirect\("\/login"\)/);
  });

  test("the Add receipt action opens the EXISTING submission route", () => {
    const cta = code("components/sales-staff/add-receipt.tsx");
    assert.match(cta, /href="\/retailer\/receipts"/);
    // No second upload path: the CTA navigates and posts nothing.
    assert.ok(!cta.includes("<form"), "the CTA grew its own form");
    assert.ok(!cta.includes("fetch("), "the CTA uploads by itself");
    assert.ok(!cta.includes("type=\"file\""), "the CTA grew a second file input");
    assert.equal(ADD_RECEIPT, "Add receipt");
    assert.equal(ADD_RECEIPT_HINT, "Submit your sale to qualify");
  });

  test("the greeting never contradicts an empty screen", () => {
    assert.equal(GREETING, "Welcome back");
    assert.match(page, /GREETING_LINE_NO_CAMPAIGNS/);
    assert.match(GREETING_LINE, /within reach/);
    assert.match(GREETING_LINE_NO_CAMPAIGNS, /campaigns appear here/);
  });

  test("it invents no statistic, streak, rank or countdown", () => {
    for (const path of REDESIGN_SURFACES) {
      const source = code(path);
      assert.doesNotMatch(
        source,
        /\b(streak|leaderboard|ranking|countdown|guaranteed|projected|forecast)\b/i,
        `${path} invents motivation`,
      );
    }
  });

  test("a truncated opportunity strip states the cap", () => {
    assert.equal(showingSome(3, 5), "Showing 3 of 5.");
    assert.match(page, /showingSome/);
    assert.equal(MAX_OPPORTUNITY_CARDS, 6);
  });

  test("the desktop layout is a constrained reading measure, not the full width", () => {
    // A dashboard whose every card spans a 1440px browser is a phone layout stretched.
    assert.match(page, /max-w-5xl/);
    assert.ok(!page.includes("max-w-full"), "the Home stretches across the browser");
  });

  test("the Home is responsive at mobile, tablet and desktop widths", () => {
    // The opportunity region is a scrolling strip on a phone and a grid from `sm` up.
    assert.match(page, /overflow-x-auto/);
    assert.match(page, /sm:grid/);
    assert.match(page, /lg:grid-cols-3/);
  });

  test("it has a skeleton loading state that matches what arrives", () => {
    const loading = code("app/(retailer)/retailer/home/loading.tsx");
    assert.match(loading, /SkeletonScreen/);
    // The label is generic: it never names a record, a campaign or an identity.
    assert.match(loading, /Loading your home screen/);
  });
});

/* =========================================================================
 * 7. EARNINGS
 * ======================================================================= */
describe("7. earnings", () => {
  const page = code(EARNINGS_PAGE);

  test("the compact summary shows only authoritative figures", () => {
    const panel = code("components/sales-staff/coins-panel.tsx");
    for (const field of [
      "totalRewardCoins",
      "currentMonthRewardCoins",
      "rewardedSaleCount",
    ]) {
      assert.ok(panel.includes(field), `the coins panel dropped ${field}`);
    }
    // It never renders zeros for a summary it could not read.
    assert.match(panel, /COINS_UNAVAILABLE/);
    assert.match(panel, /summary === null/);
  });

  test("the earnings page keeps its approved heading and totals", () => {
    assert.match(page, /My campaign earnings/);
    for (const field of [
      "totalRewardCoins",
      "currentMonthRewardCoins",
      "rewardedSaleCount",
      "rewardedCampaignCount",
      "latestRewardAt",
    ]) {
      assert.ok(page.includes(field), `the earnings page dropped ${field}`);
    }
  });

  test("the empty state says what has to happen, and offers Add receipt", () => {
    assert.match(page, /Not every receipt qualifies/);
    assert.match(page, /AddReceiptAction/);
    // It never promises the next receipt will earn anything.
    assert.doesNotMatch(page, /will earn|you will receive|guaranteed/i);
  });

  test("NO wallet, balance, redemption, payout or paid-status vocabulary", () => {
    const forbidden =
      /\b(wallet|available balance|redeem|redemption|payout|withdraw|cash out|paid status)\b/i;
    for (const path of REDESIGN_SURFACES) {
      for (const line of code(path).split("\n")) {
        assert.ok(
          !forbidden.test(line),
          `${path} introduces wallet vocabulary: ${line.trim()}`,
        );
      }
    }
    // The one mention is the NOTICE, which states the absence rather than implying one.
    assert.match(NOT_A_WALLET_NOTICE, /not available yet/);
    assert.match(page, /NOT_A_WALLET_NOTICE/);
  });

  test("verified_sale_id is never exposed on any redesigned surface", () => {
    for (const path of [...REDESIGN_SURFACES, RECEIPTS_PAGE]) {
      const source = code(path);
      assert.ok(
        !/verified_sale_id|verifiedSaleId/i.test(source),
        `${path} exposes a verified sale id`,
      );
    }
  });
});

/* =========================================================================
 * 8. THE BACKEND BOUNDARY IS UNCHANGED
 * ======================================================================= */
describe("8. the backend boundary", () => {
  test("no redesigned surface reads a table or calls an RPC directly", () => {
    for (const path of REDESIGN_SURFACES) {
      const source = code(path);
      // A quoted argument, so `Array.from(...)` is not mistaken for a table read.
      assert.doesNotMatch(source, /\.from\(\s*["'`]/, `${path} reads a table directly`);
      assert.doesNotMatch(source, /\.rpc\(\s*["'`]/, `${path} calls an RPC directly`);
      for (const table of [
        "campaign_rewards",
        "campaign_subject_accumulators",
        "verified_sales",
      ]) {
        assert.ok(!source.includes(table), `${path} names table ${table}`);
      }
    }
  });

  test("no reward or coin arithmetic is performed in the presentation layer", () => {
    for (const path of REDESIGN_SURFACES) {
      const source = code(path);
      assert.doesNotMatch(
        source,
        /coinsPerUnit\s*\*|\*\s*coinsPerUnit|rewardCoins\s*[+\-*/]\s*[a-zA-Z]/,
        `${path} calculates a reward`,
      );
    }
  });

  test("no migration, Edge Function or Flutter file is referenced", () => {
    for (const path of REDESIGN_SURFACES) {
      const source = code(path);
      assert.ok(!source.includes("supabase/migrations"), `${path} references migrations`);
      assert.ok(!source.includes("supabase/functions"), `${path} references a function`);
      assert.doesNotMatch(source, /\.dart\b/, `${path} references Flutter`);
    }
  });

  test("role visibility is unchanged: the new route is Sales Staff only", () => {
    const nav = code("components/retailer-portal/retailer-nav-items.tsx");
    // Home belongs to the submitter list, and to no other.
    assert.match(
      nav,
      /kind === "submitter"\)\s*\{\s*return \[HOME_ITEM, RECEIPTS_ITEM, MY_CAMPAIGNS_ITEM, MY_EARNINGS_ITEM\]/,
    );
    assert.match(nav, /return \[STAFF_ITEM, PRODUCTS_ITEM\]/);
    assert.match(
      nav,
      /return \[OVERVIEW_ITEM, SHOPS_ITEM, STAFF_ITEM, PRODUCTS_ITEM, CAMPAIGNS_ITEM\]/,
    );
    // And it is absent from the Vendor Admin navigation entirely.
    assert.ok(!code("components/admin/nav-items.tsx").includes("/retailer/home"));
  });
});

/* =========================================================================
 * 9. MOTION
 * ======================================================================= */
describe("9. motion", () => {
  const css = read("app/globals.css");

  test("the entrance and ring animations are one-shot, never looping", () => {
    assert.match(css, /@keyframes sr-rise/);
    assert.match(css, /@keyframes sr-ring-sweep/);
    // `infinite` appears only on the skeleton shimmer and the nav progress bar, both
    // of which predate this milestone and are removed under reduced motion.
    for (const block of [".sr-animate-rise", ".sr-ring-sweep"]) {
      const start = css.indexOf(block);
      assert.ok(start > -1, `${block} is missing`);
      const rule = css.slice(start, css.indexOf("}", start));
      assert.ok(!rule.includes("infinite"), `${block} loops`);
    }
  });

  test("reduced motion collapses BOTH the duration and the stagger delay", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(reduced, /animation-duration:\s*0\.001ms\s*!important/);
    // Without this a staggered entrance would leave content INVISIBLE for its delay —
    // the one way a reduced-motion screen could end up worse than an animated one.
    assert.match(reduced, /animation-delay:\s*0ms\s*!important/);
    assert.match(reduced, /\.sr-skeleton::after\s*\{\s*display:\s*none/);
  });

  test("the ring holds its settled value rather than snapping back to zero", () => {
    // `both` keeps the final frame; under reduced motion that frame is the first one.
    const rule = css.slice(css.indexOf(".sr-ring-sweep"));
    assert.match(rule.slice(0, rule.indexOf("}")), /both/);
  });

  test("the count-up shows the stored number whenever it is not animating", () => {
    const source = code("components/ui/count-up.tsx");
    // A number merely WAITING to animate must never render smaller than the stored one.
    assert.match(source, /useState\(value\)/);
    assert.match(source, /prefers-reduced-motion: reduce/);
    // It restarts on a VALUE change, not on every render.
    assert.match(source, /\[value, durationMs\]/);
  });

  test("the entrance rise is a transform, so it cannot shift the layout", () => {
    const rise = css.slice(css.indexOf("@keyframes sr-rise"));
    const body = rise.slice(0, rise.indexOf("}\n}") + 3);
    assert.match(body, /transform:\s*translateY/);
    assert.ok(!/margin|height|top:/.test(body), "the entrance animates layout");
  });
});

/* =========================================================================
 * 10. ACCESSIBILITY
 * ======================================================================= */
describe("10. accessibility", () => {
  test("the ring is silent and the block around it speaks", () => {
    const ring = code("components/ui/progress-ring.tsx");
    assert.match(ring, /aria-hidden="true"/);
    // It carries no role of its own — a bare percentage says nothing about whose units.
    assert.ok(!ring.includes('role="progressbar"'), "the ring announces itself");

    const block = code("components/sales-staff/target-progress.tsx");
    assert.match(block, /role="progressbar"/);
    assert.match(block, /aria-valuenow=\{progress\.progressUnits\}/);
    assert.match(block, /aria-valuemax=\{progress\.targetUnits\}/);
    assert.match(block, /aria-valuetext=\{semantic\}/);
  });

  test("status is never carried by colour alone", () => {
    const block = code("components/sales-staff/target-progress.tsx");
    // A tone, a badge with a word, and a sentence.
    assert.match(block, /statement\.label/);
    assert.match(block, /progressHeadline/);

    const nav = code("components/retailer-portal/retailer-shell.tsx");
    // The selected bottom-bar tab carries a shape as well as a hue.
    assert.match(nav, /aria-current=\{active \? "page" : undefined\}/);
  });

  test("the bottom bar shortens the visible label but never the accessible name", () => {
    const shell = code("components/retailer-portal/retailer-shell.tsx");
    assert.match(shell, /shortLabel \?\? item\.label/);
    assert.match(shell, /<span className="sr-only">\{item\.label\}<\/span>/);
  });

  test("each list stays a real list, so it still announces its length", () => {
    for (const path of [HOME_PAGE, CAMPAIGNS_PAGE]) {
      const source = code(path);
      assert.match(source, /<ul/);
      assert.match(source, /as="li"/);
    }
  });

  test("gradient and filter ids are per-instance, so two rings cannot collide", () => {
    const ring = code("components/ui/progress-ring.tsx");
    assert.match(ring, /idSuffix: string;/);
    assert.match(ring, /sr-ring-gradient\$\{idSuffix\}/);
  });
});
