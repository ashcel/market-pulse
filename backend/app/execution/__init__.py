"""Execution plane (M9 / EDR 0020).

New plane — NOT an engine change. ENGINE_VERSION stays 2.0.0.
Deterministic risk desk: Trading Constitution, risk engine, position
sizing, Trade Quality Score, Trade Permit. No order-placement code lives
here until Phase C, and only behind the EXECUTION_ENABLED kill switch.
"""
