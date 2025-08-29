import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkImports, checkTests, layerNames, sourceFiles } from '../../scripts/verify-tree.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');

function plant(layer: string, name: string, lines: readonly string[]): string {
  const path = join(SRC, layer, name);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

describe('the source tree', () => {
  it('holds modules in every layer', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(60);
    for (const layer of layerNames()) {
      expect(files.some((file) => file.includes(layer))).toBe(true);
    }
  });

  it('names eight layers in order', () => {
    expect(layerNames()).toEqual([
      'util',
      'domain',
      'ingest',
      'storage',
      'service',
      'report',
      'api',
      'cli',
    ]);
  });
});

describe('the import direction rule', () => {
  it('finds nothing wrong with this tree', () => {
    expect(checkImports(sourceFiles())).toEqual([]);
  });

  it('catches a module importing a layer above it', () => {
    const planted = plant('util', 'planted-upward.ts', [
      "import type { Store } from '../storage/store.js';",
      'export type Held = Store;',
    ]);
    try {
      const findings = checkImports([planted]);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.problem).toContain('util imports storage');
    } finally {
      rmSync(planted);
    }
  });

  it('leaves a downward import alone', () => {
    const planted = plant('service', 'planted-downward.ts', [
      "import { money } from '../util/money.js';",
      'export const held = money;',
    ]);
    try {
      expect(checkImports([planted])).toEqual([]);
    } finally {
      rmSync(planted);
    }
  });

  it('leaves an import inside one layer alone', () => {
    const planted = plant('domain', 'planted-sideways.ts', [
      "import { money } from '../util/money.js';",
      "import type { Tier } from './schedule.js';",
      'export type Held = Tier;',
      'export const held = money;',
    ]);
    try {
      expect(checkImports([planted])).toEqual([]);
    } finally {
      rmSync(planted);
    }
  });
});

describe('the test coverage rule', () => {
  it('finds a test file beside every module', () => {
    expect(checkTests(sourceFiles())).toEqual([]);
  });

  it('catches a module with no test beside it', () => {
    const planted = plant('util', 'planted-untested.ts', ['export const held = 1;']);
    try {
      const findings = checkTests([planted]);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.problem).toContain('no test file');
    } finally {
      rmSync(planted);
    }
  });
});
