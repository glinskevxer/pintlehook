import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, batchId, settlementId } from '../../src/domain/identity.js';
import type { HoldVerdict } from '../../src/domain/hold.js';
import { buildLine, type SettlementLine } from '../../src/domain/settlement.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  batchById,
  canLiftByHand,
  liftHold,
  liftableLines,
  payBatch,
  releaseBatch,
  stuckLines,
} from '../../src/service/releaseService.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { money, zero } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 2);

const cut: JournalDraft = {
  at: AT,
  kind: 'batch_cut',
  key: batchId(1),
  payload: {
    batch: batchId(1),
    periodFrom: '2025-05-01',
    periodUntil: '2025-06-01',
    cutOn: '2025-06-02',
    currency: 'USD',
  },
};

function verdict(reasons: HoldVerdict['reasons']): HoldVerdict {
  return { held: reasons.length > 0, reasons, primaryReason: reasons[0] };
}

function line(reasons: HoldVerdict['reasons'], advocate = 1): SettlementLine {
  return unwrap(
    buildLine(
      settlementId(advocate),
      advocateId(advocate),
      [],
      money('USD', 400),
      zero('USD'),
      verdict(reasons),
      'USD',
    ),
  );
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'kate'));
  unwrap(store.commit([cut]));
});

describe('batchById', () => {
  it('reads a batch', () => {
    expect(unwrap(batchById(context, batchId(1))).state).toBe('cut');
  });

  it('fails for a batch nobody cut', () => {
    expect(isErr(batchById(context, batchId(9)))).toBe(true);
  });
});

describe('releaseBatch and payBatch', () => {
  it('releases then pays', () => {
    unwrap(store.commit(unwrap(releaseBatch(context, batchId(1), day(2025, 6, 3)))));
    expect(store.batches.get(batchId(1))!.state).toBe('released');
    unwrap(store.commit(unwrap(payBatch(context, batchId(1), day(2025, 6, 5)))));
    expect(store.batches.get(batchId(1))!.state).toBe('paid');
  });

  it('refuses to pay a batch that was never released', () => {
    const r = payBatch(context, batchId(1), day(2025, 6, 5));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('batch_bad_transition');
    }
  });

  it('refuses to release twice', () => {
    unwrap(store.commit(unwrap(releaseBatch(context, batchId(1), day(2025, 6, 3)))));
    expect(isErr(releaseBatch(context, batchId(1), day(2025, 6, 4)))).toBe(true);
  });

  it('refuses a release dated before the cut', () => {
    const r = releaseBatch(context, batchId(1), day(2025, 6, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('batch_dated_too_early');
    }
  });

  it('names who released it', () => {
    const drafts = unwrap(releaseBatch(context, batchId(1), day(2025, 6, 3)));
    expect(drafts[0]!.payload['actor']).toBe('kate');
    expect(drafts[0]!.payload['releasedOn']).toBe('2025-06-03');
  });

  it('fails for a batch nobody cut', () => {
    expect(isErr(releaseBatch(context, batchId(9), day(2025, 6, 3)))).toBe(true);
  });
});

describe('canLiftByHand', () => {
  it('lets a desk lift a small payout', () => {
    expect(canLiftByHand(line(['below_minimum']))).toBe(true);
  });

  it('lets a desk lift missing remit details', () => {
    expect(canLiftByHand(line(['no_remit_details']))).toBe(true);
  });

  it('will not let a desk lift a negative position', () => {
    expect(canLiftByHand(line(['negative_position']))).toBe(false);
  });

  it('will not let a desk lift a mixed hold', () => {
    expect(canLiftByHand(line(['below_minimum', 'negative_position']))).toBe(false);
  });

  it('is false for a line that is not held', () => {
    expect(canLiftByHand(line([]))).toBe(false);
  });
});

describe('liftHold', () => {
  it('records the lift with a reason', () => {
    const drafts = unwrap(
      liftHold(context, batchId(1), line(['below_minimum']), 'carrier asked for the cheque'),
    );
    expect(drafts[0]!.payload['note']).toBe('carrier asked for the cheque');
    expect(drafts[0]!.payload['actor']).toBe('kate');
  });

  it('refuses a line that is not held', () => {
    const r = liftHold(context, batchId(1), line([]), 'why not');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('hold_not_held');
    }
  });

  it('refuses a reason that a desk cannot lift and names it', () => {
    const r = liftHold(context, batchId(1), line(['negative_position']), 'because');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('hold_not_liftable');
      expect(r.problems[0]!.message).toContain('negative_position');
    }
  });

  it('refuses a blank reason', () => {
    const r = liftHold(context, batchId(1), line(['below_minimum']), '   ');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('hold_reason_missing');
    }
  });
});

describe('splitting the working list', () => {
  const lines = [
    line(['below_minimum'], 1),
    line(['negative_position'], 2),
    line([], 3),
    line(['no_remit_details'], 4),
  ];

  it('lists what a desk can work', () => {
    expect(liftableLines(lines).map((l) => l.advocate)).toEqual([advocateId(1), advocateId(4)]);
  });

  it('lists what a desk cannot', () => {
    expect(stuckLines(lines).map((l) => l.advocate)).toEqual([advocateId(2)]);
  });
});
