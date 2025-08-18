import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  catalogOrEmpty,
  catalogSummary,
  emptyCatalog,
  programIds,
  readCatalogFile,
  readCatalogText,
} from '../../src/cli/catalogFile.js';
import { programId } from '../../src/domain/identity.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const good = {
  programs: [
    {
      id: programId(1),
      name: 'owner operator referral',
      openedOn: '2024-01-01',
      versions: [
        {
          version: 1,
          effectiveFrom: '2024-01-01',
          note: 'opening',
          rules: {
            attributionWindowDays: 90,
            cureWindowDays: 21,
            qualifyingLoadCount: 6,
            qualifyingWindowDays: 120,
            retentionDays: 180,
            programYearCapMinor: 0,
            releaseCeilingMinor: 100000,
            currency: 'USD',
          },
          schedule: {
            currency: 'USD',
            tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25000, marginShare: 0 }],
          },
        },
      ],
    },
  ],
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pintlehook-catalog-'));
});

function write(value: unknown): string {
  const path = join(directory, 'catalog.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

describe('readCatalogText', () => {
  it('reads a good catalogue', () => {
    const catalog = unwrap(readCatalogText(JSON.stringify(good)));
    expect(catalog.programs).toHaveLength(1);
    expect(catalog.programs[0]!.openedOn).toEqual(day(2024, 1, 1));
    expect(catalog.bindings).toHaveLength(1);
  });

  it('binds every version to its own schedule', () => {
    const two = structuredClone(good);
    two.programs[0]!.versions.push({
      ...good.programs[0]!.versions[0]!,
      version: 2,
      effectiveFrom: '2025-01-01',
    });
    const catalog = unwrap(readCatalogText(JSON.stringify(two)));
    expect(catalog.bindings.map((binding) => binding.version)).toEqual([1, 2]);
  });

  it('reads an optional closing day', () => {
    const closed = structuredClone(good);
    closed.programs[0] = { ...closed.programs[0]!, closedOn: '2026-01-01' } as never;
    expect(unwrap(readCatalogText(JSON.stringify(closed))).programs[0]!.closedOn).toEqual(
      day(2026, 1, 1),
    );
  });

  it('refuses text that is not json', () => {
    const r = readCatalogText('not json');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_file_unparseable');
    }
  });

  it('refuses a file of the wrong shape and names the field', () => {
    const r = readCatalogText(JSON.stringify({ programs: [{ id: programId(1) }] }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_file_shape');
    }
  });

  it('refuses a program identifier of the wrong kind', () => {
    const wrong = { ...good, programs: [{ ...good.programs[0]!, id: 'cxr_00000001' }] };
    expect(isErr(readCatalogText(JSON.stringify(wrong)))).toBe(true);
  });

  it('refuses a day it cannot read', () => {
    const wrong = structuredClone(good);
    wrong.programs[0]!.openedOn = 'soon';
    expect(isErr(readCatalogText(JSON.stringify(wrong)))).toBe(true);
  });

  it('refuses a catalogue the api would refuse', () => {
    const wrong = structuredClone(good);
    wrong.programs[0]!.versions[0]!.effectiveFrom = '2023-01-01';
    const r = readCatalogText(JSON.stringify(wrong));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_version_before_open');
    }
  });

  it('refuses a schedule whose lowest tier does not start at one', () => {
    const wrong = structuredClone(good);
    wrong.programs[0]!.versions[0]!.schedule.tiers[0]!.fromCount = 2;
    expect(isErr(readCatalogText(JSON.stringify(wrong)))).toBe(true);
  });

  it('reads an empty program list', () => {
    expect(unwrap(readCatalogText(JSON.stringify({ programs: [] }))).programs).toEqual([]);
  });
});

describe('readCatalogFile', () => {
  it('reads one off disk', () => {
    expect(unwrap(readCatalogFile(write(good))).programs).toHaveLength(1);
  });

  it('says so when there is no file there', () => {
    const r = readCatalogFile(join(directory, 'missing.json'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_file_missing');
    }
  });
});

describe('helpers', () => {
  it('gives an empty catalogue when no path was passed', () => {
    expect(unwrap(catalogOrEmpty(undefined)).programs).toEqual([]);
    expect(unwrap(emptyCatalog()).programs).toEqual([]);
  });

  it('reads a path when one was passed', () => {
    expect(unwrap(catalogOrEmpty(write(good))).programs).toHaveLength(1);
  });

  it('counts and lists what it holds', () => {
    const catalog = unwrap(readCatalogText(JSON.stringify(good)));
    expect(catalogSummary(catalog)).toBe('1 programs, 1 schedules');
    expect(programIds(catalog)).toEqual([programId(1)]);
  });
});
