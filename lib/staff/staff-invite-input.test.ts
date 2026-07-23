/**
 * Unit tests for the Invite Staff form's normalization and validation.
 *
 * Run with:  npm test
 *
 * These pin the two role/shop rules the database also enforces (a Retailer Manager
 * carries no shops; a Sales Staff member carries at least one), and — the security
 * property — that a submitted shop id is accepted ONLY when it appears in the set the
 * server read from public.list_retailer_staff_assignable_shops().
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStaffInviteInput,
  validateStaffInviteInput,
} from "./staff-invite-input.ts";

const SHOP_A = "11111111-1111-4111-8111-111111111111";
const SHOP_B = "22222222-2222-4222-8222-222222222222";
/** A well-formed UUID that is NOT in the assignable set — another Retailer's shop. */
const FOREIGN_SHOP = "99999999-9999-4999-8999-999999999999";

const ALLOWED = [SHOP_A, SHOP_B];

function values(overrides: Partial<ReturnType<typeof normalizeStaffInviteInput>> = {}) {
  return {
    ...normalizeStaffInviteInput({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      roleCode: "SALES_STAFF",
      shopIds: [SHOP_A],
    }),
    ...overrides,
  };
}

describe("normalizeStaffInviteInput", () => {
  test("1. trims names, lower-cases and trims the email, upper-cases the role", () => {
    const result = normalizeStaffInviteInput({
      firstName: "  Ada  ",
      lastName: "  Lovelace ",
      email: "  Ada@Example.COM  ",
      roleCode: " sales_staff ",
      shopIds: [],
    });
    assert.equal(result.firstName, "Ada");
    assert.equal(result.lastName, "Lovelace");
    assert.equal(result.email, "ada@example.com");
    assert.equal(result.roleCode, "SALES_STAFF");
  });

  test("2. never case-folds a name — 'de Silva' is not 'De Silva'", () => {
    const result = normalizeStaffInviteInput({ firstName: "de Silva", lastName: "o'Neil" });
    assert.equal(result.firstName, "de Silva");
    assert.equal(result.lastName, "o'Neil");
  });

  test("3. de-duplicates, lower-cases and sorts shop ids", () => {
    const result = normalizeStaffInviteInput({
      shopIds: [SHOP_B.toUpperCase(), SHOP_A, SHOP_B, "  ", ""],
    });
    assert.deepEqual(result.shopIds, [SHOP_A, SHOP_B]);
  });

  test("4. a non-array shopIds and File-like entries are treated as absent", () => {
    assert.deepEqual(normalizeStaffInviteInput({ shopIds: "not-an-array" }).shopIds, []);
    assert.deepEqual(normalizeStaffInviteInput({ shopIds: [{}, 42] }).shopIds, []);
    assert.equal(normalizeStaffInviteInput({ firstName: {} }).firstName, "");
  });

  test("5. missing fields normalize to empty strings, never undefined", () => {
    const result = normalizeStaffInviteInput({});
    assert.deepEqual(result, {
      firstName: "",
      lastName: "",
      email: "",
      roleCode: "",
      shopIds: [],
    });
  });
});

describe("validateStaffInviteInput — required fields", () => {
  test("6. accepts a complete Sales Staff submission", () => {
    const result = validateStaffInviteInput(values(), ALLOWED);
    assert.equal(result.ok, true);
  });

  test("7. reports each missing field against that field", () => {
    const result = validateStaffInviteInput(
      values({ firstName: "", lastName: "", email: "", roleCode: "" }),
      ALLOWED,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.firstName);
    assert.ok(result.fieldErrors.lastName);
    assert.ok(result.fieldErrors.email);
    assert.ok(result.fieldErrors.roleCode);
  });

  test("8. rejects a malformed or over-long email", () => {
    for (const email of ["nope", "a@b", "a b@c.d", `${"a".repeat(250)}@example.com`]) {
      const result = validateStaffInviteInput(values({ email }), ALLOWED);
      assert.equal(result.ok, false, `${email} must be rejected`);
    }
  });

  test("9. rejects a role code that is not one of the two invitable roles", () => {
    for (const roleCode of ["RETAILER_OWNER", "VENDOR_SUPER_ADMIN", "ADMIN", "X"]) {
      const result = validateStaffInviteInput(
        values({ roleCode, shopIds: [] }),
        ALLOWED,
      );
      assert.equal(result.ok, false, `${roleCode} must be rejected`);
      if (result.ok) return;
      assert.ok(result.fieldErrors.roleCode);
    }
  });
});

describe("validateStaffInviteInput — Retailer Manager sends zero shops", () => {
  test("10. a Manager with no shops is valid", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "RETAILER_MANAGER", shopIds: [] }),
      ALLOWED,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.values.shopIds, []);
  });

  test("11. a Manager WITH shops is rejected — the database forbids the rows", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "RETAILER_MANAGER", shopIds: [SHOP_A] }),
      ALLOWED,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.shopIds);
  });
});

describe("validateStaffInviteInput — Sales Staff requires at least one shop", () => {
  test("12. zero shops is rejected", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [] }),
      ALLOWED,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.fieldErrors.shopIds ?? "", /at least one shop/i);
  });

  test("13. a Retailer with NO assignable shops gets its own message, not 'select one'", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [] }),
      [],
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.fieldErrors.shopIds ?? "", /no active shops/i);
  });

  test("14. multiple assignable shops are accepted", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [SHOP_A, SHOP_B] }),
      ALLOWED,
    );
    assert.equal(result.ok, true);
  });
});

describe("validateStaffInviteInput — shop ids come ONLY from the assignable RPC", () => {
  test("15. a well-formed id outside the assignable set is rejected", () => {
    // This is the tampered-POST case: another Retailer's shop, or one of the caller's
    // own that is suspended/deactivated and therefore absent from the RPC's result.
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [FOREIGN_SHOP] }),
      ALLOWED,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.shopIds);
  });

  test("16. one foreign id poisons an otherwise-valid selection", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [SHOP_A, FOREIGN_SHOP] }),
      ALLOWED,
    );
    assert.equal(result.ok, false);
  });

  test("17. a malformed id and a foreign id report IDENTICALLY", () => {
    // Distinguishing them would confirm whether some other shop id exists.
    const malformed = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: ["not-a-uuid"] }),
      ALLOWED,
    );
    const foreign = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [FOREIGN_SHOP] }),
      ALLOWED,
    );
    assert.equal(malformed.ok, false);
    assert.equal(foreign.ok, false);
    if (malformed.ok || foreign.ok) return;
    assert.equal(malformed.fieldErrors.shopIds, foreign.fieldErrors.shopIds);
  });

  test("18. the allowed set is matched case-insensitively", () => {
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: [SHOP_A] }),
      [SHOP_A.toUpperCase()],
    );
    assert.equal(result.ok, true);
  });

  test("19. an unbounded selection is refused before the subset check does the work", () => {
    const many = Array.from({ length: 500 }, (_unused, index) =>
      `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const result = validateStaffInviteInput(
      values({ roleCode: "SALES_STAFF", shopIds: many }),
      ALLOWED,
    );
    assert.equal(result.ok, false);
  });

  test("20. an empty allowed set can never yield a valid Sales Staff submission", () => {
    for (const shopIds of [[], [SHOP_A], [FOREIGN_SHOP]]) {
      const result = validateStaffInviteInput(
        values({ roleCode: "SALES_STAFF", shopIds }),
        [],
      );
      assert.equal(result.ok, false);
    }
  });
});
