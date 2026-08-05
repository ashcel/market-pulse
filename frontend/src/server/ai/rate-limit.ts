/**
 * Quota guard for the free AI tier.
 *
 * This endpoint spends the operator's money on a page anyone can load, so it
 * is limited on two axes at once: a per-caller window (so one visitor cannot
 * monopolise it) and a global daily ceiling (so the whole internet cannot
 * drain the month's budget in an afternoon).
 *
 * In-process and therefore per-node — fine for a single-node deployment, which
 * is what this app runs on. It is a budget guard, not a security control: a
 * determined caller can rotate IPs. The real ceiling is the daily cap.
 */

export interface RateLimitConfig {
  /** Requests allowed per caller inside `windowMs`. */
  perCaller: number;
  windowMs: number;
  /** Hard ceiling across all callers per UTC day. */
  dailyTotal: number;
}

export const DEFAULT_LIMITS: RateLimitConfig = {
  perCaller: 5,
  windowMs: 60 * 60_000,
  dailyTotal: 500,
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Set when denied: which ceiling was hit. */
  reason?: "caller" | "daily";
  /** Requests left for this caller in the current window. */
  remaining: number;
  /** When the caller's window resets (epoch ms). */
  resetAt: number;
}

interface CallerState {
  count: number;
  windowStart: number;
}

export class AiRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly callers = new Map<string, CallerState>();
  private dailyCount = 0;
  private dailyKey = "";

  constructor(config: RateLimitConfig = DEFAULT_LIMITS) {
    this.config = config;
  }

  private dayKeyFor(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  /**
   * Drops callers whose window has fully elapsed. Called on every check so the
   * map cannot grow without bound on a public endpoint.
   */
  private sweep(now: number): void {
    for (const [key, state] of this.callers) {
      if (now - state.windowStart >= this.config.windowMs) this.callers.delete(key);
    }
  }

  /** Records and decides one request. Only an allowed request consumes quota. */
  check(callerId: string, now = Date.now()): RateLimitDecision {
    this.sweep(now);

    const today = this.dayKeyFor(now);
    if (today !== this.dailyKey) {
      this.dailyKey = today;
      this.dailyCount = 0;
    }

    const state = this.callers.get(callerId);
    const fresh = !state || now - state.windowStart >= this.config.windowMs;
    const current: CallerState = fresh ? { count: 0, windowStart: now } : state;
    const resetAt = current.windowStart + this.config.windowMs;

    if (current.count >= this.config.perCaller) {
      this.callers.set(callerId, current);
      return { allowed: false, reason: "caller", remaining: 0, resetAt };
    }
    if (this.dailyCount >= this.config.dailyTotal) {
      this.callers.set(callerId, current);
      return {
        allowed: false,
        reason: "daily",
        remaining: this.config.perCaller - current.count,
        resetAt,
      };
    }

    current.count += 1;
    this.dailyCount += 1;
    this.callers.set(callerId, current);
    return {
      allowed: true,
      remaining: this.config.perCaller - current.count,
      resetAt,
    };
  }

  /** Test/ops introspection — how much of today's global budget is spent. */
  usedToday(now = Date.now()): number {
    return this.dayKeyFor(now) === this.dailyKey ? this.dailyCount : 0;
  }
}

/** Reads an integer env override, falling back when unset or nonsense. */
function envInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function limitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RateLimitConfig {
  return {
    perCaller: envInt(env, "AI_PROXY_PER_CALLER", DEFAULT_LIMITS.perCaller),
    windowMs: envInt(env, "AI_PROXY_WINDOW_MS", DEFAULT_LIMITS.windowMs),
    dailyTotal: envInt(env, "AI_PROXY_DAILY_TOTAL", DEFAULT_LIMITS.dailyTotal),
  };
}

/**
 * Who is being limited. A signed-in user is billed to their account so a
 * shared office IP does not throttle them collectively; everyone else is
 * billed to the client IP the proxy reports.
 */
export function callerKey(userId: string | null, request: Request): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}
