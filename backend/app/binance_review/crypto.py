"""Fernet-based symmetric encryption for storing the Trade Review Binance API
secret at rest.

The encryption key is derived from `binance_review_settings.ENCRYPTION_SECRET`
(an arbitrary-length passphrase) via SHA-256, then base64url-encoded — this is
exactly the 32-byte key shape Fernet requires. Same pattern as the (now-inert)
`app.bybit.crypto` module this replaces, kept as its own passphrase/module
rather than reusing `app.execution.exec_key_crypto` so the two key classes
(read-only review vs. order-placement execution) stay independently rotatable.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from .config import binance_review_settings
from .exceptions import BinanceReviewCryptoError


def _fernet() -> Fernet:
    digest = hashlib.sha256(binance_review_settings.ENCRYPTION_SECRET.encode()).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError) as exc:
        raise BinanceReviewCryptoError("Stored Binance secret could not be decrypted") from exc
