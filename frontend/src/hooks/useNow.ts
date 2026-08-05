import { useEffect, useState } from "react";

/**
 * A clock that re-renders on an interval, so countdowns ("in 30 mins") stay
 * true without a page refresh. Defaults to a minute — the resolution the
 * human time formatters actually show.
 *
 * SSR renders the mount-time value; the first client tick corrects any drift.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
