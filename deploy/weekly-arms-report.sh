#!/usr/bin/env bash
#
# The weekly forward-test arms report.
#
# Two stages, deliberately in this order:
#
#   1. The deterministic report. Pure stdlib, no LLM, no network beyond the
#      local database. This is the one that must not fail, and it is sent
#      before anything else runs.
#   2. The interpretation pass (Claude Code, headless). It reads the same
#      report and writes the analysis into the weekly document — expanding on
#      what moved, and proposing arm rotations for the next cycle.
#
# Stage 2 failing must never cost you stage 1, which is why the send happens
# in between rather than at the end. An LLM is allowed to be unavailable; the
# record is not.
#
# Note this runs LOCALLY, from the VPS, by cron. It cannot be a cloud agent:
# the Postgres it reads is bound to localhost:5435 inside docker.
#
set -uo pipefail

REPO="/home/ubuntu/code/personal/market-pulse"
BACKEND="$REPO/backend"
PYTHON="$BACKEND/.venv/bin/python"
TELEGRAM_TARGET="${ARMS_REPORT_TARGET:--1003758179732:662}"   # Milky Way HQ / Tradeway Alert
WEEK="$(date -u +%Y-W%V)"
OUTDIR="$REPO/research/weekly"
DOC="$OUTDIR/$WEEK.md"
LOG="/home/ubuntu/quant-logs/arms-report.log"

mkdir -p "$OUTDIR" "$(dirname "$LOG")"

log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

log "=== weekly arms report $WEEK ==="

# ── stage 1: the numbers ─────────────────────────────────────────────────────
cd "$BACKEND" || { log "FATAL: no $BACKEND"; exit 1; }

if ! "$PYTHON" -m app.research.arms_report --format markdown --out "$DOC" 2>>"$LOG"; then
    log "FATAL: report generation failed"
    hermes send --to "telegram:$TELEGRAM_TARGET" --quiet \
        "Forward-test arms report FAILED to generate for $WEEK. See $LOG." || true
    exit 1
fi
log "wrote $DOC"

SUMMARY="$("$PYTHON" -m app.research.arms_report --format telegram 2>>"$LOG")"
if [ -z "$SUMMARY" ]; then
    log "FATAL: empty summary"
    exit 1
fi

if hermes send --to "telegram:$TELEGRAM_TARGET" --quiet "$SUMMARY"; then
    log "sent summary to telegram:$TELEGRAM_TARGET"
else
    log "WARN: telegram delivery failed"
fi

# ── stage 2: the reading of them ─────────────────────────────────────────────
# Best-effort. Everything above has already shipped.
if ! command -v claude >/dev/null 2>&1; then
    log "claude not on PATH — skipping interpretation"
    exit 0
fi

PROMPT="Read $DOC — this week's forward-test arms report, already generated.

Then append a section '## Reading' to that same file covering:
1. What actually moved this week versus the cumulative picture, and whether the
   move is larger than the standard error shown. Say plainly when it is not.
2. Any arm at or near its gate, and what it would take to resolve it.
3. Whether a registered arm should be retired and what should take the slot,
   as a proposal with a stated hypothesis and a pre-registered gate. Do not
   edit engine/smc/arms.py — the registry changes only by a human decision
   recorded as an EDR.

Rules: no promotion, no config change, no commit, no push. Segment by engine
version. Do not treat a difference inside its confidence interval as a finding.
If nothing this week is distinguishable from noise, say exactly that and stop —
a short honest section is the correct output most weeks."

log "starting interpretation pass"
if claude -p "$PROMPT" --permission-mode acceptEdits >>"$LOG" 2>&1; then
    log "interpretation appended"
    TAIL="$(sed -n '/^## Reading/,$p' "$DOC" | head -c 3000)"
    [ -n "$TAIL" ] && hermes send --to "telegram:$TELEGRAM_TARGET" --quiet \
        --subject "[arms $WEEK] reading" "$TAIL"
else
    log "WARN: interpretation pass failed — deterministic report already sent"
fi

log "=== done ==="
