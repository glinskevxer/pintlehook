import { describe, expect, it } from 'vitest';
import {
  bodyCurrency,
  bodyText,
  pathValue,
  queryCurrency,
  queryDayOrToday,
  requiredBodyDay,
  requiredBodyText,
  requiredQueryValue,
} from '../../src/api/parse.js';
import { request } from '../../src/api/router.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);
const context: Context = unwrap(contextFor(Store.empty(), fixedClock(AT), 'UTC', 'desk'));

describe('bodyText', () => {
  it('reads a string and gives nothing for anything else', () => {
    expect(bodyText({ a: 'x' }, 'a')).toBe('x');
    expect(bodyText({ a: 41 }, 'a')).toBe('');
    expect(bodyText({}, 'a')).toBe('');
  });

  it('does not stringify an object into the answer', () => {
    expect(bodyText({ a: { nested: true } }, 'a')).toBe('');
  });
});

describe('requiredBodyText', () => {
  it('trims and refuses a blank', () => {
    expect(unwrap(requiredBodyText({ a: ' x ' }, 'a'))).toBe('x');
    const r = requiredBodyText({ a: '  ' }, 'a');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('a');
    }
  });
});

describe('requiredBodyDay', () => {
  it('reads a day', () => {
    expect(unwrap(requiredBodyDay({ on: '2025-03-09' }, 'on'))).toEqual(day(2025, 3, 9));
  });

  it('refuses a missing one and one it cannot read', () => {
    expect(isErr(requiredBodyDay({}, 'on'))).toBe(true);
    expect(isErr(requiredBodyDay({ on: 'soon' }, 'on'))).toBe(true);
  });
});

describe('queryDayOrToday', () => {
  it('defaults to the context clock', () => {
    expect(unwrap(queryDayOrToday(context, request(), 'on'))).toEqual(day(2025, 9, 1));
  });

  it('takes the day when the query carries one', () => {
    expect(
      unwrap(queryDayOrToday(context, request({ query: { on: '2025-01-02' } }), 'on')),
    ).toEqual(day(2025, 1, 2));
  });

  it('refuses one it cannot read rather than falling back to today', () => {
    expect(isErr(queryDayOrToday(context, request({ query: { on: 'soon' } }), 'on'))).toBe(true);
  });

  it('treats a blank as absent', () => {
    expect(unwrap(queryDayOrToday(context, request({ query: { on: '  ' } }), 'on'))).toEqual(
      day(2025, 9, 1),
    );
  });
});

describe('currencies', () => {
  it('default to the program currency and refuse one we do not carry', () => {
    expect(unwrap(queryCurrency(request(), 'currency'))).toBe('USD');
    expect(unwrap(queryCurrency(request({ query: { currency: 'CAD' } }), 'currency'))).toBe('CAD');
    expect(isErr(queryCurrency(request({ query: { currency: 'GBP' } }), 'currency'))).toBe(true);
  });

  it('read the same way off a body', () => {
    expect(unwrap(bodyCurrency({}, 'currency'))).toBe('USD');
    expect(unwrap(bodyCurrency({ currency: 'MXN' }, 'currency'))).toBe('MXN');
    expect(isErr(bodyCurrency({ currency: 'GBP' }, 'currency'))).toBe(true);
  });
});

describe('pathValue', () => {
  it('reads a path parameter and refuses a missing one', () => {
    expect(unwrap(pathValue({ name: 'aging' }, 'name'))).toBe('aging');
    expect(isErr(pathValue({}, 'name'))).toBe(true);
    expect(isErr(pathValue({ name: '  ' }, 'name'))).toBe(true);
  });
});

describe('requiredQueryValue', () => {
  it('reads a required query parameter', () => {
    expect(unwrap(requiredQueryValue(request({ query: { a: 'x' } }), 'a'))).toBe('x');
    expect(isErr(requiredQueryValue(request(), 'a'))).toBe(true);
  });
});
