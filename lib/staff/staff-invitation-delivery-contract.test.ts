/**
 * Unit tests for the SHARED staff-invitation delivery contract.
 *
 * Run with:  npm test
 *
 * This is the file that decides what the web portal and the Flutter app may send and
 * what they will be told, so it is tested as a contract rather than as a helper:
 *
 *   1. INPUT VALIDATION — every rejection the milestone requires, each one asserted to
 *      produce a stable code rather than a thrown error or a silently-ignored field.
 *   2. THE CLOSED RESPONSE SHAPE — three fields, a pinned version, one HTTP status per
 *      code, and nothing that could carry backend or provider text.
 *   3. THE PARTIAL-SUCCESS SEMANTICS — the outcome that must never look like a failure.
 *
 * The module is pure, so everything here is exact-value assertion with no fakes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isStaffInvitationCode,
  isStaffInvitationSendingEnabled,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_REQUEST_BYTES,
  MAX_SHOP_SELECTION,
  parseStaffInvitationRequest,
  RETAILER_MANAGER_ROLE,
  RETAILER_STAFF_INVITATIONS_ENABLED_VALUE,
  SALES_STAFF_ROLE,
  staffInvitationOutcomeFor,
  staffInvitationResponse,
  STAFF_INVITATION_CONTRACT_VERSION,
  STAFF_INVITATION_HTTP_STATUS,
  STAFF_INVITATION_REQUEST_FIELDS,
  type StaffInvitationCode,
} from "./staff-invitation-delivery-contract.ts";

const SHOP_A = "11111111-1111-4111-8111-111111111111";
const SHOP_B = "22222222-2222-4222-8222-222222222222";

/** A valid Sales Staff request. Cases below vary exactly one thing from it. */
function salesStaff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    roleCode: SALES_STAFF_ROLE,
    shopIds: [SHOP_A],
    ...overrides,
  };
}

/** A valid Retailer Manager request — no shops, and the field is still required. */
function manager(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: "Grace",
    lastName: "Hopper",
    email: "grace@example.com",
    roleCode: RETAILER_MANAGER_ROLE,
    shopIds: [],
    ...overrides,
  };
}

/* ===========================================================================
 * 1. INPUT VALIDATION
 * ========================================================================= */

describe("parseStaffInvitationRequest — the two valid shapes", () => {
  test("1. a valid Sales Staff request is accepted and canonicalized", () => {
    const result = parseStaffInvitationRequest(
      salesStaff({
        firstName: "  Ada  ",
        email: "  Ada@Example.COM ",
        roleCode: " sales_staff ",
        shopIds: [SHOP_B.toUpperCase(), SHOP_A],
      }),
    );

    assert.ok(result.ok);
    assert.deepEqual(result.request, {
      // Names are trimmed but NEVER case-folded: "de Silva" is not "De Silva".
      firstName: "Ada",
      lastName: "Lovelace",
      // The email is lower-cased, matching the database's canonical-email constraint.
      email: "ada@example.com",
      roleCode: "SALES_STAFF",
      // Shop ids are lower-cased and sorted, so checkbox order cannot change the request.
      shopIds: [SHOP_A, SHOP_B].sort(),
    });
  });

  test("2. a valid Retailer Manager request is accepted with an EMPTY shop list", () => {
    const result = parseStaffInvitationRequest(manager());
    assert.ok(result.ok);
    assert.deepEqual(result.request.shopIds, []);
    assert.equal(result.request.roleCode, "RETAILER_MANAGER");
  });

  test("3. many shops are accepted, up to the declared cap", () => {
    const shopIds = Array.from({ length: MAX_SHOP_SELECTION }, (_, index) =>
      `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    assert.ok(parseStaffInvitationRequest(salesStaff({ shopIds })).ok);
  });
});

describe("parseStaffInvitationRequest — names", () => {
  test("4. a missing name is refused", () => {
    for (const key of ["firstName", "lastName"]) {
      const body = salesStaff();
      delete body[key];
      assert.deepEqual(parseStaffInvitationRequest(body), {
        ok: false,
        code: "INVALID_REQUEST",
      });
    }
  });

  test("5. a blank or whitespace-only name is refused", () => {
    for (const key of ["firstName", "lastName"]) {
      for (const value of ["", "   ", "\t\n"]) {
        assert.equal(
          parseStaffInvitationRequest(salesStaff({ [key]: value })).ok,
          false,
          `${key}=${JSON.stringify(value)}`,
        );
      }
    }
  });

  test("6. a non-string name is refused, including a number and an object", () => {
    for (const value of [42, null, {}, [], true]) {
      assert.equal(parseStaffInvitationRequest(salesStaff({ firstName: value })).ok, false);
    }
  });

  test("7. an excessively long name is refused", () => {
    const long = "a".repeat(MAX_NAME_LENGTH + 1);
    assert.equal(parseStaffInvitationRequest(salesStaff({ firstName: long })).ok, false);
    assert.equal(parseStaffInvitationRequest(salesStaff({ lastName: long })).ok, false);
    // Exactly at the bound is fine — the cap is defensive, not a product rule.
    assert.ok(
      parseStaffInvitationRequest(salesStaff({ firstName: "a".repeat(MAX_NAME_LENGTH) }))
        .ok,
    );
  });
});

describe("parseStaffInvitationRequest — email", () => {
  test("8. a malformed address is refused", () => {
    for (const email of [
      "not-an-email",
      "@example.com",
      "ada@",
      "ada@example",
      "ada example@test.com",
      "ada@exa mple.com",
      "",
    ]) {
      assert.equal(
        parseStaffInvitationRequest(salesStaff({ email })).ok,
        false,
        JSON.stringify(email),
      );
    }
  });

  test("9. a non-string or oversized address is refused", () => {
    assert.equal(parseStaffInvitationRequest(salesStaff({ email: 1 })).ok, false);
    const long = `${"a".repeat(MAX_EMAIL_LENGTH)}@example.com`;
    assert.equal(parseStaffInvitationRequest(salesStaff({ email: long })).ok, false);
  });
});

describe("parseStaffInvitationRequest — role", () => {
  test("10. an unsupported role code is refused", () => {
    for (const roleCode of [
      "RETAILER_OWNER",
      "VENDOR_ADMIN",
      "ADMIN",
      "",
      "SALES_STAFF_ADMIN",
      42,
      null,
    ]) {
      assert.deepEqual(
        parseStaffInvitationRequest(salesStaff({ roleCode })),
        { ok: false, code: "INVALID_REQUEST" },
        JSON.stringify(roleCode),
      );
    }
  });

  test("11. only the two invitable codes are accepted", () => {
    assert.ok(parseStaffInvitationRequest(salesStaff()).ok);
    assert.ok(parseStaffInvitationRequest(manager()).ok);
  });
});

describe("parseStaffInvitationRequest — shops", () => {
  test("12. a Retailer Manager carrying shops is refused as a ROLE/SHOP problem", () => {
    assert.deepEqual(parseStaffInvitationRequest(manager({ shopIds: [SHOP_A] })), {
      ok: false,
      code: "INVALID_ROLE_SHOP_COMBINATION",
    });
  });

  test("13. Sales Staff with zero shops is refused as a ROLE/SHOP problem", () => {
    assert.deepEqual(parseStaffInvitationRequest(salesStaff({ shopIds: [] })), {
      ok: false,
      code: "INVALID_ROLE_SHOP_COMBINATION",
    });
  });

  test("14. the role/shop codes map to 422, distinct from a malformed request's 400", () => {
    assert.equal(STAFF_INVITATION_HTTP_STATUS.INVALID_ROLE_SHOP_COMBINATION, 422);
    assert.equal(STAFF_INVITATION_HTTP_STATUS.INVALID_REQUEST, 400);
  });

  test("15. a malformed shop UUID is refused", () => {
    for (const shopId of [
      "not-a-uuid",
      "11111111-1111-4111-8111",
      "11111111111141118111111111111111",
      `${SHOP_A}-extra`,
      "",
    ]) {
      assert.deepEqual(
        parseStaffInvitationRequest(salesStaff({ shopIds: [shopId] })),
        { ok: false, code: "INVALID_REQUEST" },
        JSON.stringify(shopId),
      );
    }
  });

  test("16. a duplicate shop UUID is REFUSED, not silently de-duplicated", () => {
    assert.deepEqual(parseStaffInvitationRequest(salesStaff({ shopIds: [SHOP_A, SHOP_A] })), {
      ok: false,
      code: "INVALID_REQUEST",
    });
    // Including a duplicate that differs only in case — the comparison is canonical.
    assert.equal(
      parseStaffInvitationRequest(salesStaff({ shopIds: [SHOP_A, SHOP_A.toUpperCase()] }))
        .ok,
      false,
    );
  });

  test("17. a non-array shopIds is refused, and the field is REQUIRED", () => {
    for (const shopIds of [SHOP_A, null, {}, 1, undefined]) {
      assert.equal(
        parseStaffInvitationRequest(salesStaff({ shopIds })).ok,
        false,
        JSON.stringify(shopIds),
      );
    }
    const missing = manager();
    delete missing.shopIds;
    assert.equal(
      parseStaffInvitationRequest(missing).ok,
      false,
      "an absent array must not mean an empty one",
    );
  });

  test("18. a non-string shop element is refused", () => {
    assert.equal(parseStaffInvitationRequest(salesStaff({ shopIds: [42] })).ok, false);
    assert.equal(parseStaffInvitationRequest(salesStaff({ shopIds: [null] })).ok, false);
  });

  test("19. an excessive shop count is refused before any of it is examined", () => {
    const shopIds = Array.from({ length: MAX_SHOP_SELECTION + 1 }, () => SHOP_A);
    assert.deepEqual(parseStaffInvitationRequest(salesStaff({ shopIds })), {
      ok: false,
      code: "INVALID_REQUEST",
    });
  });
});

describe("parseStaffInvitationRequest — the body itself", () => {
  test("20. an UNKNOWN top-level field is REFUSED, never ignored", () => {
    // The security property: a field that is silently dropped today is a field a later
    // edit might start honouring. Every one of these is something a client must never
    // be able to nominate.
    for (const key of [
      "retailerOrganizationId",
      "organizationId",
      "actorUserId",
      "userId",
      "profileId",
      "membershipId",
      "permission",
      "invitationId",
      "token",
      "rawToken",
      "tokenHash",
      "expiresAt",
      "sentAt",
      "status",
      "normalizedEmail",
      "auditMetadata",
      "resendApiKey",
      "apiKey",
      "serviceRoleKey",
      "appOrigin",
    ]) {
      assert.deepEqual(
        parseStaffInvitationRequest(salesStaff({ [key]: "anything" })),
        { ok: false, code: "INVALID_REQUEST" },
        `${key} was not refused`,
      );
    }
  });

  test("21. a non-object body is refused", () => {
    for (const body of [null, undefined, [], "string", 42, true]) {
      assert.deepEqual(
        parseStaffInvitationRequest(body),
        { ok: false, code: "INVALID_REQUEST" },
        JSON.stringify(body ?? null),
      );
    }
  });

  test("22. an array of valid requests is refused — one request per call", () => {
    assert.equal(parseStaffInvitationRequest([salesStaff()]).ok, false);
  });

  test("23. the accepted field list is exactly five names", () => {
    assert.deepEqual([...STAFF_INVITATION_REQUEST_FIELDS], [
      "firstName",
      "lastName",
      "email",
      "roleCode",
      "shopIds",
    ]);
  });

  test("24. an accepted request carries ONLY those five fields", () => {
    const result = parseStaffInvitationRequest(salesStaff());
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.request).sort(), [
      "email",
      "firstName",
      "lastName",
      "roleCode",
      "shopIds",
    ]);
  });

  test("25. nothing throws — every rejection is a returned code", () => {
    // The Edge Function turns the result into a response; a throw would become an
    // opaque 500 and lose the stable code.
    for (const body of [null, [], "x", { firstName: {} }, { shopIds: [Symbol.toString] }]) {
      assert.doesNotThrow(() => parseStaffInvitationRequest(body));
    }
  });

  test("26. a byte bound exists for the raw body, and it is generous but finite", () => {
    assert.equal(MAX_REQUEST_BYTES, 65536);
  });
});

/* ===========================================================================
 * 2. THE RESPONSE CONTRACT
 * ========================================================================= */

const ALL_CODES = Object.keys(STAFF_INVITATION_HTTP_STATUS) as StaffInvitationCode[];

describe("the response shape is closed and versioned", () => {
  test("27. the version is pinned at 1", () => {
    assert.equal(STAFF_INVITATION_CONTRACT_VERSION, 1);
  });

  test("28. every response is exactly {version, outcome, code}", () => {
    for (const code of ALL_CODES) {
      const response = staffInvitationResponse(code);
      assert.deepEqual(
        Object.keys(response).sort(),
        ["code", "outcome", "version"],
        `${code} produced ${JSON.stringify(response)}`,
      );
      assert.equal(response.version, STAFF_INVITATION_CONTRACT_VERSION);
      assert.equal(response.code, code);
    }
  });

  test("29. the stable SUCCESS shapes", () => {
    assert.deepEqual(staffInvitationResponse("SENT"), {
      version: 1,
      outcome: "SENT",
      code: "SENT",
    });
    assert.deepEqual(staffInvitationResponse("RESENT"), {
      version: 1,
      outcome: "RESENT",
      code: "RESENT",
    });
  });

  test("30. the stable PARTIAL-SUCCESS shape", () => {
    assert.deepEqual(staffInvitationResponse("DELIVERY_ACCEPTED_STATUS_UNCONFIRMED"), {
      version: 1,
      outcome: "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
      code: "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
    });
  });

  test("31. the stable VALIDATION and AUTHORIZATION shapes", () => {
    assert.deepEqual(staffInvitationResponse("INVALID_REQUEST"), {
      version: 1,
      outcome: "NOT_SENT",
      code: "INVALID_REQUEST",
    });
    assert.deepEqual(staffInvitationResponse("ACCESS_DENIED"), {
      version: 1,
      outcome: "NOT_SENT",
      code: "ACCESS_DENIED",
    });
    assert.deepEqual(staffInvitationResponse("AUTH_REQUIRED"), {
      version: 1,
      outcome: "NOT_SENT",
      code: "AUTH_REQUIRED",
    });
  });

  test("32. the stable PROVIDER-FAILURE shape carries no provider detail", () => {
    const response = staffInvitationResponse("DELIVERY_FAILED");
    assert.deepEqual(response, {
      version: 1,
      outcome: "DELIVERY_FAILED",
      code: "DELIVERY_FAILED",
    });
  });

  test("33. no response value resembles backend, provider, or secret text", () => {
    // Every field of every possible reply is one of this module's own SCREAMING_SNAKE
    // constants or the number 1. There is nowhere for a SQL message, a SQLSTATE, a
    // PostgREST payload, a stack trace, a project ref, an id, an address, or a token to
    // appear, and this asserts that exhaustively rather than by inspection.
    for (const code of ALL_CODES) {
      const serialized = JSON.stringify(staffInvitationResponse(code));
      assert.ok(!/[0-9a-f]{64}/.test(serialized), `${code}: looks like a hash`);
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized),
        `${code}: looks like a UUID`,
      );
      assert.ok(!serialized.includes("@"), `${code}: looks like an address`);
      assert.ok(!/supabase|postgres|resend|sqlstate/i.test(serialized), code);
      for (const value of Object.values(staffInvitationResponse(code))) {
        assert.ok(
          value === 1 || /^[A-Z_]+$/.test(String(value)),
          `${code}: unexpected value ${String(value)}`,
        );
      }
    }
  });
});

describe("codes, outcomes and HTTP statuses agree", () => {
  test("34. every required code exists", () => {
    for (const code of [
      "METHOD_NOT_ALLOWED",
      "INVALID_REQUEST",
      "AUTH_REQUIRED",
      "ACCESS_DENIED",
      "INVITATION_CONFLICT",
      "RETAILER_INACTIVE",
      "DELIVERY_FAILED",
      "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
      "FEATURE_DISABLED",
      "INTERNAL_ERROR",
    ]) {
      assert.ok(isStaffInvitationCode(code), `${code} is missing from the contract`);
    }
  });

  test("35. RATE_LIMITED is deliberately ABSENT — there is no rate limiter", () => {
    // Advertising a code no implementation can produce would be a claim about a control
    // that does not exist.
    assert.equal(isStaffInvitationCode("RATE_LIMITED"), false);
  });

  test("36. each code has exactly one HTTP status, and they are the documented ones", () => {
    assert.deepEqual(STAFF_INVITATION_HTTP_STATUS, {
      SENT: 200,
      RESENT: 200,
      DELIVERY_ACCEPTED_STATUS_UNCONFIRMED: 202,
      DELIVERY_FAILED: 502,
      METHOD_NOT_ALLOWED: 405,
      INVALID_REQUEST: 400,
      INVALID_ROLE_SHOP_COMBINATION: 422,
      AUTH_REQUIRED: 401,
      ACCESS_DENIED: 403,
      INVITATION_CONFLICT: 409,
      RETAILER_INACTIVE: 422,
      FEATURE_DISABLED: 503,
      NOT_CONFIGURED: 503,
      INTERNAL_ERROR: 500,
    });
  });

  test("37. only the four delivery codes are non-NOT_SENT outcomes", () => {
    const delivered = ALL_CODES.filter(
      (code) => staffInvitationOutcomeFor(code) !== "NOT_SENT",
    ).sort();
    assert.deepEqual(delivered, [
      "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
      "DELIVERY_FAILED",
      "RESENT",
      "SENT",
    ]);
  });

  test("38. every NOT_SENT code has a NON-success HTTP status", () => {
    // The safety invariant in the other direction: if nothing was sent, the client must
    // see an error status, so a naive `if (response.ok)` cannot read a refusal as a send.
    for (const code of ALL_CODES) {
      if (staffInvitationOutcomeFor(code) !== "NOT_SENT") continue;
      const status = STAFF_INVITATION_HTTP_STATUS[code];
      assert.ok(status >= 400, `${code} is ${status}, which reads as success`);
    }
  });

  test("39. the two 'the email may exist' codes are 2xx, so nothing auto-retries", () => {
    // A retry would rotate the token and invalidate a link that was already delivered.
    for (const code of ["SENT", "RESENT", "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED"] as const) {
      const status = STAFF_INVITATION_HTTP_STATUS[code];
      assert.ok(status >= 200 && status < 300, `${code} is ${status}`);
    }
    // DELIVERY_FAILED is the exception and correctly so: nothing was delivered, the
    // failure was recorded, and the operator may retry.
    assert.equal(STAFF_INVITATION_HTTP_STATUS.DELIVERY_FAILED, 502);
  });

  test("40. isStaffInvitationCode rejects anything not declared", () => {
    for (const value of ["sent", "SENT ", "", null, 1, {}, "UNKNOWN_CODE"]) {
      assert.equal(isStaffInvitationCode(value), false, JSON.stringify(value ?? null));
    }
    assert.equal(isStaffInvitationCode("SENT"), true);
  });

  test("41. a prototype key is not mistaken for a code", () => {
    // `hasOwnProperty` rather than `in`, so "constructor" and "toString" are not codes.
    for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(isStaffInvitationCode(value), false, value);
    }
  });
});

/* ===========================================================================
 * 3. THE FEATURE FLAG
 * ========================================================================= */

describe("the feature flag comparison is shared and fails closed", () => {
  test("42. only the exact string 'true' enables sending", () => {
    assert.equal(RETAILER_STAFF_INVITATIONS_ENABLED_VALUE, "true");
    assert.equal(isStaffInvitationSendingEnabled("true"), true);
  });

  test("43. every near-miss spelling is DISABLED", () => {
    for (const value of [
      "false",
      "1",
      "yes",
      "on",
      "TRUE",
      "True",
      " true ",
      "true\n",
      "",
      undefined,
      null,
      true,
      1,
    ]) {
      assert.equal(
        isStaffInvitationSendingEnabled(value),
        false,
        JSON.stringify(value ?? null),
      );
    }
  });
});
