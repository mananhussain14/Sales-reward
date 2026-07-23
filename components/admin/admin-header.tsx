"use client";

import { SignOutButton } from "@/components/auth/sign-out-button";

type AdminHeaderProps = {
  /** Organization name from the authorized server-side access result. */
  organizationName: string;
  /** Signed-in administrator's name from the authorized server-side result. */
  userDisplayName: string;
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
  userDisplayName,
  sidebarOpen,
  onToggleSidebar,
}: AdminHeaderProps) {
  const initials = getOrganizationInitials(organizationName);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-slate-200 bg-white/85 px-4 backdrop-blur-md sm:px-6">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={sidebarOpen}
        aria-controls="admin-sidebar"
        className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:hidden"
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
        <h1 className="truncate text-base font-semibold text-slate-900">
          Vendor Admin
        </h1>
      </div>

      <div className="flex items-center gap-3">
        {/* Identity lockup: who is signed in, over which organization they are
            managing. Hidden below `sm`, where the avatar alone carries it. */}
        <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
          <span className="max-w-[12rem] truncate text-sm font-medium text-slate-900 md:max-w-[16rem]">
            {userDisplayName}
          </span>
          <span className="max-w-[12rem] truncate text-xs text-slate-500 md:max-w-[16rem]">
            {organizationName}
          </span>
        </div>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-sm"
          aria-hidden="true"
        >
          {initials}
        </span>

        {/* Separator between the identity lockup and the sign-out action. */}
        <span
          aria-hidden="true"
          className="hidden h-6 w-px bg-slate-200 sm:block"
        />

        <SignOutButton variant="header" />
      </div>
    </header>
  );
}
