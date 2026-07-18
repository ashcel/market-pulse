"""Async Bybit V5 REST client: HMAC signing, host failover, retry/backoff.

Ports the signing contract of the reference TS client
(`tradereview/lib/bybit/client.ts`) with the two details that are load-bearing
for a valid Bybit V5 signature:

  - GET requests build the query string by hand (`k=v` pairs joined by `&`,
    `None` values dropped) and sign *that exact string* — never delegate
    query building to the HTTP client, since re-ordering or re-escaping
    changes the signature and Bybit rejects the request.
  - POST requests sign the exact compact-JSON body bytes
    (`json.dumps(..., separators=(",", ":"))`) that get sent as `content=`.
"""

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any, Literal

import httpx

from .constants import (
    BYBIT_MAINNET_FAILOVER_URL,
    BYBIT_MAINNET_URL,
    BYBIT_TESTNET_URL,
    RECV_WINDOW_MS,
    RET_CODE_RATE_LIMITED,
    TIME_OFFSET_TTL_MS,
)
from .exceptions import BybitUpstreamError

_MAX_RETRIES = 3
_INITIAL_BACKOFF_S = 1.0

# Module-level server-time-offset cache shared across client instances,
# mirroring the reference TS client's module-level `cachedTimeOffset`.
_cached_time_offset_ms: int | None = None
_last_offset_fetch_monotonic_ms: float = 0.0


def _now_ms() -> int:
    return int(time.time() * 1000)


def _failover_url(url: str) -> str:
    return url.replace(BYBIT_MAINNET_URL, BYBIT_MAINNET_FAILOVER_URL)


async def _fetch_server_offset_ms(base_url: str, http: httpx.AsyncClient) -> int | None:
    try:
        resp = await http.get(f"{base_url}/v5/market/time", timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError):
        return None

    server_ms: int | None = None
    if data.get("time"):
        server_ms = int(data["time"])
    else:
        time_nano = (data.get("result") or {}).get("timeNano")
        if time_nano:
            server_ms = int(time_nano) // 1_000_000
    if server_ms is None:
        return None
    return server_ms - _now_ms()


async def get_time_offset(base_url: str, http: httpx.AsyncClient) -> int:
    """Return the cached (or freshly fetched) clock-drift offset in ms.

    Cached for ~1h; on cache miss, tries `base_url` then its `.bytick.com`
    failover before giving up and returning the last-known (or zero) offset.
    """
    global _cached_time_offset_ms, _last_offset_fetch_monotonic_ms
    now = time.monotonic() * 1000
    if (
        _cached_time_offset_ms is not None
        and now - _last_offset_fetch_monotonic_ms < TIME_OFFSET_TTL_MS
    ):
        return _cached_time_offset_ms

    offset = await _fetch_server_offset_ms(base_url, http)
    if offset is None:
        failover = _failover_url(base_url)
        if failover != base_url:
            offset = await _fetch_server_offset_ms(failover, http)

    if offset is not None:
        _cached_time_offset_ms = offset
        _last_offset_fetch_monotonic_ms = now
        return offset
    return _cached_time_offset_ms or 0


def _sign(secret: str, timestamp: int, api_key: str, recv_window: int, payload: str) -> str:
    message = f"{timestamp}{api_key}{recv_window}{payload}"
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _build_query_string(params: dict[str, Any]) -> str:
    parts = [f"{k}={v}" for k, v in params.items() if v is not None]
    return "&".join(parts)


class BybitClient:
    """Signed Bybit V5 REST client for linear-perpetual account data."""

    def __init__(self, api_key: str, api_secret: str, testnet: bool = False) -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        self._base_url = BYBIT_TESTNET_URL if testnet else BYBIT_MAINNET_URL
        self._recv_window = RECV_WINDOW_MS

    async def _request(
        self,
        method: Literal["GET", "POST"],
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        params = params or {}
        base_url = self._base_url
        delay = _INITIAL_BACKOFF_S
        last_error: Exception | None = None

        async with httpx.AsyncClient(timeout=15.0) as http:
            for attempt in range(_MAX_RETRIES + 1):
                offset = await get_time_offset(base_url, http)
                timestamp = _now_ms() + offset

                if method == "GET":
                    query_string = _build_query_string(params)
                    signature_payload = query_string
                    body: bytes | None = None
                    request_url = f"{base_url}{path}"
                    if query_string:
                        request_url = f"{request_url}?{query_string}"
                else:
                    body_str = json.dumps(params, separators=(",", ":"))
                    signature_payload = body_str
                    body = body_str.encode()
                    request_url = f"{base_url}{path}"

                signature = _sign(
                    self._api_secret,
                    timestamp,
                    self._api_key,
                    self._recv_window,
                    signature_payload,
                )
                headers = {
                    "X-BAPI-API-KEY": self._api_key,
                    "X-BAPI-TIMESTAMP": str(timestamp),
                    "X-BAPI-SIGN": signature,
                    "X-BAPI-RECV-WINDOW": str(self._recv_window),
                }
                if method == "POST":
                    headers["Content-Type"] = "application/json"

                try:
                    if method == "GET":
                        resp = await http.get(request_url, headers=headers)
                    else:
                        resp = await http.post(request_url, headers=headers, content=body)
                except httpx.HTTPError as exc:
                    last_error = exc
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(delay)
                        base_url = _failover_url(base_url)
                        delay *= 2
                        continue
                    raise BybitUpstreamError(f"Bybit request failed: {exc}") from exc

                if resp.status_code == 429 and attempt < _MAX_RETRIES:
                    retry_after = _parse_retry_after(resp.headers.get("Retry-After"), delay)
                    await asyncio.sleep(retry_after)
                    base_url = _failover_url(base_url)
                    delay *= 2
                    continue

                try:
                    data: dict[str, Any] = resp.json()
                except ValueError as exc:
                    raise BybitUpstreamError(
                        f"Bybit returned a non-JSON response (HTTP {resp.status_code})"
                    ) from exc

                ret_code = data.get("retCode")
                if ret_code == RET_CODE_RATE_LIMITED and attempt < _MAX_RETRIES:
                    await asyncio.sleep(delay)
                    base_url = _failover_url(base_url)
                    delay *= 2
                    continue

                if ret_code != 0:
                    raise BybitUpstreamError(
                        data.get("retMsg", "Unknown Bybit error"), ret_code=ret_code
                    )

                result: dict[str, Any] = data.get("result") or {}
                return result

        if last_error is not None:
            raise BybitUpstreamError(f"Bybit request failed: {last_error}") from last_error
        raise BybitUpstreamError("Bybit request failed after retries")

    async def get_closed_pnl(
        self,
        category: str = "linear",
        limit: int = 50,
        cursor: str | None = None,
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            "/v5/position/closed-pnl",
            {
                "category": category,
                "limit": limit,
                "cursor": cursor,
                "startTime": start_time,
                "endTime": end_time,
            },
        )

    async def get_order_history(
        self,
        category: str = "linear",
        symbol: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            "/v5/order/history",
            {
                "category": category,
                "symbol": symbol.upper() if symbol else None,
                "limit": limit,
                "cursor": cursor,
                "startTime": start_time,
                "endTime": end_time,
            },
        )

    async def test_connection(self) -> bool:
        """Verify the key/secret pair is valid.

        Tries a UNIFIED-account wallet-balance lookup first (works for most
        modern accounts), then falls back to CONTRACT for classic accounts.
        Raises `BybitUpstreamError` (propagated from the CONTRACT attempt) if
        both fail.
        """
        try:
            await self._request(
                "GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"}
            )
            return True
        except BybitUpstreamError:
            await self._request(
                "GET", "/v5/account/wallet-balance", {"accountType": "CONTRACT"}
            )
            return True


def _parse_retry_after(header_value: str | None, default_s: float) -> float:
    if not header_value:
        return default_s
    try:
        return float(header_value)
    except ValueError:
        return default_s
