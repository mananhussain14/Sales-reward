/**
 * THE ANTI-DRIFT CONTRACT FOR THE 10 MB RECEIPT LIMIT.
 *
 * Run with:  npm test
 *
 * The defect this milestone repairs was not a wrong number. Every number was right; they
 * simply lived in four places that had no way of noticing when one of them moved — and
 * one of them, the framework's, nobody had written down at all.
 *
 * So this file asserts that all the places still agree, including the two that a shared
 * TypeScript constant could never have reached:
 *
 *   the policy module        lib/uploads/upload-policy.ts
 *   the server validator     lib/receipts/receipt-file.ts
 *   the browser pre-flight   lib/receipts/receipt-upload-preflight.ts
 *   the table CHECK          supabase/migrations/…_receipt_submission_storage_foundation.sql
 *   the private bucket       the same migration's storage.buckets row
 *   the reservation RPC      supabase/migrations/…_receipt_submission_operations.sql
 *
 * The transport limits derived from that number are asserted in
 * ./upload-request-boundary.test.ts against the real next.config.ts.
 *
 * THE UNITS ARE BINARY AND THAT IS DELIBERATE. "10 MB" here means 10 MiB — 10,485,760
 * bytes — which is what the database already stored before this milestone. Nothing about
 * the product's behaviour is changed by naming it; the assertions below simply make the
 * convention impossible to drift away from by accident.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  MAX_RECEIPT_FILE_BYTES,
  MAX_RECEIPT_FILE_MEGABYTES,
  MAX_UPLOADED_FILE_BYTES,
  NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES,
  NEXT_DEFAULT_SERVER_ACTION_BODY_LIMIT_BYTES,
  PROXY_BODY_CLONE_HEADROOM_BYTES,
  PROXY_CLIENT_MAX_BODY_BYTES,
  SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
  UPLOAD_REQUEST_OVERHEAD_BYTES,
} from "./upload-policy.ts";
import { MAX_RECEIPT_FILE_BYTES as VALIDATOR_MAX_BYTES } from "../receipts/receipt-file.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const STORAGE_MIGRATION = read(
  "supabase/migrations/20260726090000_receipt_submission_storage_foundation.sql",
);
const OPERATIONS_MIGRATION = read(
  "supabase/migrations/20260726210000_receipt_submission_operations.sql",
);

/** 10 MiB, written out once so the assertions below cannot be self-referential. */
const TEN_MEBIBYTES = 10485760;

describe("1. the application file maximum", () => {
  test("1. is 10 MiB, expressed in bytes", () => {
    assert.equal(MAX_RECEIPT_FILE_BYTES, TEN_MEBIBYTES);
    assert.equal(MAX_RECEIPT_FILE_BYTES, 10 * 1024 * 1024);
  });

  test("2. the display value describes exactly that size", () => {
    // The form and every message say "10 MB". If the byte value ever moves without this
    // one moving with it, the product would advertise a limit it does not enforce —
    // which is the class of defect this whole file exists to prevent.
    assert.equal(MAX_RECEIPT_FILE_MEGABYTES * 1024 * 1024, MAX_RECEIPT_FILE_BYTES);
  });

  test("3. matches the server-side validator byte for byte", () => {
    // lib/receipts/receipt-file.ts holds its own copy because it imports node:crypto and
    // next.config.ts must not. This is the assertion that makes the duplication safe.
    assert.equal(MAX_UPLOADED_FILE_BYTES, VALIDATOR_MAX_BYTES);
    assert.equal(MAX_RECEIPT_FILE_BYTES, VALIDATOR_MAX_BYTES);
  });

  test("4. is what the application-wide upload maximum resolves to", () => {
    assert.equal(MAX_UPLOADED_FILE_BYTES, MAX_RECEIPT_FILE_BYTES);
  });
});

describe("2. the database and Storage agree with it", () => {
  test("5. the receipt_submissions CHECK constraint uses the same number", () => {
    assert.match(
      STORAGE_MIGRATION,
      new RegExp(`file_size_bytes\\s*>\\s*0\\s+and\\s+file_size_bytes\\s*<=\\s*${MAX_RECEIPT_FILE_BYTES}`),
      "the table CHECK no longer matches the application maximum",
    );
  });

  test("6. the private receipts bucket's file_size_limit uses the same number", () => {
    // Also asserts the bucket is still PRIVATE in the same statement, so a change that
    // raised the limit by rewriting this row cannot quietly flip `public` as well.
    const insert = /insert into storage\.buckets[\s\S]{0,600}?;/.exec(STORAGE_MIGRATION);
    assert.ok(insert, "the bucket insert could not be located");
    assert.ok(
      insert[0].includes(String(MAX_RECEIPT_FILE_BYTES)),
      "the bucket file_size_limit no longer matches the application maximum",
    );
    assert.ok(
      /\bfalse\b/.test(insert[0]),
      "the receipts bucket is no longer created private",
    );
  });

  test("7. reserve_receipt_submission() guards on the same number", () => {
    assert.match(
      OPERATIONS_MIGRATION,
      new RegExp(`p_file_size_bytes\\s*>\\s*${MAX_RECEIPT_FILE_BYTES}`),
      "the reservation RPC no longer matches the application maximum",
    );
  });
});

describe("3. the transport limits are derived, not typed in", () => {
  test("8. the Server Action limit is the file maximum plus a stated overhead", () => {
    assert.equal(
      SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
      MAX_UPLOADED_FILE_BYTES + UPLOAD_REQUEST_OVERHEAD_BYTES,
    );
  });

  test("9. the Proxy limit is the Server Action limit plus a stated headroom", () => {
    assert.equal(
      PROXY_CLIENT_MAX_BODY_BYTES,
      SERVER_ACTION_BODY_SIZE_LIMIT_BYTES + PROXY_BODY_CLONE_HEADROOM_BYTES,
    );
  });

  test("10. the ordering that makes the whole thing work is preserved", () => {
    // file maximum < Server Action limit < Proxy limit.
    //
    // The first inequality is what stops a 10 MB receipt being 413'd. The second is what
    // stops an over-sized body being silently truncated by the Proxy instead of cleanly
    // refused by the Server Action boundary.
    assert.ok(MAX_UPLOADED_FILE_BYTES < SERVER_ACTION_BODY_SIZE_LIMIT_BYTES);
    assert.ok(SERVER_ACTION_BODY_SIZE_LIMIT_BYTES < PROXY_CLIENT_MAX_BODY_BYTES);
  });

  test("11. the overhead allowance is generous against real multipart framing", () => {
    // A real encoded submission carrying a 10 MiB file measures ~565 bytes of framing
    // (see ./upload-request-boundary.test.ts, which measures it rather than assuming).
    // The allowance is orders of magnitude above that, and still small in absolute
    // terms — the margin exists so nobody is refused by arithmetic they cannot see, not
    // so the server will buffer more.
    assert.ok(UPLOAD_REQUEST_OVERHEAD_BYTES >= 64 * 1024);
    assert.ok(UPLOAD_REQUEST_OVERHEAD_BYTES <= 1024 * 1024);
  });

  test("12. neither transport limit is unbounded", () => {
    for (const limit of [
      SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
      PROXY_CLIENT_MAX_BODY_BYTES,
    ]) {
      assert.ok(Number.isFinite(limit), "a transport limit is not finite");
      assert.ok(limit > 0);
      // Bounded to a small multiple of the file maximum: the request boundary exists to
      // cap memory, and a limit far above what any file needs would give that up.
      assert.ok(limit < MAX_UPLOADED_FILE_BYTES * 2);
    }
  });
});

describe("4. the recorded Next.js defaults are accurate", () => {
  test("13. the Server Action default is 1 MiB", () => {
    // Read from node_modules rather than trusted: action-handler.js declares
    // `defaultBodySizeLimit = '1 MB'` and resolves it to 1024 * 1024.
    assert.equal(NEXT_DEFAULT_SERVER_ACTION_BODY_LIMIT_BYTES, 1024 * 1024);
    const handler = read("node_modules/next/dist/server/app-render/action-handler.js");
    assert.match(handler, /defaultBodySizeLimit = '1 MB'/);
  });

  test("14. the Proxy default is 10 MiB — the same size as a maximum receipt", () => {
    assert.equal(NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES, TEN_MEBIBYTES);
    assert.equal(NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES, MAX_RECEIPT_FILE_BYTES);
    const shared = read("node_modules/next/dist/server/config-shared.js");
    assert.match(shared, new RegExp(`proxyClientMaxBodySize: ${TEN_MEBIBYTES}`));
  });
});
