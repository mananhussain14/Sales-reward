/**
 * Minimal class-name joiner.
 *
 * Filters out falsey values so conditional classes read cleanly at the call
 * site — `cn("base", active && "on")`. Kept dependency-free on purpose: the
 * project policy forbids adding packages, and this is all `clsx` would give us
 * here.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
