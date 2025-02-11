/**
 * The store. Tables, a journal, and the fold that turns one into the other.
 *
 * Two rules hold the whole thing together. Nothing writes a table except the
 * fold, so a table can always be thrown away and rebuilt; and a commit either
 * lands in the journal and the tables together or lands in neither, so a
 * process killed mid settlement leaves a store that still folds.
 */

import { ok, type Result } from '../util/result.js';
import type { JournalDraft, JournalPayload, JournalRecord } from './journal.js';
import { JournalLog } from './log.js';
import { numberField, readEvent, textField, type EventKind } from './events.js';
import {
  NO_DAY,
  TABLE_NAMES,
  flagKey,
  type AccrualRow,
  type AdvocateRow,
  type BatchRow,
  type CarrierRow,
  type ClaimRow,
  type FlagRow,
  type LoadRow,
  type ReferralRow,
  type TableName,
  type TouchRow,
} from './rows.js';
import { Table } from './table.js';
import { checkAgainstLog, rowsOf, takeSnapshot, type Snapshot } from './snapshot.js';

function text(payload: JournalPayload, field: string): string {
  const read = textField(payload, field);
  return read.ok ? read.value : '';
}

function count(payload: JournalPayload, field: string): number {
  const read = numberField(payload, field);
  return read.ok ? read.value : 0;
}

export function referralKeyOf(program: string, invitee: string): string {
  return `${program}:${invitee}`;
}

export class Store {
  readonly carriers = new Table<CarrierRow>(
    (row) => row.id,
    [
      { name: 'mc', keys: (row) => [row.motorCarrierNumber], unique: true },
      { name: 'dot', keys: (row) => [row.dotNumber], unique: false },
      { name: 'remit', keys: (row) => [row.remitDigest], unique: false },
    ],
  );

  readonly advocates = new Table<AdvocateRow>(
    (row) => row.id,
    [
      { name: 'carrier', keys: (row) => [row.carrier], unique: false },
      { name: 'code', keys: (row) => [row.referralCode], unique: true },
      { name: 'program', keys: (row) => [row.program], unique: false },
    ],
  );

  readonly touches = new Table<TouchRow>(
    (row) => row.id,
    [
      { name: 'advocate', keys: (row) => [row.advocate], unique: false },
      { name: 'invitee', keys: (row) => [row.invitee], unique: false },
    ],
  );

  readonly referrals = new Table<ReferralRow>(
    (row) => row.key,
    [
      {
        name: 'advocate',
        keys: (row) => (row.advocate === '' ? [] : [row.advocate]),
        unique: false,
      },
      { name: 'invitee', keys: (row) => [row.invitee], unique: false },
      { name: 'state', keys: (row) => [row.state], unique: false },
    ],
  );

  readonly loads = new Table<LoadRow>(
    (row) => row.id,
    [
      { name: 'carrier', keys: (row) => [row.carrier], unique: false },
      { name: 'pro', keys: (row) => [`${row.carrier}:${row.proNumber}`], unique: true },
    ],
  );

  readonly claims = new Table<ClaimRow>(
    (row) => row.id,
    [{ name: 'load', keys: (row) => [row.load], unique: false }],
  );

  readonly accruals = new Table<AccrualRow>(
    (row) => row.id,
    [
      { name: 'advocate', keys: (row) => [row.advocate], unique: false },
      { name: 'referral', keys: (row) => [row.referralKey], unique: false },
      { name: 'year', keys: (row) => [`${row.advocate}:${row.programYearFrom}`], unique: false },
    ],
  );

  readonly batches = new Table<BatchRow>((row) => row.id, []);

  readonly flags = new Table<FlagRow>(
    (row) => row.key,
    [{ name: 'advocate', keys: (row) => [row.advocate], unique: false }],
  );

  private constructor(private readonly log: JournalLog) {}

  static empty(): Store {
    return new Store(JournalLog.empty());
  }

  static fromLog(log: JournalLog): Result<Store> {
    const store = new Store(log);
    const folded = store.foldFrom(0);
    return folded.ok ? ok(store) : folded;
  }

  static fromSnapshot(log: JournalLog, snapshot: Snapshot): Result<Store> {
    const behind = checkAgainstLog(snapshot, log);
    if (!behind.ok) {
      return behind;
    }
    const store = new Store(log);
    store.loadTables(snapshot);
    const folded = store.foldFrom(snapshot.atSequence);
    return folded.ok ? ok(store) : folded;
  }

  get journal(): JournalLog {
    return this.log;
  }

  get sequence(): number {
    return this.log.length;
  }

  /** Append the drafts and fold them. Either all of it lands or none of it. */
  commit(drafts: readonly JournalDraft[]): Result<JournalRecord[]> {
    const before = this.log.length;
    const written = this.log.appendAll(drafts);
    if (!written.ok) {
      return written;
    }
    const folded = this.foldFrom(before);
    if (folded.ok) {
      return written;
    }
    this.log.truncateTo(before);
    this.clearTables();
    this.foldFrom(0);
    return folded;
  }

  snapshot(): Snapshot {
    return takeSnapshot(this.log, {
      carriers: this.carriers.all(),
      advocates: this.advocates.all(),
      touches: this.touches.all(),
      referrals: this.referrals.all(),
      loads: this.loads.all(),
      claims: this.claims.all(),
      accruals: this.accruals.all(),
      batches: this.batches.all(),
      flags: this.flags.all(),
    });
  }

  tableNames(): readonly TableName[] {
    return TABLE_NAMES;
  }

  rebuild(): Result<number> {
    this.clearTables();
    return this.foldFrom(0);
  }

  private clearTables(): void {
    this.carriers.clear();
    this.advocates.clear();
    this.touches.clear();
    this.referrals.clear();
    this.loads.clear();
    this.claims.clear();
    this.accruals.clear();
    this.batches.clear();
    this.flags.clear();
  }

  private loadTables(snapshot: Snapshot): void {
    this.clearTables();
    this.carriers.putAll(rowsOf<CarrierRow>(snapshot, 'carriers'));
    this.advocates.putAll(rowsOf<AdvocateRow>(snapshot, 'advocates'));
    this.touches.putAll(rowsOf<TouchRow>(snapshot, 'touches'));
    this.referrals.putAll(rowsOf<ReferralRow>(snapshot, 'referrals'));
    this.loads.putAll(rowsOf<LoadRow>(snapshot, 'loads'));
    this.claims.putAll(rowsOf<ClaimRow>(snapshot, 'claims'));
    this.accruals.putAll(rowsOf<AccrualRow>(snapshot, 'accruals'));
    this.batches.putAll(rowsOf<BatchRow>(snapshot, 'batches'));
    this.flags.putAll(rowsOf<FlagRow>(snapshot, 'flags'));
  }

  private foldFrom(sequence: number): Result<number> {
    for (const record of this.log.since(sequence)) {
      const event = readEvent(record);
      if (!event.ok) {
        return event;
      }
      const applied = this.apply(event.value.kind, record);
      if (!applied.ok) {
        return applied;
      }
    }
    return ok(this.log.length);
  }

  private apply(kind: EventKind, record: JournalRecord): Result<unknown> {
    const p = record.payload;
    switch (kind) {
      case 'carrier_filed':
        return this.carriers.put({
          id: text(p, 'carrier'),
          legalName: text(p, 'legalName'),
          motorCarrierNumber: text(p, 'motorCarrierNumber'),
          dotNumber: text(p, 'dotNumber'),
          authorityStatus: text(p, 'authorityStatus'),
          remitDigest: text(p, 'remitDigest'),
          bankDigest: text(p, 'bankDigest'),
          powerUnits: count(p, 'powerUnits'),
        });
      case 'advocate_enrolled':
        return this.advocates.put({
          id: text(p, 'advocate'),
          carrier: text(p, 'carrier'),
          program: text(p, 'program'),
          referralCode: text(p, 'referralCode'),
          enrolledFrom: text(p, 'from'),
          enrolledUntil: NO_DAY,
          endReason: '',
        });
      case 'advocate_withdrawn': {
        const held = this.advocates.get(text(p, 'advocate'));
        return held === undefined
          ? ok(undefined)
          : this.advocates.put({
              ...held,
              enrolledUntil: text(p, 'until'),
              endReason: text(p, 'reason'),
            });
      }
      case 'touch_recorded':
        return this.touches.put({
          id: text(p, 'touch'),
          advocate: text(p, 'advocate'),
          invitee: text(p, 'invitee'),
          channel: text(p, 'channel'),
          presentedCode: text(p, 'presentedCode'),
          at: count(p, 'at'),
          sourceReference: text(p, 'sourceReference'),
        });
      case 'referral_opened':
        return this.referrals.put({
          key: referralKeyOf(text(p, 'program'), text(p, 'invitee')),
          program: text(p, 'program'),
          invitee: text(p, 'invitee'),
          advocate: '',
          state: 'recorded',
          recordedOn: text(p, 'recordedOn'),
          effectiveActivation: NO_DAY,
          qualifiedOn: NO_DAY,
          reversedOn: NO_DAY,
        });
      case 'referral_attributed':
        return this.updateReferral(p, {
          advocate: text(p, 'advocate'),
          state: 'attributed',
          effectiveActivation: text(p, 'effectiveActivation'),
        });
      case 'referral_qualified':
        return this.updateReferral(p, {
          state: 'qualified',
          qualifiedOn: text(p, 'qualifiedOn'),
          reversedOn: NO_DAY,
        });
      case 'referral_reversed':
        return this.updateReferral(p, {
          state: 'reversed',
          reversedOn: text(p, 'reversedOn'),
        });
      case 'load_delivered':
        return this.loads.put({
          id: text(p, 'load'),
          carrier: text(p, 'carrier'),
          proNumber: text(p, 'proNumber'),
          status: 'delivered',
          deliveredOn: text(p, 'deliveredOn'),
          lineHaulMinor: count(p, 'lineHaulMinor'),
          carrierPayMinor: count(p, 'carrierPayMinor'),
          currency: text(p, 'currency'),
          originState: text(p, 'originState'),
          destinationState: text(p, 'destinationState'),
        });
      case 'load_amended': {
        const held = this.loads.get(text(p, 'load'));
        if (held === undefined) {
          return ok(undefined);
        }
        const field = text(p, 'field');
        if (field === 'status') {
          return this.loads.put({ ...held, status: text(p, 'value') });
        }
        if (field === 'carrierPayMinor') {
          return this.loads.put({ ...held, carrierPayMinor: count(p, 'value') });
        }
        return this.loads.put({ ...held, lineHaulMinor: count(p, 'value') });
      }
      case 'claim_stated':
        return this.claims.put({
          id: text(p, 'claim'),
          load: text(p, 'load'),
          raisedOn: text(p, 'raisedOn'),
          disposition: text(p, 'disposition'),
          amountMinor: count(p, 'amountMinor'),
          currency: text(p, 'currency'),
        });
      case 'accrual_posted':
        return this.accruals.put({
          id: text(p, 'accrual'),
          advocate: text(p, 'advocate'),
          program: text(p, 'program'),
          referralKey: text(p, 'referralKey'),
          kind: text(p, 'kind'),
          postedOn: text(p, 'postedOn'),
          programYearFrom: text(p, 'programYearFrom'),
          amountMinor: count(p, 'amountMinor'),
          currency: text(p, 'currency'),
          reverses: text(p, 'reverses'),
          note: text(p, 'note'),
        });
      case 'batch_cut':
        return this.batches.put({
          id: text(p, 'batch'),
          periodFrom: text(p, 'periodFrom'),
          periodUntil: text(p, 'periodUntil'),
          cutOn: text(p, 'cutOn'),
          state: 'cut',
          currency: text(p, 'currency'),
        });
      case 'batch_released':
      case 'batch_paid': {
        const held = this.batches.get(text(p, 'batch'));
        return held === undefined
          ? ok(undefined)
          : this.batches.put({
              ...held,
              state: kind === 'batch_released' ? 'released' : 'paid',
            });
      }
      case 'eligibility_flag_raised':
        return this.flags.put({
          key: flagKey(text(p, 'advocate'), text(p, 'flag')),
          advocate: text(p, 'advocate'),
          flag: text(p, 'flag'),
          raisedOn: text(p, 'raisedOn'),
          clearedOn: NO_DAY,
        });
      case 'eligibility_flag_cleared': {
        const key = flagKey(text(p, 'advocate'), text(p, 'flag'));
        const held = this.flags.get(key);
        return held === undefined
          ? ok(undefined)
          : this.flags.put({ ...held, clearedOn: text(p, 'clearedOn') });
      }
      case 'program_version_added':
        return ok(undefined);
    }
  }

  private updateReferral(payload: JournalPayload, change: Partial<ReferralRow>): Result<unknown> {
    const key = referralKeyOf(text(payload, 'program'), text(payload, 'invitee'));
    const held = this.referrals.get(key);
    return held === undefined ? ok(undefined) : this.referrals.put({ ...held, ...change });
  }
}
