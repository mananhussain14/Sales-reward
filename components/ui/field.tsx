import { cn } from "@/components/ui/cn";

/**
 * Form control styling, centralized.
 *
 * Every input, textarea and select in the product shares one look: 12px radius,
 * a slate border that turns indigo on focus with a soft ring, and a consistent
 * disabled treatment. Exposed as class helpers so both server-rendered and
 * client forms use the identical surface without duplicating long class strings.
 */
const CONTROL_BASE =
  "block w-full rounded-xl border bg-white text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus-visible:ring-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70";

const CONTROL_OK =
  "border-slate-300 focus-visible:border-indigo-500 focus-visible:ring-indigo-500/30";

const CONTROL_ERROR =
  "border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/30";

export function inputClasses(hasError = false, extra?: string): string {
  return cn(
    CONTROL_BASE,
    "h-11 px-3.5",
    hasError ? CONTROL_ERROR : CONTROL_OK,
    extra,
  );
}

export function textareaClasses(hasError = false, extra?: string): string {
  return cn(
    CONTROL_BASE,
    "min-h-24 px-3.5 py-2.5",
    hasError ? CONTROL_ERROR : CONTROL_OK,
    extra,
  );
}

export function selectClasses(hasError = false, extra?: string): string {
  return cn(
    CONTROL_BASE,
    "h-11 px-3.5 pr-9 appearance-none bg-no-repeat",
    hasError ? CONTROL_ERROR : CONTROL_OK,
    extra,
  );
}

/** A native chevron for custom-styled selects, positioned by the caller. */
export function SelectChevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400",
        className,
      )}
    >
      <path d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

export function Label({
  htmlFor,
  children,
  optional = false,
  className,
}: {
  htmlFor: string;
  children: React.ReactNode;
  optional?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-sm font-medium text-slate-800", className)}
    >
      {children}
      {optional && (
        <span className="ml-1 font-normal text-slate-400">(optional)</span>
      )}
    </label>
  );
}

export function FieldHint({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-xs text-slate-500">
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-sm font-medium text-red-700">
      {children}
    </p>
  );
}

/**
 * A labelled field wrapper. Composes the label, an optional hint, the control
 * (passed as children so any element works), and an optional error, with the
 * consistent vertical rhythm used across every form.
 */
export function Field({
  label,
  htmlFor,
  optional = false,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={htmlFor} optional={optional}>
        {label}
      </Label>
      {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
      {children}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
