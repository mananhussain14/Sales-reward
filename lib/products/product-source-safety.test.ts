/**
 * SOURCE-LEVEL SAFETY GUARDS for the Vendor product catalog feature.
 *
 * Run with:  npm test
 *
 * These read this milestone's own source files and assert properties that no unit test
 * can observe at runtime but that a careless later edit could quietly break:
 *
 *   1. NO DIRECT PROTECTED-TABLE ACCESS — every read and write goes through an RPC,
 *      and the RPC surface is exactly the eight the migration created.
 *   2. NO SERVICE-ROLE CLIENT ANYWHERE — this feature has no privileged path at all.
 *   3. NO SERVER-ONLY MODULE IN A CLIENT COMPONENT, and no tenant id in browser code.
 *   4. NOTHING IS LOGGED BUT A SANITIZED CATEGORY.
 *   5. THE RETAILER SURFACE IS READ-ONLY — no write action is reachable from it.
 *   6. NO OUT-OF-SCOPE VOCABULARY (OCR, receipt matching, campaigns, incentives,
 *      rewards, coins, payouts) was introduced.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The repository root, derived from this file's own location (lib/products/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const VENDOR_DIRS = ["lib/products", "app/(admin)/products"];
const RETAILER_DIR = "app/(retailer)/retailer/products";

type SourceFile = { path: string; source: string };

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(join(dir, entry)));
    else if (/\.tsx?$/.test(entry)) out.push(join(dir, entry));
  }
  return out;
}

function load(dirs: string[]): SourceFile[] {
  return dirs
    .flatMap((dir) => listFiles(dir))
    .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
    .map((path) => ({ path, source: readFileSync(join(ROOT, path), "utf8") }));
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const PRODUCT_FILES = load([...VENDOR_DIRS, RETAILER_DIR]);
const RETAILER_FILES = PRODUCT_FILES.filter((file) => file.path.startsWith(RETAILER_DIR));
const CLIENT_FILES = PRODUCT_FILES.filter((file) =>
  /^\s*["']use client["']/m.test(file.source),
);

function codeLines(file: SourceFile): { number: number; text: string }[] {
  return stripComments(file.source)
    .split("\n")
    .map((text, index) => ({ number: index + 1, text }))
    .filter((line) => line.text.trim().length > 0);
}

/** The complete RPC surface this feature may call — the eight the migration created. */
const ALLOWED_RPCS = [
  "list_vendor_products",
  "create_vendor_product",
  "update_vendor_product",
  "set_vendor_product_status",
  "list_vendor_product_retailer_assignments",
  "assign_vendor_product_to_retailer",
  "unassign_vendor_product_from_retailer",
  "list_retailer_assigned_products",
];

describe("the milestone's own files were found", () => {
  test("1. every product directory contributes source files", () => {
    assert.ok(PRODUCT_FILES.length >= 8, `only found ${PRODUCT_FILES.length}`);
    for (const dir of [...VENDOR_DIRS, RETAILER_DIR]) {
      assert.ok(PRODUCT_FILES.some((f) => f.path.startsWith(dir)), `no source under ${dir}`);
    }
  });

  test("2. at least one Client Component and one Retailer file were identified", () => {
    assert.ok(CLIENT_FILES.length >= 1, "client rules would pass vacuously");
    assert.ok(RETAILER_FILES.length >= 1, "retailer rules would pass vacuously");
  });
});

describe("no direct protected-table access; RPCs only", () => {
  test('3. no product module contains a `.from("table")` call', () => {
    for (const file of PRODUCT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\.from\s*\(\s*["'`]/.test(line.text),
          `${file.path}:${line.number} direct table access: ${line.text.trim()}`,
        );
      }
    }
  });

  test("4. no product module writes raw SQL", () => {
    for (const file of PRODUCT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(line.text),
          `${file.path}:${line.number} raw SQL: ${line.text.trim()}`,
        );
      }
    }
  });

  test("5. every RPC name used is one of the eight this milestone created", () => {
    const used = new Set<string>();
    for (const file of PRODUCT_FILES) {
      for (const match of stripComments(file.source).matchAll(/"([a-z_]+)"\s+as\s+const/g)) {
        used.add(match[1]);
      }
    }
    assert.ok(used.size >= 8, `only ${used.size} RPC constants found`);
    for (const name of used) {
      assert.ok(ALLOWED_RPCS.includes(name), `unexpected RPC constant: ${name}`);
    }
  });

  test("6. the write path calls RPCs and nothing else", () => {
    const writers = PRODUCT_FILES.filter((f) => f.path === "lib/products/vendor-products.ts");
    assert.equal(writers.length, 1);
    assert.ok(/\.rpc\s*\(/.test(writers[0].source), "the write module must call RPCs");
  });
});

describe("this feature has no privileged path at all", () => {
  test("7. no product module imports or constructs the service-role client", () => {
    for (const file of PRODUCT_FILES) {
      const code = stripComments(file.source);
      assert.ok(!/createAdminClient/.test(code), `${file.path} constructs a service-role client`);
      assert.ok(
        !code.includes('from "@/lib/supabase/admin"'),
        `${file.path} imports the service-role client`,
      );
      assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(code), `${file.path} reads the key`);
    }
  });

  test("8. no product module touches Storage or introduces a NEXT_PUBLIC_ variable", () => {
    for (const file of PRODUCT_FILES) {
      const code = stripComments(file.source);
      assert.ok(!/\.storage\b/.test(code), `${file.path} touches Storage`);
      assert.ok(!/NEXT_PUBLIC_/.test(code), `${file.path} adds a NEXT_PUBLIC_ variable`);
    }
  });
});

describe("client components stay client-safe", () => {
  const FORBIDDEN_IN_CLIENT = [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/products/vendor-products",
    "@/lib/products/retailer-products",
    "@/lib/auth/vendor-admin-access",
    "next/headers",
    "node:crypto",
  ];

  test("9. no Client Component imports a server-only module", () => {
    for (const file of CLIENT_FILES) {
      for (const forbidden of FORBIDDEN_IN_CLIENT) {
        assert.ok(
          !file.source.includes(`from "${forbidden}"`),
          `${file.path} imports ${forbidden} into browser code`,
        );
      }
    }
  });

  test("10. no Client Component reads process.env", () => {
    for (const file of CLIENT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(!/process\.env/.test(line.text), `${file.path}:${line.number} reads env`);
      }
    }
  });

  test("11. no Client Component handles a Vendor, creator or membership identifier", () => {
    for (const file of CLIENT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\b(vendorOrganizationId|vendor_organization_id|createdByProfileId|created_by_profile_id|organizationId|membershipId)\b/.test(
            line.text,
          ),
          `${file.path}:${line.number} handles forbidden material: ${line.text.trim()}`,
        );
      }
    }
  });

  test("12. hidden form fields are limited to the three permitted addresses", () => {
    // productId and retailerId are addresses the database re-checks against the Vendor
    // it derives; status is a closed literal set. Nothing else may ride in hidden.
    for (const file of CLIENT_FILES) {
      for (const match of file.source.match(/type="hidden"[\s\S]{0,120}?name="([a-zA-Z]+)"/g) ?? []) {
        const name = /name="([a-zA-Z]+)"/.exec(match)?.[1] ?? "";
        assert.ok(
          ["productId", "retailerId", "status"].includes(name),
          `${file.path} has an unexpected hidden field: ${name}`,
        );
      }
    }
  });
});

describe("nothing is logged but a sanitized category", () => {
  const SAFE_INTERPOLATIONS = new Set(["operation", "category"]);

  const consoleLines = PRODUCT_FILES.flatMap((file) =>
    codeLines(file)
      .filter((line) => /console\.(log|error|warn|info|debug)/.test(line.text))
      .map((line) => ({ file: file.path, ...line })),
  );

  test("13. logging is funnelled through one helper per data module", () => {
    assert.equal(
      consoleLines.length,
      2,
      `expected one chokepoint per data module, found ${consoleLines.length}`,
    );
    assert.deepEqual(
      consoleLines.map((line) => line.file).sort(),
      ["lib/products/retailer-products.ts", "lib/products/vendor-products.ts"],
    );
  });

  test("14. no log line interpolates anything but a sanitized category", () => {
    const FORBIDDEN =
      /\b(productId|product_id|productCode|productName|retailerId|error|err|result|response|data|session|claims)\b/;
    for (const line of consoleLines) {
      for (const match of line.text.matchAll(/\$\{([^}]*)\}/g)) {
        const expression = match[1].trim();
        assert.ok(
          SAFE_INTERPOLATIONS.has(expression),
          `${line.file}:${line.number} interpolates "${expression}"`,
        );
        assert.ok(!FORBIDDEN.test(expression), `${line.file}:${line.number} logs data`);
      }
    }
  });

  test("15. no console call is passed a bare identifier argument", () => {
    for (const line of consoleLines) {
      const call = /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(line.text);
      const firstArg = (call?.[1] ?? "").trim();
      assert.ok(
        firstArg.startsWith('"') || firstArg.startsWith("'") || firstArg.startsWith("`"),
        `${line.file}:${line.number} logs a non-literal`,
      );
    }
  });
});

describe("the Retailer surface is strictly read-only", () => {
  test("16. no Retailer product file imports a Server Action or a write module", () => {
    for (const file of RETAILER_FILES) {
      const code = stripComments(file.source);
      assert.ok(
        !code.includes('from "@/lib/products/vendor-products"'),
        `${file.path} imports the Vendor write module`,
      );
      assert.ok(!/\/products\/actions"/.test(code), `${file.path} imports a product action`);
      assert.ok(!/"use server"/.test(code), `${file.path} declares a Server Action`);
    }
  });

  test("17. no Retailer product file renders a form or a mutating control", () => {
    for (const file of RETAILER_FILES) {
      const code = stripComments(file.source);
      assert.ok(!/<form\b/.test(code), `${file.path} renders a form`);
      assert.ok(!/<button\b/.test(code), `${file.path} renders a button`);
      assert.ok(!/useActionState/.test(code), `${file.path} wires an action`);
    }
  });

  test("18. the Retailer read module calls exactly one RPC and no write RPC", () => {
    const file = PRODUCT_FILES.find((f) => f.path === "lib/products/retailer-products.ts");
    assert.ok(file, "the retailer read module must exist");
    const code = stripComments(file.source);
    for (const rpc of [
      "create_vendor_product",
      "update_vendor_product",
      "set_vendor_product_status",
      "assign_vendor_product_to_retailer",
      "unassign_vendor_product_from_retailer",
    ]) {
      assert.ok(!code.includes(rpc), `${file.path} references the write RPC ${rpc}`);
    }
    assert.ok(code.includes("list_retailer_assigned_products"));
  });
});

describe("nothing out of scope was introduced", () => {
  test("19. no OCR, receipt-matching, campaign, incentive, reward, coin or payout code", () => {
    // Comments are stripped first so the migrations' and modules' own "deliberately not
    // doing X" notes do not trip this.
    const OUT_OF_SCOPE =
      /\b(ocr|tesseract|textract|receiptMatch|matchReceipt|campaign|incentive|reward|coinBalance|payout|commission)\b/i;
    for (const file of PRODUCT_FILES) {
      for (const line of stripComments(file.source).split("\n")) {
        assert.ok(
          !OUT_OF_SCOPE.test(line),
          `${file.path} mentions out-of-scope work: ${line.trim()}`,
        );
      }
    }
  });

  test("20. no price or money field was added to the product model", () => {
    const MONEY = /\b(price|unitPrice|cost|currencyAmount|msrp|rrp)\b/i;
    for (const file of PRODUCT_FILES) {
      for (const line of stripComments(file.source).split("\n")) {
        assert.ok(!MONEY.test(line), `${file.path} adds a price field: ${line.trim()}`);
      }
    }
  });
});
