/**
 * The onboarding feed. The compliance desk exports one row per carrier packet,
 * and the row carries the approval kind, the approval day, and the day the
 * certificate of insurance cleared if it has.
 *
 * The adapter does no dating of its own. It reads what the desk wrote and hands
 * it to the activation rule, because the cure window is a program rule and the
 * program version in force depends on the approval day, which is in this row.
 */

import type { Day } from '../util/clock.js';
import { parseDotNumber, parseMotorCarrierNumber } from '../util/ids.js';
import { err, ok, type Problem, type Result } from '../util/result.js';
import type { ApprovalKind } from '../domain/activation.js';
import type { AuthorityStatus } from '../domain/party.js';
import { readDay, readInteger, readOneOf, readOptionalText, readText, type Row } from './coerce.js';
import type { FeedEnvelope } from './envelope.js';
import { rowReference, type FeedRead, type RejectedRow } from './feed.js';

const APPROVAL_KINDS = ['outright', 'conditional'] as const;
const AUTHORITY_STATUSES = ['active', 'pending', 'revoked', 'unknown'] as const;

export interface OnboardingDraft {
  readonly motorCarrierNumber: string;
  readonly dotNumber: string;
  readonly legalName: string;
  readonly approvalKind: ApprovalKind;
  readonly approvedOn: Day;
  readonly insuranceClearedOn?: Day | undefined;
  readonly authorityStatus: AuthorityStatus;
  readonly powerUnits: number;
  readonly referralCodeOnPacket?: string | undefined;
  readonly sourceReference: string;
  readonly rowNumber: number;
}

export const ONBOARDING_COLUMNS = [
  'mc_number',
  'dot_number',
  'legal_name',
  'approval_kind',
  'approved_on',
  'authority_status',
  'power_units',
] as const;

export function readOnboardingRow(
  envelope: FeedEnvelope,
  row: Row,
  rowNumber: number,
): Result<OnboardingDraft> {
  const mc = readText(row, 'mc_number');
  const dot = readText(row, 'dot_number');
  const name = readText(row, 'legal_name');
  const kind = readOneOf(row, 'approval_kind', APPROVAL_KINDS);
  const approvedOn = readDay(row, 'approved_on');
  const status = readOneOf(row, 'authority_status', AUTHORITY_STATUSES);
  const powerUnits = readInteger(row, 'power_units');
  if (!mc.ok || !dot.ok || !name.ok || !kind.ok || !approvedOn.ok || !status.ok || !powerUnits.ok) {
    const problems: Problem[] = [];
    for (const result of [mc, dot, name, kind, approvedOn, status, powerUnits]) {
      if (!result.ok) {
        problems.push(...result.problems);
      }
    }
    return err(problems);
  }
  const parsedMc = parseMotorCarrierNumber(mc.value);
  if (!parsedMc.ok) {
    return err(parsedMc.problems.map((p) => ({ ...p, path: 'mc_number' })));
  }
  const parsedDot = parseDotNumber(dot.value);
  if (!parsedDot.ok) {
    return err(parsedDot.problems.map((p) => ({ ...p, path: 'dot_number' })));
  }
  const clearedRaw = readOptionalText(row, 'insurance_cleared_on');
  let insuranceClearedOn: Day | undefined;
  if (clearedRaw !== undefined) {
    const cleared = readDay(row, 'insurance_cleared_on');
    if (!cleared.ok) {
      return cleared;
    }
    insuranceClearedOn = cleared.value;
  }
  return ok({
    motorCarrierNumber: parsedMc.value,
    dotNumber: parsedDot.value,
    legalName: name.value,
    approvalKind: kind.value,
    approvedOn: approvedOn.value,
    insuranceClearedOn,
    authorityStatus: status.value,
    powerUnits: powerUnits.value,
    referralCodeOnPacket: readOptionalText(row, 'referral_code'),
    sourceReference: rowReference(envelope, rowNumber),
    rowNumber,
  });
}

export function readOnboardingFeed(
  envelope: FeedEnvelope,
  rows: readonly Row[],
): FeedRead<OnboardingDraft> {
  const accepted: OnboardingDraft[] = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const draft = readOnboardingRow(envelope, row, rowNumber);
    if (draft.ok) {
      accepted.push(draft.value);
    } else {
      rejected.push({ rowNumber, problems: draft.problems, row });
    }
  });
  return { envelope, accepted, rejected };
}

export function awaitingInsurance(read: FeedRead<OnboardingDraft>): OnboardingDraft[] {
  return read.accepted.filter(
    (draft) => draft.approvalKind === 'conditional' && draft.insuranceClearedOn === undefined,
  );
}
