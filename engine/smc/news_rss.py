"""Feed-agnostic RSS item extraction (port of news.ts's parsing plane).

Only the raw-item parser lives here — sentiment/impact tagging is a legacy
UI concern and stays TS-side until the SPA phase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime


@dataclass(slots=True)
class RssItemRaw:
    headline: str
    description: str
    url: str | None
    guid: str | None
    # Epoch ms from pubDate; None when absent/unparseable.
    published_at_ms: int | None


def _strip_cdata(value: str) -> str:
    value = re.sub(r"^<!\[CDATA\[", "", value)
    return re.sub(r"\]\]>$", "", value)


def _decode_entities(value: str) -> str:
    for entity, char in (
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", '"'),
        ("&#039;", "'"),
        ("&apos;", "'"),
        ("&nbsp;", " "),
    ):
        value = value.replace(entity, char)
    return value


def _strip_html(value: str) -> str:
    text = _decode_entities(re.sub(r"<[^>]*>", " ", value))
    return re.sub(r"\s+", " ", text).strip()


def _tag_content(xml: str, tag: str) -> str | None:
    match = re.search(rf"<{tag}[^>]*>([\s\S]*?)</{tag}>", xml, re.IGNORECASE)
    if match is None:
        return None
    return _strip_cdata(match.group(1).strip()).strip()


def _parse_pub_date_ms(value: str) -> int | None:
    """Date.parse equivalent for the formats feeds actually emit (RFC 2822
    first — the RSS norm — then ISO)."""
    try:
        return int(parsedate_to_datetime(value).timestamp() * 1000)
    except (TypeError, ValueError):
        pass
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def parse_rss_items(xml: str) -> list[RssItemRaw]:
    items = re.findall(r"<item>[\s\S]*?</item>", xml, re.IGNORECASE)
    parsed: list[RssItemRaw] = []
    for item in items:
        title = _tag_content(item, "title")
        if not title:
            continue
        pub_date = _tag_content(item, "pubDate")
        published_at_ms = _parse_pub_date_ms(pub_date) if pub_date else None
        parsed.append(
            RssItemRaw(
                headline=_strip_html(title),
                description=_strip_html(_tag_content(item, "description") or ""),
                url=_tag_content(item, "link"),
                guid=_tag_content(item, "guid"),
                published_at_ms=published_at_ms,
            )
        )
    return parsed
