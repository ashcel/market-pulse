"""OpenRouter-compatible LLM client for news sentiment analysis.

Stateless HTTP client that sends batched headlines to DeepSeek Flash
(or any OpenRouter model) and parses structured sentiment responses.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger("news_intel")

# ── Response schemas ─────────────────────────────────────────────────────────

DEFAULT_TIMEOUT_S = 30
MAX_RETRIES = 2


@dataclass(slots=True)
class AssetSentiment:
    direction: str  # "bullish" | "bearish" | "neutral"
    confidence: float  # 0.0–1.0
    reason: str | None = None


@dataclass(slots=True)
class MarketSentiment:
    score: float  # 0–100 (0 = extreme bearish, 50 = neutral, 100 = extreme bullish)
    label: str  # "Bullish" | "Bearish" | "Neutral"
    description: str
    bullish_ratio: float
    bearish_ratio: float
    neutral_ratio: float


@dataclass(slots=True)
class SentimentAnalysisResult:
    market_sentiment: MarketSentiment
    asset_sentiments: dict[str, AssetSentiment]
    key_narratives: list[str]
    ai_brief: str
    raw_response: str | None = None


# ── Prompt template ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a crypto market sentiment analyst. Your role is to analyze news headlines and produce structured sentiment data.

Rules:
1. Analyze each headline in context — don't just match keywords
2. For each asset mentioned, assess whether the news is bullish, bearish, or neutral
3. Provide a confidence score (0.0–1.0) for each assessment
4. Identify key narratives/themes driving the news
5. Write a brief 2-3 sentence market summary
6. NEVER fabricate data — if there aren't enough headlines, say so
7. Return ONLY valid JSON, no markdown wrapping

Response format:
{
  "market_sentiment": {
    "score": <0-100>,
    "label": "Bullish|Bearish|Neutral",
    "description": "<one-sentence summary>",
    "bullish_ratio": <0.0-1.0>,
    "bearish_ratio": <0.0-1.0>,
    "neutral_ratio": <0.0-1.0>
  },
  "asset_sentiments": {
    "BTC": {
      "direction": "bullish|bearish|neutral",
      "confidence": 0.0-1.0,
      "reason": "<why this assessment>"
    }
  },
  "key_narratives": ["<narrative 1>", "<narrative 2>"],
  "ai_brief": "<2-3 sentence market summary>"
}"""


def _build_user_prompt(headlines: list[dict[str, Any]]) -> str:
    """Build a user prompt from a list of headline dicts.

    Each headline dict: {headline, description?, source?, published_at?, assets?}
    """
    items = []
    for i, h in enumerate(headlines, 1):
        line = f"{i}. \"{h.get('headline', '')}\""
        if h.get("source"):
            line += f" — {h['source']}"
        if h.get("assets"):
            line += f" [assets: {', '.join(h['assets'][:5])}]"
        if h.get("description"):
            # Truncate long descriptions
            desc = h["description"][:200]
            line += f"\n   {desc}"
        items.append(line)

    prompt = f"Analyze these {len(headlines)} crypto/market news headlines:\n\n"
    prompt += "\n".join(items)
    prompt += "\n\nReturn the structured JSON analysis."
    return prompt


async def analyze_sentiment(
    headlines: list[dict[str, Any]],
    client: httpx.AsyncClient | None = None,
) -> SentimentAnalysisResult | None:
    """Send headlines to LLM and parse sentiment response.

    Returns None if the API call fails or parsing fails.
    """
    base_url = settings.LLM_BASE_URL
    if not base_url:
        logger.warning("LLM endpoint not configured — skipping sentiment analysis")
        return None

    user_prompt = _build_user_prompt(headlines)
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S)

    last_error: Exception | None = None

    # OpenCode Zen free tier doesn't need an API key
    headers = {
        "Content-Type": "application/json",
        "HTTP-Referer": "https://iq.heydewi.com",
        "X-Title": "Market Pulse",
    }
    if settings.LLM_API_KEY:
        headers["Authorization"] = f"Bearer {settings.LLM_API_KEY}"

    try:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = await client.post(
                    f"{settings.LLM_BASE_URL}/chat/completions",
                    json={
                        "model": settings.LLM_MODEL,
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": 0.3,
                        "max_tokens": 2000,
                        "response_format": {"type": "json_object"},
                    },
                )
                if response.status_code != 200:
                    raise RuntimeError(
                        f"LLM API returned {response.status_code}: {response.text[:300]}"
                    )

                body = response.json()
                raw = body["choices"][0]["message"]["content"]
                return _parse_response(raw)

            except (httpx.HTTPError, RuntimeError, KeyError, json.JSONDecodeError) as e:
                last_error = e
                logger.warning(
                    "LLM call attempt %d/%d failed: %s", attempt, MAX_RETRIES, e
                )
                if attempt < MAX_RETRIES:
                    import asyncio

                    await asyncio.sleep(2**attempt)

        logger.error("All LLM call attempts failed: %s", last_error)
        return None

    finally:
        if own_client:
            await client.aclose()


def _parse_response(raw: str) -> SentimentAnalysisResult | None:
    """Parse LLM JSON response into structured result."""
    try:
        # Strip any markdown code fences
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
            cleaned = cleaned.rsplit("```", 1)[0]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()

        data = json.loads(cleaned)
    except (json.JSONDecodeError, AttributeError) as e:
        logger.error("Failed to parse LLM response JSON: %s", e)
        return None

    try:
        ms = data.get("market_sentiment", {})
        market = MarketSentiment(
            score=float(ms.get("score", 50)),
            label=str(ms.get("label", "Neutral")),
            description=str(ms.get("description", "")),
            bullish_ratio=float(ms.get("bullish_ratio", 0)),
            bearish_ratio=float(ms.get("bearish_ratio", 0)),
            neutral_ratio=float(ms.get("neutral_ratio", 0)),
        )

        asset_map: dict[str, AssetSentiment] = {}
        for ticker, val in (data.get("asset_sentiments") or {}).items():
            asset_map[ticker.upper()] = AssetSentiment(
                direction=str(val.get("direction", "neutral")),
                confidence=float(val.get("confidence", 0.5)),
                reason=str(val.get("reason")) if val.get("reason") else None,
            )

        return SentimentAnalysisResult(
            market_sentiment=market,
            asset_sentiments=asset_map,
            key_narratives=list(data.get("key_narratives") or []),
            ai_brief=str(data.get("ai_brief", "")),
            raw_response=raw,
        )
    except (TypeError, ValueError, AttributeError) as e:
        logger.error("Failed to structure LLM response: %s", e)
        return None
