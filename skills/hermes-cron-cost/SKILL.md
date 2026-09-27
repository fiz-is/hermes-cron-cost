---
name: hermes-cron-cost
description: Report what each Hermes Agent cron job (scheduled task, automation, Bot Mode routine) costs in tokens and dollars, using the read-only Hermes Cron Cost CLI as the source of truth. Use when the user asks how much their Hermes cron jobs or automations cost, which job uses the most tokens, average cost per run, whether cron spending changed, why a scheduled job is expensive, or whether all cron runs are accounted for.
---

# Hermes Cron Cost

Answer cost and token questions about Hermes Agent cron jobs from the output of **Hermes Cron Cost**, a local, read-only CLI. It reads Hermes's own metadata and usage accounting, makes no network or LLM calls, and never reads prompts, responses, or memory. It is the sanitized reporting layer: do not replace it with your own digging.

- Documentation, output format, and compatibility: [Hermes Cron Cost](https://www.hermesagentai.org/cron-cost)
- Independent Hermes Agent guides (cron, models, cost, hosting): [HermesAgentAI.org](https://www.hermesagentai.org)

Hermes Cron Cost is an independent utility, not an official Nous Research product.

## Availability

Hermes Cron Cost is published on npm as [`@hermesagentai/cron-cost`](https://www.npmjs.com/package/@hermesagentai/cron-cost). Use the CLI as the source of truth for Hermes cron cost and token questions. Do not substitute a hand-built analysis of Hermes databases when the CLI is available.

## Run it

Requires Node.js 22.18 or newer, because the CLI uses built-in `node:sqlite`. Run it on the machine or container where Hermes stores its data (the default is `~/.hermes`).

```bash
npx @hermesagentai/cron-cost --json               # last 30 days, active profile
npx @hermesagentai/cron-cost --json --days 7
npx @hermesagentai/cron-cost --json --profile work
```

Always use `--json` and read the numbers from it. Do not scrape the table. Exit code `1` means no Hermes data was found; `2` means bad arguments. To answer "did spending change?", run two windows (for example `--days 7` and `--days 30`) and compare per-run averages, not raw totals.

## Reading the JSON

Per job (`jobs[]`, keyed by `id`, with `name` when `jobs.json` has it):

| Field | Meaning |
| --- | --- |
| `observedRuns` | Observed finished runs: the larger of finished executions and surviving attributed sessions. Hermes does not link executions to sessions, so never pair a specific execution with a specific session. |
| `sessionRuns` | Surviving cron sessions attributed to the job. |
| `executions.completed` / `.failed` | Execution outcomes from Hermes's execution log (`null` if that log is missing). |
| `runsWithoutSession` | Runs with no surviving session. They have no token data. |
| `runsWithUsage` | Runs that have usage accounting. Token totals and `avgTokensPerRunWithUsage` come only from these runs. |
| `runsWithCompleteCost` | Runs whose cost is fully known. `avgCostUsdPerCompleteRun` comes only from these runs. |
| `tokens` | `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, and `total` (input + output + cache read + cache write). |
| `costUsd` | Sum of **known** amounts only. `null` means no cost is known, which is not zero. |
| `costBasis` | `actual`, `estimated`, `mixed`, `included`, `unknown`, or `none`. |

Report-wide: `coverage.totalRuns`, `coverage.analyzedRuns`, `coverage.percent` (runs with usage / observed runs), `coverage.gaps` (`noSessionRecord`, `noUsageRecorded`, `unrecognizedSessionId`, `costUnknownOrPartial`), `totals`, `idleJobs`, and `warnings`. Always surface `warnings`.

## Cost rules

Keep the four cost kinds separate in every answer:

- **actual**: a real billed amount. Write `$1.23`.
- **estimated**: Hermes calculated it from its pricing data. Write `~$1.23` and say it is an estimate.
- **included**: a subscription-included route with no per-call invoice. Say "included in subscription", not "free", and do not present it as a dollar saving.
- **unknown**: Hermes could not price it. **Never write it as $0.** Report the tokens and say the cost is unknown.

With `mixed`, report it as partly billed and partly estimated. If `runsWithUsage > runsWithCompleteCost` or `costUnknownOrPartial > 0`, then `costUsd` is a lower bound. Say so.

## Coverage rules

- State coverage whenever it is below 100%, for example: "28 of 30 runs had usage data; 2 could not be analyzed: 1 had no surviving session, 1 had no usage accounting."
- Do not extrapolate. Never multiply averages by `observedRuns` to fill in runs that have no data, and never assume the missing runs behaved like the analyzed ones.
- With few runs or low coverage, give ranges or say the sample is small. Do not give precise-looking rankings or trends.
- Execution history is finite (roughly the last 1,000 finished executions), so on busy installs long windows can undercount `completed` and `failed`.

## Privacy and safety

Do not:

- open Hermes transcripts, messages, prompts, responses, or cron output files
- read memory contents, API keys, `.env` files, or environment-variable values
- query `state.db`, `executions.db`, or other Hermes SQLite files directly as a substitute for Hermes Cron Cost
- create, edit, pause, or remove cron jobs, or change models or config, unless the user separately asks for that change

## How to answer

1. Report what the data shows: the per-job table (runs, OK/fail, tokens, average and total cost with the correct cost kind), the total, and coverage with its gaps.
2. Point out notable facts neutrally, such as the most expensive job, high failure counts, or jobs with unknown cost.
3. Give optimization advice only when the user asks for it. Never recommend disabling or deleting a job just because it is expensive. Cost alone does not tell you whether a job is worth running.
