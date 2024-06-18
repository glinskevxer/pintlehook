import { describe, expect, it } from 'vitest';
import {
  all,
  err,
  fail,
  flatMap,
  isErr,
  isOk,
  map,
  ok,
  problem,
  unwrap,
  withPath,
} from '../../src/util/result.js';

describe('ok and err', () => {
  it('wraps a value', () => {
    const r = ok(41);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(41);
  });

  it('refuses an empty problem list', () => {
    expect(() => err([])).toThrow(/at least one problem/);
  });

  it('keeps every problem it was given', () => {
    const r = err([problem('a', 'first'), problem('b', 'second')]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]!.code).toBe('a');
  });
});

describe('problem', () => {
  it('omits path when not given', () => {
    expect(problem('x', 'y')).toEqual({ code: 'x', message: 'y' });
  });

  it('keeps path when given', () => {
    expect(problem('x', 'y', 'row.3')).toEqual({ code: 'x', message: 'y', path: 'row.3' });
  });
});

describe('fail', () => {
  it('builds a single problem error', () => {
    const r = fail('bad_row', 'nope', 'touches.0');
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.path).toBe('touches.0');
  });
});

describe('guards', () => {
  it('narrows both ways', () => {
    const good = ok('v');
    const bad = fail('c', 'm');
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);
  });
});

describe('unwrap', () => {
  it('returns the value', () => {
    expect(unwrap(ok(7))).toBe(7);
  });

  it('throws with every problem in the message', () => {
    const r = err([problem('one', 'first'), problem('two', 'second')]);
    expect(() => unwrap(r)).toThrow(/one: first; two: second/);
  });
});

describe('map and flatMap', () => {
  it('maps a value', () => {
    expect(unwrap(map(ok(3), (n) => n * 2))).toBe(6);
  });

  it('leaves an error alone', () => {
    const r = map(fail('c', 'm'), (n: number) => n * 2);
    expect(r.ok).toBe(false);
  });

  it('chains', () => {
    const r = flatMap(ok(3), (n) => (n > 2 ? ok(n + 1) : fail('small', 'too small')));
    expect(unwrap(r)).toBe(4);
  });

  it('short circuits a chain', () => {
    const r = flatMap(fail('c', 'm'), () => ok(1));
    expect(isErr(r)).toBe(true);
  });
});

describe('all', () => {
  it('collects values in order', () => {
    expect(unwrap(all([ok(1), ok(2), ok(3)]))).toEqual([1, 2, 3]);
  });

  it('gathers every problem rather than stopping at the first', () => {
    const r = all([ok(1), fail('a', 'first'), ok(2), fail('b', 'second')]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems.map((p) => p.code)).toEqual(['a', 'b']);
    }
  });

  it('handles an empty list', () => {
    expect(unwrap(all<number>([]))).toEqual([]);
  });
});

describe('withPath', () => {
  it('sets a path that was missing', () => {
    const r = withPath(fail('c', 'm'), 'batch');
    expect(r.problems[0]!.path).toBe('batch');
  });

  it('prefixes a path that was present', () => {
    const r = withPath(fail('c', 'm', 'row.2'), 'batch');
    expect(r.problems[0]!.path).toBe('batch.row.2');
  });
});
