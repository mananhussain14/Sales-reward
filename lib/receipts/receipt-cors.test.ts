/**
 * BEHAVIOURAL TESTS for the one CORS policy the `submit-receipt` Edge Function uses.
 *
 * Run with:  npm test
 *
 * ./receipt-edge-function-safety.test.ts can only read the Edge Function's SOURCE, because
 * that file calls `Deno.serve` and cannot be imported from Node. This module can be
 * imported, so the policy is exercised as a real `Response` here — the headers asserted
 * below are the bytes a browser will actually receive, not a string that looks like them.
 *
 * WHAT WENT WRONG, AND WHAT EACH RULE HOLDS SHUT
 * A Flutter Web build's preflight succeeded and the POST that followed was blocked: the
 * allowed-request-header list named `authorization` and `content-type` while the Supabase
 * client also sends `apikey` and `x-client-info`. ONE unlisted header fails the whole
 * preflight, so the browser discarded a response the function had already produced.
 *
 *   §1  the preflight answers 204 with the full policy;
 *   §2  every header a real Supabase client sends is allowed — the actual regression;
 *   §3  both methods the endpoint answers are advertised;
 *   §4  EVERY outcome, including the unexpected-error reply, carries the headers;
 *   §5  credentials stay off, which is what keeps the wildcard origin safe;
 *   §6  the policy is one object, and a caller cannot mutate it for everyone else.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_ORIGIN,
  CORS_ALLOWED_REQUEST_HEADERS,
  corsJsonResponse,
  corsPreflightResponse,
  receiptCorsHeaders,
} from "./receipt-cors.ts";

/**
 * The headers a browser must see before it will hand a cross-origin response to the page
 * that asked for it.
 */
const ORIGIN = "Access-Control-Allow-Origin";
const METHODS = "Access-Control-Allow-Methods";
const HEADERS = "Access-Control-Allow-Headers";

/** Splits a comma-separated header value into lowercase tokens. */
function tokens(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * The complete response vocabulary of the Edge Function, with the HTTP status each maps
 * to — copied from the `switch` in supabase/functions/submit-receipt/index.ts.
 * ./receipt-edge-function-safety.test.ts holds that vocabulary closed and asserts that
 * every member of it is returned through the shared helper, so the coverage below cannot
 * silently go stale.
 */
const MAPPED_RESPONSES: ReadonlyArray<{ status: string; httpStatus: number }> = [
  { status: "submitted", httpStatus: 200 },
  { status: "invalid", httpStatus: 400 },
  { status: "unauthenticated", httpStatus: 401 },
  { status: "denied", httpStatus: 403 },
  { status: "invalid", httpStatus: 405 },
  { status: "duplicate", httpStatus: 409 },
  { status: "upload-failed", httpStatus: 502 },
  // Both the configuration gap AND the top-level catch that turns an unexpected throw
  // into a readable reply instead of a header-less runtime 500.
  { status: "unavailable", httpStatus: 503 },
];

describe("1. the preflight", () => {
  test("answers 204 with no body", async () => {
    const response = corsPreflightResponse();
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "", "a 204 must carry no body");
  });

  test("allows the requesting origin", () => {
    assert.equal(corsPreflightResponse().headers.get(ORIGIN), CORS_ALLOWED_ORIGIN);
    assert.equal(CORS_ALLOWED_ORIGIN, "*", "the policy is not origin-restricted");
  });
});

describe("2. the allowed request headers cover a real Supabase client", () => {
  /**
   * The regression. `apikey` and `x-client-info` are sent by the Supabase JS and Dart
   * clients on every call including `functions.invoke`; omitting either failed the
   * preflight and blocked the POST.
   */
  const REQUIRED = ["authorization", "apikey", "x-client-info", "content-type"];

  test("the preflight lists every header the client sends", () => {
    const allowed = tokens(corsPreflightResponse().headers.get(HEADERS));
    for (const header of REQUIRED) {
      assert.ok(
        allowed.includes(header),
        `"${header}" is not allowed; a browser will fail the preflight and block the POST`,
      );
    }
  });

  test("the exported list and the emitted header agree", () => {
    assert.deepEqual(
      tokens(corsPreflightResponse().headers.get(HEADERS)),
      CORS_ALLOWED_REQUEST_HEADERS.map((header) => header.toLowerCase()),
      "the emitted header is not the declared list",
    );
    for (const header of REQUIRED) {
      assert.ok(
        (CORS_ALLOWED_REQUEST_HEADERS as readonly string[]).includes(header),
        `"${header}" was removed from the declared list`,
      );
    }
  });

  test("no header is listed twice or carries stray whitespace", () => {
    const raw = corsPreflightResponse().headers.get(HEADERS) ?? "";
    const list = tokens(raw);
    assert.equal(new Set(list).size, list.length, `duplicated entries in "${raw}"`);
    assert.ok(!/,\s*,|^\s|\s$/.test(raw), `malformed header list: "${raw}"`);
  });
});

describe("3. the allowed methods", () => {
  test("advertise POST and OPTIONS", () => {
    const methods = tokens(corsPreflightResponse().headers.get(METHODS));
    assert.ok(methods.includes("post"), "POST is not advertised — submissions are blocked");
    assert.ok(methods.includes("options"), "OPTIONS is not advertised");
  });

  test("advertise nothing the endpoint does not answer", () => {
    // The function refuses anything but POST with a 405 regardless; advertising a method
    // it will not serve invites a browser to try one.
    assert.deepEqual(
      tokens(corsPreflightResponse().headers.get(METHODS)),
      CORS_ALLOWED_METHODS.map((method) => method.toLowerCase()),
    );
    assert.equal(CORS_ALLOWED_METHODS.length, 2);
  });
});

describe("4. every outcome is readable by the browser", () => {
  for (const { status, httpStatus } of MAPPED_RESPONSES) {
    test(`\`${status}\` (${httpStatus}) carries the CORS headers`, async () => {
      const response = corsJsonResponse({ status }, httpStatus);

      assert.equal(response.status, httpStatus);
      assert.equal(response.headers.get(ORIGIN), CORS_ALLOWED_ORIGIN, "no allowed origin");
      assert.deepEqual(
        tokens(response.headers.get(HEADERS)),
        tokens(corsPreflightResponse().headers.get(HEADERS)),
        "the response policy differs from the preflight policy",
      );
      assert.deepEqual(
        tokens(response.headers.get(METHODS)),
        tokens(corsPreflightResponse().headers.get(METHODS)),
      );
      assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
      assert.deepEqual(await response.json(), { status });
    });
  }

  test("the success payload passes through untouched", async () => {
    const response = corsJsonResponse(
      { status: "submitted", submission_id: "b1a3f1e2-0000-4000-8000-000000000000" },
      200,
    );
    assert.equal(response.headers.get(ORIGIN), CORS_ALLOWED_ORIGIN);
    assert.deepEqual(await response.json(), {
      status: "submitted",
      submission_id: "b1a3f1e2-0000-4000-8000-000000000000",
    });
  });

  test("the helper adds nothing to the body", async () => {
    // The CORS layer must not widen the closed response vocabulary the Edge Function
    // owns — no echoed origin, no diagnostic, no provider text.
    assert.deepEqual(Object.keys(await corsJsonResponse({ status: "denied" }, 403).json()), [
      "status",
    ]);
  });
});

describe("5. no ambient credentials", () => {
  /**
   * `Access-Control-Allow-Credentials: true` is the one header that would make a wildcard
   * origin dangerous: it tells the browser to attach cookies to a cross-origin request and
   * to let the calling page read the reply. This endpoint is bearer-token only.
   */
  test("the credentials header is absent everywhere", () => {
    const responses = [
      corsPreflightResponse(),
      ...MAPPED_RESPONSES.map(({ status, httpStatus }) =>
        corsJsonResponse({ status }, httpStatus),
      ),
    ];
    for (const response of responses) {
      assert.equal(
        response.headers.get("Access-Control-Allow-Credentials"),
        null,
        `credentials are enabled on the ${response.status} response`,
      );
    }
    assert.ok(
      !Object.keys(receiptCorsHeaders()).some((name) => /credential/i.test(name)),
      "the header map declares a credentials header",
    );
  });
});

describe("6. one policy, and it cannot be mutated", () => {
  test("the preflight and a JSON reply are built from the same map", () => {
    const preflight = corsPreflightResponse().headers;
    const reply = corsJsonResponse({ status: "unavailable" }, 503).headers;
    for (const name of Object.keys(receiptCorsHeaders())) {
      assert.equal(
        preflight.get(name),
        reply.get(name),
        `"${name}" differs between the preflight and a JSON reply`,
      );
    }
  });

  test("each call returns a fresh object", () => {
    const first = receiptCorsHeaders();
    first[ORIGIN] = "https://attacker.invalid";
    delete first[HEADERS];

    assert.equal(receiptCorsHeaders()[ORIGIN], CORS_ALLOWED_ORIGIN, "the map is shared state");
    assert.equal(corsPreflightResponse().headers.get(ORIGIN), CORS_ALLOWED_ORIGIN);
    assert.ok(corsPreflightResponse().headers.get(HEADERS), "the allowed-header list was lost");
  });

  test("the preflight is cacheable, so a submission costs one round trip after the first", () => {
    const maxAge = Number(corsPreflightResponse().headers.get("Access-Control-Max-Age"));
    assert.ok(Number.isInteger(maxAge) && maxAge > 0, "no usable Access-Control-Max-Age");
  });
});
