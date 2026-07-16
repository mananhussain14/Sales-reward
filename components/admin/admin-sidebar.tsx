"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, type NavItem } from "@/components/admin/nav-items";

type AdminSidebarProps = {
  /** Whether the off-canvas drawer is open (mobile only). */
  open: boolean;
  /** Called when a navigation action should dismiss the mobile drawer. */
  onNavigate: () => void;
};

function NavIcon({ children }: { children: NavItem["icon"] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function AdminSidebar({ open, onNavigate }: AdminSidebarProps) {
  const pathname = usePathname();

  return (
    <nav
      id="admin-sidebar"
      aria-label="Primary"
      className={[
        "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-zinc-200 bg-white",
        "transition-transform duration-200 ease-in-out",
        "dark:border-zinc-800 dark:bg-zinc-950",
        open ? "translate-x-0" : "-translate-x-full",
        "lg:translate-x-0",
      ].join(" ")}
    >
      <div className="flex h-16 items-center gap-2 border-b border-zinc-200 px-5 dark:border-zinc-800">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white">
          SR
        </span>
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          SalesReward
        </span>
      </div>

      <ul className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const isActive = !item.disabled && pathname === item.href;

          if (item.disabled) {
            return (
              <li key={item.label}>
                <span
                  aria-disabled="true"
                  title="Coming soon"
                  className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-zinc-400 dark:text-zinc-600"
                >
                  <NavIcon>{item.icon}</NavIcon>
                  <span className="flex-1">{item.label}</span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    Soon
                  </span>
                </span>
              </li>
            );
          }

          return (
            <li key={item.label}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                onClick={onNavigate}
                className={[
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                  isActive
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                ].join(" ")}
              >
                <NavIcon>{item.icon}</NavIcon>
                <span className="flex-1">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <p className="text-xs text-zinc-400 dark:text-zinc-600">
          Vendor Admin · v0.1
        </p>
      </div>
    </nav>
  );
}
