"""ForexFactory economic-calendar normalization — pins the parser against a
fixture in the real feed shape: impact lowercasing, ET→UTC date conversion,
empty forecast/previous handling, dedup-key stability, and shape-surprise."""

from smc.econ_events import EconEventInput, normalize_forexfactory_events

# Real payload shape (keys verified against the live feed 2026-07-22): a flat
# list of objects with title/country/date/impact/forecast/previous. ``country``
# is a currency code; ``date`` carries a US-Eastern offset.
FIXTURE = [
    {
        "title": "Core CPI m/m",
        "country": "USD",
        "date": "2026-07-19T18:45:00-04:00",
        "impact": "High",
        "forecast": "0.3%",
        "previous": "0.2%",
    },
    {
        "title": "Bank Holiday",
        "country": "JPY",
        "date": "2026-07-19T19:00:00-04:00",
        "impact": "Holiday",
        "forecast": "",
        "previous": "",
    },
    {
        "title": "Trade Balance",
        "country": "NZD",
        "date": "2026-07-20T00:00:00-04:00",
        "impact": "Low",
        "forecast": "250M",
        "previous": "800M",
    },
]


def test_normalizes_all_valid_rows() -> None:
    events = normalize_forexfactory_events(FIXTURE)
    assert len(events) == 3
    assert all(isinstance(e, EconEventInput) for e in events)


def test_impact_is_lowercased_and_mapped() -> None:
    events = normalize_forexfactory_events(FIXTURE)
    by_title = {e.title: e for e in events}
    assert by_title["Core CPI m/m"].impact == "high"
    assert by_title["Bank Holiday"].impact == "holiday"
    assert by_title["Trade Balance"].impact == "low"


def test_unknown_impact_falls_back_to_low() -> None:
    events = normalize_forexfactory_events(
        [{"title": "Speech", "country": "USD", "date": "2026-07-19T12:00:00-04:00", "impact": "?"}]
    )
    assert events[0].impact == "low"


def test_date_converted_to_utc_z() -> None:
    events = normalize_forexfactory_events(FIXTURE)
    cpi = next(e for e in events if e.title == "Core CPI m/m")
    # 18:45 ET (-04:00) → 22:45 UTC.
    assert cpi.occurs_at == "2026-07-19T22:45:00.000Z"


def test_empty_forecast_previous_become_none() -> None:
    events = normalize_forexfactory_events(FIXTURE)
    hol = next(e for e in events if e.title == "Bank Holiday")
    assert hol.forecast is None
    assert hol.previous is None
    cpi = next(e for e in events if e.title == "Core CPI m/m")
    assert cpi.forecast == "0.3%"
    assert cpi.previous == "0.2%"


def test_dedup_key_stable_and_uses_raw_date() -> None:
    a = normalize_forexfactory_events(FIXTURE)[0]
    b = normalize_forexfactory_events(FIXTURE)[0]
    assert a.dedup_key == b.dedup_key
    assert a.dedup_key == "forexfactory:USD:Core CPI m/m:2026-07-19T18:45:00-04:00"


def test_dedup_key_distinguishes_country_title_date() -> None:
    keys = {e.dedup_key for e in normalize_forexfactory_events(FIXTURE)}
    assert len(keys) == 3


def test_custom_source_flows_into_key_and_field() -> None:
    events = normalize_forexfactory_events(FIXTURE, source="ff-next")
    assert all(e.source == "ff-next" for e in events)
    assert events[0].dedup_key.startswith("ff-next:")


def test_rows_missing_required_fields_are_skipped_not_fatal() -> None:
    payload = [
        {"country": "USD", "date": "2026-07-19T12:00:00-04:00", "impact": "High"},  # no title
        {"title": "No country", "date": "2026-07-19T12:00:00-04:00", "impact": "High"},
        {"title": "Bad date", "country": "USD", "date": "not-a-date", "impact": "High"},
        {
            "title": "Good",
            "country": "EUR",
            "date": "2026-07-19T12:00:00-04:00",
            "impact": "Medium",
        },
    ]
    events = normalize_forexfactory_events(payload)
    assert len(events) == 1
    assert events[0].title == "Good"
    assert events[0].impact == "medium"


def test_shape_surprise_returns_empty() -> None:
    assert normalize_forexfactory_events({"not": "a list"}) == []
    assert normalize_forexfactory_events(None) == []
    assert normalize_forexfactory_events("") == []
