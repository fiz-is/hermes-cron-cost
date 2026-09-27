#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { readHermesData, resolveHermesHome } from './hermes.ts';
import { buildReport, renderText } from './report.ts';

const HELP = `hermes-cron-cost — see what each Hermes cron job actually costs you.

Usage: hermes-cron-cost [options]

Options:
  --days <number>    Analysis window in days (default: 30)
  --profile <name>   Analyze a named Hermes profile (default: the active profile)
  --json             Print the report as JSON
  --help             Show this help
  --version          Show the version

Reads local Hermes data read-only. Never modifies Hermes, never uploads anything.`;

// node:sqlite is still flagged experimental on Node 22; its one-time warning is noise here.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

export function main(argv: string[]): number {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        days: { type: 'string', default: '30' },
        profile: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) return console.log(HELP), 0;
  if (values.version) return console.log(version), 0;

  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`--days must be a positive number (got ${JSON.stringify(values.days)})`);
    return 2;
  }
  let home;
  try {
    home = resolveHermesHome({ profile: values.profile });
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const data = readHermesData(home.home);
  const hermesHome = home.home.startsWith(homedir()) ? '~' + home.home.slice(homedir().length) : home.home;
  const report = buildReport(data, { days, profile: home.profile, hermesHome, version });
  console.log(values.json ? JSON.stringify(report, null, 2) : renderText(report));
  const nothing = !data.sources.stateDb.found && !data.sources.executionsDb.found;
  if (nothing && !values.json) {
    console.error(values.profile !== undefined
      ? `\nHermes profile "${home.profile}" not found (looked in ${home.home}).`
      : `\nNo Hermes installation found at ${home.home}. Set HERMES_HOME or pass --profile.`);
  }
  return nothing ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
