// Locating and reading persisted Hermes data. Everything here is read-only:
// SQLite files are opened read-only with PRAGMA query_only, jobs.json is only read.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// Same rule as Hermes' hermes_constants.PROFILE_ID_RE.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface HermesHome {
  root: string; // default-profile home, parent of profiles/
  home: string; // the profile home actually analyzed
  profile: string;
}

export interface ResolveOptions {
  profile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function expandHome(p: string, homeDir: string): string {
  return p === '~' || p.startsWith('~/') ? join(homeDir, p.slice(1)) : p;
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Mirrors Hermes (hermes_constants.get_default_hermes_root + hermes_cli.profiles):
 * - root: ~/.hermes (Windows: %LOCALAPPDATA%/hermes), plus HERMES_DATA_DIR_SUFFIX;
 *   a HERMES_HOME outside it is a custom root (or <root>/profiles/<name>).
 * - default profile = root; named profile = <root>/profiles/<lowercased name>.
 * - no --profile: HERMES_HOME if set, else the sticky <root>/active_profile.
 */
export function resolveHermesHome(opts: ResolveOptions = {}): HermesHome {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? '';
  const native = (opts.platform ?? process.platform) === 'win32'
    ? join(env.LOCALAPPDATA?.trim() || join(homeDir, 'AppData', 'Local'), 'hermes' + suffix)
    : join(homeDir, '.hermes' + suffix);
  const envHome = env.HERMES_HOME?.trim() ? resolve(expandHome(env.HERMES_HOME.trim(), homeDir)) : undefined;

  let root = native;
  if (envHome && !isWithin(envHome, native)) {
    root = basename(dirname(envHome)) === 'profiles' ? dirname(dirname(envHome)) : envHome;
  }
  const named = (name: string): HermesHome => {
    const canon = name.trim().toLowerCase();
    if (canon === 'default') return { root, home: root, profile: 'default' };
    if (!PROFILE_ID_RE.test(canon)) throw new Error(`Invalid Hermes profile name: ${JSON.stringify(name)}`);
    return { root, home: join(root, 'profiles', canon), profile: canon };
  };

  if (opts.profile !== undefined) return named(opts.profile);
  if (envHome) {
    const profile = dirname(envHome) === join(root, 'profiles') ? basename(envHome) : 'default';
    return { root, home: envHome, profile };
  }
  let active = '';
  try {
    active = readFileSync(join(root, 'active_profile'), 'utf8').replace(/^﻿/, '').trim();
  } catch { /* no sticky profile */ }
  return active && active.toLowerCase() !== 'default' && PROFILE_ID_RE.test(active.toLowerCase())
    ? named(active)
    : { root, home: root, profile: 'default' };
}

// ---------------------------------------------------------------- SQLite

export type OpenMode = 'immutable' | 'readonly';

export interface OpenedDb {
  db: DatabaseSync;
  mode: OpenMode;
}

const require = createRequire(import.meta.url);

/**
 * Open a SQLite file without writing to it. With no -wal file present every committed
 * page is in the main file, so `immutable=1` reads it without creating -shm/-wal
 * sidecars. With a live -wal, a plain read-only open is required to see WAL pages.
 */
export function openReadOnly(path: string): OpenedDb {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync;
  let mode: OpenMode;
  if (existsSync(path + '-wal')) {
    db = new DatabaseSync(path, { readOnly: true });
    mode = 'readonly';
  } else {
    const url = pathToFileURL(path);
    url.searchParams.set('immutable', '1');
    db = new DatabaseSync(url, { readOnly: true });
    mode = 'immutable';
  }
  db.exec('PRAGMA query_only = 1');
  return { db, mode };
}

export function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// ---------------------------------------------------------------- rows

export interface SessionRow {
  id: string;
  source: string | null;
  parentId: string | null;
  startedAt: number;
  endReason: string | null;
  modelConfig: string | null; // only parsed for lineage markers, never printed
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  estimatedCost: number | null;
  actualCost: number | null;
  costStatus: string | null;
}

export interface UsageRow {
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  estimatedCost: number | null;
  actualCost: number | null;
  costStatus: string | null;
}

export interface ExecutionRow {
  jobId: string;
  status: string;
  claimedAt: number; // epoch seconds
}

export interface JobDef {
  id: string;
  name: string | null;
}

export interface SourceStatus {
  path: string;
  found: boolean;
  mode?: OpenMode;
  missing?: string[]; // tables/columns this reader wanted but did not find
  error?: string;
}

export interface HermesData {
  sessions: SessionRow[];
  usage: UsageRow[] | null; // null: no session_model_usage table (older Hermes)
  executions: ExecutionRow[] | null; // null: no executions.db / table
  jobs: JobDef[] | null; // null: no jobs.json
  sources: { stateDb: SourceStatus; executionsDb: SourceStatus; jobsFile: SourceStatus };
}

function pick(cols: Set<string>, name: string, fallback: string, missing: string[], table: string): string {
  if (cols.has(name)) return name;
  missing.push(`${table}.${name}`);
  return fallback;
}

/**
 * Cron sessions: every session whose id has the cron prefix or whose source is 'cron',
 * plus every descendant through parent_session_id (compression continuations, delegated
 * subagents; attribution.ts decides which descendants belong to the run). Only metadata
 * and accounting columns are selected — never messages, prompts or titles.
 */
function readState(path: string, status: SourceStatus): Pick<HermesData, 'sessions' | 'usage'> {
  const { db, mode } = openReadOnly(path);
  status.mode = mode;
  const missing: string[] = (status.missing = []);
  try {
    const s = columnsOf(db, 'sessions');
    if (!s.has('id') || !s.has('started_at')) {
      missing.push('sessions');
      return { sessions: [], usage: null };
    }
    const c = (name: string, fallback = 'NULL') => pick(s, name, fallback, missing, 'sessions');
    const hasParent = s.has('parent_session_id');
    const rootCond = `(id LIKE 'cron\\_%' ESCAPE '\\'${s.has('source') ? ` OR source = 'cron'` : ''})`;
    const tree = hasParent
      ? `WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE ${rootCond}
           UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id)`
      : `WITH tree(id) AS (SELECT id FROM sessions WHERE ${rootCond})`;
    const sessions = db.prepare(`${tree}
      SELECT id, ${c('source')} AS source, ${c('parent_session_id')} AS parentId,
             started_at AS startedAt, ${c('end_reason')} AS endReason,
             ${c('model_config')} AS modelConfig,
             COALESCE(${c('input_tokens', '0')}, 0) AS input,
             COALESCE(${c('output_tokens', '0')}, 0) AS output,
             COALESCE(${c('cache_read_tokens', '0')}, 0) AS cacheRead,
             COALESCE(${c('cache_write_tokens', '0')}, 0) AS cacheWrite,
             COALESCE(${c('reasoning_tokens', '0')}, 0) AS reasoning,
             ${c('estimated_cost_usd')} AS estimatedCost,
             ${c('actual_cost_usd')} AS actualCost,
             ${c('cost_status')} AS costStatus
      FROM sessions WHERE id IN (SELECT id FROM tree)`).all() as unknown as SessionRow[];

    const u = columnsOf(db, 'session_model_usage');
    if (!u.has('session_id')) {
      missing.push('session_model_usage');
      return { sessions, usage: null };
    }
    const uc = (name: string, fallback = 'NULL') => pick(u, name, fallback, missing, 'session_model_usage');
    const usage = db.prepare(`
      SELECT session_id AS sessionId,
             COALESCE(${uc('input_tokens', '0')}, 0) AS input,
             COALESCE(${uc('output_tokens', '0')}, 0) AS output,
             COALESCE(${uc('cache_read_tokens', '0')}, 0) AS cacheRead,
             COALESCE(${uc('cache_write_tokens', '0')}, 0) AS cacheWrite,
             COALESCE(${uc('reasoning_tokens', '0')}, 0) AS reasoning,
             ${uc('estimated_cost_usd')} AS estimatedCost,
             ${uc('actual_cost_usd')} AS actualCost,
             ${uc('cost_status')} AS costStatus
      FROM session_model_usage
      WHERE session_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(sessions.map((x) => x.id))) as unknown as UsageRow[];
    return { sessions, usage };
  } finally {
    db.close();
  }
}

function readExecutions(path: string, status: SourceStatus): ExecutionRow[] | null {
  const { db, mode } = openReadOnly(path);
  status.mode = mode;
  try {
    const cols = columnsOf(db, 'executions');
    const need = ['job_id', 'status', 'claimed_at'].filter((n) => !cols.has(n));
    if (need.length) {
      status.missing = need.map((n) => (cols.size ? `executions.${n}` : 'executions'));
      return null;
    }
    const rows = db.prepare(`SELECT job_id AS jobId, status, claimed_at AS claimedAt FROM executions`)
      .all() as { jobId: string; status: string; claimedAt: string }[];
    // claimed_at is an ISO-8601 string with offset (hermes_time.now().isoformat()).
    return rows.map((r) => ({ jobId: r.jobId, status: r.status, claimedAt: Date.parse(r.claimedAt) / 1000 }));
  } finally {
    db.close();
  }
}

function readJobs(path: string): JobDef[] {
  const data = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  // Keep only id + name; prompts and delivery targets are never retained.
  return list.flatMap((j: any) =>
    j && typeof j.id === 'string' ? [{ id: j.id, name: typeof j.name === 'string' && j.name.trim() ? j.name : null }] : []);
}

export function readHermesData(home: string): HermesData {
  const stateDb: SourceStatus = { path: join(home, 'state.db'), found: false };
  const executionsDb: SourceStatus = { path: join(home, 'cron', 'executions.db'), found: false };
  const jobsFile: SourceStatus = { path: join(home, 'cron', 'jobs.json'), found: false };
  const data: HermesData = { sessions: [], usage: null, executions: null, jobs: null, sources: { stateDb, executionsDb, jobsFile } };

  const attempt = (status: SourceStatus, fn: () => void) => {
    if (!(status.found = existsSync(status.path))) return;
    try {
      fn();
    } catch (e) {
      status.error = (e as Error).message;
    }
  };
  attempt(stateDb, () => Object.assign(data, readState(stateDb.path, stateDb)));
  attempt(executionsDb, () => { data.executions = readExecutions(executionsDb.path, executionsDb); });
  attempt(jobsFile, () => { data.jobs = readJobs(jobsFile.path); });
  return data;
}
