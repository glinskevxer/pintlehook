/**
 * Delimited text in and out. Carrier packet exports and settlement registers
 * both travel as csv, and the dialects differ: quoted fields with embedded
 * commas, embedded newlines, a stray byte order mark, and trailing blank lines
 * that a spreadsheet adds on save.
 */

import { fail, ok, type Result } from './result.js';

export interface CsvOptions {
  readonly delimiter: string;
  readonly quote: string;
}

const DEFAULTS: CsvOptions = { delimiter: ',', quote: '"' };
const BYTE_ORDER_MARK = '﻿';

export function parseCsv(text: string, options: Partial<CsvOptions> = {}): Result<string[][]> {
  const { delimiter, quote } = { ...DEFAULTS, ...options };
  if (delimiter.length !== 1 || quote.length !== 1) {
    return fail('csv_dialect', 'delimiter and quote must each be a single character');
  }
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const character = source[index] as string;
    if (quoted) {
      if (character === quote) {
        if (source[index + 1] === quote) {
          field += quote;
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === quote && !started) {
      quoted = true;
      started = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (character === '\r') {
      index += source[index + 1] === '\n' ? 2 : 1;
      endRow();
      continue;
    }
    if (character === '\n') {
      index += 1;
      endRow();
      continue;
    }
    field += character;
    started = true;
    index += 1;
  }
  if (quoted) {
    return fail('csv_unterminated_quote', 'the file ends inside a quoted field');
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return ok(rows.filter((r) => !(r.length === 1 && r[0] === '')));
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export function parseCsvTable(text: string, options: Partial<CsvOptions> = {}): Result<CsvTable> {
  const parsed = parseCsv(text, options);
  if (!parsed.ok) {
    return parsed;
  }
  const [header, ...body] = parsed.value;
  if (header === undefined) {
    return fail('csv_empty', 'the file has no header row');
  }
  const trimmed = header.map((h) => h.trim());
  const duplicate = trimmed.find((h, i) => trimmed.indexOf(h) !== i);
  if (duplicate !== undefined) {
    return fail('csv_duplicate_column', `column "${duplicate}" appears more than once`);
  }
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const cells = body[i] as string[];
    if (cells.length !== trimmed.length) {
      return fail(
        'csv_row_width',
        `row ${i + 2} has ${cells.length} fields against ${trimmed.length} columns`,
      );
    }
    const record: Record<string, string> = {};
    trimmed.forEach((column, at) => {
      record[column] = cells[at] as string;
    });
    rows.push(record);
  }
  return ok({ header: trimmed, rows });
}

function quoteField(value: string, options: CsvOptions): string {
  const needsQuote =
    value.includes(options.delimiter) ||
    value.includes(options.quote) ||
    value.includes('\n') ||
    value.includes('\r');
  if (!needsQuote) {
    return value;
  }
  const escaped = value.split(options.quote).join(options.quote + options.quote);
  return options.quote + escaped + options.quote;
}

export function writeCsv(
  rows: readonly (readonly string[])[],
  options: Partial<CsvOptions> = {},
): string {
  const merged = { ...DEFAULTS, ...options };
  return rows
    .map((row) => row.map((cell) => quoteField(cell, merged)).join(merged.delimiter))
    .join('\n');
}

export function writeCsvTable(
  header: readonly string[],
  rows: readonly Readonly<Record<string, string>>[],
  options: Partial<CsvOptions> = {},
): string {
  const body = rows.map((row) => header.map((column) => row[column] ?? ''));
  return writeCsv([header, ...body], options);
}
