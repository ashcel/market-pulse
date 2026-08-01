/**
 * Sprint 5 rollout flags (docs/IMPLEMENTATION-PLAN.md §1 rule 3: "rollback satu
 * baris"). Every one defaults to **off**, so a deploy of this sprint changes
 * nothing a user sees until an operator flips a flag.
 *
 * These are read through `import.meta.env`, which Vite substitutes at BUILD
 * time — flipping one is `VITE_NAV_V2=1 bun run build` plus a restart, not an
 * env var on the running process. That is deliberate: the flags gate what the
 * client renders, and the client bundle is built, not interpreted. The
 * server-side flags that need no rebuild live in `backend/app/config.py`
 * (SCORECARD_ENABLED, SIGNAL_SOURCES_LIVE).
 *
 * Both the bare name and the `VITE_` prefix are accepted so the operator can
 * write `NAV_V2=1` as the plan does and still have it work.
 */

type Env = Record<string, string | boolean | undefined>;

function flag(name: string): boolean {
  // `import.meta.env` is statically replaced, so the lookups have to be written
  // out rather than computed — an indexed read of a name Vite cannot see at
  // build time resolves to undefined in the browser bundle.
  const env = import.meta.env as unknown as Env;
  const raw = env[`VITE_${name}`] ?? env[name];
  return raw === "1" || raw === "true" || raw === true;
}

/** Nav 4 tab: Now · Ideas · Book · Lab, Settings moved to the header. */
export const NAV_V2 = flag("NAV_V2");

/**
 * Render the forecast cone from the ported in-app engine (`@/lib/forecast`)
 * instead of proxying `/quant/token` to the notifier-bot dashboard. When this
 * is on, `backend/app/quant/router.py`'s `/quant/token` has no caller left.
 */
export const PORT_FORECAST = flag("PORT_FORECAST");
