"""Social pulse — sentiment, spam discounting, recency decay.

The behaviour worth protecting is that a farm cannot set the tone: a thousand
identical zero-follower posts must not read as bullish conviction.
"""

from datetime import UTC, datetime, timedelta

from smc.listing_social import (
    SocialPost,
    build_pulse,
    is_spam,
    sentiment_of,
)

NOW = datetime(2026, 8, 15, 12, 0, tzinfo=UTC)


def post(
    text: str,
    *,
    minutes_ago: int = 10,
    followers: int = 5_000,
    likes: int = 20,
    reposts: int = 3,
    replies: int = 2,
    identifier: str = "1",
) -> SocialPost:
    return SocialPost(
        id=identifier,
        source="x",
        text=text,
        created_at=NOW - timedelta(minutes=minutes_ago),
        author=f"user{identifier}",
        author_followers=followers,
        likes=likes,
        reposts=reposts,
        replies=replies,
    )


class TestSentiment:
    def test_bullish_and_bearish_language_separate(self) -> None:
        assert sentiment_of("this is bullish, accumulating here") > 0
        assert sentiment_of("total scam, team dumping on us") < 0

    def test_negation_flips_polarity(self) -> None:
        """The single most common failure of a bag-of-words score on this
        vocabulary."""
        assert sentiment_of("this is a rug") < 0
        assert sentiment_of("this is not a rug") > sentiment_of("this is a rug")

    def test_neutral_text_scores_zero(self) -> None:
        assert sentiment_of("The token contract was deployed on Tuesday.") == 0.0

    def test_output_is_bounded(self) -> None:
        shouted = "moon pump bullish ape send it " * 20
        assert -1.0 <= sentiment_of(shouted) <= 1.0

    def test_multiword_phrases_are_read(self) -> None:
        assert sentiment_of("this is exit liquidity") < 0
        assert sentiment_of("buying the dip here") > 0


class TestSpam:
    def test_short_content_is_spam(self) -> None:
        assert is_spam(post("gm"))

    def test_tag_stuffing_is_spam(self) -> None:
        assert is_spam(post("great project #a #b #c #d #e #f @g @h check it out now"))

    def test_emoji_wall_is_spam(self) -> None:
        assert is_spam(post("this is going up 🚀🚀🚀🚀🚀🚀🚀🚀 big news soon"))

    def test_zero_reach_zero_engagement_is_spam(self) -> None:
        assert is_spam(post("this project looks solid to me", followers=3, likes=0, reposts=0, replies=0))

    def test_a_real_post_is_not_spam(self) -> None:
        assert not is_spam(post("Liquidity looks thin but the holder spread is healthy so far"))

    def test_duplicate_text_is_spam(self) -> None:
        from collections import Counter

        text = "amazing project going to the moon soon"
        duplicates = Counter({" ".join(text.split()): 5})
        assert is_spam(post(text), duplicate_texts=duplicates)


class TestPulse:
    def test_farm_posts_cannot_set_the_sentiment(self) -> None:
        """A wall of identical zero-follower hype against one substantive
        bearish post from a real account."""
        farm = [
            post("moon soon 🚀🚀🚀🚀🚀🚀🚀🚀", followers=2, likes=0, reposts=0, replies=0, identifier=str(i))
            for i in range(40)
        ]
        real = post(
            "Top wallets hold most of the supply here, this looks like exit liquidity to me",
            followers=80_000,
            likes=900,
            reposts=200,
            identifier="real",
        )
        pulse = build_pulse("TEST", [*farm, real], now=NOW)

        assert pulse.spam_ratio > 0.9
        assert pulse.sentiment is not None
        assert pulse.sentiment < 0

    def test_recency_decay_favours_newer_posts(self) -> None:
        old_bull = post("extremely bullish, accumulating", minutes_ago=48 * 60 - 30, identifier="old")
        new_bear = post("this is a scam, getting out", minutes_ago=5, identifier="new")
        pulse = build_pulse("TEST", [old_bull, new_bear], now=NOW)
        assert pulse.sentiment is not None
        assert pulse.sentiment < 0

    def test_posts_outside_the_window_are_dropped(self) -> None:
        stale = post("bullish", minutes_ago=60 * 24 * 10, identifier="stale")
        pulse = build_pulse("TEST", [stale], now=NOW)
        assert pulse.unavailable_reason == "no_recent_posts"
        assert pulse.available is False

    def test_unavailable_reason_short_circuits(self) -> None:
        pulse = build_pulse("TEST", [], unavailable_reason="no_x_bearer_token", now=NOW)
        assert pulse.unavailable_reason == "no_x_bearer_token"
        assert pulse.sentiment is None
        assert pulse.available is False

    def test_counts_and_velocity(self) -> None:
        posts = [
            post("solid project holding here", minutes_ago=30, identifier="a"),
            post("looks strong, buying more", minutes_ago=90, identifier="b"),
            post("bullish on this one long term", minutes_ago=60 * 30, identifier="c"),
        ]
        pulse = build_pulse("TEST", posts, now=NOW)
        assert pulse.posts_total == 3
        assert pulse.posts_1h == 1
        assert pulse.posts_24h == 2
        assert pulse.velocity is not None

    def test_top_posts_exclude_spam_and_rank_by_engagement(self) -> None:
        loud = post("gm", likes=99_999, identifier="spam")
        good = post("Holder distribution here is unusually clean for a new listing",
                    likes=500, identifier="good")
        quiet = post("Seems fine, watching the liquidity for now", likes=5, identifier="quiet")
        pulse = build_pulse("TEST", [loud, good, quiet], now=NOW)

        top_ids = [scored.post.id for scored in pulse.top_posts]
        assert "spam" not in top_ids
        assert top_ids[0] == "good"

    def test_bullish_and_bearish_shares_sum_to_one(self) -> None:
        posts = [
            post("very bullish accumulating hard", identifier="a"),
            post("this is a scam avoid this", identifier="b"),
            post("bullish long term conviction", identifier="c"),
        ]
        pulse = build_pulse("TEST", posts, now=NOW)
        assert pulse.bullish_share is not None and pulse.bearish_share is not None
        assert abs(pulse.bullish_share + pulse.bearish_share - 1.0) < 1e-9
