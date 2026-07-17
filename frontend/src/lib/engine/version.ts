import { CRYPTO_RISK_SETTINGS } from "./crypto-config";
import { INTENT_MAX_HOLD_BARS } from "./hysteresis";

/**
 * Engine version — the primary GROUP BY for every forward-test statistic. Bump
 * it on any change to decision or trigger *semantics* so the record segments
 * by engine behaviour instead of pooling incompatible versions into one
 * hit-rate.
 *
 * Semver intent: major = trigger/decision semantics, minor = additive signal,
 * patch = fix. `1.0.0` marks the freeze — the i.mss trigger question is closed
 * (phase3-spike.md verdict: CHoCH retained), and the official forward-test
 * clock starts here. Stats from `1.0.0` onward are *evidence*; prior versions
 * are *shakeout*.
 */
export const ENGINE_VERSION = "1.0.0";

/**
 * Build/commit SHA for exact traceability. Injected at build time —
 * `GIT_SHA` in a plain Node/Bun process (the worker), `VITE_GIT_SHA` in the
 * bundled web app. Falls back to "unknown" in dev.
 */
export function gitSha(): string {
  const fromNode = typeof process !== "undefined" && process.env ? process.env.GIT_SHA : undefined;
  const fromVite =
    typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_GIT_SHA
      : undefined;
  return fromNode ?? fromVite ?? "unknown";
}

/** Canonical (sorted-key) JSON so the hash is stable across key ordering. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** FNV-1a over the canonical JSON encoding — dependency-free and deterministic. */
function stableHash(value: unknown): string {
  const json = JSON.stringify(sortKeys(value));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hash over the engine's outcome-affecting configuration. Captures config-only
 * drift that the hand-bumped ENGINE_VERSION would miss. The surface is the
 * resolved risk settings + the per-intent hold horizons — the two knobs that
 * actually move recorded outcomes.
 */
export function configHash(): string {
  return stableHash({ risk: CRYPTO_RISK_SETTINGS, holdBars: INTENT_MAX_HOLD_BARS });
}

/** Provenance stamped onto every opened forward-test record. */
export interface Provenance {
  engineVersion: string;
  configHash: string;
  gitSha: string;
}

export function currentProvenance(): Provenance {
  return { engineVersion: ENGINE_VERSION, configHash: configHash(), gitSha: gitSha() };
}

/**
 * Guards the one place provenance actually matters: right before a
 * shadow/anticipatory/tracked record is persisted. `buildShadowSignal` et al.
 * always spread `currentProvenance()` in, so a missing field here means the
 * caller bypassed that path — silently writing `""` would pool a mis-stamped
 * record into every `engineVersion`-segmented stat forever. Fail loudly
 * instead of defaulting.
 */
export function assertProvenance<T extends Partial<Provenance>>(
  input: T,
): asserts input is T & Provenance {
  if (!input.engineVersion || !input.configHash || !input.gitSha) {
    throw new Error(
      "Refusing to persist a forward-test record with incomplete provenance " +
        `(engineVersion=${input.engineVersion || "∅"}, configHash=${input.configHash || "∅"}, ` +
        `gitSha=${input.gitSha || "∅"}).`,
    );
  }
}
