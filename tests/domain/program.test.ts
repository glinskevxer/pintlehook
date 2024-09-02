import { describe, expect, it } from 'vitest';
import { programId } from '../../src/domain/identity.js';
import {
  isOpenOn,
  orderedVersions,
  rulesOn,
  validateProgram,
  validateRules,
  versionOn,
  type Program,
  type ProgramRules,
} from '../../src/domain/program.js';
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

const program: Program = {
  id: programId(1),
  name: 'owner operator referral',
  openedOn: day(2024, 1, 1),
  versions: [
    { version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'opening rules' },
    {
      version: 2,
      effectiveFrom: day(2024, 7, 1),
      rules: { ...rules, cureWindowDays: 30, qualifyingLoadCount: 4 },
      note: 'insurance desk asked for a longer cure',
    },
  ],
};

describe('orderedVersions', () => {
  it('sorts by effective day', () => {
    const shuffled: Program = { ...program, versions: [...program.versions].reverse() };
    expect(orderedVersions(shuffled).map((v) => v.version)).toEqual([1, 2]);
  });
});

describe('versionOn', () => {
  it('takes the version in force on the day', () => {
    expect(unwrap(versionOn(program, day(2024, 6, 30))).version).toBe(1);
    expect(unwrap(versionOn(program, day(2024, 7, 1))).version).toBe(2);
    expect(unwrap(versionOn(program, day(2025, 1, 1))).version).toBe(2);
  });

  it('fails before the first version takes effect', () => {
    const r = versionOn(program, day(2023, 12, 31));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_no_version');
    }
  });
});

describe('rulesOn', () => {
  it('returns the rules of the version in force', () => {
    expect(unwrap(rulesOn(program, day(2024, 3, 1))).cureWindowDays).toBe(21);
    expect(unwrap(rulesOn(program, day(2024, 8, 1))).cureWindowDays).toBe(30);
  });

  it('passes the failure through', () => {
    expect(isErr(rulesOn(program, day(2020, 1, 1)))).toBe(true);
  });
});

describe('isOpenOn', () => {
  it('opens on the opening day', () => {
    expect(isOpenOn(program, day(2024, 1, 1))).toBe(true);
    expect(isOpenOn(program, day(2023, 12, 31))).toBe(false);
  });

  it('closes on the closing day, exclusive', () => {
    const closed: Program = { ...program, closedOn: day(2025, 1, 1) };
    expect(isOpenOn(closed, day(2024, 12, 31))).toBe(true);
    expect(isOpenOn(closed, day(2025, 1, 1))).toBe(false);
  });
});

describe('validateProgram', () => {
  it('accepts a good program', () => {
    expect(unwrap(validateProgram(program))).toEqual(program);
  });

  it('rejects a program with no versions', () => {
    expect(isErr(validateProgram({ ...program, versions: [] }))).toBe(true);
  });

  it('rejects a close before the open', () => {
    const r = validateProgram({ ...program, closedOn: day(2023, 1, 1) });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_closed_before_open');
    }
  });

  it('rejects a repeated version number', () => {
    const twice: Program = {
      ...program,
      versions: [program.versions[0]!, { ...program.versions[1]!, version: 1 }],
    };
    const r = validateProgram(twice);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_version_repeated');
    }
  });

  it('rejects a version taking effect before the program opened', () => {
    const early: Program = {
      ...program,
      versions: [{ ...program.versions[0]!, effectiveFrom: day(2023, 6, 1) }],
    };
    expect(isErr(validateProgram(early))).toBe(true);
  });

  it('rejects two versions on the same day', () => {
    const clash: Program = {
      ...program,
      versions: [program.versions[0]!, { ...program.versions[1]!, effectiveFrom: day(2024, 1, 1) }],
    };
    const r = validateProgram(clash);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_versions_same_day');
    }
  });

  it('passes a rule problem through', () => {
    const broken: Program = {
      ...program,
      versions: [{ ...program.versions[0]!, rules: { ...rules, cureWindowDays: 0 } }],
    };
    const r = validateProgram(broken);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_rule_not_positive');
    }
  });
});

describe('validateRules', () => {
  it('accepts good rules', () => {
    expect(unwrap(validateRules(rules))).toEqual(rules);
  });

  it('rejects a zero or fractional window', () => {
    expect(isErr(validateRules({ ...rules, attributionWindowDays: 0 }))).toBe(true);
    expect(isErr(validateRules({ ...rules, retentionDays: 1.5 }))).toBe(true);
  });

  it('rejects a negative cap', () => {
    const r = validateRules({ ...rules, programYearCapMinor: -1 });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('program_rule_negative');
    }
  });

  it('allows a zero cap, which means no cap was set', () => {
    expect(isErr(validateRules({ ...rules, programYearCapMinor: 0 }))).toBe(false);
  });
});
