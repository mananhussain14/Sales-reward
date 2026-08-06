/**
 * SOURCE-LEVEL SAFETY GUARDS for the receipt-extraction milestone.
 *
 * Run with:  npm test
 *
 * The three Edge Functions cannot be unit-tested from Node — they call `Deno.serve`, read
 * `Deno.env` and import from `npm:`. What CAN be asserted, and what matters most, are the
 * structural properties a careless later edit would quietly break:
 *
 *   1. NO REAL PROVIDER. No endpoint, credential, SDK or service name anywhere in executable
 *      Milestone A source, and the provider column is pinned to one literal in SQL.
 *   2. NO RAW PAYLOAD TABLE.
 *   3. FAKE MODE CANNOT BE ENABLED BY A CLIENT, and the gate is evaluated only AFTER
 *      authentication, parsing and authorization.
 *   4. THE REQUEST FUNCTION NEVER RECORDS A SUCCESS.
 *   5. NO EDGE FUNCTION SWEEPS THE REAPER GLOBALLY.
 *   6. THE EDGE LAYER NEVER MANUFACTURES `retry_allowed: true`, AND NEVER TOUCHES THE
 *      ATTEMPT COUNTERS.
 *   7. NO BUCKET, PATH, HASH, CLAIM TOKEN, OPERATION ID, URL OR ERROR OBJECT REACHES A LOG
 *      LINE OR A RESPONSE.
 *   8. THE PREVIEW FUNCTION MINTS NO PUBLIC URL AND CANNOT LIST OR DELETE.
 *   9. THE EXISTING RECEIPT CONTRACT IS BYTE-UNCHANGED.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the exact
 * shapes that would constitute a regression, naming the file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const REQUEST_FN = "supabase/functions/request-receipt-extraction/index.ts";
const GET_FN = "supabase/functions/get-receipt-extraction/index.ts";
const PREVIEW_FN = "supabase/functions/receipt-image-preview/index.ts";
const EDGE_FUNCTIONS = [REQUEST_FN, GET_FN, PREVIEW_FN];

const MIGRATIONS = [
  "supabase/migrations/20260812090000_iso_currency_codes.sql",
  "supabase/migrations/20260812210000_receipt_extraction_foundation.sql",
  "supabase/migrations/20260813090000_receipt_extraction_worker_operations.sql",
  "supabase/migrations/20260813210000_receipt_extraction_client_operations.sql",
];

const LIB_MODULES = [
  "lib/receipts/receipt-extraction-vocabulary.ts",
  "lib/receipts/receipt-extraction-mode.ts",
  "lib/receipts/receipt-extraction-request-contract.ts",
  "lib/receipts/receipt-amount-parsing.ts",
  "lib/receipts/receipt-extraction-provider.ts",
  "lib/receipts/receipt-extraction-fake-fixtures.ts",
  "lib/receipts/receipt-extraction-fake-provider.ts",
  "lib/receipts/receipt-extraction-flow.ts",
  "lib/receipts/receipt-extraction-normalization.ts",
];

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Git needs the Command Line Tools on PATH in this environment. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/Library/Developer/CommandLineTools/usr/bin:${process.env.PATH ?? ""}`,
  };
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function stripSqlComments(source: string): string {
  return source.replace(/^[ \t]*--.*$/gm, "");
}

const CONFIG = read("supabase/config.toml");
const PACKAGE = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};

describe("1. Azure provider access is isolated and fail-closed", () => {
  const AZURE_CONFIG =
    "lib/receipts/receipt-extraction-azure-config.ts";
  const AZURE_ADAPTER =
    "lib/receipts/receipt-extraction-azure-provider.ts";
  const PROVIDER_SELECTOR =
    "lib/receipts/receipt-extraction-provider-selection.ts";
  const AZURE_READINESS =
    "supabase/migrations/20260828210000_receipt_extraction_azure_readiness.sql";

  test("no Edge Function opens a provider network connection directly", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));

      assert.ok(
        !/\bfetch\s*\(/.test(code),
        `${path} calls fetch directly`,
      );
      assert.ok(
        !/new\s+WebSocket\b/.test(code),
        `${path} opens a WebSocket`,
      );
      assert.ok(
        !/\bXMLHttpRequest\b/.test(code),
        `${path} creates XMLHttpRequest`,
      );
    }
  });

  test("Azure construction is delegated through the shared selector", () => {
    const selector = stripTsComments(
      read(PROVIDER_SELECTOR),
    );

    assert.match(
      selector,
      /createAzureDocumentIntelligenceProvider/,
    );

    // Only the request and polling functions execute OCR work.
    // receipt-image-preview only issues a short-lived signed URL and must
    // remain independent of provider selection.
    for (const path of [REQUEST_FN, GET_FN]) {
      const code = stripTsComments(read(path));

      assert.match(
        code,
        /receipt-extraction-provider-selection\.ts/,
        `${path} does not import the provider selector`,
      );
      assert.ok(
        !/createAzureDocumentIntelligenceProvider/.test(code),
        `${path} constructs Azure directly`,
      );
    }
  });

  test("Azure configuration modules read no environment themselves", () => {
    for (const modulePath of [
      AZURE_CONFIG,
      AZURE_ADAPTER,
      PROVIDER_SELECTOR,
    ]) {
      const code = stripTsComments(read(modulePath));

      assert.ok(
        !/\bDeno\.env\b/.test(code),
        `${modulePath} reads Deno.env`,
      );
      assert.ok(
        !/\bprocess\.env\b/.test(code),
        `${modulePath} reads process.env`,
      );
    }
  });

  test("the Azure adapter cannot log secrets or raw responses", () => {
    const code = stripTsComments(read(AZURE_ADAPTER));

    assert.ok(!/\bconsole\./.test(code));
    assert.ok(!/\blogFailure\s*\(/.test(code));
  });

  test("provider secrets are absent from config.toml", () => {
    const config = CONFIG.replace(/^\s*#.*$/gm, "");

    for (const secretName of [
      "AZURE_DI_ENDPOINT",
      "AZURE_DI_KEY",
      "AZURE_DI_API_VERSION",
      "AZURE_DI_MODEL",
    ]) {
      assert.ok(
        !config.includes(secretName),
        `config.toml declares ${secretName}`,
      );
    }
  });

  test("the database admits only the approved provider/model pairs", () => {
    const sql = stripSqlComments(read(AZURE_READINESS));

    assert.match(
      sql,
      /receipt_extractions_provider_allowed/,
    );
    assert.match(sql, /'FAKE'/);
    assert.match(
      sql,
      /'AZURE_DOCUMENT_INTELLIGENCE'/,
    );

    assert.match(
      sql,
      /receipt_extractions_provider_model_pair_allowed/,
    );
    assert.match(sql, /'fake-receipt-v1'/);
    assert.match(sql, /'prebuilt-receipt'/);
    assert.match(sql, /'prebuilt-invoice'/);
  });

  test("the Azure readiness migration does not enable extraction", () => {
    const sql = stripSqlComments(read(AZURE_READINESS));

    assert.ok(
      !/update\s+public\.receipt_extraction_runtime[\s\S]*?set\s+mode\s*=\s*'AZURE'/i
        .test(sql),
      "the migration enables Azure mode",
    );

    assert.ok(
      !/update\s+public\.receipt_extraction_runtime[\s\S]*?set\s+mode\s*=\s*'FAKE'/i
        .test(sql),
      "the migration enables fake mode",
    );
  });

  test("no Azure SDK dependency was introduced", () => {
    for (const dependency of Object.keys(PACKAGE.dependencies)) {
      assert.ok(
        !/^@azure\//i.test(dependency),
        `Azure SDK dependency found: ${dependency}`,
      );
    }
  });
});

describe("2. no raw provider payload is stored", () => {
  test("no migration creates a payload table", () => {
    // Comments are stripped: the foundation migration's header states, in prose, that this
    // table deliberately does not exist, and that sentence must not trip the rule it records.
    for (const path of MIGRATIONS) {
      assert.ok(
        !/receipt_extraction_payloads/.test(stripSqlComments(read(path))),
        `${path} references receipt_extraction_payloads`,
      );
    }
  });

  test("the table really is absent from the schema, not merely uncreated by these four", () => {
    const everyMigration = execFileSync(
      "git",
      ["ls-files", "supabase/migrations"],
      { cwd: ROOT, encoding: "utf8", env: gitEnv() },
    )
      .split("\n")
      .filter((line) => line.endsWith(".sql"));
    for (const path of everyMigration) {
      assert.ok(
        !/create table[^;]*receipt_extraction_payloads/i.test(read(path)),
        `${path} creates receipt_extraction_payloads`,
      );
    }
  });

  test("no module or function references one", () => {
    for (const path of [...EDGE_FUNCTIONS, ...LIB_MODULES]) {
      assert.ok(!/receipt_extraction_payloads/.test(stripTsComments(read(path))), path);
    }
  });

  test("the success RPC has no key for a payload, a raw error or a text blob", () => {
    const worker = stripSqlComments(read(MIGRATIONS[2]));
    for (const forbidden of [
      "raw_payload",
      "provider_payload",
      "provider_response",
      "provider_error",
      "raw_error",
      "receipt_text",
      "ocr_text",
    ]) {
      assert.ok(!worker.includes(forbidden), `the worker migration mentions ${forbidden}`);
    }
  });
});

describe("3. extraction mode cannot be enabled by a client", () => {
  test("the runtime mode is read only from the environment", () => {
    for (const path of [REQUEST_FN, GET_FN]) {
      const code = stripTsComments(read(path));

      const reads =
        code.match(
          /Deno\.env\.get\(RECEIPT_EXTRACTION_MODE_ENV\)/g,
        ) ?? [];

      assert.equal(
        reads.length,
        1,
        `${path} must read the mode exactly once`,
      );
    }

    const requestCode = stripTsComments(read(REQUEST_FN));
    assert.match(
      requestCode,
      /resolveReceiptExtractionRequestProvider\(\{[\s\S]*?mode:\s*Deno\.env\.get\(RECEIPT_EXTRACTION_MODE_ENV\)/,
    );

    const getCode = stripTsComments(read(GET_FN));
    assert.match(
      getCode,
      /const edgeMode\s*=\s*Deno\.env\.get\(RECEIPT_EXTRACTION_MODE_ENV\)/,
    );
  });

  test("the request body allowlist has exactly one key", () => {
    const contract = read("lib/receipts/receipt-extraction-request-contract.ts");
    assert.match(contract, /EXTRACTION_REQUEST_FIELDS = \["submission_id"\] as const/);
  });

  test("no Edge Function reads a mode or fixture from the request", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      for (const pattern of [
        /request\.headers\.get\(\s*["'][Xx]-/,
        /searchParams/,
        /\brequest\b[^;]*\bfixture\b/i,
        /\bbody\b[^;]*\bmode\b/i,
      ]) {
        assert.ok(!pattern.test(code), `${path} matches ${pattern}`);
      }
    }
  });

  test("fake fixture configuration is environment-only", () => {
    for (const path of [REQUEST_FN, GET_FN]) {
      const code = stripTsComments(read(path));

      assert.match(
        code,
        /fakeFixture:\s*Deno\.env\.get\(RECEIPT_EXTRACTION_FIXTURE_ENV\)/,
        `${path} does not source the fake fixture from Deno.env`,
      );
    }
  });

  test("the database gate ships DISABLED and no function writes it", () => {
    const foundation = read(MIGRATIONS[1]);
    assert.match(foundation, /values \(true, 'DISABLED'\)/);

    // No function in any migration may UPDATE the runtime mode.
    for (const path of MIGRATIONS) {
      const sql = stripSqlComments(read(path));
      assert.ok(
        !/update\s+public\.receipt_extraction_runtime/i.test(sql),
        `${path} writes the runtime gate`,
      );
    }
  });
});

describe("4. the request function never records a success", () => {
  test("the identifier does not appear at all", () => {
    const code = stripTsComments(read(REQUEST_FN));
    assert.ok(
      !/record_receipt_extraction_success/.test(code),
      "request-receipt-extraction must never complete an attempt",
    );
  });

  test("only the poll function completes", () => {
    const code = stripTsComments(read(GET_FN));
    assert.match(code, /record_receipt_extraction_success/);
  });

  test("the ordered sequence is not re-implemented in either function", () => {
    // The order lives in the shared pure module so two callers cannot execute two orders.
    for (const [path, symbol] of [
      [REQUEST_FN, "runExtractionRequestFlow"],
      [GET_FN, "runExtractionPollFlow"],
    ] as const) {
      const code = read(path);
      assert.match(code, new RegExp(`import[\\s\\S]*${symbol}`), `${path} does not import ${symbol}`);
      assert.match(code, new RegExp(`await ${symbol}\\(`), `${path} does not call ${symbol}`);
    }
  });
});

describe("5. no Edge Function sweeps the reaper globally", () => {
  test("every reaper call supplies exactly one extraction id", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      const calls = [...code.matchAll(/EXPIRE_RPC,\s*\{([^}]*)\}/g)];
      for (const call of calls) {
        const args = call[1];
        assert.match(args, /p_extraction_id:/, `${path} calls the reaper without an id`);
        assert.ok(!/p_extraction_id:\s*null/.test(args), `${path} passes NULL to the reaper`);
        assert.ok(
          !/p_extraction_id:\s*undefined/.test(args),
          `${path} passes undefined to the reaper`,
        );
      }
    }
  });

  test("no function calls the reaper with no arguments at all", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      assert.ok(!/rpc\(EXPIRE_RPC\)/.test(code), `${path} calls the reaper with no scope`);
    }
  });
});

describe("6. the Edge layer never manufactures retry_allowed, nor touches the counters", () => {
  test("no literal true is ever assigned to retry_allowed", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      assert.ok(!/retry_allowed:\s*true/.test(code), `${path} manufactures retry_allowed`);
    }
  });

  test("every computed retry_allowed is a narrowing conjunction or a literal false", () => {
    for (const path of [REQUEST_FN, GET_FN]) {
      const code = stripTsComments(read(path));
      for (const match of code.matchAll(/retry_allowed:\s*([^,\n]+)/g)) {
        const expression = match[1].trim();
        const isNarrowing = expression.includes("&&");
        const isFalse = expression === "false";
        assert.ok(
          isNarrowing || isFalse,
          `${path} sets retry_allowed to "${expression}" without narrowing`,
        );
        assert.ok(!/\|\|/.test(expression), `${path} widens retry_allowed with ||`);
      }
    }
  });

  test("the counters are passed through, never recomputed from availability", () => {
    for (const path of [REQUEST_FN, GET_FN]) {
      const code = stripTsComments(read(path));
      for (const match of code.matchAll(/attempts_(?:used|remaining):\s*([^,\n]+)/g)) {
        const expression = match[1].trim();
        assert.ok(
          !/edgeFakeEnabled|isFakeExtractionEnabled|DISABLED/.test(expression),
          `${path} lets availability influence "${expression}"`,
        );
      }
    }
  });
});

describe("7. nothing sensitive reaches a log line or a response", () => {
  test("the only logger takes a fixed category string", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      for (const match of code.matchAll(/logFailure\(([^)]*)\)/g)) {
        const argument = match[1].trim();
        if (argument.startsWith("category")) continue; // the declaration itself
        assert.match(argument, /^"[^"$]*"$/, `${path} logs a non-literal: ${argument}`);
      }
    }
  });

  test("no console call other than the single logger", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      const consoles = [...code.matchAll(/console\.\w+\(/g)];
      assert.equal(consoles.length, 1, `${path} has ${consoles.length} console calls`);
    }
  });

  test("no error object is ever bound, echoed or logged", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      assert.ok(!/catch\s*\(\s*\w+\s*\)/.test(code), `${path} binds a caught error`);
      assert.ok(!/error\.message/.test(code), `${path} reads an error message`);
      assert.ok(!/JSON\.stringify\(\s*\w*[Ee]rror/.test(code), `${path} serializes an error`);
    }
  });

  test("no storage coordinate, hash, token or operation id appears in a response payload", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      // These may be READ (the request function needs the bucket to download) but must never
      // be a key of an object handed to the JSON helper.
      for (const forbidden of [
        /storage_bucket:\s/,
        /storage_object_path:\s/,
        /file_sha256/,
        /claim_token:\s/,
        /provider_operation_id:\s*(?!id|providerOperationId)/,
        /worker_claim_token/,
      ]) {
        const payloadKeys = [...code.matchAll(/json\(\s*"[a-z-]+",\s*\d+,\s*\{([\s\S]*?)\}\s*\)/g)]
          .map((match) => match[1])
          .join("\n");
        assert.ok(!forbidden.test(payloadKeys), `${path} response carries ${forbidden}`);
      }
    }
  });

  test("the client projection is built from an EXPLICIT allowlist, not a spread", () => {
    for (const path of [REQUEST_FN, GET_FN]) {
      const code = stripTsComments(read(path));
      assert.match(code, /function safeExtractionPayload/, `${path} has no explicit projection`);
      assert.ok(
        !/\.\.\.row\b/.test(code),
        `${path} spreads a database row into a response`,
      );
    }
  });

  test("the service-role key goes only into the service client", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      const uses = [...code.matchAll(/serviceRoleKey/g)];
      // Declaration, null check, and exactly one createClient use.
      assert.ok(uses.length <= 4, `${path} references the service-role key ${uses.length} times`);
      assert.match(code, /createClient\(supabaseUrl,\s*publishableKey/, path);
      assert.match(code, /createClient\(supabaseUrl,\s*serviceRoleKey/, path);
    }
  });

  test("every response is built by the shared CORS helper", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = stripTsComments(read(path));
      assert.ok(!/new Response\(/.test(code), `${path} constructs a bare Response`);
      assert.match(code, /corsPreflightResponse\(\)/, path);
      assert.match(code, /corsJsonResponse\(/, path);
    }
  });

  test("the shared CORS module is imported, not re-implemented", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = read(path);
      assert.match(code, /from "\.\.\/\.\.\/\.\.\/lib\/receipts\/receipt-cors\.ts"/, path);
      assert.ok(!/Access-Control-Allow-Origin/.test(stripTsComments(code)), path);
    }
  });
});

describe("8. the preview function is read-only and mints nothing permanent", () => {
  const code = stripTsComments(read(PREVIEW_FN));

  test("no public URL", () => {
    assert.ok(!/getPublicUrl/.test(code));
  });

  test("no listing and no deletion", () => {
    assert.ok(!/\.list\(/.test(code));
    assert.ok(!/\.remove\(/.test(code));
    assert.ok(!/\.upload\(/.test(code));
    assert.ok(!/\.move\(/.test(code));
  });

  test("the signed URL is short-lived and the TTL is a named constant", () => {
    assert.match(code, /const SIGNED_URL_TTL_SECONDS = 120;/);
    assert.match(code, /createSignedUrl\(objectPath, SIGNED_URL_TTL_SECONDS\)/);
  });

  test("the JSON response forbids caching, because it carries a live capability", () => {
    assert.match(code, /"Cache-Control",\s*"no-store"/);
    assert.match(code, /"Pragma",\s*"no-cache"/);
  });

  test("the URL is never logged", () => {
    // String literals are removed first, so the fixed category "signed url could not be
    // created" — which is safe and says nothing about any particular URL — cannot trip a
    // rule aimed at the VARIABLE. What must never happen is the value being logged.
    const withoutLiterals = code.replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``");
    assert.ok(!/console\.\w+\([^)]*\burl\b/.test(withoutLiterals));
    assert.ok(!/logFailure\([^)]*\burl\b/.test(withoutLiterals));
    // The value is bound exactly once and used exactly once, in the response.
    assert.equal([...withoutLiterals.matchAll(/\burl\b/g)].length, 2);
  });

  test("the response carries no bucket, path, mime type or hash", () => {
    const payload = /json\("ok",\s*200,\s*\{([^}]*)\}\)/.exec(code);
    assert.ok(payload, "no success payload found");
    const keys = payload?.[1] ?? "";
    assert.match(keys, /url/);
    assert.match(keys, /expires_in_seconds/);
    for (const forbidden of ["bucket", "path", "mime", "sha", "hash", "submission_id"]) {
      assert.ok(!keys.includes(forbidden), `the preview response carries ${forbidden}`);
    }
  });

  test("ownership is proved under the CALLER'S token before any service-role use", () => {
    const accessAt = code.indexOf("ACCESS_RPC, { p_submission_id");
    const serviceAt = code.indexOf("createClient(supabaseUrl, serviceRoleKey");
    assert.ok(accessAt > 0 && serviceAt > 0);
    assert.ok(accessAt < serviceAt, "the service client is built before ownership is proved");
  });
});

describe("9. the environment gate is evaluated only after auth, parsing and authorization", () => {
  for (const path of [REQUEST_FN, GET_FN]) {
    test(`${path} orders its checks correctly`, () => {
      const code = stripTsComments(read(path));
      const getUserAt = code.indexOf("auth.getUser(accessToken)");
      const parseAt = code.indexOf("parseExtractionRequest(rawBody)");
      const accessAt = code.indexOf("ACCESS_RPC, { p_submission_id");
      const gateAt = code.indexOf(
        "Deno.env.get(RECEIPT_EXTRACTION_MODE_ENV)",
      );

      assert.ok(getUserAt > 0, "no token revalidation");
      assert.ok(parseAt > getUserAt, "the body is parsed before the token is revalidated");
      assert.ok(accessAt > parseAt, "authorization happens before the body is parsed");
      assert.ok(gateAt > accessAt, "the mode gate is evaluated before authorization");
    });
  }

  test("all three declare verify_jwt = true", () => {
    for (const name of [
      "request-receipt-extraction",
      "get-receipt-extraction",
      "receipt-image-preview",
    ]) {
      const block = new RegExp(
        `\\[functions\\.${name}\\][\\s\\S]{0,200}?verify_jwt = true`,
      );
      assert.match(CONFIG, block, `${name} does not declare verify_jwt = true`);
    }
  });

  test("all three revalidate the token rather than trusting its claims", () => {
    for (const path of EDGE_FUNCTIONS) {
      assert.match(stripTsComments(read(path)), /auth\.getUser\(accessToken\)/, path);
    }
  });
});

describe("10. the existing receipt contract is byte-unchanged", () => {
  const UNCHANGED = [
    "supabase/migrations/20260726090000_receipt_submission_storage_foundation.sql",
    "supabase/migrations/20260726210000_receipt_submission_operations.sql",
    "supabase/migrations/20260730090000_sales_staff_receipt_product_and_submission_reads.sql",
    "supabase/functions/submit-receipt/index.ts",
    "lib/receipts/receipt-cors.ts",
    "lib/receipts/receipt-file.ts",
    "lib/receipts/receipt-submission-flow.ts",
    "lib/receipts/receipt-submissions.ts",
    "lib/receipts/receipt-data.ts",
    "lib/receipts/receipt-normalization.ts",
  ];

  test("every protected path still exists", () => {
    for (const path of UNCHANGED) {
      assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
    }
  });

  test("none of them differs from the merge base", () => {
    // Compared against origin/main rather than a pinned digest, so the assertion stays true
    // as the branch advances and still fails the moment one of these files is edited here.
    let changed: string;
    try {
      changed = execFileSync(
        "git",
        ["diff", "--name-only", "origin/main", "--", ...UNCHANGED],
        { cwd: ROOT, encoding: "utf8", env: gitEnv() },
      );
    } catch {
      // No git, no origin/main, or a shallow checkout. The existence check above still holds.
      return;
    }
    assert.equal(changed.trim(), "", `these files must not change:\n${changed}`);
  });

  test("no new migration alters the existing receipt tables or functions", () => {
    for (const path of MIGRATIONS) {
      const sql = stripSqlComments(read(path));
      for (const forbidden of [
        /alter table\s+public\.receipt_submissions/i,
        /drop\s+(table|function|trigger|index)/i,
        /create or replace function\s+public\.(reserve|finalize|record_receipt_submission|list_my_receipt|get_my_receipt_submission)/i,
        /alter\s+.*receipts.*bucket/i,
        /create policy/i,
        /insert into storage\.buckets/i,
      ]) {
        assert.ok(!forbidden.test(sql), `${path} matches ${forbidden}`);
      }
    }
  });

  test("no new storage bucket and no storage policy", () => {
    for (const path of MIGRATIONS) {
      const sql = stripSqlComments(read(path));
      assert.ok(!/storage\.buckets/.test(sql), `${path} touches storage.buckets`);
      assert.ok(!/storage\.objects/.test(sql), `${path} touches storage.objects`);
    }
  });
});

describe("11. imports resolve the way Deno requires, and the pin matches package.json", () => {
  test("every relative import carries an explicit .ts extension", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = read(path);
      for (const match of code.matchAll(/from\s+"(\.[^"]+)"/g)) {
        assert.match(match[1], /\.ts$/, `${path} imports ${match[1]} without an extension`);
      }
    }
  });

  test("every imported module exists", () => {
    for (const path of EDGE_FUNCTIONS) {
      const code = read(path);
      const dir = join(ROOT, path, "..");
      for (const match of code.matchAll(/from\s+"(\.[^"]+)"/g)) {
        assert.ok(existsSync(join(dir, match[1])), `${path} imports missing ${match[1]}`);
      }
    }
  });

  test("the pinned supabase-js version matches package.json", () => {
    const pinned = PACKAGE.dependencies["@supabase/supabase-js"].replace(/^[\^~]/, "");
    for (const path of EDGE_FUNCTIONS) {
      assert.match(
        read(path),
        new RegExp(`npm:@supabase/supabase-js@${pinned.replace(/\./g, "\\.")}`),
        `${path} pins a different supabase-js`,
      );
    }
  });

  test("the integration script is registered and no unrelated script changed", () => {
    assert.equal(
      PACKAGE.scripts["test:extraction:integration"],
      "node scripts/receipt-extraction-integration-test.mjs",
    );
    assert.equal(PACKAGE.scripts.test, 'node --experimental-strip-types --test "lib/**/*.test.ts"');
    assert.equal(
      PACKAGE.scripts["test:receipts:integration"],
      "node scripts/receipt-submission-integration-test.mjs",
    );
  });
});

describe("12. no out-of-scope vocabulary was introduced", () => {
  test("no reward, incentive, claim, campaign, coin, payout or review queue", () => {
    for (const path of [...MIGRATIONS, ...LIB_MODULES, ...EDGE_FUNCTIONS]) {
      const code = path.endsWith(".sql") ? stripSqlComments(read(path)) : stripTsComments(read(path));
      for (const forbidden of [
        /\breward/i,
        /\bincentive/i,
        /\bcampaign/i,
        /\bpayout/i,
        /\bcoin_/i,
        /review_queue/i,
        /\bapprove(d|_)/i,
      ]) {
        assert.ok(!forbidden.test(code), `${path} matches ${forbidden}`);
      }
    }
  });

  test("no PDF, multi-page or offline-capture support", () => {
    for (const path of [...MIGRATIONS, ...LIB_MODULES, ...EDGE_FUNCTIONS]) {
      const code = path.endsWith(".sql") ? stripSqlComments(read(path)) : stripTsComments(read(path));
      for (const forbidden of [/application\/pdf/i, /page_number/i, /offline_queue/i]) {
        assert.ok(!forbidden.test(code), `${path} matches ${forbidden}`);
      }
    }
  });

  test("no semantic duplicate signal was added", () => {
    const foundation = stripSqlComments(read(MIGRATIONS[1]));
    for (const forbidden of ["duplicate_of", "is_duplicate", "duplicate_score", "likely_duplicate"]) {
      assert.ok(!foundation.includes(forbidden), `the foundation adds ${forbidden}`);
    }
  });
});
