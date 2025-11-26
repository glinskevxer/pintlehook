import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import { countOn, inPeriod, movementOver, movementReport } from '../../src/report/tierMovement.js';
import { renderText } from '../../src/report/table.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 11, 1);
const PERIOD = interval(day(2025, 6, 1), day(2025, 12, 1));

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 2,
  qualifyingWindowDays: 120,
  retentionDays: 180,
  programYearCapMinor: 0,
  releaseCeilingMinor: 100_000,
  currency: 'USD',
};

const schedule: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 },
    { name: 'silver', fromCount: 2, flatMinor: 40_000, marginShare: 0 },
    { name: 'gold', fromCount: 4, flatMinor: 60_000, marginShare: 0 },
  ],
};

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

function carrier(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'carrier_filed',
    key: carrierId(id),
    payload: {
      carrier: carrierId(id),
      legalName: `Carrier ${id}`,
      motorCarrierNumber: `MC90000${id}`,
      dotNumber: `550000${id}`,
      authorityStatus: 'active',
      remitDigest: `r${id}`,
      bankDigest: `b${id}`,
      powerUnits: 1,
    },
  };
}

function enrolled(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'advocate_enrolled',
    key: advocateId(id),
    payload: {
      advocate: advocateId(id),
      carrier: carrierId(id),
      program: programId(1),
      referralCode: `CODE00${id}`,
      from: '2025-01-01',
    },
  };
}

function qualified(
  invitee: number,
  advocate: number,
  on: string,
  reversedOn?: string,
): JournalDraft[] {
  const key = `prg_00000001:${carrierId(invitee)}`;
  const drafts: JournalDraft[] = [
    {
      at: AT,
      kind: 'referral_opened',
      key,
      payload: { program: programId(1), invitee: carrierId(invitee), recordedOn: '2025-01-05' },
    },
    {
      at: AT,
      kind: 'referral_attributed',
      key,
      payload: {
        program: programId(1),
        invitee: carrierId(invitee),
        advocate: advocateId(advocate),
        effectiveActivation: '2025-02-01',
      },
    },
    {
      at: AT,
      kind: 'referral_qualified',
      key,
      payload: { program: programId(1), invitee: carrierId(invitee), qualifiedOn: on },
    },
  ];
  if (reversedOn !== undefined) {
    drafts.push({
      at: AT,
      kind: 'referral_reversed',
      key,
      payload: {
        program: programId(1),
        invitee: carrierId(invitee),
        reversedOn,
        reason: 'retention_failed',
      },
    });
  }
  return drafts;
}

let store: Store;
let context: Context;
let catalog: Catalog;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'manager'));
  catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
  unwrap(store.commit([carrier(1), carrier(2), enrolled(1), enrolled(2)]));
});

describe('countOn', () => {
  it('counts a referral that had qualified by the day', () => {
    unwrap(store.commit(qualified(9, 1, '2025-03-01')));
    expect(unwrap(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(1);
  });

  it('does not count one that qualified later', () => {
    unwrap(store.commit(qualified(9, 1, '2025-09-01')));
    expect(unwrap(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(0);
  });

  it('counts a referral on the day it qualified', () => {
    unwrap(store.commit(qualified(9, 1, '2025-06-01')));
    expect(unwrap(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(1);
  });

  it('stops counting one that had been reversed by the day', () => {
    unwrap(store.commit(qualified(9, 1, '2025-03-01', '2025-05-01')));
    expect(unwrap(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(0);
  });

  it('still counts one reversed after the day', () => {
    unwrap(store.commit(qualified(9, 1, '2025-03-01', '2025-09-01')));
    expect(unwrap(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(1);
  });

  it('leaves out referrals belonging to another advocate', () => {
    unwrap(store.commit(qualified(9, 2, '2025-03-01')));
    expect(unwrap(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(0);
  });

  it('fails on a qualifying day it cannot read', () => {
    unwrap(store.commit(qualified(9, 1, 'soon')));
    expect(isErr(countOn(context, advocateId(1), programId(1), day(2025, 6, 1)))).toBe(true);
  });
});

describe('movementOver', () => {
  it('lists nobody when nothing moved', () => {
    unwrap(store.commit(qualified(9, 1, '2025-03-01')));
    expect(unwrap(movementOver(context, catalog, programId(1), PERIOD))).toEqual([]);
  });

  it('lists an advocate that climbed a rung', () => {
    unwrap(store.commit([...qualified(9, 1, '2025-03-01'), ...qualified(8, 1, '2025-08-01')]));
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toBe('bronze');
    expect(rows[0]!.after).toBe('silver');
    expect(rows[0]!.direction).toBe('climbed');
  });

  it('lists an advocate that fell back', () => {
    unwrap(
      store.commit([
        ...qualified(9, 1, '2025-03-01'),
        ...qualified(8, 1, '2025-03-02', '2025-08-01'),
      ]),
    );
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    expect(rows[0]!.direction).toBe('fell');
    expect(rows[0]!.before).toBe('silver');
    expect(rows[0]!.after).toBe('bronze');
  });

  it('lists an advocate that arrived from below the ladder', () => {
    unwrap(store.commit(qualified(9, 1, '2025-08-01')));
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    expect(rows[0]!.before).toBe('below the ladder');
    expect(rows[0]!.after).toBe('bronze');
  });

  it('carries the counts either side of the move', () => {
    unwrap(store.commit([...qualified(9, 1, '2025-03-01'), ...qualified(8, 1, '2025-08-01')]));
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    expect(rows[0]!.countBefore).toBe(1);
    expect(rows[0]!.countAfter).toBe(2);
  });

  it('orders by advocate so the report is repeatable', () => {
    unwrap(store.commit([...qualified(9, 2, '2025-08-01'), ...qualified(8, 1, '2025-08-02')]));
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    expect(rows.map((row) => row.advocate)).toEqual([advocateId(1), advocateId(2)]);
  });

  it('fails for a program the catalogue does not hold', () => {
    expect(isErr(movementOver(context, catalog, programId(9), PERIOD))).toBe(true);
  });
});

describe('movementReport', () => {
  it('counts both directions in the footnote', () => {
    unwrap(store.commit([...qualified(9, 1, '2025-03-01'), ...qualified(8, 1, '2025-08-01')]));
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    const report = movementReport(rows, PERIOD);
    expect(report.footnotes[0]).toBe('1 climbed, 0 fell back');
  });

  it('names the period in the title', () => {
    const report = movementReport([], PERIOD);
    expect(report.title).toContain('2025-06-01');
    expect(report.title).toContain('2025-12-01');
  });

  it('renders the rungs either side', () => {
    unwrap(store.commit([...qualified(9, 1, '2025-03-01'), ...qualified(8, 1, '2025-08-01')]));
    const rows = unwrap(movementOver(context, catalog, programId(1), PERIOD));
    const text = renderText(movementReport(rows, PERIOD));
    expect(text).toContain('bronze');
    expect(text).toContain('silver');
    expect(text).toContain('climbed');
  });

  it('says so when nobody moved', () => {
    expect(renderText(movementReport([], PERIOD))).toContain('(nothing to report)');
  });
});

describe('inPeriod', () => {
  it('is half open on the right', () => {
    expect(inPeriod(PERIOD, day(2025, 6, 1))).toBe(true);
    expect(inPeriod(PERIOD, day(2025, 11, 30))).toBe(true);
    expect(inPeriod(PERIOD, day(2025, 12, 1))).toBe(false);
  });
});
