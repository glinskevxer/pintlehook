import { describe, expect, it } from 'vitest';
import { isErr, unwrap } from '../../src/util/result.js';
import {
  codeAlphabet,
  formatReferralCode,
  mintReferralCode,
  normalizeCodeInput,
  parseDotNumber,
  parseMotorCarrierNumber,
  parseReferralCode,
  parseSurrogateId,
  surrogateId,
} from '../../src/util/ids.js';

describe('code alphabet', () => {
  it('leaves out the characters that sound alike', () => {
    const alphabet = codeAlphabet();
    for (const character of ['I', 'L', 'O', 'U']) {
      expect(alphabet).not.toContain(character);
    }
    expect(alphabet).toHaveLength(32);
  });
});

describe('normalizeCodeInput', () => {
  it('upper cases and strips separators', () => {
    expect(normalizeCodeInput('ab3-k9 z')).toBe('AB3K9Z');
  });

  it('folds the characters a driver would misread', () => {
    expect(normalizeCodeInput('ILOU')).toBe('110V');
  });
});

describe('mintReferralCode', () => {
  it('appends a check character', () => {
    const code = unwrap(mintReferralCode('AB3K9Z'));
    expect(code).toHaveLength(7);
    expect(code.startsWith('AB3K9Z')).toBe(true);
  });

  it('is deterministic', () => {
    expect(unwrap(mintReferralCode('AB3K9Z'))).toBe(unwrap(mintReferralCode('AB3K9Z')));
  });

  it('normalises before minting', () => {
    expect(unwrap(mintReferralCode('ab3-k9z'))).toBe(unwrap(mintReferralCode('AB3K9Z')));
  });

  it('refuses a body of the wrong length', () => {
    const r = mintReferralCode('AB3K9');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_code_length');
    }
  });
});

describe('parseReferralCode', () => {
  it('accepts a code it minted', () => {
    const code = unwrap(mintReferralCode('QW7X2M'));
    expect(unwrap(parseReferralCode(code))).toBe(code);
  });

  it('accepts a code typed with a separator', () => {
    const code = unwrap(mintReferralCode('QW7X2M'));
    expect(unwrap(parseReferralCode(formatReferralCode(code)))).toBe(code);
  });

  it('accepts a code where the driver typed the letter O for a zero', () => {
    const code = unwrap(mintReferralCode('0W7X2M'));
    expect(unwrap(parseReferralCode(code.replace('0', 'O')))).toBe(code);
  });

  it('rejects a single character transcription error', () => {
    const code = unwrap(mintReferralCode('QW7X2M'));
    const broken = `${code.slice(0, 2)}8${code.slice(3)}`;
    const r = parseReferralCode(broken);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_code_check');
    }
  });

  it('rejects a transposition of two adjacent characters', () => {
    const code = unwrap(mintReferralCode('QW7X2M'));
    const swapped = `${code[1] as string}${code[0] as string}${code.slice(2)}`;
    expect(isErr(parseReferralCode(swapped))).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(isErr(parseReferralCode('QW7X2'))).toBe(true);
  });
});

describe('formatReferralCode', () => {
  it('groups three and four', () => {
    expect(formatReferralCode('AB3K9ZQ')).toBe('AB3-K9ZQ');
  });
});

describe('motor carrier numbers', () => {
  it('accepts the printed form', () => {
    expect(unwrap(parseMotorCarrierNumber('MC-123456'))).toBe('MC123456');
    expect(unwrap(parseMotorCarrierNumber('mc 123456'))).toBe('MC123456');
    expect(unwrap(parseMotorCarrierNumber('123456'))).toBe('MC123456');
  });

  it('strips leading zeros so two spellings collapse', () => {
    expect(unwrap(parseMotorCarrierNumber('MC-0012345'))).toBe(
      unwrap(parseMotorCarrierNumber('MC-12345')),
    );
  });

  it('rejects letters and short numbers', () => {
    expect(isErr(parseMotorCarrierNumber('MC-12A456'))).toBe(true);
    expect(isErr(parseMotorCarrierNumber('MC-123'))).toBe(true);
  });
});

describe('dot numbers', () => {
  it('accepts several printed forms', () => {
    expect(unwrap(parseDotNumber('USDOT 3126540'))).toBe('3126540');
    expect(unwrap(parseDotNumber('DOT-3126540'))).toBe('3126540');
    expect(unwrap(parseDotNumber('3126540'))).toBe('3126540');
  });

  it('rejects junk', () => {
    expect(isErr(parseDotNumber('none on file'))).toBe(true);
  });
});

describe('surrogate identifiers', () => {
  it('pads to a fixed width so identifiers sort lexically', () => {
    expect(surrogateId('adv', 12)).toBe('adv_00000012');
    expect(surrogateId('adv', 9).localeCompare(surrogateId('adv', 10))).toBeLessThan(0);
  });

  it('refuses a bad prefix or sequence', () => {
    expect(() => surrogateId('ADV', 1)).toThrow(/lower case letters/);
    expect(() => surrogateId('adv', -1)).toThrow(/non negative integer/);
  });

  it('round trips', () => {
    expect(unwrap(parseSurrogateId(surrogateId('cxr', 4021)))).toEqual({
      prefix: 'cxr',
      sequence: 4021,
    });
  });

  it('rejects a foreign shape', () => {
    expect(isErr(parseSurrogateId('adv-12'))).toBe(true);
  });
});
