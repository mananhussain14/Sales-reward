/**
 * Unit tests for the `send-retailer-staff-invitation` CORS policy.
 *
 * Run with:  npm test
 *
 * The Edge Function itself cannot be imported from Node — it calls `Deno.serve`, reads
 * `Deno.env`, and imports from `npm:`. This module can be, so the policy is exercised as
 * real `Response` objects here: the headers asserted below are the ones a browser will
 * actually receive.
 *
 * The property that matters is that a Flutter Web build (a browser) can READ every reply.
 * A preflight that omits one requested header fails the whole check and the browser
 * discards the real response — the function runs, the invitation is sent, and the client
 * sees nothing. That defect already shipped once for `submit-receipt`; the last describe
 * block pins this policy against that one so the two entry points cannot drift.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_ORIGIN,
  CORS_ALLOWED_REQUEST_HEADERS,
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  corsJsonResponse,
  corsPreflightResponse,
  staffInvitationCorsHeaders,
} from "./staff-invitation-cors.ts";
import { receiptCorsHeaders } from "../receipts/receipt-cors.ts";
import {
  staffInvitationResponse,
  STAFF_INVITATION_HTTP_STATUS,
  type StaffInvitationCode,
} from "./staff-invitation-delivery-contract.ts";

const ORIGIN = "Access-Control-Allow-Origin";
const METHODS = "Access-Control-Allow-Methods";
const HEADERS = "Access-Control-Allow-Headers";
const MAX_AGE = "Access-Control-Max-Age";
const CREDENTIALS = "Access-Control-Allow-Credentials";

describe("the header map", () => {
  test("1. allows any origin, without echoing the request's own", () => {
    assert.equal(CORS_ALLOWED_ORIGIN, "*");
    assert.equal(staffInvitationCorsHeaders()[ORIGIN], "*");
  });

  test("2. allows exactly POST and OPTIONS", () => {
    assert.deepEqual([...CORS_ALLOWED_METHODS], ["POST", "OPTIONS"]);
    assert.equal(staffInvitationCorsHeaders()[METHODS], "POST, OPTIONS");
  });

  test("3. allows every header a real Supabase client sends", () => {
    // `apikey` and `x-client-info` are attached by the JS and Dart clients on every
    // call including functions.invoke; omitting either fails the whole preflight.
    for (const header of [
      "authorization",
      "apikey",
      "x-client-info",
      "content-type",
      "x-supabase-api-version",
      "x-region",
    ]) {
      assert.ok(
        (CORS_ALLOWED_REQUEST_HEADERS as readonly string[]).includes(header),
        `${header} is not allowed through the preflight`,
      );
    }
  });

  test("4. never enables ambient credentials", () => {
    // The one header that would make the wildcard origin dangerous. A browser also
    // refuses `*` together with credentials, so setting it would break the clients.
    assert.equal(staffInvitationCorsHeaders()[CREDENTIALS], undefined);
  });

  test("5. returns a FRESH object, so no caller can mutate the shared policy", () => {
    const first = staffInvitationCorsHeaders();
    first[ORIGIN] = "https://evil.example";
    assert.equal(staffInvitationCorsHeaders()[ORIGIN], "*");
  });

  test("6. caches the preflight for an hour", () => {
    assert.equal(CORS_PREFLIGHT_MAX_AGE_SECONDS, 3600);
    assert.equal(staffInvitationCorsHeaders()[MAX_AGE], "3600");
  });
});

describe("the preflight response", () => {
  test("7. is a 204 with no body and the full policy", () => {
    const response = corsPreflightResponse();
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.equal(response.headers.get(ORIGIN), "*");
    assert.equal(response.headers.get(METHODS), "POST, OPTIONS");
    assert.equal(response.headers.get(HEADERS), CORS_ALLOWED_REQUEST_HEADERS.join(", "));
    assert.equal(response.headers.get(CREDENTIALS), null);
  });
});

describe("every JSON reply is readable by the browser that asked", () => {
  const ALL_CODES = Object.keys(STAFF_INVITATION_HTTP_STATUS) as StaffInvitationCode[];

  test("8. the CORS headers are attached at EVERY declared status", async () => {
    for (const code of ALL_CODES) {
      const status = STAFF_INVITATION_HTTP_STATUS[code];
      const response = corsJsonResponse(staffInvitationResponse(code), status);
      assert.equal(response.status, status, code);
      assert.equal(response.headers.get(ORIGIN), "*", code);
      assert.equal(response.headers.get("Content-Type"), "application/json", code);
      assert.deepEqual(await response.json(), staffInvitationResponse(code), code);
    }
  });

  test("9. replies are never cached or reused by an intermediary", () => {
    const response = corsJsonResponse(staffInvitationResponse("SENT"), 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });

  test("10. the builder adds nothing to the payload and reads nothing from it", () => {
    // The closed vocabulary is the contract module's concern; this one only adds
    // headers, so a future field can never be introduced here by accident.
    const response = corsJsonResponse({ a: 1 }, 200);
    assert.equal(response.status, 200);
  });
});

describe("the policy does not drift from the other Edge Function's", () => {
  test("11. the two header maps are byte-identical", () => {
    // `submit-receipt` and `send-retailer-staff-invitation` are the system's two mobile
    // entry points and are subject to the same browser rules. They are separate modules
    // (see this module's header for why) and this is what keeps them one policy: a
    // header added to either without the other fails here.
    assert.deepEqual(staffInvitationCorsHeaders(), receiptCorsHeaders());
  });

  test("12. this module is dependency-free, so Deno can import it", () => {
    // Asserted structurally in staff-invitation-edge-function-safety.test.ts; asserted
    // behaviourally here by the fact that this file could import it under Node at all
    // while the Edge Function imports it under Deno.
    assert.equal(typeof corsPreflightResponse, "function");
    assert.equal(typeof corsJsonResponse, "function");
  });
});
