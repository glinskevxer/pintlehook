import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  asOfOf,
  auditCommand,
  currencyOf,
  exceptionsCommand,
  programOf,
  programsCommand,
  rulesCommand,
  saveCommand,
  statusCommand,
  verifyCommand,
} from '../../src/cli/commands.js';
import { EXIT_FAILED, EXIT_NOTHING_FOUND, EXIT_OK, RecordingSink } from '../../src/cli/output.js';
import { openSession, type Session } from '../../src/cli/session.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
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
  name: 'owner operator referral',
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
      actor: 'onboarding',
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
      actor: 'onboarding',
    },
  },
];

let session: Session;
let catalog: Catalog;
let sink: RecordingSink;

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'pintlehook-cli-'));
  session = unwrap(
    openSession({ directory, zone: 'America/Chicago', actor: 'operator', clock: fixedClock(AT) }),
  );
  catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
  sink = new RecordingSink();
  unwrap(session.context.store.commit(setup));
});

describe('option readers', () => {
  it('reads a program', () => {
    expect(unwrap(programOf({ program: programId(1) }))).toBe(programId(1));
    expect(isErr(programOf({}))).toBe(true);
    expect(isErr(programOf({ program: carrierId(1) }))).toBe(true);
  });

  it('defaults the currency and refuses one we do not carry', () => {
    expect(unwrap(currencyOf({}))).toBe('USD');
    expect(unwrap(currencyOf({ currency: 'CAD' }))).toBe('CAD');
    expect(isErr(currencyOf({ currency: 'GBP' }))).toBe(true);
  });

  it('defaults the as of day to the session clock', () => {
    expect(unwrap(asOfOf(session, {}))).toEqual(day(2025, 9, 1));
    expect(unwrap(asOfOf(session, { asOf: '2025-06-01' }))).toEqual(day(2025, 6, 1));
    expect(isErr(asOfOf(session, { asOf: 'soon' }))).toBe(true);
  });
});

describe('status', () => {
  it('counts what is loaded and says the journal verifies', () => {
    expect(statusCommand(session, sink)).toBe(EXIT_OK);
    expect(sink.output).toContain('1 carriers');
    expect(sink.output).toContain('journal verifies: yes');
  });

  it('reports integrity findings when there are any', () => {
    unwrap(
      session.context.store.commit([
        {
          at: AT,
          kind: 'advocate_enrolled',
          key: advocateId(2),
          payload: {
            advocate: advocateId(2),
            carrier: carrierId(9),
            program: programId(1),
            referralCode: 'QW7X2MB',
            from: '2025-01-01',
          },
        },
      ]),
    );
    statusCommand(session, sink);
    expect(sink.output).toContain('advocate_carrier_exists');
  });
});

describe('programs', () => {
  it('lists what the catalogue holds', () => {
    expect(programsCommand(catalog, sink)).toBe(EXIT_OK);
    expect(sink.output).toContain('owner operator referral');
    expect(sink.output).toContain('1 versions');
  });

  it('says so when the catalogue is empty', () => {
    programsCommand(unwrap(buildCatalog([], [])), sink);
    expect(sink.output).toBe('no programs in the catalogue');
  });
});

describe('rules', () => {
  it('prints the rules in force', () => {
    expect(rulesCommand(session, catalog, sink, { program: programId(1) })).toBe(EXIT_OK);
    expect(sink.output).toContain('attribution window 90 days');
    expect(sink.output).toContain('2025-09-01');
  });

  it('prints them for the day asked about', () => {
    rulesCommand(session, catalog, sink, { program: programId(1), asOf: '2024-06-01' });
    expect(sink.output).toContain('2024-06-01');
  });

  it('needs a program', () => {
    expect(rulesCommand(session, catalog, sink, {})).toBe(EXIT_FAILED);
    expect(sink.errorOutput).toContain('option_missing');
  });

  it('reports a program the catalogue does not hold', () => {
    expect(rulesCommand(session, catalog, sink, { program: programId(9) })).toBe(
      EXIT_NOTHING_FOUND,
    );
  });

  it('reports a day it cannot read', () => {
    expect(rulesCommand(session, catalog, sink, { program: programId(1), asOf: 'soon' })).toBe(
      EXIT_FAILED,
    );
  });
});

describe('exceptions', () => {
  it('renders the exception report', () => {
    expect(exceptionsCommand(session, catalog, sink, { program: programId(1) })).toBe(EXIT_OK);
    expect(sink.output).toContain('exception report as at 2025-09-01');
  });

  it('needs a program', () => {
    expect(exceptionsCommand(session, catalog, sink, {})).toBe(EXIT_FAILED);
  });
});

describe('audit', () => {
  it('walks an advocate and names the actor on each line', () => {
    expect(auditCommand(session, sink, advocateId(1))).toBe(EXIT_OK);
    expect(sink.output).toContain('advocate_enrolled by onboarding');
  });

  it('reports an advocate nobody enrolled', () => {
    expect(auditCommand(session, sink, advocateId(9))).toBe(EXIT_NOTHING_FOUND);
  });

  it('reports something that is not an advocate identifier', () => {
    expect(auditCommand(session, sink, 'nonsense')).toBe(EXIT_FAILED);
  });
});

describe('save and verify', () => {
  it('writes the records and says how many', () => {
    expect(saveCommand(session, sink)).toBe(EXIT_OK);
    expect(sink.output).toContain('wrote 2 records');
  });

  it('verifies a clean store', () => {
    expect(verifyCommand(session, sink)).toBe(EXIT_OK);
    expect(sink.output).toContain('2 records verify');
  });

  it('reports integrity findings rather than saying it verified', () => {
    unwrap(
      session.context.store.commit([
        {
          at: AT,
          kind: 'advocate_enrolled',
          key: advocateId(2),
          payload: {
            advocate: advocateId(2),
            carrier: carrierId(9),
            program: programId(1),
            referralCode: 'QW7X2MB',
            from: '2025-01-01',
          },
        },
      ]),
    );
    expect(verifyCommand(session, sink)).not.toBe(EXIT_OK);
    expect(sink.errorOutput).toContain('integrity_advocate_carrier_exists');
    expect(sink.output).toBe('');
  });
});
