/**
 * The gate that runs before anything ships.
 *
 * Every check here is one that has been wrong at some point: a coverage floor
 * that quietly slipped, a dependency added without anybody noticing, a report
 * registered but unreachable, a route with no summary. The point of the list is
 * that it is checked rather than remembered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allRoutes } from '../src/api/app.js';
import { definitions, reportNames } from '../src/report/registry.js';
import { EVENT_KINDS, requiredFields } from '../src/storage/events.js';

const ROOT = join(import.meta.dirname, '..');

export const STATEMENT_FLOOR = 94;
export const BRANCH_FLOOR = 90;
export const ALLOWED_DEPENDENCIES = ['commander', 'zod'];

export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

function result(name: string, passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

export function checkDependencies(): CheckResult {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const found = Object.keys(manifest.dependencies ?? {}).sort();
  const unexpected = found.filter((name) => !ALLOWED_DEPENDENCIES.includes(name));
  return result(
    'runtime dependencies',
    unexpected.length === 0,
    unexpected.length === 0 ? found.join(', ') : `unexpected: ${unexpected.join(', ')}`,
  );
}

export function checkPinnedVersions(): CheckResult {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  const loose = Object.entries(all)
    .filter(([, range]) => !/^\d+\.\d+\.\d+$/.test(range))
    .map(([name]) => name);
  return result(
    'versions pinned',
    loose.length === 0,
    loose.length === 0 ? `${Object.keys(all).length} pinned` : `not pinned: ${loose.join(', ')}`,
  );
}

export function checkRouteSummaries(): CheckResult {
  const bare = allRoutes.filter((route) => route.summary.trim().length < 10);
  return result(
    'every route explains itself',
    bare.length === 0,
    bare.length === 0
      ? `${allRoutes.length} routes`
      : `bare: ${bare.map((r) => r.path).join(', ')}`,
  );
}

export function checkReportsReachable(): CheckResult {
  const names = reportNames();
  const missing = definitions().filter((definition) => !names.includes(definition.name));
  return result(
    'every report is reachable by name',
    missing.length === 0,
    `${names.length} reports`,
  );
}

export function checkEventFields(): CheckResult {
  const bare = EVENT_KINDS.filter((kind) => requiredFields(kind).length === 0);
  return result(
    'every event names its required fields',
    bare.length === 0,
    `${EVENT_KINDS.length} event kinds`,
  );
}

export function checkCoverage(): CheckResult {
  let summary: { total?: { statements?: { pct?: number }; branches?: { pct?: number } } };
  try {
    summary = JSON.parse(
      readFileSync(join(ROOT, 'coverage', 'coverage-summary.json'), 'utf8'),
    ) as typeof summary;
  } catch {
    return result('coverage floors', false, 'no coverage summary, run npm run coverage first');
  }
  const statements = summary.total?.statements?.pct ?? 0;
  const branches = summary.total?.branches?.pct ?? 0;
  const passed = statements >= STATEMENT_FLOOR && branches >= BRANCH_FLOOR;
  return result(
    'coverage floors',
    passed,
    `statements ${statements} against ${STATEMENT_FLOOR}, branches ${branches} against ${BRANCH_FLOOR}`,
  );
}

export function checksWithoutCoverage(): CheckResult[] {
  return [
    checkDependencies(),
    checkPinnedVersions(),
    checkRouteSummaries(),
    checkReportsReachable(),
    checkEventFields(),
  ];
}

export function run(withCoverage: boolean): number {
  const checks = withCoverage
    ? [...checksWithoutCoverage(), checkCoverage()]
    : checksWithoutCoverage();
  let failed = 0;
  for (const check of checks) {
    console.log(`${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
    if (!check.passed) {
      failed += 1;
    }
  }
  return failed === 0 ? 0 : 1;
}

if ((process.argv[1] ?? '').includes('release-check')) {
  process.exitCode = run(!process.argv.includes('--no-coverage'));
}
