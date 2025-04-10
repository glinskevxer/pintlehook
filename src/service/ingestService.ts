/**
 * Wiring the ingest pipeline to the store.
 *
 * Loads and claims land in the journal directly, because they are statements
 * of fact from systems that own them. Touches go through the referral service
 * instead, because a touch has to resolve a carrier and find an advocate, and
 * a row that cannot do either is a working item rather than a fact.
 */

import { formatDay } from '../util/clock.js';
import { ok, type Result } from '../util/result.js';
import type { CarrierId, ClaimId, LoadId } from '../domain/identity.js';
import type { ClaimDraft } from '../ingest/claimFeed.js';
import type { LoadDraft } from '../ingest/loadFeed.js';
import type { TouchDraft } from '../ingest/touchFeed.js';
import type { JournalDraft } from '../storage/journal.js';
import type { QuarantineEntry } from '../ingest/quarantine.js';
import type { Context } from './context.js';
import { recordTouches, type TouchBatchOutcome } from './referrals.js';
import { resolveCarrier } from './resolution.js';

export interface UnresolvedRow {
  readonly reference: string;
  readonly code: string;
  readonly message: string;
}

export interface IngestOutcome {
  readonly drafts: readonly JournalDraft[];
  readonly accepted: number;
  readonly unresolved: readonly UnresolvedRow[];
}

function unresolvedOf(
  reference: string,
  problems: readonly { code: string; message: string }[],
): UnresolvedRow {
  const first = problems[0];
  return {
    reference,
    code: first?.code ?? 'ingest_rejected',
    message: first?.message ?? 'this row could not be applied',
  };
}

export function applyLoads(context: Context, drafts: readonly LoadDraft[]): Result<IngestOutcome> {
  const journal: JournalDraft[] = [];
  const unresolved: UnresolvedRow[] = [];
  for (const draft of drafts) {
    const carrier = resolveCarrier(context.store, {
      motorCarrierNumber: draft.carrierMotorCarrierNumber,
    });
    if (!carrier.ok) {
      unresolved.push(unresolvedOf(draft.sourceReference, carrier.problems));
      continue;
    }
    if (draft.status !== 'delivered' || draft.deliveredOn === undefined) {
      continue;
    }
    const load = context.ids.mint('load') as LoadId;
    journal.push({
      at: context.clock.now(),
      kind: 'load_delivered',
      key: load,
      payload: {
        load,
        carrier: carrier.value.carrier.id as CarrierId,
        proNumber: draft.proNumber,
        deliveredOn: formatDay(draft.deliveredOn),
        lineHaulMinor: draft.lineHaulMinor,
        carrierPayMinor: draft.carrierPayMinor,
        currency: draft.currency,
        originState: draft.lane.originState,
        destinationState: draft.lane.destinationState,
        sourceReference: draft.sourceReference,
        actor: context.actor,
      },
    });
  }
  return ok({ drafts: journal, accepted: journal.length, unresolved });
}

export function applyClaims(
  context: Context,
  drafts: readonly ClaimDraft[],
): Result<IngestOutcome> {
  const journal: JournalDraft[] = [];
  const unresolved: UnresolvedRow[] = [];
  for (const draft of drafts) {
    const load = context.store.loads.where((row) => row.proNumber === draft.proNumber);
    const first = load[0];
    if (first === undefined) {
      unresolved.push({
        reference: draft.sourceReference,
        code: 'claim_load_unknown',
        message: `no load carries pro number ${draft.proNumber}`,
      });
      continue;
    }
    const claim = context.ids.mint('claim') as ClaimId;
    journal.push({
      at: context.clock.now(),
      kind: 'claim_stated',
      key: claim,
      payload: {
        claim,
        load: first.id,
        raisedOn: formatDay(draft.raisedOn),
        disposition: draft.disposition,
        amountMinor: draft.amountMinor,
        currency: draft.currency,
        administratorReference: draft.administratorReference,
        actor: context.actor,
      },
    });
  }
  return ok({ drafts: journal, accepted: journal.length, unresolved });
}

export function applyTouches(context: Context, drafts: readonly TouchDraft[]): TouchBatchOutcome {
  return recordTouches(context, drafts);
}

export interface IngestReport {
  readonly applied: number;
  readonly unresolved: number;
  readonly quarantined: number;
}

export function reportOf(
  outcome: IngestOutcome,
  quarantined: readonly QuarantineEntry[],
): IngestReport {
  return {
    applied: outcome.accepted,
    unresolved: outcome.unresolved.length,
    quarantined: quarantined.length,
  };
}

export function commitAll(context: Context, drafts: readonly JournalDraft[]): Result<number> {
  if (drafts.length === 0) {
    return ok(0);
  }
  const written = context.store.commit(drafts);
  return written.ok ? ok(written.value.length) : written;
}
