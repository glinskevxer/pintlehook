/**
 * Reading a delivery out of a delimited file. Partners ship the envelope as a
 * block of key colon value lines above the header, separated by a line holding
 * only dashes, because that is what their export tool writes and asking three
 * of them to change it went nowhere.
 */

import { parseCsvTable, type CsvOptions } from '../util/csv.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Row } from './coerce.js';

const SEPARATOR = /^-{3,}\s*$/;
const HEADER_LINE = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;

export interface DeliveryFile {
  readonly envelopeFields: Readonly<Record<string, string>>;
  readonly rows: readonly Row[];
}

export function splitDelivery(text: string): Result<{ header: string; body: string }> {
  const lines = text.split(/\r\n|\r|\n/);
  const at = lines.findIndex((line) => SEPARATOR.test(line));
  if (at < 0) {
    return fail('delivery_no_separator', 'the file has no dashed line between envelope and rows');
  }
  return ok({
    header: lines.slice(0, at).join('\n'),
    body: lines.slice(at + 1).join('\n'),
  });
}

export function readEnvelopeFields(header: string): Result<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const line of header.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const match = HEADER_LINE.exec(line);
    if (match === null) {
      return fail('delivery_header_line', `cannot read "${line}" as an envelope field`);
    }
    const key = match[1] as string;
    if (key in fields) {
      return fail('delivery_header_repeated', `${key} appears twice in the envelope`);
    }
    fields[key] = (match[2] as string).trim();
  }
  if (Object.keys(fields).length === 0) {
    return fail('delivery_header_empty', 'the envelope block is empty');
  }
  return ok(fields);
}

export function readDeliveryFile(
  text: string,
  options: Partial<CsvOptions> = {},
): Result<DeliveryFile> {
  const split = splitDelivery(text);
  if (!split.ok) {
    return split;
  }
  const envelopeFields = readEnvelopeFields(split.value.header);
  if (!envelopeFields.ok) {
    return envelopeFields;
  }
  const table = parseCsvTable(split.value.body, options);
  if (!table.ok) {
    return table;
  }
  return ok({ envelopeFields: envelopeFields.value, rows: table.value.rows });
}

/** Turn the envelope block into the shape the envelope reader wants. */
export function toEnvelopeInput(fields: Readonly<Record<string, string>>): Record<string, unknown> {
  const numeric = new Set(['declaredRows', 'sequence']);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = numeric.has(key) ? Number(value) : value;
  }
  return out;
}

export function writeDeliveryFile(
  fields: Readonly<Record<string, string>>,
  header: readonly string[],
  rows: readonly Row[],
): string {
  const envelope = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const body = [header.join(','), ...rows.map((row) => header.map((c) => row[c] ?? '').join(','))];
  return [envelope, '---', ...body].join('\n');
}
