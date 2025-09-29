/**
 * A scenario builder for the integration tests.
 *
 * The point of building one of these rather than writing journal drafts by
 * hand is that every fixture goes through the real services, so a scenario that
 * cannot be set up is a scenario the program would refuse in production too.
 */

import {
  carrierId,
  programId,
  type AdvocateId,
  type CarrierId,
} from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import type { TouchDraft } from '../../src/ingest/touchFeed.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import { recordTouch } from '../../src/service/referrals.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day, formatDay, type Day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

export const DEFAULT_RULES: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 2,
  qualifyingWindowDays: 120,
  retentionDays: 180,
  programYearCapMinor: 0,
  releaseCeilingMinor: 100_000,
  currency: 'USD',
};

export const LADDER: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 },
    { name: 'silver', fromCount: 2, flatMinor: 40_000, marginShare: 100 },
    { name: 'gold', fromCount: 4, flatMinor: 60_000, marginShare: 250 },
  ],
};

export function catalogWith(overrides: Partial<ProgramRules> = {}): Catalog {
  const program: Program = {
    id: programId(1),
    name: 'owner operator referral',
    openedOn: day(2024, 1, 1),
    versions: [
      {
        version: 1,
        effectiveFrom: day(2024, 1, 1),
        rules: { ...DEFAULT_RULES, ...overrides },
        note: 'opening',
      },
    ],
  };
  return unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule: LADDER }]));
}

export function party(id: number, name: string, line1 = `${id} Main St`): Party {
  return {
    id: carrierId(id),
    legalName: name,
    motorCarrierNumber: `MC${String(900000 + id)}`,
    dotNumber: String(5500000 + id),
    authorityStatus: 'active',
    remit: { line1, city: 'Joliet', state: 'IL', postalCode: '60431' },
    bank: undefined,
    powerUnits: 1,
  };
}

export class Scenario {
  readonly store = Store.empty();
  readonly context: Context;
  readonly codes = new Map<number, string>();
  readonly advocates = new Map<number, AdvocateId>();
  private loadCount = 0;

  constructor(at: number) {
    this.context = unwrap(contextFor(this.store, fixedClock(at), 'America/Chicago', 'scenario'));
  }

  file(id: number, name: string, line1?: string): this {
    unwrap(this.store.commit(unwrap(fileCarrier(this.context, party(id, name, line1)))));
    return this;
  }

  enrol(id: number, from: Day): this {
    const enrolled = unwrap(
      enrolAdvocate(this.context, {
        carrier: carrierId(id),
        program: programId(1),
        from,
      }),
    );
    unwrap(this.store.commit(enrolled.drafts));
    this.codes.set(id, enrolled.referralCode);
    this.advocates.set(id, enrolled.advocate);
    return this;
  }

  touch(
    advocateCarrier: number,
    invitee: number,
    at: number,
    channel: TouchDraft['channel'] = 'card',
  ): this {
    const draft: TouchDraft = {
      presentedCode: this.codes.get(advocateCarrier) as string,
      channel,
      at,
      inviteeMotorCarrierNumber: party(invitee, '').motorCarrierNumber,
      inviteeDotNumber: undefined,
      inviteeName: undefined,
      sourceReference: `scenario:${advocateCarrier}:${invitee}`,
      rowNumber: 1,
    };
    unwrap(this.store.commit(unwrap(recordTouch(this.context, draft)).drafts));
    return this;
  }

  attribute(invitee: number, advocateCarrier: number, activation: Day): this {
    return this.write({
      kind: 'referral_attributed',
      key: `${programId(1)}:${carrierId(invitee)}`,
      payload: {
        program: programId(1),
        invitee: carrierId(invitee),
        advocate: this.advocates.get(advocateCarrier) as string,
        effectiveActivation: formatDay(activation),
      },
    });
  }

  load(carrier: number, on: Day, marginMinor = 50_000): this {
    this.loadCount += 1;
    return this.write({
      kind: 'load_delivered',
      key: `lod_${this.loadCount}`,
      payload: {
        load: `lod_${this.loadCount}`,
        carrier: carrierId(carrier),
        proNumber: `PL-${this.loadCount}`,
        deliveredOn: formatDay(on),
        lineHaulMinor: 200_000 + marginMinor,
        carrierPayMinor: 200_000,
        currency: 'USD',
        originState: 'IL',
        destinationState: 'TX',
      },
    });
  }

  claim(
    loadNumber: number,
    on: Day,
    amountMinor: number,
    disposition = 'charged_to_carrier',
  ): this {
    return this.write({
      kind: 'claim_stated',
      key: `clm_${loadNumber}`,
      payload: {
        claim: `clm_${loadNumber}`,
        load: `lod_${loadNumber}`,
        raisedOn: formatDay(on),
        disposition,
        amountMinor,
        currency: 'USD',
      },
    });
  }

  advocateOf(carrier: number): AdvocateId {
    return this.advocates.get(carrier) as AdvocateId;
  }

  inviteeOf(carrier: number): CarrierId {
    return carrierId(carrier);
  }

  /** Write a record directly, for a state the services will not set up. */
  writeRecord(kind: string, key: string, payload: Record<string, unknown>): this {
    return this.write({ kind, key, payload });
  }

  private write(draft: Omit<JournalDraft, 'at'>): this {
    unwrap(this.store.commit([{ at: this.context.clock.now(), ...draft }]));
    return this;
  }
}
