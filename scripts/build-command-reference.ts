/**
 * Generating the command and route reference from the code that defines them.
 *
 * Hand written command documentation is wrong within a month. This walks the
 * commander program and the api route table and writes what is actually there,
 * and the check mode fails the build when the committed file has drifted, so
 * the drift is caught by the pull request rather than by a reader.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allRoutes } from '../src/api/app.js';
import { buildProgram } from '../src/cli/entry.js';
import { RecordingSink } from '../src/cli/output.js';
import { definitions } from '../src/report/registry.js';

const ROOT = join(import.meta.dirname, '..');
export const REFERENCE_PATH = join(ROOT, 'docs', 'reference.md');

export function commandLines(): string[] {
  const program = buildProgram(new RecordingSink(), () => undefined);
  const lines = ['## commands', ''];
  for (const command of program.commands) {
    const options = command.options
      .map((option) => option.flags)
      .sort()
      .join(', ');
    lines.push(`### ${command.name()}`);
    lines.push('');
    lines.push(command.description());
    lines.push('');
    if (options !== '') {
      lines.push(`Options: ${options}`);
      lines.push('');
    }
  }
  return lines;
}

export function routeLines(): string[] {
  const lines = ['## api routes', '', '| method | path | what it does |', '| --- | --- | --- |'];
  const sorted = [...allRoutes].sort((left, right) =>
    left.path === right.path
      ? left.method.localeCompare(right.method)
      : left.path.localeCompare(right.path),
  );
  for (const route of sorted) {
    lines.push(`| ${route.method} | ${route.path} | ${route.summary} |`);
  }
  lines.push('');
  return lines;
}

export function reportLines(): string[] {
  const lines = [
    '## reports',
    '',
    '| name | what it shows | needs an advocate |',
    '| --- | --- | --- |',
  ];
  for (const definition of definitions()) {
    lines.push(
      `| ${definition.name} | ${definition.summary} | ${definition.needsAdvocate ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  return lines;
}

export function buildReference(): string {
  return [
    '# reference',
    '',
    'This file is generated from the code by `npm run commands`. Do not edit it.',
    '',
    ...commandLines(),
    ...routeLines(),
    ...reportLines(),
  ].join('\n');
}

export function currentReference(): string {
  try {
    return readFileSync(REFERENCE_PATH, 'utf8');
  } catch {
    return '';
  }
}

export function run(check: boolean): number {
  const wanted = buildReference();
  if (check) {
    if (currentReference() !== wanted) {
      console.error('docs/reference.md is out of date, run npm run commands');
      return 1;
    }
    console.log('docs/reference.md is up to date');
    return 0;
  }
  writeFileSync(REFERENCE_PATH, wanted, 'utf8');
  console.log(`wrote ${REFERENCE_PATH}`);
  return 0;
}

if ((process.argv[1] ?? '').includes('build-command-reference')) {
  process.exitCode = run(process.argv.includes('--check'));
}
