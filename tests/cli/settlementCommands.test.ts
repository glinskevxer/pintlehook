import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_OK, RecordingSink } from '../../src/cli/output.js';
import {
  batchesCommand,
  cutCommand,
  payCommand,
  releaseCommand,
  type CutOptions,
} from '../../src/cli/settlementCommands.js';
import { openSession, type Session } from '../../src/cli/session.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { fixedClock } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 2);

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

const setup: JournalDraft[] = [
  {
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
  },
  {
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
  },
  {
    at: AT,
    kind: 'accrual_posted',
    key: 'acr_1',
    payload: {
      accrual: 'acr_1',
      advocate: advocateId(1),
      program: programId(1),
      referralKey: 'prg_00000001:cxr_00000009',
      kind: 'base',
      postedOn: '2025-05-10',
      programYearFrom: '2025-01-01',
      amountMinor: 25_000,
      currency: 'USD',
      reverses: '',
      note: 'bounty',
    },
  },
];

let session: Session;
let catalog: Catalog;
let sink: RecordingSink;

function options(overrides: Partial<CutOptions> = {}): CutOptions {
  return {
    program: programId(1),
    from: '2025-05-01',
    until: '2025-06-01',
    asOf: '2025-06-02',
    ...overrides,
  };
}

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'pintlehook-settle-'));
  session = unwrap(
    openSession({ directory, zone: 'America/Chicago', actor: 'operator', clock: fixedClock(AT) }),
  );
  catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
  sink = new RecordingSink();
  unwrap(session.context.store.commit(setup));
});

describe('cutting', () => {
  it('previews by default and writes nothing', () => {
    expect(cutCommand(session, catalog, sink, options())).toBe(EXIT_OK);
    expect(sink.output).toContain('this was a preview');
    expect(session.context.store.batches.size).toBe(0);
  });

  it('prints the register in the preview', () => {
    cutCommand(session, catalog, sink, options());
    expect(sink.output).toContain('settlement register');
    expect(sink.output).toContain('250.00 USD');
  });

  it('cuts for real when told to commit', () => {
    expect(cutCommand(session, catalog, sink, options({ commit: true }))).toBe(EXIT_OK);
    expect(session.context.store.batches.size).toBe(1);
    expect(sink.output).toContain('25000 minor units payable');
  });

  it('needs a program', () => {
    expect(cutCommand(session, catalog, sink, options({ program: undefined }))).toBe(EXIT_FAILED);
  });

  it('needs both ends of the period', () => {
    expect(cutCommand(session, catalog, sink, options({ from: undefined }))).toBe(EXIT_FAILED);
    expect(cutCommand(session, catalog, sink, options({ until: undefined }))).toBe(EXIT_FAILED);
  });

  it('refuses a period end it cannot read', () => {
    expect(cutCommand(session, catalog, sink, options({ until: 'soon' }))).toBe(EXIT_FAILED);
  });

  it('refuses a cut before the period closes', () => {
    expect(cutCommand(session, catalog, sink, options({ asOf: '2025-05-20' }))).not.toBe(EXIT_OK);
    expect(sink.errorOutput).toContain('settlement_cut_too_early');
  });

  it('refuses a currency we do not carry', () => {
    expect(cutCommand(session, catalog, sink, options({ currency: 'GBP' }))).toBe(EXIT_FAILED);
  });
});

describe('moving a batch along', () => {
  function cut(): string {
    cutCommand(session, catalog, sink, options({ commit: true }));
    return session.context.store.batches.all()[0]!.id;
  }

  it('releases then pays', () => {
    const batch = cut();
    expect(releaseCommand(session, sink, batch, '2025-06-03')).toBe(EXIT_OK);
    expect(session.context.store.batches.get(batch)!.state).toBe('released');
    expect(payCommand(session, sink, batch, '2025-06-05')).toBe(EXIT_OK);
    expect(session.context.store.batches.get(batch)!.state).toBe('paid');
  });

  it('defaults the day to the session clock', () => {
    const batch = cut();
    expect(releaseCommand(session, sink, batch, undefined)).toBe(EXIT_OK);
    expect(sink.output).toContain('2025-06-02');
  });

  it('refuses to pay before releasing', () => {
    const batch = cut();
    expect(payCommand(session, sink, batch, '2025-06-05')).not.toBe(EXIT_OK);
    expect(sink.errorOutput).toContain('batch_bad_transition');
  });

  it('refuses a batch identifier that is not one', () => {
    expect(releaseCommand(session, sink, 'nonsense', '2025-06-03')).toBe(EXIT_FAILED);
  });

  it('refuses a day it cannot read', () => {
    const batch = cut();
    expect(releaseCommand(session, sink, batch, 'soon')).toBe(EXIT_FAILED);
  });

  it('reports a batch nobody cut', () => {
    expect(releaseCommand(session, sink, 'bch_00000099', '2025-06-03')).not.toBe(EXIT_OK);
  });
});

describe('listing batches', () => {
  it('says so when there are none', () => {
    expect(batchesCommand(session, sink, undefined)).toBe(EXIT_OK);
    expect(sink.output).toBe('no batches');
  });

  it('lists what has been cut', () => {
    cutCommand(session, catalog, sink, options({ commit: true }));
    sink.lines.length = 0;
    batchesCommand(session, sink, undefined);
    expect(sink.output).toContain('cut 2025-06-02');
    expect(sink.output).toContain('2025-05-01 to 2025-06-01');
  });

  it('filters by state', () => {
    cutCommand(session, catalog, sink, options({ commit: true }));
    sink.lines.length = 0;
    batchesCommand(session, sink, 'paid');
    expect(sink.output).toBe('no batches in paid');
  });
});
