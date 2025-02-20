/**
 * The runtime context. Services take one of these rather than reaching for a
 * clock or a counter, so a settlement run can be replayed years later with the
 * clock it was run under and land on the same numbers.
 *
 * Identifiers come from the store rather than from a random source, and the
 * sequence resumes from what is already filed, so a process restarted half way
 * through a batch does not reuse an identifier or skip one.
 */

import type { Day, Instant } from '../util/clock.js';
import { dayOf } from '../util/clock.js';
import { sequenceOf, type IdKind } from '../domain/identity.js';
import { ID_PREFIXES } from '../domain/identity.js';
import { surrogateId } from '../util/ids.js';
import { ok, type Result } from '../util/result.js';
import type { Store } from '../storage/store.js';
import type { ZoneId } from '../util/zoned.js';

export interface Clock {
  now(): Instant;
  today(): Day;
}

export function fixedClock(at: Instant): Clock {
  return {
    now: () => at,
    today: () => dayOf(at),
  };
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    today: () => dayOf(Date.now()),
  };
}

export class IdSequence {
  private readonly next = new Map<IdKind, number>();

  constructor(seed: Readonly<Partial<Record<IdKind, number>>> = {}) {
    for (const [kind, value] of Object.entries(seed)) {
      this.next.set(kind as IdKind, value);
    }
  }

  peek(kind: IdKind): number {
    return this.next.get(kind) ?? 1;
  }

  mint(kind: IdKind): string {
    const at = this.peek(kind);
    this.next.set(kind, at + 1);
    return surrogateId(ID_PREFIXES[kind], at);
  }

  observe(kind: IdKind, id: string): void {
    const read = sequenceOf(id);
    if (read.ok && read.value >= this.peek(kind)) {
      this.next.set(kind, read.value + 1);
    }
  }
}

/** Resume the sequence from whatever the store already holds. */
export function sequenceFromStore(store: Store): IdSequence {
  const sequence = new IdSequence();
  for (const row of store.carriers.all()) {
    sequence.observe('carrier', row.id);
  }
  for (const row of store.advocates.all()) {
    sequence.observe('advocate', row.id);
  }
  for (const row of store.touches.all()) {
    sequence.observe('touch', row.id);
  }
  for (const row of store.loads.all()) {
    sequence.observe('load', row.id);
  }
  for (const row of store.claims.all()) {
    sequence.observe('claim', row.id);
  }
  for (const row of store.accruals.all()) {
    sequence.observe('accrual', row.id);
  }
  for (const row of store.batches.all()) {
    sequence.observe('batch', row.id);
  }
  return sequence;
}

export interface Context {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSequence;
  readonly zone: ZoneId;
  readonly actor: string;
}

export function contextFor(
  store: Store,
  clock: Clock,
  zone: ZoneId,
  actor: string,
): Result<Context> {
  return ok({ store, clock, ids: sequenceFromStore(store), zone, actor });
}

export function withActor(context: Context, actor: string): Context {
  return { ...context, actor };
}

export function withClock(context: Context, clock: Clock): Context {
  return { ...context, clock };
}
