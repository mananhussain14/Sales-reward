"use client";

import { useId, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import { inputClasses } from "@/components/ui/field";
import { CheckIcon, SearchIcon, XIcon } from "@/components/ui/icons";

/**
 * The searchable multi-select behind every "which Retailers / which groups / which
 * products" choice, shared by the campaign wizard AND Retailer-group creation and editing
 * so all four read and behave identically.
 *
 * ============================================================================
 * THE SEARCH IS PURELY VISUAL — THIS IS A CORRECTNESS PROPERTY, NOT A STYLE CHOICE
 * ============================================================================
 * Every option stays MOUNTED and is merely hidden when it does not match the query. An
 * unmounted checkbox is absent from the FormData, and for `set_vendor_retailer_group_members`
 * — which REPLACES the whole membership — that would silently remove Retailers the
 * operator never touched. Hiding preserves the submission; unmounting would corrupt it.
 * The previous implementation did this correctly and the behaviour is carried over
 * unchanged.
 *
 * NO INTERNAL IDENTIFIER IS EVER RENDERED. Ids live in `value` attributes and React keys —
 * addresses the server re-validates — and appear in no visible text, title or aria-label.
 * Every label a person reads is a name.
 */

export type PickerOption = {
  id: string;
  primary: string;
  secondary: string | null;
  /** False when the option cannot be used; it stays visible and is explained. */
  isSelectable: boolean;
  /** Why it cannot be used, or any other short caveat worth surfacing. */
  note: string | null;
};

export function EntityPicker({
  name,
  label,
  options,
  selected,
  onToggle,
  onClear,
  searchLabel,
  emptyMessage,
  noun,
  disabled = false,
  invalid = false,
  describedBy,
}: {
  name: string;
  /** Visible heading for the picker; also the accessible name of the option group. */
  label: string;
  options: PickerOption[];
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  onClear?: () => void;
  searchLabel: string;
  emptyMessage: string;
  /** Singular noun used in the counts — "Retailer", "group", "product". */
  noun: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const listId = useId();

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      new Set(
        options
          .filter(
            (option) =>
              needle.length === 0 ||
              option.primary.toLowerCase().includes(needle) ||
              (option.secondary ?? "").toLowerCase().includes(needle),
          )
          .map((option) => option.id),
      ),
    [options, needle],
  );

  if (options.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
        {emptyMessage}
      </p>
    );
  }

  const count = selected.size;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-white",
        invalid ? "border-red-400" : "border-slate-200",
      )}
      aria-describedby={describedBy}
    >
      {/* Toolbar: search on the left, the live count on the right. */}
      <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/70 p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <label htmlFor={searchId} className="sr-only">
            {searchLabel}
          </label>
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-controls={listId}
            className={inputClasses(false, "h-10 pl-9")}
          />
        </div>

        <div className="flex items-center gap-3">
          {/* The one number an operator checks before saving. `aria-live` sits directly
              above the text it announces so the association is obvious to a reader — and
              to the source-level guard that asserts this count is announced at all. */}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
              count > 0
                ? "bg-indigo-50 text-indigo-700 ring-indigo-600/20"
                : "bg-white text-slate-500 ring-slate-300",
            )}
            aria-live="polite"
          >
            {count > 0 && <CheckIcon className="h-3 w-3" aria-hidden="true" />}
            {count} {count === 1 ? noun : `${noun}s`} selected
          </span>

          {onClear && count > 0 && (
            <button
              type="button"
              onClick={onClear}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
            >
              <XIcon className="h-3 w-3" aria-hidden="true" />
              Clear
            </button>
          )}
        </div>
      </div>

      <fieldset id={listId} className="max-h-80 overflow-y-auto p-2" disabled={disabled}>
        <legend className="sr-only">{label}</legend>

        {matches.size === 0 && (
          <p className="px-3 py-6 text-center text-sm text-slate-500">
            Nothing matches “{query.trim()}”.
          </p>
        )}

        {options.map((option) => {
          const checked = selected.has(option.id);
          const hidden = !matches.has(option.id);
          return (
            <label
              key={option.id}
              // Hidden, NEVER unmounted — see the header. An off-screen checkbox still
              // submits, which is what keeps a filtered view from dropping a selection.
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500",
                hidden && "hidden",
                checked
                  ? "border-indigo-200 bg-indigo-50"
                  : "border-transparent hover:bg-slate-50",
              )}
            >
              <input
                type="checkbox"
                name={name}
                value={option.id}
                checked={checked}
                onChange={(event) => onToggle(option.id, event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">
                  {option.primary}
                </span>
                {option.secondary && (
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {option.secondary}
                  </span>
                )}
                {option.note && (
                  <span className="mt-1 inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
                    {option.note}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}
