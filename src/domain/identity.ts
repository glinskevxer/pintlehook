/**
 * Branded identifiers. A settlement identifier and an accrual identifier are
 * both strings, and the compiler is the only thing standing between us and a
 * report that joins one to the other.
 */

import { parseSurrogateId, surrogateId } from '../util/ids.js';
import { fail, ok, type Result } from '../util/result.js';

declare const brand: unique symbol;

type Branded<Tag extends string> = string & { readonly [brand]: Tag };

export type AdvocateId = Branded<'AdvocateId'>;
export type CarrierId = Branded<'CarrierId'>;
export type ProgramId = Branded<'ProgramId'>;
export type TouchId = Branded<'TouchId'>;
export type LoadId = Branded<'LoadId'>;
export type ClaimId = Branded<'ClaimId'>;
export type AccrualId = Branded<'AccrualId'>;
export type SettlementId = Branded<'SettlementId'>;
export type BatchId = Branded<'BatchId'>;

export const ID_PREFIXES = {
  advocate: 'adv',
  carrier: 'cxr',
  program: 'prg',
  touch: 'tch',
  load: 'lod',
  claim: 'clm',
  accrual: 'acr',
  settlement: 'stl',
  batch: 'bch',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function mint<T extends string>(kind: IdKind, sequence: number): T {
  return surrogateId(ID_PREFIXES[kind], sequence) as T;
}

function read<T extends string>(kind: IdKind, raw: string): Result<T> {
  const parsed = parseSurrogateId(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const expected = ID_PREFIXES[kind];
  if (parsed.value.prefix !== expected) {
    return fail(
      'identifier_kind',
      `expected a ${kind} identifier starting ${expected}, got "${raw}"`,
    );
  }
  return ok(raw as T);
}

export const advocateId = (sequence: number): AdvocateId => mint('advocate', sequence);
export const carrierId = (sequence: number): CarrierId => mint('carrier', sequence);
export const programId = (sequence: number): ProgramId => mint('program', sequence);
export const touchId = (sequence: number): TouchId => mint('touch', sequence);
export const loadId = (sequence: number): LoadId => mint('load', sequence);
export const claimId = (sequence: number): ClaimId => mint('claim', sequence);
export const accrualId = (sequence: number): AccrualId => mint('accrual', sequence);
export const settlementId = (sequence: number): SettlementId => mint('settlement', sequence);
export const batchId = (sequence: number): BatchId => mint('batch', sequence);

export const readAdvocateId = (raw: string): Result<AdvocateId> => read('advocate', raw);
export const readCarrierId = (raw: string): Result<CarrierId> => read('carrier', raw);
export const readProgramId = (raw: string): Result<ProgramId> => read('program', raw);
export const readTouchId = (raw: string): Result<TouchId> => read('touch', raw);
export const readLoadId = (raw: string): Result<LoadId> => read('load', raw);
export const readClaimId = (raw: string): Result<ClaimId> => read('claim', raw);
export const readAccrualId = (raw: string): Result<AccrualId> => read('accrual', raw);
export const readSettlementId = (raw: string): Result<SettlementId> => read('settlement', raw);
export const readBatchId = (raw: string): Result<BatchId> => read('batch', raw);

export function kindOf(raw: string): IdKind | undefined {
  const parsed = parseSurrogateId(raw);
  if (!parsed.ok) {
    return undefined;
  }
  for (const [kind, prefix] of Object.entries(ID_PREFIXES)) {
    if (prefix === parsed.value.prefix) {
      return kind as IdKind;
    }
  }
  return undefined;
}

/** Sequence number back out of an identifier, for a generator that resumes. */
export function sequenceOf(raw: string): Result<number> {
  const parsed = parseSurrogateId(raw);
  return parsed.ok ? ok(parsed.value.sequence) : parsed;
}
