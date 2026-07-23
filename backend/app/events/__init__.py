"""Event intelligence read plane — Catalyst Impact Score (pure) plus the
FastAPI read model that stamps it onto stored event rows at serve time.

The worker passes (`app.worker.event_pass` / `unlock_pass` / `econ_pass`)
remain the sole writers of `token_event` / `catalyst_event` /
`economic_event`; this package only reads and annotates.
"""
