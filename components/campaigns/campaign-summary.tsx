"use client";

import { cn } from "@/components/ui/cn";
import { AlertTriangleIcon, CheckIcon } from "@/components/ui/icons";

/**
 * The wizard's live summary — what the campaign currently says, in one place, updating as
 * the operator moves through the steps.
 *
 * Its purpose is to remove the need to page backwards to remember a decision made three
 * steps ago. It is READ-ONLY and derives nothing: the wizard passes finished display
 * strings, so this component cannot disagree with the step that produced one.
 *
 * PRESENTATION FOLLOWS WIDTH:
 *   * `xl` and wider — a sticky panel beside the form.
 *   * below that — a native `<details>`, collapsed by default, so it costs one line of
 *     vertical space on a phone instead of a screen of it. `<details>` is used rather than
 *     a hand-built disclosure because the browser already gives it correct expand/collapse
 *     semantics, keyboard operation and find-in-page behaviour.
 */

export type SummaryRow = {
  key: string;
  label: string;
  /** The finished display string, or null while the step is still incomplete. */
  value: string | null;
  /** A shorter clarifying line — e.g. how product eligibility resolves. */
  detail?: string | null;
};

function Rows({ rows }: { rows: SummaryRow[] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-3 py-2.5">
          <dt className="shrink-0 text-xs font-medium text-slate-500">{row.label}</dt>
          <dd className="min-w-0 text-right">
            {row.value === null ? (
              // Not a dash: a dash reads as "none", and the honest state is "not chosen
              // yet". Stated in words, with an icon so it is not colour alone.
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                <AlertTriangleIcon className="h-3 w-3" aria-hidden="true" />
                Not set
              </span>
            ) : (
              <>
                <span className="block text-sm font-medium text-slate-900">
                  {row.value}
                </span>
                {row.detail && (
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {row.detail}
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CampaignSummaryPanel({
  rows,
  completeCount,
  totalCount,
  className,
}: {
  rows: SummaryRow[];
  completeCount: number;
  totalCount: number;
  className?: string;
}) {
  const allSet = completeCount === totalCount;

  const heading = (
    <span className="flex items-center gap-2">
      <span className="text-sm font-semibold text-slate-900">Campaign summary</span>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
          allSet
            ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
            : "bg-slate-100 text-slate-600 ring-slate-500/20",
        )}
      >
        {allSet && <CheckIcon className="h-3 w-3" aria-hidden="true" />}
        {completeCount}/{totalCount}
      </span>
    </span>
  );

  return (
    <div className={className}>
      {/* Narrow: collapsible, so it never pushes the form off the first screen. */}
      <details className="group rounded-2xl border border-slate-200 bg-white shadow-card xl:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
          {heading}
          <span
            aria-hidden="true"
            className="text-xs font-medium text-slate-500 group-open:hidden"
          >
            Show
          </span>
          <span
            aria-hidden="true"
            className="hidden text-xs font-medium text-slate-500 group-open:inline"
          >
            Hide
          </span>
        </summary>
        <div className="border-t border-slate-100 px-4 pb-2">
          <Rows rows={rows} />
        </div>
      </details>

      {/* Wide: sticky beside the form. */}
      <aside className="sticky top-6 hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-card xl:block">
        <div className="flex items-center justify-between gap-3">{heading}</div>
        <div className="mt-2">
          <Rows rows={rows} />
        </div>
      </aside>
    </div>
  );
}

/**
 * One block of the review step: a heading, an Edit link back to the step that owns it, and
 * the decisions it holds.
 *
 * An INCOMPLETE section is announced rather than left to a row of dashes — the previous
 * review screen rendered "—" for anything unset, which looks identical to a value that is
 * legitimately empty. Here the section is tinted, carries a worded warning and names what
 * is missing.
 */
export function ReviewSection({
  title,
  onEdit,
  editLabel,
  incomplete = false,
  incompleteMessage,
  children,
}: {
  title: string;
  onEdit: () => void;
  editLabel: string;
  incomplete?: boolean;
  incompleteMessage?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border p-4",
        incomplete ? "border-amber-300 bg-amber-50/40" : "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          {incomplete && (
            <AlertTriangleIcon
              className="h-3.5 w-3.5 text-amber-600"
              aria-hidden="true"
            />
          )}
          {title}
        </h3>
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {editLabel}
        </button>
      </div>

      {incomplete && incompleteMessage && (
        <p className="mt-1.5 text-xs font-medium text-amber-800">{incompleteMessage}</p>
      )}

      <div className="mt-2.5 space-y-1.5 text-sm text-slate-700">{children}</div>
    </section>
  );
}

/** A single fact inside a review section. */
export function ReviewFact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <span className="min-w-0 text-slate-800">{children}</span>
    </p>
  );
}
