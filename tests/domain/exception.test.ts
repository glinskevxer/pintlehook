import { describe, expect, it } from 'vitest';
import {
  ageInDays,
  clear,
  countByKind,
  describeException,
  exceptionKey,
  exceptionOrder,
  isOpen,
  latestPerSubject,
  needsAction,
  openOnly,
  severityOf,
  type ExceptionKind,
  type ProgramException,
} from '../../src/domain/exception.js';
import { day } from '../../src/util/clock.js';
import { sorted } from '../../src/util/ordering.js';
import { isErr, unwrap } from '../../src/util/result.js';

function exception(overrides: Partial<ProgramException> = {}): ProgramException {
  return {
    kind: 'retention_failed',
    subject: 'cxr_00000009',
    raisedOn: day(2025, 5, 1),
    detail: 'empty checkpoint',
    clearedOn: undefined,
    ...overrides,
  };
}

describe('severity', () => {
  it('puts a retention failure on the action list', () => {
    expect(severityOf('retention_failed')).toBe('action');
    expect(needsAction(exception())).toBe(true);
  });

  it('puts a pending activation on the note list', () => {
    expect(severityOf('activation_pending')).toBe('note');
    expect(needsAction(exception({ kind: 'activation_pending' }))).toBe(false);
  });

  it('does not put a cleared exception on the action list', () => {
    const cleared = unwrap(clear(exception(), day(2025, 5, 10)));
    expect(needsAction(cleared)).toBe(false);
  });
});

describe('isOpen and clear', () => {
  it('is open until it is cleared', () => {
    expect(isOpen(exception())).toBe(true);
    expect(isOpen(unwrap(clear(exception(), day(2025, 5, 10))))).toBe(false);
  });

  it('refuses to clear twice', () => {
    const cleared = unwrap(clear(exception(), day(2025, 5, 10)));
    const r = clear(cleared, day(2025, 5, 20));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('exception_already_cleared');
    }
  });

  it('refuses a clearing date before it was raised', () => {
    const r = clear(exception(), day(2025, 4, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('exception_cleared_before_raised');
    }
  });

  it('allows clearing on the day it was raised', () => {
    expect(isErr(clear(exception(), day(2025, 5, 1)))).toBe(false);
  });
});

describe('exceptionKey', () => {
  it('is the kind and the subject together', () => {
    expect(exceptionKey(exception({ raisedOn: day(2026, 1, 1) }))).toBe(exceptionKey(exception()));
    expect(exceptionKey(exception({ subject: 'other' }))).not.toBe(exceptionKey(exception()));
    expect(exceptionKey(exception({ kind: 'claim_charged_back' }))).not.toBe(
      exceptionKey(exception()),
    );
  });
});

describe('exceptionOrder', () => {
  it('puts action before review before note', () => {
    const list = [
      exception({ kind: 'activation_pending' }),
      exception({ kind: 'unattributed_referral' }),
      exception({ kind: 'retention_failed' }),
    ];
    expect(sorted(list, exceptionOrder).map((e) => severityOf(e.kind))).toEqual([
      'action',
      'review',
      'note',
    ]);
  });

  it('orders equal severity by the day it was raised', () => {
    const older = exception({ raisedOn: day(2025, 1, 1) });
    expect(sorted([exception(), older], exceptionOrder)[0]!.raisedOn).toEqual(day(2025, 1, 1));
  });

  it('breaks a full tie on the subject', () => {
    const a = exception({ subject: 'aaa' });
    const b = exception({ subject: 'bbb' });
    expect(sorted([b, a], exceptionOrder)[0]!.subject).toBe('aaa');
  });
});

describe('openOnly', () => {
  it('drops the cleared ones and sorts the rest', () => {
    const cleared = unwrap(clear(exception({ subject: 'cleared' }), day(2025, 5, 5)));
    const open = openOnly([cleared, exception({ kind: 'activation_pending' }), exception()]);
    expect(open).toHaveLength(2);
    expect(open[0]!.kind).toBe('retention_failed');
  });
});

describe('countByKind', () => {
  it('counts every kind it saw', () => {
    const counts = countByKind([
      exception(),
      exception({ subject: 'other' }),
      exception({ kind: 'settlement_held' }),
    ]);
    expect(counts.get('retention_failed')).toBe(2);
    expect(counts.get('settlement_held')).toBe(1);
    expect(counts.get('recovery_stale' as ExceptionKind)).toBeUndefined();
  });
});

describe('ageInDays', () => {
  it('counts to today while it is open', () => {
    expect(ageInDays(exception(), day(2025, 5, 31))).toBe(30);
  });

  it('stops counting once it is cleared', () => {
    const cleared = unwrap(clear(exception(), day(2025, 5, 11)));
    expect(ageInDays(cleared, day(2025, 8, 1))).toBe(10);
  });

  it('never goes negative', () => {
    expect(ageInDays(exception(), day(2025, 1, 1))).toBe(0);
  });
});

describe('latestPerSubject', () => {
  it('keeps one per subject and kind', () => {
    const first = exception({ raisedOn: day(2025, 5, 1), detail: 'first' });
    const second = exception({ raisedOn: day(2025, 6, 1), detail: 'second' });
    const folded = latestPerSubject([first, second]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.detail).toBe('second');
  });

  it('keeps two subjects apart', () => {
    expect(latestPerSubject([exception(), exception({ subject: 'other' })])).toHaveLength(2);
  });

  it('does not double a replayed feed', () => {
    const once = latestPerSubject([exception(), exception({ subject: 'other' })]);
    const twice = latestPerSubject([
      exception(),
      exception({ subject: 'other' }),
      exception(),
      exception({ subject: 'other' }),
    ]);
    expect(twice).toHaveLength(once.length);
  });
});

describe('describeException', () => {
  it('says whether it is open', () => {
    expect(describeException(exception())).toContain('open');
    expect(describeException(unwrap(clear(exception(), day(2025, 6, 1))))).toContain('cleared');
  });
});
