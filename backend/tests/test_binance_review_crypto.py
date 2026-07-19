"""Fernet round-trip tests for the Binance Trade-Review API-secret encryption
helper."""

import pytest

from app.binance_review.crypto import decrypt, encrypt
from app.binance_review.exceptions import BinanceReviewCryptoError


def test_round_trip() -> None:
    plaintext = "super-secret-binance-api-secret-1234567890"
    token = encrypt(plaintext)
    assert token != plaintext
    assert decrypt(token) == plaintext


def test_round_trip_arbitrary_length_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.binance_review.config import binance_review_settings

    # SHA-256-derives the Fernet key, so any passphrase length must work.
    monkeypatch.setattr(binance_review_settings, "ENCRYPTION_SECRET", "x")
    assert decrypt(encrypt("short-secret")) == "short-secret"

    monkeypatch.setattr(binance_review_settings, "ENCRYPTION_SECRET", "y" * 500)
    assert decrypt(encrypt("long-secret")) == "long-secret"


def test_decrypt_malformed_token_raises() -> None:
    with pytest.raises(BinanceReviewCryptoError):
        decrypt("not-a-valid-fernet-token")


def test_decrypt_empty_token_raises() -> None:
    with pytest.raises(BinanceReviewCryptoError):
        decrypt("")
