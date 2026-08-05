/**
 * Human time formatting shared by every surface that shows "when".
 *
 * Two rules the UI depends on:
 * - Absolute times render in the **viewer's local zone**. A trader reads the
 *   calendar against their own clock, not UTC.
 * - Relative times read as words ("in 30 mins", "4 hours ago"), rounded to a
 *   single unit. Precision beyond the unit is noise at a glance.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "30 mins" / "4 hours" / "2 days" — magnitude only, no direction. */
export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return "less than a minute";
  if (abs < HOUR) return plural(Math.round(abs / MINUTE), "min");
  if (abs < DAY) return plural(Math.round(abs / HOUR), "hour");
  return plural(Math.round(abs / DAY), "day");
}

/**
 * Direction-aware phrasing around `now`: "in 4 hours" ahead, "30 mins ago"
 * behind, "now" inside the last minute either way.
 */
export function humanRelative(at: number | string, now = Date.now()): string {
  const time = typeof at === "string" ? new Date(at).getTime() : at;
  if (!Number.isFinite(time)) return "—";
  const delta = time - now;
  if (Math.abs(delta) < MINUTE) return "now";
  return delta > 0 ? `in ${humanDuration(delta)}` : `${humanDuration(delta)} ago`;
}

/** Local clock time, e.g. "21:00". */
export function localTime(at: number | string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Local calendar label relative to today: "Today", "Tomorrow", else
 * "Thu, Aug 7". Same-day comparison is done on local date parts, so it flips
 * at the viewer's midnight rather than UTC's.
 */
export function localDayLabel(at: number | string, now = Date.now()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, today)) return "Today";
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (sameDay(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** "Today 21:00" / "Thu, Aug 7 14:30" — the full local stamp. */
export function localDateTime(at: number | string, now = Date.now()): string {
  return `${localDayLabel(at, now)} ${localTime(at)}`;
}
