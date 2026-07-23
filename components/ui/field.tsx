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
  required = false,
  className,
}: {
  htmlFor: string;
  children: React.ReactNode;
  optional?: boolean;
  /** Renders a visible required marker, so a requirement is not left to color/placement. */
  required?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-sm font-medium text-slate-800", className)}
    >
      {children}
      {required && (
        <span className="ml-1 text-red-600" aria-hidden="true">
          *
        </span>
      )}
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

/**
 * The standard single-line text field, used across every form.
 *
 * CRITICAL LAYOUT RULE: the label sits on top, the input directly beneath it, and
 * the hint OR error is rendered BELOW the input. Keeping the guidance under the
 * control — never between the label and the input — is what makes two fields in a
 * `grid sm:grid-cols-2` line up: a field with a hint and a field without one still
 * present their inputs on the same row, because nothing of variable height sits
 * above the input. This survives a hint wrapping to two lines, an error appearing,
 * a longer label, and every viewport, since the message only ever grows downward.
 *
 * It renders a real, connected control: `htmlFor`/`id` tie the label to the input,
 * `aria-describedby` points at whichever message is shown, and `aria-invalid`
 * marks a rejected field. It carries no logic — the caller owns the value, the
 * error text, and the submit — so it changes no form behavior or field name.
 */
export function TextField({
  name,
  label,
  id,
  type = "text",
  defaultValue,
  value,
  readOnly = false,
  required = false,
  optional,
  hint,
  error,
  autoComplete,
  inputMode,
  maxLength,
  placeholder,
  disabled = false,
  inputClassName,
}: {
  name: string;
  label: string;
  /** Defaults to `name`. Set when two forms on one page could collide. */
  id?: string;
  type?: "text" | "email";
  /** Uncontrolled initial value (the common case — forms reset on action completion). */
  defaultValue?: string;
  /** Controlled value (used with `readOnly` for a locked, still-submitted field). */
  value?: string;
  readOnly?: boolean;
  required?: boolean;
  /** Shows the "(optional)" marker. Defaults to the inverse of `required`. */
  optional?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  autoComplete?: string;
  inputMode?: React.ComponentProps<"input">["inputMode"];
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  inputClassName?: string;
}) {
  const controlId = id ?? name;
  const showOptional = optional ?? !required;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  // Only the rendered message is referenced — error XOR hint below.
  const describedBy = error ? errorId : hintId;

  return (
    <div className="space-y-2">
      <Label htmlFor={controlId} required={required} optional={showOptional}>
        {label}
      </Label>
      <input
        id={controlId}
        name={name}
        type={type}
        defaultValue={defaultValue}
        value={value}
        readOnly={readOnly || undefined}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClasses(Boolean(error), inputClassName)}
      />
      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : hint ? (
        <FieldHint id={hintId}>{hint}</FieldHint>
      ) : null}
    </div>
  );
}
