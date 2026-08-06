"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { getMyAssignedReceiptShops } from "@/lib/receipts/receipt-data";
import { submitReceipt } from "@/lib/receipts/receipt-submissions";
import { requestReceiptExtraction } from "@/lib/receipts/receipt-extraction-request";
import { runReceiptSubmissionOutcome } from "@/lib/receipts/receipt-submission-extraction-flow";
import { validateReceiptFile } from "@/lib/receipts/receipt-file";
import { MAX_RECEIPT_FILE_BYTES } from "@/lib/uploads/upload-policy";
import {
  RECEIPT_DUPLICATE_ERROR,
  RECEIPT_EXTRACTION_NOT_STARTED_MESSAGE,
  RECEIPT_EXTRACTION_UNSUPPORTED_IMAGE_MESSAGE,
  RECEIPT_FILE_MESSAGES,
  RECEIPT_GENERIC_ERROR,
  RECEIPT_UPLOAD_FAILED_ERROR,
  type SubmitReceiptState,
} from "@/app/(retailer)/retailer/receipts/submit-receipt-state";

/**
 * Server Action for submitting one customer receipt.
 *
 * NO TABLE IS WRITTEN HERE AND NO STORAGE CALL IS MADE HERE. Both effects are delegated:
 * @/lib/receipts/receipt-submissions runs the reserve → upload → finalize sequence, and
 * @/lib/receipts/receipt-extraction-request asks the shared Edge Function that a stored
 * receipt be read. `.from(` and `.storage` appear nowhere in this module, no service-role
 * client is constructed anywhere on this path, and the extraction tables are named in no
 * file of the web application.
 *
 * STORING AND READING ARE SEPARATE OPERATIONS, and this action reports them separately. A
 * receipt that was stored is never re-reported as an upload failure because the reading
 * could not be started, and it is never deleted or rolled back for that reason either —
 * see @/lib/receipts/receipt-submission-extraction-flow, which owns that decision.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT. It is reachable by a hand-crafted POST from any
 * client, regardless of which page rendered the form or whether that page rendered at
 * all. So this action re-establishes its own footing rather than trusting the route:
 * portal access is re-resolved, the assigned-shop list is re-read from the database,
 * and the file is re-validated from its own bytes. Hiding a control removes the
 * accident; only these checks — and the RPCs behind them — remove the capability.
 *
 * WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY: one shop id, and one file. There is no
 * Retailer organization id, profile id, membership id, role id, storage path, bucket,
 * status, or file hash accepted from the form — the hash is computed here from the
 * bytes, the path and bucket are generated in SQL, and the status is set by the
 * database.
 *
 * THE DECLARED CONTENT TYPE IS IGNORED. `File.type` is attacker-controlled; the
 * accepted MIME type is derived from the file's own leading bytes by
 * @/lib/receipts/receipt-file and that derived value is what is stored and uploaded.
 */

/** The staff receipt page — the single revalidation target, a fixed literal. */
const RECEIPTS_PATH = "/retailer/receipts";

/**
 * The user-facing sentences all live in ./submit-receipt-state.ts, and the browser reads
 * the SAME constants for the checks it performs before sending anything. A refusal
 * therefore reads identically whether the file never left the device or was refused here
 * from its own bytes.
 */
const GENERIC_ERROR = RECEIPT_GENERIC_ERROR;
const UPLOAD_FAILED_ERROR = RECEIPT_UPLOAD_FAILED_ERROR;
const DUPLICATE_ERROR = RECEIPT_DUPLICATE_ERROR;
const FILE_MESSAGES = RECEIPT_FILE_MESSAGES;

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(
  state: Partial<SubmitReceiptState>,
  selectedShopId: string,
): SubmitReceiptState {
  return {
    fieldErrors: {},
    formError: null,
    successMessage: null,
    selectedShopId,
    ...state,
  };
}

export async function submitReceiptAction(
  _prevState: SubmitReceiptState,
  formData: FormData,
): Promise<SubmitReceiptState> {
  const rawShopId = formData.get("shopId");
  const selectedShopId =
    typeof rawShopId === "string" ? rawShopId.trim().toLowerCase() : "";

  // ---------------------------------------------------------------------------
  // 1. Authorization, re-resolved from the verified session
  // ---------------------------------------------------------------------------
  // Defence in depth: the reservation RPC evaluates the same chain again from
  // auth.uid() and is what actually stops an unauthorized or cross-tenant submission.
  const access = await getRetailerPortalAccess();

  // redirect() signals by throwing NEXT_REDIRECT, so both calls sit outside any
  // try/catch in this module.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    return fail({ formError: GENERIC_ERROR }, selectedShopId);
  }

  // An Owner or a Manager reaching this endpoint is refused here AND by the RPC. They
  // cannot resolve as a submitter because RECEIPT_SUBMIT is mapped to SALES_STAFF
  // alone; this branch turns that into a clean message instead of a database error.
  if (access.kind !== "submitter") {
    return fail({ formError: GENERIC_ERROR }, selectedShopId);
  }

  // ---------------------------------------------------------------------------
  // 2. The assigned-shop set, re-read from the database for THIS caller
  // ---------------------------------------------------------------------------
  // Both the source of truth for validation and a second authorization gate. The
  // browser never supplies this set, and a shop id outside it is refused here before
  // the reservation RPC refuses it again in SQL.
  const assigned = await getMyAssignedReceiptShops();

  if (assigned.status !== "ok") {
    return fail({ formError: GENERIC_ERROR }, selectedShopId);
  }

  if (
    selectedShopId.length === 0 ||
    !UUID_PATTERN.test(selectedShopId) ||
    !assigned.shops.some((shop) => shop.shopId === selectedShopId)
  ) {
    // A blank selection, a malformed id and an id outside the assigned set are reported
    // identically. The last two can only come from a tampered submission, and
    // distinguishing them would confirm whether some other shop exists.
    return fail(
      { fieldErrors: { shopId: "Choose one of your assigned shops." } },
      selectedShopId,
    );
  }

  // ---------------------------------------------------------------------------
  // 3. The file
  // ---------------------------------------------------------------------------
  // The size is checked from the part's own metadata BEFORE the bytes are read into
  // memory, so an oversized upload is refused without buffering it. Everything after
  // that works from the bytes themselves.
  const parts = formData.getAll("receipt").filter((part) => part instanceof File);

  if (parts.length > 1) {
    return fail(
      { fieldErrors: { receipt: FILE_MESSAGES["too-many-files"] } },
      selectedShopId,
    );
  }

  const part = parts[0];

  if (!part || part.size === 0) {
    return fail(
      { fieldErrors: { receipt: FILE_MESSAGES[part ? "empty" : "missing"] } },
      selectedShopId,
    );
  }

  if (part.size > MAX_RECEIPT_FILE_BYTES) {
    return fail(
      { fieldErrors: { receipt: FILE_MESSAGES["too-large"] } },
      selectedShopId,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await part.arrayBuffer());
  } catch {
    // The thrown value is deliberately not bound or logged: a stream failure can carry
    // request detail.
    return fail({ formError: GENERIC_ERROR }, selectedShopId);
  }

  const validation = validateReceiptFile({
    fileName: part.name,
    bytes,
    fileCount: parts.length,
  });

  if (!validation.ok) {
    return fail(
      { fieldErrors: { receipt: FILE_MESSAGES[validation.reason] } },
      selectedShopId,
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Delegate
  // ---------------------------------------------------------------------------
  // The service returns a closed union of plain statuses plus, on success alone, the
  // submission id the reservation generated — no path, no bucket, no hash, no provider
  // code. That id is SERVER-SIDE MATERIAL: it is handed to the extraction request below
  // and goes no further. It is not returned from this action, not placed in
  // SubmitReceiptState, and not rendered. Everything below maps statuses to this
  // codebase's own strings; nothing from Storage or PostgreSQL is rendered.
  const submission = await submitReceipt(
    {
      shopId: selectedShopId,
      fileName: validation.file.fileName,
      mimeType: validation.file.mimeType,
      sizeBytes: validation.file.sizeBytes,
      sha256: validation.file.sha256,
    },
    bytes,
  );

  // ---------------------------------------------------------------------------
  // 5. Ask that the stored receipt be read
  // ---------------------------------------------------------------------------
  // THE RECEIPT IS ALREADY COMMITTED at this point, and nothing below may undo that. The
  // decision — whether to ask at all, and with which id — lives in the pure flow module
  // so it can be tested; this line supplies the one real effect.
  //
  // IT IS AWAITED, and that is load-bearing rather than stylistic: a promise left running
  // when a Server Action returns its response may be abandoned by the framework, which
  // would produce exactly the symptom this milestone exists to fix — a receipt that
  // uploads and a reading that never begins. There is no retry: asking again can consume
  // one of the three attempts a receipt gets in its lifetime.
  const result = await runReceiptSubmissionOutcome(
    submission,
    {
      mimeType: validation.file.mimeType,
      sizeBytes: validation.file.sizeBytes,
    },
    { requestExtraction: ({ submissionId }) => requestReceiptExtraction(submissionId) },
  );

  // The history changes on every stored receipt AND on a recorded upload failure, so the
  // page is revalidated for every outcome that reached the database.
  if (result.status.startsWith("submitted") || result.status === "upload-failed") {
    revalidatePath(RECEIPTS_PATH);
  }

  switch (result.status) {
    case "submitted":
      return {
        fieldErrors: {},
        formError: null,
        successMessage: `Receipt submitted from ${validation.file.fileName}.`,
        // Cleared so the next submission starts from a blank form.
        selectedShopId: "",
      };
    // BOTH OF THE NEXT TWO ARE SUCCESSES. The receipt is stored in each of them, so
    // neither may be reported as a failure and neither clears anything the person would
    // have to redo. They differ from the case above in one respect only: they do not
    // claim the automatic reading began, because it did not.
    case "submitted-extraction-unstarted":
      return {
        fieldErrors: {},
        formError: null,
        successMessage: RECEIPT_EXTRACTION_NOT_STARTED_MESSAGE,
        selectedShopId: "",
      };
    case "submitted-extraction-skipped":
      return {
        fieldErrors: {},
        formError: null,
        successMessage: RECEIPT_EXTRACTION_UNSUPPORTED_IMAGE_MESSAGE,
        selectedShopId: "",
      };
    case "duplicate":
      return fail(
        { fieldErrors: { receipt: DUPLICATE_ERROR } },
        selectedShopId,
      );
    case "upload-failed":
      return fail({ formError: UPLOAD_FAILED_ERROR }, selectedShopId);
    case "denied":
    case "invalid":
    case "unavailable":
    default:
      return fail({ formError: GENERIC_ERROR }, selectedShopId);
  }
}
