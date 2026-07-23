/**
 * Unit tests for product form normalization and validation.
 *
 * Run with:  npm test
 *
 * These pin the rules the catalog's uniqueness depends on: what "normalized" means for
 * a product code and a barcode, that the same rules are applied whichever form
 * submitted them, and that the code is validated on create but not on update — because
 * it is immutable in the database and the edit form has no field for it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_PRODUCT_VALUES,
  MAX_BRAND_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_PRODUCT_CODE_LENGTH,
  MAX_PRODUCT_NAME_LENGTH,
  normalizeProductInput,
  optionalOrNull,
  validateProductInput,
} from "./product-input.ts";

describe("normalizeProductInput", () => {
  test("1. upper-cases, trims and collapses the product code", () => {
    const values = normalizeProductInput({ productCode: "  sr-100   a  " });
    assert.equal(values.productCode, "SR-100 A");
  });

  test("2. trims and collapses the name and brand but never case-folds them", () => {
    const values = normalizeProductInput({
      productName: "  Sparkling   Water 500ml ",
      brand: "  de  Silva ",
    });
    assert.equal(values.productName, "Sparkling Water 500ml");
    assert.equal(values.brand, "de Silva");
  });

  test("3. strips spaces and hyphens from the barcode", () => {
    assert.equal(normalizeProductInput({ barcode: " 501-2345 678900 " }).barcode, "5012345678900");
    assert.equal(normalizeProductInput({ barcode: "5012345678900" }).barcode, "5012345678900");
  });

  test("4. trims the description but leaves its internal formatting alone", () => {
    const values = normalizeProductInput({ description: "  Line one.\n\nLine two.  " });
    assert.equal(values.description, "Line one.\n\nLine two.");
  });

  test("5. missing and non-string fields normalize to empty strings, never undefined", () => {
    assert.deepEqual(normalizeProductInput({}), EMPTY_PRODUCT_VALUES);
    assert.deepEqual(
      normalizeProductInput({ productCode: 42, productName: {}, barcode: null }),
      EMPTY_PRODUCT_VALUES,
    );
  });

  test("6. normalization is idempotent — normalizing twice changes nothing", () => {
    const once = normalizeProductInput({
      productCode: " sr 100 ",
      productName: "  A   B ",
      barcode: "12-34 5678",
      brand: " x  y ",
      description: "  d  ",
    });
    assert.deepEqual(normalizeProductInput(once), once);
  });
});

describe("validateProductInput — create", () => {
  const base = normalizeProductInput({
    productCode: "SR-100",
    productName: "Sparkling Water",
  });

  test("7. accepts a minimal valid product", () => {
    assert.equal(validateProductInput(base, "create").ok, true);
  });

  test("8. requires a product code", () => {
    const result = validateProductInput({ ...base, productCode: "" }, "create");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.productCode);
  });

  test("9. rejects a code with disallowed characters", () => {
    for (const productCode of ["SR@100", "SR#1", "SR,1", "SR(1)", "-SR1", ".SR1"]) {
      const result = validateProductInput({ ...base, productCode }, "create");
      assert.equal(result.ok, false, productCode);
    }
  });

  test("10. accepts the permitted separators", () => {
    for (const productCode of ["SR-100", "SR_100", "SR.100", "SR/100", "SR 100", "S1"]) {
      assert.equal(
        validateProductInput({ ...base, productCode }, "create").ok,
        true,
        productCode,
      );
    }
  });

  test("11. enforces the code length limit", () => {
    const long = "A".repeat(MAX_PRODUCT_CODE_LENGTH + 1);
    assert.equal(validateProductInput({ ...base, productCode: long }, "create").ok, false);
    assert.equal(
      validateProductInput(
        { ...base, productCode: "A".repeat(MAX_PRODUCT_CODE_LENGTH) },
        "create",
      ).ok,
      true,
    );
  });

  test("12. requires a non-empty product name", () => {
    // Normalization turns whitespace into "", so a whitespace-only name is empty.
    const values = normalizeProductInput({ productCode: "SR-1", productName: "   " });
    const result = validateProductInput(values, "create");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.productName);
  });

  test("13. enforces the name, brand and description limits", () => {
    assert.equal(
      validateProductInput(
        { ...base, productName: "N".repeat(MAX_PRODUCT_NAME_LENGTH + 1) },
        "create",
      ).ok,
      false,
    );
    assert.equal(
      validateProductInput({ ...base, brand: "B".repeat(MAX_BRAND_LENGTH + 1) }, "create").ok,
      false,
    );
    assert.equal(
      validateProductInput(
        { ...base, description: "D".repeat(MAX_DESCRIPTION_LENGTH + 1) },
        "create",
      ).ok,
      false,
    );
  });
});

describe("validateProductInput — barcode", () => {
  const base = normalizeProductInput({ productCode: "SR-100", productName: "Water" });

  test("14. a blank barcode is valid — it is optional", () => {
    assert.equal(validateProductInput({ ...base, barcode: "" }, "create").ok, true);
  });

  test("15. accepts GTIN-8, UPC-A, EAN-13 and GTIN-14 lengths", () => {
    for (const barcode of ["12345678", "123456789012", "5012345678900", "12345678901234"]) {
      assert.equal(validateProductInput({ ...base, barcode }, "create").ok, true, barcode);
    }
  });

  test("16. rejects too-short, too-long and non-numeric barcodes", () => {
    for (const barcode of ["1234567", "123456789012345", "ABCDEFGH", "5012345678900X"]) {
      const result = validateProductInput({ ...base, barcode }, "create");
      assert.equal(result.ok, false, barcode);
      if (result.ok) return;
      assert.ok(result.fieldErrors.barcode);
    }
  });

  test("17. a separator-laden barcode is valid once normalized", () => {
    const values = normalizeProductInput({
      productCode: "SR-1",
      productName: "Water",
      barcode: "501-2345 678900",
    });
    assert.equal(validateProductInput(values, "create").ok, true);
  });
});

describe("validateProductInput — update", () => {
  test("18. does NOT validate the product code — the form cannot send one", () => {
    // The code is immutable in the database, so an edit submission carries no code
    // field at all. Validating a value the form cannot send would be a rule with no
    // subject; requiring one would make every edit fail.
    const values = normalizeProductInput({ productName: "New name" });
    assert.equal(values.productCode, "");
    assert.equal(validateProductInput(values, "update").ok, true);
  });

  test("19. still validates the name, barcode, brand and description", () => {
    const bad = normalizeProductInput({ productName: "", barcode: "12" });
    const result = validateProductInput(bad, "update");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.productName);
    assert.ok(result.fieldErrors.barcode);
  });

  test("20. an invalid code is ignored on update rather than reported", () => {
    const values = { ...normalizeProductInput({ productName: "Name" }), productCode: "@@@" };
    assert.equal(validateProductInput(values, "update").ok, true);
  });
});

describe("optionalOrNull", () => {
  test("21. an empty string becomes null; anything else passes through", () => {
    assert.equal(optionalOrNull(""), null);
    assert.equal(optionalOrNull("5012345678900"), "5012345678900");
  });

  test("22. every optional field of a blank form reaches the RPC as null", () => {
    const values = normalizeProductInput({ productCode: "SR-1", productName: "Water" });
    assert.equal(optionalOrNull(values.barcode), null);
    assert.equal(optionalOrNull(values.brand), null);
    assert.equal(optionalOrNull(values.description), null);
  });
});

describe("validation errors are sanitized", () => {
  test("23. no message echoes the submitted value back", () => {
    const values = normalizeProductInput({
      productCode: "SECRET@CODE",
      productName: "",
      barcode: "NOTANUMBER",
    });
    const result = validateProductInput(values, "create");
    assert.equal(result.ok, false);
    if (result.ok) return;
    const messages = Object.values(result.fieldErrors).join(" ");
    assert.ok(!messages.includes("SECRET"), messages);
    assert.ok(!messages.includes("NOTANUMBER"), messages);
  });

  test("24. a rejection always echoes the values so the form can be redrawn", () => {
    const values = normalizeProductInput({ productCode: "", productName: "Keep me" });
    const result = validateProductInput(values, "create");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.values, values);
  });
});
