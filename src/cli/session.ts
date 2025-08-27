/**
 * Opening a store from a journal file and writing it back.
 *
 * The journal is the file. There is no database and no schema migration: the
 * file is a list of sealed records, and opening it folds them. A snapshot beside
 * it is an optimisation the loader is allowed to ignore, so a corrupt snapshot
 * costs a slow start up rather than a lost afternoon.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, ok, type Result } from '../util/result.js';
import { isZoneId, type ZoneId } from '../util/zoned.js';
import { JournalLog } from '../storage/log.js';
import { decodeSnapshot, encodeSnapshot } from '../storage/snapshot.js';
import { Store } from '../storage/store.js';
import { contextFor, systemClock, type Clock, type Context } from '../service/context.js';

export interface SessionPaths {
  readonly journal: string;
  readonly snapshot: string;
}

export function pathsFor(directory: string): SessionPaths {
  return {
    journal: join(directory, 'journal.ndjson'),
    snapshot: join(directory, 'snapshot.json'),
  };
}

export interface OpenOptions {
  readonly directory: string;
  readonly zone: string;
  readonly actor: string;
  readonly clock?: Clock | undefined;
  readonly ignoreSnapshot?: boolean | undefined;
}

export interface Session {
  readonly context: Context;
  readonly paths: SessionPaths;
  readonly usedSnapshot: boolean;
}

export function openSession(options: OpenOptions): Result<Session> {
  if (!isZoneId(options.zone)) {
    return fail('session_zone_unsupported', `no rule table for zone "${options.zone}"`);
  }
  const zone: ZoneId = options.zone;
  const paths = pathsFor(options.directory);
  const text = existsSync(paths.journal) ? readFileSync(paths.journal, 'utf8') : '';
  const log = JournalLog.fromText(text);
  if (!log.ok) {
    return log;
  }
  let store: Result<Store> | undefined;
  let usedSnapshot = false;
  if (options.ignoreSnapshot !== true && existsSync(paths.snapshot)) {
    const snapshot = decodeSnapshot(readFileSync(paths.snapshot, 'utf8'));
    if (snapshot.ok) {
      const resumed = Store.fromSnapshot(log.value, snapshot.value);
      if (resumed.ok) {
        store = resumed;
        usedSnapshot = true;
      }
    }
  }
  const opened = store ?? Store.fromLog(log.value);
  if (!opened.ok) {
    return opened;
  }
  const context = contextFor(opened.value, options.clock ?? systemClock(), zone, options.actor);
  return context.ok ? ok({ context: context.value, paths, usedSnapshot }) : context;
}

export function saveSession(session: Session): Result<number> {
  const directory = dirname(session.paths.journal);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(session.paths.journal, session.context.store.journal.toText(), 'utf8');
  writeFileSync(session.paths.snapshot, encodeSnapshot(session.context.store.snapshot()), 'utf8');
  return ok(session.context.store.sequence);
}

/** Reopen from what was written, which is the only honest way to check a save. */
export function reopen(session: Session, options: OpenOptions): Result<Session> {
  return openSession({ ...options, directory: dirname(session.paths.journal) });
}

export function sessionSummary(session: Session): string {
  const store = session.context.store;
  return [
    `${store.sequence} records`,
    `${store.carriers.size} carriers`,
    `${store.advocates.size} advocates`,
    `${store.referrals.size} referrals`,
    session.usedSnapshot ? 'resumed from a snapshot' : 'folded from the journal',
  ].join(', ');
}
