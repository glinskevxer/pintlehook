import { describe, expect, it } from 'vitest';
import {
  activationMoved,
  cureDeadline,
  isPending,
  resolveActivation,
  type Activation,
  type PacketApproval,
} from '../../src/domain/activation.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const asOf = day(2025, 6, 1);

const outright: PacketApproval = { kind: 'outright', approvedOn: day(2025, 2, 10) };

const conditional: PacketApproval = {
  kind: 'conditional',
  approvedOn: day(2025, 2, 10),
  insuranceClearedOn: day(2025, 2, 20),
};

describe('outright approval', () => {
  it('activates on the approval day', () => {
    const outcome = unwrap(resolveActivation(outright, 21, asOf));
    expect(isPending(outcome)).toBe(false);
    if (!isPending(outcome)) {
      expect(outcome.effectiveOn).toEqual(day(2025, 2, 10));
      expect(outcome.basis).toBe('outright_approval');
      expect(outcome.backdated).toBe(false);
    }
  });

  it('refuses an outright approval that also carries a clearance day', () => {
    const r = resolveActivation({ ...outright, insuranceClearedOn: day(2025, 3, 1) }, 21, asOf);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('activation_outright_with_cure');
    }
  });
});

describe('conditional approval cured inside the window', () => {
  it('backdates to the conditional approval', () => {
    const outcome = unwrap(resolveActivation(conditional, 21, asOf)) as Activation;
    expect(outcome.effectiveOn).toEqual(day(2025, 2, 10));
    expect(outcome.basis).toBe('cured_in_window');
    expect(outcome.cureDays).toBe(10);
    expect(outcome.backdated).toBe(true);
  });

  it('counts a same day clearance as no backdating', () => {
    const sameDay: PacketApproval = { ...conditional, insuranceClearedOn: day(2025, 2, 10) };
    const outcome = unwrap(resolveActivation(sameDay, 21, asOf)) as Activation;
    expect(outcome.cureDays).toBe(0);
    expect(outcome.backdated).toBe(false);
  });

  it('accepts the last day of the window', () => {
    const lastDay: PacketApproval = { ...conditional, insuranceClearedOn: day(2025, 3, 2) };
    const outcome = unwrap(resolveActivation(lastDay, 21, asOf)) as Activation;
    expect(outcome.basis).toBe('cured_in_window');
    expect(outcome.effectiveOn).toEqual(day(2025, 2, 10));
  });
});

describe('conditional approval cured late', () => {
  it('activates on the clearance day and loses the backdating', () => {
    const late: PacketApproval = { ...conditional, insuranceClearedOn: day(2025, 3, 3) };
    const outcome = unwrap(resolveActivation(late, 21, asOf)) as Activation;
    expect(outcome.basis).toBe('cured_late');
    expect(outcome.effectiveOn).toEqual(day(2025, 3, 3));
    expect(outcome.backdated).toBe(false);
    expect(outcome.cureDays).toBe(21);
  });

  it('moves the activation by one day when the cure window is one day shorter', () => {
    const onTheEdge: PacketApproval = { ...conditional, insuranceClearedOn: day(2025, 3, 2) };
    const wide = unwrap(resolveActivation(onTheEdge, 21, asOf));
    const narrow = unwrap(resolveActivation(onTheEdge, 20, asOf));
    expect(activationMoved(wide, narrow)).toBe(true);
  });

  it('refuses a certificate dated before the approval', () => {
    const backwards: PacketApproval = { ...conditional, insuranceClearedOn: day(2025, 2, 1) };
    const r = resolveActivation(backwards, 21, asOf);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('activation_cleared_before_approval');
    }
  });
});

describe('conditional approval with nothing on file yet', () => {
  const waiting: PacketApproval = { kind: 'conditional', approvedOn: day(2025, 2, 10) };

  it('reports pending while the window is still open', () => {
    const outcome = unwrap(resolveActivation(waiting, 21, day(2025, 2, 25)));
    expect(isPending(outcome)).toBe(true);
    if (isPending(outcome)) {
      expect(outcome.cureExpiresOn).toEqual(day(2025, 3, 3));
      expect(outcome.since).toEqual(day(2025, 2, 10));
    }
  });

  it('fails once the window has closed', () => {
    const r = resolveActivation(waiting, 21, day(2025, 3, 3));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('activation_cure_expired');
    }
  });

  it('is still pending on the last day of the window', () => {
    expect(isPending(unwrap(resolveActivation(waiting, 21, day(2025, 3, 2))))).toBe(true);
  });
});

describe('cure window validation', () => {
  it('refuses a zero or fractional window', () => {
    expect(isErr(resolveActivation(conditional, 0, asOf))).toBe(true);
    expect(isErr(resolveActivation(conditional, 2.5, asOf))).toBe(true);
  });
});

describe('cureDeadline', () => {
  it('names the last day a certificate can land', () => {
    expect(unwrap(cureDeadline(conditional, 21))).toEqual(day(2025, 3, 2));
  });

  it('refuses an outright approval', () => {
    const r = cureDeadline(outright, 21);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('activation_not_conditional');
    }
  });

  it('refuses a bad window', () => {
    expect(isErr(cureDeadline(conditional, 0))).toBe(true);
  });
});

describe('activationMoved', () => {
  it('is false for two identical activations', () => {
    const one = unwrap(resolveActivation(conditional, 21, asOf));
    const two = unwrap(resolveActivation(conditional, 30, asOf));
    expect(activationMoved(one, two)).toBe(false);
  });

  it('is true when one side is still pending', () => {
    const waiting: PacketApproval = { kind: 'conditional', approvedOn: day(2025, 2, 10) };
    const pending = unwrap(resolveActivation(waiting, 21, day(2025, 2, 15)));
    const settled = unwrap(resolveActivation(conditional, 21, asOf));
    expect(activationMoved(pending, settled)).toBe(true);
  });

  it('is false when both sides are pending', () => {
    const waiting: PacketApproval = { kind: 'conditional', approvedOn: day(2025, 2, 10) };
    const one = unwrap(resolveActivation(waiting, 21, day(2025, 2, 15)));
    const two = unwrap(resolveActivation(waiting, 30, day(2025, 2, 15)));
    expect(activationMoved(one, two)).toBe(false);
  });
});
