# Delegation protocol — HARD RULE

**The daily agent is a reviewer and orchestrator, not a coder.** All
implementation work — product code, tests, migrations, docs, EDRs — is
delegated to an installed coding tool. The agent's own hands touch only:

- review artifacts (review notes, accept/hold decisions),
- plan bookkeeping (`milestones/*` checkboxes, `PROGRESS.md`),
- git operations (snapshot, commit, revert),
- verification commands (test/typecheck/lint/DoD checks).

If every tool in the roster fails on a task, the agent **flags the user in
`PROGRESS.md` and stops that task**. It does not implement the task itself.
No exceptions — a "quick fix" written by the reviewer is the failure mode
this rule exists to prevent (reviewer and author must stay separate).

## Tool roster (ranked)

Try in this order. Rank 1 is the default implementer for every task; move
down the list only on a delegation failure (defined below).

| Rank | Tool        | Invocation sketch                             | Notes                          |
| ---- | ----------- | --------------------------------------------- | ------------------------------ |
| 1    | Claude Code | `claude -p "<brief>" --dangerously-skip-permissions` | ✅ v2.1.209, headless works   |
| 2    | Codex       | `codex exec --sandbox danger-full-access "<brief>"` | ✅ v0.139.0, sandbox works   |
| 3    | Antigravity | `agy -p "<brief>" --dangerously-skip-permissions` | ✅ v1.1.2, headless works    |

- Verify exact invocation flags against each tool's `--help` on first use and
  record the working command lines here (edit this table in place).
- Ranking = quality first, then usage: if a tool is out of quota / rate
  limited, skip to the next and note it; return to the higher-ranked tool the
  next day.
- The user may reorder this table at any time; the table is the law.

## Delegation failure (move to next tool when ANY of these)

1. Tool not installed / not authenticated / CLI errors before doing work.
2. Usage or rate limit reached.
3. Produces no diff, or a diff unrelated to the brief.
4. Two consecutive **hold-for-revise** verdicts on the same task (the tool
   isn't converging — hand the task and both review notes to the next tool).

Log every failure + switch in `PROGRESS.md` (tool, reason, one line).

## Per-task loop

```
1. SNAPSHOT   — require clean tree; record `git rev-parse HEAD`.
2. BRIEF      — write the task brief (template below) to
                milestones/briefs/<task-id>.md; it is the tool's only spec.
3. DELEGATE   — invoke rank-1 tool with the brief. On delegation failure,
                next tool per the table.
4. REVIEW     — the agent itself, always (never delegated):
                a. read the full diff (`git diff`) — every hunk;
                b. run `bunx vitest run`, `bunx tsc --noEmit`, `bun run lint`;
                c. check the task's DoD line by line;
                d. check the guardrails (milestones/README.md) — engine
                   semantics untouched, no outcome peeking, R rule, SSE-only,
                   user-scoped tables, no plaintext secrets;
                e. check fit: matches surrounding code style, no scope creep,
                   no drive-by edits outside the brief.
5. VERDICT    — exactly one of:
                ACCEPT — commit with a conventional message; note the
                         implementing tool in the commit body
                         (e.g. "Implemented-by: claude-code").
                HOLD   — write review notes (what fails, where, expected vs
                         actual) into the brief file; re-delegate to the SAME
                         tool with brief + notes. Max 2 holds per tool.
                REJECT — after the roster is exhausted: restore the snapshot
                         (`git checkout -- . && git clean -fd` back to the
                         recorded HEAD), flag the user, stop the task.
6. LOG        — PROGRESS.md entry (format in PROGRESS.md) including tool,
                attempt count, verdict trail.
```

Rules that make the loop safe on a production tree:

- **Never delegate onto a dirty tree.** One task's changes are the only
  uncommitted delta at any moment; revert is then always clean.
- **Never end the day mid-hold.** Either the revision lands and is ACCEPTed,
  or restore the snapshot and log HOLD-carryover so tomorrow re-delegates
  from a clean state with the notes.
- **The agent never edits the implementer's diff.** If it's one line short
  of acceptable, that's a HOLD with a one-line note — not a touch-up.

## Brief template (`milestones/briefs/<task-id>.md`)

```markdown
# <task-id> — <task title>

## Context
<2–5 lines: what milestone this serves, what exists already, file pointers>

## Task
<the milestone file's task text, expanded to be self-sufficient — the tool
 has no access to this conversation>

## Definition of Done
<copied verbatim from the milestone file, plus any concrete file paths>

## Constraints (always include; copy, don't reference)
- Do NOT modify src/lib/engine decision/trigger semantics or ENGINE_VERSION.
- Do NOT read 1.0.0 shadow-record outcomes (record:report --integrity only).
- SSE only, no WebSocket server endpoints. No src/server imports in client code.
- Migrations: hand-written SQL, next number in src/server/db/migrations/.
- New tables user-scoped (user_id FK). No plaintext secrets in DB or logs.
- R metrics only where a stop order is evidenced; else % / MAE-MFE.
- Match existing code style; tests colocated *.test.ts; do not touch
  routeTree.gen.ts; do not add packages without flagging (24h supply guard).
- Do not commit. Leave changes in the working tree for review.

## Review notes from previous attempt
<empty on first attempt; appended by the agent on HOLD>
```

## Verification of this protocol (one-time, before M0-T1)

- [x] **D-T0 — Tool availability check.** Run each roster tool's version/auth
      check; record working invocation lines in the table above; do a dry-run
      delegation of a no-op task (e.g. "add a code comment to
      milestones/briefs/dry-run.md") through the full loop, then revert it.
      *DoD:* all three tools' status recorded; the loop exercised end-to-end
      once, incl. a forced HOLD and a snapshot restore.
