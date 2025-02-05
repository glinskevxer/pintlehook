import { describe, expect, it } from 'vitest';
import {
  NO_DAY,
  TABLE_NAMES,
  dayText,
  flagKey,
  isEnrolledRow,
  isOpenFlag,
  readDayText,
  requireDayText,
  type AdvocateRow,
  type FlagRow,
} from '../../src/storage/rows.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('table names', () => {
  it('has no repeats', () => {
    expect(new Set(TABLE_NAMES).size).toBe(TABLE_NAMES.length);
  });

  it('covers everything the fold writes', () => {
    expect(TABLE_NAMES).toContain('accruals');
    expect(TABLE_NAMES).toContain('referrals');
    expect(TABLE_NAMES).toContain('flags');
  });
});

describe('dayText', () => {
  it('writes a day', () => {
    expect(dayText(day(2025, 3, 9))).toBe('2025-03-09');
  });

  it('writes nothing for a day that is not there', () => {
    expect(dayText(undefined)).toBe(NO_DAY);
  });
});

describe('readDayText', () => {
  it('reads a day back', () => {
    expect(unwrap(readDayText('2025-03-09', 'qualifiedOn'))).toEqual(day(2025, 3, 9));
  });

  it('reads an empty string as nothing', () => {
    expect(unwrap(readDayText(NO_DAY, 'qualifiedOn'))).toBeUndefined();
  });

  it('refuses text that is not a day and names the field', () => {
    const r = readDayText('soon', 'qualifiedOn');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('qualifiedOn');
    }
  });

  it('round trips', () => {
    const original = day(2024, 2, 29);
    expect(unwrap(readDayText(dayText(original), 'x'))).toEqual(original);
  });
});

describe('requireDayText', () => {
  it('accepts a day', () => {
    expect(unwrap(requireDayText('2025-03-09', 'recordedOn'))).toEqual(day(2025, 3, 9));
  });

  it('refuses an empty string', () => {
    const r = requireDayText(NO_DAY, 'recordedOn');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('row_day_missing');
    }
  });

  it('refuses text that is not a day', () => {
    expect(isErr(requireDayText('soon', 'recordedOn'))).toBe(true);
  });
});

describe('flagKey', () => {
  it('joins the advocate and the flag', () => {
    expect(flagKey('adv_1', 'w9_missing')).toBe('adv_1:w9_missing');
  });

  it('keeps two flags on one advocate apart', () => {
    expect(flagKey('adv_1', 'a')).not.toBe(flagKey('adv_1', 'b'));
  });
});

describe('isOpenFlag', () => {
  const flag: FlagRow = {
    key: 'adv_1:w9',
    advocate: 'adv_1',
    flag: 'w9',
    raisedOn: '2025-03-01',
    clearedOn: NO_DAY,
  };

  it('is open with no clearing day', () => {
    expect(isOpenFlag(flag)).toBe(true);
  });

  it('is closed once cleared', () => {
    expect(isOpenFlag({ ...flag, clearedOn: '2025-04-01' })).toBe(false);
  });
});

describe('isEnrolledRow', () => {
  const advocate: AdvocateRow = {
    id: 'adv_1',
    carrier: 'cxr_1',
    program: 'prg_1',
    referralCode: 'AB3K9ZQ',
    enrolledFrom: '2025-01-01',
    enrolledUntil: NO_DAY,
    endReason: '',
  };

  it('is enrolled with no end day', () => {
    expect(isEnrolledRow(advocate)).toBe(true);
  });

  it('is not enrolled once the spell closed', () => {
    expect(isEnrolledRow({ ...advocate, enrolledUntil: '2025-06-01' })).toBe(false);
  });
});
