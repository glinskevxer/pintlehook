import { describe, expect, it } from 'vitest';
import {
  currentSpell,
  firstEnrolmentDay,
  isEnrolledOn,
  programYearOf,
  reEnrol,
  spellCoveringDay,
  validateSpells,
  withdraw,
  type Advocate,
} from '../../src/domain/advocate.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const base: Advocate = {
  id: advocateId(1),
  carrier: carrierId(1),
  program: programId(1),
  referralCode: 'AB3K9ZQ',
  spells: [{ from: day(2024, 3, 4) }],
};

const twoSpells: Advocate = {
  ...base,
  spells: [
    { from: day(2023, 1, 10), until: day(2023, 9, 1), endReason: 'withdrew' },
    { from: day(2024, 3, 4) },
  ],
};

describe('isEnrolledOn', () => {
  it('covers the first day of a spell', () => {
    expect(isEnrolledOn(base, day(2024, 3, 4))).toBe(true);
  });

  it('does not cover the day before', () => {
    expect(isEnrolledOn(base, day(2024, 3, 3))).toBe(false);
  });

  it('treats an open spell as running through the day asked about', () => {
    expect(isEnrolledOn(base, day(2030, 1, 1))).toBe(true);
  });

  it('excludes the closing day of a closed spell', () => {
    expect(isEnrolledOn(twoSpells, day(2023, 9, 1))).toBe(false);
    expect(isEnrolledOn(twoSpells, day(2023, 8, 31))).toBe(true);
  });

  it('sees the gap between two spells', () => {
    expect(isEnrolledOn(twoSpells, day(2024, 1, 1))).toBe(false);
  });
});

describe('spellCoveringDay and currentSpell', () => {
  it('finds the spell that owns a day', () => {
    expect(spellCoveringDay(twoSpells, day(2023, 5, 1))!.endReason).toBe('withdrew');
  });

  it('returns nothing in a gap', () => {
    expect(spellCoveringDay(twoSpells, day(2024, 1, 1))).toBeUndefined();
  });

  it('finds the open spell', () => {
    expect(currentSpell(twoSpells)!.from).toEqual(day(2024, 3, 4));
  });

  it('returns nothing when every spell is closed', () => {
    const closed: Advocate = {
      ...base,
      spells: [{ from: day(2023, 1, 1), until: day(2023, 2, 1) }],
    };
    expect(currentSpell(closed)).toBeUndefined();
  });
});

describe('firstEnrolmentDay', () => {
  it('takes the earliest spell start', () => {
    expect(firstEnrolmentDay(twoSpells)).toEqual(day(2023, 1, 10));
  });

  it('returns nothing with no spells', () => {
    expect(firstEnrolmentDay({ ...base, spells: [] })).toBeUndefined();
  });
});

describe('programYearOf', () => {
  it('runs twelve months from the spell start', () => {
    const year = unwrap(programYearOf(base, day(2024, 5, 1)));
    expect(year.from).toEqual(day(2024, 3, 4));
    expect(year.until).toEqual(day(2025, 3, 4));
  });

  it('rolls to the next year on the anniversary', () => {
    const year = unwrap(programYearOf(base, day(2025, 3, 4)));
    expect(year.from).toEqual(day(2025, 3, 4));
    expect(year.until).toEqual(day(2026, 3, 4));
  });

  it('keeps the day before the anniversary in the first year', () => {
    expect(unwrap(programYearOf(base, day(2025, 3, 3))).from).toEqual(day(2024, 3, 4));
  });

  it('rolls several years forward', () => {
    expect(unwrap(programYearOf(base, day(2027, 6, 1))).from).toEqual(day(2027, 3, 4));
  });

  it('starts a fresh program year after a re enrolment', () => {
    const first = unwrap(programYearOf(twoSpells, day(2023, 5, 1)));
    const second = unwrap(programYearOf(twoSpells, day(2024, 5, 1)));
    expect(first.from).toEqual(day(2023, 1, 10));
    expect(second.from).toEqual(day(2024, 3, 4));
  });

  it('fails on a day the advocate was not enrolled', () => {
    const r = programYearOf(twoSpells, day(2024, 1, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('advocate_not_enrolled');
    }
  });
});

describe('validateSpells', () => {
  it('sorts and accepts a clean run', () => {
    const sortedSpells = unwrap(validateSpells(twoSpells.spells));
    expect(sortedSpells[0]!.from).toEqual(day(2023, 1, 10));
  });

  it('rejects an inverted spell', () => {
    expect(isErr(validateSpells([{ from: day(2024, 5, 1), until: day(2024, 4, 1) }]))).toBe(true);
  });

  it('rejects two open spells', () => {
    const r = validateSpells([{ from: day(2023, 1, 1) }, { from: day(2024, 1, 1) }]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('enrolment_two_open_spells');
    }
  });

  it('rejects overlapping spells', () => {
    const r = validateSpells([
      { from: day(2023, 1, 1), until: day(2023, 6, 1) },
      { from: day(2023, 5, 1), until: day(2023, 9, 1) },
    ]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('enrolment_spells_overlap');
    }
  });

  it('accepts spells that touch without overlapping', () => {
    const r = validateSpells([
      { from: day(2023, 1, 1), until: day(2023, 6, 1) },
      { from: day(2023, 6, 1), until: day(2023, 9, 1) },
    ]);
    expect(isErr(r)).toBe(false);
  });
});

describe('withdraw and reEnrol', () => {
  it('closes the open spell', () => {
    const after = unwrap(withdraw(base, day(2025, 1, 15), 'withdrew'));
    expect(after.spells[0]!.until).toEqual(day(2025, 1, 15));
    expect(after.spells[0]!.endReason).toBe('withdrew');
  });

  it('refuses to withdraw when nothing is open', () => {
    const closed = unwrap(withdraw(base, day(2025, 1, 15), 'withdrew'));
    expect(isErr(withdraw(closed, day(2025, 2, 1), 'suspended'))).toBe(true);
  });

  it('refuses to close a spell on the day it began', () => {
    expect(isErr(withdraw(base, day(2024, 3, 4), 'withdrew'))).toBe(true);
  });

  it('adds a fresh spell on re enrolment', () => {
    const closed = unwrap(withdraw(base, day(2025, 1, 15), 'withdrew'));
    const back = unwrap(reEnrol(closed, day(2025, 6, 1)));
    expect(back.spells).toHaveLength(2);
    expect(currentSpell(back)!.from).toEqual(day(2025, 6, 1));
  });

  it('refuses to re enrol somebody already enrolled', () => {
    expect(isErr(reEnrol(base, day(2025, 6, 1)))).toBe(true);
  });
});
