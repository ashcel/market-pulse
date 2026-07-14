# M4 — AI complement layer

**Goal:** the BYOK AI analyst becomes the narrative layer over persisted
facts: a per-trade behavior memo and a daily intelligence brief. AI is a
**complement** — it narrates and connects what the deterministic layers
measured; it never originates a number, a verdict, or a claim.

**Depends on:** M2 (context stamps), M3 (forensics) for the memo; the
existing intelligence layer for the brief.

## Success criteria (all measurable)

- [ ] **Groundedness harness:** an automated check that extracts numeric
      claims from AI output and asserts each appears in the prompt payload
      (tolerating formatting). Both features ship with this harness in CI
      against recorded fixtures; sampled live outputs pass ≥ 95%, failures
      logged for prompt iteration.
- [ ] Per-trade memo available on any stamped+forensics-complete position;
      renders a deterministic fallback (the facts, un-narrated) when no AI
      key is configured.
- [ ] Daily brief generates each morning from: market snapshot, discovery/
      spikes, events/catalysts, breadth/macro, the user's open positions and
      yesterday's closed trades. Grounded, same harness.
- [ ] Keys stay in the browser (existing BYOK stance) — memo/brief generation
      happens client-side against provider APIs, or the user explicitly
      opts a key into server-side storage (M1 custody) for scheduled briefs.
- [ ] Every AI-authored surface is visibly labeled as AI-generated with a
      "grounded in your data as of <ts>" line.

## Guardrails

- The prompt contains **only** persisted rows (stamps, forensics, snapshot);
  the model is instructed to reason only from them (existing
  `analyst-context.ts` pattern — extend it, don't fork it).
- No trade recommendations in the brief. The memo reviews the past; the brief
  describes the present; M6 owns anything decision-shaped, gated by M5 stats.
- Token cost is the user's (BYOK) — keep payloads compact; reuse the
  existing compaction patterns in `analyst-context.ts`.

## Tasks

- [ ] **M4-T1 — Groundedness harness.** Pure module: (promptPayload, output)
      → list of unmatched numeric claims; CI fixtures from recorded runs.
      *DoD:* harness catches a seeded hallucinated number in fixtures.
- [ ] **M4-T2 — Trade-memo context builder.** Extend `analyst-context.ts`
      with a position section: facts from M1, stamp from M2, forensics from
      M3, counterfactuals labeled. Compact, deterministic ordering.
      *DoD:* snapshot-tested payload; size budget documented.
- [ ] **M4-T3 — Trade-memo UI.** "Review this trade" on position detail →
      memo (client-side BYOK call), grounded-label, no-key fallback.
      *DoD:* live memo on a real position passes the harness.
- [ ] **M4-T4 — Daily-brief context builder.** Assemble the morning payload
      (snapshot, discovery, spikes, events, macro/breadth, user's open risk +
      yesterday's closes). Deterministic; works with zero open positions.
      *DoD:* snapshot-tested; renders without AI as a structured fact sheet.
- [ ] **M4-T5 — Brief surface + scheduling.** Brief page/card on the
      homepage; generation on first visit of the day (client BYOK) and,
      if the user opted a key into server custody, a scheduled worker pass
      that pushes it through the existing SSE notification stream.
      *DoD:* brief appears each morning for the owner; SSE path exercised.
- [ ] **M4-T6 — Groundedness in production.** Log harness results for live
      generations (memo + brief); add a `docs/ai-groundedness.md` with the
      measured pass rate after one week and prompt adjustments made.
      *DoD:* ≥95% sampled pass rate or documented iteration plan.
