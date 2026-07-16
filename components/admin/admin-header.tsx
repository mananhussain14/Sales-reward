"use client";

type AdminHeaderProps = {
  /** Whether the mobile sidebar drawer is currently open. */
  sidebarOpen: boolean;
  /** Toggles the mobile sidebar drawer. */
  onToggleSidebar: () => void;
};

export function AdminHeader({ sidebarOpen, onToggleSidebar }: AdminHeaderProps) {
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
        <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
          Vendor Company
        </span>
        <span
          className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-sm font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          aria-hidden="true"
        >
          VC
        </span>
      </div>
    </header>
  );
}
