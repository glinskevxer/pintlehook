/**
 * Rendering a report. Every report in this program is a list of rows with named
 * columns, so there is one renderer and three ways out of it: a fixed width
 * table for a terminal, csv for a spreadsheet, and json for anything else.
 *
 * Money is right aligned and rendered from minor units at the boundary. Nothing
 * upstream of here ever formats an amount, which is the only way to be sure the
 * register and the statement agree on what a cent looks like.
 */

import { formatMoney, type Money } from '../util/money.js';
import { writeCsv } from '../util/csv.js';
import { fail, ok, type Result } from '../util/result.js';

export type Align = 'left' | 'right';

export interface Column<T> {
  readonly key: string;
  readonly heading: string;
  readonly align: Align;
  readonly render: (row: T) => string;
}

export interface Report<T> {
  readonly title: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly footnotes: readonly string[];
}

export function textColumn<T>(key: string, heading: string, render: (row: T) => string): Column<T> {
  return { key, heading, align: 'left', render };
}

export function numberColumn<T>(
  key: string,
  heading: string,
  render: (row: T) => number,
): Column<T> {
  return { key, heading, align: 'right', render: (row) => String(render(row)) };
}

export function moneyColumn<T>(key: string, heading: string, render: (row: T) => Money): Column<T> {
  return { key, heading, align: 'right', render: (row) => formatMoney(render(row)) };
}

export function cellsOf<T>(report: Report<T>): string[][] {
  return report.rows.map((row) => report.columns.map((column) => column.render(row)));
}

export function headingsOf<T>(report: Report<T>): string[] {
  return report.columns.map((column) => column.heading);
}

function widths<T>(report: Report<T>): number[] {
  const cells = cellsOf(report);
  return report.columns.map((column, at) => {
    let widest = column.heading.length;
    for (const row of cells) {
      widest = Math.max(widest, (row[at] as string).length);
    }
    return widest;
  });
}

function pad(value: string, width: number, align: Align): string {
  const gap = ' '.repeat(Math.max(0, width - value.length));
  return align === 'right' ? gap + value : value + gap;
}

export function renderText<T>(report: Report<T>): string {
  const sizes = widths(report);
  const lines: string[] = [report.title, ''];
  lines.push(
    report.columns
      .map((column, at) => pad(column.heading, sizes[at] as number, column.align))
      .join('  '),
  );
  lines.push(sizes.map((size) => '-'.repeat(size)).join('  '));
  for (const row of cellsOf(report)) {
    lines.push(
      row
        .map((cell, at) => pad(cell, sizes[at] as number, (report.columns[at] as Column<T>).align))
        .join('  '),
    );
  }
  if (report.rows.length === 0) {
    lines.push('(nothing to report)');
  }
  for (const note of report.footnotes) {
    lines.push('', note);
  }
  return lines.join('\n');
}

export function renderCsv<T>(report: Report<T>): string {
  return writeCsv([headingsOf(report), ...cellsOf(report)]);
}

export function renderJson<T>(report: Report<T>): string {
  const rows = report.rows.map((row) => {
    const out: Record<string, string> = {};
    for (const column of report.columns) {
      out[column.key] = column.render(row);
    }
    return out;
  });
  return JSON.stringify({ title: report.title, rows, footnotes: report.footnotes }, null, 2);
}

export type Shape = 'text' | 'csv' | 'json';

export const SHAPES: readonly Shape[] = ['text', 'csv', 'json'];

export function isShape(value: string): value is Shape {
  return (SHAPES as readonly string[]).includes(value);
}

export function render<T>(report: Report<T>, shape: Shape): string {
  switch (shape) {
    case 'text':
      return renderText(report);
    case 'csv':
      return renderCsv(report);
    case 'json':
      return renderJson(report);
  }
}

export function parseShape(value: string): Result<Shape> {
  const lower = value.trim().toLowerCase();
  return isShape(lower) ? ok(lower) : fail('report_shape_unknown', `no output shape "${value}"`);
}

export function validateReport<T>(report: Report<T>): Result<Report<T>> {
  if (report.columns.length === 0) {
    return fail('report_no_columns', 'a report needs at least one column');
  }
  const keys = report.columns.map((column) => column.key);
  const duplicate = keys.find((key, at) => keys.indexOf(key) !== at);
  if (duplicate !== undefined) {
    return fail('report_column_repeated', `column "${duplicate}" appears twice`);
  }
  return ok(report);
}
