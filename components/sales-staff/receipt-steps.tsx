import { cn } from "@/components/ui/cn";

/**
 * What submitting a receipt actually involves, as a four-step readout.
 *
 * ============================================================================
 * IT IS A STRIP, NOT A STEPPER
 * ============================================================================
 * Nothing on it navigates and nothing on it is a control. It sets expectations before a
 * person starts, and that is all — the form below is a single page, and pretending
 * otherwise would offer steps that cannot be visited.
 *
 * ============================================================================
 * THE LAST STEP IS A PROCESS, NOT A RESULT
 * ============================================================================
 * It says a reviewer verifies the sale. It does NOT say the receipt was read
 * automatically, that its text was extracted, or that a reward follows — whether a sale
 * qualifies is decided by verification and by the campaign, and this screen performs
 * neither. A strip that promised a result would be the one untrue sentence on the page.
 */
const STEPS = [
  {
    title: "Choose your shop",
    detail: "Only shops you are currently assigned to are listed.",
  },
  {
    title: "Add the receipt photo",
    detail: "One clear image of the whole receipt.",
  },
  {
    title: "Submit securely",
    detail: "The image is stored privately against your submission.",
  },
  {
    title: "A reviewer verifies the sale",
    detail: "Rewards are decided after that, and not every receipt qualifies.",
  },
];

export function ReceiptStepsStrip({ className }: { className?: string }) {
  return (
    <ol className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {STEPS.map((step, index) => (
        <li
          key={step.title}
          className="flex gap-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-700"
          >
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{step.title}</p>
            <p className="mt-0.5 text-xs text-slate-500">{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
