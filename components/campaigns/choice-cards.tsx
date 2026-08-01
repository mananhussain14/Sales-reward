"use client";

import { cn } from "@/components/ui/cn";
import { CheckIcon } from "@/components/ui/icons";

/**
 * The selectable option card used for every closed campaign choice — audience mode,
 * product scope, performance scope, reward rule and stacking.
 *
 * ONE component for all five, because the requirement is the same each time: an operator
 * choosing between two or three options needs to read what each one DOES, not what it is
 * called. A native radio does the work; the card is its label, so the whole surface is the
 * hit target and keyboard focus, checked state and screen-reader semantics come for free.
 *
 * SELECTION IS NEVER SIGNALLED BY COLOUR ALONE: the chosen card gains a check mark and a
 * heavier border as well as a tint, and the underlying radio is what a screen reader
 * announces regardless.
 *
 * The field NAME and VALUE are unchanged from the previous markup, so the FormData this
 * produces — and everything the Server Action and the RPC do with it — is identical.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  title,
  description,
  footnote,
  icon,
  disabled = false,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  title: string;
  description: string;
  /** An extra line shown only while the option is selected. */
  footnote?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-xl border p-4 transition-all",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 has-[:focus-visible]:ring-offset-2",
        checked
          ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-200"
          : "border-slate-200 bg-white hover:border-indigo-300 hover:bg-slate-50",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="sr-only"
      />

      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
            checked ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {icon}
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-slate-900">{title}</span>
          {/* A shape, not just a tint — the state survives greyscale and colour blindness. */}
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
              checked
                ? "border-indigo-600 bg-indigo-600 text-white"
                : "border-slate-300 bg-white",
            )}
          >
            {checked && <CheckIcon className="h-2.5 w-2.5" />}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-slate-600">
          {description}
        </span>
        {footnote && checked && (
          <span className="mt-2 block rounded-lg bg-white/70 px-2.5 py-1.5 text-xs leading-relaxed text-slate-600 ring-1 ring-inset ring-indigo-100">
            {footnote}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * A labelled group of choice cards.
 *
 * A real `<fieldset>`/`<legend>`, so the question is announced once and the options are
 * announced as members of it rather than as unrelated controls.
 */
export function ChoiceCardGroup({
  legend,
  hint,
  columns = 1,
  children,
}: {
  legend: string;
  hint?: string;
  columns?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-800">{legend}</legend>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      <div
        className={cn(
          "mt-3 grid gap-3",
          columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
        )}
      >
        {children}
      </div>
    </fieldset>
  );
}
