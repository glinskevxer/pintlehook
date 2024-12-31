/**
 * The touch feed. Four sources write into it and none of them can identify a
 * carrier the same way, so a draft carries whichever handles the row had and
 * the resolution happens later against the carrier file.
 */

import type { Instant } from '../util/clock.js';
import { parseReferralCode } from '../util/ids.js';
import { err, ok, type Result } from '../util/result.js';
import { TOUCH_CHANNELS, type TouchChannel } from '../domain/touch.js';
import { readInstant, readOneOf, readOptionalText, readText, type Row } from './coerce.js';
import type { FeedEnvelope } from './envelope.js';
import { readRows, rowReference, type FeedRead } from './feed.js';

export interface TouchDraft {
  readonly presentedCode: string;
  readonly channel: TouchChannel;
  readonly at: Instant;
  readonly inviteeMotorCarrierNumber?: string | undefined;
  readonly inviteeDotNumber?: string | undefined;
  readonly inviteeName?: string | undefined;
  readonly sourceReference: string;
  readonly rowNumber: number;
}

export const TOUCH_COLUMNS = ['referral_code', 'channel', 'occurred_at'] as const;

export function readTouchRow(
  envelope: FeedEnvelope,
  row: Row,
  rowNumber: number,
): Result<TouchDraft> {
  const code = readText(row, 'referral_code');
  const channel = readOneOf(row, 'channel', TOUCH_CHANNELS);
  const at = readInstant(row, 'occurred_at');
  if (!code.ok || !channel.ok || !at.ok) {
    return err([
      ...(code.ok ? [] : code.problems),
      ...(channel.ok ? [] : channel.problems),
      ...(at.ok ? [] : at.problems),
    ]);
  }
  const parsedCode = parseReferralCode(code.value);
  if (!parsedCode.ok) {
    return err(parsedCode.problems.map((p) => ({ ...p, path: 'referral_code' })));
  }
  return ok({
    presentedCode: parsedCode.value,
    channel: channel.value,
    at: at.value,
    inviteeMotorCarrierNumber: readOptionalText(row, 'invitee_mc'),
    inviteeDotNumber: readOptionalText(row, 'invitee_dot'),
    inviteeName: readOptionalText(row, 'invitee_name'),
    sourceReference: rowReference(envelope, rowNumber),
    rowNumber,
  });
}

export function readTouchFeed(envelope: FeedEnvelope, rows: readonly Row[]): FeedRead<TouchDraft> {
  return readRows(envelope, rows, readTouchRow);
}

/** A draft with nothing to identify the invitee cannot be attributed later. */
export function hasInviteeHandle(draft: TouchDraft): boolean {
  return (
    draft.inviteeMotorCarrierNumber !== undefined ||
    draft.inviteeDotNumber !== undefined ||
    draft.inviteeName !== undefined
  );
}

export function withoutInviteeHandle(read: FeedRead<TouchDraft>): TouchDraft[] {
  return read.accepted.filter((draft) => !hasInviteeHandle(draft));
}
