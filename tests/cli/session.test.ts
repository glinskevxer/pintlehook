import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  openSession,
  pathsFor,
  reopen,
  saveSession,
  sessionSummary,
} from '../../src/cli/session.js';
import { fixedClock } from '../../src/service/context.js';
import { carrierId } from '../../src/domain/identity.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

function options(directory: string) {
  return {
    directory,
    zone: 'America/Chicago',
    actor: 'operator',
    clock: fixedClock(AT),
  };
}

function carrier(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'carrier_filed',
    key: carrierId(id),
    payload: {
      carrier: carrierId(id),
      legalName: `Carrier ${id}`,
      motorCarrierNumber: `MC90000${id}`,
      dotNumber: `550000${id}`,
      authorityStatus: 'active',
      remitDigest: `r${id}`,
      bankDigest: `b${id}`,
      powerUnits: 1,
    },
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pintlehook-'));
});

describe('pathsFor', () => {
  it('names both files inside the directory', () => {
    const paths = pathsFor('/data');
    expect(paths.journal.endsWith('journal.ndjson')).toBe(true);
    expect(paths.snapshot.endsWith('snapshot.json')).toBe(true);
  });
});

describe('opening', () => {
  it('opens an empty directory as an empty store', () => {
    const session = unwrap(openSession(options(directory)));
    expect(session.context.store.sequence).toBe(0);
    expect(session.usedSnapshot).toBe(false);
  });

  it('refuses a zone it has no rule table for', () => {
    const r = openSession({ ...options(directory), zone: 'Europe/Riga' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('session_zone_unknown');
    }
  });

  it('refuses a journal file it cannot read', () => {
    writeFileSync(pathsFor(directory).journal, 'not a record', 'utf8');
    expect(isErr(openSession(options(directory)))).toBe(true);
  });

  it('carries the actor and the zone onto the context', () => {
    const session = unwrap(openSession(options(directory)));
    expect(session.context.actor).toBe('operator');
    expect(session.context.zone).toBe('America/Chicago');
  });
});

describe('saving and reopening', () => {
  it('writes what it holds and reads it back', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1), carrier(2)]));
    expect(unwrap(saveSession(session))).toBe(2);
    const again = unwrap(reopen(session, options(directory)));
    expect(again.context.store.carriers.size).toBe(2);
  });

  it('resumes from the snapshot when there is one', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1)]));
    unwrap(saveSession(session));
    expect(unwrap(openSession(options(directory))).usedSnapshot).toBe(true);
  });

  it('folds the journal when told to ignore the snapshot', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1)]));
    unwrap(saveSession(session));
    const folded = unwrap(openSession({ ...options(directory), ignoreSnapshot: true }));
    expect(folded.usedSnapshot).toBe(false);
    expect(folded.context.store.carriers.size).toBe(1);
  });

  it('reaches the same tables either way', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1), carrier(2)]));
    unwrap(saveSession(session));
    const resumed = unwrap(openSession(options(directory)));
    const folded = unwrap(openSession({ ...options(directory), ignoreSnapshot: true }));
    expect(resumed.context.store.carriers.all()).toEqual(folded.context.store.carriers.all());
  });

  it('falls back to the journal when the snapshot is rubbish', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1)]));
    unwrap(saveSession(session));
    writeFileSync(pathsFor(directory).snapshot, 'not a snapshot', 'utf8');
    const reopened = unwrap(openSession(options(directory)));
    expect(reopened.usedSnapshot).toBe(false);
    expect(reopened.context.store.carriers.size).toBe(1);
  });

  it('falls back to the journal when the snapshot is from another history', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1)]));
    unwrap(saveSession(session));
    const stale = readFileSync(pathsFor(directory).snapshot, 'utf8');
    const other = unwrap(openSession({ ...options(directory), ignoreSnapshot: true }));
    unwrap(other.context.store.commit([carrier(2)]));
    unwrap(saveSession(other));
    writeFileSync(pathsFor(directory).snapshot, stale, 'utf8');
    const reopened = unwrap(openSession(options(directory)));
    expect(reopened.context.store.carriers.size).toBe(2);
  });

  it('writes a journal that still verifies', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1), carrier(2)]));
    unwrap(saveSession(session));
    const again = unwrap(openSession({ ...options(directory), ignoreSnapshot: true }));
    expect(unwrap(again.context.store.journal.verify())).toBe(2);
  });
});

describe('sessionSummary', () => {
  it('counts what was opened', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1)]));
    expect(sessionSummary(session)).toContain('1 carriers');
    expect(sessionSummary(session)).toContain('folded from the journal');
  });

  it('says when it resumed from a snapshot', () => {
    const session = unwrap(openSession(options(directory)));
    unwrap(session.context.store.commit([carrier(1)]));
    unwrap(saveSession(session));
    expect(sessionSummary(unwrap(openSession(options(directory))))).toContain(
      'resumed from a snapshot',
    );
  });
});
