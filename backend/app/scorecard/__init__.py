"""Sprint 5 scorecard — evidence for signal sources.

`source_scorecard` tracks hit-rate + avg R per source, version, regime, and
horizon over a rolling window. Computed nightly at 00:00 UTC from
`signal_events` joined to the forward-test settlement tables (same settlement
code path — this is the reason Zipline was rejected, per §1.5-#5).

Flag `SCORECARD_ENABLED` (default 0/False) gates the cron; rows are written
but the UI shows "Belum cukup data" until n ≥ 20.
"""
