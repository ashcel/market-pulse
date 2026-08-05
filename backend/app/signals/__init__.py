"""Signal facts plane — Sprint 2 "balik arah" (docs/IMPLEMENTATION-PLAN.md §2.1).

Market Pulse owns signal facts here instead of proxying them out of another
app. Append-only by construction: `repo.py` exports an insert plus reads, and
the table itself carries a BEFORE UPDATE OR DELETE trigger.
"""
