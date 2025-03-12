import { describe, expect, it } from 'vitest';
import { isPending, type PacketApproval } from '../../src/domain/activation.js';
import { programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import type { OnboardingDraft } from '../../src/ingest/onboardingFeed.js';
import {
  activationFor,
  activationForDraft,
  approvalOf,
  effectiveActivationDay,
  summarizeActivations,
  wouldMoveActivation,
} from '../../src/service/activationService.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock } from '../../src/service/context.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 6,
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

function catalogWithCure(days: number) {
  const program: Program = {
    id: programId(1),
    name: 'referral',
    openedOn: day(2024, 1, 1),
    versions: [
      {
        version: 1,
        effectiveFrom: day(2024, 1, 1),
        rules: { ...rules, cureWindowDays: days },
        note: 'x',
      },
    ],
  };
  return unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
}

const catalog = catalogWithCure(21);

const conditional: PacketApproval = {
  kind: 'conditional',
  approvedOn: day(2025, 2, 10),
  insuranceClearedOn: day(2025, 3, 2),
};

function draft(overrides: Partial<OnboardingDraft> = {}): OnboardingDraft {
  return {
    motorCarrierNumber: 'MC884210',
    dotNumber: '3126540',
    legalName: 'Brannan Hauling',
    approvalKind: 'conditional',
    approvedOn: day(2025, 2, 10),
    insuranceClearedOn: day(2025, 2, 20),
    authorityStatus: 'active',
    powerUnits: 1,
    referralCodeOnPacket: undefined,
    sourceReference: 'c/o/1:1',
    rowNumber: 1,
    ...overrides,
  };
}

describe('approvalOf', () => {
  it('carries the clearance day for a conditional approval', () => {
    expect(approvalOf(draft()).insuranceClearedOn).toEqual(day(2025, 2, 20));
  });

  it('leaves the clearance day off an outright approval', () => {
    const approval = approvalOf(draft({ approvalKind: 'outright', insuranceClearedOn: undefined }));
    expect(approval.kind).toBe('outright');
    expect(approval.insuranceClearedOn).toBeUndefined();
  });
});

describe('activationFor', () => {
  it('backdates when the certificate landed inside the cure window', () => {
    const outcome = unwrap(
      activationFor(catalog, {
        program: programId(1),
        approval: conditional,
        asOf: day(2025, 6, 1),
      }),
    );
    expect(isPending(outcome)).toBe(false);
    expect(unwrap(effectiveActivationDay(outcome))).toEqual(day(2025, 2, 10));
  });

  it('reads the cure window from the program version, not from a constant', () => {
    const narrow = catalogWithCure(20);
    const outcome = unwrap(
      activationFor(narrow, {
        program: programId(1),
        approval: conditional,
        asOf: day(2025, 6, 1),
      }),
    );
    expect(unwrap(effectiveActivationDay(outcome))).toEqual(day(2025, 3, 2));
  });

  it('fails for a program the catalogue does not hold', () => {
    expect(
      isErr(
        activationFor(catalog, {
          program: programId(9),
          approval: conditional,
          asOf: day(2025, 6, 1),
        }),
      ),
    ).toBe(true);
  });

  it('fails when the approval predates every program version', () => {
    const early: PacketApproval = { kind: 'outright', approvedOn: day(2023, 1, 1) };
    expect(
      isErr(
        activationFor(catalog, { program: programId(1), approval: early, asOf: day(2025, 6, 1) }),
      ),
    ).toBe(true);
  });

  it('reports pending while the cure window is open', () => {
    const waiting: PacketApproval = { kind: 'conditional', approvedOn: day(2025, 2, 10) };
    const outcome = unwrap(
      activationFor(catalog, { program: programId(1), approval: waiting, asOf: day(2025, 2, 20) }),
    );
    expect(isPending(outcome)).toBe(true);
    expect(isErr(effectiveActivationDay(outcome))).toBe(true);
  });
});

describe('activationForDraft', () => {
  it('uses the context clock as the as of day', () => {
    const context = unwrap(
      contextFor(Store.empty(), fixedClock(Date.UTC(2025, 1, 20)), 'UTC', 'desk'),
    );
    const outcome = unwrap(
      activationForDraft(context, catalog, programId(1), draft({ insuranceClearedOn: undefined })),
    );
    expect(isPending(outcome)).toBe(true);
  });
});

describe('summarizeActivations', () => {
  it('counts settled, pending and failed', () => {
    const settled = activationFor(catalog, {
      program: programId(1),
      approval: conditional,
      asOf: day(2025, 6, 1),
    });
    const pending = activationFor(catalog, {
      program: programId(1),
      approval: { kind: 'conditional', approvedOn: day(2025, 2, 10) },
      asOf: day(2025, 2, 20),
    });
    const failed = activationFor(catalog, {
      program: programId(9),
      approval: conditional,
      asOf: day(2025, 6, 1),
    });
    expect(summarizeActivations([settled, pending, failed])).toEqual({
      settled: 1,
      pending: 1,
      failed: 1,
    });
  });

  it('counts nothing for an empty list', () => {
    expect(summarizeActivations([])).toEqual({ settled: 0, pending: 0, failed: 0 });
  });
});

describe('wouldMoveActivation', () => {
  const request = {
    program: programId(1),
    approval: conditional,
    asOf: day(2025, 6, 1),
  };

  it('sees a cure window change that moves the date', () => {
    expect(unwrap(wouldMoveActivation(catalog, catalogWithCure(20), request))).toBe(true);
  });

  it('sees a change that does not move the date', () => {
    expect(unwrap(wouldMoveActivation(catalog, catalogWithCure(30), request))).toBe(false);
  });

  it('is false when both sides are still pending', () => {
    const waiting = {
      program: programId(1),
      approval: { kind: 'conditional' as const, approvedOn: day(2025, 2, 10) },
      asOf: day(2025, 2, 15),
    };
    expect(unwrap(wouldMoveActivation(catalog, catalogWithCure(30), waiting))).toBe(false);
  });

  it('fails rather than guessing when one side has run out of cure window', () => {
    const waiting = {
      program: programId(1),
      approval: { kind: 'conditional' as const, approvedOn: day(2025, 2, 10) },
      asOf: day(2025, 3, 5),
    };
    const r = wouldMoveActivation(catalog, catalogWithCure(30), waiting);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('activation_cure_expired');
    }
  });

  it('passes a failure through', () => {
    expect(
      isErr(wouldMoveActivation(catalog, catalog, { ...request, program: programId(9) })),
    ).toBe(true);
  });
});
