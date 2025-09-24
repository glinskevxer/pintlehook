import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { programId } from '../../src/domain/identity.js';
import { runCycle, type CycleRequest } from '../../src/service/cycle.js';
import { openSession, pathsFor, saveSession } from '../../src/cli/session.js';
import { fixedClock } from '../../src/service/context.js';
import { runIntegrity } from '../../src/storage/integrity.js';
import { JournalLog } from '../../src/storage/log.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { isErr, unwrap } from '../../src/util/result.js';
import { Scenario, catalogWith } from '../support/scenario.js';

const AT = Date.UTC(2025, 11, 2);
const PROGRAM_YEAR = interval(day(2025, 1, 1), day(2026, 1, 1));
const catalog = catalogWith();

const request: CycleRequest = {
  program: programId(1),
  period: interval(day(2025, 11, 1), day(2025, 12, 1)),
  cutOn: day(2025, 12, 2),
  currency: 'USD',
  programYearFrom: day(2025, 1, 1),
};

function settled(): Scenario {
  const scenario = new Scenario(AT)
    .file(1, 'Brannan Hauling')
    .file(9, 'Delacroix Transport')
    .file(8, 'Cobb Transport')
    .enrol(1, day(2025, 1, 1))
    .touch(1, 9, Date.UTC(2025, 0, 20, 15))
    .touch(1, 8, Date.UTC(2025, 0, 21, 15))
    .attribute(9, 1, day(2025, 2, 1))
    .attribute(8, 1, day(2025, 2, 1))
    .load(9, day(2025, 2, 10))
    .load(9, day(2025, 3, 10))
    .load(9, day(2025, 5, 10))
    .load(9, day(2025, 7, 10))
    .load(8, day(2025, 2, 12))
    .load(8, day(2025, 3, 12))
    .load(8, day(2025, 5, 12))
    .load(8, day(2025, 7, 12));
  unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));
  return scenario;
}

describe('folding the journal again', () => {
  const scenario = settled();

  it('reaches exactly the same tables', () => {
    const again = unwrap(Store.fromLog(scenario.store.journal));
    expect(again.accruals.all()).toEqual(scenario.store.accruals.all());
    expect(again.referrals.all()).toEqual(scenario.store.referrals.all());
    expect(again.batches.all()).toEqual(scenario.store.batches.all());
  });

  it('reaches the same tables when rebuilt in place', () => {
    const before = scenario.store.accruals.all();
    unwrap(scenario.store.rebuild());
    expect(scenario.store.accruals.all()).toEqual(before);
  });

  it('folds a journal rebuilt from its own text', () => {
    const text = scenario.store.journal.toText();
    const rebuilt = unwrap(Store.fromLog(unwrap(JournalLog.fromText(text))));
    expect(rebuilt.sequence).toBe(scenario.store.sequence);
    expect(runIntegrity(rebuilt).clean).toBe(true);
  });

  it('has written more than a handful of records', () => {
    expect(scenario.store.sequence).toBeGreaterThan(15);
  });
});

describe('a journal somebody edited', () => {
  const scenario = settled();

  it('stops verifying at the edit', () => {
    const records = [...scenario.store.journal.all()];
    const at = Math.floor(records.length / 2);
    records[at] = { ...records[at]!, payload: { ...records[at]!.payload, tampered: true } };
    const r = JournalLog.fromRecords(records);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_record_tampered');
    }
  });

  it('stops verifying when a record is taken out of the middle', () => {
    const records = [...scenario.store.journal.all()];
    records.splice(Math.floor(records.length / 2), 1);
    expect(isErr(JournalLog.fromRecords(records))).toBe(true);
  });

  it('verifies untouched', () => {
    expect(unwrap(scenario.store.journal.verify())).toBe(scenario.store.sequence);
  });
});

describe('through a snapshot on disk', () => {
  const scenario = settled();
  const directory = mkdtempSync(join(tmpdir(), 'pintlehook-replay-'));
  const options = {
    directory,
    zone: 'America/Chicago' as const,
    actor: 'operator',
    clock: fixedClock(AT),
  };

  const session = unwrap(openSession(options));
  unwrap(
    session.context.store.commit(
      [...scenario.store.journal.all()].map((record) => ({
        at: record.at,
        kind: record.kind,
        key: record.key,
        payload: record.payload,
      })),
    ),
  );
  unwrap(saveSession(session));

  it('resumes to the same tables it wrote', () => {
    const resumed = unwrap(openSession(options));
    const folded = unwrap(openSession({ ...options, ignoreSnapshot: true }));
    expect(resumed.usedSnapshot).toBe(true);
    expect(resumed.context.store.accruals.all()).toEqual(folded.context.store.accruals.all());
  });

  it('reaches the tables the original run reached', () => {
    const resumed = unwrap(openSession(options));
    expect(resumed.context.store.accruals.size).toBe(scenario.store.accruals.size);
    expect(resumed.context.store.batches.size).toBe(scenario.store.batches.size);
  });

  it('falls back to the journal when the snapshot is edited', () => {
    const path = pathsFor(directory).snapshot;
    const held = readFileSync(path, 'utf8');
    writeFileSync(path, held.replace(/"atSequence":\d+/, '"atSequence":1'), 'utf8');
    const reopened = unwrap(openSession(options));
    expect(reopened.usedSnapshot).toBe(false);
    expect(reopened.context.store.accruals.size).toBe(scenario.store.accruals.size);
    writeFileSync(path, held, 'utf8');
  });

  it('leaves the reopened store passing every integrity check', () => {
    expect(runIntegrity(unwrap(openSession(options)).context.store).clean).toBe(true);
  });
});
