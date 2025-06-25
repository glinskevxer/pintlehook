import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import {
  definitionOf,
  definitions,
  reportNames,
  runReport,
  type ReportRequest,
} from '../../src/report/registry.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

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
  tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 }],
};

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

const catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));

const carrier: JournalDraft = {
  at: AT,
  kind: 'carrier_filed',
  key: carrierId(1),
  payload: {
    carrier: carrierId(1),
    legalName: 'Brannan Hauling',
    motorCarrierNumber: 'MC884210',
    dotNumber: '3126540',
    authorityStatus: 'active',
    remitDigest: 'r',
    bankDigest: 'b',
    powerUnits: 1,
  },
};

const enrolled: JournalDraft = {
  at: AT,
  kind: 'advocate_enrolled',
  key: advocateId(1),
  payload: {
    advocate: advocateId(1),
    carrier: carrierId(1),
    program: programId(1),
    referralCode: 'AB3K9ZQ',
    from: '2025-01-01',
  },
};

let store: Store;
let context: Context;

const request: ReportRequest = {
  program: programId(1),
  currency: 'USD',
  asOf: day(2025, 9, 1),
  advocate: advocateId(1),
};

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  unwrap(store.commit([carrier, enrolled]));
});

describe('the registry', () => {
  it('lists every report once, sorted', () => {
    const names = reportNames();
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
  });

  it('gives every report a summary', () => {
    for (const definition of definitions()) {
      expect(definition.summary.length).toBeGreaterThan(10);
    }
  });

  it('reads a definition by name', () => {
    expect(unwrap(definitionOf('statement')).needsAdvocate).toBe(true);
    expect(unwrap(definitionOf('performance')).needsAdvocate).toBe(false);
  });

  it('names the ones it does know when asked for one it does not', () => {
    const r = definitionOf('profit');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('statement');
    }
  });
});

describe('runReport', () => {
  it('runs every report in the list without failing', () => {
    for (const name of reportNames()) {
      expect(isErr(runReport(context, catalog, name, request, 'text'))).toBe(false);
    }
  });

  it('renders in each shape', () => {
    const text = unwrap(runReport(context, catalog, 'performance', request, 'text'));
    const csv = unwrap(runReport(context, catalog, 'performance', request, 'csv'));
    const json = unwrap(runReport(context, catalog, 'performance', request, 'json'));
    expect(text).not.toBe(csv);
    expect(json).toContain('"rows"');
  });

  it('refuses a report that needs an advocate when none was given', () => {
    const r = runReport(context, catalog, 'statement', { ...request, advocate: undefined }, 'text');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('report_advocate_required');
    }
  });

  it('runs a program wide report with no advocate given', () => {
    const r = runReport(context, catalog, 'aging', { ...request, advocate: undefined }, 'text');
    expect(isErr(r)).toBe(false);
  });

  it('passes a failure from the report through', () => {
    const r = runReport(
      context,
      catalog,
      'statement',
      { ...request, advocate: advocateId(9) },
      'text',
    );
    expect(isErr(r)).toBe(true);
  });

  it('refuses a name nobody registered', () => {
    expect(isErr(runReport(context, catalog, 'profit', request, 'text'))).toBe(true);
  });

  it('names the advocate in the lane report title', () => {
    const text = unwrap(runReport(context, catalog, 'lanes', request, 'text'));
    expect(text).toContain(advocateId(1));
  });
});
