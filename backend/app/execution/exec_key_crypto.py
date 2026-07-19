import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from .config import execution_settings


def _fernet() -> Fernet:
    digest = hashlib.sha256(execution_settings.ENCRYPTION_SECRET.encode()).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError) as exc:
        raise ValueError("Stored Binance secret could not be decrypted") from exc
