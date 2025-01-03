/**
 * Ingest metrics. The desk needs to know when a partner's file quality has
 * moved, and a single delivery cannot tell them: one bad file in a run of good
 * ones is a bad file, and three in a row is a conversation with the partner.
 *
 * So the metrics keep a window per source and answer questions about the run
 * rather than about the last delivery.
 */

import { ascending, byKey, sorted, sumBy } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { FeedKind } from './envelope.js';
import type { PipelineSummary } from './pipeline.js';
import { registryKey } from './registry.js';

export interface SourceWindow {
  readonly source: string;
  readonly kind: FeedKind;
  readonly deliveries: readonly PipelineSummary[];
}

export interface SourceMetrics {
  readonly source: string;
  readonly kind: FeedKind;
  readonly deliveries: number;
  readonly rowsIn: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly duplicates: number;
  readonly acceptanceRate: number;
  readonly consecutiveBadDeliveries: number;
}

export function windowOf(
  summaries: readonly PipelineSummary[],
  source: string,
  kind: FeedKind,
  size: number,
): Result<SourceWindow> {
  if (!Number.isInteger(size) || size <= 0) {
    return fail('metrics_window_invalid', 'the window must be a positive whole number');
  }
  const mine = sorted(
    summaries.filter((summary) => summary.source === source),
    byKey((summary: PipelineSummary) => summary.sequence, ascending),
  );
  return ok({ source, kind, deliveries: mine.slice(-size) });
}

/** A delivery is bad when more than one row in twenty failed to read. */
export function isBadDelivery(summary: PipelineSummary): boolean {
  const total = summary.accepted + summary.quarantined;
  return total > 0 && summary.quarantined * 20 > total;
}

export function measure(window: SourceWindow): SourceMetrics {
  const rowsIn = sumBy(window.deliveries, (summary) => summary.rowsIn);
  const accepted = sumBy(window.deliveries, (summary) => summary.accepted);
  const quarantined = sumBy(window.deliveries, (summary) => summary.quarantined);
  const duplicates = sumBy(window.deliveries, (summary) => summary.duplicates);
  const readable = accepted + quarantined;
  let streak = 0;
  for (let i = window.deliveries.length - 1; i >= 0; i -= 1) {
    if (isBadDelivery(window.deliveries[i] as PipelineSummary)) {
      streak += 1;
    } else {
      break;
    }
  }
  return {
    source: window.source,
    kind: window.kind,
    deliveries: window.deliveries.length,
    rowsIn,
    accepted,
    quarantined,
    duplicates,
    acceptanceRate: readable === 0 ? 1 : accepted / readable,
    consecutiveBadDeliveries: streak,
  };
}

export function needsAConversation(metrics: SourceMetrics): boolean {
  return metrics.consecutiveBadDeliveries >= 3;
}

export function measureAll(
  summaries: readonly PipelineSummary[],
  sources: readonly { source: string; kind: FeedKind }[],
  size: number,
): Result<Map<string, SourceMetrics>> {
  const out = new Map<string, SourceMetrics>();
  for (const entry of sources) {
    const window = windowOf(summaries, entry.source, entry.kind, size);
    if (!window.ok) {
      return window;
    }
    out.set(registryKey(entry.source, entry.kind), measure(window.value));
  }
  return ok(out);
}

export function describeMetrics(metrics: SourceMetrics): string {
  const rate = Math.round(metrics.acceptanceRate * 100);
  return `${metrics.source} accepted ${rate} percent over ${metrics.deliveries} deliveries`;
}
