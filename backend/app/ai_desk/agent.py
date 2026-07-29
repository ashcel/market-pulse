"""LangChain agent setup for AI Desk Review."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

from app.config import settings

from .tools import TOOLS

SYSTEM_PROMPT = """You are the **AI Desk Review** for Market Pulse, a crypto trading intelligence platform.

**Your role:** Answer questions about the market, today's events, sentiment, positions, and anything a trader needs to understand "what happened today."

**Always be concise** — traders want brief, actionable answers.

**Tool use:**
- Use `read_chart` for price data and technical structure of any asset.
- Use `query_db` for market sentiment, events, positions, or recent trades from the database.
- Use `search_web` to find recent news when the user asks about current events or news.
- Use `read_sentiment` for the latest AI-powered market sentiment analysis.
- Use `analyze_positions` when reviewing a whole portfolio — pass the positions as a JSON array and it returns charts for every symbol plus sentiment and events in one call. Prefer it over calling `read_chart` once per symbol.

**When asked to analyze open positions / portfolio:**
1. Call `analyze_positions` with the positions given to you (JSON array).
2. Call `search_web` for news on the largest or riskiest holdings.
3. For each position give: current price vs entry, trend read, and one clear action — **hold**, **close**, or **adjust stop** — with a one-line reason.
4. Close with a short portfolio-level note (concentration, net direction, leverage risk).

**When asked "what happened today" or "market update":**
1. Call `read_sentiment()` for the AI brief
2. Call `query_db("events today")` for recent headlines
3. Call `read_chart("BTC", "1d")` for Bitcoin price context
4. Call `search_web("crypto market today")` for web news
5. Synthesize into a 3-4 sentence brief covering: price action, sentiment, key events, notable news

**Rules:**
- Never make up data. If a tool fails or returns nothing, say so.
- Use tools in parallel when they don't depend on each other.
- Format prices with $ and commas (e.g. $65,432).
- Format percentages with + or - sign (e.g. +2.3%).
- If you don't know something, use a tool to find out — don't guess.
"""


def build_agent() -> Any:
    """Build and return a LangChain agent executor."""
    # ChatOpenAI requires a non-empty key, but Zen rejects Authorization.
    from httpx import AsyncClient, Auth, Client

    class _NoAuth(Auth):
        def auth_flow(self, request):
            request.headers.pop("authorization", None)
            yield request

    no_auth = _NoAuth()

    llm = ChatOpenAI(
        base_url=settings.LLM_BASE_URL,
        model=settings.LLM_MODEL,
        api_key="zen-free",
        http_client=Client(auth=no_auth),
        http_async_client=AsyncClient(auth=no_auth),
        temperature=0.3,
        max_tokens=2000,
    )

    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", SYSTEM_PROMPT),
            MessagesPlaceholder(variable_name="history"),
            ("human", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad"),
        ]
    )

    from langchain_classic.agents import AgentExecutor, create_tool_calling_agent

    agent = create_tool_calling_agent(llm, TOOLS, prompt)
    executor = AgentExecutor(
        agent=agent,
        tools=TOOLS,
        verbose=False,
        max_iterations=8,
        handle_parsing_errors=True,
    )
    return executor


def format_history(history: list[dict]) -> list:
    """Convert conversation history dict to LangChain message list."""
    messages = []
    for msg in history:
        if msg["role"] == "user":
            messages.append(HumanMessage(content=msg["content"]))
        elif msg["role"] == "assistant":
            messages.append(AIMessage(content=msg["content"]))
    return messages
