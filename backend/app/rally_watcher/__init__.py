"""LIVE RALLY WATCHER — 15-minute momentum scan with target + liquidity.

Read-only, unpersisted: mirrors `engine/smc/rally_watcher.py`'s live-computed
`RallyRead` over the dynamic scan universe (`app.patterns.universe`). No
`signal_events` writes, no worker pass — a ~60s server-side cache only. See
`smc.rally_watcher` for the detector, targets, and liquidation-estimate
formulas.
"""
