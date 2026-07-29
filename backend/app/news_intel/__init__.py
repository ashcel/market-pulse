"""Market Pulse — News Intelligence Package

AI-powered news sentiment analysis layer. Reads headlines from the existing
token_event table (populated by the worker's event_pass), analyzes them via
DeepSeek Flash (or any OpenRouter-compatible LLM), and stores structured
sentiment snapshots.

Philosophy: the LLM narrates and tags, never originates signals. Sentiment
scores are evidence for the trader, not trading signals.
"""
