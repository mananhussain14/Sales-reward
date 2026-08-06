import Link from "next/link";
import { CameraPlusIcon } from "@/components/ui/icons";
import { cn } from "@/components/ui/cn";
import {
  ADD_RECEIPT,
  ADD_RECEIPT_HINT,
  ADD_RECEIPT_SEMANTIC_LABEL,
} from "@/lib/sales-staff/home-copy";

/**
 * The primary action of the whole Sales Staff experience.
 *
 * ============================================================================
 * IT OPENS THE EXISTING FLOW AND OWNS NOTHING
 * ============================================================================
 * A link to the receipt route. There is NO second submission workflow behind this
 * control, no dialog that uploads, and no duplicate of the receipt form — the screen it
 * opens is the one that has always performed the write, with its own Server Action, its
 * own validation and its own in-flight guard.
 *
 * ============================================================================
 * "TO QUALIFY", NOT "TO EARN"
 * ============================================================================
 * Submitting a receipt makes a sale eligible for evaluation. Whether it earns anything is
 * decided by verification and by the campaign, neither of which this button performs, so
 * the supporting line promises qualification and never a reward.
 *
 * The gradient is the one place in the product a control carries one. Everything else it
 * keeps — the radius family, the semibold label, the 8px icon gap, the press settle —
 * matches the shared button exactly.
 */
export function AddReceiptAction({
  compact = false,
  className,
}: {
  /** Drops the supporting line, for a header where the hint would be noise. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href="/retailer/receipts"
      aria-label={ADD_RECEIPT_SEMANTIC_LABEL}
      className={cn(
        "group inline-flex items-center gap-3 rounded-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-elevated transition-all duration-150 hover:from-indigo-700 hover:to-violet-700 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
        compact ? "px-5 py-2.5" : "px-6 py-3",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20"
      >
        <CameraPlusIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-tight">
          {ADD_RECEIPT}
        </span>
        {!compact && (
          <span className="block text-xs leading-tight text-white/85">
            {ADD_RECEIPT_HINT}
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * The same action, pinned above the mobile navigation bar.
 *
 * ============================================================================
 * IT CLEARS THE CHROME BY CONSTRUCTION
 * ============================================================================
 * `RESERVED_HEIGHT` is the room the scrolling page leaves beneath its last card, so
 * nothing is ever trapped behind this pill. It sits ABOVE the bottom navigation rather
 * than over it, and `env(safe-area-inset-bottom)` keeps it clear of a home indicator.
 *
 * Right-aligned rather than centred, and the reason is a collision rather than a
 * preference: the hero's own action is left-aligned, so at no scroll position do the two
 * controls occupy one patch of screen.
 *
 * Hidden from `lg` up, where the sidebar is permanent and the action lives in the page
 * header instead — a floating pill with no bottom chrome to float above is just a button
 * in the wrong place.
 */
export function AddReceiptFloatingAction() {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-30 flex justify-end px-4 lg:hidden"
      // Above the bottom navigation bar, plus the device's own safe area.
      style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <AddReceiptAction className="pointer-events-auto" />
    </div>
  );
}

/**
 * The space the scrolling content reserves for the floating pill and the bottom bar.
 *
 * Declared once, beside the components that create the obstruction, so a layout cannot
 * drift out of agreement with them.
 */
export const RESERVED_BOTTOM_SPACE = "pb-40 lg:pb-0";
