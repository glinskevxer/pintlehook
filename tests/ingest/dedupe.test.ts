import { describe, expect, it } from 'vitest';
import {
  candidateOrder,
  countByReason,
  dedupe,
  duplicateRate,
  type DedupeCandidate,
} from '../../src/ingest/dedupe.js';
import { sorted } from '../../src/util/ordering.js';
import { isErr, unwrap } from '../../src/util/result.js';

const base = Date.UTC(2025, 2, 15, 12, 0, 0);
const SECOND = 1000;

interface Event {
  readonly id: string;
  readonly natural: string;
  readonly collapse: string;
  readonly at: number;
  readonly strength: number;
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    natural: 'n1',
    collapse: 'adv1:cxr9',
    at: base,
    strength: 1,
    ...overrides,
  };
}

const read = (e: Event): DedupeCandidate => ({
  naturalKey: e.natural,
  collapseKey: e.collapse,
  at: e.at,
  sourceReference: e.id,
  strength: e.strength,
});

function run(events: Event[], tolerance = 30 * SECOND) {
  return unwrap(dedupe(events, read, tolerance));
}

describe('exact duplicates', () => {
  it('drops the second copy of the same natural key', () => {
    const result = run([event(), event({ id: 'e2' })]);
    expect(result.kept).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.reason).toBe('exact');
  });

  it('keeps two different natural keys far apart in time', () => {
    const result = run([event(), event({ id: 'e2', natural: 'n2', at: base + 3600 * SECOND })]);
    expect(result.kept).toHaveLength(2);
  });

  it('drops a rerun of a whole delivery', () => {
    const delivery = [
      event({ id: 'a', natural: 'n1', at: base }),
      event({ id: 'b', natural: 'n2', at: base + 600 * SECOND }),
      event({ id: 'c', natural: 'n3', at: base + 1200 * SECOND }),
    ];
    const result = run([...delivery, ...delivery.map((e) => ({ ...e, id: `${e.id}2` }))]);
    expect(result.kept).toHaveLength(3);
    expect(countByReason(result).exact).toBe(3);
  });
});

describe('near duplicates', () => {
  it('collapses two sources writing the same handshake seconds apart', () => {
    const result = run([
      event({ id: 'fuel', natural: 'n1', at: base, strength: 3 }),
      event({ id: 'recruit', natural: 'n2', at: base + 5 * SECOND, strength: 1 }),
    ]);
    expect(result.kept).toHaveLength(1);
    expect(result.duplicates[0]!.reason).toBe('near');
  });

  it('keeps the stronger source', () => {
    const result = run([
      event({ id: 'recruit', natural: 'n1', at: base, strength: 1 }),
      event({ id: 'fuel', natural: 'n2', at: base + 5 * SECOND, strength: 3 }),
    ]);
    expect(result.kept[0]!.id).toBe('fuel');
    expect(result.duplicates[0]!.dropped.id).toBe('recruit');
  });

  it('does not depend on the order they arrived in', () => {
    const one = run([
      event({ id: 'recruit', natural: 'n1', at: base, strength: 1 }),
      event({ id: 'fuel', natural: 'n2', at: base + 5 * SECOND, strength: 3 }),
    ]);
    const two = run([
      event({ id: 'fuel', natural: 'n2', at: base + 5 * SECOND, strength: 3 }),
      event({ id: 'recruit', natural: 'n1', at: base, strength: 1 }),
    ]);
    expect(two.kept.map((e) => e.id)).toEqual(one.kept.map((e) => e.id));
  });

  it('keeps two events just outside the tolerance', () => {
    const result = run([
      event({ id: 'a', natural: 'n1', at: base }),
      event({ id: 'b', natural: 'n2', at: base + 31 * SECOND }),
    ]);
    expect(result.kept).toHaveLength(2);
  });

  it('collapses two events exactly at the tolerance', () => {
    const result = run([
      event({ id: 'a', natural: 'n1', at: base }),
      event({ id: 'b', natural: 'n2', at: base + 30 * SECOND }),
    ]);
    expect(result.kept).toHaveLength(1);
  });

  it('does not collapse across different collapse keys', () => {
    const result = run([
      event({ id: 'a', natural: 'n1', at: base, collapse: 'adv1:cxr9' }),
      event({ id: 'b', natural: 'n2', at: base + 2 * SECOND, collapse: 'adv2:cxr9' }),
    ]);
    expect(result.kept).toHaveLength(2);
  });

  it('collapses nothing at a tolerance of zero unless the instants match', () => {
    const apart = run(
      [
        event({ id: 'a', natural: 'n1', at: base }),
        event({ id: 'b', natural: 'n2', at: base + 1 }),
      ],
      0,
    );
    expect(apart.kept).toHaveLength(2);
    const together = run(
      [event({ id: 'a', natural: 'n1', at: base }), event({ id: 'b', natural: 'n2', at: base })],
      0,
    );
    expect(together.kept).toHaveLength(1);
  });
});

describe('tolerance validation', () => {
  it('refuses a negative tolerance', () => {
    const r = dedupe([event()], read, -1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('dedupe_tolerance_invalid');
    }
  });

  it('refuses a fractional tolerance', () => {
    expect(isErr(dedupe([event()], read, 1.5))).toBe(true);
  });
});

describe('candidateOrder', () => {
  it('groups by collapse key then time then strength', () => {
    const list: DedupeCandidate[] = [
      { naturalKey: 'n2', collapseKey: 'b', at: base, sourceReference: 'x', strength: 1 },
      { naturalKey: 'n1', collapseKey: 'a', at: base + 10, sourceReference: 'y', strength: 1 },
      { naturalKey: 'n3', collapseKey: 'a', at: base, sourceReference: 'z', strength: 1 },
    ];
    expect(sorted(list, candidateOrder).map((c) => c.naturalKey)).toEqual(['n3', 'n1', 'n2']);
  });
});

describe('reporting', () => {
  it('gives a duplicate rate', () => {
    const result = run([event(), event({ id: 'e2' })]);
    expect(duplicateRate(result)).toBeCloseTo(0.5);
  });

  it('gives a rate of zero for an empty list', () => {
    expect(duplicateRate(run([]))).toBe(0);
  });

  it('counts both reasons', () => {
    const result = run([
      event({ id: 'a', natural: 'n1', at: base }),
      event({ id: 'b', natural: 'n1', at: base }),
      event({ id: 'c', natural: 'n2', at: base + 3 * SECOND }),
    ]);
    const counts = countByReason(result);
    expect(counts.exact + counts.near).toBe(result.duplicates.length);
  });
});
