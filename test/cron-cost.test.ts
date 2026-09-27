import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { belongsToRun, buildRuns, parseCronSessionId } from '../src/attribution.ts';
import { openReadOnly, readHermesData, resolveHermesHome, type SessionRow } from '../src/hermes.ts';
import { buildReport, classifyCost, renderText } from '../src/report.ts';

// DDL copied from a real Hermes v0.21.5 state.db / cron/executions.db (schema only).
const SESSIONS_DDL = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
  system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
  message_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0,
  billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
  cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT, api_call_count INTEGER DEFAULT 0,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id))`;
const USAGE_DDL = `CREATE TABLE session_model_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, model TEXT NOT NULL,
  billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
  PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task))`;
const EXECUTIONS_DDL = `CREATE TABLE executions (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL, pid INTEGER NOT NULL,
  process_started_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('claimed','running','completed','failed','unknown')),
  claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT,
  handoff_pending INTEGER NOT NULL DEFAULT 0, handoff_started_at REAL, delivery_outcome TEXT, scheduled_instant TEXT)`;

const NOW = new Date('2026-09-26T12:00:00Z');
const T = NOW.getTime() / 1000;
const DAY = 86400;

interface S { id: string; source?: string; parent?: string; ago: number; end?: string; cfg?: object; tokens?: [number, number]; cost?: number | null; status?: string | null; actual?: number }
interface U { sid: string; model?: string; task?: string; tokens: [number, number, number?]; est?: number; actual?: number; status?: string | null }
interface E { job: string; status: string; ago: number }

function makeHome(opts: { sessions?: S[]; usage?: U[]; executions?: E[]; jobs?: object[] | null; wal?: boolean; legacy?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hcc-'));
  mkdirSync(join(home, 'cron'));
  const state = new DatabaseSync(join(home, 'state.db'));
  if (opts.wal) state.exec('PRAGMA journal_mode=WAL');
  if (opts.legacy) {
    // Pre-usage-table Hermes: no session_model_usage, no cost columns.
    state.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0)`);
    for (const s of opts.sessions ?? [])
      state.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(s.id, s.source ?? 'cron', T - s.ago * DAY, ...(s.tokens ?? [0, 0]));
  } else {
    state.exec(SESSIONS_DDL);
    state.exec(USAGE_DDL);
    const ins = state.prepare(`INSERT INTO sessions (id, source, parent_session_id, started_at, end_reason, model_config,
      input_tokens, output_tokens, estimated_cost_usd, actual_cost_usd, cost_status, system_prompt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'SECRET PROMPT')`);
    for (const s of opts.sessions ?? [])
      ins.run(s.id, s.source ?? 'cron', s.parent ?? null, T - s.ago * DAY, s.end ?? null, s.cfg ? JSON.stringify(s.cfg) : null,
        ...(s.tokens ?? [0, 0]), s.cost ?? null, s.actual ?? null, s.status ?? null);
    const insU = state.prepare(`INSERT INTO session_model_usage (session_id, model, task, input_tokens, output_tokens,
      cache_read_tokens, estimated_cost_usd, actual_cost_usd, cost_status) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const u of opts.usage ?? [])
      insU.run(u.sid, u.model ?? 'm', u.task ?? '', u.tokens[0], u.tokens[1], u.tokens[2] ?? 0, u.est ?? 0, u.actual ?? 0, u.status ?? null);
  }
  if (!opts.wal) state.close();
  if (opts.executions) {
    const ex = new DatabaseSync(join(home, 'cron', 'executions.db'));
    ex.exec(EXECUTIONS_DDL);
    const ins = ex.prepare(`INSERT INTO executions (id, job_id, source, process_id, pid, status, claimed_at, error)
      VALUES (?,?,'scheduler','p',1,?,?, 'SECRET ERROR')`);
    opts.executions.forEach((e, i) => ins.run(`x${i}`, e.job, e.status, new Date((T - e.ago * DAY) * 1000).toISOString().replace('Z', '+00:00')));
    ex.close();
  }
  if (opts.jobs !== null) writeFileSync(join(home, 'cron', 'jobs.json'), JSON.stringify({ jobs: opts.jobs ?? [] }));
  return { home, state: opts.wal ? state : undefined };
}

const report = (home: string, days = 30) =>
  buildReport(readHermesData(home), { days, now: NOW, profile: 'default', hermesHome: home, version: 't' });

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id, source: 'cron', parentId: null, startedAt: T, endReason: null, modelConfig: null, input: 0, output: 0,
  cacheRead: 0, cacheWrite: 0, reasoning: 0, estimatedCost: null, actualCost: null, costStatus: null, ...extra,
});

// ------------------------------------------------------------ attribution

test('parses cron session ids, including job ids with underscores', () => {
  assert.deepEqual(parseCronSessionId('cron_a1b2c3d4e5f6_20260926_070000'), { jobId: 'a1b2c3d4e5f6', stamp: '20260926_070000' });
  assert.equal(parseCronSessionId('cron_my_daily_job_20260926_070000')?.jobId, 'my_daily_job');
  // A job id that itself ends in a timestamp-shaped segment still resolves: the suffix is fixed-width.
  assert.equal(parseCronSessionId('cron_x_20250101_000000_20260926_070000')?.jobId, 'x_20250101_000000');
  assert.equal(parseCronSessionId('cron_job_2026926_0700'), null);
  assert.equal(parseCronSessionId('20260926_070000_abc'), null);
  assert.equal(parseCronSessionId('cron__20260926_070000'), null);
});

test('links compression continuations and delegates to the run, not user branches', () => {
  const root = row('cron_job_1_20260926_070000', { endReason: 'compression' });
  const cont = row('20260926_071000_aaaa', { parentId: root.id });
  const delegate = row('20260926_071500_bbbb', { parentId: cont.id, source: 'tool' });
  const branch = row('20260926_090000_cccc', { parentId: root.id, source: 'desktop', modelConfig: JSON.stringify({ _branched_from: root.id }) });
  const plainChild = row('20260926_090000_dddd', { parentId: delegate.id, source: 'desktop' });
  assert.equal(belongsToRun(cont, root), true);
  assert.equal(belongsToRun(branch, root), false);
  assert.equal(belongsToRun(plainChild, delegate), false); // delegate did not end in compression

  const runs = buildRuns([root, cont, delegate, branch, plainChild]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].jobId, 'job_1');
  assert.deepEqual(runs[0].sessions.map((s) => s.id).sort(), [root.id, cont.id, delegate.id].sort());
});

test('a source=cron session with an unknown id format stays unattributed', () => {
  const runs = buildRuns([row('weird-id'), row('20260926_000000_abcd', { source: 'desktop' })]);
  assert.deepEqual(runs.map((r) => [r.root.id, r.jobId]), [['weird-id', null]]);
});

// ------------------------------------------------------------ cost semantics

test('cost classification follows Hermes cost_status semantics', () => {
  const p = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0.5, actualCost: 0, costStatus: 'estimated' }), { kind: 'estimated', usd: 0.5 });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0.4, actualCost: 0, costStatus: 'actual' }), { kind: 'actual', usd: 0.4 });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0.5, actualCost: 0.7, costStatus: 'estimated' }), { kind: 'actual', usd: 0.7 });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0, actualCost: 0, costStatus: 'actual' }), { kind: 'actual', usd: 0 });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0, actualCost: 0, costStatus: 'included' }), { kind: 'included', usd: 0 });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0, actualCost: 0, costStatus: 'unknown' }), { kind: 'unknown', usd: null });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0, actualCost: 0, costStatus: null }), { kind: 'unknown', usd: null });
  assert.deepEqual(classifyCost({ ...p, estimatedCost: 0.01, actualCost: 0, costStatus: null }), { kind: 'estimated', usd: 0.01 });
});

// ------------------------------------------------------------ report

function standardHome() {
  const jobs = [{ id: 'brief_am', name: 'Morning AI Brief', prompt: 'SECRET PROMPT' }, { id: 'gh', name: 'GitHub Monitor' }, { id: 'idle', name: 'Idle' }];
  const sessions: S[] = [
    { id: 'cron_brief_am_20260925_070000', ago: 1, tokens: [900, 100], cost: 0.2, status: 'estimated' },
    { id: 'cron_brief_am_20260924_070000', ago: 2, tokens: [1900, 100], cost: 0.4, status: 'estimated' },
    { id: 'cron_brief_am_20260801_070000', ago: 40, tokens: [5000, 0], cost: 9, status: 'estimated' }, // outside 30d
    { id: 'cron_gh_20260926_080000', ago: 0.1, tokens: [100, 50], cost: 0, status: 'included' },
    { id: 'cron_gh_20260920_080000', ago: 6, tokens: [0, 0] }, // session without usage accounting
    { id: 'cron_gone_20260915_080000', ago: 11, tokens: [300, 30], cost: 0, status: 'unknown' }, // deleted job, unknown cost
  ];
  const usage: U[] = [
    { sid: 'cron_brief_am_20260925_070000', tokens: [900, 100], est: 0.2, status: 'estimated' },
    { sid: 'cron_brief_am_20260924_070000', tokens: [1800, 100], est: 0.35, status: 'estimated' },
    { sid: 'cron_brief_am_20260924_070000', task: 'compression', tokens: [100, 0], est: 0.05, status: null },
    { sid: 'cron_gh_20260926_080000', tokens: [100, 50], status: 'included' },
    { sid: 'cron_gone_20260915_080000', tokens: [300, 30], status: 'unknown' },
  ];
  const executions: E[] = [
    { job: 'brief_am', status: 'completed', ago: 1 }, { job: 'brief_am', status: 'completed', ago: 2 },
    { job: 'brief_am', status: 'failed', ago: 3 }, // failed before any session was created
    { job: 'brief_am', status: 'completed', ago: 40 }, // outside window
    { job: 'gh', status: 'completed', ago: 0.1 }, { job: 'gh', status: 'failed', ago: 6 },
    { job: 'gh', status: 'running', ago: 0.01 },
  ];
  return makeHome({ sessions, usage, executions, jobs });
}

test('groups runs per job, aggregates tokens/cost, averages, and counts success/failure', () => {
  const r = report(standardHome().home);
  const brief = r.jobs.find((j) => j.id === 'brief_am')!;
  assert.equal(brief.name, 'Morning AI Brief');
  assert.equal(brief.sessionRuns, 2);
  assert.equal(brief.runsWithUsage, 2);
  assert.deepEqual([brief.tokens.input, brief.tokens.output, brief.tokens.total], [2800, 200, 3000]);
  assert.equal(brief.avgTokensPerRunWithUsage, 1500);
  assert.ok(Math.abs(brief.costUsd! - 0.6) < 1e-9);
  assert.ok(Math.abs(brief.avgCostUsdPerCompleteRun! - 0.3) < 1e-9);
  assert.equal(brief.costBasis, 'estimated');
  assert.deepEqual(brief.executions, { completed: 2, failed: 1, unknown: 0, inFlight: 0 });
  assert.equal(brief.runsWithoutSession, 1);

  const gh = r.jobs.find((j) => j.id === 'gh')!;
  assert.equal(gh.costBasis, 'included');
  assert.equal(gh.costUsd, 0);
  assert.deepEqual(gh.executions, { completed: 1, failed: 1, unknown: 0, inFlight: 1 });
  assert.equal(gh.sessionRuns, 2);
  assert.equal(gh.observedRuns, 2); // the running execution is not a terminal run
  assert.equal(gh.runsWithUsage, 1);
  assert.equal(gh.runsUsingIncludedRoutes, 1);

  const gone = r.jobs.find((j) => j.id === 'gone')!;
  assert.equal(gone.inJobsFile, false);
  assert.equal(gone.costUsd, null, 'unknown cost must not become $0');
  assert.equal(gone.costBasis, 'unknown');
  assert.equal(gone.tokens.total, 330);
  assert.equal(r.idleJobs, 1);
});

test('RUNS counts observed terminal runs: 2 sessions + 2 completed + 1 failed with no session = 3', () => {
  const { home } = makeHome({
    jobs: [{ id: 'brief', name: 'Morning AI Brief' }],
    sessions: [
      { id: 'cron_brief_20260925_070000', ago: 1, tokens: [900, 100] },
      { id: 'cron_brief_20260924_070000', ago: 2, tokens: [1900, 100] },
    ],
    usage: [
      { sid: 'cron_brief_20260925_070000', tokens: [900, 100], est: 0.2, status: 'estimated' },
      { sid: 'cron_brief_20260924_070000', tokens: [1900, 100], est: 0.4, status: 'estimated' },
    ],
    executions: [
      { job: 'brief', status: 'completed', ago: 1 }, { job: 'brief', status: 'completed', ago: 2 },
      { job: 'brief', status: 'failed', ago: 3 }, { job: 'brief', status: 'running', ago: 0.01 },
    ],
  });
  const r = report(home);
  const j = r.jobs[0];
  assert.equal(j.observedRuns, 3);
  assert.equal(j.sessionRuns, 2);
  assert.equal(j.runsWithoutSession, 1);
  assert.deepEqual(j.executions, { completed: 2, failed: 1, unknown: 0, inFlight: 1 });
  assert.equal(j.runsWithUsage, 2);
  assert.equal(j.avgTokensPerRunWithUsage, 1500); // 3000 tokens / 2 sessions with usage, not / 3
  assert.ok(Math.abs(j.avgCostUsdPerCompleteRun! - 0.3) < 1e-9); // $0.60 / 2, not / 3
  assert.deepEqual([r.coverage.totalRuns, r.coverage.analyzedRuns, r.coverage.gaps.noSessionRecord], [3, 2, 1]);
  const text = renderText(r);
  assert.match(text, /^Morning AI Brief\s+3\s+2\s+1\s+2\.8k\s+200\s+1,500\s+~\$0\.30\s+~\$0\.60$/m);
  assert.match(text, /Analyzed 2 \/ 3 observed cron runs/);
  assert.match(text, /not paired per run/);
});

test('without executions.db, RUNS falls back to surviving sessions', () => {
  const { home } = makeHome({ sessions: [{ id: 'cron_j_20260925_000000', ago: 1, tokens: [1, 1] }, { id: 'cron_j_20260924_000000', ago: 2 }] });
  const j = report(home).jobs[0];
  assert.deepEqual([j.observedRuns, j.sessionRuns, j.runsWithUsage, j.executions], [2, 2, 1, null]);
});

test('coverage counts every population honestly', () => {
  const r = report(standardHome().home);
  // brief: max(3 exec, 2 sessions)=3; gh: max(2, 2)=2; gone: max(0, 1)=1
  assert.equal(r.coverage.totalRuns, 6);
  assert.equal(r.coverage.analyzedRuns, 4);
  assert.deepEqual(r.coverage.gaps, { noSessionRecord: 1, noUsageRecorded: 1, unrecognizedSessionId: 0, costUnknownOrPartial: 1 });
  assert.equal(r.populations.knownJobs, 3);
  assert.equal(r.populations.executionsInWindow, 6);
  assert.equal(r.populations.terminalExecutionsInWindow, 5);
  assert.equal(r.populations.cronSessionsInWindow, 5);
  assert.equal(r.populations.runsWithCompleteCost, 3);
  assert.ok(Math.abs(r.totals.costUsd! - 0.6) < 1e-9);
});

test('default 30-day window vs custom --days', () => {
  const { home } = standardHome();
  const brief30 = report(home).jobs.find((j) => j.id === 'brief_am')!;
  assert.deepEqual([brief30.sessionRuns, brief30.observedRuns], [2, 3]);
  const brief45 = report(home, 45).jobs.find((j) => j.id === 'brief_am')!;
  assert.deepEqual([brief45.sessionRuns, brief45.observedRuns], [3, 4]);
  const r1 = report(home, 1.5);
  assert.deepEqual(r1.jobs.map((j) => [j.id, j.sessionRuns, j.observedRuns]).sort(), [['brief_am', 1, 1], ['gh', 1, 1]]);
});

test('mixed and partial cost states are kept distinct', () => {
  const { home } = makeHome({
    sessions: [
      { id: 'cron_j_20260925_000000', ago: 1, tokens: [10, 10] },
      { id: 'cron_j_20260924_000000', ago: 2, tokens: [10, 10] },
      { id: 'cron_j_20260923_000000', ago: 3, tokens: [10, 10] },
    ],
    usage: [
      { sid: 'cron_j_20260925_000000', tokens: [10, 10], est: 1, actual: 1.25, status: 'actual' },
      { sid: 'cron_j_20260924_000000', tokens: [10, 10], est: 0.5, status: 'estimated' },
      { sid: 'cron_j_20260923_000000', tokens: [5, 5], est: 0.1, status: 'estimated' },
      { sid: 'cron_j_20260923_000000', model: 'other', tokens: [5, 5], status: 'unknown' },
    ],
  });
  const j = report(home).jobs[0];
  assert.deepEqual(j.costStatusCounts, { actual: 1, estimated: 1, partial: 1 });
  assert.equal(j.costBasis, 'mixed');
  assert.ok(Math.abs(j.costUsd! - 1.85) < 1e-9); // known parts only
  assert.ok(Math.abs(j.avgCostUsdPerCompleteRun! - 0.875) < 1e-9); // (1.25 + 0.5) / 2 complete runs
  assert.equal(j.runsWithCompleteCost, 2);
  const text = renderText(report(home));
  assert.match(text, /~\$1\.85\*/);
  assert.match(text, /1 analyzed run had tokens Hermes could not price/);
});

test('compression continuation usage is attributed to its cron job', () => {
  const { home } = makeHome({
    sessions: [
      { id: 'cron_j_20260925_000000', ago: 1, end: 'compression', tokens: [100, 10], cost: 0.1, status: 'estimated' },
      { id: '20260925_001000_abcd', parent: 'cron_j_20260925_000000', ago: 0.99, tokens: [50, 5], cost: 0.05, status: 'estimated' },
    ],
    usage: [
      { sid: 'cron_j_20260925_000000', tokens: [100, 10], est: 0.1, status: 'estimated' },
      { sid: '20260925_001000_abcd', tokens: [50, 5], est: 0.05, status: 'estimated' },
    ],
  });
  const r = report(home);
  assert.equal(r.jobs[0].sessionRuns, 1);
  assert.equal(r.jobs[0].observedRuns, 1);
  assert.equal(r.jobs[0].tokens.total, 165);
  assert.ok(Math.abs(r.jobs[0].costUsd! - 0.15) < 1e-9);
  assert.equal(r.populations.linkedChildSessions, 1);
});

test('unrecognized cron sessions are counted, never guessed', () => {
  const { home } = makeHome({ sessions: [{ id: 'cron-legacy-format', ago: 1, tokens: [10, 1] }] });
  const r = report(home);
  assert.equal(r.jobs.length, 0);
  assert.equal(r.coverage.totalRuns, 1);
  assert.equal(r.coverage.analyzedRuns, 0);
  assert.equal(r.coverage.gaps.unrecognizedSessionId, 1);
  assert.match(renderText(r), /could not map to a job/);
});

test('empty cron history', () => {
  const { home } = makeHome({ executions: [], jobs: [] });
  const r = report(home);
  assert.equal(r.coverage.totalRuns, 0);
  assert.equal(r.coverage.percent, null);
  assert.match(renderText(r), /No cron runs found in the last 30 days/);
});

test('older schema: no usage table, no cost columns, no executions.db, no jobs.json', () => {
  const { home } = makeHome({ legacy: true, jobs: null, sessions: [{ id: 'cron_j_20260925_000000', ago: 1, tokens: [40, 2] }] });
  const r = report(home);
  assert.equal(r.jobs[0].tokens.total, 42);
  assert.equal(r.jobs[0].costUsd, null);
  assert.equal(r.jobs[0].executions, null);
  assert.equal(r.populations.knownJobs, null);
  assert.equal(r.coverage.analyzedRuns, 1);
  assert.ok(r.warnings.some((w) => w.includes('no session_model_usage')));
  assert.ok(r.warnings.some((w) => w.includes('estimated_cost_usd')));
  assert.ok(r.warnings.some((w) => w.includes('executions.db not found')));
});

test('corrupt/unreadable state.db degrades to a warning, not a crash', () => {
  const home = mkdtempSync(join(tmpdir(), 'hcc-'));
  writeFileSync(join(home, 'state.db'), 'not a database');
  const r = report(home);
  assert.equal(r.coverage.totalRuns, 0);
  assert.ok(r.warnings.some((w) => w.startsWith('state.db could not be read')));
});

// ------------------------------------------------------------ paths

test('resolves default, named, active and HERMES_HOME profiles like Hermes', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'hcc-home-'));
  const root = join(homeDir, '.hermes');
  const base = { homeDir, platform: 'darwin' as const };
  assert.deepEqual(resolveHermesHome({ ...base, env: {} }), { root, home: root, profile: 'default' });
  assert.deepEqual(resolveHermesHome({ ...base, env: {}, profile: 'Coder' }), { root, home: join(root, 'profiles', 'coder'), profile: 'coder' });
  assert.deepEqual(resolveHermesHome({ ...base, env: {}, profile: 'default' }).home, root);
  assert.throws(() => resolveHermesHome({ ...base, env: {}, profile: '../etc' }), /Invalid Hermes profile/);
  // HERMES_HOME pointing at a profile (what the hermes wrapper exports)
  assert.deepEqual(resolveHermesHome({ ...base, env: { HERMES_HOME: join(root, 'profiles', 'coder') } }),
    { root, home: join(root, 'profiles', 'coder'), profile: 'coder' });
  // custom root (Docker) and a named profile under it
  assert.deepEqual(resolveHermesHome({ ...base, env: { HERMES_HOME: '/opt/data' }, profile: 'x' }),
    { root: '/opt/data', home: '/opt/data/profiles/x', profile: 'x' });
  assert.equal(resolveHermesHome({ ...base, env: { HERMES_HOME: '/opt/data/profiles/x' } }).root, '/opt/data');
  // sticky active profile
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'active_profile'), 'coder\n');
  assert.equal(resolveHermesHome({ ...base, env: {} }).home, join(root, 'profiles', 'coder'));
  assert.equal(resolveHermesHome({ ...base, env: {}, profile: 'default' }).home, root);
  assert.equal(resolveHermesHome({ ...base, env: { HERMES_DATA_DIR_SUFFIX: '-dev' } }).root, join(homeDir, '.hermes-dev'));
  assert.equal(resolveHermesHome({ homeDir, platform: 'win32', env: { LOCALAPPDATA: 'C:/L' } }).root, join('C:/L', 'hermes'));
});

// ------------------------------------------------------------ CLI + read-only

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const runCli = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) out[join(f.parentPath, f.name)] = createHash('sha256').update(readFileSync(join(f.parentPath, f.name))).digest('hex');
  return out;
}

test('--json output, and the CLI never changes any file in the Hermes home', () => {
  const { home } = standardHome();
  const before = snapshot(home);
  const res = runCli(['--json'], { HERMES_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(res.stdout);
  assert.equal(r.window.days, 30);
  assert.equal(r.coverage.totalRuns >= 1, true);
  assert.ok(r.jobs.some((j: { name: string }) => j.name === 'Morning AI Brief'));
  assert.deepEqual(Object.keys(r.populations).sort(), ['attributedRuns', 'cronSessionsInWindow', 'executionsInWindow', 'knownJobs',
    'linkedChildSessions', 'runsWithCompleteCost', 'runsWithUsage', 'terminalExecutionsInWindow']);
  assert.equal(r.sources.stateDb.mode, 'immutable');
  // privacy: prompts, errors and system prompts are never read into the output
  assert.doesNotMatch(res.stdout, /SECRET/);
  assert.deepEqual(snapshot(home), before, 'no file created, modified or removed');

  const text = runCli(['--days', '7'], { HERMES_HOME: home });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Last 7 days/);
  assert.match(text.stdout, /Morning AI Brief/);
  assert.doesNotMatch(text.stdout + text.stderr, /SECRET|ExperimentalWarning/);
});

test('live WAL database is read read-only and writes are refused', () => {
  const { home, state } = makeHome({ wal: true, sessions: [{ id: 'cron_j_20260925_000000', ago: 1, tokens: [1, 1] }] });
  try {
    const { db, mode } = openReadOnly(join(home, 'state.db'));
    assert.equal(mode, 'readonly');
    assert.throws(() => db.exec(`DELETE FROM sessions`), /readonly|query_only/i);
    db.close();
    const r = report(home);
    assert.equal(r.jobs[0].sessionRuns, 1); // un-checkpointed WAL rows are visible
  } finally {
    state!.close();
  }
});

test('missing Hermes installation exits 1 with a clear message; bad args exit 2', () => {
  const missing = join(tmpdir(), 'hcc-does-not-exist-' + process.pid);
  const res = runCli([], { HERMES_HOME: missing });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /No Hermes state found/);
  assert.match(res.stderr, /No Hermes installation found/);
  assert.equal(runCli(['--days', '0'], { HERMES_HOME: missing }).status, 2);
  assert.equal(runCli(['--bogus'], { HERMES_HOME: missing }).status, 2);
  assert.match(runCli(['--help'], {}).stdout, /--profile <name>/);
  assert.match(runCli(['--version'], {}).stdout, /^\d+\.\d+\.\d+/);
});
