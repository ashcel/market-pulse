"""Frozen parameters of the evidence plane.

Changing a horizon set changes what every stored IC means, so these are
constants with a version, not configuration.
"""

from typing import Final

#: Bumped whenever a horizon is added, removed, or redefined. Stored on every
#: row so a horizon change is a new cohort rather than a silent reinterpretation
#: of the old one.
FORWARD_RETURN_VERSION: Final = "1.0.0"

#: The bar the plane measures on. One hour is the finest interval every tracked
#: symbol has continuous history for, and it divides all six horizons evenly.
BASE_INTERVAL: Final = "1H"

#: Seconds in one `BASE_INTERVAL` bar. Used to turn Binance's bar *open* time
#: into the close time the measurement is anchored to.
BAR_SECONDS: Final = 3_600

#: Horizon label -> number of `BASE_INTERVAL` bars ahead.
#:
#: The set spans intraday to swing deliberately: the IC decay curve across
#: these six points is what declares a score's honest holding period, and a
#: curve needs both ends to have a shape.
HORIZONS: Final[dict[str, int]] = {
    "1h": 1,
    "4h": 4,
    "12h": 12,
    "1d": 24,
    "3d": 72,
    "7d": 168,
}

#: Longest horizon, in bars — how far past an observation the plane must see
#: before that observation's slowest row can be written.
MAX_HORIZON_BARS: Final = max(HORIZONS.values())
