/**
 * PURE MODULE — types and one port interface. No implementation, no I/O, no network.
 *
 * THE PROVIDER PORT. Everything downstream of this interface — the Edge Functions, the
 * ordered flow, the tests — is written against it and never against a concrete provider.
 * Milestone A ships exactly one implementation, the fake in
 * ./receipt-extraction-fake-provider.ts. A later milestone adds a second implementation of
 * this same interface and changes nothing else.
 *
 * THE SHAPE IS ASYNCHRONOUS ON PURPOSE, EVEN THOUGH THE FAKE IS INSTANT.
 *   submit()  hands the bytes over and returns an operation identifier.
 *   poll()    asks whether that operation has finished.
 * A real document-understanding service is a submit-then-poll API, so modelling the fake
 * as one synchronous call would mean the polling path, the PROCESSING state, the claim
 * deadline and the reaper were all untested scaffolding until the day a real provider
 * arrived — and then discovered broken. Keeping the two steps separate makes the
 * asynchronous shape the only path there is, exercised on every run.
 *
 * THE PORT NEVER SEES AUTHORIZATION. It receives bytes and a MIME type. It is not given
 * the submission id, the retailer, the profile, the storage bucket, the object path or the
 * file hash, because a provider adapter has no decision to make about any of them and a
 * value not passed is a value that cannot be logged or transmitted by an adapter written
 * later.
 */

import type {
  ExtractionFailureCode,
  ExtractionWarningCode,
} from "./receipt-extraction-vocabulary.ts";

/** A normalized monetary field: the integer minor units plus the text it was read from. */
export type NormalizedAmount = {
  /** Integer minor units, or null when the text could not be resolved with certainty. */
  readonly minor: number | null;
  /** The text exactly as printed. Retained even when `minor` is null — especially then. */
  readonly sourceText: string | null;
  /** Provider confidence in [0, 1], or null when the provider offers none. */
  readonly confidence: number | null;
};

/** A normalized textual field. */
export type NormalizedText = {
  readonly value: string | null;
  readonly sourceText: string | null;
  readonly confidence: number | null;
};

/** A normalized date field. `value` is an ISO calendar date, `YYYY-MM-DD`, with no zone. */
export type NormalizedDate = {
  readonly value: string | null;
  readonly sourceText: string | null;
  readonly confidence: number | null;
};

/** A normalized time field. `value` is `HH:MM`, minute precision, with no zone. */
export type NormalizedTime = {
  readonly value: string | null;
  readonly sourceText: string | null;
  readonly confidence: number | null;
};

/**
 * One normalized line item.
 *
 * INFORMATIONAL ONLY IN MILESTONE A. Line items are displayed for review; they are not
 * confirmation evidence, are not copied into a confirmation, and grant no reward
 * eligibility. Nothing in the schema or the RPCs reads them for a decision.
 */
export type NormalizedLineItem = {
  /** 1-based, dense, unique within the extraction. */
  readonly lineNumber: number;
  readonly description: string | null;
  readonly descriptionSourceText: string | null;
  /** Up to three decimal places; the only non-integer numeric in the extraction schema. */
  readonly quantity: number | null;
  readonly quantitySourceText: string | null;
  readonly unitPriceMinor: number | null;
  readonly unitPriceSourceText: string | null;
  readonly lineTotalMinor: number | null;
  readonly lineTotalSourceText: string | null;
  readonly confidence: number | null;
};

/** The full normalized reading of one receipt. */
export type NormalizedExtraction = {
  readonly merchantName: NormalizedText;
  readonly documentNumber: NormalizedText;
  readonly transactionDate: NormalizedDate;
  readonly transactionTime: NormalizedTime;
  readonly currencyCode: NormalizedText;
  readonly total: NormalizedAmount;
  readonly subtotal: NormalizedAmount;
  readonly taxTotal: NormalizedAmount;
  readonly warningCodes: readonly ExtractionWarningCode[];
};

/** The result of handing the bytes to the provider. */
export type ExtractionSubmitResult =
  | { readonly status: "ok"; readonly providerOperationId: string }
  | { readonly status: "failed"; readonly failureCode: ExtractionFailureCode };

/** The result of asking whether an operation has finished. */
export type ExtractionPollResult =
  | { readonly status: "pending" }
  | {
      readonly status: "succeeded";
      readonly normalized: NormalizedExtraction;
      readonly lineItems: readonly NormalizedLineItem[];
    }
  | { readonly status: "failed"; readonly failureCode: ExtractionFailureCode };

/** What the provider is given. Bytes and a MIME type, and deliberately nothing else. */
export type ExtractionSubmitInput = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
};

/** What a poll is given. `startedAtMs` and `nowMs` are injected so time is never read here. */
export type ExtractionPollInput = {
  readonly providerOperationId: string;
  readonly startedAtMs: number;
  readonly nowMs: number;
};

/**
 * The port every extraction provider implements.
 *
 * `name` and `model` are recorded on the attempt as provider-neutral operational metadata.
 * In Milestone A `name` can only ever be "FAKE": the database CHECK
 * `provider is null or provider = 'FAKE'` refuses anything else, so "no real provider was
 * called" is an invariant of the data rather than a claim about the code.
 */
export type ReceiptExtractionProvider = {
  readonly name: string;
  readonly model: string;
  submit(input: ExtractionSubmitInput): Promise<ExtractionSubmitResult>;
  poll(input: ExtractionPollInput): Promise<ExtractionPollResult>;
};

/** An empty normalized field, for a value the provider did not read. */
export const EMPTY_TEXT: NormalizedText = { value: null, sourceText: null, confidence: null };
export const EMPTY_AMOUNT: NormalizedAmount = { minor: null, sourceText: null, confidence: null };
