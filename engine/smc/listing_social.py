"""Social pulse for a new listing — what the crowd is saying, right now.

New-listing chatter is not ordinary news chatter. It is dominated by paid
shills, airdrop farmers and copy-pasted rocket emoji, and the honest signal
is a thin minority inside it. So this module does three things a plain
sentiment average does not:

1. **Weights by reach, not by count.** One post from an account people
   actually read outweighs fifty farm replies. Reach is log-scaled — a 100k
   account is not a thousand times a 100-follower account.
2. **Decays hard by age.** A half-life measured in hours, because "the
   sentiment must be realtime" means a post from yesterday is context, not
   signal. The default half-life is 4h and the window is 48h.
3. **Discounts spam explicitly.** Duplicate text, link-only posts, emoji
   walls and tag-stuffing are detected and down-weighted, and the resulting
   `spam_ratio` is published — a token whose entire buzz is farmed should
   read as *farmed*, not as bullish.

The lexicon is small and launch-specific on purpose. A general finance
lexicon mislabels this vocabulary badly ("ape", "send it", "rug", "jeet"),
and a large one would need supervision we have no labels for.

Pure — the collectors that fetch posts live in the backend. Own version, no
ENGINE_VERSION involvement.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

LISTING_SOCIAL_VERSION = "1.0.0"

# How fast a post stops counting. 4h half-life: a 12h-old post carries 1/8th
# the weight of one posted now.
DEFAULT_HALF_LIFE_HOURS = 4.0
DEFAULT_WINDOW_HOURS = 48.0

# Phrases, checked before single words, because negation and multi-word slang
# carry most of the meaning in this register.
_BULLISH_PHRASES: tuple[str, ...] = (
    "buying the dip",
    "loading up",
    "diamond hands",
    "to the moon",
    "sending it",
    "send it",
    "generational bottom",
    "not selling",
    "long term hold",
    "strong hands",
    "undervalued",
    "gem",
    "early",
)
_BEARISH_PHRASES: tuple[str, ...] = (
    "rug pull",
    "rugged",
    "exit liquidity",
    "dead coin",
    "dumping on",
    "get out",
    "avoid this",
    "honeypot",
    "scam",
    "insider dump",
    "team selling",
    "down bad",
    "bag holder",
    "bagholder",
)

_BULLISH_WORDS: frozenset[str] = frozenset(
    {
        "bullish", "moon", "mooning", "pump", "pumping", "ape", "aping", "accumulate",
        "accumulating", "breakout", "sending", "green", "rip", "ripping", "alpha",
        "conviction", "buy", "buying", "bought", "hold", "holding", "hodl", "long",
        "longing", "based", "solid", "strong", "listed", "listing",
    }
)
_BEARISH_WORDS: frozenset[str] = frozenset(
    {
        "bearish", "dump", "dumping", "dumped", "rug", "scam", "sell", "selling", "sold",
        "short", "shorting", "red", "bleeding", "crash", "crashing", "down", "jeet",
        "jeets", "trash", "garbage", "ponzi", "farm", "farmed", "overvalued", "top",
        "topped", "exit", "dead",
    }
)

_NEGATORS: frozenset[str] = frozenset(
    {"not", "no", "never", "isnt", "isn't", "wasnt", "wasn't", "dont", "don't",
     "aint", "ain't", "cant", "can't"}
)

_INTENSIFIERS: frozenset[str] = frozenset(
    {"very", "super", "extremely", "massively", "insanely", "absolutely", "fucking"}
)

_URL = re.compile(r"https?://\S+")
_MENTION = re.compile(r"[@#]\w+")
_EMOJI = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf\U0001f1e6-\U0001f1ff]",
    flags=re.UNICODE,
)
_WORD = re.compile(r"[a-z']+")

# Spam heuristics.
_MAX_TAGS_BEFORE_SPAM = 5
_MAX_EMOJI_BEFORE_SPAM = 6
_MIN_WORDS_FOR_CONTENT = 4


@dataclass(slots=True)
class SocialPost:
    """One post from any source, normalized."""

    id: str
    source: str  # "x" | "reddit" | "telegram" | ...
    text: str
    created_at: datetime
    author: str = ""
    author_followers: int = 0
    likes: int = 0
    reposts: int = 0
    replies: int = 0
    url: str = ""

    @property
    def engagement(self) -> int:
        # Reposts are the strongest of the three: they cost the sharer
        # something and they multiply reach.
        return self.likes + 3 * self.reposts + self.replies


@dataclass(slots=True)
class ScoredPost:
    post: SocialPost
    sentiment: float  # -1..1
    weight: float  # combined reach x recency x spam discount
    is_spam: bool
    age_hours: float


@dataclass(slots=True)
class SocialPulse:
    symbol: str
    # Weighted sentiment across the window, -1..1. None when nothing survived.
    sentiment: float | None
    # Unweighted counts, for the "is anyone even talking" question.
    posts_total: int
    posts_24h: int
    posts_1h: int
    # Posts/hour in the last 6h against the window baseline. >1 is accelerating.
    velocity: float | None
    # Share of collected posts judged spam/farm, 0..1.
    spam_ratio: float
    # Total reach-weighted audience the non-spam posts reached.
    reach: int
    bullish_share: float | None
    bearish_share: float | None
    # The posts a human should actually read: popular, recent, not spam.
    top_posts: list[ScoredPost] = field(default_factory=list)
    sources: dict[str, int] = field(default_factory=dict)
    collected_at: datetime | None = None
    version: str = LISTING_SOCIAL_VERSION
    unavailable_reason: str | None = None

    @property
    def available(self) -> bool:
        return self.unavailable_reason is None and self.posts_total > 0


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def sentiment_of(text: str) -> float:
    """Lexicon sentiment for one post, -1..1.

    Negation flips the polarity of the next three tokens, which is what makes
    "not a rug" and "rug" land on opposite sides — the single most common
    failure of a bag-of-words score on this vocabulary.
    """
    lowered = _URL.sub(" ", text.lower())
    hits = 0.0
    count = 0

    for phrase in _BULLISH_PHRASES:
        occurrences = lowered.count(phrase)
        if occurrences:
            hits += 1.5 * occurrences
            count += occurrences
    for phrase in _BEARISH_PHRASES:
        occurrences = lowered.count(phrase)
        if occurrences:
            hits -= 1.5 * occurrences
            count += occurrences

    words = _tokens(lowered)
    negate_until = -1
    multiplier = 1.0
    for index, word in enumerate(words):
        if word in _NEGATORS:
            negate_until = index + 3
            continue
        if word in _INTENSIFIERS:
            multiplier = 1.5
            continue

        polarity = 0.0
        if word in _BULLISH_WORDS:
            polarity = 1.0
        elif word in _BEARISH_WORDS:
            polarity = -1.0
        if polarity == 0.0:
            continue

        if index <= negate_until:
            polarity = -polarity
        hits += polarity * multiplier
        multiplier = 1.0
        count += 1

    if count == 0:
        return 0.0
    # Divide by sqrt(count) rather than count: a post making the same point
    # five ways is more confident than one making it once, but not 5x.
    return max(-1.0, min(1.0, hits / math.sqrt(count) / 1.5))


def is_spam(post: SocialPost, *, duplicate_texts: Counter[str] | None = None) -> bool:
    """Farm/shill detection. Conservative — a false positive costs one real
    post, a false negative lets a farm set the sentiment."""
    text = post.text or ""
    stripped = _MENTION.sub(" ", _URL.sub(" ", text))
    words = _tokens(stripped)

    if len(words) < _MIN_WORDS_FOR_CONTENT:
        return True
    if len(_MENTION.findall(text)) > _MAX_TAGS_BEFORE_SPAM:
        return True
    if len(_EMOJI.findall(text)) > _MAX_EMOJI_BEFORE_SPAM:
        return True
    # Brand-new/zero-reach accounts posting into a launch are the farm's
    # signature. Reach alone is not spam — reach plus no engagement is.
    if post.author_followers < 30 and post.engagement == 0:
        return True
    if duplicate_texts is not None:
        normalized = " ".join(words)
        if duplicate_texts.get(normalized, 0) > 2:
            return True
    return False


def _recency_weight(age_hours: float, half_life_hours: float) -> float:
    if age_hours < 0:
        age_hours = 0.0
    return 0.5 ** (age_hours / max(half_life_hours, 0.1))


def _reach_weight(post: SocialPost) -> float:
    """Log-scaled reach. Floored at 1 so a zero-engagement post from a real
    account still counts a little."""
    reach = post.author_followers + 5 * post.engagement
    return 1.0 + math.log10(1.0 + max(reach, 0))


def build_pulse(
    symbol: str,
    posts: list[SocialPost],
    *,
    now: datetime | None = None,
    half_life_hours: float = DEFAULT_HALF_LIFE_HOURS,
    window_hours: float = DEFAULT_WINDOW_HOURS,
    top_n: int = 8,
    unavailable_reason: str | None = None,
) -> SocialPulse:
    """Fold collected posts into one realtime read."""
    reference = now or datetime.now(UTC)

    if unavailable_reason is not None:
        return SocialPulse(
            symbol=symbol,
            sentiment=None,
            posts_total=0,
            posts_24h=0,
            posts_1h=0,
            velocity=None,
            spam_ratio=0.0,
            reach=0,
            bullish_share=None,
            bearish_share=None,
            collected_at=reference,
            unavailable_reason=unavailable_reason,
        )

    cutoff = reference - timedelta(hours=window_hours)
    fresh = [p for p in posts if p.created_at >= cutoff]
    if not fresh:
        return SocialPulse(
            symbol=symbol,
            sentiment=None,
            posts_total=0,
            posts_24h=0,
            posts_1h=0,
            velocity=None,
            spam_ratio=0.0,
            reach=0,
            bullish_share=None,
            bearish_share=None,
            collected_at=reference,
            unavailable_reason="no_recent_posts",
        )

    duplicates: Counter[str] = Counter(
        " ".join(_tokens(_MENTION.sub(" ", _URL.sub(" ", p.text or "")))) for p in fresh
    )

    scored: list[ScoredPost] = []
    for post in fresh:
        age_hours = (reference - post.created_at).total_seconds() / 3600.0
        spam = is_spam(post, duplicate_texts=duplicates)
        weight = _recency_weight(age_hours, half_life_hours) * _reach_weight(post)
        if spam:
            # Not zero: a wall of farm posts is itself weak evidence that
            # something is being promoted. But it must not set the tone.
            weight *= 0.05
        scored.append(
            ScoredPost(
                post=post,
                sentiment=sentiment_of(post.text or ""),
                weight=weight,
                is_spam=spam,
                age_hours=age_hours,
            )
        )

    total_weight = sum(s.weight for s in scored)
    sentiment = (
        sum(s.sentiment * s.weight for s in scored) / total_weight if total_weight > 0 else None
    )

    clean = [s for s in scored if not s.is_spam]
    opinionated = [s for s in clean if abs(s.sentiment) > 0.05]
    bullish_share = (
        len([s for s in opinionated if s.sentiment > 0]) / len(opinionated) if opinionated else None
    )
    bearish_share = (1.0 - bullish_share) if bullish_share is not None else None

    hour_ago = reference - timedelta(hours=1)
    day_ago = reference - timedelta(hours=24)
    six_ago = reference - timedelta(hours=6)
    posts_1h = len([s for s in scored if s.post.created_at >= hour_ago])
    posts_24h = len([s for s in scored if s.post.created_at >= day_ago])
    recent_6h = len([s for s in scored if s.post.created_at >= six_ago])

    baseline_per_hour = len(scored) / max(window_hours, 1.0)
    velocity = (recent_6h / 6.0) / baseline_per_hour if baseline_per_hour > 0 else None

    top = sorted(clean, key=lambda s: (-s.post.engagement, s.age_hours))[:top_n]

    return SocialPulse(
        symbol=symbol,
        sentiment=round(sentiment, 4) if sentiment is not None else None,
        posts_total=len(scored),
        posts_24h=posts_24h,
        posts_1h=posts_1h,
        velocity=round(velocity, 3) if velocity is not None else None,
        spam_ratio=round(len([s for s in scored if s.is_spam]) / len(scored), 3),
        reach=sum(s.post.author_followers for s in clean),
        bullish_share=round(bullish_share, 3) if bullish_share is not None else None,
        bearish_share=round(bearish_share, 3) if bearish_share is not None else None,
        top_posts=top,
        sources=dict(Counter(s.post.source for s in scored)),
        collected_at=reference,
    )
