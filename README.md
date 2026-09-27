# Hermes Cron Cost

See what each Hermes cron job actually costs you. It's a small, read-only CLI that reads your local Hermes data and prints tokens and cost for each cron job.

**Documentation and compatibility:** [hermesagentai.org/cron-cost](https://www.hermesagentai.org/cron-cost) is the canonical documentation and Hermes-version compatibility page for Hermes Cron Cost.

```bash
npx @hermesagentai/cron-cost
```

Requires Node.js 22.18 or newer. Run it on the machine where Hermes stores its data.

```
Hermes Cron Cost

Profile default · ~/.hermes
Last 30 days (Aug 27, 2026 – Sep 26, 2026)
Analyzed 117 / 119 observed cron runs (98.3% had attributable usage data)

JOB               RUNS  OK  FAIL  INPUT  OUTPUT  AVG TOKENS  AVG COST  TOTAL COST
Morning AI Brief    29  28     1   870k     61k      42,110    ~$0.19      ~$5.51
GitHub Monitor      89  85     4   679k     44k       8,304    ~$0.04     ~$3.36*
Weekly Research      1   1     0   100k     11k     111,402  included    included
RUNS = finished executions or surviving sessions, whichever is larger (they are not paired per run).
AVG columns use only runs with usage (tokens) or fully known cost (cost).

Measured cost: ~$8.87*  (~ = Hermes estimate from its pricing data)
1 run used subscription-included routes (no per-call invoice; those calls count as $0).

2 runs could not be analyzed:
- 2 had an execution record but no surviving Hermes session

* 3 analyzed runs had tokens Hermes could not price; their tokens are counted, their cost is not.
```

(The sample above comes from fixture data.) In it, GitHub Monitor has 89 finished executions but only 87 surviving sessions. RUNS shows the 89 observed runs, which matches OK + FAIL. The token and cost averages come only from the 87 sessions that have usage data.

| Column | Meaning |
| --- | --- |
| `RUNS` | Observed finished runs in the window: completed + failed + unknown executions, or surviving cron sessions if there are more of those. Claimed or running executions are not counted. If there is no `executions.db`, it is the number of surviving sessions. |
| `OK` / `FAIL` | Completed and failed executions from `executions.db`. |
| `INPUT` / `OUTPUT` / `AVG TOKENS` | From runs with usage accounting only. |
| `AVG COST` | From runs whose cost is fully known only. |

## Options

| Option | Meaning |
| --- | --- |
| `--days <n>` | Analysis window. Default `30`. A run belongs to the window if its session started inside it. |
| `--profile <name>` | Analyze a named Hermes profile. `default` is the root profile. |
| `--json` | Print the same report as JSON, including every population count, the coverage gaps and the status of each data source. |
| `--help`, `--version` | |

If you pass no `--profile`, the tool picks the profile the way Hermes does. It uses `HERMES_HOME` if that is set. Otherwise it uses the sticky `<root>/active_profile`, and falls back to the default profile.

## What it reads

The tool analyzes a profile home. That is `~/.hermes` for the default profile and `~/.hermes/profiles/<name>` for a named one. It also honors `HERMES_HOME`, `HERMES_DATA_DIR_SUFFIX` and `%LOCALAPPDATA%\hermes` on Windows.

| File | Used for |
| --- | --- |
| `state.db` → `sessions` | Cron sessions and their lineage (`id`, `source`, `parent_session_id`, `end_reason`, lineage markers in `model_config`), plus aggregate token and cost columns |
| `state.db` → `session_model_usage` | Per-model and per-task tokens, `estimated_cost_usd`, `actual_cost_usd`, `cost_status` |
| `cron/executions.db` → `executions` | `job_id`, `status`, `claimed_at`: run counts, successes and failures |
| `cron/jobs.json` | Job `id` → `name` only |

## Privacy and read-only guarantee

- It never selects message text, prompts, system prompts, titles, error text or memory. From `jobs.json` it keeps only `id` and `name`.
- It opens SQLite read-only with `PRAGMA query_only=1`. If a database has no `-wal` file, it opens with `immutable=1`, so no file is created or touched. If a live `-wal` exists, which means Hermes is running, it does a normal read-only open. As with any SQLite reader, that open takes shared-memory locks in the existing `-shm` file.
- It never writes Hermes files and never runs Hermes, cron jobs or LLMs. It makes no network calls and collects no telemetry.

## Attribution

A run is attributed to a job only through links that Hermes itself writes:

1. **Session ID.** `cron/scheduler.py` names each run's session `cron_<job_id>_<YYYYMMDD_HHMMSS>`. The job ID is everything between `cron_` and the fixed-width timestamp suffix, so job IDs that contain `_` still parse correctly.
2. **Lineage.** Sessions whose `parent_session_id` chain leads back to that session count as part of the same run: compression continuations and delegated subagents. User branches and resets do not.
3. **Unmatched sessions.** A `source='cron'` session whose ID doesn't match the pattern is counted as unattributed. It is never guessed.

`executions.db` rows have a `job_id` but no session ID, so executions are never paired with sessions. A job's observed run count (`RUNS`, `observedRuns` in JSON) is the larger of two numbers in the window: finished executions (completed + failed + unknown) and surviving attributed sessions (`sessionRuns`). The difference (`runsWithoutSession`) is reported as "no surviving Hermes session". That covers script-only or blocked runs, pruned sessions and runs that started just outside the window. The tool never assigns an execution's status to a particular session.

**Coverage** is the number of runs with usage accounting (`runsWithUsage`) divided by the total observed runs. Separately, "cost unknown or partial" counts runs that have tokens Hermes could not price.

## Cost semantics

The tool uses the costs Hermes already stored and has no pricing engine of its own.

- `cost_status = estimated` is shown as `~$`. This is Hermes's estimate from its pricing snapshot.
- `actual` is shown as `$`. If `actual_cost_usd` is above 0, that value wins. The installed Hermes (v0.21.5) writes the priced amount for every status to `estimated_cost_usd`.
- `included` is shown as `included`. It is a subscription route, meaning $0 with no per-call invoice.
- `unknown` is never shown as `$0`. Its tokens are counted but its cost is left out of the total, and the run is flagged with `*`.
- Auxiliary rows (compression, titles, and so on) have no status. A positive amount counts as an estimate and a zero amount counts as unknown.
- `AVG COST` is averaged over runs whose cost is fully known.
- Total tokens are input + output + cache read + cache write, the same as Hermes insights.

## Limitations

- Validated against real Hermes v0.21.5+2961.g436b904 cron history. The acceptance test covered 4 observed runs: 2 completed, 2 failed, 3 surviving cron sessions, and 2 runs with usage accounting. Hermes Cron Cost reported 50% coverage and 36,875 measured tokens, and every reported count, token total, cost status, and coverage gap matched Hermes's persisted records. Real billed dollar costs, compression-continuation sessions, delegated subagent sessions, and gateway-scheduled firing have not yet been observed in the live acceptance test.
- If someone resumes a cron session and chats in it, those later tokens land in the same session and are counted too.
- `executions.db` keeps only the last 1000 finished executions, so for long windows on busy installs the OK and FAIL counts can be low.
- Tested schema: Hermes v0.21.5 (2026.9.24). With older schemas (no `session_model_usage`, no cost columns, no `executions.db`), the report degrades and prints a warning instead of failing.
- It needs Node ≥ 22.18, because it uses the built-in `node:sqlite` and has no runtime dependencies.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Tests build temporary fixture homes using the real Hermes DDL. They never touch `~/.hermes`.
