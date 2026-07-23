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

  test("4 & 5. no full-reload navigation or stray router.refresh anywhere", () => {
    const files = [...walk("app"), ...walk("components")];
    for (const file of files) {
      const src = read(file);
      assert.ok(!/window\.location/.test(src), `${file} uses window.location`);
      assert.ok(!/location\.(href|assign|replace)\s*=/.test(src), `${file} assigns location`);
      assert.ok(!/router\.refresh\(/.test(src), `${file} calls router.refresh()`);
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
