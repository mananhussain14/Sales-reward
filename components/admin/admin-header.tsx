"use client";

import { SignOutButton } from "@/components/auth/sign-out-button";

type AdminHeaderProps = {
  /** Organization name from the authorized server-side access result. */
  organizationName: string;
  /** Whether the mobile sidebar drawer is currently open. */
  sidebarOpen: boolean;
  /** Toggles the mobile sidebar drawer. */
  onToggleSidebar: () => void;
};

/** Shown when a name yields no initials at all (e.g. whitespace only). */
const FALLBACK_INITIALS = "VA";

/**
 * Derives up to two avatar initials from an organization name.
 *
 * A single word contributes its first two characters ("SalesReward" → "SA");
 * two or more words contribute one character each ("Acme Rewards Company" →
 * "AR"). Names are operator-entered free text, so this must tolerate padding,
 * runs of whitespace, and the empty string rather than assume a clean value.
 */
function getOrganizationInitials(organizationName: string): string {
  const words = organizationName.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return FALLBACK_INITIALS;

  const initials =
    words.length === 1
      ? words[0].slice(0, 2)
      : words[0].charAt(0) + words[1].charAt(0);

  return initials.toUpperCase() || FALLBACK_INITIALS;
}

export function AdminHeader({
  organizationName,
  sidebarOpen,
  onToggleSidebar,
}: AdminHeaderProps) {
  const initials = getOrganizationInitials(organizationName);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/80">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={sidebarOpen}
        aria-controls="admin-sidebar"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
        </svg>
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Vendor Admin
        </h1>
      </div>

      <div className="flex items-center gap-3">
        <span className="hidden max-w-[16rem] truncate text-sm text-zinc-500 sm:inline dark:text-zinc-400">
          {organizationName}
        </span>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          aria-hidden="true"
        >
          {initials}
        </span>

        {/* Separator between the identity lockup and the sign-out action. */}
        <span
          aria-hidden="true"
          className="hidden h-6 w-px bg-zinc-200 sm:block dark:bg-zinc-800"
        />

        <SignOutButton variant="header" />
      </div>
    </header>
  );
}
