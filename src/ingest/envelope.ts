/**
 * Every feed arrives wrapped in the same envelope: who sent it, what it is,
 * when they cut it, and how many rows they think are in it. The envelope is
 * checked before a single row is read, because a partner who ships a truncated
 * file usually ships a correct envelope with it, and that is the cheapest way
 * to catch the truncation.
 */

import { z } from 'zod';
import { parseInstant, type Instant } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { fail, ok, problem, type Problem, type Result } from '../util/result.js';
import { isZoneId, type ZoneId } from '../util/zoned.js';

export const FEED_KINDS = ['touch', 'onboarding', 'load', 'claim'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export interface FeedEnvelope {
  readonly source: string;
  readonly kind: FeedKind;
  readonly cutAt: Instant;
  readonly declaredRows: number;
  readonly zone: ZoneId;
  readonly sequence: number;
}

const envelopeSchema = z.object({
  source: z.string().min(1).max(64),
  kind: z.enum(FEED_KINDS),
  cutAt: z.string().min(1),
  declaredRows: z.number().int().nonnegative(),
  zone: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

function toProblems(error: z.ZodError): Problem[] {
  return error.issues.map((issue) =>
    problem('envelope_shape', issue.message, issue.path.join('.') || undefined),
  );
}

export function readEnvelope(raw: unknown): Result<FeedEnvelope> {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: toProblems(parsed.error) };
  }
  const cutAt = parseInstant(parsed.data.cutAt);
  if (!cutAt.ok) {
    return cutAt;
  }
  if (!isZoneId(parsed.data.zone)) {
    return fail('envelope_zone_unknown', `no rule table for zone "${parsed.data.zone}"`, 'zone');
  }
  return ok({
    source: parsed.data.source,
    kind: parsed.data.kind,
    cutAt: cutAt.value,
    declaredRows: parsed.data.declaredRows,
    zone: parsed.data.zone,
    sequence: parsed.data.sequence,
  });
}

/** The identity of one delivery. Two files with this key are the same delivery. */
export function envelopeKey(envelope: FeedEnvelope): string {
  return digestOfParts([envelope.source, envelope.kind, envelope.sequence]);
}

export function checkRowCount(envelope: FeedEnvelope, actualRows: number): Result<number> {
  if (actualRows !== envelope.declaredRows) {
    return fail(
      'envelope_row_count',
      `${envelope.source} declared ${envelope.declaredRows} rows and sent ${actualRows}`,
    );
  }
  return ok(actualRows);
}

/** A delivery that goes backwards in sequence is a replay, not a new file. */
export function isReplay(envelope: FeedEnvelope, highestSeen: number | undefined): boolean {
  return highestSeen !== undefined && envelope.sequence <= highestSeen;
}

export function describeEnvelope(envelope: FeedEnvelope): string {
  return `${envelope.source} ${envelope.kind} #${envelope.sequence} with ${envelope.declaredRows} rows`;
}

export function isFeedKind(value: string): value is FeedKind {
  return (FEED_KINDS as readonly string[]).includes(value);
}
