"use client";

import { useEffect, useState } from "react";

/**
 * A ticking epoch-seconds clock for client components.
 *
 * Pages that gate actions on a deadline must re-render as the deadline passes,
 * not only when the user interacts — otherwise a "Run resolution" button that
 * was valid when the page loaded stays on screen after the window has closed.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
