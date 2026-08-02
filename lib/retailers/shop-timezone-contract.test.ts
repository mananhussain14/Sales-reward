/**
 * CONTRACT AND SOURCE-LEVEL SAFETY GUARDS for shop time-zone management.
 *
 * Run with:  npm test
 *
 * Two kinds of assertion live here:
 *
 *   1. BEHAVIOUR of the browser-safe shape validator, which must agree exactly with the
 *      database CHECK it mirrors.
 *   2. SOURCE-LEVEL properties no unit test can observe at runtime but that a careless
 *      later edit could quietly break — the permission's single role mapping, the RPC's
 *      argument surface, the absence of any timezone GUESS, and the absence of a
 *      service-role or direct-table write path.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression, naming the file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { hasIanaTimeZoneShape } from "../reference/iana-timezone-shape.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MIGRATION = "supabase/migrations/20260818090000_shop_timezone_management.sql";
const ACTION = "app/(admin)/retailers/[relationshipId]/shops/timezone-actions.ts";
const CONTROL = "app/(admin)/retailers/[relationshipId]/shops/shop-timezone-control.tsx";
const STATE = "app/(admin)/retailers/[relationshipId]/shops/timezone-state.ts";
const READ_MODEL = "lib/retailers/vendor-retailer-detail.ts";

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Strips SQL comments, for the same reason. */
function stripSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, "");
}

/* ===========================================================================
 * 1. The shape validator agrees with the database CHECK
 * ======================================================================== */
describe("1. IANA time-zone shape validation", () => {
  test("1.1 accepts the region/city identifiers the database accepts", () => {
    for (const zone of [
      "Asia/Dubai",
      "Asia/Kuwait",
      "Europe/London",
      "Europe/Paris",
      "America/New_York",
      "America/Argentina/Buenos_Aires",
      "America/Port-au-Prince",
      "Australia/Lord_Howe",
      "Pacific/Port_Moresby",
    ]) {
      assert.equal(hasIanaTimeZoneShape(zone), true, `${zone} should be accepted`);
    }
  });

  test("1.2 refuses fixed offsets, which cannot follow a place's DST rules", () => {
    for (const zone of ["UTC+3", "GMT+3", "+04:00", "-0500", "UTC", "GMT", "EST", "PST"]) {
      assert.equal(hasIanaTimeZoneShape(zone), false, `${zone} should be refused`);
    }
  });

  test("1.3 refuses every Etc/ entry — real IANA names, but still fixed offsets", () => {
    for (const zone of ["Etc/GMT+3", "Etc/GMT-3", "Etc/UTC", "Etc/Greenwich"]) {
      assert.equal(hasIanaTimeZoneShape(zone), false, `${zone} should be refused`);
    }
  });

  test("1.4 refuses malformed values", () => {
    for (const zone of ["", "  ", "Europe/", "/London", "Asia//Dubai", "Asia", "a"]) {
      assert.equal(hasIanaTimeZoneShape(zone), false, `${JSON.stringify(zone)} should be refused`);
    }
  });

  test("1.5 refuses an untrimmed value rather than silently trimming it", () => {
    // The database CHECK asserts `timezone_name = btrim(timezone_name)`, so trimming here
    // would let the form accept a value it then sends unchanged and the database refuses.
    assert.equal(hasIanaTimeZoneShape(" Asia/Dubai"), false);
    assert.equal(hasIanaTimeZoneShape("Asia/Dubai "), false);
    assert.equal(hasIanaTimeZoneShape(" Asia/Dubai "), false);
  });

  test("1.6 refuses a value longer than the column's 64-character bound", () => {
    assert.equal(hasIanaTimeZoneShape("Region/" + "x".repeat(64)), false);
  });

  test("1.7 is a pure function — no network, no environment, no Intl lookup", () => {
    const source = stripComments(read("lib/reference/iana-timezone-shape.ts"));
    for (const forbidden of ["fetch(", "process.env", "Intl.", "require(", "import "]) {
      assert.ok(
        !source.includes(forbidden),
        `the shape module must not reference ${forbidden}`,
      );
    }
  });
});

/* ===========================================================================
 * 2. The permission is mapped to exactly one role
 * ======================================================================== */
describe("2. permission vocabulary and role closure", () => {
  const migration = stripSqlComments(read(MIGRATION));

  test("2.1 the migration seeds SHOP_TIMEZONE_MANAGE under the RETAILERS module", () => {
    assert.match(migration, /'SHOP_TIMEZONE_MANAGE'/);
    assert.match(migration, /'RETAILERS'/);
  });

  test("2.2 exactly one role code appears in the whole migration", () => {
    // The role-permission mapping is the ONLY place a role may be named, and it must name
    // VENDOR_SUPER_ADMIN. Any other role code anywhere in this file would be a second
    // grantee or a role-based authorization check, and both are regressions.
    const roleCodes = [
      "VENDOR_SUPER_ADMIN",
      "CLAIM_REVIEWER",
      "FINANCE_ADMIN",
      "RETAILER_OWNER",
      "RETAILER_MANAGER",
      "SALES_STAFF",
    ].filter((code) => migration.includes(`'${code}'`));

    assert.deepEqual(
      roleCodes,
      ["VENDOR_SUPER_ADMIN"],
      "only VENDOR_SUPER_ADMIN may be named in the shop-timezone migration",
    );
  });

  test("2.3 authorization is by PERMISSION, never by comparing a role code", () => {
    assert.match(migration, /has_organization_permission\([^)]*'SHOP_TIMEZONE_MANAGE'\)/);
  });

  test("2.4 the migration creates no table, policy, or table grant", () => {
    assert.ok(!/create\s+table/i.test(migration), "no table may be created");
    assert.ok(!/create\s+policy/i.test(migration), "no RLS policy may be added");
    assert.ok(
      !/grant\s+(select|insert|update|delete|all)\s+on\s+table/i.test(migration),
      "no table privilege may be granted",
    );
  });

  test("2.5 the function is SECURITY DEFINER with an empty search_path", () => {
    assert.match(migration, /security definer/);
    assert.match(migration, /set search_path = ''/);
  });

  test("2.6 EXECUTE is granted to authenticated and to nobody else", () => {
    assert.match(migration, /grant\s+execute\s+on\s+function\s+public\.set_retailer_shop_timezone\(uuid,\s*text\)\s+to\s+authenticated/);
    assert.ok(
      !/grant\s+execute[^\n]*to\s+(anon|service_role)/.test(migration),
      "neither anon nor service_role may be granted EXECUTE",
    );
  });
});

/* ===========================================================================
 * 3. RPC argument safety — no client-supplied tenant or authorization
 * ======================================================================== */
describe("3. RPC argument safety", () => {
  const migration = stripSqlComments(read(MIGRATION));
  const action = stripComments(read(ACTION));
  const control = stripComments(read(CONTROL));

  test("3.1 the RPC takes exactly two parameters", () => {
    const signature = migration.match(
      /create function public\.set_retailer_shop_timezone\(([\s\S]*?)\)\s*returns/,
    );
    assert.ok(signature, "the function signature must be found");
    const params = signature[1]
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
    assert.deepEqual(params, ["p_retailer_shop_id", "p_timezone_name"]);
  });

  test("3.2 no tenant, actor, role or offset parameter exists", () => {
    for (const forbidden of [
      "p_vendor_organization_id",
      "p_retailer_organization_id",
      "p_relationship_id",
      "p_actor_profile_id",
      "p_profile_id",
      "p_role_code",
      "p_permission_code",
      "p_utc_offset",
      "p_offset",
    ]) {
      assert.ok(
        !migration.includes(forbidden),
        `the RPC must not accept ${forbidden} — a caller-controlled tenant id is how a cross-tenant write happens`,
      );
    }
  });

  test("3.3 the action sends only the shop id and the zone", () => {
    const rpcCall = action.match(/\.rpc\("set_retailer_shop_timezone",\s*\{([\s\S]*?)\}\)/);
    assert.ok(rpcCall, "the RPC call must be found");
    const keys = [...rpcCall[1].matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ["p_retailer_shop_id", "p_timezone_name"]);
  });

  test("3.4 the form posts only the two addresses and the zone", () => {
    const hidden = [...control.matchAll(/name="(\w+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      hidden,
      ["relationshipId", "shopId", "timezoneName"],
      "the form must carry no other field",
    );
  });

  test("3.5 the action uses the authenticated client, never the service role", () => {
    assert.match(action, /@\/lib\/supabase\/server/);
    for (const forbidden of ["SERVICE_ROLE", "service_role", "serviceRole", "createServiceClient"]) {
      assert.ok(!action.includes(forbidden), `the action must not reference ${forbidden}`);
    }
  });

  test("3.6 the action performs no direct table write", () => {
    for (const forbidden of [".update(", ".insert(", ".upsert(", ".delete("]) {
      assert.ok(
        !action.includes(forbidden),
        `the action must not call ${forbidden} — the RPC is the only audited door`,
      );
    }
  });
});

/* ===========================================================================
 * 4. No timezone is ever guessed
 * ======================================================================== */
describe("4. no inference of a time zone", () => {
  const control = stripComments(read(CONTROL));
  const action = stripComments(read(ACTION));

  test("4.1 the control never reads a browser or device time zone", () => {
    for (const forbidden of [
      "Intl.DateTimeFormat",
      "resolvedOptions",
      "getTimezoneOffset",
      "navigator.",
    ]) {
      assert.ok(
        !control.includes(forbidden),
        `the control must not use ${forbidden} — a prefilled guess would be adopted silently`,
      );
    }
  });

  test("4.2 neither the control nor the action infers a zone from country or city", () => {
    for (const source of [control, action]) {
      assert.ok(!/countryCode\s*(\?\?|\|\|)/.test(source), "no country-based fallback");
      assert.ok(!/city\s*(\?\?|\|\|)/.test(source), "no city-based fallback");
      assert.ok(!source.includes("iso-country-codes"), "no country list is consulted");
    }
  });

  test("4.3 the input defaults to the STORED value or to empty, never to a default zone", () => {
    // The only permitted seed is `storedTimezone ?? ""`.
    assert.match(control, /defaultValue=\{storedTimezone \?\? ""\}/);
    assert.ok(
      !/defaultValue=\{["']\w+\/\w+["']\}/.test(control),
      "the input must not be seeded with a hard-coded zone",
    );
  });

  test("4.4 no zone literal is used as a VALUE or a fallback", () => {
    // A zone name may legitimately appear as UI copy — the `placeholder` prop and the
    // hint both show "Asia/Dubai" as an example, which is exactly how an operator learns
    // the expected form. What must never appear is a zone in a position that would make
    // it the value actually submitted: a `??`/`||` fallback, a state seed, or an
    // assignment. Those are the shapes that would turn an example into a silent default.
    const valuePositions =
      /(\?\?|\|\|)\s*["'][A-Za-z]+\/[A-Za-z_]+["']|useState\(\s*["'][A-Za-z]+\/[A-Za-z_]+["']|=\s*["'][A-Za-z]+\/[A-Za-z_]+["']\s*;/;

    for (const [name, source] of [
      ["control", control],
      ["action", action],
    ] as const) {
      assert.ok(
        !valuePositions.test(source),
        `${name}: a time zone literal must not be used as a value or fallback`,
      );
    }

    // And specifically: no UTC fallback anywhere, in any position. UTC is never a
    // defensible default for a shop, which is why the database refuses it outright.
    for (const [name, source] of [
      ["control", control],
      ["action", action],
    ] as const) {
      assert.ok(
        !/(\?\?|\|\|)\s*["']UTC["']/.test(source),
        `${name}: there must be no UTC fallback`,
      );
    }
  });
});

/* ===========================================================================
 * 5. Safe error mapping
 * ======================================================================== */
describe("5. error mapping", () => {
  const action = stripComments(read(ACTION));
  const state = stripComments(read(STATE));

  test("5.1 only the check-violation SQLSTATE is mapped to a field", () => {
    assert.match(action, /const CHECK_VIOLATION = "23514"/);
    // 42501 must NOT be distinguished: an unauthorized caller, a foreign shop and an
    // unknown shop must all collapse into the one generic message.
    assert.ok(
      !action.includes('"42501"'),
      "42501 must not be special-cased — that would reintroduce an existence oracle",
    );
  });

  test("5.2 the raw database error is never forwarded", () => {
    for (const forbidden of ["error.message", "error.details", "error.hint", "String(error)"]) {
      assert.ok(!action.includes(forbidden), `the action must not surface ${forbidden}`);
    }
  });

  test("5.3 the browser-visible state carries no identifier or database detail", () => {
    for (const forbidden of [
      "organizationId",
      "organization_id",
      "profileId",
      "actorId",
      "roleCode",
      "permissionCode",
      "sqlstate",
      "sqlState",
      "utcOffset",
    ]) {
      assert.ok(!state.includes(forbidden), `the state must not carry ${forbidden}`);
    }
  });

  test("5.4 a no-op is reported distinctly from a save", () => {
    assert.match(state, /unchanged: boolean/);
    assert.match(action, /unchanged: !data\.changed/);
  });

  test("5.5 the confirmation shows the STORED value, not the submitted string", () => {
    assert.match(action, /savedTimezoneName: data\.timezone_name/);
  });
});

/* ===========================================================================
 * 6. The read model
 * ======================================================================== */
describe("6. shop read model", () => {
  const readModel = stripComments(read(READ_MODEL));

  test("6.1 the shop payload exposes the zone and whether it is unresolved", () => {
    assert.match(readModel, /timezoneName: string \| null/);
    assert.match(readModel, /timezone_name: string \| null/);
    assert.match(readModel, /timezoneName: shop\.timezone_name/);
  });

  test("6.2 the select reads the two new columns and no others", () => {
    assert.match(
      readModel,
      /\.select\("id, name, code, city, country_code, status, timezone_name"\)/,
    );
  });

  test("6.3 the shop id is exposed — the one id, needed as an address", () => {
    assert.match(readModel, /shopId: string/);
    assert.match(readModel, /shopId: shop\.id/);
  });

  test("6.4 no organization or membership id was added to the payload", () => {
    const payload = readModel.match(
      /export type VendorRetailerDetail = \{([\s\S]*?)\n\};/,
    );
    assert.ok(payload, "the payload type must be found");
    for (const forbidden of ["organizationId", "retailerOrganizationId", "vendorOrganizationId", "memberId"]) {
      assert.ok(
        !payload[1].includes(forbidden),
        `the detail payload must not carry ${forbidden}`,
      );
    }
  });
});

/* ===========================================================================
 * 7. The control is not reachable from the Retailer or reviewer surfaces
 * ======================================================================== */
describe("7. surface containment", () => {
  test("7.1 only the Vendor Admin retailer detail page renders the control", () => {
    const importers: string[] = [];
    for (const candidate of [
      "app/(admin)/retailers/[relationshipId]/page.tsx",
      "app/(retailer)/retailer/shops/page.tsx",
      "app/(retailer)/retailer/page.tsx",
      "app/(retailer)/retailer/receipts/page.tsx",
    ]) {
      if (read(candidate).includes("shop-timezone-control")) importers.push(candidate);
    }
    assert.deepEqual(
      importers,
      ["app/(admin)/retailers/[relationshipId]/page.tsx"],
      "the timezone control must appear on the Vendor Admin detail page and nowhere else",
    );
  });

  test("7.2 no Retailer-portal module imports the setter action", () => {
    for (const candidate of [
      "app/(retailer)/retailer/shops/page.tsx",
      "app/(retailer)/retailer/page.tsx",
    ]) {
      assert.ok(
        !read(candidate).includes("timezone-actions"),
        `${candidate} must not import the timezone action`,
      );
    }
  });

  test("7.3 the client component imports no server-only module", () => {
    const control = stripComments(read(CONTROL));
    for (const forbidden of [
      "@/lib/supabase/server",
      "@/lib/auth/vendor-admin-access",
      "@/lib/retailers/vendor-retailer-detail",
    ]) {
      assert.ok(
        !control.includes(forbidden),
        `a Client Component must not import ${forbidden}`,
      );
    }
  });
});

/* ===========================================================================
 * 8. Scope — Phase 1A introduces no later-phase vocabulary
 * ======================================================================== */
describe("8. milestone scope", () => {
  test("8.1 no verification, matching, reward or coin vocabulary was introduced", () => {
    const sources = [MIGRATION, ACTION, CONTROL, STATE].map((f) =>
      f.endsWith(".sql") ? stripSqlComments(read(f)) : stripComments(read(f)),
    );
    for (const source of sources) {
      for (const forbidden of [
        "receipt_verification",
        "verified_sale",
        "campaign_contribution",
        "campaign_award",
        "coin_ledger",
        "claim_reviewer",
        "CLAIM_REVIEWER",
        "RECEIPT_VERIFY",
      ]) {
        assert.ok(
          !source.includes(forbidden),
          `Phase 1A must not introduce ${forbidden}`,
        );
      }
    }
  });
});
