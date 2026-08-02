/**
 * CONTRACT AND SOURCE-LEVEL SAFETY GUARDS for Claim Reviewer portal access.
 *
 * Run with:  npm test
 *
 * These read this milestone's own source files and assert properties that no unit test
 * can observe at runtime but that a careless later edit could quietly break:
 *
 *   1. the permission exists, is portal-only, and reaches exactly one role;
 *   2. the resolver authorizes by PERMISSION, never by a role code, and takes no tenant;
 *   3. the access adapter sends nothing, uses the authenticated client, and leaks no error;
 *   4. the route gate branches to the four correct destinations;
 *   5. the reviewer surface carries no Vendor Admin navigation and no receipt data;
 *   6. PHASE 1B DID NOT TOUCH get_my_portal_context() — the Flutter contract.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression, naming the file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MIGRATION = "supabase/migrations/20260818210000_claim_reviewer_access.sql";
const PORTAL_CONTEXT_MIGRATION =
  "supabase/migrations/20260729090000_shared_portal_context.sql";
const ADAPTER = "lib/review/claim-reviewer-access.ts";
const LAYOUT = "app/(review)/review/layout.tsx";
const PAGE = "app/(review)/review/page.tsx";
const DENIED = "app/review-access-denied/page.tsx";
const LANDING = "lib/auth/landing-decision.ts";
const LANDING_WIRING = "lib/auth/authenticated-landing.ts";

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function stripSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, "");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(join(dir, entry)));
    else if (/\.tsx?$/.test(entry)) out.push(join(dir, entry));
  }
  return out;
}

/* ===========================================================================
 * 1. Permission vocabulary — portal-only, one role
 * ======================================================================== */
describe("1. permission vocabulary", () => {
  const migration = stripSqlComments(read(MIGRATION));

  test("1.1 seeds CLAIM_REVIEW_PORTAL_READ under the CLAIM_REVIEW module", () => {
    assert.match(migration, /'CLAIM_REVIEW_PORTAL_READ'/);
    assert.match(migration, /'CLAIM_REVIEW'/);
  });

  test("1.2 exactly one role code appears in the whole migration", () => {
    // The role-permission mapping is the ONLY place a role may be named, and it must
    // name CLAIM_REVIEWER. Any other role code anywhere in this file would be a second
    // grantee or a role-based authorization check, and both are regressions.
    const roleCodes = [
      "CLAIM_REVIEWER",
      "VENDOR_SUPER_ADMIN",
      "FINANCE_ADMIN",
      "RETAILER_OWNER",
      "RETAILER_MANAGER",
      "SALES_STAFF",
    ].filter((code) => migration.includes(`'${code}'`));

    assert.deepEqual(
      roleCodes,
      ["CLAIM_REVIEWER"],
      "only CLAIM_REVIEWER may be named in the claim-reviewer-access migration",
    );
  });

  test("1.3 does NOT create RECEIPT_REVIEW_READ or RECEIPT_VERIFY", () => {
    // Phase 1B grants a shell. Creating the receipt permissions here would mean the
    // moment Phase 1C's queue RPC ships, every reviewer silently gains receipt data.
    assert.ok(!migration.includes("RECEIPT_REVIEW_READ"));
    assert.ok(!migration.includes("RECEIPT_VERIFY"));
  });

  test("1.4 creates no table, policy or table grant", () => {
    assert.ok(!/create\s+table/i.test(migration), "no table may be created");
    assert.ok(!/create\s+policy/i.test(migration), "no RLS policy may be added");
    assert.ok(
      !/grant\s+(select|insert|update|delete|all)\s+on\s+table/i.test(migration),
      "no table privilege may be granted",
    );
  });

  test("1.5 introduces no Phase 1C+ vocabulary", () => {
    for (const forbidden of [
      "receipt_verification",
      "verified_sale",
      "campaign_contribution",
      "campaign_award",
      "coin_ledger",
      "product_match",
    ]) {
      assert.ok(
        !migration.includes(forbidden),
        `Phase 1B must not introduce ${forbidden}`,
      );
    }
  });
});

/* ===========================================================================
 * 2. The resolver
 * ======================================================================== */
describe("2. resolver contract", () => {
  const migration = stripSqlComments(read(MIGRATION));

  test("2.1 the resolver body contains no role code", () => {
    const body = migration.slice(
      migration.indexOf("create function public.resolve_claim_reviewer_organization"),
      migration.indexOf("create function public.get_claim_reviewer_context"),
    );
    assert.ok(body.length > 0, "the resolver must be found");
    // Authorization travels permission -> role_permissions -> role, so the mapping is
    // the sole authority and a role code here would be a second, competing one.
    assert.ok(
      !body.includes("CLAIM_REVIEWER"),
      "the resolver must not name CLAIM_REVIEWER — the mapping is the authority",
    );
    assert.ok(!body.includes("VENDOR_SUPER_ADMIN"));
  });

  test("2.2 the resolver takes exactly one parameter, a permission code", () => {
    const signature = migration.match(
      /create function public\.resolve_claim_reviewer_organization\(([\s\S]*?)\)\s*returns/,
    );
    assert.ok(signature, "the signature must be found");
    const params = signature[1]
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
    assert.deepEqual(params, ["target_permission_code"]);
  });

  test("2.3 no tenant, profile, role or membership parameter exists", () => {
    for (const forbidden of [
      "p_organization_id",
      "p_vendor_organization_id",
      "p_profile_id",
      "p_user_id",
      "p_member_id",
      "p_role_code",
    ]) {
      assert.ok(
        !migration.includes(forbidden),
        `neither function may accept ${forbidden}`,
      );
    }
  });

  test("2.4 it fails closed on zero AND on multiple qualifying organizations", () => {
    // The single clause that produces both behaviours.
    assert.match(migration, /where \(select count\(\*\) from qualifying\) = 1/);
    // And nothing that would pick one of several.
    assert.ok(
      !/order by o\.id[\s\S]*limit 1/.test(migration),
      "the resolver must not order-and-take-first the way the Vendor context does",
    );
  });

  test("2.5 the context RPC takes zero arguments", () => {
    assert.match(migration, /create function public\.get_claim_reviewer_context\(\)/);
  });

  test("2.6 the context RPC authorizes through the resolver and the portal permission", () => {
    assert.match(
      migration,
      /public\.resolve_claim_reviewer_organization\('CLAIM_REVIEW_PORTAL_READ'\)/,
    );
  });

  test("2.7 grants: authenticated only on the context RPC, nothing on the resolver", () => {
    assert.match(
      migration,
      /grant\s+execute\s+on\s+function\s+public\.get_claim_reviewer_context\(\)\s+to\s+authenticated/,
    );
    assert.match(
      migration,
      /revoke execute on function public\.resolve_claim_reviewer_organization\(text\) from authenticated/,
    );
    assert.ok(
      !/grant\s+execute[^\n]*to\s+(anon|service_role)/.test(migration),
      "neither anon nor service_role may be granted EXECUTE",
    );
  });
});

/* ===========================================================================
 * 3. The Web access adapter
 * ======================================================================== */
describe("3. access adapter", () => {
  const adapter = stripComments(read(ADAPTER));

  test("3.1 calls the context RPC with zero arguments", () => {
    assert.match(adapter, /\.rpc\("get_claim_reviewer_context"\)/);
    assert.ok(
      !/\.rpc\("get_claim_reviewer_context",/.test(adapter),
      "the RPC must be called with no argument object at all",
    );
  });

  test("3.2 supplies no organization or tenant identifier", () => {
    // Scoped to the CALL, not the whole module: the response row type legitimately
    // declares `organization_id` because the RPC returns it. What must not exist is a
    // tenant identifier travelling outward.
    const call = adapter.slice(
      adapter.indexOf('.rpc("get_claim_reviewer_context"'),
    );
    const callArgs = call.slice(0, call.indexOf(")") + 1);

    for (const forbidden of [
      "organizationId",
      "organization_id",
      "p_organization_id",
      "vendorId",
      "userId",
    ]) {
      assert.ok(
        !callArgs.includes(forbidden),
        `the RPC call must not send ${forbidden}`,
      );
    }
  });

  test("3.3 uses the authenticated server client, never the service role", () => {
    assert.match(adapter, /@\/lib\/supabase\/server/);
    for (const forbidden of [
      "SERVICE_ROLE",
      "service_role",
      "serviceRole",
      "createServiceClient",
    ]) {
      assert.ok(!adapter.includes(forbidden), `the adapter must not reference ${forbidden}`);
    }
  });

  test("3.4 performs no role-code check of its own", () => {
    for (const code of [
      "CLAIM_REVIEWER",
      "VENDOR_SUPER_ADMIN",
      "RETAILER_OWNER",
      "SALES_STAFF",
    ]) {
      assert.ok(
        !adapter.includes(code),
        `the adapter must not compare a role code (${code}) — SQL decides`,
      );
    }
  });

  test("3.5 never surfaces a raw database error", () => {
    for (const forbidden of [
      "error.message",
      "error.details",
      "error.hint",
      "error.code",
      "String(error)",
      "console.",
    ]) {
      assert.ok(!adapter.includes(forbidden), `the adapter must not surface ${forbidden}`);
    }
  });

  test("3.6 distinguishes unavailable from unauthorized", () => {
    // A transport or RPC failure must not read as a denial: an authorized reviewer
    // would be told they had lost access during a transient outage.
    assert.match(adapter, /status: "unavailable"/);
    assert.match(adapter, /status: "unauthorized"/);
    assert.match(adapter, /status: "unauthenticated"/);
  });

  test("3.7 is server-only and reads no receipt data", () => {
    assert.match(adapter, /^import "server-only";/m);
    for (const forbidden of ["receipt_submissions", "receipt_confirmations", "receipt"]) {
      assert.ok(
        !adapter.toLowerCase().includes(forbidden),
        `the adapter must not mention ${forbidden}`,
      );
    }
  });
});

/* ===========================================================================
 * 4. The route gate
 * ======================================================================== */
describe("4. route gate", () => {
  const layout = stripComments(read(LAYOUT));

  test("4.1 the layout resolves access through the Claim Reviewer adapter", () => {
    assert.match(layout, /getClaimReviewerAccess/);
  });

  test("4.2 it does not reuse the Vendor Admin or Retailer gate", () => {
    assert.ok(!layout.includes("getVendorSuperAdminAccess"));
    assert.ok(!layout.includes("getRetailerPortalAccess"));
  });

  test("4.3 unauthenticated redirects to /login", () => {
    assert.match(layout, /status === "unauthenticated"[\s\S]{0,120}redirect\("\/login"\)/);
  });

  test("4.4 unauthorized redirects to the REVIEWER denial route", () => {
    assert.match(
      layout,
      /status === "unauthorized"[\s\S]{0,160}redirect\("\/review-access-denied"\)/,
    );
    assert.ok(
      !layout.includes('redirect("/access-denied")'),
      "must not use the Vendor denial route, which speaks about Vendor permissions",
    );
  });

  test("4.5 unavailable does NOT redirect to a denial", () => {
    const unavailableBlock = layout.slice(layout.indexOf('status === "unavailable"'));
    const nextRedirect = unavailableBlock.indexOf("redirect(");
    const nextReturn = unavailableBlock.indexOf("return");
    assert.ok(
      nextReturn !== -1 && (nextRedirect === -1 || nextReturn < nextRedirect),
      "the unavailable branch must render, not redirect",
    );
  });

  test("4.6 the denial page lives OUTSIDE the (review) group, so it cannot loop", () => {
    // Its path has no "(review)" segment; if it did, the group layout would guard it
    // and every unauthorized visitor would bounce between the two forever.
    assert.ok(!DENIED.includes("(review)"));
    const denied = stripComments(read(DENIED));
    // And it self-corrects for an authorized reviewer rather than being a dead end.
    assert.match(denied, /status === "authorized"[\s\S]{0,120}redirect\("\/review"\)/);
  });

  test("4.7 the denial page's rendered copy never mentions Vendor Super Admin", () => {
    // Comments are stripped: the file's own header explains WHY it must not name
    // Vendor Super Admin, and that explanation must not trip the rule it describes.
    const denied = stripComments(read(DENIED));
    assert.ok(
      !denied.includes("Vendor Super Admin"),
      "rendered copy must not name a different product surface's role",
    );
  });
});

/* ===========================================================================
 * 5. The reviewer surface leaks nothing
 * ======================================================================== */
describe("5. reviewer surface containment", () => {
  const reviewFiles = [...listFiles("components/review"), LAYOUT, PAGE];

  test("5.1 no reviewer module imports the Vendor Admin navigation", () => {
    for (const file of reviewFiles) {
      // Comments are stripped for the same reason as 4.7: review-nav-items.tsx
      // documents this very rule and names the symbol while doing so.
      const source = stripComments(read(file));
      // The reviewer's own export is REVIEW_NAV_ITEMS, so a bare substring test would
      // match it. Only the Vendor Admin symbol and its module path are forbidden.
      const importsAdminNav =
        /(^|[^_A-Z])NAV_ITEMS\b/.test(source.replace(/REVIEW_NAV_ITEMS/g, "")) ||
        source.includes("components/admin/nav-items");

      assert.ok(
        !importsAdminNav,
        `${file} must not import the Vendor Admin navigation`,
      );
    }
  });

  test("5.2 no reviewer module links to a Vendor Admin or Retailer route", () => {
    for (const file of reviewFiles) {
      const source = stripComments(read(file));
      for (const route of [
        '"/retailers"',
        '"/users"',
        '"/roles"',
        '"/products"',
        '"/campaigns"',
        '"/audit-logs"',
        '"/claims"',
        '"/coins"',
        '"/payouts"',
        '"/retailer"',
      ]) {
        assert.ok(!source.includes(route), `${file} must not link to ${route}`);
      }
    }
  });

  test("5.3 the dashboard queries nothing at all", () => {
    const page = stripComments(read(PAGE));
    for (const forbidden of [
      "createClient",
      ".rpc(",
      ".from(",
      "supabase",
      "receipt_submissions",
      "receipt_confirmations",
      "receipt_extractions",
      "audit_logs",
    ]) {
      assert.ok(
        !page.includes(forbidden),
        `the empty dashboard must not reference ${forbidden}`,
      );
    }
  });

  test("5.4 the dashboard displays no count", () => {
    const page = stripComments(read(PAGE));
    // A receipt count is receipt data derived from a table this portal may not read.
    assert.ok(!/\bcount\b/i.test(page), "no count may appear on the empty dashboard");
    assert.ok(!/\b\d+\s+receipts?\b/i.test(page), "no receipt tally may appear");
  });

  test("5.5 the reviewer shell exposes only the disabled queue item", () => {
    const nav = read("components/review/review-nav-items.tsx");
    const labels = [...nav.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["Review queue"]);
    assert.match(nav, /disabled:\s*true/);
  });
});

/* ===========================================================================
 * 6. Landing order — additive, zero regression
 * ======================================================================== */
describe("6. landing decision", () => {
  const landing = stripComments(read(LANDING));
  const wiring = stripComments(read(LANDING_WIRING));

  test("6.1 /review is a fixed internal literal in LANDING_ROUTES", () => {
    assert.match(landing, /claimReviewer:\s*"\/review"/);
  });

  test("6.2 the reviewer parameter defaults to unauthorized", () => {
    // The default is what lets every pre-existing call site and test stand unmodified
    // as a regression proof.
    assert.match(
      landing,
      /reviewer:\s*ClaimReviewerAccessStatus\s*=\s*"unauthorized"/,
    );
  });

  test("6.3 the reviewer branch sits inside the previously-accessDenied path", () => {
    // Everything before it is untouched, so no existing role's landing can move.
    const vendorFirst = landing.indexOf('kind: "vendor"');
    const reviewerBranch = landing.indexOf('kind: "claimReviewer"');
    const accessDenied = landing.lastIndexOf("LANDING_ROUTES.accessDenied");
    assert.ok(vendorFirst < reviewerBranch, "vendor precedence comes first");
    assert.ok(reviewerBranch < accessDenied, "reviewer is checked before denying");
  });

  test("6.4 the reviewer probe runs only when no earlier read authorized", () => {
    assert.match(wiring, /if \(retailerStatus !== "unauthorized"\)/);
    const guard = wiring.indexOf('retailerStatus !== "unauthorized"');
    const probe = wiring.indexOf("getClaimReviewerAccess()");
    assert.ok(guard < probe, "the guard must precede the reviewer probe");
  });

  test("6.5 web routing does not use the Flutter portal-context RPC", () => {
    for (const source of [landing, wiring]) {
      assert.ok(
        !source.includes("get_my_portal_context"),
        "web routing must not consume the mobile portal contract",
      );
    }
  });
});

/* ===========================================================================
 * 7. THE FLUTTER CONTRACT — get_my_portal_context is untouched
 * ======================================================================== */
describe("7. Flutter portal-context compatibility", () => {
  test("7.1 no migration after the portal-context one redefines it", () => {
    // The Flutter parser rejects an unknown portal_kind and requires an exact
    // context_version, so ANY later redefinition is a potential mobile break and must
    // be a deliberate, separately reviewed act rather than a side effect of this branch.
    const later = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql") && f > "20260729090000_shared_portal_context.sql");

    const offenders = later.filter((f) => {
      const sql = stripSqlComments(read(join("supabase/migrations", f)));
      return /(create|create or replace|drop)\s+function\s+public\.get_my_portal_context/i.test(
        sql,
      );
    });

    assert.deepEqual(
      offenders,
      [],
      "no migration may redefine get_my_portal_context after its original",
    );
  });

  test("7.2 this milestone's migration does not mention it at all", () => {
    const migration = stripSqlComments(read(MIGRATION));
    assert.ok(!migration.includes("get_my_portal_context"));
    assert.ok(!migration.includes("context_version"));
    assert.ok(!migration.includes("portal_kind"));
  });

  test("7.3 nor does it touch the Vendor Admin context function", () => {
    const migration = stripSqlComments(read(MIGRATION));
    assert.ok(!migration.includes("get_vendor_super_admin_context"));
  });

  test("7.4 the original portal-context contract still declares five portal kinds", () => {
    // A guard on the source of truth itself: if someone adds CLAIM_REVIEWER to the
    // documented vocabulary, this fails and forces the Flutter question to be asked.
    const original = read(PORTAL_CONTEXT_MIGRATION);
    assert.ok(
      !/portal_kind[\s\S]{0,400}CLAIM_REVIEWER/.test(original),
      "CLAIM_REVIEWER must not appear in the portal_kind vocabulary",
    );
  });
});
