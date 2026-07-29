You are executing R4-T2: Read-only audit of every PnL/R/excursion/win-rate consumer and stop-evidence coverage in the sync path for Market Pulse.

What to audit:
1. Every PnL, R-multiple, excursion, and win-rate consumer in:
   - backend/app/review/analytics.py
   - backend/app/binance_review/ (models, enrichment, service, schemas)
   - backend/app/worker/binance.py (sync path)
   - backend/app/execution/
   - frontend/src/routes/review.tsx + review-panel components
   - frontend/src/lib/review/ (BYOK memo)
   - frontend/src/hooks/useReview.ts

2. Stop-evidence coverage audit: Where is R computed? Is it always gated on stop_loss IS NOT NULL?

3. Write findings to docs/review/R4-T2-audit-findings.md

Hard constraints: NO code changes, NO git ops, NO systemctl/migrations. Read-only audit.
