/**
 * PURE MODULE — no React, no I/O, no environment, no side effects. Its only import is a
 * sibling type.
 *
 * THE SHOP-SELECTION RULES for the Sales Staff receipt form, expressed once so they can be
 * tested in Node rather than inferred from JSX.
 *
 * ============================================================================
 * WHY THE ORDER OF THE TWO CHOICES IS A RULE AND NOT A LAYOUT PREFERENCE
 * ============================================================================
 * A person used to be able to choose a photograph, submit, be told the shop was missing, and
 * then lose the photograph — the form cleared the file input after EVERY attempt, including a
 * refused one, because a browser cannot repopulate a file input from the server. The fix is
 * structural rather than cosmetic: when there is a choice of shop to make, it must be made
 * BEFORE the file picker is usable, so the refusal that discarded the photograph cannot be
 * reached in the first place. Nothing here clears anything; the gate below is what makes the
 * clearing unnecessary.
 *
 * ============================================================================
 * NONE OF THIS IS AUTHORIZATION
 * ============================================================================
 * `shopCount` and `selectedShopId` come from list_my_assigned_receipt_shops() and from a
 * form control respectively. Both are conveniences. The Server Action re-reads the assigned
 * set for the authenticated caller and refuses an id outside it, and
 * reserve_receipt_submission proves the same chain again in SQL from auth.uid() — an ACTIVE
 * membership, a LIVE assignment (removed_at is null) and an ACTIVE shop of that same
 * Retailer. A tampered browser that skips every gate below still cannot submit against a
 * shop it is not assigned to.
 */

import type { AssignedReceiptShop } from "./receipt-normalization.ts";

/**
 * Which of the three shapes the form takes.
 *
 * `unassigned` — no active assignment. There is nothing to submit against.
 * `fixed`      — exactly one. The shop is context, not a question.
 * `choose`     — more than one. The shop is the first question asked.
 */
export type ReceiptShopMode = "unassigned" | "fixed" | "choose";

export function receiptShopMode(shopCount: number): ReceiptShopMode {
  if (!Number.isFinite(shopCount) || shopCount <= 0) return "unassigned";
  return shopCount === 1 ? "fixed" : "choose";
}

/**
 * The shop the form starts on.
 *
 * EXACTLY ONE ASSIGNED SHOP IS CHOSEN AUTOMATICALLY, because there is no choice to make and
 * asking would be a question with one answer. Any other count starts EMPTY: preselecting the
 * first of several shops would attribute a sale to whichever shop happens to sort first, and
 * no business contract in this codebase defines a safe default. A fabricated default is worse
 * than a blank one — it is wrong silently.
 */
export function initialSelectedShopId(shops: readonly AssignedReceiptShop[]): string {
  return shops.length === 1 ? shops[0].shopId : "";
}

/**
 * The shop the form should ACT on, given what it currently holds and what is actually assigned.
 *
 * WHY A RECONCILIATION EXISTS AT ALL. The assigned-shop list is re-read by the server on every
 * revalidation, so it can change under a form that is already on screen — an owner withdraws an
 * assignment, or closes a shop, while somebody is choosing a photograph. A selection that is no
 * longer in the list must not survive that: it would post a shop id the server refuses, and for
 * a person whose list has shrunk to one there would be no control on screen to correct it with.
 *
 * IT IS A DERIVATION, NOT A RESET. Nothing is stored and nothing else is touched — in
 * particular, a shop that disappears never discards a chosen file. The form simply acts on the
 * value that is still true, and falls back to the same starting point a fresh form would use.
 */
export function reconcileSelectedShopId(
  shops: readonly AssignedReceiptShop[],
  selectedShopId: string,
): string {
  if (shops.some((shop) => shop.shopId === selectedShopId)) return selectedShopId;
  return initialSelectedShopId(shops);
}

/** `Name · CODE` when the shop has a code, and the name alone when it does not. */
export function receiptShopLabel(shop: AssignedReceiptShop): string {
  return shop.shopCode ? `${shop.shopName} · ${shop.shopCode}` : shop.shopName;
}

export type ReceiptSelectionGateInput = {
  /** How many ACTIVE shops the caller is ACTIVELY assigned to. */
  readonly shopCount: number;
  /** The shop id currently held by the form, or "" for none. */
  readonly selectedShopId: string;
  /** Whether a file is currently in the picker. */
  readonly fileChosen: boolean;
  /** Whether a submission is in flight. */
  readonly pending: boolean;
  /** Whether the chosen file already failed the shared pre-flight check. */
  readonly fileRejected: boolean;
};

export type ReceiptSelectionGate = {
  readonly mode: ReceiptShopMode;
  /** Render the editable selector. True for `choose` alone. */
  readonly showShopSelector: boolean;
  /** Render the read-only "Submitting for: …" line. True for `fixed` alone. */
  readonly showFixedShopNotice: boolean;
  /** Whether the file input may be operated at all. */
  readonly fileSelectionEnabled: boolean;
  /** Whether Submit may be operated at all. */
  readonly submitEnabled: boolean;
};

/**
 * The whole gate, in one function.
 *
 * A FILE MAY BE CHOSEN ONLY ONCE A SHOP IS SETTLED. For `fixed` that is immediate — the one
 * assigned shop is already selected — and for `choose` it waits for the person. For
 * `unassigned` it never happens.
 *
 * SUBMIT NEEDS BOTH, ALWAYS. A shop AND a file, in every mode, plus a file the pre-flight
 * check did not already refuse. Offering Submit for an incomplete form would produce a
 * server refusal whose only purpose is to say what the form already knew.
 */
export function receiptSelectionGate(
  input: ReceiptSelectionGateInput,
): ReceiptSelectionGate {
  const mode = receiptShopMode(input.shopCount);
  const shopSettled = input.selectedShopId.length > 0;

  const fileSelectionEnabled = !input.pending && mode !== "unassigned" && shopSettled;

  return {
    mode,
    showShopSelector: mode === "choose",
    showFixedShopNotice: mode === "fixed",
    fileSelectionEnabled,
    submitEnabled:
      fileSelectionEnabled && input.fileChosen && !input.fileRejected,
  };
}
