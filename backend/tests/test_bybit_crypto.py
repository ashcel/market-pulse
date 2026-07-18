"""Fernet round-trip tests for the Bybit API-secret encryption helper."""

import pytest

from app.bybit.crypto import decrypt, encrypt
from app.bybit.exceptions import BybitCryptoError


def test_round_trip() -> None:
    plaintext = "super-secret-bybit-api-secret-1234567890"
    token = encrypt(plaintext)
    assert token != plaintext
    assert decrypt(token) == plaintext


def test_round_trip_arbitrary_length_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.bybit.config import bybit_settings

    # SHA-256-derives the Fernet key, so any passphrase length must work.
    monkeypatch.setattr(bybit_settings, "ENCRYPTION_SECRET", "x")
    assert decrypt(encrypt("short-secret")) == "short-secret"

    monkeypatch.setattr(bybit_settings, "ENCRYPTION_SECRET", "y" * 500)
    assert decrypt(encrypt("long-secret")) == "long-secret"


def test_decrypt_malformed_token_raises() -> None:
    with pytest.raises(BybitCryptoError):
        decrypt("not-a-valid-fernet-token")


def test_decrypt_empty_token_raises() -> None:
    with pytest.raises(BybitCryptoError):
        decrypt("")
