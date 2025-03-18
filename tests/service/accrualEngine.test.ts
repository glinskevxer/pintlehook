import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import {
  describePlan,
  isSettled,
  ladderEntriesOf,
  planAccruals,
  runAccruals,
  type QualifiedReferral,
} from '../../src/service/accrualEngine.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { accrualsOfAdvocate } from '../../src/storage/repositories.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);
const YEAR_FROM = day(2025, 1, 1);

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 3,
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
    { name: 'silver', fromCount: 3, flatMinor: 40_000, marginShare: 100 },
  ],
};

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

const catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));

function referral(key: string, month: number, marginMinor = 100_000): QualifiedReferral {
  return { referralKey: key, qualifiedOn: day(2025, month, 10), margin: money('USD', marginMinor) };
}

let store: Store;
let context: Context;

function request(referrals: QualifiedReferral[]) {
  return {
    advocate: advocateId(1),
    program: programId(1),
    programYearFrom: YEAR_FROM,
    referrals,
    currency: 'USD' as const,
  };
}

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement'));
});

describe('ladderEntriesOf', () => {
  it('orders by qualifying day then referral key', () => {
    const entries = ladderEntriesOf([referral('b', 3), referral('a', 1), referral('c', 3)]);
    expect(entries.map((entry) => entry.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('the first run', () => {
  it('posts a base amount for one referral', () => {
    const plan = unwrap(planAccruals(context, catalog, request([referral('a', 1)])));
    expect(plan.drafts).toHaveLength(1);
    expect(plan.drafts[0]!.payload['kind']).toBe('base');
    expect(plan.drafts[0]!.payload['amountMinor']).toBe(25_000);
    expect(plan.netChange.minor).toBe(25_000);
  });

  it('dates the posting to the day the run happened', () => {
    const plan = unwrap(planAccruals(context, catalog, request([referral('a', 1)])));
    expect(plan.drafts[0]!.payload['postedOn']).toBe('2025-09-01');
  });

  it('names the program year the posting falls in', () => {
    const plan = unwrap(planAccruals(context, catalog, request([referral('a', 1)])));
    expect(plan.drafts[0]!.payload['programYearFrom']).toBe('2025-01-01');
  });

  it('posts one line per referral, already carrying the true up', () => {
    const referrals = [referral('a', 1), referral('b', 2), referral('c', 3)];
    const plan = unwrap(planAccruals(context, catalog, request(referrals)));
    expect(plan.drafts).toHaveLength(3);
    for (const draft of plan.drafts) {
      expect(draft.payload['amountMinor']).toBe(41_000);
    }
  });
});

describe('running again', () => {
  it('posts nothing when nothing changed', () => {
    unwrap(runAccruals(context, catalog, request([referral('a', 1)])));
    const again = unwrap(planAccruals(context, catalog, request([referral('a', 1)])));
    expect(isSettled(again)).toBe(true);
    expect(describePlan(again)).toBe('nothing to post');
  });

  it('posts only the difference when a tier is crossed', () => {
    unwrap(runAccruals(context, catalog, request([referral('a', 1), referral('b', 2)])));
    expect(accrualsOfAdvocate(store, advocateId(1))).toHaveLength(2);
    const referrals = [referral('a', 1), referral('b', 2), referral('c', 3)];
    const plan = unwrap(runAccruals(context, catalog, request(referrals)));
    const trueUps = plan.drafts.filter((draft) => draft.payload['kind'] === 'true_up');
    expect(trueUps).toHaveLength(2);
    for (const draft of trueUps) {
      expect(draft.payload['amountMinor']).toBe(16_000);
    }
  });

  it('leaves every referral in the year worth the same in the end', () => {
    const referrals = [referral('a', 1), referral('b', 2), referral('c', 3)];
    unwrap(runAccruals(context, catalog, request(referrals)));
    const byReferral = new Map<string, number>();
    for (const row of accrualsOfAdvocate(store, advocateId(1))) {
      byReferral.set(row.referralKey, (byReferral.get(row.referralKey) ?? 0) + row.amountMinor);
    }
    expect([...byReferral.values()]).toEqual([41_000, 41_000, 41_000]);
  });
});

describe('a referral falling out of the year', () => {
  const three = [referral('a', 1), referral('b', 2), referral('c', 3)];

  it('posts a true down that takes the tier back', () => {
    unwrap(runAccruals(context, catalog, request(three)));
    const plan = unwrap(
      runAccruals(context, catalog, request([referral('a', 1), referral('b', 2)])),
    );
    const downs = plan.drafts.filter((draft) => draft.payload['kind'] === 'true_down');
    expect(downs).toHaveLength(3);
    expect(plan.netChange.minor).toBeLessThan(0);
  });

  it('leaves the survivors at the lower tier', () => {
    unwrap(runAccruals(context, catalog, request(three)));
    unwrap(runAccruals(context, catalog, request([referral('a', 1), referral('b', 2)])));
    const total = accrualsOfAdvocate(store, advocateId(1)).reduce(
      (running, row) => running + row.amountMinor,
      0,
    );
    expect(total).toBe(50_000);
  });

  it('takes a referral all the way back to nothing', () => {
    unwrap(runAccruals(context, catalog, request([referral('a', 1)])));
    unwrap(runAccruals(context, catalog, request([])));
    const total = accrualsOfAdvocate(store, advocateId(1)).reduce(
      (running, row) => running + row.amountMinor,
      0,
    );
    expect(total).toBe(0);
  });
});

describe('failures', () => {
  it('refuses a run in a currency the schedule does not pay', () => {
    const r = planAccruals(context, catalog, { ...request([referral('a', 1)]), currency: 'CAD' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('accrual_currency_mismatch');
    }
  });

  it('refuses a referral carrying another currency', () => {
    const foreign: QualifiedReferral = { ...referral('a', 1), margin: money('MXN', 1) };
    expect(isErr(planAccruals(context, catalog, request([foreign])))).toBe(true);
  });

  it('fails for a program the catalogue does not hold', () => {
    const r = planAccruals(context, catalog, {
      ...request([referral('a', 1)]),
      program: programId(9),
    });
    expect(isErr(r)).toBe(true);
  });

  it('posts nothing for an advocate with no qualified referrals', () => {
    expect(isSettled(unwrap(planAccruals(context, catalog, request([]))))).toBe(true);
  });
});

describe('describePlan', () => {
  it('counts the postings and the net', () => {
    const plan = unwrap(planAccruals(context, catalog, request([referral('a', 1)])));
    expect(describePlan(plan)).toBe('1 postings, net 25000 minor units');
  });
});
