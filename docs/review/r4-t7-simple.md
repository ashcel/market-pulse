Complete R4-T7: Grounded per-trade AI memo + groundedness check for Market Pulse.

Read these files first:
- docs/forensics-definitions.md
- docs/decisions/0023-forensics-measurement-boundary.md
- backend/app/review/forensics.py
- backend/app/review/forensics_service.py
- frontend/src/lib/review/prompt.ts
- frontend/src/lib/review/generate.ts

1. Create backend/app/review/groundedness.py:
- Function check_memo(memo_text, forensics) that extracts numbers from memo
- Checks each claim against forensics fields
- Returns list of unsupported claims or empty list

2. Modify frontend/src/lib/review/prompt.ts:
- Add forensics param to prompt builder
- Include MAE/MFE/efficiency/discipline when available
- Add instruction to only cite existing numbers

3. In review-panel.tsx:
- After AI review, show amber warning for unsupported claims

Run: cd frontend && bun run build
