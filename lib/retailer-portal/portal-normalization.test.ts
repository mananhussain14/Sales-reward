/**
 * Unit tests for the pure Retailer Owner Portal normalization layer.
 *
 * Run with:  npm test
 *
 * Uses Node's BUILT-IN test runner (node:test) and assertion library
 * (node:assert). No testing package is installed — this repository had no test
 * framework before this milestone, and adding one was out of scope. Node 22
 * strips the TypeScript types at load time via --experimental-strip-types, so
 * these run directly against the source with no build step and no transform
 * config.
 *
 * Scope is deliberately the PURE layer only. The server module that calls the
 * RPCs cannot be unit-tested here: it imports `next/headers` transitively, which
 * throws outside a request scope. That module's behaviour is instead covered by
 * the database-level harness, which exercises the real authorization chain
 * against a real PostgreSQL instance — a far stronger check than a mocked
 * Supabase client would be.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeContextRow,
  normalizeContextResult,
  normalizeShopRow,
  normalizeShopsResult,
  buildShopKey,
} from "./portal-normalization.ts";

/** A complete, valid context row exactly as the RPC returns it. */
function validContextRow() {
  return {
    retailer_name: "Northwind Retail",
    retailer_status: "ACTIVE",
    country_code: "AE",
    default_currency: "AED",
    membership_status: "ACTIVE",
    total_shop_count: 3,
    active_shop_count: 1,
  };
}

/** A complete, valid shop row exactly as the RPC returns it. */
function validShopRow() {
  return {
    shop_name: "Downtown Branch",
    shop_code: "DT-01",
    city: "Dubai",
    country_code: "AE",
    shop_status: "ACTIVE",
  };
}

describe("normalizeContextRow", () => {
  test("maps a valid row to camelCase", () => {
    const result = normalizeContextRow(validContextRow());

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, {
      retailerName: "Northwind Retail",
      retailerStatus: "ACTIVE",
      countryCode: "AE",
      defaultCurrency: "AED",
      membershipStatus: "ACTIVE",
      totalShopCount: 3,
      activeShopCount: 1,
    });
  });

  test("accepts null country_code and default_currency (both nullable columns)", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      country_code: null,
      default_currency: null,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.countryCode, null);
    assert.equal(result.ok && result.value.defaultCurrency, null);
  });

  test("accepts zero counts — an empty estate is valid, not malformed", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      total_shop_count: 0,
      active_shop_count: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.totalShopCount, 0);
  });

  test("trims surrounding whitespace from text values", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      retailer_name: "  Northwind Retail  ",
    });

    assert.equal(result.ok && result.value.retailerName, "Northwind Retail");
  });

  // --- fail-closed: counts -------------------------------------------------

  test("rejects a negative count", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      total_shop_count: -1,
    });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /total_shop_count/);
  });

  test("rejects a non-integer count", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      total_shop_count: 2.5,
    });

    assert.equal(result.ok, false);
  });

  test("rejects NaN — typeof NaN is 'number', so a bare typeof check would admit it", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      active_shop_count: Number.NaN,
    });

    assert.equal(result.ok, false);
  });

  test("rejects Infinity", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      total_shop_count: Number.POSITIVE_INFINITY,
    });

    assert.equal(result.ok, false);
  });

  test("rejects a numeric string rather than coercing it", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      total_shop_count: "3",
    });

    assert.equal(result.ok, false);
  });

  test("rejects active_shop_count exceeding total_shop_count", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      total_shop_count: 1,
      active_shop_count: 5,
    });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /exceeded/);
  });

  // --- fail-closed: required text -----------------------------------------

  test("rejects a missing retailer_name", () => {
    const row: Record<string, unknown> = validContextRow();
    delete row.retailer_name;

    const result = normalizeContextRow(row);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /retailer_name/);
  });

  test("rejects a whitespace-only retailer_name", () => {
    const result = normalizeContextRow({
      ...validContextRow(),
      retailer_name: "   ",
    });

    assert.equal(result.ok, false);
  });

  test("rejects a missing membership_status", () => {
    const row: Record<string, unknown> = validContextRow();
    delete row.membership_status;

    assert.equal(normalizeContextRow(row).ok, false);
  });

  test("rejects a present-but-empty nullable column", () => {
    // "" is not absence — it would render a blank cell that looks like data.
    const result = normalizeContextRow({
      ...validContextRow(),
      country_code: "",
    });

    assert.equal(result.ok, false);
  });

  test("rejects a non-object row", () => {
    assert.equal(normalizeContextRow(null).ok, false);
    assert.equal(normalizeContextRow("row").ok, false);
    assert.equal(normalizeContextRow([]).ok, false);
  });
});

describe("normalizeContextResult", () => {
  test("one row resolves to ok", () => {
    const result = normalizeContextResult([validContextRow()]);

    assert.equal(result.status, "ok");
    assert.equal(
      result.status === "ok" ? result.context.retailerName : null,
      "Northwind Retail",
    );
  });

  test("zero rows is no-context, NOT malformed — this is the ordinary denial", () => {
    assert.equal(normalizeContextResult([]).status, "no-context");
  });

  test("two rows fails closed rather than picking the first", () => {
    // The SQL guarantees at most one row, so this should be unreachable. If it
    // ever happens, choosing rows[0] would show one Retailer's data to an owner
    // who qualifies for two — exactly what the ambiguity rule prevents.
    const result = normalizeContextResult([
      validContextRow(),
      { ...validContextRow(), retailer_name: "Second Retailer" },
    ]);

    assert.equal(result.status, "malformed");
  });

  test("a non-array result is malformed", () => {
    assert.equal(normalizeContextResult(null).status, "malformed");
    assert.equal(normalizeContextResult({}).status, "malformed");
  });

  test("one malformed row is malformed, not no-context", () => {
    // The distinction matters: no-context redirects to access-denied, malformed
    // renders a retry-safe error. Confusing a schema fault for a denial would
    // tell an authorized owner they lack permission.
    const result = normalizeContextResult([
      { ...validContextRow(), total_shop_count: -5 },
    ]);

    assert.equal(result.status, "malformed");
  });
});

describe("normalizeShopRow", () => {
  test("maps a valid row to camelCase", () => {
    const result = normalizeShopRow(validShopRow());

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, {
      shopName: "Downtown Branch",
      shopCode: "DT-01",
      city: "Dubai",
      countryCode: "AE",
      shopStatus: "ACTIVE",
    });
  });

  test("accepts null shop_code, city, and country_code (all nullable columns)", () => {
    const result = normalizeShopRow({
      ...validShopRow(),
      shop_code: null,
      city: null,
      country_code: null,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.shopCode, null);
    assert.equal(result.ok && result.value.city, null);
    assert.equal(result.ok && result.value.countryCode, null);
  });

  test("accepts every allowed lifecycle status", () => {
    for (const status of ["ACTIVE", "SUSPENDED", "DEACTIVATED"]) {
      const result = normalizeShopRow({ ...validShopRow(), shop_status: status });
      assert.equal(result.ok, true, `expected ${status} to be accepted`);
    }
  });

  test("rejects a missing shop_name", () => {
    const row: Record<string, unknown> = validShopRow();
    delete row.shop_name;

    const result = normalizeShopRow(row);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /shop_name/);
  });

  test("rejects a missing shop_status", () => {
    const row: Record<string, unknown> = validShopRow();
    delete row.shop_status;

    assert.equal(normalizeShopRow(row).ok, false);
  });

  test("rejects a non-object row", () => {
    assert.equal(normalizeShopRow(undefined).ok, false);
    assert.equal(normalizeShopRow(42).ok, false);
  });
});

describe("normalizeShopsResult", () => {
  test("maps a list of valid rows in the order received", () => {
    const result = normalizeShopsResult([
      { ...validShopRow(), shop_name: "Alpha" },
      { ...validShopRow(), shop_name: "Beta" },
    ]);

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.status === "ok" ? result.shops.map((s) => s.shopName) : null,
      ["Alpha", "Beta"],
    );
  });

  test("an empty array is a successful empty list, not a failure", () => {
    // "No shops" must never be presented as "not allowed".
    const result = normalizeShopsResult([]);

    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" ? result.shops : null, []);
  });

  test("one malformed row rejects the WHOLE list rather than being skipped", () => {
    // Skipping it would silently show an incomplete estate, and the omission
    // would be invisible to the person who most needs it complete.
    const result = normalizeShopsResult([
      validShopRow(),
      { ...validShopRow(), shop_name: "" },
      validShopRow(),
    ]);

    assert.equal(result.status, "malformed");
  });

  test("names the failing row's INDEX, never its contents", () => {
    const result = normalizeShopsResult([
      validShopRow(),
      { ...validShopRow(), shop_name: "", city: "SensitiveCityValue" },
    ]);

    assert.equal(result.status, "malformed");
    const reason = result.status === "malformed" ? result.reason : "";
    assert.match(reason, /index 1/);
    // A reason string reaches server logs; it must never carry row data.
    assert.doesNotMatch(reason, /SensitiveCityValue/);
  });

  test("a non-array result is malformed", () => {
    assert.equal(normalizeShopsResult(null).status, "malformed");
    assert.equal(normalizeShopsResult({ rows: [] }).status, "malformed");
  });
});

describe("reason strings never expose raw database errors", () => {
  test("no reason string contains SQL, schema, or connection detail", () => {
    // Every rejection path's reason is operator-facing and must name only the
    // FIELD at fault. These are the strings that reach server logs; the browser
    // sees a fixed generic message instead.
    const forbidden =
      /(select |from public\.|pg_|postgres|supabase|jwt|token|password|relation |permission denied|policy)/i;

    const reasons: string[] = [];

    const contextFailures = [
      { ...validContextRow(), total_shop_count: -1 },
      { ...validContextRow(), retailer_name: "" },
      { ...validContextRow(), country_code: "" },
      null,
    ];

    for (const row of contextFailures) {
      const r = normalizeContextRow(row);
      if (!r.ok) reasons.push(r.reason);
    }

    const shopResult = normalizeShopsResult([{ ...validShopRow(), shop_name: "" }]);
    if (shopResult.status === "malformed") reasons.push(shopResult.reason);

    const multiRow = normalizeContextResult([validContextRow(), validContextRow()]);
    if (multiRow.status === "malformed") reasons.push(multiRow.reason);

    assert.ok(reasons.length > 0, "expected some failure reasons to inspect");

    for (const reason of reasons) {
      assert.doesNotMatch(reason, forbidden, `reason leaked detail: ${reason}`);
    }
  });
});

describe("buildShopKey", () => {
  test("combines shop code and index", () => {
    assert.equal(
      buildShopKey(
        {
          shopName: "A",
          shopCode: "DT-01",
          city: null,
          countryCode: null,
          shopStatus: "ACTIVE",
        },
        0,
      ),
      "DT-01-0",
    );
  });

  test("handles a null shop code", () => {
    assert.equal(
      buildShopKey(
        {
          shopName: "A",
          shopCode: null,
          city: null,
          countryCode: null,
          shopStatus: "ACTIVE",
        },
        2,
      ),
      "no-code-2",
    );
  });

  test("produces distinct keys for duplicate codes — code is NOT unique in the schema", () => {
    const shop = {
      shopName: "A",
      shopCode: "DUP",
      city: null,
      countryCode: null,
      shopStatus: "ACTIVE",
    };

    assert.notEqual(buildShopKey(shop, 0), buildShopKey(shop, 1));
  });
});
