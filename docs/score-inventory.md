# Score Inventory (M0-T4)

Every numeric/percentage/gauge/grade surfaced to the user (plus borderline
categorical reads), with its definition, evidence basis, and a keep /
demote-to-rank / remove / n/a decision per the M0 rubric (see
`milestones/briefs/M0-T4.md`). This is an inventory only — no `src/` files
were changed. Executing the demote/remove rows is M0-T5.

Decision rubric recap:

- **keep** — objective, externally verifiable measure (raw price/volume, ATR,
  a real external API, a correlation coefficient, genuine settled
  forward-test/tracker outcomes with disclosed sample size) whose label
  doesn't overclaim.
- **demote-to-rank** — real, internally-consistent, but a rule-based/weighted
  heuristic dressed as a precise percentage/"confidence" without forward-test
  validation, or a score with a silent fallback that changes its meaning
  unannounced. Fix: qualitative band/rank, or an explicit heuristic
  disclosure.
- **remove** — actively misleading with no reasonable fix short of deletion,
  or duplicates another score under a confusingly similar label.
- **n/a (not user-facing)** — computed/stored but never rendered in the web
  UI.

## Regime & confidence gauges

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| Market Regime confidence | `src/routes/index.tsx:255,260`, `src/routes/regime.tsx:77` via `ConfidenceGauge` (`src/components/iq/confidence-gauge.tsx:16-64`) | `src/lib/engine/market.ts:394` — `clamp(round(48 + \|riskScore-50\|*1.6), 45, 97)` | Distance-from-neutral transform of `riskScore`, itself a 0.35/0.25/0.2/0.2 weighted blend of the four pillars below (`market.ts:370`) | demote-to-rank | Rule-based heuristic on a heuristic blend, shown as a bare `%` gauge; no forward-test calibration backs "confidence" here (EDR 0017: engine is a context instrument pending its 1.0.0 verdict) |
| Regime pillar — Trend | `src/routes/regime.tsx:147-179` (score at `:163`) | `src/lib/engine/market.ts:347-357` — hardcoded lookup table (`trending-up`→85, `breakout-compression`→62, `low-volatility`→55, `range-bound`→52, `mean-reversion`→48, `choppy`→42, `high-volatility`→35, `trending-down`→18) | None — the numbers are arbitrary constants assigned to an already-categorical regime label | demote-to-rank | A categorical classification (`classifyRegime`) dressed up as a precise 0-100 score via made-up constants; show the regime label itself, which already exists and needs no invented number |
| Regime pillar — Breadth | `src/routes/regime.tsx:147-179` (score at `:163`) | `src/lib/engine/market.ts:360` — `(assets above 7d MA / total) * 100` | Literal, externally verifiable percentage of the tracked universe above its own 7-day average price | keep | A genuine percentage of real price data, not a heuristic blend; label doesn't overclaim |
| Regime pillar — Volatility | `src/routes/regime.tsx:147-179` (score at `:163`) | `src/lib/engine/market.ts:363` — `clamp(round(115 - atrPctDaily*18), 5, 95)` | Real BTC 14-day ATR%, rescaled through arbitrary constants (115, 18) into a 0-100 "score" | demote-to-rank | The underlying ATR% is objective (and already shown raw as `VolatilityData.vix`, see below), but this pillar's specific linear rescale is undocumented/uncalibrated; show the raw ATR% instead of a manufactured 0-100 figure |
| Regime pillar — Momentum | `src/routes/regime.tsx:147-179` (score at `:163`) | `src/lib/engine/market.ts:361` — mean of per-asset `momentum` (`market.ts:190`, `tanhScore` of 24h/7d % change) | Deterministic squash of real 24h/7d % price change; no probability/confidence claim attached | keep | Transparent, reproducible transform of real return data; doesn't overclaim statistical meaning |
| Regime pillar — Participation | `src/routes/regime.tsx:147-179` (score at `:163`) | `src/lib/engine/market.ts:365` — `(assets with 24h volume > prior-period avg / total) * 100` | Literal, externally verifiable percentage of the universe printing above-average volume | keep | Genuine percentage of real volume data |
| Rotation confidence | `src/routes/rotation.tsx:83,93` | `src/lib/engine/market.ts:491` — `clamp(round(55 + rho*40), 30, 95)`, rho = Spearman rank correlation of 24h vs 7d sector rankings (`market.ts:475-483`) | Real Spearman rank correlation of the universe's own sector rankings | demote-to-rank | The underlying rho is a genuine statistic, but rescaling it into an opaque 30-95 "confidence" band (rather than showing rho, or the Persistent/Unstable band the UI already derives from it at `rotation.tsx:83-88`) implies more calibration than exists |
| Rotation Strength value (leg %) | `src/components/iq/rotation-flow.tsx:29-31` | `src/lib/engine/market.ts:472` — `clamp(round(((avg24-min)/spread)*100), 0, 100)` | Min-max normalization of real 24h sector % changes for the day | keep | Directly derived from real return data; the per-day min-max rescale means the same number isn't comparable across days, but the UI never claims cross-day comparability — it's a same-day magnitude indicator only |
| Rotation Strength label (High/Medium/Low) | `src/routes/index.tsx:288-290`, `src/routes/rotation.tsx:74-80` | `src/lib/engine/market.ts:490` — `spread >= 3 ? "High" : spread >= 1.2 ? "Medium" : "Low"` | Objective thresholds on the real 24h sector spread | keep | Transparent, fixed thresholds on real data; categorical, no probability implied |

## Signal engine confidence (core evaluateSignal output)

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| Signal/"Overall" confidence | `src/routes/technical.tsx:112`, `src/routes/token.$symbol.tsx:3058,3674,3834` | `src/lib/engine/quant.ts:852-853` — `rawConfidence` (weighted rule checklist, base 35, components ±5 to ±20 each), clamped 0-100 | Rule-based checklist over trend/structure/volume/candle/RR/S-R/liquidity/extension — no forward-test calibration yet | demote-to-rank | This is the engine's central output and the exact case EDR 0017 flags: a bare `/100` reads as proven edge, but the 1.0.0 forward-test verdict hasn't landed (verdict protocol gates on n≥150) — resolved M0-T5a |
| Asset-list confidence (rankings/homepage) | `src/routes/rankings.tsx:299`, sort control `:214`, `src/routes/index.tsx:515` | `src/lib/engine/market.ts:243` — `round(0.5*technical + 0.25*momentum + 0.25*strength)`, `technical` = the quant.ts confidence above | Inherits the quant.ts confidence's rule-based basis, further blended with momentum/strength | demote-to-rank | Same overclaim as the underlying confidence score it's 50% built from — resolved M0-T5a |
| Market Pulse Score (asset.score) | `src/routes/rankings.tsx:150-155,259`, `src/routes/index.tsx:639` ("Top Assets" table) | `src/lib/engine/market.ts:244` — `round(0.3*momentum + 0.25*strength + 0.25*technical + 0.2*volumeScore)` | A second, differently-weighted composite blend of the same four heuristic components used elsewhere | demote-to-rank | A distinct 0-100 "Score" column presented with the same visual confidence as the confidence field, but is a separately-tuned blend with no forward-test backing — two similarly-precise composite numbers (`score` and `confidence`) risk being read as agreeing measures of the same thing when they're independently weighted — resolved M0-T5a |
| SignalComponent.score (per-check point values) | — | `src/lib/engine/quant.ts:592-825` (`add(...)` calls, e.g. ±20 trend, ±8 structure) | Feeds only the aggregate confidence sum above | n/a (not user-facing) | `src/components/iq/signal-card.tsx` renders each check's label/value/status/detail text only — never the numeric point value |
| "Technical Data" score (homepage) | `src/routes/index.tsx:340` | `src/lib/engine/market.ts:570-574` — mean of all assets' `technical` (= quant.ts confidence) | Average of the same rule-based confidence scores flagged above | demote-to-rank | Averaging a heuristic doesn't make it calibrated; inherits the underlying issue — resolved M0-T5a |
| Rankings "Momentum" column | `src/routes/rankings.tsx:279` | `src/lib/engine/market.ts:190` — `0.6*tanhScore(change24h,6) + 0.4*tanhScore(change7d,15)` | Deterministic squash of real 24h/7d % price change | keep | Transparent formula over real return data; not styled as a confidence/probability |
| Rankings "Strength" column | `src/routes/rankings.tsx:284` | `src/lib/engine/market.ts:200-210` (`scoreAsset`) — base 40 ± 10 per MA the price sits above/below (24h/72h/168h) + `rangePos*20` | Objective, transparent rule (price vs. three real moving averages, plus range position) | keep | Every input is real price/MA data with a disclosed, fixed rule — no probability claim. Note: this is a *different* metric from `strength.ts`'s `SwingStrength` (strong/weak/unresolved swing classifier) despite the shared word "strength" — a naming collision worth resolving in the UI/docs, not a scoring problem |
| Rankings "Volume" column | `src/routes/rankings.tsx:289` | `src/lib/engine/market.ts:219` — `tanhScore((volumeRatio-1)*100, 80)` | Deterministic squash of real 24h vs. prior-period volume ratio | keep | Transparent transform of real volume data |
| `SwingStrength` (strong/weak/unresolved) | — | `src/lib/engine/strength.ts` (`deriveSwingStrength`) | Structural (swing break) classifier, read by no decision, score, or veto (EDR 0004) | n/a (not user-facing) | Confirmed: no reference to `swingStrength`/`SwingStrength` anywhere in `src/routes/token.$symbol.tsx` or elsewhere in the UI |

## Location / POI / liquidity

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| `LocationGrade` (at-structure/mid-range/extended) | `src/routes/token.$symbol.tsx:1008-1024,2920-2968` | `src/lib/engine/location.ts:121-222` (`gradeLocation`) | Price position within the real support→resistance range, ATR-scaled proximity, plus optional fresh supply/demand-zone and session-level confluence | keep | Categorical label derived directly from objective price geometry (support/resistance/ATR/zones), never expressed as a numeric confidence — doesn't overclaim |
| Liquidity pool confidence | Chart price-line title `src/routes/token.$symbol.tsx:1620`, hint text `:1887` | `src/lib/engine/liquidity.ts:38-144` — `confidence` field (line 53), `round(100 * (0.40*touches + 0.25*tightness + 0.35*recency))` | Real structural inputs (touch count, cluster tightness, swing recency), but linear weights are a judgment call, not a calibration (see `docs/decisions/0002-liquidity-pool-confidence.md`) | demote-to-rank | The EDR itself names this exact risk: "Confidence numbers may be read as probabilities. They are ordinal rankings; the UI shows them as bare scores deliberately." A bare 0-100 number titled on the chart invites exactly that misread — show a qualitative tier (e.g. Strong/Moderate/Weak) or add an explicit "ordinal, not a probability" disclosure |
| `LiquidityPoolComponents` (touches/tightness/recency, 0-1 each) | — | `src/lib/engine/liquidity.ts:29-36` | Sub-components of the confidence score above | n/a (not user-facing) | Exposed on the pool object for programmatic/AI-context use only; the token page never renders the individual component values, only the blended `confidence` |
| Discovery/opportunity score | — | `src/lib/engine/discovery.ts:53` (field), `scoreOpportunities` `discovery.ts:255-307` | Percentile blend of 24h range, liquidity, and trade-activity across the full exchange | n/a (not user-facing) | `src/components/iq/market-opportunities-card.tsx` renders rank, 24h range %, turnover, price, and change — never the `score` number itself; it drives sort order only (rank position implicitly reflects it, but no digit is shown) |

## Backtest / forward-test evidence

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| Per-setup historical "backtest" (winRate, expectancy, averageR, profitFactor) | `src/routes/token.$symbol.tsx:3069-3108` ("Hist. edge", "Win rate", "Risk level"), `:3467-3519` (full `BacktestEvidence` card) | `src/lib/engine/quant.ts:915-1021` (`runBacktest`) — walk-forward replay of the same setup type over the **same chart's own candle history** | In-sample replay on the chart's own history, not the live-followed forward test; `lowSample` below `MIN_RELIABLE_BACKTEST_TRADES = 10` (`quant.ts:128`) | remove | Labels ("Win rate", "Avg R") are near-identical to the genuine tracker/shadow-record stats below, but this is a fundamentally weaker, in-sample curve-fit evidence source computed from the same data the setup was pattern-matched against — exactly the "duplicates another score under a confusingly similar label" removal case the rubric calls out; high risk of a user conflating this with real forward-tested performance |
| Live tracker stats (winRate, averageR) | `src/routes/tracker.tsx:100-118` (summary tiles), `src/routes/token.$symbol.tsx:2786` | `src/lib/engine/tracker.ts:200-232` (`summarizeTrackedSignals`) | Real, user-confirmed followed signals settled against actual price ticks/candles; `lowSample` below `MIN_RELIABLE_TRACKED_TRADES = 5` | keep | Genuine settled outcomes with a disclosed low-sample warning. Minor gap: the closed-sample count `n` is only spelled out in the low-sample warning text (`tracker.tsx:113-118`); above that threshold `n` is inferable from "Followed" − "Open" but isn't itself a labeled figure next to the win rate — worth surfacing explicitly, not a fake-precision issue |
| Engine's Live Record (shadow-record winRate/averageR, global + per setup×regime combo) | `src/routes/tracker.tsx:167-282` | `src/lib/engine/shadow.ts` (`summarizeShadowRecord`-style aggregation; `MIN_SHADOW_RECORD_TRADES = 15` at `shadow.ts:66`) | This **is** the official ENGINE_VERSION 1.0.0 forward-test clock: every `favored` verdict auto-recorded and settled against real candle highs/lows, no cherry-picking, no follow required | keep | Genuine settled forward-test outcomes with disclosed sample size (`n` shown directly, low-sample warning names `MIN_SHADOW_RECORD_TRADES`) and a demotion flag surfaced per combo — exactly the rubric's "keep" case. (Per the frozen verdict protocol, this is a legitimate on-page read, not outcome-peeking — that restriction is about *analysis* ahead of the n≥150 gate, not about the record simply being visible.) |
| Anticipatory limit-fill record (fillRate, winRate, averageR) | `src/routes/token.$symbol.tsx:2770-2792` | `src/lib/engine/anticipatory.ts:256-278` (`summarizeAnticipatoryRecord`) | Real fill/no-fill outcomes for the Phase 0.5 POI limit-plan model, own store, never mixed into shadow stats (EDR 0010) | keep | Genuine settled outcomes with sample size disclosed inline (`filled`/`neverFilled`/`settled` counts, low-sample flag) |
| Wilson/shrinkage stats (wilson95, shrunkRate, meanWithSe) | — | `src/server/forward-test/report-stats.ts:21,39,56` | Only consumed by `src/server/scripts/record-report.ts` (CLI report) | n/a (not user-facing) | Not reachable from the web UI at all |
| Risk/reward plan (entry/stop/target, R:R) | `src/routes/token.$symbol.tsx:2278,2438` | `src/lib/engine/quant.ts:454-547` (`buildRiskPlan`) | Deterministic geometry from real price/ATR/support-resistance; R is always computed against an evidenced stop level | keep | Objective calculation, not a probability claim; already compliant with the "R metrics only where a stop is evidenced" rule |
| `RiskGrade` (low/medium/high) | `src/routes/token.$symbol.tsx:3097-3098,3397-3403` | `src/lib/engine/quant.ts:130-151` (`gradeRisk`) — fixed ATR% bands (2.2/4.5) + counter-trend bump | Objective ATR% thresholds, documented and fixed | keep | Transparent banding of real volatility data; the counter-trend bump is disclosed in the UI's `sub` text |

## RS / rotation (discovery plane)

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| `rsBtc24h` / `rsBtc7d` | `src/routes/rankings.tsx:365`, `src/components/iq/rs-scan-card.tsx:70-77,82` | `src/lib/engine/relative.ts:86-87` | Real % change spread vs BTC over the same window | keep | Directly observable return-spread data, no modeling |
| `corrBtc7d` (ρ) | `src/routes/rankings.tsx:367-370` | `src/lib/engine/relative.ts:36-55,88` (`pearson`) | Real Pearson correlation of time-aligned hourly returns, null below 48 overlapping returns | keep | Genuine correlation coefficient with a disclosed minimum-sample floor |
| `rsPercentile24h` | `src/components/iq/rs-scan-card.tsx:83`, `src/routes/rankings.tsx` (feeds sort, not directly rendered there) | `src/lib/engine/rs-scan.ts:113,123` (`percentiles`) | Rank-based percentile of the real 24h RS spread within today's gated liquidity tier | keep | A percentile is a rank transform of objective data, not a heuristic confidence blend; self-calibrating by construction |
| Trend-transition flags (confirmed/CHoCH-hint, days-ago) | `src/components/iq/rs-scan-card.tsx:30-49` | `src/lib/engine/rs-scan.ts:38-44,136-144` (`transitionFlag`, via `structure.ts`/`trend-transition.ts`) | Structural swing-based classification, categorical (not numeric) | keep | Deterministic structural read, categorical, no probability implied |

## Volatility

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| `VolatilityData.vix` (BTC ATR%) | `src/routes/index.tsx:368` | `src/lib/engine/market.ts:508-523` (`buildVolatility`) | Real 14-bar ATR as % of price | keep | Raw, externally verifiable volatility measure |
| Per-token ATR% | `src/routes/token.$symbol.tsx:2593-2594` | `src/lib/engine/quant.ts:337` (`analyticsFor`) | Real 14-bar ATR as % of last close | keep | Same as above, per-asset |
| Volume ratio vs 20-bar avg | `src/routes/token.$symbol.tsx:2599-2602` | `src/lib/engine/quant.ts:339-340` | Real current volume ÷ real 20-bar average volume | keep | Directly observable ratio of real exchange data |

## Sentiment / news

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| Homepage "Sentiment" (Fear & Greed, 0-100) | `src/routes/index.tsx:319,321` | `src/lib/engine/market.ts:563-568`, real API at `:525-537` | The real alternative.me Fear & Greed Index when reachable; **silently falls back** to `0.5*breadth + 0.5*avgMomentum` (an unrelated internal proxy) on fetch failure | demote-to-rank | Rubric explicitly flags "any score with a silent fallback path that changes its meaning without telling the user" — the user cannot tell whether the number they're looking at is the real F&G index or an internal breadth/momentum proxy wearing its label. Fix: surface the active source (e.g. a "proxy" badge) whenever the fallback is in effect |
| News direction/impact (bullish/bearish/neutral, high/medium/low) | `src/components/iq/news-impact-card.tsx:24,33-38`, filters `src/routes/news.tsx:34-39,59` | `src/lib/engine/news.ts:11-16` (`BULLISH_WORDS`/`BEARISH_WORDS`/`HIGH_IMPACT_WORDS` regex) | Deterministic keyword-regex match over headline + description text | keep | Categorical, not numeric; checked the UI copy end-to-end (`news.tsx`, `news-impact-card.tsx`, component/prop names) — nowhere is this classifier labeled "sentiment," satisfying M0's standalone success-criterion bullet. No fake precision: it's presented as a badge, not a score |

## Macro / other

| Score | Where shown (file:line) | Definition (file:line) | Evidence basis | Decision | Justification |
|---|---|---|---|---|---|
| BTC↔NDX correlation | `src/components/iq/macro-strip.tsx:52-53` | `src/lib/engine/macro.ts:19,91-108,115-131` (`pearson`, `computeBtcNdxCorrelation`) | Real Pearson correlation of daily returns over ~30 shared trading sessions, null below 11 shared sessions | keep | Genuine correlation coefficient with a disclosed minimum-sample floor |
| Correlation regime (coupled/decoupled/inverse) | `src/components/iq/macro-strip.tsx:42-58` | `src/lib/engine/macro.ts:133-138` (`correlationRegimeOf`) | Fixed thresholds (≥0.4 / ≤-0.3) on the real correlation above | keep | Transparent, fixed banding of an objective statistic |
| External context (Fear & Greed, RS, catalysts fed to the AI analyst) | — | `src/lib/engine/external-context.ts` | Real breadth/RS/event data assembled server-side | n/a (not user-facing) | Only consumed by `buildAnalystSystem` (`src/routes/token.$symbol.tsx:3607-3615`) as the BYOK AI prompt's system context — never rendered as its own number in the app UI. (The AI's free-text replies may reference these figures in prose, but that output is the user's own configured model speaking, not an engine-authored score.) |
| `confidenceAtFollow` | — | `src/lib/engine/tracker.ts:33` | Snapshot of the quant.ts confidence at the moment a signal was followed | n/a (not user-facing) | Stored on `TrackedSignal` for provenance only; `src/routes/tracker.tsx`'s `TrackedSignalRow` renders Entry/Stop/Target/Current/Result — never this field |

## Search coverage

Beyond the seed list, searched for every `ConfidenceGauge` usage and `/100`-suffixed
render across `src/routes/**/*.tsx` and `src/components/iq/**/*.tsx`, plus every
score/percentage/gauge/grade field on `market.ts`, `quant.ts`, `location.ts`,
`liquidity.ts`, `discovery.ts`, `rs-scan.ts`, `relative.ts`, `strength.ts`,
`macro.ts`, `news.ts`, `tracker.ts`, `shadow.ts`, `anticipatory.ts`, and
`report-stats.ts`, and traced each into its rendering site (or confirmed it has
none). This surfaced four numbers not in the brief's seed list: the "Market
Pulse Score" (`asset.score`, distinct from `asset.confidence`), the rankings
"Momentum"/"Volume" columns, the Engine's Live Record shadow-record stats on
`/tracker`, and the Phase 0.5 anticipatory fill-record note on the token page —
all added above.
