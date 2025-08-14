import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_NOTHING_FOUND, EXIT_OK, RecordingSink } from '../../src/cli/output.js';
import {
  asOfLine,
  knownReport,
  listReportsCommand,
  reportCommand,
  reportPackCommand,
} from '../../src/cli/reportCommands.js';
import { openSession, type Session } from '../../src/cli/session.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { reportNames } from '../../src/report/registry.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { fixedClock } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
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
];

let session: Session;
let catalog: Catalog;
let sink: RecordingSink;

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'pintlehook-report-'));
  session = unwrap(
    openSession({ directory, zone: 'America/Chicago', actor: 'operator', clock: fixedClock(AT) }),
  );
  catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
  sink = new RecordingSink();
  unwrap(session.context.store.commit(setup));
});

describe('listing reports', () => {
  it('lists every one the registry holds', () => {
    expect(listReportsCommand(sink)).toBe(EXIT_OK);
    expect(sink.lines).toHaveLength(reportNames().length);
  });

  it('marks the ones that need an advocate', () => {
    listReportsCommand(sink);
    expect(sink.output).toContain('needs an advocate');
  });
});

describe('running one report', () => {
  it('renders it', () => {
    expect(reportCommand(session, catalog, sink, 'aging', { program: programId(1) })).toBe(EXIT_OK);
    expect(sink.output).toContain('accrual ageing as at 2025-09-01');
  });

  it('renders in the shape asked for', () => {
    reportCommand(session, catalog, sink, 'performance', { program: programId(1), shape: 'json' });
    expect(sink.output).toContain('"rows"');
  });

  it('needs a program', () => {
    expect(reportCommand(session, catalog, sink, 'aging', {})).toBe(EXIT_FAILED);
  });

  it('refuses a shape it does not render', () => {
    expect(
      reportCommand(session, catalog, sink, 'aging', { program: programId(1), shape: 'pdf' }),
    ).toBe(EXIT_NOTHING_FOUND);
  });

  it('refuses a currency we do not carry', () => {
    expect(
      reportCommand(session, catalog, sink, 'aging', { program: programId(1), currency: 'GBP' }),
    ).toBe(EXIT_FAILED);
  });

  it('refuses a report that needs an advocate when none was given', () => {
    expect(reportCommand(session, catalog, sink, 'statement', { program: programId(1) })).not.toBe(
      EXIT_OK,
    );
  });

  it('runs one that needs an advocate when given one', () => {
    expect(
      reportCommand(session, catalog, sink, 'statement', {
        program: programId(1),
        advocate: advocateId(1),
      }),
    ).toBe(EXIT_OK);
  });

  it('refuses an advocate identifier of the wrong kind', () => {
    expect(
      reportCommand(session, catalog, sink, 'statement', {
        program: programId(1),
        advocate: carrierId(1),
      }),
    ).toBe(EXIT_FAILED);
  });

  it('refuses a report nobody registered', () => {
    expect(reportCommand(session, catalog, sink, 'profit', { program: programId(1) })).toBe(
      EXIT_NOTHING_FOUND,
    );
  });

  it('runs every registered report over this store', () => {
    for (const name of reportNames()) {
      const code = reportCommand(session, catalog, sink, name, {
        program: programId(1),
        advocate: advocateId(1),
      });
      expect(code).toBe(EXIT_OK);
    }
  });
});

describe('the report pack', () => {
  it('runs every report that can run', () => {
    expect(
      reportPackCommand(session, catalog, sink, {
        program: programId(1),
        advocate: advocateId(1),
      }),
    ).toBe(EXIT_OK);
    for (const name of reportNames()) {
      expect(sink.output).toContain(`=== ${name} ===`);
    }
  });

  it('skips the ones needing an advocate and says which', () => {
    expect(reportPackCommand(session, catalog, sink, { program: programId(1) })).toBe(EXIT_OK);
    expect(sink.output).toContain('they need an advocate');
    expect(sink.output).toContain('statement');
  });

  it('stops on the first report that fails', () => {
    const code = reportPackCommand(session, catalog, sink, {
      program: programId(1),
      asOf: 'soon',
    });
    expect(code).not.toBe(EXIT_OK);
    expect(sink.errorOutput).toContain('day_unparseable');
  });

  it('runs the program wide reports even for a program the catalogue lacks', () => {
    expect(reportPackCommand(session, catalog, sink, { program: programId(9) })).toBe(EXIT_OK);
  });
});

describe('helpers', () => {
  it('recognises a report name', () => {
    expect(unwrap(knownReport('aging'))).toBe('aging');
    expect(isErr(knownReport('profit'))).toBe(true);
  });

  it('reads the as of day back for a message', () => {
    expect(asOfLine(session, {})).toBe('2025-09-01');
    expect(asOfLine(session, { asOf: 'soon' })).toBe('an unreadable day');
  });
});
