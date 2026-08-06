/**
 * SOURCE-LEVEL guards for the navigation-feedback & performance milestone.
 *
 * Run with:  npm test
 *
 * These pin the structural properties of the fix — every major route group has a
 * loading state, navigation uses real Next.js Link (never a full reload), loading
 * states are announced to assistive tech, the progress indicator holds no
 * sensitive data and no fake percentage, and pending buttons disable. They assert
 * NO timing (local speed varies) and NO Tailwind class.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Strips comments so prose describing a rule ("carries no token") cannot trip it. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Every .ts/.tsx file under the given roots. */
function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

const LOADING_ROUTES = [
  "app/(admin)/loading.tsx",
  "app/(admin)/retailers/loading.tsx",
  "app/(admin)/retailers/new/loading.tsx",
  "app/(admin)/retailers/[relationshipId]/loading.tsx",
  "app/(admin)/retailers/[relationshipId]/owner/invite/loading.tsx",
  "app/(admin)/retailers/[relationshipId]/shops/new/loading.tsx",
  "app/(admin)/products/loading.tsx",
  "app/(admin)/users/loading.tsx",
  "app/(admin)/roles/loading.tsx",
  "app/(admin)/audit-logs/loading.tsx",
  "app/(retailer)/retailer/loading.tsx",
  "app/(retailer)/retailer/staff/loading.tsx",
  "app/(retailer)/retailer/home/loading.tsx",
  "app/(retailer)/retailer/receipts/loading.tsx",
  "app/(retailer)/retailer/shops/loading.tsx",
  "app/(retailer)/retailer/products/loading.tsx",
  "app/invitations/complete/loading.tsx",
  "app/invitations/staff/loading.tsx",
];

describe("every major route group has a loading state", () => {
  test("1. the loading.tsx files exist", () => {
    for (const route of LOADING_ROUTES) {
      assert.ok(existsSync(join(ROOT, route)), `missing loading state: ${route}`);
    }
  });

  test("6. every loading state is announced to assistive technology", () => {
    for (const route of LOADING_ROUTES) {
      const src = read(route);
      const announced =
        src.includes("SkeletonScreen") ||
        (src.includes('role="status"') && src.includes("sr-only"));
      assert.ok(announced, `${route} has no screen-reader status`);
    }
  });
});

describe("navigation uses client-side Next.js Link, never a full reload", () => {
  test("2. the sidebars navigate with Link", () => {
    for (const shell of [
      "components/admin/admin-sidebar.tsx",
      "components/retailer-portal/retailer-shell.tsx",
    ]) {
      const src = read(shell);
      assert.ok(src.includes('from "next/link"'), `${shell} does not import Link`);
      assert.ok(src.includes("<Link"), `${shell} does not render Link`);
    }
  });

  test("3. the retailer View-details action uses Link", () => {
    const src = read("app/(admin)/retailers/page.tsx");
    assert.ok(src.includes("<Link"), "the retailers list no longer uses Link");
    assert.ok(!src.includes("<a href"), "the retailers list uses a raw anchor");
  });

  /**
   * The files permitted to call router.refresh(), and why.
   *
   * 1. MANAGE SHOPS DIALOG — the shop picker is populated by a read that can fail
   *    independently of the roster (list_retailer_staff_assignable_shops). When it does, the
   *    brief requires a READ-ONLY RETRY inside the dialog rather than a page error — and a
   *    retry of a Server Component read is exactly what router.refresh() is for.
   *
   * 2. QUALIFICATION PANEL — added by the Phase 1D-0 settlement correction.
   *
   *    The original rule said post-mutation sync should use revalidatePath from the Server
   *    Action instead. A controlled hosted classification disproved that for THIS route:
   *    Next.js completes "the mutation, the cache invalidation, and the page re-render ...
   *    in a single roundtrip", so revalidating the path the reviewer is already viewing
   *    held the action's reply until the receipt-detail route had re-rendered — layout auth
   *    checks, get_claim_review_detail and get_claim_receipt_qualification, each a separate
   *    cross-region round trip. The immutable event had committed and been audited, and the
   *    reviewer still saw "Recording…" indefinitely.
   *
   *    So the qualification action now returns its outcome and nothing else, and the panel
   *    re-reads the route itself AFTER that outcome is on screen. This is not navigation and
   *    not a write: it is a re-attempt of a Server Component read, the same justification
   *    as (1). The rule is unchanged everywhere else, the per-file cap still applies, and
   *    the assertion below additionally pins that the qualification action may never
   *    reintroduce the same-route revalidation that caused the hang.
   *
   *    See docs/server-action-authoritative-settlement.md.
   *
   * 3. SALE-HEADER PANEL — the SECOND consumer of the same settlement pattern,
   *    added by Phase 1D-A. Finalizing a sale header is an immutable, audited
   *    financial write on the SAME heavy cross-region route that produced the
   *    original hang, so its action returns the authoritative outcome and
   *    revalidates nothing, and the panel re-reads the route itself afterwards.
   *    Identical justification to (2): a re-attempt of a Server Component read,
   *    not navigation and not a write. Test 4b below covers both actions.
   *
   *    See docs/claim-reviewer-sale-header-finalization-web.md.
   *
   * 4. PRODUCT PANEL — the THIRD consumer of the same settlement pattern, added
   *    by Phase 1D-B. Accepting or rejecting a receipt's whole product list is an
   *    immutable, audited write on the SAME heavy cross-region route, so its
   *    action returns the authoritative outcome and revalidates nothing, and the
   *    panel re-reads the route itself afterwards. Identical justification to (2)
   *    and (3): a re-attempt of a Server Component read, not navigation and not a
   *    write. Test 4b below covers all three actions.
   *
   *    Its single call site is shared by the post-settlement effect and the manual
   *    "Check product decision status" button, and is guarded by a ref so at most
   *    one automatic refresh follows an authoritative result.
   *
   *    See docs/claim-reviewer-product-decision-flow.md.
   *
   * 5. CAMPAIGN EVALUATION PANEL — the FOURTH consumer of the same settlement
   *    pattern, added by Phase 2A-F. Evaluating a sale is an audited write on the
   *    same heavy cross-region route, so its action returns the authoritative
   *    outcome and revalidates nothing, and the panel re-reads the route itself
   *    afterwards. Identical justification to (2), (3) and (4).
   *
   *    Its single call site is shared by the post-settlement effect and the manual
   *    "Check campaign results" button, and is guarded by a ref so at most one
   *    automatic refresh follows an authoritative result.
   *
   * See docs/retailer-manage-staff-shops-web.md § 11.
   */
  const REFRESH_ALLOWED = new Set([
    "app/(retailer)/retailer/staff/manage-shops-dialog.tsx",
    "app/(review)/review/[receiptSubmissionId]/qualification-panel.tsx",
    "app/(review)/review/[receiptSubmissionId]/sale-header-panel.tsx",
    "app/(review)/review/[receiptSubmissionId]/product-panel.tsx",
    "app/(review)/review/[receiptSubmissionId]/campaign-evaluation-panel.tsx",
  ]);

  test("4 & 5. no full-reload navigation or stray router.refresh anywhere", () => {
    const files = [...walk("app"), ...walk("components")];
    for (const file of files) {
      const src = read(file);
      assert.ok(!/window\.location/.test(src), `${file} uses window.location`);
      assert.ok(!/location\.(href|assign|replace)\s*=/.test(src), `${file} assigns location`);

      if (REFRESH_ALLOWED.has(file)) {
        // Narrow the allowance to a single call, so the exception cannot quietly grow into
        // a habit inside the files that hold it.
        assert.equal(
          (stripComments(src).match(/router\.refresh\(/g) ?? []).length,
          1,
          `${file} may call router.refresh() exactly once`,
        );
        continue;
      }

      assert.ok(!/router\.refresh\(/.test(src), `${file} calls router.refresh()`);
    }
  });

  /**
   * The regression this correction exists to prevent.
   *
   * Re-adding revalidatePath to the qualification action would restore the exact hang a
   * reviewer hit while classifying a receipt as TEST_DATA, so it is pinned here rather
   * than left to code review.
   */
  test("4b. no immutable-write action revalidates the route it answers from", () => {
    for (const file of [
      "app/(review)/review/[receiptSubmissionId]/qualification-actions.ts",
      "app/(review)/review/[receiptSubmissionId]/sale-finalization-actions.ts",
      "app/(review)/review/[receiptSubmissionId]/product-decision-actions.ts",
    ]) {
      const action = stripComments(read(file));
      assert.ok(
        !/revalidatePath/.test(action),
        `${file} revalidates its own route again — this is the Recording… hang`,
      );
      assert.ok(
        !/from "next\/cache"/.test(action),
        `${file} imports next/cache again`,
      );
      assert.ok(!/redirect\(/.test(action), `${file} redirects`);
    }
  });
});

describe("the global progress indicator is safe and honest", () => {
  const src = stripComments(read("components/ui/nav-progress.tsx"));

  test("7. it uses the official useLinkStatus hook, not DOM interception", () => {
    assert.ok(src.includes("useLinkStatus"), "does not use useLinkStatus");
    assert.ok(!src.includes("addEventListener"), "intercepts DOM events");
    assert.ok(!/document\.(querySelector|addEventListener)/.test(src), "touches document");
  });

  test("8. it shows an indeterminate bar, never a fake percentage", () => {
    assert.ok(!src.includes("%"), "the progress component renders a percentage");
  });

  test("9 & 10. it carries no identity, route, or invitation data", () => {
    for (const bad of [
      "email",
      "token",
      "tokenHash",
      "organizationId",
      "userId",
      "membershipId",
      "invitationId",
      "retailerId",
    ]) {
      assert.ok(!src.includes(bad), `nav-progress references sensitive data: ${bad}`);
    }
  });
});

describe("no loading or progress source leaks invitation secrets", () => {
  test("11. loading states and the progress bar contain no token or hash", () => {
    for (const file of [...LOADING_ROUTES, "components/ui/nav-progress.tsx"]) {
      const src = stripComments(read(file));
      for (const bad of ["token", "tokenHash", "invitationId", "password"]) {
        assert.ok(!src.includes(bad), `${file} references ${bad}`);
      }
    }
  });
});

describe("primary actions give immediate pending feedback", () => {
  const forms: Array<[string, string]> = [
    ["app/(admin)/retailers/new/retailer-form.tsx", "onboardRetailer"],
    ["app/(admin)/retailers/[relationshipId]/shops/new/shop-form.tsx", "addVendorRetailerShop"],
    [
      "app/(admin)/retailers/[relationshipId]/owner/invite/invite-owner-form.tsx",
      "inviteRetailerOwnerAction",
    ],
    ["app/(retailer)/retailer/staff/invite-staff-form.tsx", "inviteStaffAction"],
    ["app/(retailer)/retailer/receipts/submit-receipt-form.tsx", "submitReceiptAction"],
    ["app/login/login-form.tsx", "signIn"],
    ["app/invitations/staff/accept-forms.tsx", "activateStaffAccountAction"],
  ];

  test("7. each form disables its submit while pending", () => {
    for (const [file] of forms) {
      const src = read(file);
      const disables = src.includes("loading={pending}") || src.includes("disabled={pending}");
      assert.ok(disables, `${file} does not disable its submit while pending`);
    }
  });

  test("8. each form still posts to its existing Server Action", () => {
    for (const [file, action] of forms) {
      assert.ok(read(file).includes(action), `${file} disconnected ${action}`);
    }
  });
});
