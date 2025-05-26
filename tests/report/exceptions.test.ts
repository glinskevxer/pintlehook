import { describe, expect, it } from 'vitest';
import type { ProgramException } from '../../src/domain/exception.js';
import {
  byKindReport,
  bySeverity,
  exceptionReport,
  oldestFirst,
  rowsOf,
  staleActions,
  subjectsNeedingAction,
} from '../../src/report/exceptions.js';
import { renderText } from '../../src/report/table.js';
import { day } from '../../src/util/clock.js';

const ASOF = day(2025, 6, 1);

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

const mixed: ProgramException[] = [
  exception({ kind: 'activation_pending', subject: 'a', raisedOn: day(2025, 5, 20) }),
  exception({ kind: 'unattributed_referral', subject: 'b', raisedOn: day(2025, 4, 1) }),
  exception({ kind: 'retention_failed', subject: 'c', raisedOn: day(2025, 3, 1) }),
  exception({ kind: 'recovery_stale', subject: 'd', raisedOn: day(2025, 5, 25) }),
];

describe('rowsOf', () => {
  it('orders action before review before note', () => {
    expect(rowsOf(mixed, ASOF).map((row) => row.severity)).toEqual([
      'action',
      'action',
      'review',
      'note',
    ]);
  });

  it('puts the older item first inside a severity', () => {
    const rows = rowsOf(mixed, ASOF);
    expect(rows[0]!.subject).toBe('c');
    expect(rows[1]!.subject).toBe('d');
  });

  it('ages each item to the day asked about', () => {
    const rows = rowsOf(mixed, ASOF);
    expect(rows.find((row) => row.subject === 'c')!.ageDays).toBe(92);
    expect(rows.find((row) => row.subject === 'a')!.ageDays).toBe(12);
  });

  it('stops ageing a cleared item', () => {
    const cleared = exception({
      subject: 'e',
      raisedOn: day(2025, 1, 1),
      clearedOn: day(2025, 1, 11),
    });
    expect(rowsOf([cleared], ASOF)[0]!.ageDays).toBe(10);
  });

  it('handles an empty list', () => {
    expect(rowsOf([], ASOF)).toEqual([]);
  });
});

describe('exceptionReport', () => {
  const report = exceptionReport(mixed, ASOF);

  it('names the day it was run for', () => {
    expect(report.title).toContain('2025-06-01');
  });

  it('counts what needs action', () => {
    expect(report.footnotes[0]).toBe('2 of 4 need action');
  });

  it('names the oldest open item', () => {
    expect(report.footnotes[1]).toBe('the oldest open item is 92 days old');
  });

  it('carries an age column', () => {
    expect(report.columns.map((column) => column.key)).toContain('age');
    expect(renderText(report)).toContain('92');
  });

  it('says so when there is nothing', () => {
    expect(renderText(exceptionReport([], ASOF))).toContain('(nothing to report)');
  });
});

describe('oldestFirst', () => {
  it('ignores severity and sorts purely on age', () => {
    const rows = oldestFirst(rowsOf(mixed, ASOF));
    expect(rows.map((row) => row.subject)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('breaks a tie on the subject', () => {
    const same = [
      exception({ subject: 'z', raisedOn: day(2025, 5, 1) }),
      exception({ subject: 'y', raisedOn: day(2025, 5, 1) }),
    ];
    expect(oldestFirst(rowsOf(same, ASOF)).map((row) => row.subject)).toEqual(['y', 'z']);
  });
});

describe('byKindReport', () => {
  it('counts each kind once', () => {
    const report = byKindReport(mixed);
    expect(report.rows).toHaveLength(4);
    expect(report.footnotes[0]).toBe('4 exceptions in total');
  });

  it('sorts the kinds', () => {
    const report = byKindReport(mixed);
    const kinds = report.rows.map((row) => row[0]);
    expect([...kinds].sort()).toEqual(kinds);
  });

  it('adds two of the same kind together', () => {
    const report = byKindReport([exception({ subject: 'a' }), exception({ subject: 'b' })]);
    expect(report.rows[0]![1]).toBe(2);
  });
});

describe('subjectsNeedingAction', () => {
  it('lists only the action subjects, deduplicated and sorted', () => {
    expect(subjectsNeedingAction(mixed)).toEqual(['c', 'd']);
  });

  it('leaves out anything cleared', () => {
    const cleared = exception({ subject: 'z', clearedOn: day(2025, 5, 10) });
    expect(subjectsNeedingAction([cleared])).toEqual([]);
  });
});

describe('bySeverity', () => {
  it('buckets the rows', () => {
    const buckets = bySeverity(rowsOf(mixed, ASOF));
    expect(buckets.get('action')).toHaveLength(2);
    expect(buckets.get('note')).toHaveLength(1);
  });
});

describe('staleActions', () => {
  it('keeps only the old action items', () => {
    const stale = staleActions(rowsOf(mixed, ASOF), 30);
    expect(stale.map((row) => row.subject)).toEqual(['c']);
  });

  it('is empty when nothing is old enough', () => {
    expect(staleActions(rowsOf(mixed, ASOF), 365)).toEqual([]);
  });

  it('ignores a review item however old', () => {
    const old = exception({
      kind: 'unattributed_referral',
      subject: 'b',
      raisedOn: day(2020, 1, 1),
    });
    expect(staleActions(rowsOf([old], ASOF), 30)).toEqual([]);
  });
});
