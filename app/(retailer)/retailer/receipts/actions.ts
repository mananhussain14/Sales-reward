"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { getMyAssignedReceiptShops } from "@/lib/receipts/receipt-data";
import { submitReceipt } from "@/lib/receipts/receipt-submissions";
import {
  MAX_RECEIPT_FILE_BYTES,
  validateReceiptFile,
  type ReceiptFileRejection,
} from "@/lib/receipts/receipt-file";
import type { SubmitReceiptState } from "@/app/(retailer)/retailer/receipts/submit-receipt-state";

/**
 * Server Action for submitting one customer receipt.
 *
 * NO TABLE IS WRITTEN HERE AND NO STORAGE CALL IS MADE HERE. Every effect is delegated
 * to @/lib/receipts/receipt-submissions, which runs the reserve → upload → finalize
 * sequence. `.from(` and `.storage` appear nowhere in this module.
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
 * The one message for every failure that is not a field problem.
 *
 * It covers an unauthorized caller, an unassigned or inactive shop, another Retailer's
 * shop, a shop id that does not exist, and a database outage. Collapsing them is
 * deliberate: the reservation RPC already refuses all of the addressing cases with a
 * single byte-identical exception so it cannot be used to probe another Retailer's
 * estate, and distinguishing them here would reintroduce exactly that disclosure.
 */
const GENERIC_ERROR =
  "We couldn't submit that receipt. Check the details and try again.";

/**
 * Shown when the reservation succeeded but the file did not reach storage.
 *
 * Safe to be specific: nothing about the provider, the bucket, the key, or the error is
 * named, and telling the person it was the UPLOAD that failed is what tells them
 * retrying the same photo is the right next step.
 */
const UPLOAD_FAILED_ERROR =
  "Your receipt could not be uploaded. Please check your connection and try again.";

/** Shown when this person already has a live submission of this exact file. */
const DUPLICATE_ERROR =
  "You've already submitted this receipt. Choose a different photo, or check your history below.";

/** One message per distinct, user-actionable file problem. */
const FILE_MESSAGES: Record<ReceiptFileRejection, string> = {
  missing: "Choose a receipt photo to upload.",
  empty: "That file is empty. Choose a different photo.",
  "too-large": `That file is too large. Receipts must be ${Math.floor(
    MAX_RECEIPT_FILE_BYTES / (1024 * 1024),
  )} MB or smaller.`,
  "unsupported-type": "Receipts must be a JPEG, PNG or WebP image.",
  "invalid-name": "That file name could not be read. Rename the file and try again.",
  "too-many-files": "Upload one receipt at a time.",
};

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
  // The service returns a closed union of plain statuses — no submission id, no path,
  // no bucket, no hash, no provider code. Everything below maps those to this
  // codebase's own strings; nothing from Storage or PostgreSQL is rendered.
  const result = await submitReceipt(
    {
      shopId: selectedShopId,
      fileName: validation.file.fileName,
      mimeType: validation.file.mimeType,
      sizeBytes: validation.file.sizeBytes,
      sha256: validation.file.sha256,
    },
    bytes,
  );

  // The history changes on success AND on a recorded upload failure, so the page is
  // revalidated for every outcome that reached the database.
  if (result.status === "submitted" || result.status === "upload-failed") {
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
