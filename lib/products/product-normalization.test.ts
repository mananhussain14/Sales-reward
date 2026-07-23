/**
 * Unit tests for the product RPC normalizers.
 *
 * Run with:  npm test
 *
 * These pin the fail-closed contract (a drifted row is refused rather than rendered as
 * `undefined`), the exact two-state vocabularies, the "never assigned" case that only
 * the assignment panel has, and — the property the UI depends on — that the shapes the
 * pages consume carry no Vendor organization id, creator identity, assignment id or
 * audit metadata.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNMENT_STATUSES,
  canAssignToRetailer,
  normalizeAssignedProducts,
  normalizeProductAssignments,
  normalizeVendorProducts,
  PRODUCT_STATUSES,
  productStatusLabel,
} from "./product-normalization.ts";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const RETAILER_ID = "22222222-2222-4222-8222-222222222222";

describe("normalizeVendorProducts", () => {
  const row = {
    product_id: PRODUCT_ID,
    product_code: "SR-100",
    barcode: "5012345678900",
    product_name: "Sparkling Water",
    brand: "Aqua",
    description: "A fizzy drink.",
    status: "ACTIVE",
    active_assignment_count: 3,
    created_at: "2026-07-27T09:00:00Z",
    updated_at: "2026-07-27T10:00:00Z",
  };

  test("1. maps a well-formed row and lower-cases the id", () => {
    const result = normalizeVendorProducts([{ ...row, product_id: PRODUCT_ID.toUpperCase() }]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.products[0].productId, PRODUCT_ID);
    assert.equal(result.products[0].activeAssignmentCount, 3);
    assert.equal(result.products[0].status, "ACTIVE");
  });

  test("2. optional fields become null, never empty strings", () => {
    const result = normalizeVendorProducts([
      { ...row, barcode: null, brand: "   ", description: undefined },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.products[0].barcode, null);
    assert.equal(result.products[0].brand, null);
    assert.equal(result.products[0].description, null);
  });

  test("3. accepts an assignment count returned as a JSON string", () => {
    // bigint arrives as a number when it fits and a string when the driver plays safe.
    const result = normalizeVendorProducts([{ ...row, active_assignment_count: "12" }]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.products[0].activeAssignmentCount, 12);
  });

  test("4. an empty catalog is a valid successful answer", () => {
    assert.deepEqual(normalizeVendorProducts([]), { status: "ok", products: [] });
  });

  test("5. refuses an unrecognized status rather than defaulting", () => {
    // Defaulting could render an approval-like state this milestone never built.
    for (const status of ["DRAFT", "ARCHIVED", "APPROVED", "", null, 7]) {
      assert.equal(
        normalizeVendorProducts([{ ...row, status }]).status,
        "malformed",
        String(status),
      );
    }
  });

  test("6. refuses a row missing any required field", () => {
    for (const key of ["product_id", "product_code", "product_name"]) {
      const result = normalizeVendorProducts([{ ...row, [key]: null }]);
      assert.equal(result.status, "malformed", key);
      if (result.status !== "malformed") return;
      assert.equal(result.reason, key);
    }
    assert.equal(
      normalizeVendorProducts([{ ...row, active_assignment_count: "many" }]).status,
      "malformed",
    );
  });

  test("7. the mapped shape carries NO unsafe field, even if the RPC returned one", () => {
    const result = normalizeVendorProducts([
      {
        ...row,
        // None of these is in the RPC's result today. They are injected to prove the
        // normalizer maps an explicit allow-list rather than spreading the row.
        vendor_organization_id: "33333333-3333-4333-8333-333333333333",
        created_by_profile_id: "44444444-4444-4444-8444-444444444444",
        audit_note: "internal",
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(Object.keys(result.products[0]).sort(), [
      "activeAssignmentCount",
      "barcode",
      "brand",
      "createdAt",
      "description",
      "productCode",
      "productId",
      "productName",
      "status",
      "updatedAt",
    ]);
  });
});

describe("normalizeProductAssignments", () => {
  const row = {
    retailer_organization_id: RETAILER_ID,
    retailer_name: "Harbour Retail",
    retailer_status: "ACTIVE",
    relationship_status: "ACTIVE",
    assignment_status: "ACTIVE",
    assigned_at: "2026-07-27T11:00:00Z",
  };

  test("8. maps an assigned Retailer", () => {
    const result = normalizeProductAssignments([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.assignments[0].assignmentStatus, "ACTIVE");
    assert.equal(result.assignments[0].retailerOrganizationId, RETAILER_ID);
  });

  test("9. a NULL assignment status means 'never assigned' and is not drift", () => {
    for (const assignment_status of [null, undefined]) {
      const result = normalizeProductAssignments([
        { ...row, assignment_status, assigned_at: null },
      ]);
      assert.equal(result.status, "ok", String(assignment_status));
      if (result.status !== "ok") return;
      assert.equal(result.assignments[0].assignmentStatus, null);
    }
  });

  test("10. a withdrawn assignment maps to INACTIVE", () => {
    const result = normalizeProductAssignments([{ ...row, assignment_status: "INACTIVE" }]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.assignments[0].assignmentStatus, "INACTIVE");
  });

  test("11. refuses an unrecognized non-null assignment status", () => {
    for (const assignment_status of ["PENDING", "APPROVED", ""]) {
      assert.equal(
        normalizeProductAssignments([{ ...row, assignment_status }]).status,
        "malformed",
        assignment_status,
      );
    }
  });

  test("12. refuses a row missing any required field", () => {
    for (const key of [
      "retailer_organization_id",
      "retailer_name",
      "retailer_status",
      "relationship_status",
    ]) {
      const result = normalizeProductAssignments([{ ...row, [key]: null }]);
      assert.equal(result.status, "malformed", key);
    }
  });
});

describe("canAssignToRetailer", () => {
  const base = {
    retailerOrganizationId: RETAILER_ID,
    retailerName: "Harbour Retail",
    retailerStatus: "ACTIVE",
    relationshipStatus: "ACTIVE",
    assignmentStatus: null,
    assignedAt: null,
  };

  test("13. both the Retailer and the relationship must be ACTIVE", () => {
    assert.equal(canAssignToRetailer(base), true);
    assert.equal(canAssignToRetailer({ ...base, retailerStatus: "SUSPENDED" }), false);
    assert.equal(canAssignToRetailer({ ...base, relationshipStatus: "SUSPENDED" }), false);
    assert.equal(
      canAssignToRetailer({ ...base, retailerStatus: "DEACTIVATED", relationshipStatus: "DEACTIVATED" }),
      false,
    );
  });

  test("14. it mirrors the RPC's rule, so no offered control can fail on status", () => {
    // assign_vendor_product_to_retailer requires vr.status = 'ACTIVE' AND o.status =
    // 'ACTIVE'. Anything this returns true for is something the database will accept
    // (given an active product), and anything it returns false for the database refuses.
    for (const retailerStatus of ["ACTIVE", "SUSPENDED", "DEACTIVATED"]) {
      for (const relationshipStatus of ["ACTIVE", "SUSPENDED", "DEACTIVATED"]) {
        const expected = retailerStatus === "ACTIVE" && relationshipStatus === "ACTIVE";
        assert.equal(
          canAssignToRetailer({ ...base, retailerStatus, relationshipStatus }),
          expected,
          `${retailerStatus}/${relationshipStatus}`,
        );
      }
    }
  });
});

describe("normalizeAssignedProducts — the Retailer's view", () => {
  const row = {
    product_id: PRODUCT_ID,
    product_code: "SR-100",
    barcode: "5012345678900",
    product_name: "Sparkling Water",
    brand: "Aqua",
    description: "A fizzy drink.",
    assignment_status: "ACTIVE",
  };

  test("15. maps a well-formed row", () => {
    const result = normalizeAssignedProducts([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.products[0].productCode, "SR-100");
    assert.equal(result.products[0].assignmentStatus, "ACTIVE");
  });

  test("16. an empty list is a valid successful answer, not a denial", () => {
    assert.deepEqual(normalizeAssignedProducts([]), { status: "ok", products: [] });
  });

  test("17. the Retailer's shape carries no Vendor, creator or assignment identifier", () => {
    const result = normalizeAssignedProducts([
      {
        ...row,
        vendor_organization_id: "33333333-3333-4333-8333-333333333333",
        vendor_name: "Acme Vendor",
        created_by_profile_id: "44444444-4444-4444-8444-444444444444",
        assignment_id: "55555555-5555-4555-8555-555555555555",
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    const serialized = JSON.stringify(result.products[0]);
    for (const leak of [
      "33333333-3333-4333-8333-333333333333",
      "Acme Vendor",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ]) {
      assert.ok(!serialized.includes(leak), `leaked ${leak}`);
    }
    assert.deepEqual(Object.keys(result.products[0]).sort(), [
      "assignmentStatus",
      "barcode",
      "brand",
      "description",
      "productCode",
      "productId",
      "productName",
    ]);
  });

  test("18. fails closed on drift", () => {
    assert.equal(normalizeAssignedProducts("nope").status, "malformed");
    assert.equal(normalizeAssignedProducts([null]).status, "malformed");
    assert.equal(
      normalizeAssignedProducts([{ ...row, assignment_status: "MAYBE" }]).status,
      "malformed",
    );
  });
});

describe("status vocabularies", () => {
  test("19. exactly two product statuses — no draft, review, approval or payout state", () => {
    assert.deepEqual([...PRODUCT_STATUSES], ["ACTIVE", "INACTIVE"]);
    assert.deepEqual([...ASSIGNMENT_STATUSES], ["ACTIVE", "INACTIVE"]);
  });

  test("20. every product status has a label that is not the raw enum value", () => {
    for (const status of PRODUCT_STATUSES) {
      const label = productStatusLabel(status);
      assert.ok(label.length > 0, status);
      assert.notEqual(label, status);
    }
  });
});
