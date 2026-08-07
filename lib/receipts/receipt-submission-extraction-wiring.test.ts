/**
 * SOURCE-LEVEL GUARDS FOR THE SUBMISSION → EXTRACTION WIRING.
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * The reading milestone shipped with every unit covered and the INTEGRATION uncovered:
 * the provider, the normalization, the configuration and the SQL contract all had tests,
 * and none of them could tell that the web application never called the endpoint at all.
 * A green suite reported a feature that had never once run.
 *
 * The behaviour is asserted next door, in ./receipt-submission-extraction-flow.test.ts,
 * against a fake port. What CANNOT be observed at runtime from Node — the Server Action
 * imports `next/headers`, and the request module reaches the network — is asserted here
 * from the source itself: the exact function name, the exact body, the token that is
 * forwarded, the absence of a service-role client, the absence of a retry, and the fact
 * that no id reaches the browser.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the
 * exact shapes that would constitute a regression, naming the file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTRACTION_REQUEST_FIELDS } from "./receipt-extraction-request-contract.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ACTION = "app/(retailer)/retailer/receipts/actions.ts";
const STATE = "app/(retailer)/retailer/receipts/submit-receipt-state.ts";
const FORM = "app/(retailer)/retailer/receipts/submit-receipt-form.tsx";
const PAGE = "app/(retailer)/retailer/receipts/page.tsx";
const REQUEST_MODULE = "lib/receipts/receipt-extraction-request.ts";
/** The web's one caller of the read function, added by the polling milestone. */
const POLL_MODULE = "lib/receipts/receipt-extraction-poll-request.ts";
const FLOW = "lib/receipts/receipt-submission-extraction-flow.ts";
const ELIGIBILITY = "lib/receipts/receipt-extraction-eligibility.ts";
const SUBMISSION_FLOW = "lib/receipts/receipt-submission-flow.ts";

/** Every file that participates in initiating a reading from the web application. */
const WIRING = [ACTION, REQUEST_MODULE, FLOW, ELIGIBILITY, SUBMISSION_FLOW];

/** The whole web application, for the rules that must hold EVERYWHERE and not just here. */
const WEB_ROOTS = ["app", "components", "lib"];

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function code(path: string): string {
  return stripComments(read(path));
}

/** Every production `.ts`/`.tsx` file under the web roots, tests excluded. */
function webSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(next);
      }
    }
  };
  for (const root of WEB_ROOTS) walk(root);
  return out;
}

const WEB_SOURCES = webSources();
const CONFIG = read("supabase/config.toml");

describe("1. the wiring exists at all — the defect this milestone repairs", () => {
  test("the Server Action reaches the request module", () => {
    assert.match(
      code(ACTION),
      /from "@\/lib\/receipts\/receipt-extraction-request"/,
      "the Server Action does not import the extraction request module",
    );
    assert.match(
      code(ACTION),
      /requestReceiptExtraction/,
      "the Server Action never calls the extraction request",
    );
  });

  test("the request module posts to a Supabase Edge Function", () => {
    assert.match(code(REQUEST_MODULE), /functions\/v1\//);
  });

  test("the wiring is reachable only from a stored receipt", () => {
    // The pure flow is the only caller of the port, and it is guarded on `submitted`.
    assert.match(
      code(FLOW),
      /submission\.status !== "submitted"/,
      "the flow no longer gates the request on a stored receipt",
    );
  });
});

describe("2. the exact function name, declared once", () => {
  const NAME = "request-receipt-extraction";

  test("the name is declared in exactly one web module", () => {
    const holders = WEB_SOURCES.filter((path) => code(path).includes(NAME));
    assert.deepEqual(holders, [REQUEST_MODULE]);
  });

  test("it appears exactly once inside that module", () => {
    const occurrences = code(REQUEST_MODULE).split(NAME).length - 1;
    assert.equal(occurrences, 1, `declared ${occurrences} times`);
  });

  test("it matches a deployed function block in supabase/config.toml", () => {
    assert.match(CONFIG, new RegExp(`\\[functions\\.${NAME}\\][\\s\\S]{0,200}?enabled = true`));
  });

  test("the polling function IS now called from the web — the follow-up landed", () => {
    // THIS ASSERTION USED TO SAY THE OPPOSITE, and said so deliberately: the milestone
    // that shipped the request left the reading unwatched and named this line as the place
    // that would announce the change. This is that change.
    //
    // It matters more than a scope note. `get-receipt-extraction` is not a passive status
    // read — calling it is what polls the provider for a PROCESSING attempt and records
    // the terminal row. While nothing on the web called it, a web-submitted receipt could
    // reach PROCESSING and stay there until the reaper marked it WORKER_ABANDONED. So the
    // assertion is inverted rather than deleted: the web MUST hold a caller.
    const holders = WEB_SOURCES.filter((path) => code(path).includes("get-receipt-extraction"));

    assert.deepEqual(
      holders,
      [POLL_MODULE],
      "exactly one web module may name the polling function",
    );
  });
});

describe("3. the exact request payload", () => {
  test("the body is the one field the endpoint's allowlist declares", () => {
    assert.deepEqual([...EXTRACTION_REQUEST_FIELDS], ["submission_id"]);
    assert.match(
      code(REQUEST_MODULE),
      /body: JSON\.stringify\(\{ submission_id: submissionId \}\)/,
    );
  });

  test("nothing else is serialized into a request body here", () => {
    const bodies = [...code(REQUEST_MODULE).matchAll(/JSON\.stringify\(([\s\S]*?)\)/g)];
    assert.equal(bodies.length, 1, "more than one body is built");
    for (const forbidden of [
      "shopId",
      "sha256",
      "objectPath",
      "bucket",
      "mimeType",
      "fileName",
      "mode",
      "fixture",
      "provider",
      "model",
    ]) {
      assert.ok(!bodies[0][1].includes(forbidden), `the body carries ${forbidden}`);
    }
  });
});

describe("4. the caller's own session, and never a service-role key", () => {
  test("the user's access token is forwarded as the bearer", () => {
    const source = code(REQUEST_MODULE);
    assert.match(source, /auth\.getSession\(\)/);
    assert.match(source, /Authorization: `Bearer \$\{accessToken\}`/);
  });

  test("no module on this path constructs a service-role client", () => {
    for (const path of WIRING) {
      assert.ok(!code(path).includes("createAdminClient"), `${path} builds an admin client`);
      assert.ok(
        !code(path).includes("SUPABASE_SERVICE_ROLE_KEY"),
        `${path} reads the service-role key`,
      );
      assert.ok(
        !code(path).includes("@/lib/supabase/admin"),
        `${path} imports the admin client`,
      );
    }
  });

  test("no module on this path uses an anonymous or key-only request", () => {
    // The publishable key rides along as the gateway's `apikey`, which is what it is for.
    // What must never happen is a request that carries it INSTEAD of the caller's token.
    const source = code(REQUEST_MODULE);
    const authAt = source.indexOf("Authorization:");
    const apikeyAt = source.indexOf("apikey:");
    assert.ok(authAt > 0 && apikeyAt > authAt, "the request is not caller-authenticated");
  });

  test("the request is refused before it is sent when there is no session", () => {
    assert.match(
      code(REQUEST_MODULE),
      /typeof accessToken !== "string"[\s\S]{0,240}?return \{ status: "unavailable" \}/,
    );
  });
});

describe("5. the canonical id, and only the canonical id", () => {
  test("the submitted result carries the reservation's own id", () => {
    assert.match(
      code(SUBMISSION_FLOW),
      /return \{ status: "submitted", submissionId: reserved\.submissionId \}/,
    );
  });

  test("no failure variant carries an id", () => {
    const failures = code(SUBMISSION_FLOW).match(/return \{ status: "(?!submitted")[^}]*\}/g);
    for (const variant of failures ?? []) {
      assert.ok(!variant.includes("submissionId"), variant);
    }
  });

  test("the Server Action never reads a submission id from the form", () => {
    const source = code(ACTION);
    for (const forbidden of [
      'formData.get("submissionId")',
      'formData.get("submission_id")',
      'formData.get("receiptId")',
      'formData.get("extractionId")',
    ]) {
      assert.ok(!source.includes(forbidden), `the action trusts ${forbidden}`);
    }
    // Exhaustive rather than illustrative: the browser influences two names, and neither
    // of them is an id of anything the database created.
    const reads = [...source.matchAll(/formData\.get(?:All)?\(\s*"([^"]+)"\s*\)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual([...new Set(reads)].sort(), ["receipt", "shopId"]);
  });

  test("the id passed to the port comes from the submission result", () => {
    assert.match(
      code(FLOW),
      /submissionId: submission\.submissionId/,
      "the flow does not use the database's id",
    );
  });
});

describe("6. the submission id reaches the browser on ONE branch, and carries nothing with it", () => {
  // THIS SECTION USED TO ASSERT THAT NO ID REACHED THE BROWSER AT ALL, which was the right
  // rule while the web had no use for one: it asked for a reading and stopped. Polling
  // changes the requirement, because `get-receipt-extraction` is keyed on a submission id
  // and calling it is what finalizes an attempt. The browser must hold the id of the
  // receipt it just submitted or the reading is never completed by anyone.
  //
  // So the rule is NARROWED rather than dropped. What still must hold, and is asserted
  // below: the id appears on the success branch alone, no other identifier or storage
  // detail travels with it, and the id itself is never rendered as text.
  //
  // The widening grants nothing. assert_my_receipt_extraction_access requires
  // `submitted_by_profile_id = auth.uid()`, so the only id useful to a person is one for a
  // receipt they submitted; naming another returns `not-found`, byte-identically to naming
  // one that does not exist.

  test("the browser-visible state exposes the submission id and no other identifier", () => {
    const source = code(STATE);
    assert.ok(
      source.includes("extractionSubmissionId"),
      "the state must carry the id the panel polls with",
    );
    for (const forbidden of ["extractionId", "submission_id", "profileId", "organizationId"]) {
      assert.ok(!source.includes(forbidden), `SubmitReceiptState exposes ${forbidden}`);
    }
  });

  test("only the `submitted` branch carries a non-null id", () => {
    const source = code(ACTION);
    assert.match(
      source,
      /extractionSubmissionId:\s*\n?\s*submission\.status === "submitted" \? submission\.submissionId : null/,
      "the id is not gated on a stored receipt with an open attempt",
    );
    // Every other returned state pins it to null: a duplicate, a refusal, an upload
    // failure, an unsupported image and a reading that could not start all have no
    // attempt to follow, and a progress panel there would be a false statement.
    const nulls = source.match(/extractionSubmissionId:\s*null/g) ?? [];
    assert.ok(nulls.length >= 3, `expected at least 3 null branches, found ${nulls.length}`);
  });

  test("no returned state carries a bucket, path or hash alongside it", () => {
    for (const block of code(ACTION).split("return {").slice(1)) {
      const literal = block.slice(0, block.indexOf("};"));
      for (const forbidden of ["objectPath", "bucket", "sha256", "storage", "submission_id"]) {
        assert.ok(!literal.includes(forbidden), `${forbidden} in: ${literal}`);
      }
    }
  });

  test("the form passes the id to the panel and never renders it as text", () => {
    const source = code(FORM);
    // Handed to a component as a prop and used as a React key — both structural uses.
    assert.match(source, /submissionId=\{state\.extractionSubmissionId\}/);
    assert.match(source, /key=\{state\.extractionSubmissionId\}/);
    // Never interpolated into visible copy.
    assert.ok(
      !/\{state\.extractionSubmissionId\}\s*</.test(source),
      "the form renders the raw id as text",
    );
    assert.ok(!code(PAGE).includes("submission_id"), "the page renders a raw id");
  });
});

describe("7. one request, never a retry", () => {
  test("the request module contains no loop and no re-invocation", () => {
    const source = code(REQUEST_MODULE);
    for (const forbidden of [/\bfor\s*\(/, /\bwhile\s*\(/, /\bsetTimeout\b/, /\bretry/i]) {
      assert.ok(!forbidden.test(source), `${REQUEST_MODULE} matches ${forbidden}`);
    }
    assert.equal(source.split("fetch(").length - 1, 1, "more than one request is sent");
  });

  test("the flow calls the port at most once, from one place", () => {
    const source = code(FLOW);
    assert.equal(
      source.split("ports.requestExtraction").length - 1,
      1,
      "the port is called from more than one place",
    );
    for (const forbidden of [/\bfor\s*\(/, /\bwhile\s*\(/, /\bcatch\b/]) {
      assert.ok(!forbidden.test(source), `${FLOW} matches ${forbidden}`);
    }
  });

  test("the Server Action calls the request exactly once and AWAITS it", () => {
    const source = code(ACTION);
    // Once as an import, once as the call. Anything else is a second initiation path.
    assert.equal(source.split("runReceiptSubmissionOutcome").length - 1, 2);
    assert.equal(
      (source.match(/await runReceiptSubmissionOutcome\(/g) ?? []).length,
      1,
      "the outcome is not awaited exactly once — a detached promise may be abandoned",
    );
    assert.match(source, /const result = await runReceiptSubmissionOutcome\(/);
    // A fire-and-forget shape is the specific defect this asserts against.
    assert.ok(!/void\s+requestReceiptExtraction/.test(source));
    assert.ok(!/requestReceiptExtraction\([^)]*\)\s*\.then/.test(source));
  });
});

describe("8. no direct access to the reading's own tables", () => {
  test("no web module names receipt_extractions or its line items", () => {
    for (const path of WEB_SOURCES) {
      const source = code(path);
      for (const table of ["receipt_extractions", "receipt_extraction_line_items"]) {
        assert.ok(!source.includes(table), `${path} names ${table}`);
      }
    }
  });

  test("no web module calls a worker or extraction RPC directly", () => {
    const RPCS = [
      "request_receipt_extraction",
      "claim_receipt_extraction_job",
      "record_receipt_extraction_operation",
      "record_receipt_extraction_success",
      "record_receipt_extraction_failure",
      "get_receipt_extraction_worker_state",
      "expire_stale_receipt_extraction_claims",
    ];
    for (const path of WEB_SOURCES) {
      const source = code(path);
      for (const rpc of RPCS) {
        assert.ok(!source.includes(rpc), `${path} calls ${rpc} directly`);
      }
    }
  });

  test("no module on this path opens a table or a bucket", () => {
    for (const path of WIRING) {
      const source = code(path);
      assert.ok(!/\.from\s*\(\s*["'`]/.test(source), `${path} reads a table directly`);
      assert.ok(!/\.storage\b/.test(source), `${path} touches Storage`);
    }
  });
});

describe("9. nothing from the reader reaches the web application", () => {
  test("the request module reads two response fields and no more", () => {
    const source = code(REQUEST_MODULE);
    const fields = [...source.matchAll(/record\.(\w+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(fields)].sort(), ["outcome", "status"]);
  });

  test("no extracted value, confidence or provider detail is named", () => {
    for (const path of WIRING) {
      const source = code(path);
      for (const forbidden of [
        "merchant_name",
        "total_minor",
        "line_item",
        "confidence",
        "source_text",
        "azure",
        "AZURE_DI",
        "cognitiveservices",
        "apim-request-id",
      ]) {
        assert.ok(
          !source.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} names ${forbidden}`,
        );
      }
    }
  });

  test("the outcome union carries statuses only", () => {
    assert.match(code(FLOW), /export type ExtractionRequestOutcome =/);
    const union = /export type ExtractionRequestOutcome =([\s\S]*?);/.exec(code(FLOW));
    assert.ok(union, "the union was not found");
    assert.deepEqual(
      [...union[1].matchAll(/status: "([^"]+)"/g)].map((match) => match[1]).sort(),
      ["requested", "unavailable"],
    );
  });
});

describe("10. failures are logged as categories, never as content", () => {
  test("the request module logs through one helper, with literals only", () => {
    const lines = code(REQUEST_MODULE)
      .split("\n")
      .filter((line) => /console\./.test(line));
    assert.equal(lines.length, 1, `expected one logging chokepoint, found ${lines.length}`);

    // Call sites only — the helper's own declaration is skipped, since its parameter list
    // is a signature rather than a logged value.
    const calls = [
      ...code(REQUEST_MODULE).matchAll(/(?<!function )logExtractionRequestFailure\(([^)]*)\)/g),
    ].map((match) => match[1].trim());

    assert.ok(calls.length >= 4, `expected several call sites, found ${calls.length}`);
    for (const argument of calls) {
      assert.ok(argument.startsWith('"'), `logs a non-literal: ${argument}`);
    }
  });

  test("no error, response, token or id is ever interpolated into a log", () => {
    const line = code(REQUEST_MODULE)
      .split("\n")
      .find((candidate) => /console\./.test(candidate)) as string;
    for (const expression of [...line.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim())) {
      assert.equal(expression, "category", `logs ${expression}`);
    }
  });

  test("no thrown value is bound anywhere on this path", () => {
    for (const path of WIRING) {
      assert.ok(
        !/catch\s*\(\s*\w+\s*\)/.test(code(path)),
        `${path} binds a caught value, which can carry request detail`,
      );
    }
  });
});

describe("11. the partial success is a success", () => {
  test("the stored-but-unread outcomes return a successMessage and no formError", () => {
    const source = code(ACTION);
    for (const status of [
      "submitted-extraction-unstarted",
      "submitted-extraction-skipped",
    ]) {
      const branch = new RegExp(
        `case "${status}":[\\s\\S]*?return \\{([\\s\\S]*?)\\n {6}\\};`,
      ).exec(source);
      assert.ok(branch, `${status} has no branch`);
      assert.match(branch[1], /formError: null/, `${status} reports an error`);
      assert.match(branch[1], /successMessage: RECEIPT_EXTRACTION_/, status);
    }
  });

  test("neither uses the upload-failure or the generic-error sentence", () => {
    const source = code(ACTION);
    const branches = /case "submitted-extraction-unstarted":[\s\S]*?case "duplicate":/.exec(
      source,
    );
    assert.ok(branches, "the partial-success branches were not found");
    assert.ok(!branches[0].includes("UPLOAD_FAILED_ERROR"), branches[0]);
    assert.ok(!branches[0].includes("GENERIC_ERROR"), branches[0]);
  });

  test("the exact sentence the milestone requires is the one that ships", () => {
    assert.match(
      read(STATE),
      /"Receipt submitted successfully, but automatic data extraction could not be started\."/,
    );
  });

  test("nothing on this path deletes, rolls back, or re-marks a stored receipt", () => {
    for (const path of [ACTION, FLOW, REQUEST_MODULE]) {
      const source = code(path);
      for (const forbidden of [
        "removeObject",
        "recordFailure",
        "record_receipt_submission_upload_failure",
        ".remove(",
        ".delete(",
      ]) {
        assert.ok(!source.includes(forbidden), `${path} can undo a stored receipt`);
      }
    }
  });
});

describe("12. the eligibility gate runs BEFORE anything is asked", () => {
  test("the gate is consulted in the flow, ahead of the port", () => {
    const source = code(FLOW);
    const gateAt = source.indexOf("classifyExtractionEligibility");
    const portAt = source.indexOf("ports.requestExtraction");
    assert.ok(gateAt > 0, "the gate is not consulted");
    assert.ok(portAt > gateAt, "the request is made before the gate is consulted");
  });

  test("an ineligible image returns without reaching the port", () => {
    assert.match(
      code(FLOW),
      /eligibility\.status !== "eligible"[\s\S]{0,320}?return \{[\s\S]{0,160}?"submitted-extraction-skipped"/,
    );
  });

  test("the user-facing sentence is honest about what did not happen", () => {
    const sentence = read(STATE);
    assert.match(sentence, /was not started/);
    // It must not claim a reading is under way, and it must not read as a failure.
    assert.ok(!/is being read|we are reading|extraction started/i.test(sentence));
  });
});
