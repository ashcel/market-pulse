/**
 * Funding-play advisor — deterministic support for the funding-harvest
 * strategy: during extreme funding, position AGAINST the crowded side to
 * receive the settlement payment (entering only in the final minutes before
 * settlement, hard-capped max loss), flatten right after funding is
 * distributed, then optionally flip into the post-settlement reversal.
 *
 * This is a discovery/advisor layer like `discovery.ts` — it never touches
 * decision or trigger semantics, ENGINE_VERSION, or any forward-test record.
 * It says "this funding window is worth taking / not yet / skip", with the
 * math and hazards shown; it never auto-trades.
 */

/** One perp pair's live funding state (raw inputs, fetched elsewhere). */
export interface FundingRow {
  /** Base asset for app routing, e.g. "SOL". */
  ticker: string;
  /** Exchange pair, e.g. "SOLUSDT". */
  pair: string;
  /** Current-period funding rate as a decimal (0.0001 = 0.01%). */
  fundingRate: number;
  /** Epoch ms of the next funding settlement. */
  nextFundingMs: number;
  markPrice: number;
  indexPrice: number;
  /** Funding interval in hours — 8 by default, 4 or 1 on adjusted pairs. */
  intervalHours: number;
}

export interface FundingPlayConfig {
  /** |rate| at which a pair is flagged at all. */
  extremeRate: number;
  /** |rate| the strategy actually hunts (user trades ±2%). */
  primeRate: number;
  /** Enter only within this many minutes of settlement. */
  entryWindowMinutes: number;
  /** Taker fee per side, decimal (round trip = 2×). */
  takerFeeRate: number;
  /** Hard max loss for the harvest leg, USD. */
  maxLossUsd: number;
  /** Stop distance assumed for sizing, % of price. */
  defaultStopDistancePct: number;
}

export const DEFAULT_FUNDING_PLAY_CONFIG: FundingPlayConfig = {
  // 0.5%/interval is ~5.5%/day at the 8h cadence — well past any normal
  // carry and the point where a harvest is worth surfacing at all.
  extremeRate: 0.005,
  // The user's own bar: they only actually trade ±2%/interval extremes.
  // Between extremeRate and primeRate we still show the row but hold the
  // stronger thin-book warning for the prime band the user hunts.
  primeRate: 0.02,
  // The harvest leg is a pre-settlement scalp; 30 min gives enough runway to
  // place a *limit* entry (see hazards) without exposing the position to a
  // full interval of adverse drift. Enter late, flatten at the print.
  entryWindowMinutes: 30,
  // Binance USDT-perp taker fee (0.05%). Round trip = 2× = 0.10%; the harvest
  // is assumed taker on at least one side, so this is the honest cost floor.
  takerFeeRate: 0.0005,
  // Hard max loss per harvest leg (user's rule is $1–3). Sizing is derived
  // from this, never the other way around.
  maxLossUsd: 3,
  // Assumed protective-stop distance for sizing. 1% keeps the notional small
  // enough to survive settlement-minute volatility; at maxLossUsd=$3 this
  // sizes ~$300 notional.
  defaultStopDistancePct: 1,
};

/** Where this opportunity sits in its lifecycle relative to settlement. */
export type FundingPlayPhase =
  | "watch" // extreme funding but entry window not open yet
  | "enter-window" // inside the pre-settlement entry window
  | "settling" // settlement imminent (final minute) — too late to enter
  | "post-settlement"; // funding paid; harvest leg should be flat, reversal leg live

export type FundingPlayVerdict = "take" | "not-yet" | "skip";

export interface FundingPlayAdvice {
  ticker: string;
  pair: string;
  /** Side that RECEIVES funding (the harvest leg). */
  side: "long" | "short";
  phase: FundingPlayPhase;
  verdict: FundingPlayVerdict;
  fundingRate: number;
  intervalHours: number;
  minutesToFunding: number;
  markPrice: number;
  /** Funding captured per unit notional, % (|rate|×100). */
  grossCapturePct: number;
  /** Round-trip taker fees, %. */
  feesPct: number;
  /** grossCapturePct − feesPct; ≤0 means the play cannot pay. */
  netEdgePct: number;
  /** Adverse price move that erases the net edge, %. */
  breakevenMovePct: number;
  /** Notional sized so the default stop loses exactly maxLossUsd. */
  suggestedNotionalUsd: number;
  /** Expected funding receipt in USD at that notional. */
  expectedCaptureUsd: number;
  /** One-line condition that flips a not-yet/skip into take (or take into exit). */
  whatFlipsIt: string;
  /** Concrete risks of THIS instance (thin book, decaying rate, interval quirk…). */
  hazards: string[];
  /** Framing for the optional post-settlement reversal leg — always cautionary. */
  reversalNote: string;
  /** Plain-English one-paragraph read. */
  note: string;
}

export interface FundingScan {
  source: "live" | "demo";
  updatedAt: string;
  /** Perp pairs seen before filtering. */
  pairsSeen: number;
  /** Ranked advice, best first (preferred = [0]); only |rate| ≥ extremeRate. */
  plays: FundingPlayAdvice[];
}

const isFiniteNum = (n: number): boolean => typeof n === "number" && Number.isFinite(n);

/** Round to a fixed number of places for readable copy without float noise. */
const pct = (n: number, places = 3): string => n.toFixed(places);

/**
 * Minutes until the *next* settlement once the current one is already past.
 * Advances whole intervals from `nextFundingMs` (which may be 0 or long stale)
 * to the first boundary strictly in the future — no loop, no negative minutes.
 */
function minutesToNextSettlement(
  nextFundingMs: number,
  nowMs: number,
  intervalHours: number,
): number {
  const intervalMs = intervalHours * 3_600_000;
  if (!(intervalMs > 0)) return 0; // degenerate interval — cadence unknown
  const elapsed = Math.max(0, nowMs - nextFundingMs);
  const cycles = Math.floor(elapsed / intervalMs) + 1;
  const nextMs = nextFundingMs + cycles * intervalMs;
  return Math.max(0, (nextMs - nowMs) / 60_000);
}

/** Advise one pair's funding window; null when |rate| is below the flag gate. */
export function adviseFundingPlay(
  row: FundingRow,
  nowMs: number,
  config: FundingPlayConfig = DEFAULT_FUNDING_PLAY_CONFIG,
): FundingPlayAdvice | null {
  // Robustness: any garbage numeric input disqualifies the whole row. A stale
  // or zero nextFundingMs is NOT garbage — it just means we're post-settlement.
  if (
    !isFiniteNum(row.fundingRate) ||
    !isFiniteNum(row.nextFundingMs) ||
    !isFiniteNum(row.markPrice) ||
    !isFiniteNum(row.indexPrice) ||
    !isFiniteNum(row.intervalHours) ||
    !isFiniteNum(nowMs)
  ) {
    return null;
  }
  if (Math.abs(row.fundingRate) < config.extremeRate) return null;

  const minutesToFunding = Math.max(0, (row.nextFundingMs - nowMs) / 60_000);
  const grossCapturePct = Math.abs(row.fundingRate) * 100;
  const feesPct = config.takerFeeRate * 2 * 100;
  const netEdgePct = grossCapturePct - feesPct;

  // Sizing: notional so the assumed stop loses exactly maxLossUsd. Guard the
  // divide — a zero/non-finite stop distance means we can't size, not Infinity.
  const stopFrac = config.defaultStopDistancePct / 100;
  const suggestedNotionalUsd = stopFrac > 0 ? config.maxLossUsd / stopFrac : 0;
  const expectedCaptureUsd = (grossCapturePct / 100) * suggestedNotionalUsd;

  const side: "long" | "short" = row.fundingRate > 0 ? "short" : "long";
  // The crowded / paying side is the opposite of the receiving (harvest) side.
  const crowdedSide = side === "short" ? "long" : "short";

  const inWindow = minutesToFunding <= config.entryWindowMinutes && minutesToFunding > 1;
  const phase: FundingPlayPhase =
    row.nextFundingMs <= nowMs
      ? "post-settlement"
      : minutesToFunding <= 1
        ? "settling"
        : inWindow
          ? "enter-window"
          : "watch";

  // Verdict — a net edge that fees have eaten is a skip regardless of timing.
  let verdict: FundingPlayVerdict;
  if (netEdgePct <= 0) verdict = "skip";
  else if (phase === "enter-window") verdict = "take";
  else if (phase === "watch") verdict = "not-yet";
  else verdict = "skip"; // settling (too late) or post-settlement (leg is over)

  // breakevenMovePct === netEdgePct, and it is LEVERAGE-INDEPENDENT: an X%
  // adverse move on the notional loses X%·notional; the funding receipt is
  // netEdgePct%·notional. Break-even at X = netEdgePct%. Leverage only scales
  // the margin posted, never the notional-denominated %, so it cancels out.
  const breakevenMovePct = netEdgePct;

  // whatFlipsIt must never be empty (product rule: every not-yet/skip states
  // its not-yet / wrong-instance / what-flips-it).
  const minsToOpen = Math.max(0, minutesToFunding - config.entryWindowMinutes);
  let whatFlipsIt: string;
  if (verdict === "take") {
    whatFlipsIt = `Flatten the instant funding pays (~${Math.round(minutesToFunding)} min): the edge dies at the settlement snapshot, so exit is the only thing to watch.`;
  } else if (netEdgePct <= 0) {
    // Rate must climb until gross capture clears the round trip.
    const breakEvenRatePct = feesPct; // grossCapturePct must exceed this
    whatFlipsIt = `Net edge is ${pct(netEdgePct)}% after fees — funding no longer clears the ${pct(feesPct)}% round trip. Flips to take only if |funding| rises above ${pct(breakEvenRatePct)}%.`;
  } else if (phase === "watch") {
    whatFlipsIt = `Entry window opens in ~${Math.round(minsToOpen)} min (settlement in ~${Math.round(minutesToFunding)} min); becomes a take once you're inside the ${config.entryWindowMinutes}-min window.`;
  } else if (phase === "settling") {
    whatFlipsIt = `Settlement is <1 min out — too late to enter cleanly. Flips at the NEXT window, ~${Math.round(minutesToNextSettlement(row.nextFundingMs, nowMs, row.intervalHours))} min away.`;
  } else {
    // post-settlement
    whatFlipsIt = `Harvest leg is over — funding already paid. Next settlement in ~${Math.round(minutesToNextSettlement(row.nextFundingMs, nowMs, row.intervalHours))} min (every ${row.intervalHours}h); re-arm then.`;
  }

  // Hazards — only the ones that apply to THIS row.
  const hazards: string[] = [];
  hazards.push(
    `Current-period rate (${pct(grossCapturePct)}%) is a live prediction, not locked until the settlement snapshot — it can decay before funding pays.`,
  );
  if (netEdgePct > 0) {
    hazards.push(
      `Settlement-minute volatility routinely exceeds the funding capture — your break-even adverse move is only ${pct(breakevenMovePct)}%, so a normal wick can erase the harvest.`,
    );
  }
  if (Math.abs(row.fundingRate) >= config.primeRate) {
    hazards.push(
      `Pairs at ${pct(grossCapturePct)}% funding are frequently thin or delist-prone — expect slippage; prefer a limit entry over a market fill.`,
    );
  }
  if (row.intervalHours !== 8) {
    hazards.push(
      `Non-standard ${row.intervalHours}h funding interval — cadence and annualization differ from the 8h norm; windows recur every ${row.intervalHours}h.`,
    );
  }

  const reversalNote = `Optional reversal leg: once funding is paid this is a SEPARATE momentum bet with ZERO funding edge — the crowded ${crowdedSide} side that was paying tends to unwind after settlement, so a move against them often follows. That is a tendency, not a promise, and it is pure direction risk: hold it to the same $${config.maxLossUsd} hard max-loss as the harvest leg.`;

  // note — one plain-English paragraph: rate, side, window, capture vs
  // break-even move, dominant hazard (hazards[0]).
  const rateWord =
    row.fundingRate > 0 ? "positive (longs pay shorts)" : "negative (shorts pay longs)";
  let windowSentence: string;
  if (phase === "enter-window") {
    windowSentence = `You're inside the entry window — settlement in ~${Math.round(minutesToFunding)} min.`;
  } else if (phase === "watch") {
    windowSentence = `Too early: window opens in ~${Math.round(minsToOpen)} min.`;
  } else if (phase === "settling") {
    windowSentence = `Settlement is <1 min out — do not chase it.`;
  } else {
    windowSentence = `Funding has already paid — the harvest leg is done.`;
  }
  const note =
    `${pct(grossCapturePct)}% funding is ${rateWord}, so the harvest leg is ${side.toUpperCase()} to receive it. ${windowSentence} ` +
    `At the suggested $${Math.round(suggestedNotionalUsd)} notional that's ~$${expectedCaptureUsd.toFixed(2)} of funding against a ${pct(breakevenMovePct)}% break-even adverse move. ${hazards[0]}`;

  return {
    ticker: row.ticker,
    pair: row.pair,
    side,
    phase,
    verdict,
    fundingRate: row.fundingRate,
    intervalHours: row.intervalHours,
    minutesToFunding,
    markPrice: row.markPrice,
    grossCapturePct,
    feesPct,
    netEdgePct,
    breakevenMovePct,
    suggestedNotionalUsd,
    expectedCaptureUsd,
    whatFlipsIt,
    hazards,
    reversalNote,
    note,
  };
}

/** Lower tier = more actionable, so it sorts first. */
function actionabilityTier(a: FundingPlayAdvice): number {
  if (a.verdict === "take") return 0; // enter-window, positive edge — act now
  if (a.verdict === "not-yet") return 1; // watch — worth queuing
  return 2; // skip — settling / post-settlement / negative edge
}

/** Rank all flagged pairs, best first (preferred = [0]). */
export function rankFundingPlays(
  rows: FundingRow[],
  nowMs: number,
  config: FundingPlayConfig = DEFAULT_FUNDING_PLAY_CONFIG,
): FundingPlayAdvice[] {
  return rows
    .map((row) => adviseFundingPlay(row, nowMs, config))
    .filter((a): a is FundingPlayAdvice => a !== null)
    .sort((a, b) => {
      // 1) actionability, 2) net edge, 3) stable tiebreak on pair name.
      const tier = actionabilityTier(a) - actionabilityTier(b);
      if (tier !== 0) return tier;
      if (b.netEdgePct !== a.netEdgePct) return b.netEdgePct - a.netEdgePct;
      return a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0;
    });
}

export function buildFundingScan(
  rows: FundingRow[],
  nowMs: number,
  source: FundingScan["source"],
  config: FundingPlayConfig = DEFAULT_FUNDING_PLAY_CONFIG,
): FundingScan {
  return {
    source,
    updatedAt: new Date(nowMs).toISOString(),
    pairsSeen: rows.length,
    plays: rankFundingPlays(rows, nowMs, config),
  };
}
