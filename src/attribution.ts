// Linking Hermes sessions to cron jobs. Only mechanical relationships are used:
//  1. cron/scheduler.py run_job() names the run's session
//     f"cron_{job_id}_{now.strftime('%Y%m%d_%H%M%S')}", so the job id is everything between
//     the "cron_" prefix and the fixed-width 15-char timestamp suffix (job ids may contain "_").
//  2. Sessions spawned by that run point back via sessions.parent_session_id: compression
//     continuations (parent ended with end_reason='compression') and delegated subagents
//     (source='tool' or model_config._delegate_from = parent). User branches/resets are not
//     part of the run and are excluded.
// executions.db rows carry job_id but no session id, so executions are never matched to
// sessions one-to-one; they are only counted per job.
import type { SessionRow } from './hermes.ts';

const CRON_SESSION_ID = /^cron_(.+)_(\d{8}_\d{6})$/s;

export function parseCronSessionId(id: string): { jobId: string; stamp: string } | null {
  const m = CRON_SESSION_ID.exec(id);
  return m ? { jobId: m[1], stamp: m[2] } : null;
}

function lineageMarkers(modelConfig: string | null): Record<string, unknown> {
  if (!modelConfig) return {};
  try {
    const cfg = JSON.parse(modelConfig);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/** Whether `child` is part of the same cron run as `parent` (mirrors Hermes' lineage rules). */
export function belongsToRun(child: SessionRow, parent: SessionRow): boolean {
  const m = lineageMarkers(child.modelConfig);
  if (m._branched_from === parent.id || m._reset_from === parent.id) return false;
  if (child.source === 'tool' || m._delegate_from === parent.id) return true;
  return parent.endReason === 'compression';
}

export interface CronRun {
  root: SessionRow;
  jobId: string | null; // null: looks like a cron session but the id is not in the known format
  sessions: SessionRow[]; // root first, then linked descendants
}

/**
 * Group sessions into cron runs. A run's root is a session with the cron id prefix or
 * source 'cron' that is not itself a linked descendant of another run.
 */
export function buildRuns(sessions: SessionRow[]): CronRun[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map<string, SessionRow[]>();
  const linked = new Set<string>();
  for (const s of sessions) {
    const parent = s.parentId ? byId.get(s.parentId) : undefined;
    if (parent && belongsToRun(s, parent)) {
      linked.add(s.id);
      children.set(parent.id, [...(children.get(parent.id) ?? []), s]);
    }
  }
  const runs: CronRun[] = [];
  for (const s of sessions) {
    if (linked.has(s.id)) continue;
    const parsed = parseCronSessionId(s.id);
    if (!parsed && s.source !== 'cron') continue; // unlinked descendant (e.g. a user branch)
    const members: SessionRow[] = [];
    const stack = [s];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      members.push(cur);
      stack.push(...(children.get(cur.id) ?? []));
    }
    runs.push({ root: s, jobId: parsed?.jobId ?? null, sessions: members });
  }
  return runs;
}
