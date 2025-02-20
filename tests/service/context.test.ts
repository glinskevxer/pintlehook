import { describe, expect, it } from 'vitest';
import { advocateId, carrierId } from '../../src/domain/identity.js';
import {
  IdSequence,
  contextFor,
  fixedClock,
  sequenceFromStore,
  systemClock,
  withActor,
  withClock,
} from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 4, 1, 14, 30, 0);

function draft(kind: string, key: string, payload: Record<string, unknown>): JournalDraft {
  return { at: AT, kind, key, payload };
}

describe('fixedClock', () => {
  it('always gives the same instant and day', () => {
    const clock = fixedClock(AT);
    expect(clock.now()).toBe(AT);
    expect(clock.today()).toEqual(day(2025, 5, 1));
    expect(clock.now()).toBe(AT);
  });
});

describe('systemClock', () => {
  it('gives a day that matches its own instant', () => {
    const clock = systemClock();
    const before = clock.now();
    expect(clock.today().year).toBeGreaterThan(2000);
    expect(clock.now()).toBeGreaterThanOrEqual(before);
  });
});

describe('IdSequence', () => {
  it('starts at one and rises', () => {
    const ids = new IdSequence();
    expect(ids.mint('advocate')).toBe(advocateId(1));
    expect(ids.mint('advocate')).toBe(advocateId(2));
    expect(ids.peek('advocate')).toBe(3);
  });

  it('keeps kinds apart', () => {
    const ids = new IdSequence();
    expect(ids.mint('advocate')).toBe(advocateId(1));
    expect(ids.mint('carrier')).toBe(carrierId(1));
  });

  it('takes a seed', () => {
    const ids = new IdSequence({ advocate: 40 });
    expect(ids.mint('advocate')).toBe(advocateId(40));
  });

  it('moves past an identifier it is shown', () => {
    const ids = new IdSequence();
    ids.observe('advocate', advocateId(12));
    expect(ids.mint('advocate')).toBe(advocateId(13));
  });

  it('does not go backwards for an older identifier', () => {
    const ids = new IdSequence();
    ids.observe('advocate', advocateId(12));
    ids.observe('advocate', advocateId(3));
    expect(ids.mint('advocate')).toBe(advocateId(13));
  });

  it('ignores something that is not an identifier', () => {
    const ids = new IdSequence();
    ids.observe('advocate', 'advocate twelve');
    expect(ids.mint('advocate')).toBe(advocateId(1));
  });
});

describe('sequenceFromStore', () => {
  it('resumes past everything already filed', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        draft('carrier_filed', 'cxr_1', {
          carrier: carrierId(7),
          legalName: 'Brannan Hauling',
          motorCarrierNumber: 'MC884210',
          dotNumber: '3126540',
          authorityStatus: 'active',
          remitDigest: 'r1',
          bankDigest: 'b1',
          powerUnits: 2,
        }),
        draft('advocate_enrolled', 'adv_1', {
          advocate: advocateId(4),
          carrier: carrierId(7),
          program: 'prg_00000001',
          referralCode: 'AB3K9ZQ',
          from: '2025-01-01',
        }),
      ]),
    );
    const ids = sequenceFromStore(store);
    expect(ids.mint('carrier')).toBe(carrierId(8));
    expect(ids.mint('advocate')).toBe(advocateId(5));
  });

  it('starts at one against an empty store', () => {
    expect(sequenceFromStore(Store.empty()).mint('load')).toBe('lod_00000001');
  });
});

describe('contextFor', () => {
  it('carries the store, the clock and the actor', () => {
    const store = Store.empty();
    const context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement-run'));
    expect(context.store).toBe(store);
    expect(context.clock.today()).toEqual(day(2025, 5, 1));
    expect(context.zone).toBe('America/Chicago');
    expect(context.actor).toBe('settlement-run');
  });

  it('resumes identifiers from the store it was given', () => {
    const store = Store.empty();
    const context = unwrap(contextFor(store, fixedClock(AT), 'UTC', 'x'));
    expect(context.ids.peek('advocate')).toBe(1);
  });
});

describe('withActor and withClock', () => {
  it('changes one thing and leaves the rest', () => {
    const store = Store.empty();
    const context = unwrap(contextFor(store, fixedClock(AT), 'UTC', 'first'));
    const other = withActor(context, 'second');
    expect(other.actor).toBe('second');
    expect(other.store).toBe(context.store);
    expect(other.ids).toBe(context.ids);
  });

  it('swaps the clock', () => {
    const store = Store.empty();
    const context = unwrap(contextFor(store, fixedClock(AT), 'UTC', 'x'));
    const later = withClock(context, fixedClock(Date.UTC(2026, 0, 1)));
    expect(later.clock.today()).toEqual(day(2026, 1, 1));
    expect(context.clock.today()).toEqual(day(2025, 5, 1));
  });
});
