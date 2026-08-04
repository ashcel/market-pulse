"""Pre-trade plane — the deterministic risk desk (M9 / EDR 0020, rescoped by
EDR 0024 decision 4).

NOT an engine change. ENGINE_VERSION stays 2.0.0.

What lives here: the Trading Constitution, the risk engine, position sizing,
liquidation-vs-stop checking, the Trade Quality Score, the Trade Permit, and
the skip check. All of it answers "should this trade be taken, and at what
size" — the DISCIPLINE job.

What does **not** live here: order transmission. EDR 0024 took it out of
scope; the permit is the product's output and the user places the order. The
order router, the trade lock, the execute route, and the IQ-placed execution
records are parked on `park/execution-orders`, and `binance_client.py` is
read-only. Restoring any of it is an EDR-level decision.

The exchange is still *read* from here — account, balance, positions, mark
price — because "what is at risk right now" is part of the same job.
"""
