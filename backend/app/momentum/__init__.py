"""MOMENTUM RADAR — the realtime discovery plane behind `/discover`.

    Binance WS (!ticker@arr, one connection)
      -> ingestor.py        parse frames
      -> state.py           in-memory market state + rolling window aggregator
      -> smc.momentum       momentum score + deterministic state machine
      -> scanner.py         candidate registry + top-K ranking
      -> router.py          JSON snapshot + SSE stream
      -> Discover UI        compact realtime cards

Postgres stays out of the hot path entirely: nothing here is persisted, and a
restart simply re-warms from the stream. A candidate is a *radar contact*, never
a trade signal — the engine's verdict lives on the token page.
"""
