/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Where the two receipt READ RPCs' snake_case output becomes the application's
 * camelCase types, and where their runtime shape is validated. Free of side effects so
 * it can be exercised directly by ./receipt-normalization.test.ts; the server modules
 * that call the RPCs cannot be tested that way, because importing them pulls in
 * `next/headers`.
 *
 * WHY VALIDATE AT ALL. `supabase.rpc()` is untyped in this project (there are no
 * generated database types), so its result is `any`. A type assertion would be a claim
 * about the SQL, not a check of it, and TypeScript erases it at runtime.
 *
 * NOTHING UNSAFE PASSES THROUGH, because nothing unsafe arrives:
 * list_my_receipt_submissions returns no storage bucket, no object path, no file hash,
 * no profile id, no organization id and no failure code — so there is nothing of that
 * kind here to drop. The submission id is carried because a list needs a stable key,
 * and it is the caller's own row within their own tenant.
 */

/* ---------------------------------------------------------------------------
 * Assigned shops — public.list_my_assigned_receipt_shops()
 * ------------------------------------------------------------------------- */

export type AssignedReceiptShop = {
  shopId: string;
  shopName: string;
  shopCode: string | null;
};

export type AssignedShopsNormalization =
  | { status: "ok"; shops: AssignedReceiptShop[] }
  | { status: "malformed"; reason: string };

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function normalizeAssignedShops(data: unknown): AssignedShopsNormalization {
  if (!Array.isArray(data)) {
    return { status: "malformed", reason: "not-an-array" };
  }

  const shops: AssignedReceiptShop[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const shopId = requiredText(record.shop_id);
    const shopName = requiredText(record.shop_name);

    // A shop with no id is unusable — the id is the whole point of the selector — and
    // one with no name is unrenderable. Either means drift, so the read fails rather
    // than rendering an option that would submit an empty value.
    if (shopId === null) return { status: "malformed", reason: "shop_id" };
    if (shopName === null) return { status: "malformed", reason: "shop_name" };

    shops.push({
      shopId: shopId.toLowerCase(),
      shopName,
      shopCode: optionalText(record.shop_code),
    });
  }

  return { status: "ok", shops };
}

/* ---------------------------------------------------------------------------
 * Personal history — public.list_my_receipt_submissions()
 * ------------------------------------------------------------------------- */

/**
 * The three states the database stores, verbatim. Exhaustive: the
 * receipt_submissions_status_allowed CHECK permits exactly these. An unrecognized value
 * is treated as drift and fails the read rather than rendering an unknown badge.
 *
 * There is deliberately no review, approval, rejection or payout state — none of those
 * workflows exists, and this milestone does not invent their vocabulary.
 */
export const RECEIPT_SUBMISSION_STATUSES = [
  "RESERVED",
  "SUBMITTED",
  "UPLOAD_FAILED",
] as const;

export type ReceiptSubmissionStatus = (typeof RECEIPT_SUBMISSION_STATUSES)[number];

export type ReceiptSubmission = {
  submissionId: string;
  shopName: string;
  shopCode: string | null;
  status: ReceiptSubmissionStatus;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: number;
  submittedAt: string | null;
  createdAt: string | null;
};

export type ReceiptSubmissionsNormalization =
  | { status: "ok"; submissions: ReceiptSubmission[] }
  | { status: "malformed"; reason: string };

function isReceiptStatus(value: unknown): value is ReceiptSubmissionStatus {
  return (
    typeof value === "string" &&
    (RECEIPT_SUBMISSION_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeReceiptSubmissions(
  data: unknown,
): ReceiptSubmissionsNormalization {
  if (!Array.isArray(data)) {
    return { status: "malformed", reason: "not-an-array" };
  }

  const submissions: ReceiptSubmission[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const submissionId = requiredText(record.submission_id);
    const shopName = requiredText(record.shop_name);
    const originalFileName = requiredText(record.original_file_name);
    const mimeType = requiredText(record.mime_type);

    if (submissionId === null) return { status: "malformed", reason: "submission_id" };
    if (shopName === null) return { status: "malformed", reason: "shop_name" };
    if (originalFileName === null) {
      return { status: "malformed", reason: "original_file_name" };
    }
    if (mimeType === null) return { status: "malformed", reason: "mime_type" };
    if (!isReceiptStatus(record.status)) {
      return { status: "malformed", reason: "status" };
    }

    // bigint columns arrive from PostgREST as a JSON number when they fit, and as a
    // string when the driver plays safe. Both are accepted; anything else is drift.
    const rawSize = record.file_size_bytes;
    const fileSizeBytes =
      typeof rawSize === "number"
        ? rawSize
        : typeof rawSize === "string" && /^\d+$/.test(rawSize)
          ? Number(rawSize)
          : null;

    if (fileSizeBytes === null || !Number.isFinite(fileSizeBytes)) {
      return { status: "malformed", reason: "file_size_bytes" };
    }

    submissions.push({
      submissionId: submissionId.toLowerCase(),
      shopName,
      shopCode: optionalText(record.shop_code),
      status: record.status,
      originalFileName,
      mimeType,
      fileSizeBytes,
      submittedAt: optionalTimestamp(record.submitted_at),
      createdAt: optionalTimestamp(record.created_at),
    });
  }

  return { status: "ok", submissions };
}

/** The label shown for each status. Presentation only; nothing branches on it. */
const STATUS_LABELS: Record<ReceiptSubmissionStatus, string> = {
  RESERVED: "Not uploaded",
  SUBMITTED: "Submitted",
  UPLOAD_FAILED: "Upload failed",
};

export function receiptStatusLabel(status: ReceiptSubmissionStatus): string {
  return STATUS_LABELS[status];
}
