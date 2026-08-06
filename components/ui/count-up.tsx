"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatCoins } from "@/lib/earnings/earnings-presentation";

/**
 * A whole number counting once to its stored value.
 *
 * ============================================================================
 * THE TRUTHFUL NUMBER IS THE DEFAULT; THE TWEEN IS THE EXCEPTION
 * ============================================================================
 * `displayed` is initialised to `value`, so the server-rendered HTML, the hydrated first
 * render, and every frame in which no run is in flight all show the figure the backend
 * returned. Only a run that is actually animating shows an intermediate value.
 *
 * That ordering is load-bearing rather than tidy. A number that is merely WAITING to
 * animate must never be rendered as a smaller number than the stored one — a reader whose
 * tab was in the background when the data landed would otherwise see `0 coins` on a screen
 * whose other figures read 155.
 *
 * ============================================================================
 * THE ANIMATION IS A FUNCTION OF THE VALUE, NOT OF THE RENDER
 * ============================================================================
 * The run restarts only when `value` actually changes. A parent re-render, a route
 * revalidation that returns the same figure, or a resize all leave the number exactly
 * where it is — which is the difference between a figure that settles and one that
 * flickers every time anything on the screen moves.
 *
 * A refreshed total slides from the OLD figure rather than dropping back to zero.
 *
 * ============================================================================
 * REDUCED MOTION REMOVES THE MOVEMENT, NEVER THE STATE
 * ============================================================================
 * Under `prefers-reduced-motion: reduce` no run is ever started, so the first and only
 * frame is the real number. The CSS reduced-motion rule in globals.css cannot help here —
 * this is a JavaScript animation over text content, not a CSS transition — so the query is
 * read directly.
 *
 * `tabular-nums` on the caller keeps every intermediate figure the same width, so a
 * counting number cannot reflow the layout around it.
 *
 * ============================================================================
 * IT FORMATS HERE RATHER THAN TAKING A FORMATTER
 * ============================================================================
 * A `format` callback would be a FUNCTION PROP, and functions cannot cross the Server
 * Component boundary — every caller of this component is a Server Component, so such a
 * prop fails at render time rather than at build time. The grouping rule is imported from
 * the same pure module the server pages use, so the animated figure and the static one
 * beside it cannot drift apart.
 */
/**
 * Layout effect in the browser, plain effect on the server.
 *
 * Hoisted to module scope because a hook chosen inside a component body reads as a
 * conditional hook even though `typeof window` never changes for a given runtime.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function CountUp({
  value,
  suffix,
  durationMs = 650,
}: {
  /** The authoritative figure. The run ends here, and never past it. */
  value: number;
  /** Appended after the grouped digits, e.g. `" coins"`. */
  suffix?: string;
  durationMs?: number;
}) {
  const [displayed, setDisplayed] = useState(value);
  const frameRef = useRef<number | null>(null);
  /**
   * Where the current run starts.
   *
   * Zero for the first run — that is the initial count-up the redesign asks for — and
   * thereafter wherever the last run finished, so a refreshed total slides from the old
   * figure rather than dropping back to zero.
   */
  const fromRef = useRef(0);

  // Layout effect rather than effect: it runs before the browser paints, so replacing
  // the settled figure with the start of a run cannot flash the final number first.
  useIsomorphicLayoutEffect(() => {
    if (typeof window === "undefined") return;

    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;

    if (reduced === true) {
      // The settled end, immediately.
      fromRef.current = value;
      setDisplayed(value);
      return;
    }

    const from = fromRef.current;
    if (from === value) {
      setDisplayed(value);
      return;
    }

    const start = performance.now();
    setDisplayed(from);

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      // Ease-out cubic, matching the ring's sweep so the two settle together.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (value - from) * eased);

      if (t >= 1) {
        fromRef.current = value;
        setDisplayed(value);
        frameRef.current = null;
        return;
      }
      setDisplayed(next);
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      // Whatever interrupted the run, the stored figure is where this must end up.
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return (
    <>
      {formatCoins(displayed)}
      {suffix ?? ""}
    </>
  );
}
