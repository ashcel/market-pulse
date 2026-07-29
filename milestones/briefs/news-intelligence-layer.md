# News Intelligence & AI Sentiment Layer

**Objective:** Add market sentiment from news interpreted by AI (DeepSeek Flash), and an automated AI layer that actually reads and interprets news headlines — not just keyword regex.

## Architecture

```
RSS Sources (6+ existing)
     ↓
event_pass.py (existing — ingests headlines into token_event table)
     ↓
sentiment_pass.py (NEW — every 30min)
     ↓  calls DeepSeek Flash via OpenRouter
  News Sentiment Snapshot (sentiment_snapshot table)
     ↓
  /api/v1/sentiment/* (NEW — serves data to frontend)
     ↓
  Sentiment Dashboard (frontend — new components + hooks)
```

## Layer 1 — Python Backend

### 1.1 Alembic migration: `sentiment_snapshot` table
Stores one row per AI analysis run.

### 1.2 LLM Client (`backend/app/news_intel/llm_client.py`)
- HTTP client for OpenRouter API (DeepSeek Flash)
- Configurable via settings: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`
- Sends headlines in batches, returns parsed JSON

### 1.3 Sentiment Pass (`backend/app/worker/sentiment_pass.py`)
- Runs inside worker loop every ~30 min
- Collects recent headlines from `token_event` (last 24-48h)
- Batches them (headlines + descriptions) into LLM prompt
- Prompts DeepSeek Flash to return structured sentiment:
  - Per-asset sentiment (ticker → bullish/bearish/neutral + confidence + reason)
  - Aggregate market sentiment (overall score, description)
  - Key narratives/themes
  - AI brief (2-3 sentence summary)
- Stores result in `sentiment_snapshot`

### 1.4 Prompt Design
System prompt: "You are a crypto market sentiment analyst. Analyze these news headlines and return structured JSON."
Response format: strict JSON with asset_sentiments map, market_sentiment aggregate, key_narratives, brief.

### 1.5 API Router (`backend/app/news_intel/`)
- `GET /api/v1/sentiment/current` — Latest snapshot with per-asset breakdown
- `GET /api/v1/sentiment/history` — Timeline of recent snapshots (for charts)
- `GET /api/v1/sentiment/news-brief` — Latest AI brief text

### 1.6 Config
Add to `Config`: `LLM_API_KEY`, `LLM_BASE_URL` (default: OpenRouter), `LLM_MODEL` (default: deepseek/deepseek-v4-flash)

## Layer 2 — Frontend

### 2.1 Types
Expand `SentimentData` or create `AiSentiment` type with per-asset breakdown.

### 2.2 Hooks
- `useAiSentiment()` → fetches from backend `/api/v1/sentiment/current`
- `useSentimentHistory()` → chart timeline

### 2.3 Components
- `ai-market-brief.tsx` — AI-generated news brief card
- `sentiment-asset-breakdown.tsx` — Per-asset sentiment table/grid
- `sentiment-gauge.tsx` — Market-wide sentiment gauge

### 2.4 Integration
- Add "Sentiment" section to dashboard or News tab
- Show per-asset sentiment on token pages

## Order of Implementation

1. DB migration (alembic)
2. LLM client utility
3. Sentiment worker pass
4. API router
5. Register in main.py + passes.py
6. Frontend types + hooks
7. Frontend components
