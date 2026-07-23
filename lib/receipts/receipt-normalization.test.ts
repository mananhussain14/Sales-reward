/**
 * Unit tests for the receipt RPC normalizers.
 *
 * Run with:  npm test
 *
 * These pin the fail-closed contract (a drifted row is refused, never rendered as
 * `undefined`), the exact set of stored statuses, and — the property the history UI
 * depends on — that the shapes the page consumes carry no storage path, bucket, hash,
 * profile id, organization id or failure code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAssignedShops,
  normalizeReceiptSubmissions,
  receiptStatusLabel,
  RECEIPT_SUBMISSION_STATUSES,
} from "./receipt-normalization.ts";

const SHOP_ID = "11111111-1111-4111-8111-111111111111";
const SUBMISSION_ID = "22222222-2222-4222-8222-222222222222";

describe("normalizeAssignedShops", () => {
  test("1. maps a well-formed row and lower-cases the id", () => {
    const result = normalizeAssignedShops([
      { shop_id: SHOP_ID.toUpperCase(), shop_name: "Queen Street", shop_code: "Q-1" },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.shops[0], {
      shopId: SHOP_ID,
      shopName: "Queen Street",
      shopCode: "Q-1",
    });
  });

  test("2. a missing code becomes null, never an empty string", () => {
    const result = normalizeAssignedShops([
      { shop_id: SHOP_ID, shop_name: "Queen Street", shop_code: "  " },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.shops[0].shopCode, null);
  });

  test("3. an empty list is a valid successful answer, not a failure", () => {
    // An authorized Sales Staff member with no assignment yet. The page renders a
    // "no shops assigned" state, NOT a denial.
    assert.deepEqual(normalizeAssignedShops([]), { status: "ok", shops: [] });
  });

  test("4. fails closed on drift rather than rendering an option with no value", () => {
    for (const data of [
      null,
      "rows",
      [null],
      [{ shop_name: "no id" }],
      [{ shop_id: SHOP_ID }],
      [{ shop_id: "", shop_name: "blank" }],
    ]) {
      assert.equal(
        normalizeAssignedShops(data).status,
        "malformed",
        JSON.stringify(data),
      );
    }
  });
});

describe("normalizeReceiptSubmissions", () => {
  const row = {
    submission_id: SUBMISSION_ID,
    shop_name: "Queen Street",
    shop_code: "Q-1",
    status: "SUBMITTED",
    original_file_name: "till.jpg",
    mime_type: "image/jpeg",
    file_size_bytes: 204800,
    submitted_at: "2026-07-26T10:00:00Z",
    created_at: "2026-07-26T09:59:00Z",
  };

  test("5. maps a well-formed submission", () => {
    const result = normalizeReceiptSubmissions([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.submissions[0].submissionId, SUBMISSION_ID);
    assert.equal(result.submissions[0].status, "SUBMITTED");
    assert.equal(result.submissions[0].fileSizeBytes, 204800);
  });

  test("6. accepts a bigint returned as a JSON string", () => {
    // PostgREST may serialize bigint either way depending on magnitude and driver.
    const result = normalizeReceiptSubmissions([{ ...row, file_size_bytes: "204800" }]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.submissions[0].fileSizeBytes, 204800);
  });

  test("7. refuses a non-numeric size", () => {
    for (const size of [null, "abc", {}, "-1x"]) {
      const result = normalizeReceiptSubmissions([{ ...row, file_size_bytes: size }]);
      assert.equal(result.status, "malformed", JSON.stringify(size));
    }
  });

  test("8. accepts every status the database can store", () => {
    for (const status of RECEIPT_SUBMISSION_STATUSES) {
      const result = normalizeReceiptSubmissions([{ ...row, status }]);
      assert.equal(result.status, "ok", status);
    }
  });

  test("9. refuses an unrecognized status rather than defaulting", () => {
    // Defaulting could render an approval-like state this milestone never built.
    for (const status of ["APPROVED", "REJECTED", "PAID", "", null, 7]) {
      const result = normalizeReceiptSubmissions([{ ...row, status }]);
      assert.equal(result.status, "malformed", String(status));
    }
  });

  test("10. a RESERVED row has no submitted_at, and that is not an error", () => {
    const result = normalizeReceiptSubmissions([
      { ...row, status: "RESERVED", submitted_at: null },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.submissions[0].submittedAt, null);
  });

  test("11. refuses a row missing any required text column", () => {
    for (const key of [
      "submission_id",
      "shop_name",
      "original_file_name",
      "mime_type",
    ]) {
      const result = normalizeReceiptSubmissions([{ ...row, [key]: null }]);
      assert.equal(result.status, "malformed", key);
      if (result.status !== "malformed") return;
      assert.equal(result.reason, key);
    }
  });

  test("12. the mapped shape carries NO unsafe field, even if the RPC ever returned one", () => {
    const result = normalizeReceiptSubmissions([
      {
        ...row,
        // None of these is in the RPC's result today. They are injected here to prove
        // the normalizer maps an explicit allow-list rather than spreading the row.
        storage_bucket: "receipts",
        storage_object_path: "org/profile/sub/file.jpg",
        file_sha256: "b".repeat(64),
        submitted_by_profile_id: "33333333-3333-4333-8333-333333333333",
        retailer_organization_id: "44444444-4444-4444-8444-444444444444",
        failure_code: "STORAGE_UPLOAD_FAILED",
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    const serialized = JSON.stringify(result.submissions[0]);
    for (const leak of [
      "receipts",
      "org/profile/sub/file.jpg",
      "b".repeat(64),
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "STORAGE_UPLOAD_FAILED",
    ]) {
      assert.ok(!serialized.includes(leak), `leaked ${leak}`);
    }
    assert.deepEqual(Object.keys(result.submissions[0]).sort(), [
      "createdAt",
      "fileSizeBytes",
      "mimeType",
      "originalFileName",
      "shopCode",
      "shopName",
      "status",
      "submissionId",
      "submittedAt",
    ]);
  });

  test("13. fails closed on a non-array or a non-object row", () => {
    assert.equal(normalizeReceiptSubmissions("nope").status, "malformed");
    assert.equal(normalizeReceiptSubmissions([null]).status, "malformed");
  });
});

describe("status labels", () => {
  test("14. every status has a label, and none leaks the raw enum value", () => {
    for (const status of RECEIPT_SUBMISSION_STATUSES) {
      const label = receiptStatusLabel(status);
      assert.ok(label.length > 0, status);
      assert.notEqual(label, status);
    }
  });

  test("15. there are exactly three statuses — no review, approval or payout state", () => {
    assert.deepEqual([...RECEIPT_SUBMISSION_STATUSES], [
      "RESERVED",
      "SUBMITTED",
      "UPLOAD_FAILED",
    ]);
  });
});
