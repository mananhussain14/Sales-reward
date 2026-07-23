import { cn } from "@/components/ui/cn";
import { SpinnerIcon } from "@/components/ui/icons";

/**
 * The button visual system, centralized.
 *
 * Exposed as a class-string helper rather than only a component so it works in
 * every context the app already uses: server-rendered `<Link>` call-to-actions,
 * `<form>` submit buttons wired to Server Actions, and plain `<button>`s — none
 * of which should be forced into a Client Component just to share styling.
 */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger";

export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold whitespace-nowrap transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:hover:translate-y-0";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 hover:shadow-elevated active:translate-y-px focus-visible:ring-indigo-500",
  secondary:
    "bg-slate-900 text-white shadow-sm hover:bg-slate-800 hover:shadow-elevated active:translate-y-px focus-visible:ring-slate-500",
  outline:
    "border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 hover:text-slate-900 active:translate-y-px focus-visible:ring-indigo-500",
  ghost:
    "text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-indigo-500",
  danger:
    "bg-red-600 text-white shadow-sm hover:bg-red-700 hover:shadow-elevated active:translate-y-px focus-visible:ring-red-500",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export function buttonClasses(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
  }: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean } = {},
  extra?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", extra);
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** When true, shows a spinner and a busy label; the button is also disabled. */
  loading?: boolean;
  /** Optional label shown while `loading`. Falls back to the button's children. */
  loadingLabel?: string;
};

/**
 * A `<button>` with the shared styling and a built-in pending state. Use it for
 * `<form>` submits driven by useActionState — pass `loading={pending}`.
 */
export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  loadingLabel,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={buttonClasses({ variant, size, fullWidth }, className)}
    >
      {loading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
