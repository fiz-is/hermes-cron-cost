// Aggregating attributed cron runs into the per-job report, and rendering it.
import { buildRuns, type CronRun } from './attribution.ts';
import type { HermesData, SessionRow, UsageRow } from './hermes.ts';

// Hermes cost_status vocabulary (agent/usage_pricing.py CostStatus).
export type CostKind = 'actual' | 'estimated' | 'included' | 'unknown';

interface Part {
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number;
  estimatedCost: number | null; actualCost: number | null; costStatus: string | null;
}

/**
 * Hermes semantics (hermes_state_usage.py, agent/turn_usage.py):
 * - the priced amount for every status is written to estimated_cost_usd; actual_cost_usd
 *   is only non-zero when something recorded a billed amount, and then it wins;
 * - 'included' = subscription route, $0 with no provider invoice;
 * - 'unknown' = no pricing: the stored 0 is a placeholder, not a price;
 * - auxiliary rows (titles, compression, ...) carry no status: a positive amount is an
 *   estimate, a zero amount is unknown.
 */
export function classifyCost(p: Part): { kind: CostKind; usd: number | null } {
  if ((p.actualCost ?? 0) > 0) return { kind: 'actual', usd: p.actualCost! };
  const est = p.estimatedCost ?? 0;
  switch (p.costStatus) {
    case 'actual': return { kind: 'actual', usd: est };
    case 'estimated': return { kind: 'estimated', usd: est };
    case 'included': return { kind: 'included', usd: 0 };
    case null: case '': return est > 0 ? { kind: 'estimated', usd: est } : { kind: 'unknown', usd: null };
    default: return { kind: 'unknown', usd: null };
  }
}

const tokenSum = (p: Part) => p.input + p.output + p.cacheRead + p.cacheWrite;

/**
 * A session's accounting = its session_model_usage rows plus any residual the aggregate
 * sessions row holds beyond them (legacy sessions, pre-usage-table schemas), exactly as
 * Hermes' own insights reconcile the two.
 */
function sessionParts(s: SessionRow, rows: UsageRow[]): Part[] {
  const sum = (k: keyof Part) => rows.reduce((a, r) => a + (Number(r[k as keyof UsageRow]) || 0), 0);
  const residual: Part = {
    input: Math.max(0, s.input - sum('input')),
    output: Math.max(0, s.output - sum('output')),
    cacheRead: Math.max(0, s.cacheRead - sum('cacheRead')),
    cacheWrite: Math.max(0, s.cacheWrite - sum('cacheWrite')),
    reasoning: Math.max(0, s.reasoning - sum('reasoning')),
    estimatedCost: Math.max(0, (s.estimatedCost ?? 0) - sum('estimatedCost')),
    actualCost: Math.max(0, (s.actualCost ?? 0) - sum('actualCost')),
    costStatus: s.costStatus,
  };
  return [...rows, residual].filter((p) => tokenSum(p) > 0 || (p.estimatedCost ?? 0) > 0 || (p.actualCost ?? 0) > 0);
}

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number }
const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
function addTokens(t: Tokens, p: Part) {
  t.input += p.input; t.output += p.output; t.cacheRead += p.cacheRead; t.cacheWrite += p.cacheWrite;
  t.reasoning += p.reasoning; t.total += tokenSum(p); // total follows Hermes insights: in+out+cache r/w
}

export type RunCost = 'actual' | 'estimated' | 'included' | 'mixed' | 'partial' | 'unknown' | 'no_usage';

interface RunSummary { tokens: Tokens; usd: number; cost: RunCost; usedIncluded: boolean }

function summarizeRun(run: CronRun, usageBySession: Map<string, UsageRow[]>): RunSummary {
  const tokens = zeroTokens();
  const kinds = new Set<CostKind>();
  let usd = 0;
  for (const s of run.sessions) {
    for (const p of sessionParts(s, usageBySession.get(s.id) ?? [])) {
      addTokens(tokens, p);
      const c = classifyCost(p);
      kinds.add(c.kind);
      usd += c.usd ?? 0;
    }
  }
  let cost: RunCost;
  if (!kinds.size) cost = 'no_usage';
  else if (kinds.has('unknown')) cost = kinds.size === 1 ? 'unknown' : 'partial';
  else if (kinds.has('actual') && kinds.has('estimated')) cost = 'mixed';
  else cost = kinds.has('estimated') ? 'estimated' : kinds.has('actual') ? 'actual' : 'included';
  return { tokens, usd, cost, usedIncluded: kinds.has('included') };
}

export interface JobReport {
  id: string;
  name: string | null;
  inJobsFile: boolean | null; // null when jobs.json is unavailable
  // Executions and sessions cannot be paired one-to-one, so a job's observed run count is
  // the larger of its terminal executions (completed+failed+unknown) and its surviving
  // attributed cron sessions; with no executions.db it is the session count.
  observedRuns: number;
  sessionRuns: number; // surviving attributed cron sessions (runs) started in the window
  runsWithUsage: number;
  runsWithCompleteCost: number;
  runsUsingIncludedRoutes: number; // any call on a subscription-included route ($0, no invoice)
  costStatusCounts: Partial<Record<RunCost, number>>;
  executions: { completed: number; failed: number; unknown: number; inFlight: number } | null;
  runsWithoutSession: number; // observed runs with no surviving session (observedRuns - sessionRuns)
  tokens: Tokens;
  avgTokensPerRunWithUsage: number | null;
  costUsd: number | null; // sum of known amounts; null when nothing is known
  avgCostUsdPerCompleteRun: number | null;
  costBasis: 'actual' | 'estimated' | 'mixed' | 'included' | 'unknown' | 'none';
}

export interface Report {
  tool: string;
  version: string;
  generatedAt: string;
  profile: string;
  hermesHome: string;
  window: { days: number; since: string; until: string };
  sources: HermesData['sources'];
  populations: {
    knownJobs: number | null;
    executionsInWindow: number | null;
    terminalExecutionsInWindow: number | null;
    cronSessionsInWindow: number;
    attributedRuns: number;
    linkedChildSessions: number;
    runsWithUsage: number;
    runsWithCompleteCost: number;
  };
  coverage: {
    totalRuns: number;
    analyzedRuns: number;
    percent: number | null;
    gaps: { noSessionRecord: number; noUsageRecorded: number; unrecognizedSessionId: number; costUnknownOrPartial: number };
  };
  totals: { tokens: Tokens; costUsd: number | null; costBasis: JobReport['costBasis'] };
  jobs: JobReport[];
  idleJobs: number | null; // jobs in jobs.json with no runs or executions in the window
  warnings: string[];
}

function basis(counts: Partial<Record<RunCost, number>>): JobReport['costBasis'] {
  const has = (k: RunCost) => (counts[k] ?? 0) > 0;
  const act = has('actual') || has('mixed');
  const est = has('estimated') || has('mixed') || has('partial');
  if (act && est) return 'mixed';
  if (act) return 'actual';
  if (est) return 'estimated';
  if (has('included')) return 'included';
  return has('unknown') ? 'unknown' : 'none';
}

export interface BuildOptions {
  days: number;
  now?: Date;
  profile: string;
  hermesHome: string;
  version: string;
}

export function buildReport(data: HermesData, opts: BuildOptions): Report {
  const now = opts.now ?? new Date();
  const until = now.getTime() / 1000;
  const since = until - opts.days * 86400; // same cutoff as Hermes insights
  const inWindow = (t: number) => Number.isFinite(t) && t >= since && t <= until;

  const usageBySession = new Map<string, UsageRow[]>();
  for (const u of data.usage ?? []) usageBySession.set(u.sessionId, [...(usageBySession.get(u.sessionId) ?? []), u]);

  const runs = buildRuns(data.sessions).filter((r) => inWindow(r.root.startedAt));
  const jobNames = new Map((data.jobs ?? []).map((j) => [j.id, j.name]));
  const jobs = new Map<string, JobReport & { _complete: number }>();
  const job = (id: string) => {
    let j = jobs.get(id);
    if (!j) {
      j = {
        id, name: jobNames.get(id) ?? null, inJobsFile: data.jobs ? jobNames.has(id) : null,
        observedRuns: 0, sessionRuns: 0, runsWithUsage: 0, runsWithCompleteCost: 0, runsUsingIncludedRoutes: 0, costStatusCounts: {},
        executions: data.executions ? { completed: 0, failed: 0, unknown: 0, inFlight: 0 } : null,
        runsWithoutSession: 0, tokens: zeroTokens(), avgTokensPerRunWithUsage: null, costUsd: null,
        avgCostUsdPerCompleteRun: null, costBasis: 'none', _complete: 0,
      };
      jobs.set(id, j);
    }
    return j;
  };

  let unrecognized = 0;
  let linkedChildren = 0;
  const totals = zeroTokens();
  for (const run of runs) {
    if (run.jobId === null) { unrecognized++; continue; }
    linkedChildren += run.sessions.length - 1;
    const j = job(run.jobId);
    const r = summarizeRun(run, usageBySession);
    j.sessionRuns++;
    j.costStatusCounts[r.cost] = (j.costStatusCounts[r.cost] ?? 0) + 1;
    if (r.usedIncluded) j.runsUsingIncludedRoutes++;
    if (r.cost === 'no_usage') continue;
    j.runsWithUsage++;
    for (const k of Object.keys(totals) as (keyof Tokens)[]) { j.tokens[k] += r.tokens[k]; totals[k] += r.tokens[k]; }
    if (r.cost !== 'unknown') j.costUsd = (j.costUsd ?? 0) + r.usd;
    if (r.cost !== 'unknown' && r.cost !== 'partial') { j.runsWithCompleteCost++; j._complete += r.usd; }
  }

  let executionsInWindow: number | null = null;
  let terminalInWindow: number | null = null;
  if (data.executions) {
    executionsInWindow = terminalInWindow = 0;
    for (const e of data.executions) {
      if (!inWindow(e.claimedAt)) continue;
      executionsInWindow++;
      const ex = job(e.jobId).executions!;
      if (e.status === 'completed') ex.completed++;
      else if (e.status === 'failed') ex.failed++;
      else if (e.status === 'unknown') ex.unknown++;
      else { ex.inFlight++; continue; }
      terminalInWindow++;
    }
  }

  let totalRuns = unrecognized, analyzed = 0, noSession = 0, noUsage = 0, costGap = 0, complete = 0, usd: number | null = null;
  const allCounts: Partial<Record<RunCost, number>> = {};
  for (const j of jobs.values()) {
    const terminal = j.executions ? j.executions.completed + j.executions.failed + j.executions.unknown : 0;
    // Executions and sessions can't be paired one-to-one, so per job the observed run count
    // is the larger of the two populations; the difference is runs with no surviving session.
    j.observedRuns = Math.max(terminal, j.sessionRuns);
    j.runsWithoutSession = j.observedRuns - j.sessionRuns;
    totalRuns += j.observedRuns;
    analyzed += j.runsWithUsage;
    noSession += j.runsWithoutSession;
    noUsage += j.sessionRuns - j.runsWithUsage;
    costGap += j.runsWithUsage - j.runsWithCompleteCost;
    complete += j.runsWithCompleteCost;
    if (j.costUsd !== null) usd = (usd ?? 0) + j.costUsd;
    j.avgTokensPerRunWithUsage = j.runsWithUsage ? j.tokens.total / j.runsWithUsage : null;
    j.avgCostUsdPerCompleteRun = j.runsWithCompleteCost ? j._complete / j.runsWithCompleteCost : null;
    j.costBasis = basis(j.costStatusCounts);
    for (const [k, v] of Object.entries(j.costStatusCounts)) allCounts[k as RunCost] = (allCounts[k as RunCost] ?? 0) + v;
  }

  const warnings: string[] = [];
  const { stateDb, executionsDb, jobsFile } = data.sources;
  if (!stateDb.found) warnings.push('state.db not found: no session or usage data to analyze.');
  if (stateDb.error) warnings.push(`state.db could not be read: ${stateDb.error}`);
  if (stateDb.found && data.usage === null && !stateDb.error)
    warnings.push('This Hermes version has no session_model_usage table; using per-session totals only.');
  if (stateDb.missing?.length) warnings.push(`state.db lacks: ${stateDb.missing.join(', ')} (treated as unavailable).`);
  if (!executionsDb.found) warnings.push('cron/executions.db not found: success/failure counts unavailable.');
  if (executionsDb.error) warnings.push(`cron/executions.db could not be read: ${executionsDb.error}`);
  if (executionsDb.missing?.length) warnings.push(`cron/executions.db lacks: ${executionsDb.missing.join(', ')}.`);
  if (jobsFile.error) warnings.push(`cron/jobs.json could not be parsed: ${jobsFile.error}`);

  const jobList = [...jobs.values()]
    .map(({ _complete, ...j }) => j)
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens.total - a.tokens.total || b.observedRuns - a.observedRuns);

  return {
    tool: '@hermesagentai/cron-cost',
    version: opts.version,
    generatedAt: now.toISOString(),
    profile: opts.profile,
    hermesHome: opts.hermesHome,
    window: { days: opts.days, since: new Date(since * 1000).toISOString(), until: now.toISOString() },
    sources: data.sources,
    populations: {
      knownJobs: data.jobs ? data.jobs.length : null,
      executionsInWindow,
      terminalExecutionsInWindow: terminalInWindow,
      cronSessionsInWindow: runs.length,
      attributedRuns: runs.length - unrecognized,
      linkedChildSessions: linkedChildren,
      runsWithUsage: analyzed,
      runsWithCompleteCost: complete,
    },
    coverage: {
      totalRuns,
      analyzedRuns: analyzed,
      percent: totalRuns ? (analyzed / totalRuns) * 100 : null,
      gaps: { noSessionRecord: noSession, noUsageRecorded: noUsage, unrecognizedSessionId: unrecognized, costUnknownOrPartial: costGap },
    },
    totals: { tokens: totals, costUsd: usd, costBasis: basis(allCounts) },
    jobs: jobList,
    idleJobs: data.jobs ? data.jobs.filter((j) => !jobs.has(j.id)).length : null,
    warnings,
  };
}

// ---------------------------------------------------------------- text

const int = (n: number) => Math.round(n).toLocaleString('en-US');
function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${+(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}
function money(usd: number): string {
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
// "~" marks Hermes estimates (as Hermes itself displays them), "*" marks partially known cost.
function costCell(usd: number | null, b: JobReport['costBasis'], partial: boolean): string {
  if (usd === null) return b === 'none' ? '—' : 'unknown';
  if (b === 'included') return 'included';
  return `${b === 'actual' ? '' : '~'}${money(usd)}${partial ? '*' : ''}`;
}
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function renderText(r: Report): string {
  const out: string[] = [];
  out.push('Hermes Cron Cost', '');
  out.push(`Profile ${r.profile} · ${r.hermesHome}`);
  out.push(`Last ${plural(r.window.days, 'day')} (${day(r.window.since)} – ${day(r.window.until)})`);

  if (!r.sources.stateDb.found && !r.sources.executionsDb.found) {
    out.push('', 'No Hermes state found here (no state.db or cron/executions.db).');
    for (const w of r.warnings) out.push(`! ${w}`);
    return out.join('\n');
  }
  const c = r.coverage;
  if (!c.totalRuns) {
    out.push('', `No cron runs found in the last ${plural(r.window.days, 'day')}.`);
    if (r.populations.knownJobs !== null) out.push(`${plural(r.populations.knownJobs, 'cron job')} defined in jobs.json.`);
    else out.push('No cron/jobs.json found — this profile has no cron jobs defined.');
  } else {
    out.push(`Analyzed ${int(c.analyzedRuns)} / ${plural(c.totalRuns, 'observed cron run')} (${c.percent!.toFixed(1)}% had attributable usage data)`, '');
    const hasExec = r.jobs.some((j) => j.executions);
    const header = ['JOB', 'RUNS', ...(hasExec ? ['OK', 'FAIL'] : []), 'INPUT', 'OUTPUT', 'AVG TOKENS', 'AVG COST', 'TOTAL COST'];
    const rows = r.jobs.map((j) => {
      const partial = j.runsWithUsage > j.runsWithCompleteCost;
      const label = (j.name ?? j.id) + (j.inJobsFile === false ? ' (deleted)' : '');
      return [
        label.length > 28 ? label.slice(0, 27) + '…' : label,
        int(j.observedRuns),
        ...(hasExec ? (j.executions ? [int(j.executions.completed), int(j.executions.failed)] : ['—', '—']) : []),
        j.runsWithUsage ? compact(j.tokens.input) : '—',
        j.runsWithUsage ? compact(j.tokens.output) : '—',
        j.avgTokensPerRunWithUsage === null ? '—' : int(j.avgTokensPerRunWithUsage),
        j.avgCostUsdPerCompleteRun === null ? '—' : costCell(j.avgCostUsdPerCompleteRun, j.costBasis, false),
        costCell(j.costUsd, j.costBasis, partial),
      ];
    });
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const fmt = (row: string[]) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd();
    out.push(fmt(header), ...rows.map(fmt));
    if (r.jobs.some((j) => j.runsWithoutSession > 0 || (j.executions && j.observedRuns > j.executions.completed + j.executions.failed)))
      out.push('RUNS = finished executions or surviving sessions, whichever is larger (they are not paired per run).',
        'AVG columns use only runs with usage (tokens) or fully known cost (cost).');
    out.push('');

    const t = r.totals;
    const partialAny = c.gaps.costUnknownOrPartial > 0;
    out.push(`Measured cost: ${costCell(t.costUsd, t.costBasis, partialAny)}` +
      (t.costBasis === 'estimated' || t.costBasis === 'mixed' ? '  (~ = Hermes estimate from its pricing data)' : ''));
    const incl = r.jobs.reduce((a, j) => a + j.runsUsingIncludedRoutes, 0);
    if (incl) out.push(`${plural(incl, 'run')} used subscription-included routes (no per-call invoice; those calls count as $0).`);

    const gaps: string[] = [];
    if (c.gaps.noSessionRecord) gaps.push(`${c.gaps.noSessionRecord} had an execution record but no surviving Hermes session`);
    if (c.gaps.noUsageRecorded) gaps.push(`${c.gaps.noUsageRecorded} had a session but no usage accounting`);
    if (c.gaps.unrecognizedSessionId) gaps.push(`${c.gaps.unrecognizedSessionId} had a cron session id Hermes Cron Cost could not map to a job`);
    const notAnalyzed = c.totalRuns - c.analyzedRuns;
    if (notAnalyzed) out.push('', `${plural(notAnalyzed, 'run')} could not be analyzed:`, ...gaps.map((g) => `- ${g}`));
    if (partialAny) out.push('', `* ${plural(c.gaps.costUnknownOrPartial, 'analyzed run')} had tokens Hermes could not price; their tokens are counted, their cost is not.`);
    if (r.idleJobs) out.push('', `${plural(r.idleJobs, 'other job')} in jobs.json had no runs in this window.`);
  }
  if (r.warnings.length) out.push('', ...r.warnings.map((w) => `! ${w}`));
  return out.join('\n');
}
