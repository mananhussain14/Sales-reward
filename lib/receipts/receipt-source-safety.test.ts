/**
 * SOURCE-LEVEL SAFETY GUARDS for the receipt submission feature.
 *
 * Run with:  npm test
 *
 * These read this milestone's own source files and assert properties that no unit test
 * can observe at runtime but that a careless later edit could quietly break:
 *
 *   1. NO DIRECT PROTECTED-TABLE ACCESS — every read and write goes through an RPC.
 *   2. NO STORAGE PATH, BUCKET, HASH OR ERROR OBJECT IN A LOG LINE.
 *   3. NO SERVICE-ROLE CLIENT, STORAGE CLIENT, OR SERVER-ONLY MODULE IN A CLIENT
 *      COMPONENT.
 *   4. THE SERVICE-ROLE CLIENT AND THE STORAGE API HAVE EXACTLY ONE CALLER HERE.
 *   5. NO OUT-OF-SCOPE VOCABULARY (OCR, approval, incentives, rewards, coins, payouts)
 *      was introduced.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression, naming the file and the line.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The repository root, derived from this file's own location (lib/receipts/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const RECEIPT_DIRS = ["lib/receipts", "app/(retailer)/retailer/receipts"];

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

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const RECEIPT_FILES: SourceFile[] = RECEIPT_DIRS.flatMap((dir) => listFiles(dir))
  .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
  .map((path) => ({ path, source: readFileSync(join(ROOT, path), "utf8") }));

const CLIENT_FILES = RECEIPT_FILES.filter((file) =>
  /^\s*["']use client["']/m.test(file.source),
);

function codeLines(file: SourceFile): { number: number; text: string }[] {
  return stripComments(file.source)
    .split("\n")
    .map((text, index) => ({ number: index + 1, text }))
    .filter((line) => line.text.trim().length > 0);
}

describe("the milestone's own files were found", () => {
  test("1. both receipt directories contribute source files", () => {
    assert.ok(RECEIPT_FILES.length >= 8, `only found ${RECEIPT_FILES.length}`);
    for (const dir of RECEIPT_DIRS) {
      assert.ok(
        RECEIPT_FILES.some((file) => file.path.startsWith(dir)),
        `no source under ${dir}`,
      );
    }
  });

  test("2. at least one Client Component was identified", () => {
    assert.ok(CLIENT_FILES.length >= 1, "client rules would pass vacuously");
  });
});

describe("no direct protected-table access", () => {
  test('3. no receipt module contains a `.from("table")` call', () => {
    // Supabase table access is always `.from("<table>")` — a STRING argument. Anchored
    // on the quote so `Array.from(...)` and `admin.storage.from(bucket)` (a variable)
    // are not false positives; the storage caller is asserted separately below.
    for (const file of RECEIPT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\.from\s*\(\s*["'`]/.test(line.text),
          `${file.path}:${line.number} direct table access: ${line.text.trim()}`,
        );
      }
    }
  });

  test("4. no receipt module writes raw SQL", () => {
    for (const file of RECEIPT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(line.text),
          `${file.path}:${line.number} raw SQL: ${line.text.trim()}`,
        );
      }
    }
  });
});

describe("no path, bucket, hash or error detail is ever logged", () => {
  const SAFE_INTERPOLATIONS = new Set(["operation", "category"]);

  function interpolationsOn(text: string): string[] {
    return [...text.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1].trim());
  }

  const consoleLines = RECEIPT_FILES.flatMap((file) =>
    codeLines(file)
      .filter((line) => /console\.(log|error|warn|info|debug)/.test(line.text))
      .map((line) => ({ file: file.path, ...line })),
  );

  test("5. logging is funnelled through exactly one helper per I/O module", () => {
    // Every module that talks to the database, to Storage or to an Edge Function owns a
    // single `log…Failure` helper and every call site goes through it, so there is exactly
    // one `console` line per such module and none anywhere else. Asserting the count keeps
    // the rules below non-vacuous AND locks the chokepoint: a new direct console call
    // anywhere in the feature fails here before the content rules even run.
    //
    // THE THIRD ENTRY is the extraction request module, added when the web application
    // began initiating a reading. It performs one outbound call and reports it under the
    // same discipline as the other two: a fixed category, never a body, a token or an id.
    //
    // THE FOURTH is the extraction POLL module, added when the web began following a
    // reading to its conclusion. It is called repeatedly — once every three seconds while
    // an attempt is open — which makes the discipline matter more here than anywhere else
    // in the feature: a log line carrying an id or a body would be written forty times per
    // receipt. It reports a fixed category and nothing else.
    //
    // THE FIFTH is the line-item reader, added when the web began displaying what was read.
    // It is the one module here that handles the extracted VALUES themselves, so its log
    // discipline is what stops a customer's purchase appearing in an operator log: it reports
    // a fixed category, and for a malformed payload a FIELD NAME — never a field value.
    const IO_MODULES = [
      "lib/receipts/receipt-data.ts",
      "lib/receipts/receipt-extraction-line-items.ts",
      "lib/receipts/receipt-extraction-poll-request.ts",
      "lib/receipts/receipt-extraction-request.ts",
      "lib/receipts/receipt-submissions.ts",
    ];

    assert.equal(
      consoleLines.length,
      IO_MODULES.length,
      `expected one logging chokepoint in each I/O module, found ${consoleLines.length}: ${consoleLines
        .map((line) => `${line.file}:${line.number}`)
        .join(", ")}`,
    );
    assert.deepEqual(consoleLines.map((line) => line.file).sort(), IO_MODULES);
  });

  test("6. every logged value is a fixed literal or a sanitized category", () => {
    for (const line of consoleLines) {
      for (const expression of interpolationsOn(line.text)) {
        assert.ok(
          SAFE_INTERPOLATIONS.has(expression),
          `${line.file}:${line.number} interpolates "${expression}"`,
        );
      }
    }
  });

  test("7. no log line names a path, bucket, hash, id, or error binding", () => {
    const FORBIDDEN =
      /\b(objectPath|storage_object_path|bucket|storage_bucket|sha256|file_sha256|submissionId|submission_id|shopId|bytes|error|err|result|response|data|session|claims)\b/;
    for (const line of consoleLines) {
      for (const expression of interpolationsOn(line.text)) {
        assert.ok(
          !FORBIDDEN.test(expression),
          `${line.file}:${line.number} logs forbidden material: ${line.text.trim()}`,
        );
      }
    }
  });

  test("8. no console call is passed a bare identifier argument", () => {
    for (const line of consoleLines) {
      const call = /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(line.text);
      const firstArg = (call?.[1] ?? "").trim();
      assert.ok(
        firstArg.startsWith('"') || firstArg.startsWith("'") || firstArg.startsWith("`"),
        `${line.file}:${line.number} logs a non-literal: ${line.text.trim()}`,
      );
    }
  });
});

describe("client components stay client-safe", () => {
  const FORBIDDEN_IN_CLIENT = [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/receipts/receipt-data",
    "@/lib/receipts/receipt-submissions",
    "@/lib/receipts/receipt-extraction-request",
    "@/lib/staff/retailer-staff-access",
    "next/headers",
    "node:crypto",
  ];

  test("9. no Client Component imports a service-role, server-only, or crypto module", () => {
    for (const file of CLIENT_FILES) {
      for (const forbidden of FORBIDDEN_IN_CLIENT) {
        assert.ok(
          !file.source.includes(`from "${forbidden}"`),
          `${file.path} imports ${forbidden} into browser code`,
        );
      }
    }
  });

  test("10. no Client Component reads process.env or touches Storage", () => {
    for (const file of CLIENT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(!/process\.env/.test(line.text), `${file.path}:${line.number} env`);
        assert.ok(
          !/\.storage\b/.test(line.text),
          `${file.path}:${line.number} storage in browser code`,
        );
      }
    }
  });

  test("11. no Client Component handles a path, bucket, hash, or tenant id", () => {
    for (const file of CLIENT_FILES) {
      for (const line of codeLines(file)) {
        assert.ok(
          !/\b(objectPath|storageBucket|storage_object_path|sha256|retailerOrganizationId|organization_id|submitted_by_profile_id)\b/.test(
            line.text,
          ),
          `${file.path}:${line.number} handles forbidden material: ${line.text.trim()}`,
        );
      }
    }
  });

  test("12. the only hidden field is the shop, and only the shop", () => {
    // The form submits exactly two named values, `shopId` and `receipt`. There is no hidden
    // field for a Retailer, profile, membership, bucket, path or status to ride in on.
    //
    // `shopId` MAY be hidden, and is, for a staff member assigned to exactly one shop: with no
    // choice to make there is no control to render, so the same value a <select> would have
    // posted travels in a hidden input instead. That is a change to the FORM ENCODING and not to
    // the trust model — the value is one of the two the form was always allowed to send, and
    // supabase/tests/database/sales_staff_receipt_shop_authorization_test.sql proves the id is
    // worth nothing on its own: reserve_receipt_submission re-derives the caller from auth.uid()
    // and refuses every shop they are not actively assigned to.
    //
    // The assertion is on the NAME SET rather than on the absence of hidden inputs, because that
    // is the property that actually matters: a hidden `retailerOrganizationId` must fail here
    // even though a hidden `shopId` does not.
    const ALLOWED_HIDDEN_NAMES = ["shopId"];

    for (const file of CLIENT_FILES) {
      const hidden = [
        ...file.source.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g),
      ].map((match) => match[0]);

      for (const field of hidden) {
        const name = /name="([^"]*)"/.exec(field);
        assert.ok(name !== null, `${file.path} has an unnamed hidden field: ${field}`);
        assert.ok(
          ALLOWED_HIDDEN_NAMES.includes(name[1]),
          `${file.path} introduces a hidden ${name[1]} field`,
        );
        // And its value comes from component state, never from anything server-shaped.
        assert.match(
          field,
          /value=\{selectedShopId\}/,
          `${file.path} hidden field carries an unexpected value: ${field}`,
        );
      }
    }
  });
});

describe("the privileged surface has exactly one caller", () => {
  test("13. only the submission module constructs the service-role client", () => {
    const callers = RECEIPT_FILES.filter((file) =>
      /createAdminClient/.test(stripComments(file.source)),
    ).map((file) => file.path);
    assert.deepEqual(callers, ["lib/receipts/receipt-submissions.ts"]);
  });

  test("14. only the submission module touches Supabase Storage", () => {
    const callers = RECEIPT_FILES.filter((file) =>
      /\.storage\b/.test(stripComments(file.source)),
    ).map((file) => file.path);
    assert.deepEqual(callers, ["lib/receipts/receipt-submissions.ts"]);
  });

  test("15. the two service-role RPCs are named only in that module", () => {
    const SERVICE_ROLE_RPCS = [
      "finalize_receipt_submission_upload",
      "record_receipt_submission_upload_failure",
    ];
    for (const file of RECEIPT_FILES) {
      if (file.path === "lib/receipts/receipt-submissions.ts") continue;
      for (const rpc of SERVICE_ROLE_RPCS) {
        assert.ok(
          !stripComments(file.source).includes(`"${rpc}"`),
          `${file.path} references the service-role RPC ${rpc}`,
        );
      }
    }
  });

  test("16. no receipt module reads the service-role key or a NEXT_PUBLIC_ variable", () => {
    for (const file of RECEIPT_FILES) {
      const code = stripComments(file.source);
      assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(code), `${file.path} reads the key`);
      assert.ok(!/NEXT_PUBLIC_/.test(code), `${file.path} adds a NEXT_PUBLIC_ var`);
    }
  });
});

describe("nothing out of scope was introduced", () => {
  test("17. no OCR, parsing, approval, incentive, reward, coin or payout vocabulary", () => {
    // A blunt but effective guard against scope creep landing in this feature by
    // accident. Comments are stripped first so the migrations' and modules' own
    // "deliberately not doing X" notes do not trip it.
    const OUT_OF_SCOPE =
      /\b(ocr|tesseract|textract|parseReceipt|receiptParsing|approveReceipt|rejectReceipt|approval|incentive|campaign|reward|payout|coinBalance)\b/i;
    for (const file of RECEIPT_FILES) {
      for (const line of stripComments(file.source).split("\n")) {
        assert.ok(
          !OUT_OF_SCOPE.test(line),
          `${file.path} mentions out-of-scope work: ${line.trim()}`,
        );
      }
    }
  });

  test("18. no permanent public storage URL is ever constructed", () => {
    // getPublicUrl would mint a permanent, unauthenticated link to a customer receipt.
    // Signed URLs are also absent in this MVP — see the page's own note.
    for (const file of RECEIPT_FILES) {
      const code = stripComments(file.source);
      assert.ok(!/getPublicUrl/.test(code), `${file.path} builds a public URL`);
      assert.ok(!/createSignedUrl/.test(code), `${file.path} mints a signed URL`);
    }
  });
});
