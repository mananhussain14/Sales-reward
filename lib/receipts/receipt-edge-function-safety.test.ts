/**
 * SOURCE-LEVEL SAFETY GUARDS for the `submit-receipt` Edge Function.
 *
 * Run with:  npm test
 *
 * The Edge Function cannot be unit-tested from Node — it calls `Deno.serve`, reads
 * `Deno.env`, and imports from `npm:`. What CAN be asserted, and what matters most, are
 * the structural properties a careless later edit would quietly break:
 *
 *   1. IT DOES NOT RE-IMPLEMENT THE SECURITY-CRITICAL FILE LOGIC. Magic-byte sniffing,
 *      SHA-256 and filename sanitization must come from lib/receipts/receipt-file.ts —
 *      the same module the web Server Action uses. A second Deno copy is exactly the
 *      drift docs/mobile-backend-contract.md § 4.2 warns about: the two clients would
 *      define "a valid receipt" differently the first time one of them was edited.
 *   2. IT DOES NOT RE-IMPLEMENT THE SEQUENCE. reserve → upload → finalize, and the
 *      orphan cleanup on failure, live in lib/receipts/receipt-submission-flow.ts.
 *   3. ITS IMPORTS ACTUALLY RESOLVE, with the explicit `.ts` extensions Deno requires.
 *   4. THE PINNED supabase-js VERSION MATCHES package.json.
 *   5. NO PATH, BUCKET, HASH, TOKEN OR ERROR OBJECT REACHES A LOG LINE OR A RESPONSE.
 *   6. THE SERVICE-ROLE KEY GOES ONLY INTO THE SERVICE CLIENT, and the caller's client
 *      gets the publishable key.
 *   7. JWT VERIFICATION IS DECLARED IN supabase/config.toml.
 *   8. NO OUT-OF-SCOPE VOCABULARY (OCR, approval, incentives, rewards, coins, payouts)
 *      was introduced.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression, naming the line.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** The repository root, derived from this file's own location (lib/receipts/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FUNCTION_PATH = "supabase/functions/submit-receipt/index.ts";
const CONFIG_PATH = "supabase/config.toml";

const SOURCE = readFileSync(join(ROOT, FUNCTION_PATH), "utf8");
const CONFIG = readFileSync(join(ROOT, CONFIG_PATH), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const CODE_LINES = stripComments(SOURCE)
  .split("\n")
  .map((text, index) => ({ number: index + 1, text }))
  .filter((line) => line.text.trim().length > 0);

/** Every `from "…"` specifier in the file, in source order. */
const IMPORT_SPECIFIERS = [...SOURCE.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
  (match) => match[1],
);

describe("the Edge Function exists and was found", () => {
  test("1. the entrypoint is present and non-trivial", () => {
    assert.ok(existsSync(join(ROOT, FUNCTION_PATH)), `${FUNCTION_PATH} is missing`);
    assert.ok(CODE_LINES.length >= 100, `only ${CODE_LINES.length} code lines`);
  });

  test("2. it is a Deno request handler, not a Next.js module", () => {
    assert.ok(/Deno\.serve\s*\(/.test(SOURCE), "no Deno.serve entrypoint");
    assert.ok(!/"use server"|"use client"/.test(SOURCE), "carries a Next.js directive");
    assert.ok(
      !IMPORT_SPECIFIERS.some((specifier) => specifier.startsWith("@/")),
      "uses a Next.js path alias, which Deno cannot resolve",
    );
  });
});

describe("the security-critical logic is imported, never restated", () => {
  test("3. the file validator and the flow come from lib/receipts", () => {
    assert.ok(
      /\bvalidateReceiptFile\b/.test(SOURCE) &&
        IMPORT_SPECIFIERS.some((s) => s.endsWith("lib/receipts/receipt-file.ts")),
      "does not import validateReceiptFile from lib/receipts/receipt-file.ts",
    );
    assert.ok(
      /\brunReceiptSubmissionFlow\b/.test(SOURCE) &&
        IMPORT_SPECIFIERS.some((s) =>
          s.endsWith("lib/receipts/receipt-submission-flow.ts"),
        ),
      "does not import runReceiptSubmissionFlow from lib/receipts/receipt-submission-flow.ts",
    );
  });

  test("4. magic-byte sniffing is not re-implemented", () => {
    // The three signatures lib/receipts/receipt-file.ts checks. Any byte-level image
    // detection appearing here means a second, divergent definition of "a valid receipt".
    const SNIFFING =
      /0x(?:ff|d8|89|4e|47|52|49|46|57|45|42|50)\b|["'`]RIFF["'`]|["'`]WEBP["'`]|sniff/i;
    for (const line of CODE_LINES) {
      assert.ok(
        !SNIFFING.test(line.text),
        `${FUNCTION_PATH}:${line.number} re-implements MIME sniffing: ${line.text.trim()}`,
      );
    }
  });

  test("5. hashing and filename sanitization are not re-implemented", () => {
    assert.ok(!/createHash|node:crypto|digest\s*\(/.test(stripComments(SOURCE)), "hashes here");
    assert.ok(
      !/\bsanitize\w*\s*\(/.test(stripComments(SOURCE)),
      "sanitizes a filename here",
    );
    // The declared content type must never be read: it is attacker-controlled.
    for (const line of CODE_LINES) {
      assert.ok(
        !/\bfile\.type\b/.test(line.text),
        `${FUNCTION_PATH}:${line.number} reads the declared content type`,
      );
    }
  });

  test("6. the reserve → upload → finalize order is not restated", () => {
    // The sequence lives in the shared pure module. This file supplies PORTS only, so it
    // must contain no branching on the sequence's own outcomes.
    assert.ok(
      /runReceiptSubmissionFlow\s*\(/.test(stripComments(SOURCE)),
      "does not call the shared flow",
    );
    const uploadBeforeFlow =
      stripComments(SOURCE).indexOf("runReceiptSubmissionFlow(") <
      stripComments(SOURCE).lastIndexOf(".storage.from(");
    assert.ok(!uploadBeforeFlow, "uploads outside the shared flow");
  });
});

describe("the imports resolve the way Deno requires", () => {
  test("7. every local import is relative and carries an explicit .ts extension", () => {
    const local = IMPORT_SPECIFIERS.filter((s) => s.startsWith("."));
    assert.ok(local.length >= 2, `expected at least two local imports, found ${local.length}`);
    for (const specifier of local) {
      assert.ok(
        specifier.endsWith(".ts"),
        `"${specifier}" has no .ts extension; Deno will not resolve it`,
      );
    }
  });

  test("8. every local import points at a file that exists", () => {
    const functionDir = dirname(join(ROOT, FUNCTION_PATH));
    for (const specifier of IMPORT_SPECIFIERS.filter((s) => s.startsWith("."))) {
      const target = resolve(functionDir, specifier);
      assert.ok(existsSync(target), `"${specifier}" resolves to a missing file: ${target}`);
    }
  });

  test("9. the pinned supabase-js version matches package.json", () => {
    const pinned = /npm:@supabase\/supabase-js@([\d.]+)/.exec(SOURCE)?.[1];
    assert.ok(pinned, "supabase-js is not pinned to an exact version");
    const declared = PACKAGE.dependencies["@supabase/supabase-js"].replace(/^[^\d]*/, "");
    assert.equal(
      pinned,
      declared,
      `Edge Function pins ${pinned} but package.json declares ${declared}`,
    );
  });
});

describe("nothing secret reaches a log line", () => {
  const consoleLines = CODE_LINES.filter((line) =>
    /console\.(log|error|warn|info|debug)/.test(line.text),
  );

  test("10. logging is funnelled through exactly one helper", () => {
    assert.equal(
      consoleLines.length,
      1,
      `expected one logging chokepoint, found ${consoleLines.length} at lines ${consoleLines
        .map((line) => line.number)
        .join(", ")}`,
    );
  });

  test("11. the single log line interpolates only a sanitized category", () => {
    for (const line of consoleLines) {
      const interpolated = [...line.text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      for (const expression of interpolated) {
        assert.equal(
          expression,
          "category",
          `${FUNCTION_PATH}:${line.number} interpolates "${expression}"`,
        );
      }
      const firstArg = (
        /console\.(?:log|error|warn|info|debug)\s*\(\s*([^)]*)/.exec(line.text)?.[1] ?? ""
      ).trim();
      assert.ok(
        firstArg.startsWith("`") || firstArg.startsWith('"') || firstArg.startsWith("'"),
        `${FUNCTION_PATH}:${line.number} logs a non-literal: ${line.text.trim()}`,
      );
    }
  });

  test("12. every log call site passes a fixed literal, interpolating nothing", () => {
    // A STRING LITERAL IS SAFE BY CONSTRUCTION, so literal-ness is asserted first and the
    // identifier scan runs only over what a literal cannot guarantee: the expressions
    // inside a template's `${…}`. Scanning the literal's own text instead would fail on
    // categories like "reserve rpc-error" — the word `error` in prose an operator reads,
    // not an error object being serialized. This mirrors § 7 of
    // lib/receipts/receipt-source-safety.test.ts, which also scans interpolations only.
    const FORBIDDEN =
      /\b(objectPath|storage_object_path|bucket|storage_bucket|sha256|file_sha256|error|err|result|token|authorization|serviceRoleKey|publishableKey|claims|user)\b/;
    let callSites = 0;

    for (const line of CODE_LINES) {
      // The helper's own declaration is not a call site; its parameter is the sanitized
      // category the rule is about.
      if (/function\s+logFailure/.test(line.text)) continue;
      const call = /\blogFailure\s*\(\s*([^)]*)\)/.exec(line.text);
      if (!call) continue;
      callSites += 1;

      const argument = call[1].trim();
      assert.ok(
        /^["'`]/.test(argument),
        `${FUNCTION_PATH}:${line.number} logs a non-literal category: ${line.text.trim()}`,
      );
      for (const match of argument.matchAll(/\$\{([^}]*)\}/g)) {
        assert.ok(
          !FORBIDDEN.test(match[1]),
          `${FUNCTION_PATH}:${line.number} interpolates forbidden material: ${match[1].trim()}`,
        );
      }
    }

    assert.ok(callSites >= 5, `only ${callSites} log call sites — the rule is near-vacuous`);
  });
});

describe("nothing secret reaches a response body", () => {
  test("13. the response vocabulary is closed", () => {
    // Every `json(...)` call names one of the declared statuses. A new status must be
    // added to the ResponseStatus union first, which is what keeps the contract in
    // docs/mobile-receipt-submission-audit.md § B.3 true.
    const declared = /type ResponseStatus =([\s\S]*?);/.exec(SOURCE)?.[1] ?? "";
    const statuses = new Set(
      [...declared.matchAll(/["']([a-z-]+)["']/g)].map((match) => match[1]),
    );
    assert.ok(statuses.size >= 6, `only ${statuses.size} statuses declared`);

    for (const line of CODE_LINES) {
      for (const match of line.text.matchAll(/\bjson\(\s*["']([^"']+)["']/g)) {
        assert.ok(
          statuses.has(match[1]),
          `${FUNCTION_PATH}:${line.number} returns undeclared status "${match[1]}"`,
        );
      }
    }
  });

  test("14. only `reason` and `submission_id` are ever added to a response", () => {
    // The third argument of json() is the extras object. Anything else appearing there —
    // an object path, a bucket, a hash, a provider message — would leave this function.
    const ALLOWED = new Set(["reason", "submission_id"]);
    for (const match of stripComments(SOURCE).matchAll(/\bjson\([^)]*?\{([^}]*)\}/g)) {
      for (const key of match[1].matchAll(/([A-Za-z_][\w]*)\s*:/g)) {
        assert.ok(ALLOWED.has(key[1]), `response carries a forbidden key: ${key[1]}`);
      }
    }
  });

  test("15. no path, bucket, hash or provider message is put in a Response", () => {
    const FORBIDDEN =
      /\b(objectPath|storage_object_path|storage_bucket|sha256|serviceRoleKey|publishableKey|authorization)\b/;
    for (const line of CODE_LINES) {
      // Every shape that produces a reply, including the shared CORS builders — this file
      // no longer constructs a `Response` itself, so scanning only `new Response(` would
      // make the rule vacuous.
      if (!/new Response\(|JSON\.stringify\(|corsJsonResponse\(|corsPreflightResponse\(/.test(line.text))
        continue;
      assert.ok(
        !FORBIDDEN.test(line.text),
        `${FUNCTION_PATH}:${line.number} puts secret material in a response: ${line.text.trim()}`,
      );
    }
  });
});

describe("the two clients keep their own keys", () => {
  test("16. the service-role key is read once and used for exactly one client", () => {
    const reads = [...stripComments(SOURCE).matchAll(/SUPABASE_SERVICE_ROLE_KEY/g)];
    assert.equal(reads.length, 1, `service-role key read ${reads.length} times`);

    const clients = [...stripComments(SOURCE).matchAll(/createClient\(\s*(\w+)\s*,\s*(\w+)/g)];
    assert.equal(clients.length, 2, `expected two clients, found ${clients.length}`);
    const keysUsed = clients.map((match) => match[2]).sort();
    assert.deepEqual(
      keysUsed,
      ["publishableKey", "serviceRoleKey"],
      `clients are built with ${keysUsed.join(", ")}`,
    );
  });

  test("17. reserve runs as the caller; upload and finalize run as the service role", () => {
    const code = stripComments(SOURCE);
    assert.ok(
      /asCaller\.rpc\(\s*RESERVE_RPC/.test(code),
      "reserve does not run under the caller's own token",
    );
    for (const rpc of ["FINALIZE_RPC", "RECORD_FAILURE_RPC"]) {
      assert.ok(
        new RegExp(`asService\\.rpc\\(\\s*${rpc}`).test(code),
        `${rpc} does not run as the service role`,
      );
      assert.ok(
        !new RegExp(`asCaller\\.rpc\\(\\s*${rpc}`).test(code),
        `${rpc} is reachable under the caller's token`,
      );
    }
    assert.ok(!/asCaller\.storage/.test(code), "the caller's client touches Storage");
  });

  test("18. the token is revalidated with the Auth server, not merely decoded", () => {
    const code = stripComments(SOURCE);
    assert.ok(/auth\.getUser\(\s*accessToken\s*\)/.test(code), "does not revalidate the token");
    assert.ok(!/getSession\(\)/.test(code), "trusts getSession()");
    assert.ok(!/\bjwtDecode|atob\(|decodeJwt/.test(code), "decodes the JWT itself");
  });

  test("19. no protected table is read or written directly", () => {
    // Supabase table access is always `.from("<table>")` — a STRING argument. Anchored on
    // the quote so `.storage.from(bucket)` (a variable) is not a false positive.
    for (const line of CODE_LINES) {
      assert.ok(
        !/\.from\s*\(\s*["'`]/.test(line.text),
        `${FUNCTION_PATH}:${line.number} direct table access: ${line.text.trim()}`,
      );
      assert.ok(
        !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(line.text),
        `${FUNCTION_PATH}:${line.number} raw SQL: ${line.text.trim()}`,
      );
    }
  });
});

describe("the deployment declares JWT verification", () => {
  test("20. supabase/config.toml enables the function with verify_jwt = true", () => {
    const block = /\[functions\.submit-receipt\]([\s\S]*?)(?=\n\[|$)/.exec(CONFIG)?.[1];
    assert.ok(block, "no [functions.submit-receipt] section in supabase/config.toml");
    assert.ok(/^\s*enabled\s*=\s*true\s*$/m.test(block), "the function is not enabled");
    assert.ok(
      /^\s*verify_jwt\s*=\s*true\s*$/m.test(block),
      "verify_jwt is not true — the gateway would admit unauthenticated requests",
    );
    assert.ok(
      /entrypoint\s*=\s*["']\.\/functions\/submit-receipt\/index\.ts["']/.test(block),
      "the entrypoint does not point at the function",
    );
  });
});

/**
 * ============================================================================
 * THE CORS POLICY IS CENTRAL, AND NO REPLY ESCAPES IT
 * ============================================================================
 * A Flutter Web build is a browser, so a reply it cannot read is a reply the client never
 * receives — the function runs, the receipt is stored, and the app shows nothing. Two
 * shapes caused exactly that and are held shut here:
 *
 *   - a header map that omitted `apikey` and `x-client-info`, which a real Supabase
 *     client always sends: one unlisted header fails the whole preflight;
 *   - replies built outside the helper, including the runtime's own 500 for an uncaught
 *     throw, which carry no CORS headers at all.
 *
 * The VALUES are asserted against real `Response` objects in ./receipt-cors.test.ts. What
 * is asserted here is the property that file cannot see: that the Edge Function routes
 * every reply through that one module instead of restating the policy.
 */
describe("the CORS policy is defined once and used everywhere", () => {
  const CORS_MODULE_PATH = "lib/receipts/receipt-cors.ts";
  const CORS_SOURCE = readFileSync(join(ROOT, CORS_MODULE_PATH), "utf8");
  const CORS_CODE = stripComments(CORS_SOURCE);
  const CODE = stripComments(SOURCE);

  test("22. the Edge Function imports the policy and restates no part of it", () => {
    assert.ok(
      IMPORT_SPECIFIERS.some((specifier) => specifier.endsWith("lib/receipts/receipt-cors.ts")),
      "does not import the shared CORS module",
    );
    for (const helper of ["corsJsonResponse", "corsPreflightResponse"]) {
      assert.ok(new RegExp(`\\b${helper}\\b`).test(CODE), `does not use ${helper}`);
    }

    // A single literal header name here would be a second policy: the copy and the module
    // would drift the first time either was edited, which is the defect that shipped.
    for (const line of CODE_LINES) {
      assert.ok(
        !/Access-Control-/i.test(line.text),
        `${FUNCTION_PATH}:${line.number} restates a CORS header: ${line.text.trim()}`,
      );
    }
  });

  test("23. the Edge Function constructs no Response of its own", () => {
    // `new Response(` is how a reply skips the policy. There must be none: the preflight
    // comes from corsPreflightResponse(), everything else from json() -> corsJsonResponse().
    for (const line of CODE_LINES) {
      assert.ok(
        !/new Response\(|Response\.(json|redirect|error)\(/.test(line.text),
        `${FUNCTION_PATH}:${line.number} builds a reply outside the CORS helper: ${line.text.trim()}`,
      );
    }

    const jsonHelper = /function json\([\s\S]*?\n}/.exec(CODE)?.[0];
    assert.ok(jsonHelper, "the json() helper is gone");
    assert.ok(
      /corsJsonResponse\(/.test(jsonHelper),
      "json() no longer delegates to the shared CORS helper",
    );
  });

  test("24. OPTIONS is answered by the shared preflight, before authentication", () => {
    const optionsAt = CODE.search(/request\.method\s*===\s*["']OPTIONS["']/);
    assert.ok(optionsAt > -1, "the OPTIONS method is not handled at all");

    const preflightAt = CODE.indexOf("corsPreflightResponse()");
    assert.ok(preflightAt > optionsAt, "OPTIONS is not answered by corsPreflightResponse()");

    // A preflight carries NO Authorization header. Reaching the token check first would
    // answer it with a 401 and block every cross-origin caller before the real request.
    const authAt = CODE.indexOf(`headers.get("Authorization")`);
    assert.ok(authAt > -1, "the authentication step disappeared");
    assert.ok(preflightAt < authAt, "the preflight is answered after authentication is attempted");
  });

  test("25. every declared response status is returned through the helper", () => {
    // ./receipt-cors.test.ts proves corsJsonResponse() attaches the headers to any status.
    // This proves the Edge Function has no outcome that bypasses it — success, invalid,
    // unauthenticated, denied, duplicate, upload-failed and unavailable alike.
    const declared = /type ResponseStatus =([\s\S]*?);/.exec(SOURCE)?.[1] ?? "";
    const statuses = [...declared.matchAll(/["']([a-z-]+)["']/g)].map((match) => match[1]);
    assert.ok(statuses.length >= 7, `only ${statuses.length} statuses declared`);

    const returned = new Set(
      [...CODE.matchAll(/\bjson\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
    );
    for (const status of statuses) {
      assert.ok(returned.has(status), `"${status}" is never returned through json()`);
    }
  });

  test("26. an unexpected throw is answered, not left to the runtime", () => {
    // An uncaught throw becomes a runtime-generated 500 with no CORS headers, which the
    // browser discards without showing the client a status or a body.
    const wrapper = /Deno\.serve\(([\s\S]*)\)\s*;?\s*$/.exec(CODE)?.[1];
    assert.ok(wrapper, "no Deno.serve entrypoint");
    assert.ok(/\btry\s*\{/.test(wrapper), "the entrypoint does not catch anything");
    assert.ok(
      /\bcatch\b[\s\S]*?\bjson\(\s*["']unavailable["']\s*,\s*503\s*\)/.test(wrapper),
      "an unexpected throw does not return a CORS-carrying `unavailable`",
    );
    // The caught value must not be bound: an error can quote a body, a path, or a
    // provider message, and this branch returns to a caller.
    assert.ok(
      !/\bcatch\s*\([^)]+\)/.test(wrapper),
      "the entrypoint binds the caught error, which can carry provider text",
    );
  });

  test("27. the shared module enables no ambient credentials", () => {
    // `Access-Control-Allow-Credentials: true` is the one header that would make the
    // wildcard origin dangerous. Comments are stripped first so the prose explaining its
    // absence cannot satisfy the rule it describes.
    assert.ok(
      !/Access-Control-Allow-Credentials/i.test(CORS_CODE),
      `${CORS_MODULE_PATH} declares a credentials header`,
    );
    assert.ok(!/Access-Control-Allow-Credentials/i.test(CODE), "the Edge Function declares one");
  });

  test("28. the shared module is dependency-free, so Deno can import it", () => {
    // The same constraint ./receipt-file.ts and ./receipt-submission-flow.ts are under:
    // an import of `next/*`, a Supabase client, or a Deno API would make this module
    // unusable from one of the two runtimes that load it.
    const imports = [...CORS_SOURCE.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, [], `${CORS_MODULE_PATH} imports ${imports.join(", ")}`);
    assert.ok(!/\bDeno\./.test(CORS_CODE), "uses a Deno API, so Node cannot test it");
    assert.ok(!/\bprocess\./.test(CORS_CODE), "uses a Node API, so Deno cannot serve it");
  });
});

describe("no out-of-scope vocabulary was introduced", () => {
  test("21. no OCR, approval, incentive, reward, coin or payout logic appears", () => {
    // The SAME regex as lib/receipts/receipt-source-safety.test.ts § 17, so the mobile
    // entry point and the web feature are held to one definition of "out of scope".
    // Deliberately targeted rather than broad: a bare /reject/ would trip on
    // `logFailure("upload rejected")`, which is a Storage outcome, not a receipt-review
    // state — and the receipt-review vocabulary is what this rule exists to keep out.
    const FORBIDDEN =
      /\b(ocr|tesseract|textract|parseReceipt|receiptParsing|approveReceipt|rejectReceipt|approval|incentive|campaign|reward|payout|coinBalance)\b/i;
    for (const line of CODE_LINES) {
      assert.ok(
        !FORBIDDEN.test(line.text),
        `${FUNCTION_PATH}:${line.number} out-of-scope vocabulary: ${line.text.trim()}`,
      );
    }
  });
});
