import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import {
  balanceHolds,
  buildStatement,
  creditsOf,
  debitsOf,
  fromRows,
  referralsOn,
  statementReport,
} from '../../src/report/statement.js';
import { renderText } from '../../src/report/table.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

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

function accrual(
  seq: number,
  postedOn: string,
  amountMinor: number,
  kind = 'base',
  referral = 'prg_00000001:cxr_00000009',
  note = 'first bounty',
): JournalDraft {
  return {
    at: AT,
    kind: 'accrual_posted',
    key: `acr_${seq}`,
    payload: {
      accrual: `acr_${seq}`,
      advocate: advocateId(1),
      program: programId(1),
      referralKey: referral,
      kind,
      postedOn,
      programYearFrom: '2025-01-01',
      amountMinor,
      currency: 'USD',
      reverses: '',
      note,
    },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  unwrap(store.commit([carrier, enrolled]));
});

describe('an advocate with nothing', () => {
  it('has an empty statement that still balances', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(statement.lines).toEqual([]);
    expect(statement.closingBalance.minor).toBe(0);
    expect(balanceHolds(statement)).toBe(true);
  });

  it('carries the referral code', () => {
    expect(unwrap(buildStatement(context, advocateId(1), 'USD')).referralCode).toBe('AB3K9ZQ');
  });

  it('fails for an advocate nobody enrolled', () => {
    expect(isErr(buildStatement(context, advocateId(9), 'USD'))).toBe(true);
  });
});

describe('a statement with postings', () => {
  beforeEach(() => {
    unwrap(
      store.commit([
        accrual(1, '2025-03-01', 25_000),
        accrual(2, '2025-05-01', 16_000, 'true_up', 'prg_00000001:cxr_00000009', 'tier crossing'),
        accrual(3, '2025-07-01', -41_000, 'true_down', 'prg_00000001:cxr_00000009', 'reversed'),
      ]),
    );
  });

  it('runs a balance down the lines', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(statement.lines.map((line) => line.runningBalance.minor)).toEqual([25_000, 41_000, 0]);
  });

  it('closes at the last running balance', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(statement.closingBalance.minor).toBe(0);
    expect(balanceHolds(statement)).toBe(true);
  });

  it('keeps a true down as a line rather than a smaller total', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(statement.lines).toHaveLength(3);
    expect(statement.lines[2]!.kind).toBe('true_down');
    expect(statement.lines[2]!.note).toBe('reversed');
  });

  it('orders by posting day', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(statement.lines[0]!.postedOn).toEqual(day(2025, 3, 1));
    expect(statement.lines[2]!.postedOn).toEqual(day(2025, 7, 1));
  });

  it('splits the credits from the debits', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(creditsOf(statement).minor).toBe(41_000);
    expect(debitsOf(statement).minor).toBe(-41_000);
  });

  it('lists the referrals it touches', () => {
    const statement = unwrap(buildStatement(context, advocateId(1), 'USD'));
    expect(referralsOn(statement)).toEqual(['prg_00000001:cxr_00000009']);
  });

  it('fails on a posting with an unreadable day', () => {
    unwrap(store.commit([accrual(4, 'soon', 1_000)]));
    expect(isErr(buildStatement(context, advocateId(1), 'USD'))).toBe(true);
  });
});

describe('statementReport', () => {
  beforeEach(() => {
    unwrap(
      store.commit([
        accrual(1, '2025-03-01', 25_000),
        accrual(2, '2025-05-01', 16_000, 'true_up', 'prg_00000001:cxr_00000009', 'tier crossing'),
      ]),
    );
  });

  it('names the advocate and the code in the title', () => {
    const report = statementReport(unwrap(buildStatement(context, advocateId(1), 'USD')));
    expect(report.title).toContain(advocateId(1));
    expect(report.title).toContain('AB3K9ZQ');
  });

  it('carries a why column', () => {
    const report = statementReport(unwrap(buildStatement(context, advocateId(1), 'USD')));
    expect(report.columns.map((column) => column.key)).toContain('note');
    expect(renderText(report)).toContain('tier crossing');
  });

  it('footnotes the closing balance', () => {
    const report = statementReport(unwrap(buildStatement(context, advocateId(1), 'USD')));
    expect(report.footnotes[0]).toContain('41000');
  });

  it('renders both amounts and balances as money', () => {
    const report = statementReport(unwrap(buildStatement(context, advocateId(1), 'USD')));
    expect(renderText(report)).toContain('250.00 USD');
    expect(renderText(report)).toContain('410.00 USD');
  });
});

describe('fromRows', () => {
  it('adds the minor units off a row list', () => {
    unwrap(store.commit([accrual(1, '2025-03-01', 25_000), accrual(2, '2025-05-01', -5_000)]));
    const rows = store.accruals.all();
    expect(fromRows(rows, 'USD').minor).toBe(20_000);
  });

  it('is zero for an empty list', () => {
    expect(fromRows([], 'USD').minor).toBe(0);
  });
});
