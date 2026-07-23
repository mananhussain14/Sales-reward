import { cn } from "@/components/ui/cn";

/**
 * Initials avatar.
 *
 * A decorative identity chip built from a person's or organization's display
 * name — never from an id, email, or any other identifier. Names are
 * operator-entered free text, so the derivation tolerates padding, runs of
 * whitespace, and the empty string rather than assuming a clean value, matching
 * the shell headers' existing rule.
 */
export type AvatarTone = "indigo" | "emerald" | "amber" | "slate";

const TONES: Record<AvatarTone, string> = {
  indigo: "bg-gradient-to-br from-indigo-500 to-violet-600 text-white",
  emerald: "bg-gradient-to-br from-emerald-500 to-teal-600 text-white",
  amber: "bg-gradient-to-br from-amber-500 to-orange-600 text-white",
  slate: "bg-slate-200 text-slate-600",
};

const SIZES = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
} as const;

/** Up to two initials from a free-text name. Falls back to the provided default. */
export function getInitials(name: string, fallback = "?"): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  const initials =
    words.length === 1
      ? words[0].slice(0, 2)
      : words[0].charAt(0) + words[words.length - 1].charAt(0);
  return initials.toUpperCase() || fallback;
}

export function InitialsAvatar({
  name,
  tone = "indigo",
  size = "md",
  className,
}: {
  name: string;
  tone?: AvatarTone;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold shadow-sm",
        TONES[tone],
        SIZES[size],
        className,
      )}
    >
      {getInitials(name)}
    </span>
  );
}
