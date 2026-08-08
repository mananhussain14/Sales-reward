import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatMinorAmount } from "./receipt-extraction-display.ts";

/**
 * The web polling surface, asserted where it can be: at the source level.
 *
 * The modules this milestone adds cannot all be imported here — the Server Action module
 * and the poll client both pull in `next/headers` through @/lib/supabase/server, and the
 * panel is a Client Component. The same constraint already shapes
 * ./receipt-extraction-safety.test.ts, and the same answer applies: the DECISIONS live in
 * pure modules that are unit-tested directly (see ./receipt-extraction-polling.test.ts),
 * and what is asserted here is the posture of the files that cannot be executed.
 *
 * These are the properties that would silently rot if nobody pinned them: that the web
 * still goes through the Edge Function rather than the tables, that no service-role or
 * provider material appears on the path, and that the panel renders nothing the client
 * contract does not already carry.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function code(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/**
 * The same file with its comments removed.
 *
 * Every "this file must not name X" assertion below runs against THIS, not the raw text.
 * These modules explain at length what they deliberately do not do — they name the tables
 * they never query and the keys they never read, precisely so a reader understands the
 * posture — and a scanner that could not tell prose from code would be satisfied only by
 * deleting the documentation. What matters is that the identifier never appears in an
 * executable position.
 */
function executable(relativePath: string): string {
  return code(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const POLL_CLIENT = "lib/receipts/receipt-extraction-poll-request.ts";
const POLL_LOOP = "lib/receipts/receipt-extraction-poll-loop.ts";
const POLL_RULES = "lib/receipts/receipt-extraction-polling.ts";
const ACTIONS = "app/(retailer)/retailer/receipts/extraction-actions.ts";
const PANEL = "app/(retailer)/retailer/receipts/receipt-extraction-panel.tsx";
const PANEL_STATE = "app/(retailer)/retailer/receipts/extraction-panel-state.ts";
const SUBMIT_ACTIONS = "app/(retailer)/retailer/receipts/actions.ts";
const SUBMIT_FORM = "app/(retailer)/retailer/receipts/submit-receipt-form.tsx";
const CONFIG = "supabase/config.toml";

const WEB_EXTRACTION_FILES = [POLL_CLIENT, POLL_LOOP, POLL_RULES, ACTIONS, PANEL, PANEL_STATE];

describe("1. the web actually calls the Edge Function that finalizes a reading", () => {
  test("the poll client posts to get-receipt-extraction", () => {
    const source = code(POLL_CLIENT);
    assert.match(source, /"get-receipt-extraction"/);
    assert.match(source, /\/functions\/v1\/\$\{GET_EXTRACTION_FUNCTION\}/);
    assert.match(source, /method:\s*"POST"/);
  });

  test("the function name is declared exactly once in the web application", () => {
    // A second literal would be a second thing to rename. The request client already
    // holds the only copy of its own name; this is the same rule for the read.
    const occurrences = WEB_EXTRACTION_FILES.map((file) => {
      const matches = code(file).match(/"get-receipt-extraction"/g);
      return matches === null ? 0 : matches.length;
    }).reduce((a, b) => a + b, 0);

    assert.equal(occurrences, 1);
  });

  test("that function is enabled and JWT-verified in supabase/config.toml", () => {
    const config = code(CONFIG);
    const block = /\[functions\.get-receipt-extraction\][\s\S]*?verify_jwt\s*=\s*true/.exec(
      config,
    );
    assert.ok(block !== null, "get-receipt-extraction must exist with verify_jwt = true");
  });

  test("the body carries the one allowed key and nothing else", () => {
    assert.match(code(POLL_CLIENT), /JSON\.stringify\(\{\s*submission_id:\s*submissionId\s*\}\)/);
  });

  test("a poll is never served from a cache", () => {
    // A cached PROCESSING would loop against a reading that finished minutes ago.
    assert.match(code(POLL_CLIENT), /cache:\s*"no-store"/);
  });
});

describe("2. the browser never reaches the extraction tables", () => {
  test("no web file on this path names an extraction table", () => {
    for (const file of WEB_EXTRACTION_FILES) {
      const source = executable(file);
      assert.ok(
        !/receipt_extractions|receipt_extraction_line_items|receipt_confirmations/.test(source),
        `${file} names a protected table`,
      );
    }
  });

  test("no web file on this path opens a PostgREST table query", () => {
    for (const file of WEB_EXTRACTION_FILES) {
      assert.ok(!/\.from\(/.test(executable(file)), `${file} queries a table directly`);
    }
  });

  test("no web file on this path constructs a service-role client", () => {
    for (const file of WEB_EXTRACTION_FILES) {
      const source = executable(file);
      assert.ok(!/createAdminClient/.test(source), `${file} builds an admin client`);
      assert.ok(
        !/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE/.test(source),
        `${file} reads the service-role key`,
      );
    }
  });

  test("no Azure credential, endpoint or provider name appears anywhere on the path", () => {
    for (const file of WEB_EXTRACTION_FILES) {
      const source = executable(file);
      assert.ok(
        !/AZURE_|DOCUMENT_INTELLIGENCE|cognitiveservices|prebuilt-receipt|prebuilt-invoice/i.test(
          source,
        ),
        `${file} references Azure configuration`,
      );
    }
  });
});

describe("3. no service-role or worker-only value can be rendered", () => {
  const FORBIDDEN = [
    "provider_operation_id",
    "providerOperationId",
    "worker_claim_token",
    "workerClaimToken",
    "provider_model",
    "providerModel",
    "storage_bucket",
    "storageBucket",
    "object_path",
    "storage_object_path",
    "objectPath",
    "file_sha256",
    "fileSha256",
    "expires_at",
    "expiresAt",
  ];

  test("the panel names none of them", () => {
    const source = executable(PANEL);
    for (const field of FORBIDDEN) {
      assert.ok(!source.includes(field), `the panel references ${field}`);
    }
  });

  test("no module on the web polling path names any of them", () => {
    for (const file of WEB_EXTRACTION_FILES) {
      const source = executable(file);
      for (const field of FORBIDDEN) {
        assert.ok(!source.includes(field), `${file} references ${field}`);
      }
    }
  });

  test("the panel renders no raw failure code and no warning code", () => {
    const source = executable(PANEL);
    // The ten stored codes collapse to three before they leave PostgreSQL; none of the
    // internal ten may be spoken here, and the warning vocabulary is summarized rather
    // than printed.
    for (const internal of [
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_QUOTA_EXCEEDED",
      "PROVIDER_TIMEOUT",
      "PROVIDER_REJECTED_DOCUMENT",
      "OBJECT_UNREADABLE",
      "NORMALIZATION_FAILED",
      "WORKER_ABANDONED",
      "NEVER_CLAIMED",
    ]) {
      assert.ok(!source.includes(internal), `the panel speaks the internal code ${internal}`);
    }
    assert.ok(
      !/warningCodes\.map|warningCodes\.join/.test(source),
      "the panel prints raw warning codes",
    );
  });

  test("the panel's failure copy covers exactly the three client codes", () => {
    const state = code(PANEL_STATE);
    assert.match(state, /satisfies Record<ClientExtractionFailureCode, string>/);
    for (const client of [
      "IMAGE_NOT_A_RECEIPT",
      "IMAGE_UNUSABLE",
      "EXTRACTION_UNAVAILABLE",
    ]) {
      assert.ok(state.includes(client), `no sentence for ${client}`);
    }
  });
});

describe("4. polling cannot create an extraction attempt", () => {
  test("the poll client never calls the request function", () => {
    const source = executable(POLL_CLIENT);
    assert.ok(!source.includes("request-receipt-extraction"));
    assert.ok(!source.includes("requestReceiptExtraction"));
  });

  test("the loop has no port that could request one", () => {
    const source = executable(POLL_LOOP);
    assert.ok(!/request/i.test(source));
  });

  test("the retry action calls the request function exactly once, on one line", () => {
    const source = code(ACTIONS);
    const calls = source.match(/requestReceiptExtraction\(/g) ?? [];
    assert.equal(calls.length, 1);
  });

  test("the poll action does not call the request function at all", () => {
    const source = code(ACTIONS);
    const pollAction = /export async function pollReceiptExtractionAction[\s\S]*?\n\}/.exec(
      source,
    );
    assert.ok(pollAction !== null);
    assert.ok(!pollAction[0].includes("requestReceiptExtraction"));
  });

  test("the panel calls the retry action only from the retry handler", () => {
    const source = code(PANEL);
    const calls = source.match(/retryReceiptExtractionAction\(/g) ?? [];
    assert.equal(calls.length, 1);
    // And it is guarded, so a double click cannot send two.
    assert.match(source, /if \(retrying\) return;/);
  });
});

describe("5. every Server Action re-establishes its own footing", () => {
  /**
   * How many actions this module exports. The two counts below are compared against THIS
   * rather than against a literal, so adding an action without its guard fails here instead of
   * requiring two numbers to be remembered.
   */
  function exportedActionCount(): number {
    return (code(ACTIONS).match(/^export async function /gm) ?? []).length;
  }

  test("there are three: poll, retry, and the line-item read", () => {
    assert.equal(exportedActionCount(), 3);
  });

  test("each re-resolves portal access before doing anything", () => {
    const source = code(ACTIONS);
    assert.match(source, /getRetailerPortalAccess/);
    // One shared gate, called from every action.
    const guards = source.match(/await refuseUnlessSubmitter\(\)/g) ?? [];
    assert.equal(guards.length, exportedActionCount());
  });

  test("only a submitter passes the gate", () => {
    assert.match(code(ACTIONS), /access\.kind !== "submitter"/);
  });

  test("the submission id is validated as a UUID in every action", () => {
    const source = code(ACTIONS);
    const checks = source.match(/UUID_PATTERN\.test/g) ?? [];
    assert.equal(checks.length, exportedActionCount());
  });

  test("no caller identity is accepted as a parameter", () => {
    const source = executable(ACTIONS);
    // The only argument either action takes is a submission id. A profile, organization
    // or membership parameter would move the authority off auth.uid().
    assert.ok(!/profileId|organizationId|retailerId|membershipId|userId/.test(source));
  });
});

describe("6. the client obeys the backend's retry flag", () => {
  test("the panel gates the retry control on shouldOfferRetry alone", () => {
    const source = code(PANEL);
    assert.match(source, /shouldOfferRetry\(view\) &&/);
  });

  test("the panel never does attempt arithmetic", () => {
    const source = executable(PANEL);
    assert.ok(
      !/attemptsRemaining\s*[><=]|attemptsUsed\s*[><=]|MAX_EXTRACTION_ATTEMPTS/.test(source),
      "the panel re-derives the attempt budget",
    );
  });

  test("the retry action does not second-guess retry_allowed either", () => {
    const source = executable(ACTIONS);
    assert.ok(!/retryAllowed|retry_allowed/.test(source));
  });
});

describe("7. the submission id reaches the browser on the submitted branch alone", () => {
  test("the success branch carries the reservation's id", () => {
    assert.match(
      code(SUBMIT_ACTIONS),
      /extractionSubmissionId:\s*\n?\s*submission\.status === "submitted" \? submission\.submissionId : null/,
    );
  });

  test("every other branch carries null", () => {
    const source = code(SUBMIT_ACTIONS);
    // The two partial successes and the shared failure builder must all be null: no
    // attempt exists in any of them, so a progress panel would be a false statement.
    const nulls = source.match(/extractionSubmissionId:\s*null/g) ?? [];
    assert.ok(nulls.length >= 3, `expected at least 3 null branches, found ${nulls.length}`);
  });

  test("the panel is rendered only when that id is present", () => {
    assert.match(code(SUBMIT_FORM), /state\.extractionSubmissionId &&/);
  });

  test("the panel is keyed on the id, so a second receipt starts a fresh run", () => {
    assert.match(code(SUBMIT_FORM), /key=\{state\.extractionSubmissionId\}/);
  });

  test("no bucket, path or hash accompanies it", () => {
    const source = code(SUBMIT_ACTIONS);
    const stateShape = /case "submitted":[\s\S]*?\};/.exec(source);
    assert.ok(stateShape !== null);
    assert.ok(!/bucket|objectPath|sha256|storage/i.test(stateShape[0]));
  });
});

describe("8. lifecycle safety is structural", () => {
  test("there is no setInterval anywhere on the path", () => {
    for (const file of WEB_EXTRACTION_FILES) {
      assert.ok(!executable(file).includes("setInterval"), `${file} uses setInterval`);
    }
  });

  test("the panel cancels its run on cleanup", () => {
    const source = code(PANEL);
    assert.match(source, /return \(\) => \{\s*cancelled = true;\s*\};/);
  });

  test("the panel guards against a superseded run with a generation counter", () => {
    const source = code(PANEL);
    assert.match(source, /runRef\.current !== myRun/);
  });

  test("the loop checks cancellation after every suspension point", () => {
    const source = code(POLL_LOOP);
    const checks = source.match(/if \(ports\.isCancelled\(\)\) return;/g) ?? [];
    // Before the first poll, after the poll, and after the inter-poll wait.
    assert.equal(checks.length, 3);
  });
});

describe("9. money is formatted from the currency's own minor unit", () => {
  test("two-decimal currencies render as printed", () => {
    assert.equal(formatMinorAmount(123456, "AED", 2), "AED 1234.56");
  });

  test("a zero-decimal currency is not given decimals", () => {
    // The bug this function exists to prevent: 1234 yen is not 12.34.
    assert.equal(formatMinorAmount(1234, "JPY", 0), "JPY 1234");
  });

  test("a three-decimal currency keeps all three", () => {
    assert.equal(formatMinorAmount(1234567, "KWD", 3), "KWD 1234.567");
  });

  test("small amounts are zero-padded rather than truncated", () => {
    assert.equal(formatMinorAmount(5, "AED", 2), "AED 0.05");
    assert.equal(formatMinorAmount(0, "AED", 2), "AED 0.00");
  });

  test("an unknown minor unit renders NOTHING rather than assuming two", () => {
    // Guessing would show a confident wrong number the person cannot detect.
    assert.equal(formatMinorAmount(123456, "AED", null), null);
  });

  test("a missing amount or currency renders nothing", () => {
    assert.equal(formatMinorAmount(null, "AED", 2), null);
    assert.equal(formatMinorAmount(123456, null, 2), null);
  });

  test("a nonsensical scale is refused", () => {
    assert.equal(formatMinorAmount(1, "AED", -1), null);
    assert.equal(formatMinorAmount(1, "AED", 9), null);
  });

  test("the code is normalized and the amount is never localized", () => {
    assert.equal(formatMinorAmount(100000, " aed ", 2), "AED 1000.00");
    // No thousands separator: grouping depends on a locale this app does not establish.
    assert.ok(!formatMinorAmount(100000, "AED", 2)!.includes(","));
  });
});
