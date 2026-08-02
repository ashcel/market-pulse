"""Derivatives Intelligence — Binance USDⓈ-M positioning read.

Not a Binance clone: nothing in this package renders a raw number without a
computed interpretation next to it. Every metric answers "what does this
imply?" — the raw snapshot is kept only so the interpretation is auditable.

Planes:
  - `binance.py`  — the ONLY place derivatives endpoints are fetched.
  - `models.py`   — `derivatives_snapshot`, append-only (DB trigger).
  - `service.py`  — every derived metric, server-side. The client recomputes
                    nothing.
  - `repo.py`     — the only SQL surface.
  - `router.py`   — `/api/v1/derivatives/{symbol}` (+ `/history`).
"""
