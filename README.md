# agent-bench

Milestone benchmark recorder for the agent framework comparison.
Tracks time, turns, interventions, token usage, checklist results, and qualitative scores across multiple agent frameworks running the same project.

Zero dependencies. Plain Node.js. Data stored globally in `~/.bench/`.

---

## Setup

```bash
chmod +x bench.js

# Add to your shell profile (~/.zshrc, ~/.bashrc, etc.):
alias bench="node /path/to/bench.js"
```

Run from any repo or worktree — data is written to `~/.bench/` regardless of where you invoke it.

## Parallel runs

Multiple agent runs can be active simultaneously. Active run state is keyed by `cwd` hash, so each worktree has its own independent state file. Run `bench start`, `bench log`, `bench intervene`, etc. from within each worktree and they automatically operate on the right run — no flags needed.

```bash
# Terminal 1 — in /projects/thing-claude-code
bench start "Claude Code" M2
bench log

# Terminal 2 — in /projects/thing-cursor (simultaneously)
bench start "Cursor" M2
bench log
```

`bench status` (from any directory) lists all currently active runs across all worktrees.

The only constraint: **one active run per worktree** at a time, since two agents in the same directory would be overwriting the state file that's tracking runs.

### Optional: project config

If a project has clearly ID'd and defined milestones, they can be encoded in a `projects.json` file
that the `bench` tool will use to add task metadata to the state file.

Copy the sample `projects.json` to `~/.bench/projects.json` to get automatic checklist prompts at `bench end`. The `pathRegex` is matched against `process.cwd()` at `bench start` time — if it matches, that project's milestone definitions are loaded automatically.

```json
{
  "projects": [
    {
      "name": "My Project",
      "pathRegex": "my-project",
      "milestones": {
        "M1": {
          "name": "Auth module",
          "checklist": [
            "Login flow works end to end",
            "Token refresh handled correctly"
          ]
        }
      }
    }
  ]
}
```

If no `projects.json` exists, or the current path doesn't match any project, or the milestone ID has no definition, `bench end` falls back to freeform checklist entry — type each item you verified, blank line to finish.

---

## Workflow

```bash
# 1. Start a milestone run (captures git branch + worktree automatically)
bench start "Claude Code" M2

# 2. After each agent response
bench log

# 2a. When you step away (grab coffee, lunch, etc) — time is excluded from duration
bench pause   # pause
bench pause  # resume

# 3. When you have to step in and correct something
bench intervene "Had to fix Unistyles v3 syntax — agent used v2 API"

# 4. When the agent reports token usage (call once per agent session)
#    If a milestone spans multiple sessions, call this multiple times — totals accumulate
#    Use --in for input tokens, --out for output tokens, --all for combined total
bench tokens --in 12000
bench tokens --out 800
bench tokens --all 45000

# 5. Close the run — walks through the done-when checklist then qualitative scores
bench end

# 6. View results
bench report

# 7. Export to CSV for spreadsheet analysis
bench export
```

---

## Commands

| Command | Description |
|---|---|
| `bench start <agent> <milestone>` | Begin a milestone run |
| `bench end` | Close active run — interactive checklist + 7 qualitative scores |
| `bench log` | Record one agent turn/message |
| `bench pause` | Toggle pause/resume — excludes time from duration |
| `bench intervene "<note>"` | Record a human intervention with timestamp |
| `bench tokens --in <n> \| --out <n> \| --all <n>` | Record token usage — call once per agent session |
| `bench status` | Show active run details |
| `bench report` | Summary table of all completed runs |
| `bench export` | Write CSV to `~/.bench/exports/` |

---

## Milestone IDs

Any string is valid — `M2`, `auth-module`, `SPRINT-4`, `phase-1`. Milestone IDs are matched against definitions in `~/.bench/projects.json` to load checklists automatically. If no definition is found the ID is still recorded, and `bench end` prompts for freeform checklist items.

---

## Multiple agent sessions per milestone

If a milestone requires more than one agent session (e.g. context window ran out mid-task), just call `bench tokens` again for each session. Totals accumulate correctly and the report shows how many token recordings contributed to the total:

```
Tokens: 45.3k  (3 token recordings)
```

---

## What gets recorded

**Automatic** (no discipline required):
- Wall clock duration
- Git branch and worktree path at start time
- Repo name (extracted from git remote)

**One command per event:**
- `bench log` — turn/message count
- `bench pause` — toggle pause/resume (time away is excluded from duration)
- `bench intervene` — timestamped intervention log
- `bench tokens` — token counts, accumulated across sessions

**Interactive at `bench end`:**
- Done-when checklist (Y/n/skip per item) (optionally supplied in `projects.json`)
- 7 qualitative scores (1–5):
  - Spec adherence — followed the design doc, UI spec, and theme file?
  - Theme file usage — used your `theme.ts` or hardcoded values?
  - Code quality — readable, well-typed, sensible state management?
  - Autonomy — completed without hand-holding?
  - Hallucination — invented APIs, wrong versions, confident wrongness?
  - Legibility for next agent — would another agent build on this easily?
  - Overall satisfaction — how did it feel to work with this agent?
- Free-form notes (one line)

---

## Data

All runs appended to `~/.bench/all-runs.jsonl` — one JSON object per line.
Individual run files at `~/.bench/<agent-slug>/<milestone>.json`.
CSV exports at `~/.bench/exports/export-<timestamp>.csv`.

### Run object schema

```json
{
  "agent": "opencode",
  "milestone": "M1",
  "milestoneName": "Settings Screen",
  "projectName": "Claudia",
  "startTime": 1773125260456,
  "startTs": "2026-03-10T06:47:40.456Z",
  "worktree": "/path/to/project",
  "branch": "claudia-codex",
  "repo": "pandeiro/Claudia",
  "endTime": 1773129063616,
  "endTs": "2026-03-10T07:51:03.617Z",
  "durationMs": 3803160,
  "activeDurationMs": 3500000,
  "totalPauseMs": 303160,
  "turns": 0,
  "interventions": [{ "ts": "2026-03-10T07:05:45.853Z", "note": "..." }],
  "pauses": [{ "startTs": "...", "endTs": "...", "durationMs": 303160 }],
  "tokenLog": [
    { "ts": "2026-03-10T06:48:21.354Z", "in": 36000, "out": 258000 },
    { "ts": "2026-03-10T07:50:13.273Z", "in": 114000, "out": 0 },
    { "ts": "2026-03-10T07:50:45.000Z", "total": 45000 }
  ],
  "totalTokensIn": 150000,
  "totalTokensOut": 258000,
  "totalTokens": 45000,
  "checklistResults": { "App launches without errors": "pass", ... },
  "qualitative": { "specAdherence": 4, "themeUsage": 4, ... },
  "notes": "needed a hand",
  "status": "complete",
  "checklistSummary": { "passed": 1, "failed": 0, "skipped": 6, "total": 7 }
}
```

**Token fields:**
- `tokenLog` — array of token recording sessions
- `totalTokensIn` — sum of all `--in` values recorded
- `totalTokensOut` — sum of all `--out` values recorded
- `totalTokens` — sum of all `--all` (combined) values recorded
- Report and status display the combined total: `totalTokensIn + totalTokensOut + totalTokens`

**Pause fields:**
- `pauses` — array of pause sessions: `[{ startTs, endTs, durationMs }]`
- `currentPauseStart` — timestamp when pause started (present if currently paused)
- `activeDurationMs` — wall clock time minus pause time (actual agent working time)
- `totalPauseMs` — sum of all pause durations

