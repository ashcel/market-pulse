"""Fernet-based symmetric encryption for storing the Bybit API secret at rest.

The encryption key is derived from `bybit_settings.ENCRYPTION_SECRET` (an
arbitrary-length passphrase) via SHA-256, then base64url-encoded — this is
exactly the 32-byte key shape Fernet requires.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from .config import bybit_settings
from .exceptions import BybitCryptoError


def _fernet() -> Fernet:
    digest = hashlib.sha256(bybit_settings.ENCRYPTION_SECRET.encode()).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError) as exc:
        raise BybitCryptoError("Stored Bybit secret could not be decrypted") from exc
