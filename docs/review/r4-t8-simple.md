Complete R4-T8: Whole-diff review against the definitions doc + honesty rules.

Read:
- docs/forensics-definitions.md
- docs/decisions/0023-forensics-measurement-boundary.md
- milestones/R4-review-forensics.md
- backend/app/review/forensics.py
- backend/app/review/models.py
- backend/app/worker/forensics_pass.py
- backend/app/worker/context_stamper.py
- frontend/src/components/features/review-panel.tsx
- frontend/src/hooks/useForensics.ts
- tests/test_forensics.py

Review:
1. MAE/MFE formulas correct for long/short?
2. Exit efficiency clamped at 100%? Negligible MFE guard?
3. Stop discipline slippage sign correct?
4. Re-entry: no_prior_trade vs overlapping_positions?
5. Sizing: insufficient_sample vs degenerate_cohort?
6. Honesty: R only with stop? No silent nulls? No backfill?

Run: python3 -m pytest tests/test_forensics.py -v

Write findings to docs/review/R4-T8-review-findings.md
If all pass: "R4 compliant with definitions doc v1.0.0"

NO code changes. NO git.
