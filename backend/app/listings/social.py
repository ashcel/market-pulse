"""Realtime social collection for a listing candidate.

The brief is "popular and newer posts only", and that is exactly what the X
recent-search API is good at: a 7-day index, relevancy ordering, and public
metrics on every post so popularity is a number rather than a guess. This
module collects; `smc.listing_social` decides what the posts mean.

**X needs a bearer token.** There is no keyless path left — the syndication
endpoint returns empty bodies, nitter instances are dead, and Reddit's JSON
search 403s this host. So rather than pretend, the collector reports
`no_x_bearer_token` when unconfigured and the UI shows the pulse as
uncollected instead of showing a neutral zero that looks like real
indifference. Everything else in the screener works without it; set
`X_BEARER_TOKEN` and the social component lights up.

The query is built to fight the two failure modes that make new-listing
social data useless: cashtag collisions (a 3-letter ticker matches unrelated
chatter) and airdrop farms (thousands of identical posts). The first is
handled here by requiring crypto context in the query; the second in
`listing_social.is_spam`.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import httpx
from smc.listing_social import SocialPost, SocialPulse, build_pulse

from app.config import settings

logger = logging.getLogger("listings")

X_RECENT_SEARCH = "https://api.x.com/2/tweets/search/recent"

# X caps recent search at 7 days; the pulse only weights ~48h anyway.
COLLECTION_WINDOW_HOURS = 48
MAX_RESULTS = 50


def build_query(symbol: str, name: str | None = None) -> str:
    """Cashtag OR name, with crypto context and the noise stripped.

    `$SYM` is the precise form but low-volume for a brand-new token, so the
    project name is OR'd in when it is distinctive enough to not collide with
    ordinary English (a 3-letter name would drag in everything).
    """
    ticker = symbol.strip().upper()
    clauses = [f"${ticker}", f"#{ticker}"]
    if name and len(name) >= 5 and name.lower() != ticker.lower():
        clauses.append(f'"{name.strip()}"')
    core = " OR ".join(clauses)
    return f"({core}) -is:retweet -is:reply lang:en"


def _parse_users(payload: dict) -> dict[str, dict]:
    users = ((payload.get("includes") or {}).get("users")) or []
    return {user["id"]: user for user in users if isinstance(user, dict) and user.get("id")}


def _to_posts(payload: dict) -> list[SocialPost]:
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    users = _parse_users(payload)

    posts: list[SocialPost] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        created_raw = row.get("created_at")
        try:
            created_at = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)

        metrics = row.get("public_metrics") or {}
        author = users.get(str(row.get("author_id") or ""), {})
        author_metrics = author.get("public_metrics") or {}
        username = author.get("username") or ""

        posts.append(
            SocialPost(
                id=str(row.get("id") or ""),
                source="x",
                text=str(row.get("text") or ""),
                created_at=created_at,
                author=username,
                author_followers=int(author_metrics.get("followers_count") or 0),
                likes=int(metrics.get("like_count") or 0),
                reposts=int(metrics.get("retweet_count") or 0),
                replies=int(metrics.get("reply_count") or 0),
                url=f"https://x.com/{username}/status/{row.get('id')}" if username else "",
            )
        )
    return posts


async def collect_x_posts(
    symbol: str, name: str | None = None
) -> tuple[list[SocialPost], str | None]:
    """Recent, relevance-ranked posts for one token. `(posts, reason)`."""
    token = settings.X_BEARER_TOKEN
    if not token:
        return [], "no_x_bearer_token"

    start_time = datetime.now(UTC) - timedelta(hours=COLLECTION_WINDOW_HOURS)
    params = {
        "query": build_query(symbol, name),
        "max_results": MAX_RESULTS,
        "sort_order": "relevancy",
        "start_time": start_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tweet.fields": "created_at,public_metrics,lang",
        "expansions": "author_id",
        "user.fields": "public_metrics,username,verified",
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                X_RECENT_SEARCH,
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        logger.warning("listings: X search failed for %s: %s", symbol, exc)
        return [], "x_request_failed"

    if response.status_code == 429:
        return [], "x_rate_limited"
    if response.status_code == 401:
        return [], "x_unauthorized"
    if response.status_code != 200:
        logger.warning("listings: X search %s -> HTTP %s", symbol, response.status_code)
        return [], f"x_http_{response.status_code}"

    try:
        payload = response.json()
    except ValueError:
        return [], "x_bad_payload"
    if not isinstance(payload, dict):
        return [], "x_bad_payload"

    return _to_posts(payload), None


async def fetch_social_pulse(symbol: str, name: str | None = None) -> SocialPulse:
    """Collect, then fold into the realtime pulse."""
    posts, reason = await collect_x_posts(symbol, name)
    if reason is not None:
        return build_pulse(symbol, [], unavailable_reason=reason)
    return build_pulse(symbol, posts)
