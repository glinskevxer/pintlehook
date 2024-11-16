import { describe, expect, it } from 'vitest';
import {
  isBlank,
  readBoolean,
  readCurrency,
  readDay,
  readInstant,
  readInteger,
  readMinorUnits,
  readOneOf,
  readOptionalText,
  readText,
  requireColumns,
} from '../../src/ingest/coerce.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('isBlank', () => {
  it('treats the words a partner uses for nothing as nothing', () => {
    for (const word of ['', ' ', '-', 'N/A', 'null', 'None', 'unknown']) {
      expect(isBlank(word)).toBe(true);
    }
  });

  it('treats a real value as present', () => {
    expect(isBlank('0')).toBe(false);
    expect(isBlank('no')).toBe(false);
  });

  it('treats a missing column as blank', () => {
    expect(isBlank(undefined)).toBe(true);
  });
});

describe('readText', () => {
  it('trims', () => {
    expect(unwrap(readText({ code: '  AB3  ' }, 'code'))).toBe('AB3');
  });

  it('fails on a blank and names the column', () => {
    const r = readText({ code: 'n/a' }, 'code');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('code');
      expect(r.problems[0]!.code).toBe('field_missing');
    }
  });
});

describe('readOptionalText', () => {
  it('gives nothing for a blank', () => {
    expect(readOptionalText({ note: '-' }, 'note')).toBeUndefined();
    expect(readOptionalText({}, 'note')).toBeUndefined();
  });

  it('gives the trimmed value otherwise', () => {
    expect(readOptionalText({ note: ' hi ' }, 'note')).toBe('hi');
  });
});

describe('readBoolean', () => {
  it('reads every spelling of yes', () => {
    for (const word of ['Y', 'yes', 'TRUE', 't', '1', 'on']) {
      expect(unwrap(readBoolean({ flag: word }, 'flag'))).toBe(true);
    }
  });

  it('reads every spelling of no', () => {
    for (const word of ['N', 'no', 'FALSE', 'f', '0', 'off']) {
      expect(unwrap(readBoolean({ flag: word }, 'flag'))).toBe(false);
    }
  });

  it('fails on a word it does not know', () => {
    const r = readBoolean({ flag: 'maybe' }, 'flag');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('field_not_boolean');
    }
  });
});

describe('readInteger', () => {
  it('strips thousands separators', () => {
    expect(unwrap(readInteger({ units: '1,240' }, 'units'))).toBe(1240);
  });

  it('reads a negative', () => {
    expect(unwrap(readInteger({ units: '-3' }, 'units'))).toBe(-3);
  });

  it('refuses a decimal', () => {
    expect(isErr(readInteger({ units: '1.5' }, 'units'))).toBe(true);
  });
});

describe('readMinorUnits', () => {
  it('reads dollars and cents', () => {
    expect(unwrap(readMinorUnits({ amount: '1,250.75' }, 'amount'))).toBe(125_075);
  });

  it('reads a dollar sign', () => {
    expect(unwrap(readMinorUnits({ amount: '$40' }, 'amount'))).toBe(4000);
  });

  it('reads one decimal place as tenths', () => {
    expect(unwrap(readMinorUnits({ amount: '40.5' }, 'amount'))).toBe(4050);
  });

  it('reads a leading minus', () => {
    expect(unwrap(readMinorUnits({ amount: '-12.34' }, 'amount'))).toBe(-1234);
  });

  it('reads the accounting bracket as a negative', () => {
    expect(unwrap(readMinorUnits({ amount: '(12.34)' }, 'amount'))).toBe(-1234);
  });

  it('reads a bracket around a minus as a positive', () => {
    expect(unwrap(readMinorUnits({ amount: '(-12.34)' }, 'amount'))).toBe(1234);
  });

  it('refuses three decimal places', () => {
    const r = readMinorUnits({ amount: '12.345' }, 'amount');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('field_not_money');
    }
  });

  it('refuses words', () => {
    expect(isErr(readMinorUnits({ amount: 'twelve' }, 'amount'))).toBe(true);
  });
});

describe('readCurrency', () => {
  it('upper cases', () => {
    expect(unwrap(readCurrency({ ccy: 'usd' }, 'ccy'))).toBe('USD');
  });

  it('refuses one we do not carry', () => {
    expect(isErr(readCurrency({ ccy: 'GBP' }, 'ccy'))).toBe(true);
  });
});

describe('readDay', () => {
  it('reads an iso day', () => {
    expect(unwrap(readDay({ on: '2025-03-09' }, 'on'))).toEqual(day(2025, 3, 9));
  });

  it('reads the american slash form', () => {
    expect(unwrap(readDay({ on: '3/9/2025' }, 'on'))).toEqual(day(2025, 3, 9));
    expect(unwrap(readDay({ on: '03/09/2025' }, 'on'))).toEqual(day(2025, 3, 9));
  });

  it('refuses a day that does not exist', () => {
    const r = readDay({ on: '2025-02-30' }, 'on');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('field_not_day');
    }
  });
});

describe('readInstant', () => {
  it('reads an iso instant', () => {
    expect(unwrap(readInstant({ at: '2025-03-09T14:20:00Z' }, 'at'))).toBe(
      Date.UTC(2025, 2, 9, 14, 20, 0),
    );
  });

  it('reads a space where the T should be', () => {
    expect(unwrap(readInstant({ at: '2025-03-09 14:20:00Z' }, 'at'))).toBe(
      Date.UTC(2025, 2, 9, 14, 20, 0),
    );
  });

  it('refuses an instant with no zone', () => {
    expect(isErr(readInstant({ at: '2025-03-09 14:20:00' }, 'at'))).toBe(true);
  });
});

describe('readOneOf', () => {
  const allowed = ['charged_to_carrier', 'absorbed'] as const;

  it('folds spaces and dashes to underscores', () => {
    expect(unwrap(readOneOf({ d: 'Charged to carrier' }, 'd', allowed))).toBe('charged_to_carrier');
    expect(unwrap(readOneOf({ d: 'charged-to-carrier' }, 'd', allowed))).toBe('charged_to_carrier');
  });

  it('refuses a word not on the list', () => {
    const r = readOneOf({ d: 'pending' }, 'd', allowed);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('field_not_allowed');
    }
  });
});

describe('requireColumns', () => {
  it('accepts a row with every column, even blank ones', () => {
    expect(isErr(requireColumns({ a: '', b: '1' }, ['a', 'b']))).toBe(false);
  });

  it('names every column that is missing', () => {
    const r = requireColumns({ a: '1' }, ['a', 'b', 'c']);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('b, c');
    }
  });
});
