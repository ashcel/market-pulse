# Milestone Summary

## Current Active: R4 — Trade review that changes behavior

- **Objective:** Every closed trade tells the user what they did, in facts, and the review names the habit.
- **File:** [R4-review-forensics.md](R4-review-forensics.md)
- **Status:** Started 2026-07-26. R4-T1 (EDR 0023 + definitions doc) complete. R4-T2 onwards in progress.
- **Scope:** 8 tasks total (T1-T8)

## Roadmap (R0-R6, agreed 2026-07-23)

| # | Item | Objective | Status |
|---|---|---|---|
| R0 | Safety & ops floor | Deploy hardening, firewall, key safety | Owner actions U18/U24 |
| R1 | Catalysts into verdict | Events modify the call, not just inform | Pending |
| R2 | Skip Check v1 | Deterministic trade/skip answer | Pending (depends on R1) |
| R3 | Execution plane (testnet) | Account state, trade lock, behavior detectors | Phase A done; T7/T10/T11 pending |
| R4 | Trade review & forensics | Per-trade facts name the habit | **Active** |
| R5 | Alternatives & CRO | When setup is invalid, answer "then what?" | Pending |
| R6 | Mainnet gate | Isolation decision + soft launch | Owner-decision-bound (U24) |

Full audit: [ROADMAP-2026-07-23.md](ROADMAP-2026-07-23.md).

## Key decisions

- M9 execution plane: testnet path exists, mainnet gated behind U24.
- M5 cohort analytics: deferred until n>=30 per segment.
- M7 TradFi mode: removed as mode; macro stays as catalyst context.
- M8 productization: deferred except ops-critical subset → R0.
- Trade Assistant is a collapsible dock sidebar on the token page.

## Owner actions

See [USER-ACTIONS.md](USER-ACTIONS.md) for pending owner-dependent items (U18, U20-U24).

## Delegation protocol

See [README.md](README.md) for the daily agent protocol (brief → delegate → review → ACCEPT/HOLD). No implementation by orchestrator; delegate to coding tools.
