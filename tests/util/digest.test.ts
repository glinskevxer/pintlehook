import { describe, expect, it } from 'vitest';
import {
  digestKey,
  digestOf,
  digestOfParts,
  digestOfRecord,
  digestOfSequence,
  digestOfSet,
} from '../../src/util/digest.js';

describe('digestOf', () => {
  it('is stable for the same text', () => {
    expect(digestOf('MC123456')).toBe(digestOf('MC123456'));
  });

  it('is eight hexadecimal characters', () => {
    expect(digestOf('anything at all')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('separates texts that differ by one character', () => {
    expect(digestOf('MC123456')).not.toBe(digestOf('MC123457'));
  });

  it('has a digest for the empty string', () => {
    expect(digestOf('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('digestKey', () => {
  it('joins with a pipe', () => {
    expect(digestKey(['a', 'b'])).toBe('a|b');
  });

  it('escapes a pipe inside a part so two lists cannot collide', () => {
    expect(digestKey(['a|b', 'c'])).not.toBe(digestKey(['a', 'b|c']));
    expect(digestKey(['a|b'])).not.toBe(digestKey(['a', 'b']));
  });

  it('escapes the escape character so it cannot be forged', () => {
    expect(digestKey(['a~pb'])).not.toBe(digestKey(['a|b']));
  });

  it('marks a null and an undefined the same way', () => {
    expect(digestKey([null])).toBe(digestKey([undefined]));
    expect(digestKey([null])).not.toBe(digestKey(['~n']));
  });

  it('keeps numbers and booleans distinguishable from their spellings', () => {
    expect(digestKey([1])).toBe('1');
    expect(digestKey([true])).toBe('true');
  });
});

describe('digestOfParts', () => {
  it('depends on order', () => {
    expect(digestOfParts(['a', 'b'])).not.toBe(digestOfParts(['b', 'a']));
  });

  it('agrees with hashing the joined key', () => {
    expect(digestOfParts(['a', 1, false])).toBe(digestOf(digestKey(['a', 1, false])));
  });
});

describe('digestOfRecord', () => {
  it('does not depend on key insertion order', () => {
    expect(digestOfRecord({ code: 'x', at: 3 })).toBe(digestOfRecord({ at: 3, code: 'x' }));
  });

  it('changes when a value changes', () => {
    expect(digestOfRecord({ code: 'x' })).not.toBe(digestOfRecord({ code: 'y' }));
  });

  it('changes when a key is added', () => {
    expect(digestOfRecord({ code: 'x' })).not.toBe(digestOfRecord({ code: 'x', at: 1 }));
  });

  it('does not confuse a key with a value', () => {
    expect(digestOfRecord({ a: 'b' })).not.toBe(digestOfRecord({ b: 'a' }));
  });
});

describe('digestOfSequence and digestOfSet', () => {
  it('sequence depends on order', () => {
    expect(digestOfSequence(['1', '2'])).not.toBe(digestOfSequence(['2', '1']));
  });

  it('set does not depend on order', () => {
    expect(digestOfSet(['1', '2'])).toBe(digestOfSet(['2', '1']));
  });

  it('both handle an empty list', () => {
    expect(digestOfSequence([])).toBe(digestOf(''));
    expect(digestOfSet([])).toBe(digestOf(''));
  });
});
