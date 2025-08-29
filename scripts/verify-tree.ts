/**
 * Checking the shape of the source tree.
 *
 * Two rules, and both have caught real defects. Imports run one direction only,
 * util to domain to ingest to storage to service to report to api to cli, so a
 * rule cannot quietly start depending on a report. And every module has a test
 * file beside it, because a module nobody imports and nobody tests is a module
 * that will be wrong the first time somebody needs it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const LAYERS = ['util', 'domain', 'ingest', 'storage', 'service', 'report', 'api', 'cli'] as const;

type Layer = (typeof LAYERS)[number];

const ROOT = join(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'src');
const TESTS = join(ROOT, 'tests');

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
    } else if (entry.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

function layerOf(path: string): Layer | undefined {
  const parts = relative(SOURCE, path).split(sep);
  const first = parts[0];
  return (LAYERS as readonly string[]).includes(first ?? '') ? (first as Layer) : undefined;
}

function rankOf(layer: Layer): number {
  return LAYERS.indexOf(layer);
}

const IMPORT = /from '(\.\.?\/[^']+)'/g;

export interface Finding {
  readonly file: string;
  readonly problem: string;
}

export function checkImports(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const mine = layerOf(file);
    if (mine === undefined) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const target = match[1] as string;
      const parts = target.split('/');
      const named = parts.find((part) => (LAYERS as readonly string[]).includes(part));
      if (named === undefined) {
        continue;
      }
      const theirs = named as Layer;
      if (rankOf(theirs) > rankOf(mine)) {
        findings.push({
          file: relative(ROOT, file),
          problem: `${mine} imports ${theirs}, which is above it`,
        });
      }
    }
  }
  return findings;
}

export function checkTests(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const rest = relative(SOURCE, file);
    if (rest.endsWith('index.ts')) {
      continue;
    }
    const wanted = join(TESTS, rest.replace(/\.ts$/, '.test.ts'));
    try {
      statSync(wanted);
    } catch {
      findings.push({ file: relative(ROOT, file), problem: 'has no test file beside it' });
    }
  }
  return findings;
}

export function sourceFiles(): string[] {
  return walk(SOURCE);
}

export function layerNames(): readonly Layer[] {
  return LAYERS;
}

export function run(): number {
  const files = walk(SOURCE);
  const findings = [...checkImports(files), ...checkTests(files)];
  for (const finding of findings) {
    console.error(`${finding.file}: ${finding.problem}`);
  }
  console.log(`checked ${files.length} modules across ${LAYERS.length} layers`);
  if (findings.length > 0) {
    console.error(`${findings.length} problems`);
    return 1;
  }
  return 0;
}

/** Only run when this file is the thing that was invoked, so a test can import it. */
if ((process.argv[1] ?? '').includes('verify-tree')) {
  process.exitCode = run();
}
