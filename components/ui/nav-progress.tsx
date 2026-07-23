"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { useLinkStatus } from "next/link";
import { SpinnerIcon } from "@/components/ui/icons";

/**
 * The global navigation progress indicator.
 *
 * WHY THIS APPROACH. The App Router exposes no global "is navigating" event, and
 * intercepting document clicks to fake one is the brittle hack the brief rules
 * out. Instead the bar is driven by Next.js's own {@link useLinkStatus} hook: a
 * tiny {@link NavProgressReporter} placed inside the shared navigation links
 * reports their pending state to this provider, which renders a single fixed bar
 * at the top of the shell. Completion is the real route commit — `usePathname`
 * changes the instant the destination is reached, at which point the route's own
 * `loading.tsx` skeleton takes over.
 *
 * It is presentation only and holds NO data: no route, id, name, token, or
 * identity ever reaches it, so there is nothing here to leak. The bar is
 * `position: fixed` and `pointer-events-none`, so it never shifts layout or
 * blocks interaction, and its motion is disabled under a reduced-motion
 * preference (see the `.sr-nav-progress` rules in globals.css). Modified clicks
 * (open-in-new-tab), external links, and Back/Forward are untouched — Link does
 * not report pending for them, so the bar simply does not appear.
 */
type NavProgressValue = { start: () => void };

const NavProgressContext = createContext<NavProgressValue | null>(null);

export function NavProgressProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const pathname = usePathname();
  const [lastPathname, setLastPathname] = useState(pathname);

  // Complete on route commit, using React's render-time "adjust state when an
  // input changes" pattern (react.dev, "You Might Not Need an Effect") rather than
  // a setState-in-effect. `usePathname` updates the moment the URL changes, which
  // is when the destination's loading.tsx (if any) renders and continues the
  // feedback; this also clears the bar after a Back/Forward navigation.
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setActive(false);
  }

  const start = useCallback(() => setActive(true), []);
  const value = useMemo<NavProgressValue>(() => ({ start }), [start]);

  return (
    <NavProgressContext.Provider value={value}>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
      >
        {active && <div className="sr-nav-progress" />}
      </div>
      {children}
    </NavProgressContext.Provider>
  );
}

/**
 * Drop inside a `<Link>` to feed the global bar. Renders nothing. Safe to include
 * where no provider is mounted (invitation/auth pages) — it simply no-ops.
 */
export function NavProgressReporter() {
  const { pending } = useLinkStatus();
  const ctx = useContext(NavProgressContext);

  useEffect(() => {
    if (pending && ctx) ctx.start();
  }, [pending, ctx]);

  return null;
}

/**
 * Drop inside a navigation `<Link>` to show a small spinner on that exact item
 * while it is the one being navigated to — the immediate "your click registered"
 * feedback on the clicked control itself.
 */
export function NavPendingSpinner({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <SpinnerIcon
      className={className ?? "h-4 w-4 shrink-0 animate-spin text-indigo-500"}
      aria-hidden="true"
    />
  );
}
