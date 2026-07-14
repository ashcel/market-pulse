# M7 — TradFi mode (Binance TradFi tickers)

**Goal:** a second product mode covering the TradFi instruments Binance now
serves (2026), with the same intelligence brief, journal, forensics, and
skip-check — **but only after the instruments' data semantics are verified.**
The 2026-07-14 audit's concern stands until T1 disproves it: if these tickers
trade with session gaps/calendars, several engine reads assume 24/7
continuity and must be gated, not silently misapplied.

**Depends on:** M1–M6 (the loop proven on crypto); M0's EDR (TradFi stance).

## Success criteria (all measurable)

- [ ] `docs/tradfi-instrument-survey.md` exists: every Binance TradFi ticker,
      its kline continuity (24/7 vs sessions, verified empirically from
      fetched klines — gap histogram), quote/settlement currency, contract
      type, and data quirks. **This document gates everything else in M7.**
- [ ] An instrument-class abstraction exists (`continuous` vs `session`),
      and every engine read consumed in TradFi mode is classified
      valid/gated/adapted in `docs/tradfi-engine-applicability.md`.
- [ ] Mode toggle (Crypto / TradFi) with a curated TradFi universe; snapshot,
      discovery, and token-page reads render live for TradFi instruments.
- [ ] Engine replay/determinism/parity test suites pass on TradFi fixtures
      (incl. a gapped-session fixture if T1 finds gaps).
- [ ] TradFi trades from the user's Binance account flow through M1–M3
      pipelines (ingestion → stamping → forensics) with instrument-class-
      aware settlement (no kline-walk across a session gap without a rule).
- [ ] EDR records the sampling-frame extension; `ENGINE_VERSION` untouched
      unless a semantics change proves necessary (which would STOP this
      milestone and go to a spike, per the standing guardrail).

## Tasks

- [ ] **M7-T1 — Instrument survey (gates the milestone).** Enumerate Binance
      TradFi tickers from exchangeInfo; fetch a month of klines each; measure
      gap structure empirically; document. If instruments are 24/7
      continuous, the rest of M7 simplifies substantially — record that.
      *DoD:* survey doc committed with per-instrument gap histograms.
- [ ] **M7-T2 — Instrument-class abstraction.** `InstrumentClass` on universe
      entries; kline fetch + settlement walkers become class-aware (behavior
      identical for `continuous` — parity tests prove crypto unchanged).
      *DoD:* zero diffs on crypto fixtures; session-gap fixture handled.
- [ ] **M7-T3 — Engine applicability audit.** Walk every read the product
      consumes (structure, liquidity, zones, sessions, equilibrium, FVG/OB,
      discovery, spike) against the survey; classify valid / gated /
      needs-adaptation. Gate = the read renders "not available for this
      instrument class", never a silently wrong number.
      *DoD:* applicability doc; gates implemented with tests.
- [ ] **M7-T4 — TradFi universe + mode toggle.** Curated TradFi universe
      (from the survey's liquid set), mode switch in the shell, per-mode
      routing of snapshot queries.
      *DoD:* toggle persists; both modes render live simultaneously.
- [ ] **M7-T5 — TradFi market snapshot.** Snapshot pipeline over the TradFi
      universe (sectors per asset class); macro strip becomes first-class
      context here (it already covers SPX/NDX/DXY/gold).
      *DoD:* dashboard renders live TradFi snapshot; demo fallback works.
- [ ] **M7-T6 — TradFi discovery + events.** Extend the discovery scan and
      spike detector to the TradFi tier per the applicability audit; wire
      the economic-calendar events (FOMC/CPI/NFP) as first-class catalysts
      (source chosen and documented in T1 if Binance data lacks them).
      *DoD:* scan renders; spike detection gated correctly per class.
- [ ] **M7-T7 — Token page for TradFi instruments.** Instrument page with
      gated engine reads; every gated read shows the class-based reason.
      *DoD:* page renders for one session-class and one continuous-class
      instrument (if both exist).
- [ ] **M7-T8 — Journal/forensics for TradFi trades.** Ingestion symbol
      discovery extended; stamping + forensics run class-aware; settlement
      walkers respect session boundaries.
      *DoD:* a real (or seeded) TradFi fill flows end-to-end to a forensics
      card.
- [ ] **M7-T9 — Skip check for TradFi.** Condition matcher + cohort family
      get a `market-class` dimension (protocol amendment per M5-T6's flow —
      documented, versioned).
      *DoD:* skip check answers for a TradFi symbol; amendment committed.
- [ ] **M7-T10 — EDR + regression sweep.** EDR for the TradFi extension;
      full test suite + determinism/parity sweeps on both modes; update
      CLAUDE.md architecture notes.
      *DoD:* suite green; EDR committed; crypto-mode behavior byte-identical
      where the class abstraction promises it.
