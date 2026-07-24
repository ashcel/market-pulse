import hashlib
import hmac
import time
import urllib.parse
from typing import Any

import httpx

from .config import execution_settings
from .constants import BINANCE_NO_NEED_TO_CHANGE_MARGIN_TYPE


class BinanceExecClient:
    def __init__(self, api_key: str, api_secret: str, testnet: bool = True):
        self.api_key = api_key
        self.api_secret = api_secret
        self.testnet = testnet
        self.base_url = (
            execution_settings.BINANCE_TESTNET_FUTURES_URL
            if testnet
            else execution_settings.BINANCE_MAINNET_FUTURES_URL
        )

    def _sign(self, query_string: str) -> str:
        return hmac.new(
            self.api_secret.encode("utf-8"), query_string.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    async def _request(self, method: str, path: str, params: dict | None = None) -> Any:
        params = params or {}
        params["timestamp"] = int(time.time() * 1000)
        params["recvWindow"] = 5000

        if method == "GET" or method == "DELETE":
            query_string = urllib.parse.urlencode(params)
            signature = self._sign(query_string)
            query_string += f"&signature={signature}"
            url = f"{self.base_url}{path}?{query_string}"
            async with httpx.AsyncClient() as client:
                resp = await client.request(method, url, headers={"X-MBX-APIKEY": self.api_key})
                resp.raise_for_status()
                return resp.json()
        else:
            query_string = urllib.parse.urlencode(params)
            signature = self._sign(query_string)
            params["signature"] = signature
            url = f"{self.base_url}{path}"
            async with httpx.AsyncClient() as client:
                # Binance FAPI uses form-urlencoded or query string for POSTs too typically
                # but let's send it as query string in url or data
                resp = await client.request(
                    method, url, data=params, headers={"X-MBX-APIKEY": self.api_key}
                )
                resp.raise_for_status()
                return resp.json()

    async def test_connection(self) -> dict:
        return await self._request("GET", "/fapi/v2/account")

    async def get_account(self) -> dict:
        return await self._request("GET", "/fapi/v2/account")

    async def get_balance(self) -> list[dict]:
        return await self._request("GET", "/fapi/v2/balance")

    async def get_positions(
        self, symbol: str | None = None, include_zero: bool = False
    ) -> list[dict]:
        """positionRisk rows. By default only open positions (nonzero
        `positionAmt`), preserving the original behavior. Pass
        ``include_zero=True`` to also get the flat row for a symbol — needed
        by the F1 leverage/margin read-back, which runs *before* any position
        exists and must still confirm the symbol's `leverage`/`marginType`.
        """
        positions = await self._request("GET", "/fapi/v2/positionRisk")
        if symbol is not None:
            positions = [p for p in positions if str(p.get("symbol")) == symbol]
        if include_zero:
            return positions
        return [p for p in positions if float(p.get("positionAmt", 0)) != 0]

    async def set_leverage(self, symbol: str, leverage: int) -> dict:
        """POST /fapi/v1/leverage — set the initial leverage for a symbol.

        F1: the exchange must be told the judged leverage before entry, or the
        position opens at whatever leverage the symbol last carried and every
        permit's margin/liquidation number is fiction.
        """
        return await self._request(
            "POST", "/fapi/v1/leverage", {"symbol": symbol, "leverage": int(leverage)}
        )

    async def set_margin_type(self, symbol: str, margin_type: str) -> dict:
        """POST /fapi/v1/marginType — set ISOLATED/CROSSED for a symbol.

        Binance returns error code -4046 ("No need to change margin type.")
        when the symbol is already in the requested mode — a no-op success,
        surfaced here as a normal result so callers don't treat it as a
        failure. Any other error propagates.
        """
        try:
            return await self._request(
                "POST",
                "/fapi/v1/marginType",
                {"symbol": symbol, "marginType": margin_type},
            )
        except httpx.HTTPStatusError as exc:
            code = None
            try:
                code = exc.response.json().get("code")
            except (ValueError, AttributeError):
                code = None
            if code == BINANCE_NO_NEED_TO_CHANGE_MARGIN_TYPE:
                return {"code": 200, "msg": "No need to change margin type.", "noop": True}
            raise

    async def get_mark_price(self, symbol: str) -> dict:
        """GET /fapi/v1/premiumIndex — current mark price for a symbol.

        F4: read at consume time to reject a market entry whose price has
        drifted materially from the proposal entry the permit was judged at.
        Unsigned public endpoint, but routed through the signed `_request`
        for one code path; extra signature params are harmless.
        """
        return await self._request("GET", "/fapi/v1/premiumIndex", {"symbol": symbol})

    async def get_open_orders(self, symbol: str | None = None) -> list[dict]:
        params = {}
        if symbol:
            params["symbol"] = symbol
        return await self._request("GET", "/fapi/v1/openOrders", params)

    async def get_order(
        self,
        symbol: str,
        order_id: str | None = None,
        orig_client_order_id: str | None = None,
    ) -> dict:
        params = {"symbol": symbol}
        if order_id:
            params["orderId"] = order_id
        if orig_client_order_id:
            params["origClientOrderId"] = orig_client_order_id
        return await self._request("GET", "/fapi/v1/order", params)

    async def place_order(
        self,
        symbol: str,
        side: str,
        order_type: str,
        quantity: float,
        price: float | None = None,
        stop_price: float | None = None,
        reduce_only: bool = False,
        time_in_force: str | None = None,
        new_client_order_id: str | None = None,
    ) -> dict:
        params = {"symbol": symbol, "side": side, "type": order_type, "quantity": quantity}
        if price is not None:
            params["price"] = price
        if stop_price is not None:
            params["stopPrice"] = stop_price
        if reduce_only:
            params["reduceOnly"] = "true"
        if time_in_force is not None:
            params["timeInForce"] = time_in_force
        if new_client_order_id is not None:
            params["newClientOrderId"] = new_client_order_id

        return await self._request("POST", "/fapi/v1/order", params)

    async def cancel_order(
        self, symbol: str, order_id: str | None = None, orig_client_order_id: str | None = None
    ) -> dict:
        params = {"symbol": symbol}
        if order_id:
            params["orderId"] = order_id
        if orig_client_order_id:
            params["origClientOrderId"] = orig_client_order_id
        return await self._request("DELETE", "/fapi/v1/order", params)

    async def place_algo_order(
        self,
        symbol: str,
        side: str,
        order_type: str,
        *,
        trigger_price: float,
        close_position: bool = False,
        quantity: float | None = None,
        working_type: str = "CONTRACT_PRICE",
        reduce_only: bool = False,
        new_client_strategy_id: str | None = None,
    ) -> dict:
        params = {
            "algoType": "CONDITIONAL",
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "triggerPrice": trigger_price,
            "workingType": working_type,
        }
        if close_position:
            params["closePosition"] = "true"
        else:
            if quantity is not None:
                params["quantity"] = quantity
            if reduce_only:
                params["reduceOnly"] = "true"
        if new_client_strategy_id is not None:
            params["newClientStrategyId"] = new_client_strategy_id

        return await self._request("POST", "/fapi/v1/algoOrder", params)

    async def cancel_algo_order(
        self, algo_id: int | str | None = None, client_algo_id: str | None = None
    ) -> dict:
        params = {}
        if algo_id is not None:
            params["algoId"] = algo_id
        if client_algo_id is not None:
            params["clientAlgoId"] = client_algo_id
        return await self._request("DELETE", "/fapi/v1/algoOrder", params)

    async def get_open_algo_orders(self, symbol: str | None = None) -> list[dict]:
        params = {}
        if symbol:
            params["symbol"] = symbol
        return await self._request("GET", "/fapi/v1/openAlgoOrders", params)

    async def get_income_history(
        self,
        income_type: str | None = None,
        start_time: int | None = None,
        end_time: int | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        params = {"limit": limit}
        if income_type:
            params["incomeType"] = income_type
        if start_time:
            params["startTime"] = start_time
        if end_time:
            params["endTime"] = end_time
        return await self._request("GET", "/fapi/v1/income", params)

    async def get_user_trades(
        self,
        symbol: str,
        start_time: int | None = None,
        end_time: int | None = None,
        from_id: int | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        """Account trade list for one symbol — `/fapi/v1/userTrades`. Used by
        Trade Review to reconstruct entry/exit prices, quantities, fees, and
        the closing fill's originating orderId (see app.binance_review)."""
        params: dict[str, Any] = {"symbol": symbol, "limit": limit}
        if start_time:
            params["startTime"] = start_time
        if end_time:
            params["endTime"] = end_time
        if from_id is not None:
            params["fromId"] = from_id
        return await self._request("GET", "/fapi/v1/userTrades", params)

    async def get_all_orders(
        self,
        symbol: str,
        start_time: int | None = None,
        end_time: int | None = None,
        order_id: int | None = None,
        limit: int = 500,
    ) -> list[dict]:
        """All historical orders for one symbol — `/fapi/v1/allOrders`. Used
        by Trade Review to classify a closing fill as SL/TP/liquidation/manual
        by looking up the order that produced it."""
        params: dict[str, Any] = {"symbol": symbol, "limit": limit}
        if start_time:
            params["startTime"] = start_time
        if end_time:
            params["endTime"] = end_time
        if order_id is not None:
            params["orderId"] = order_id
        return await self._request("GET", "/fapi/v1/allOrders", params)
