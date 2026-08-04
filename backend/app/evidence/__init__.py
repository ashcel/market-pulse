"""Evidence plane — the code that tests the product's own claims.

EDR 0024 decision 3: a score that has not been correlated against forward
returns may not render a number. This plane is what makes that decision
computable instead of editorial. It measures; it never decides. Nothing here
feeds the engine, so `ENGINE_VERSION` stays 2.0.0.

V1 builds it in two halves:

  1. **The ground truth** (`forward_returns.py`, this task) — what an asset
     actually did over each horizon, stored once and reused by every test.
  2. **The claims** (V1-T2) — every score the product renders, snapshotted at
     the moment it was rendered.

The Information Coefficient (V1-T3/T4) is the rank correlation between the
two, and its decay across horizons is what tells us the honest holding period
of any given read.

House rule for the whole plane: a measurement is only admissible if it could
have been made in real time. A forward return is computed from bars strictly
after the observation, and a score is recorded when it is shown — never
reconstructed afterwards from history. That is the line between a track record
and a backtest wearing its clothes.
"""
