import { describe, expect, it } from 'vitest';
import { programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import {
  buildCatalog,
  describeCatalog,
  openPrograms,
  programById,
  rulesFor,
  scheduleFor,
  versionFor,
  type ScheduleBinding,
} from '../../src/service/catalog.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 6,
  qualifyingWindowDays: 120,
  retentionDays: 180,
  programYearCapMinor: 1_500_000,
  releaseCeilingMinor: 100_000,
  currency: 'USD',
};

const bronzeOnly: RewardSchedule = {
  currency: 'USD',
  tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 }],
};

const withSilver: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 30_000, marginShare: 0 },
    { name: 'silver', fromCount: 3, flatMinor: 45_000, marginShare: 100 },
  ],
};

const program: Program = {
  id: programId(1),
  name: 'owner operator referral',
  openedOn: day(2024, 1, 1),
  versions: [
    { version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'opening' },
    {
      version: 2,
      effectiveFrom: day(2024, 7, 1),
      rules: { ...rules, cureWindowDays: 30 },
      note: 'longer cure',
    },
  ],
};

const bindings: ScheduleBinding[] = [
  { program: programId(1), version: 1, schedule: bronzeOnly },
  { program: programId(1), version: 2, schedule: withSilver },
];

const catalog = unwrap(buildCatalog([program], bindings));

describe('buildCatalog', () => {
  it('accepts a catalogue where every version is bound', () => {
    expect(catalog.programs).toHaveLength(1);
    expect(catalog.bindings).toHaveLength(2);
  });

  it('refuses the same program twice', () => {
    const r = buildCatalog([program, program], bindings);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_program_repeated');
    }
  });

  it('refuses a version with no schedule', () => {
    const r = buildCatalog([program], [bindings[0]!]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_version_unbound');
    }
  });

  it('refuses a schedule bound to a program that is not here', () => {
    const stray: ScheduleBinding = { program: programId(9), version: 1, schedule: bronzeOnly };
    const r = buildCatalog([program], [...bindings, stray]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_binding_orphan');
    }
  });

  it('refuses a schedule bound to a version that is not here', () => {
    const stray: ScheduleBinding = { program: programId(1), version: 9, schedule: bronzeOnly };
    expect(isErr(buildCatalog([program], [...bindings, stray]))).toBe(true);
  });

  it('refuses the same binding twice', () => {
    const r = buildCatalog([program], [...bindings, bindings[0]!]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('catalog_binding_repeated');
    }
  });

  it('passes a program problem through', () => {
    const broken: Program = { ...program, versions: [] };
    expect(isErr(buildCatalog([broken], []))).toBe(true);
  });

  it('passes a schedule problem through', () => {
    const broken: RewardSchedule = { currency: 'USD', tiers: [] };
    const r = buildCatalog(
      [program],
      [{ program: programId(1), version: 1, schedule: broken }, bindings[1]!],
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_empty');
    }
  });

  it('accepts an empty catalogue', () => {
    expect(unwrap(buildCatalog([], [])).programs).toEqual([]);
  });
});

describe('reading the catalogue', () => {
  it('reads a program by identifier', () => {
    expect(unwrap(programById(catalog, programId(1))).name).toBe('owner operator referral');
    expect(isErr(programById(catalog, programId(9)))).toBe(true);
  });

  it('reads the version in force on a day', () => {
    expect(unwrap(versionFor(catalog, programId(1), day(2024, 6, 30))).version).toBe(1);
    expect(unwrap(versionFor(catalog, programId(1), day(2024, 7, 1))).version).toBe(2);
  });

  it('reads the rules in force on a day', () => {
    expect(unwrap(rulesFor(catalog, programId(1), day(2024, 6, 30))).cureWindowDays).toBe(21);
    expect(unwrap(rulesFor(catalog, programId(1), day(2024, 8, 1))).cureWindowDays).toBe(30);
  });

  it('reads the schedule bound to the version in force', () => {
    expect(unwrap(scheduleFor(catalog, programId(1), day(2024, 6, 30))).tiers).toHaveLength(1);
    expect(unwrap(scheduleFor(catalog, programId(1), day(2024, 8, 1))).tiers).toHaveLength(2);
  });

  it('fails before the program had any version', () => {
    expect(isErr(versionFor(catalog, programId(1), day(2023, 1, 1)))).toBe(true);
    expect(isErr(scheduleFor(catalog, programId(1), day(2023, 1, 1)))).toBe(true);
    expect(isErr(rulesFor(catalog, programId(1), day(2023, 1, 1)))).toBe(true);
  });

  it('fails for a program that is not here', () => {
    expect(isErr(scheduleFor(catalog, programId(9), day(2024, 8, 1)))).toBe(true);
  });
});

describe('openPrograms', () => {
  it('lists programs that had a version in force', () => {
    expect(openPrograms(catalog, day(2024, 8, 1))).toHaveLength(1);
    expect(openPrograms(catalog, day(2023, 1, 1))).toHaveLength(0);
  });
});

describe('describeCatalog', () => {
  it('counts what is in it', () => {
    expect(describeCatalog(catalog)).toBe('1 programs, 2 schedules');
  });
});
