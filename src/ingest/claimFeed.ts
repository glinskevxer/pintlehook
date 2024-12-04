/**
 * The claim feed. Cargo claims arrive from the claims administrator, and the
 * disposition changes over the life of a claim, so the same claim identifier is
 * expected to appear in several deliveries with a different disposition.
 *
 * The adapter therefore reads a row as a statement about a claim at a moment
 * rather than as a new claim, and the later delivery wins.
 */

import type { Day } from '../util/clock.js';
import type { Currency } from '../util/money.js';
import { err, ok, type Problem, type Result } from '../util/result.js';
import type { ClaimDisposition } from '../domain/clawback.js';
import {
  readCurrency,
  readDay,
  readMinorUnits,
  readOneOf,
  readOptionalText,
  readText,
  type Row,
} from './coerce.js';
import type { FeedEnvelope } from './envelope.js';
import { rowReference, type FeedRead, type RejectedRow } from './feed.js';

const DISPOSITIONS = ['charged_to_carrier', 'absorbed', 'denied', 'open'] as const;

export interface ClaimDraft {
  readonly administratorReference: string;
  readonly proNumber: string;
  readonly raisedOn: Day;
  readonly disposition: ClaimDisposition;
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly closedOn?: Day | undefined;
  readonly sourceReference: string;
  readonly rowNumber: number;
}

export const CLAIM_COLUMNS = [
  'claim_reference',
  'pro_number',
  'raised_on',
  'disposition',
  'amount',
  'currency',
] as const;

export function readClaimRow(
  envelope: FeedEnvelope,
  row: Row,
  rowNumber: number,
): Result<ClaimDraft> {
  const reference = readText(row, 'claim_reference');
  const pro = readText(row, 'pro_number');
  const raisedOn = readDay(row, 'raised_on');
  const disposition = readOneOf(row, 'disposition', DISPOSITIONS);
  const amount = readMinorUnits(row, 'amount');
  const currency = readCurrency(row, 'currency');
  if (!reference.ok || !pro.ok || !raisedOn.ok || !disposition.ok || !amount.ok || !currency.ok) {
    const problems: Problem[] = [];
    for (const result of [reference, pro, raisedOn, disposition, amount, currency]) {
      if (!result.ok) {
        problems.push(...result.problems);
      }
    }
    return err(problems);
  }
  if (amount.value < 0) {
    return err([
      { code: 'claim_amount_negative', message: 'a claim cannot be negative', path: 'amount' },
    ]);
  }
  let closedOn: Day | undefined;
  if (readOptionalText(row, 'closed_on') !== undefined) {
    const closed = readDay(row, 'closed_on');
    if (!closed.ok) {
      return closed;
    }
    closedOn = closed.value;
  }
  return ok({
    administratorReference: reference.value.toUpperCase(),
    proNumber: pro.value.toUpperCase(),
    raisedOn: raisedOn.value,
    disposition: disposition.value,
    amountMinor: amount.value,
    currency: currency.value,
    closedOn,
    sourceReference: rowReference(envelope, rowNumber),
    rowNumber,
  });
}

export function readClaimFeed(envelope: FeedEnvelope, rows: readonly Row[]): FeedRead<ClaimDraft> {
  const accepted: ClaimDraft[] = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const draft = readClaimRow(envelope, row, rowNumber);
    if (draft.ok) {
      accepted.push(draft.value);
    } else {
      rejected.push({ rowNumber, problems: draft.problems, row });
    }
  });
  return { envelope, accepted, rejected };
}

/** The later statement about a claim wins, keyed on the administrator reference. */
export function latestPerClaim(drafts: readonly ClaimDraft[]): ClaimDraft[] {
  const latest = new Map<string, ClaimDraft>();
  for (const draft of drafts) {
    const held = latest.get(draft.administratorReference);
    if (held === undefined || draft.rowNumber >= held.rowNumber) {
      latest.set(draft.administratorReference, draft);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.administratorReference < right.administratorReference ? -1 : 1,
  );
}

export function chargedDrafts(read: FeedRead<ClaimDraft>): ClaimDraft[] {
  return read.accepted.filter((draft) => draft.disposition === 'charged_to_carrier');
}
